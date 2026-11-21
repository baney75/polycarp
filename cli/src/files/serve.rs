//! `polycarp files serve`: search, metadata and read-only downloads for the owner's other devices, and an inbox
//! they may save into when `allow_save` is on. It listens on this device's Tailscale addresses only, and every
//! connection is let in only after the local Tailscale daemon says whose node it comes from.

use super::config::{Config, Root};
use super::http::{self, Request};
use super::index::Index;
use super::rules;
use super::tailnet::{Node, Tailnet};
use super::{fail_json, ok_json};
use serde_json::{json, Value as Json};
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Connections served at once; more get a 503.
const MAX_CONNS: usize = 32;
/// The most one upload may carry.
const MAX_UPLOAD: u64 = 4 * 1024 * 1024 * 1024;
const WHOIS_TTL: Duration = Duration::from_secs(30);

pub struct Ctx {
    pub cfg: Config,
    pub roots: Vec<Root>,
    pub index: PathBuf,
    pub inbox: PathBuf,
    pub tailnet: Arc<dyn Tailnet>,
    /// This node, from `tailscale status` when serve started.
    pub me: Node,
    whois_cache: Mutex<HashMap<IpAddr, (Instant, Node)>>,
    conns: AtomicUsize,
}

impl Ctx {
    pub fn new(
        cfg: Config,
        roots: Vec<Root>,
        index: PathBuf,
        inbox: PathBuf,
        tailnet: Arc<dyn Tailnet>,
        me: Node,
    ) -> Ctx {
        Ctx {
            cfg,
            roots,
            index,
            inbox,
            tailnet,
            me,
            whois_cache: Mutex::new(HashMap::new()),
            conns: AtomicUsize::new(0),
        }
    }

    fn whois(&self, addr: SocketAddr) -> Result<Node, String> {
        if let Ok(cache) = self.whois_cache.lock() {
            if let Some((at, n)) = cache.get(&addr.ip()) {
                if at.elapsed() < WHOIS_TTL {
                    return Ok(n.clone());
                }
            }
        }
        let n = self.tailnet.whois(addr)?;
        if let Ok(mut cache) = self.whois_cache.lock() {
            cache.insert(addr.ip(), (Instant::now(), n.clone()));
        }
        Ok(n)
    }
}

/// True for an address Tailscale hands out: 100.64.0.0/10 or fd7a:115c:a1e0::/48.
pub fn is_tailscale_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xC0) == 64
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

/// The addresses serve binds: this node's Tailscale addresses and nothing else. Never 0.0.0.0, ::, loopback or a
/// LAN address; with none left, serve refuses to start.
pub fn bind_addrs(ips: &[IpAddr], port: u16) -> Result<Vec<SocketAddr>, String> {
    let out: Vec<SocketAddr> = ips
        .iter()
        .filter(|ip| !ip.is_unspecified() && !ip.is_loopback() && is_tailscale_ip(ip))
        .map(|ip| SocketAddr::new(*ip, port))
        .collect();
    if out.is_empty() {
        return Err(
            "this device has no Tailscale address, so there is nothing safe to listen on. Start Tailscale and sign in."
                .to_string(),
        );
    }
    Ok(out)
}

/// A tagged node serves no one: its user id is shared by every tagged node, so it has no owner to match.
pub fn may_serve(me: &Node) -> Result<(), String> {
    if me.personal() {
        Ok(())
    } else {
        Err(format!(
            "this device is tagged ({}), so it has no owner to share files with. Run serve on a device signed in as you.",
            me.tags.join(", ")
        ))
    }
}

/// A caller that was let in. `itself` is this node: another account or a sandboxed process on this machine dialing
/// its own Tailscale address looks the same to whois, so it may only ask `/v1/health` (which doctor uses).
#[derive(Debug)]
pub struct Caller {
    pub node: Node,
    pub itself: bool,
}

/// Lets a caller in only when Tailscale says its node belongs to the same user as this one, and, when the owner
/// listed devices, only one of those. This node itself always gets in, but only as far as `/v1/health`.
pub fn authorize(
    who: Result<Node, String>,
    me: &Node,
    allow_devices: &[String],
) -> Result<Caller, String> {
    let node = who.map_err(|e| format!("Tailscale could not say who is calling: {e}"))?;
    may_serve(me)?;
    if !node.tags.is_empty() {
        return Err(format!(
            "{} is a tagged device, not one of the owner's",
            node.name
        ));
    }
    if !node.same_owner(me) {
        return Err(format!(
            "{} belongs to another Tailscale user",
            if node.name.is_empty() {
                "the caller"
            } else {
                &node.name
            }
        ));
    }
    if node.ips.iter().any(|ip| me.ips.contains(ip)) {
        return Ok(Caller { node, itself: true });
    }
    if !allow_devices.is_empty() && !allow_devices.iter().any(|d| node.is_named(d)) {
        return Err(format!("{} is not in allow_devices", node.name));
    }
    Ok(Caller {
        node,
        itself: false,
    })
}

/// A Host header that names this node: one of its Tailscale addresses (or the one the connection came in on), its
/// short or full MagicDNS name, with or without a port. Anything else is a DNS rebinding page in a browser.
pub fn host_ok(host: Option<&str>, me: &Node, local: SocketAddr) -> bool {
    let Some(h) = host.map(str::trim) else {
        return false;
    };
    let (name, port) = match h.strip_prefix('[') {
        Some(rest) => match rest.split_once(']') {
            Some((ip, "")) => (ip, None),
            Some((ip, p)) => match p.strip_prefix(':') {
                Some(p) => (ip, Some(p)),
                None => return false,
            },
            None => return false,
        },
        None => match h.rsplit_once(':') {
            Some((n, p)) => (n, Some(p)),
            None => (h, None),
        },
    };
    if port.is_some_and(|p| p.parse::<u16>().is_err()) {
        return false;
    }
    match name.parse::<IpAddr>() {
        Ok(ip) => ip == local.ip() || me.ips.contains(&ip),
        Err(_) => me.is_named(name),
    }
}

/// What a request gets back.
#[derive(Debug, PartialEq)]
pub enum Reply {
    Json(u16, Json),
    File(PathBuf, u64),
    /// Read the body into the inbox under this name.
    Upload(String, u64),
}

fn refuse(status: u16, code: &str, message: &str, suggestion: &str) -> Reply {
    Reply::Json(status, fail_json(code, message, suggestion))
}

/// A path another device may read: absolute, inside a root after links are followed, past every rule, a file.
pub fn shareable(
    roots: &[Root],
    extra: &[String],
    p: &str,
) -> Result<PathBuf, (u16, &'static str, String)> {
    let path = Path::new(p);
    if !path.is_absolute() {
        return Err((400, "invalid_args", "path must be absolute".into()));
    }
    let canon =
        fs::canonicalize(path).map_err(|_| (404, "not_found", "no such file".to_string()))?;
    for root in roots {
        let Ok(rc) = fs::canonicalize(&root.path) else {
            continue;
        };
        if let Ok(rel) = canon.strip_prefix(&rc) {
            if rules::allowed_in_root(&rc, rel, extra) && canon.is_file() {
                return Ok(canon);
            }
            return Err((403, "not_shared", "that file is not shared".into()));
        }
    }
    Err((
        403,
        "not_shared",
        "that file is outside the shared folders".into(),
    ))
}

/// A name a device may save under: one plain file name, not hidden, not a secret.
pub fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.starts_with('.')
        && !name
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        && !rules::secret_file(name)
}

pub fn route(ctx: &Ctx, req: &Request) -> Reply {
    let extra = &ctx.cfg.skip;
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/health") => {
            let info = Index::open_read(&ctx.index).and_then(|i| i.info()).ok();
            Reply::Json(
                200,
                ok_json(json!({
                    "device": ctx.me.name,
                    "version": env!("CARGO_PKG_VERSION"),
                    "build": crate::version::BUILD_STAMP,
                    "port": ctx.cfg.port(),
                    "allow_save": ctx.cfg.allow_save,
                    "index": info.map(|i| json!({"files": i.files, "last_full": i.last_full})),
                })),
            )
        }
        ("GET", "/v1/search") => {
            let q = req.param("q").unwrap_or_default();
            let kind = req.param("kind").filter(|k| !k.is_empty());
            let limit = req
                .param("limit")
                .and_then(|l| l.parse::<usize>().ok())
                .unwrap_or(20)
                .clamp(1, 200);
            match Index::open_read(&ctx.index).and_then(|i| i.search(q, kind, limit, &ctx.roots)) {
                Ok(mut hits) => {
                    for h in &mut hits {
                        h.device = Some(ctx.me.name.clone());
                    }
                    Reply::Json(
                        200,
                        ok_json(json!({"device": ctx.me.name, "results": hits})),
                    )
                }
                Err(e) => refuse(
                    503,
                    "no_index",
                    &e,
                    "Run `polycarp files index` on that device.",
                ),
            }
        }
        ("GET", "/v1/meta") | ("GET", "/v1/file") => {
            let Some(p) = req.param("path") else {
                return refuse(
                    400,
                    "invalid_args",
                    "missing path",
                    "Pass ?path=<absolute path>.",
                );
            };
            let path = match shareable(&ctx.roots, extra, p) {
                Ok(path) => path,
                Err((s, code, m)) => return refuse(s, code, &m, ""),
            };
            let Ok(meta) = fs::metadata(&path) else {
                return refuse(404, "not_found", "no such file", "");
            };
            if req.path == "/v1/file" {
                return Reply::File(path, meta.len());
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Reply::Json(
                200,
                ok_json(json!({
                    "device": ctx.me.name,
                    "path": path.display().to_string(),
                    "name": name,
                    "kind": rules::kind(&name),
                    "size": meta.len(),
                    "modified": modified,
                })),
            )
        }
        ("PUT", "/v1/inbox") => {
            if !ctx.cfg.allow_save {
                return refuse(
                    403,
                    "save_off",
                    "this device does not take files",
                    "The owner can set allow_save = true in that device's files.toml.",
                );
            }
            let name = req.param("name").unwrap_or_default();
            if !safe_name(name) {
                return refuse(400, "invalid_args", "name must be one plain file name", "");
            }
            match req.content_length {
                None => refuse(400, "invalid_args", "Content-Length is required", ""),
                Some(n) if n > MAX_UPLOAD => refuse(413, "too_large", "the file is too large", ""),
                Some(n) => Reply::Upload(name.to_string(), n),
            }
        }
        (_, "/v1/health" | "/v1/search" | "/v1/meta" | "/v1/file" | "/v1/inbox") => {
            refuse(405, "invalid_args", "method not allowed", "")
        }
        _ => refuse(404, "not_found", "no such endpoint", ""),
    }
}

/// `dir/name`, or `name (1)`, `name (2)`... when taken.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

fn save_upload(
    inbox: &Path,
    name: &str,
    len: u64,
    body: &mut impl Read,
) -> Result<PathBuf, String> {
    fs::create_dir_all(inbox).map_err(|e| format!("could not create the inbox: {e}"))?;
    let tmp = inbox.join(format!(".{name}.{}.part", std::process::id()));
    let mut f = fs::File::create(&tmp).map_err(|e| format!("could not write: {e}"))?;
    let got = io::copy(&mut body.take(len), &mut f).map_err(|e| e.to_string());
    let done = matches!(got, Ok(n) if n == len) && f.sync_all().is_ok();
    drop(f);
    if !done {
        let _ = fs::remove_file(&tmp);
        return Err("the upload stopped before the end".into());
    }
    let dest = unique_path(inbox, name);
    fs::rename(&tmp, &dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not save: {e}")
    })?;
    Ok(dest)
}

/// Serves one connection. The caller is checked before anything it sent is read.
pub fn handle_conn(ctx: &Ctx, stream: TcpStream, peer: SocketAddr) {
    let Ok(keep) = stream.try_clone() else {
        return;
    };
    serve_one(ctx, stream, peer);
    close_gently(keep);
}

/// Ends the answer, then reads (and drops) what the caller still sends for a moment, so closing with its
/// request unread does not reset the connection before it has read the answer.
fn close_gently(mut s: TcpStream) {
    let _ = s.shutdown(std::net::Shutdown::Write);
    let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
    let mut sink = [0u8; 4096];
    let mut left: usize = 64 * 1024;
    while left > 0 {
        match s.read(&mut sink) {
            Ok(0) | Err(_) => break,
            Ok(n) => left = left.saturating_sub(n),
        }
    }
}

fn serve_one(ctx: &Ctx, stream: TcpStream, peer: SocketAddr) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));
    let Ok(read_half) = stream.try_clone() else {
        return;
    };
    let Ok(local) = stream.local_addr() else {
        return;
    };
    let mut out = stream;
    let caller = match authorize(ctx.whois(peer), &ctx.me, &ctx.cfg.allow_devices) {
        Ok(n) => n,
        Err(why) => {
            log(&format!("refused a connection: {why}"));
            let _ = http::write_json(
                &mut out,
                403,
                &fail_json(
                    "not_allowed",
                    &why,
                    "Only the owner's own devices may connect.",
                ),
            );
            return;
        }
    };
    let mut reader = BufReader::new(read_half);
    let req = match http::read_request(&mut reader) {
        Ok(r) => r,
        Err(e) => {
            let _ = http::write_json(
                &mut out,
                400,
                &fail_json("invalid_args", &e.to_string(), ""),
            );
            return;
        }
    };
    let refused = if req.from_browser || !host_ok(req.host.as_deref(), &ctx.me, local) {
        Some("web pages may not use this server: the request named another host or came from a browser")
    } else if caller.itself && req.path != "/v1/health" {
        Some("this device may only check its own health here")
    } else {
        None
    };
    if let Some(why) = refused {
        log(&format!(
            "refused {} {} from {}: {why}",
            req.method, req.path, caller.node.name
        ));
        let _ = http::write_json(
            &mut out,
            403,
            &fail_json(
                "not_allowed",
                why,
                "Use the polycarp command from another of your devices.",
            ),
        );
        return;
    }
    let status = match route(ctx, &req) {
        Reply::Json(s, body) => {
            let _ = http::write_json(&mut out, s, &body);
            s
        }
        Reply::File(path, len) => match fs::File::open(&path) {
            Ok(f) => {
                let sent = http::write_head(&mut out, 200, "application/octet-stream", len)
                    .and_then(|_| io::copy(&mut f.take(len), &mut out))
                    .and_then(|_| out.flush());
                if sent.is_ok() {
                    200
                } else {
                    499
                }
            }
            Err(_) => {
                let _ =
                    http::write_json(&mut out, 404, &fail_json("not_found", "no such file", ""));
                404
            }
        },
        Reply::Upload(name, len) => match save_upload(&ctx.inbox, &name, len, &mut reader) {
            Ok(dest) => {
                let _ = http::write_json(
                    &mut out,
                    201,
                    &ok_json(
                        json!({"device": ctx.me.name, "path": dest.display().to_string(), "size": len}),
                    ),
                );
                201
            }
            Err(e) => {
                let _ = http::write_json(&mut out, 400, &fail_json("io_error", &e, ""));
                400
            }
        },
    };
    // Never the query: a search or a path can say more than it should in a log.
    log(&format!(
        "{} {} from {} -> {status}",
        req.method, req.path, caller.node.name
    ));
}

fn log(line: &str) {
    eprintln!("polycarp files serve: {line}");
}

/// Accepts connections until the listener fails.
pub fn accept_loop(ctx: Arc<Ctx>, listener: TcpListener) {
    for conn in listener.incoming() {
        let Ok(stream) = conn else {
            continue;
        };
        let Ok(peer) = stream.peer_addr() else {
            continue;
        };
        if ctx.conns.fetch_add(1, Ordering::SeqCst) >= MAX_CONNS {
            ctx.conns.fetch_sub(1, Ordering::SeqCst);
            let mut s = stream;
            let _ = http::write_json(
                &mut s,
                503,
                &fail_json("busy", "too many connections", "Try again in a moment."),
            );
            continue;
        }
        let c = Arc::clone(&ctx);
        std::thread::spawn(move || {
            handle_conn(&c, stream, peer);
            c.conns.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

/// Binds each address and serves them all. Fails only when none could be bound.
pub fn serve(ctx: Arc<Ctx>, addrs: &[SocketAddr]) -> Result<(), String> {
    let mut threads = Vec::new();
    let mut errors = Vec::new();
    for a in addrs {
        debug_assert!(is_tailscale_ip(&a.ip()));
        match TcpListener::bind(a) {
            Ok(l) => {
                log(&format!("listening on {a}"));
                let c = Arc::clone(&ctx);
                threads.push(std::thread::spawn(move || accept_loop(c, l)));
            }
            Err(e) => errors.push(format!("{a}: {e}")),
        }
    }
    if threads.is_empty() {
        return Err(format!("could not listen: {}", errors.join("; ")));
    }
    for t in threads {
        let _ = t.join();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    pub struct Stub {
        pub me: Node,
        pub by_ip: HashMap<IpAddr, Node>,
    }

    impl Tailnet for Stub {
        fn status(&self) -> Result<super::super::tailnet::Status, String> {
            Ok(super::super::tailnet::Status {
                backend: "Running".into(),
                me: Some(self.me.clone()),
                peers: self.by_ip.values().cloned().collect(),
            })
        }
        fn whois(&self, addr: SocketAddr) -> Result<Node, String> {
            self.by_ip
                .get(&addr.ip())
                .cloned()
                .ok_or_else(|| "no such peer".to_string())
        }
    }

    pub fn node(name: &str, user: i64, ip: &str) -> Node {
        Node {
            name: name.into(),
            dns: format!("{name}.tail.ts.net"),
            ips: vec![ip.parse().unwrap()],
            user,
            online: true,
            os: "macOS".into(),
            tags: Vec::new(),
        }
    }

    #[test]
    fn tagged_nodes_are_never_let_in_and_a_tagged_node_serves_no_one() {
        use super::super::tailnet::{parse_status, parse_whois};
        // Every tagged node has the same tagged-devices user id, so the user check alone would let them in.
        let tagged = |name: &str| {
            parse_whois(&format!(r#"{{"Node":{{"Name":"{name}.t.ts.net.","User":42,"Tags":["tag:server"],"Addresses":["100.64.0.9/32"]}},"UserProfile":{{"ID":42}}}}"#)).unwrap()
        };
        let owner = node("mac", 42, "100.64.0.1");
        assert!(
            authorize(Ok(tagged("ci-runner")), &owner, &[]).is_err(),
            "tagged caller"
        );
        let s = parse_status(r#"{"BackendState":"Running","Self":{"DNSName":"srv.t.ts.net.","TailscaleIPs":["100.64.0.2"],"UserID":42,"Online":true,"Tags":["tag:server"]}}"#).unwrap();
        let me = s.me.unwrap();
        let laptop = node("laptop", 42, "100.64.0.3");
        assert!(authorize(Ok(laptop), &me, &[]).is_err(), "tagged me");
        assert!(
            authorize(Ok(tagged("other")), &me, &[]).is_err(),
            "tagged me, tagged caller"
        );
    }

    #[test]
    fn whois_lets_in_only_the_same_user_and_the_listed_devices() {
        let me = node("mac", 7, "100.100.0.1");
        let stub = Stub {
            me: me.clone(),
            by_ip: [
                ("100.100.0.2", node("parish1", 7, "100.100.0.2")),
                ("100.100.0.3", node("friend", 9, "100.100.0.3")),
                ("100.100.0.4", node("chapel1", 7, "100.100.0.4")),
            ]
            .into_iter()
            .map(|(ip, n)| (ip.parse().unwrap(), n))
            .collect(),
        };
        let at = |ip: &str| stub.whois(SocketAddr::new(ip.parse().unwrap(), 5555));
        assert!(authorize(at("100.100.0.2"), &me, &[]).is_ok(), "same user");
        let e = authorize(at("100.100.0.3"), &me, &[]).unwrap_err();
        assert!(e.contains("another Tailscale user"), "{e}");
        assert!(
            authorize(at("100.100.0.9"), &me, &[]).is_err(),
            "unknown node"
        );
        let allow = vec!["Parish1".to_string()];
        assert!(authorize(at("100.100.0.2"), &me, &allow).is_ok());
        let e = authorize(at("100.100.0.4"), &me, &allow).unwrap_err();
        assert!(e.contains("allow_devices"), "{e}");
        // The allowlist never lets another user in.
        let allow = vec!["friend".to_string()];
        assert!(authorize(at("100.100.0.3"), &me, &allow).is_err());
    }

    #[test]
    fn bind_is_never_a_wildcard_loopback_or_lan_address() {
        let ips: Vec<IpAddr> = vec![
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            "192.168.1.20".parse().unwrap(),
            "100.200.1.1".parse().unwrap(),
            "100.107.206.73".parse().unwrap(),
            "fd7a:115c:a1e0::b73b:ce49".parse().unwrap(),
        ];
        let got = bind_addrs(&ips, 41771).unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        for a in &got {
            assert!(!a.ip().is_unspecified() && is_tailscale_ip(&a.ip()));
            assert_ne!(a.ip(), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        }
        assert!(bind_addrs(&[IpAddr::V4(Ipv4Addr::UNSPECIFIED)], 41771).is_err());
        assert!(bind_addrs(&[], 41771).is_err());
    }

    fn ctx_with(dir: &Path, allow_save: bool) -> Ctx {
        let root = dir.join("root");
        fs::create_dir_all(&root).unwrap();
        let me = node("mac", 7, "100.100.0.1");
        let cfg = Config {
            allow_save,
            ..Config::default()
        };
        Ctx::new(
            cfg,
            vec![Root {
                path: root,
                text: true,
            }],
            dir.join("index.sqlite"),
            dir.join("inbox"),
            Arc::new(Stub {
                me: me.clone(),
                by_ip: HashMap::new(),
            }),
            me,
        )
    }

    fn put(name: &str, len: u64) -> Request {
        Request {
            method: "PUT".into(),
            path: "/v1/inbox".into(),
            query: vec![("name".into(), name.into())],
            content_length: Some(len),
            ..Request::default()
        }
    }

    fn tmp(tag: &str) -> PathBuf {
        // Not the system temp folder: on Windows it sits under AppData, which `never` refuses to share.
        let d = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/tmp")
            .join(format!("pc-files-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn uploads_are_refused_unless_allow_save_is_on() {
        let d = tmp("upload");
        let off = ctx_with(&d, false);
        match route(&off, &put("a.txt", 3)) {
            Reply::Json(403, body) => assert_eq!(body["error"]["code"], "save_off"),
            other => panic!("{other:?}"),
        }
        let on = ctx_with(&d, true);
        assert_eq!(
            route(&on, &put("a.txt", 3)),
            Reply::Upload("a.txt".into(), 3)
        );
        for bad in ["../x", ".env", "a/b", "id_rsa", ""] {
            assert!(
                matches!(route(&on, &put(bad, 3)), Reply::Json(400, _)),
                "{bad}"
            );
        }
        let saved = save_upload(&on.inbox, "a.txt", 3, &mut &b"abc"[..]).unwrap();
        assert_eq!(fs::read(&saved).unwrap(), b"abc");
        let again = save_upload(&on.inbox, "a.txt", 3, &mut &b"xyz"[..]).unwrap();
        assert_ne!(saved, again, "an upload never replaces a file");
        assert!(save_upload(&on.inbox, "b.txt", 10, &mut &b"short"[..]).is_err());
        assert!(!on.inbox.join("b.txt").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn only_files_inside_a_root_and_past_the_rules_are_shared() {
        let d = tmp("share");
        let c = ctx_with(&d, false);
        let root = &c.roots[0].path;
        fs::write(root.join("notes.md"), "hi").unwrap();
        fs::write(root.join("api-key.txt"), "secret").unwrap();
        fs::write(d.join("outside.txt"), "no").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/x.js"), "x").unwrap();
        let ok = |p: &Path| shareable(&c.roots, &[], &p.to_string_lossy());
        assert!(ok(&root.join("notes.md")).is_ok());
        assert_eq!(ok(&root.join("api-key.txt")).unwrap_err().0, 403);
        assert_eq!(ok(&d.join("outside.txt")).unwrap_err().0, 403);
        assert_eq!(ok(&root.join("../outside.txt")).unwrap_err().0, 403);
        assert_eq!(ok(&root.join("node_modules/x.js")).unwrap_err().0, 403);
        assert_eq!(shareable(&c.roots, &[], "relative.md").unwrap_err().0, 400);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_connection_from_another_user_gets_403_before_its_request_is_read() {
        let d = tmp("conn");
        let mut c = ctx_with(&d, false);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        // The test listener is on loopback; whois decides by the caller's address.
        c.tailnet = Arc::new(Stub {
            me: c.me.clone(),
            by_ip: [(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                node("friend", 9, "100.100.0.3"),
            )]
            .into_iter()
            .collect(),
        });
        let c = Arc::new(c);
        let cc = Arc::clone(&c);
        let t = std::thread::spawn(move || {
            let (s, peer) = listener.accept().unwrap();
            handle_conn(&cc, s, peer);
        });
        let r = http::request(addr, "GET", "/v1/health", None, Duration::from_secs(5)).unwrap();
        t.join().unwrap();
        assert_eq!(r.status, 403);
        let v: Json = serde_json::from_slice(&r.body).unwrap();
        assert_eq!(v["error"]["code"], "not_allowed");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_owners_device_can_search_and_download() {
        let d = tmp("e2e");
        let mut c = ctx_with(&d, false);
        let root = c.roots[0].path.clone();
        fs::write(root.join("sermon.md"), "grace and peace").unwrap();
        let mut idx = Index::open(&c.index).unwrap();
        idx.update(&c.roots, &[]).unwrap();
        c.tailnet = Arc::new(Stub {
            me: c.me.clone(),
            by_ip: [(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                node("parish1", 7, "100.100.0.2"),
            )]
            .into_iter()
            .collect(),
        });
        let c = Arc::new(c);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let cc = Arc::clone(&c);
        std::thread::spawn(move || accept_loop(cc, listener));
        let t = Duration::from_secs(5);
        let r = http::request(addr, "GET", "/v1/search?q=grace", None, t).unwrap();
        assert_eq!(r.status, 200);
        let v: Json = serde_json::from_slice(&r.body).unwrap();
        assert_eq!(v["data"]["results"][0]["name"], "sermon.md");
        assert_eq!(v["data"]["results"][0]["device"], "mac");
        let target = format!(
            "/v1/file?{}",
            http::query_string(&[("path", &root.join("sermon.md").to_string_lossy())])
        );
        let mut got = Vec::new();
        let r = http::download(addr, &target, t, &mut got).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(got, b"grace and peace");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn serve_search_shows_only_rows_under_a_configured_root() {
        let d = tmp("pruned");
        let c = ctx_with(&d, false);
        fs::write(c.roots[0].path.join("alpha.md"), "x").unwrap();
        let other = d.join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("bravo.md"), "x").unwrap();
        // Rows from a folder that was a root once, and is not any more.
        let both = [
            c.roots[0].clone(),
            Root {
                path: other,
                text: true,
            },
        ];
        Index::open(&c.index).unwrap().update(&both, &[]).unwrap();
        let get = |q: &str| Request {
            method: "GET".into(),
            path: "/v1/search".into(),
            query: vec![("q".into(), q.into())],
            ..Request::default()
        };
        match route(&c, &get("bravo")) {
            Reply::Json(200, v) => assert_eq!(v["data"]["results"], json!([]), "{v}"),
            other => panic!("{other:?}"),
        }
        match route(&c, &get("alpha")) {
            Reply::Json(200, v) => assert_eq!(v["data"]["results"].as_array().unwrap().len(), 1),
            other => panic!("{other:?}"),
        }
        let _ = fs::remove_dir_all(&d);
    }

    mod rebind_test;
    use rebind_test::serve_as;

    #[test]
    fn this_device_itself_may_check_health_and_nothing_else() {
        // Another account on this machine dialing its own Tailscale IP looks like this node to whois.
        let d = tmp("self");
        let c = ctx_with(&d, false);
        let me = c.me.clone();
        let addr = serve_as(c, me);
        let t = Duration::from_secs(5);
        let r = http::request(addr, "GET", "/v1/search?q=x", None, t).unwrap();
        assert_eq!(r.status, 403, "search from this node");
        let r = http::request(addr, "GET", "/v1/meta?path=/x", None, t).unwrap();
        assert_eq!(r.status, 403, "meta from this node");
        let r = http::request(addr, "GET", "/v1/health", None, t).unwrap();
        assert_eq!(r.status, 200, "health from this node");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn doctor_sees_its_own_service_when_allow_devices_leaves_this_device_out() {
        let d = tmp("doctor-allow");
        let mut c = ctx_with(&d, false);
        c.cfg.allow_devices = vec!["parish1".into()];
        // Doctor dials this node's own address; here that is the loopback listener.
        c.me.ips = vec![IpAddr::V4(Ipv4Addr::LOCALHOST)];
        let me = c.me.clone();
        let addr = serve_as(c, me.clone());
        let cfg = Config {
            allow_devices: vec!["parish1".into()],
            port: Some(addr.port()),
            index_path: Some(d.join("index.sqlite").to_string_lossy().into_owned()),
            roots: Some(vec![d.join("root").to_string_lossy().into_owned()]),
            ..Config::default()
        };
        let stub: Arc<dyn Tailnet> = Arc::new(Stub {
            me,
            by_ip: HashMap::new(),
        });
        let f = super::super::doctor::gather(&cfg, Some(("tailscale".into(), stub)));
        assert!(f.serve_running, "serve_error: {:?}", f.serve_error);
        assert!(!super::super::doctor::fix_plan(&f)
            .contains(&super::super::doctor::Action::RestartService));
        let _ = fs::remove_dir_all(&d);
    }
}
