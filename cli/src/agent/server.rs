//! `polycarp agent serve` over HTTP: MCP Streamable HTTP (JSON or SSE answers, a GET event stream, DELETE to end a
//! session) and the OAuth endpoints, on loopback only. A tunnel (the person's own cloudflared or Tailscale Serve)
//! reaches it there. With `--tailnet` a second listener takes the owner's own devices on this device's Tailscale
//! addresses, after whois.
//!
//! The rules every request meets, in order:
//! 1. Host names this server: a loopback name, or the host of a tunnel this channel allows. A stable install with an
//!    own tunnel left from a nightly gets the waitlist message instead. This stops DNS rebinding.
//! 2. A request a web page sent (Origin, or Sec-Fetch-Site other than none) may only read the public metadata and
//!    the approval page. It can never reach /mcp, /token, /register or /revoke, and nothing here sends CORS headers.
//! 3. /mcp needs a bearer token: an OAuth access token for this endpoint, or a local token from `token create`
//!    (refused through a public tunnel unless it was made with --remote).

use super::auth::{redirect_host, AuthzErr, Caller, Origin, Poll, State};
use super::gateway::{Gateway, Session};
use super::policy;
use super::store::{self, Settings, Tunnel, APPROVALS_FILE, AUTH_FILE};
use crate::channel::Channel;
use crate::files::http::{percent_decode, read_line};
use crate::files::serve::{authorize as whois_authorize, host_ok};
use crate::files::tailnet::{Node, Tailnet};
use serde_json::{json, Value as Json};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_BODY: usize = 4 << 20;
const MAX_HEADERS: usize = 64;
const MAX_CONNS: usize = 32;
/// Open GET event streams at once; each holds a connection.
const MAX_STREAMS: usize = 4;
const MAX_SESSIONS: usize = 200;
const SESSION_IDLE: Duration = Duration::from_secs(3600);
const STREAM_LIFE: Duration = Duration::from_secs(600);
const WHOIS_TTL: Duration = Duration::from_secs(30);

// ------------------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
pub struct Req {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    /// Names lowercased.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Req {
    pub fn header(&self, k: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
    }

    /// A web page sent it.
    pub fn sent_by_page(&self) -> bool {
        self.header("origin").is_some()
            || self
                .header("sec-fetch-site")
                .is_some_and(|v| !v.trim().eq_ignore_ascii_case("none"))
    }
}

fn bad(m: &str) -> (u16, String) {
    (400, m.to_string())
}

/// One request, body included. Errors are (status, why).
pub fn read_req(r: &mut impl BufRead) -> Result<Req, (u16, String)> {
    let line = read_line(r).map_err(|e| bad(&e.to_string()))?;
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(bad("bad request line"));
    };
    if !version.starts_with("HTTP/1.") || !target.starts_with('/') {
        return Err(bad("bad request line"));
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        if headers.len() > MAX_HEADERS {
            return Err(bad("too many headers"));
        }
        let h = read_line(r).map_err(|e| bad(&e.to_string()))?;
        if h.is_empty() {
            break;
        }
        let Some((k, v)) = h.split_once(':') else {
            return Err(bad("bad header"));
        };
        if k.is_empty()
            || k.bytes()
                .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        {
            return Err(bad("bad header"));
        }
        let k = k.to_ascii_lowercase();
        let once = [
            "host",
            "content-length",
            "transfer-encoding",
            "authorization",
            "content-type",
            "origin",
        ];
        if once.contains(&k.as_str()) && headers.iter().any(|(n, _)| *n == k) {
            return Err(bad(&format!("two {k} headers")));
        }
        headers.push((k, v.trim().to_string()));
    }
    let (path, q) = target.split_once('?').unwrap_or((target, ""));
    let query = q
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (percent_decode(k), percent_decode(v))
        })
        .collect();
    let mut req = Req {
        method: method.to_string(),
        path: path.to_string(),
        query,
        headers,
        body: Vec::new(),
    };
    let te = req.header("transfer-encoding").map(str::to_ascii_lowercase);
    let cl = req.header("content-length").map(str::to_string);
    match (te, cl) {
        (Some(_), Some(_)) => return Err(bad("Content-Length and Transfer-Encoding together")),
        (Some(t), None) if t == "chunked" => req.body = read_chunked(r)?,
        (Some(_), None) => return Err(bad("only chunked transfer encoding")),
        (None, Some(n)) => {
            let n: usize = n.parse().map_err(|_| bad("bad Content-Length"))?;
            if n > MAX_BODY {
                return Err((413, "the body is too large".into()));
            }
            let mut body = vec![0u8; n];
            r.read_exact(&mut body)
                .map_err(|_| bad("the body was cut short"))?;
            req.body = body;
        }
        (None, None) => {}
    }
    Ok(req)
}

fn read_chunked(r: &mut impl BufRead) -> Result<Vec<u8>, (u16, String)> {
    let mut body = Vec::new();
    loop {
        let line = read_line(r).map_err(|e| bad(&e.to_string()))?;
        let size = line.split(';').next().unwrap_or_default().trim();
        // At most 16 hex digits and nothing else (no sign), so the number fits before it is checked.
        if size.is_empty() || size.len() > 16 || !size.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(bad("bad chunk size"));
        }
        let n = u64::from_str_radix(size, 16).map_err(|_| bad("bad chunk size"))?;
        if n == 0 {
            // Trailers, then the empty line.
            for _ in 0..=MAX_HEADERS {
                if read_line(r).map_err(|e| bad(&e.to_string()))?.is_empty() {
                    return Ok(body);
                }
            }
            return Err(bad("too many trailers"));
        }
        let total = usize::try_from(n)
            .ok()
            .and_then(|n| body.len().checked_add(n))
            .filter(|t| *t <= MAX_BODY);
        let Some(total) = total else {
            return Err((413, "the body is too large".into()));
        };
        let start = body.len();
        body.resize(total, 0);
        r.read_exact(&mut body[start..])
            .map_err(|_| bad("a chunk was cut short"))?;
        if !read_line(r).map_err(|e| bad(&e.to_string()))?.is_empty() {
            return Err(bad("a chunk ran long"));
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// A GET event stream for this session, instead of a body.
    pub stream: Option<String>,
}

impl Resp {
    pub fn new(status: u16, ctype: &str, body: Vec<u8>) -> Resp {
        let mut r = Resp {
            status,
            headers: Vec::new(),
            body,
            stream: None,
        };
        if !ctype.is_empty() {
            r = r.with("Content-Type", ctype);
        }
        r
    }
    pub fn json(status: u16, v: &Json) -> Resp {
        Resp::new(status, "application/json", v.to_string().into_bytes())
    }
    pub fn empty(status: u16) -> Resp {
        Resp::new(status, "", Vec::new())
    }
    pub fn fail(status: u16, code: &str, message: &str, suggestion: &str) -> Resp {
        Resp::json(status, &crate::files::fail_json(code, message, suggestion))
    }
    pub fn redirect(to: &str) -> Resp {
        Resp::empty(302).with("Location", to)
    }
    pub fn with(mut self, k: &str, v: &str) -> Resp {
        self.headers.push((k.to_string(), v.to_string()));
        self
    }
    #[cfg(test)]
    pub fn header(&self, k: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.as_str())
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        410 => "Gone",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

fn write_head(w: &mut impl Write, r: &Resp, len: Option<usize>) -> io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n", r.status, reason(r.status));
    for (k, v) in &r.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(n) = len {
        head.push_str(&format!("Content-Length: {n}\r\n"));
    }
    head.push_str(
        "Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\r\n",
    );
    w.write_all(head.as_bytes())
}

pub fn write_resp(w: &mut impl Write, r: &Resp) -> io::Result<()> {
    write_head(w, r, Some(r.body.len()))?;
    w.write_all(&r.body)?;
    w.flush()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// A page of our own: no scripts, no frames, nothing loaded from elsewhere.
fn page(status: u16, title: &str, body_html: &str, refresh: Option<&str>) -> Resp {
    let meta = refresh
        .map(|u| {
            format!(
                "<meta http-equiv=\"refresh\" content=\"3;url={}\">",
                html_escape(u)
            )
        })
        .unwrap_or_default();
    let doc = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">{meta}\
<title>{t}</title><style>body{{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:34em;margin:3em auto;padding:0 1em}}\
code{{font:600 1.4em ui-monospace,monospace;letter-spacing:.08em}}</style></head><body><h1>{t}</h1>{body_html}</body></html>",
        t = html_escape(title)
    );
    Resp::new(status, "text/html; charset=utf-8", doc.into_bytes())
        .with("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'")
        .with("X-Frame-Options", "DENY")
}

/// Standard base64, for `Authorization: Basic`.
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim().trim_end_matches('=');
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::new();
    for chunk in s.as_bytes().chunks(4) {
        if chunk.len() == 1 {
            return None;
        }
        let mut n = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            n |= val(*c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// Client id and key from `Authorization: Basic` (each form-encoded, RFC 6749 section 2.3.1).
pub fn basic_auth(header: Option<&str>) -> Option<(String, String)> {
    let raw = header?.strip_prefix("Basic ")?;
    let text = String::from_utf8(base64_decode(raw)?).ok()?;
    let (id, key) = text.split_once(':')?;
    Some((percent_decode(id), percent_decode(key)))
}

fn form(body: &[u8]) -> Option<Vec<(String, String)>> {
    let text = std::str::from_utf8(body).ok()?;
    Some(
        text.split('&')
            .filter(|p| !p.is_empty())
            .map(|p| {
                let (k, v) = p.split_once('=').unwrap_or((p, ""));
                (percent_decode(k), percent_decode(v))
            })
            .collect(),
    )
}

/// OAuth parameters may each appear once (RFC 6749 section 3.1).
fn repeated(f: &[(String, String)]) -> Option<&str> {
    f.iter()
        .enumerate()
        .find(|(i, (k, _))| f[..*i].iter().any(|(k2, _)| k2 == k))
        .map(|(_, (k, _))| k.as_str())
}

/// The host name and port of a Host header, or None when it isn't one.
fn split_host(h: &str) -> Option<(String, Option<u16>)> {
    let h = h.trim();
    let (name, port) = match h.strip_prefix('[') {
        Some(rest) => {
            let (ip, p) = rest.split_once(']')?;
            (
                ip,
                if p.is_empty() {
                    None
                } else {
                    Some(p.strip_prefix(':')?)
                },
            )
        }
        None => match h.rsplit_once(':') {
            Some((n, p)) => (n, Some(p)),
            None => (h, None),
        },
    };
    let port = match port {
        Some(p) => Some(p.parse::<u16>().ok()?),
        None => None,
    };
    (!name.is_empty()).then(|| (name.trim_end_matches('.').to_ascii_lowercase(), port))
}

/// A Host header for this machine's loopback.
pub fn loopback_host(h: &str) -> bool {
    split_host(h).is_some_and(|(n, _)| matches!(n.as_str(), "127.0.0.1" | "localhost" | "::1"))
}

/// Loopback only: anything else would put the gateway on a network without the checks the tailnet listener makes.
pub fn check_bind(ip: IpAddr) -> Result<(), String> {
    if ip.is_loopback() {
        Ok(())
    } else {
        Err(format!(
            "polycarp agent serve listens on loopback only (127.0.0.1 or ::1), not {ip}. For your other devices use \
--tailnet, which checks who each one is; for the internet, a tunnel (`polycarp agent tunnel --help`)."
        ))
    }
}

// ------------------------------------------------------------------------------------------------
// The server
// ------------------------------------------------------------------------------------------------

struct Sess {
    owner: String,
    last: Instant,
    s: Session,
}

pub struct TailCtx {
    pub tailnet: Arc<dyn Tailnet>,
    pub me: Node,
    cache: Mutex<HashMap<IpAddr, (Instant, Node)>>,
}

impl TailCtx {
    pub fn new(tailnet: Arc<dyn Tailnet>, me: Node) -> TailCtx {
        TailCtx {
            tailnet,
            me,
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn whois(&self, addr: SocketAddr) -> Result<Node, String> {
        if let Ok(c) = self.cache.lock() {
            if let Some((at, n)) = c.get(&addr.ip()) {
                if at.elapsed() < WHOIS_TTL {
                    return Ok(n.clone());
                }
            }
        }
        let n = self.tailnet.whois(addr)?;
        if let Ok(mut c) = self.cache.lock() {
            c.insert(addr.ip(), (Instant::now(), n.clone()));
        }
        Ok(n)
    }
}

pub struct Ctx {
    pub dir: PathBuf,
    pub gw: Gateway,
    pub channel: Channel,
    pub settings: Settings,
    pub tailnet: Option<TailCtx>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Sess>>>>,
    limits: Mutex<HashMap<&'static str, Vec<Instant>>>,
    conns: AtomicUsize,
    streams: AtomicUsize,
}

/// How a request reached the loopback listener.
#[derive(Debug, Clone, PartialEq)]
enum Via {
    Local,
    Tunnel(Tunnel),
}

impl Ctx {
    pub fn new(dir: PathBuf, gw: Gateway, channel: Channel, settings: Settings) -> Ctx {
        Ctx {
            dir,
            gw,
            channel,
            settings,
            tailnet: None,
            sessions: Mutex::new(HashMap::new()),
            limits: Mutex::new(HashMap::new()),
            conns: AtomicUsize::new(0),
            streams: AtomicUsize::new(0),
        }
    }

    /// Reads auth.json. Files are replaced whole, so a reader needs no lock.
    fn state(&self) -> Result<State, String> {
        store::read_json(&self.dir.join(AUTH_FILE))
    }

    fn with_state<T>(&self, f: impl FnOnce(&mut State) -> T) -> Result<T, String> {
        change_state(&self.dir, f)
    }

    /// At most `per_minute` calls of `key` in the last minute. A single owner needs few; a flood is someone else.
    fn limited(&self, key: &'static str, per_minute: usize) -> bool {
        let Ok(mut l) = self.limits.lock() else {
            return true;
        };
        let hits = l.entry(key).or_default();
        hits.retain(|t| t.elapsed() < Duration::from_secs(60));
        if hits.len() >= per_minute {
            return true;
        }
        hits.push(Instant::now());
        false
    }

    /// The tunnel a request came through, when its Host names one. Err when it names a tunnel this channel refuses.
    fn via(&self, host: &str) -> Result<Option<Via>, Resp> {
        if loopback_host(host) {
            return Ok(Some(Via::Local));
        }
        let Some(t) = Tunnel::load(&self.dir) else {
            return Ok(None);
        };
        let (Some((name, _)), Some((want, _))) = (split_host(host), split_host(&t.host)) else {
            return Ok(None);
        };
        if name != want {
            return Ok(None);
        }
        let Some(route) = t.route() else {
            return Ok(None);
        };
        let invited = policy::load_invite(&self.dir).is_some();
        match policy::check(self.channel, route, invited) {
            Ok(()) => Ok(Some(Via::Tunnel(t))),
            Err(r) => Err(Resp::fail(403, r.code, &r.message, "")),
        }
    }

    fn session(&self, id: &str) -> Option<Arc<Mutex<Sess>>> {
        self.sessions.lock().ok()?.get(id).cloned()
    }

    fn new_session(&self, owner: &str) -> Option<(String, Arc<Mutex<Sess>>)> {
        let mut map = self.sessions.lock().ok()?;
        map.retain(|_, s| {
            s.lock()
                .map(|s| s.last.elapsed() < SESSION_IDLE)
                .unwrap_or(false)
        });
        if map.len() >= MAX_SESSIONS {
            return None;
        }
        let id = store::secret("");
        let s = Arc::new(Mutex::new(Sess {
            owner: owner.to_string(),
            last: Instant::now(),
            s: Session::default(),
        }));
        map.insert(id.clone(), s.clone());
        Some((id, s))
    }
}

/// Changes auth.json under the lock every writer takes (`serve`, `approve`, `revoke`, `token create`), and refreshes
/// the approvals notice when anything changed.
pub fn change_state<T>(
    dir: &std::path::Path,
    f: impl FnOnce(&mut State) -> T,
) -> Result<T, String> {
    let _l = store::Lock::take(dir)?;
    let mut st: State = store::read_json(&dir.join(AUTH_FILE))?;
    let before = serde_json::to_vec(&st).map_err(|e| e.to_string())?;
    let out = f(&mut st);
    if serde_json::to_vec(&st).map_err(|e| e.to_string())? != before {
        store::write_json(&dir.join(AUTH_FILE), &st)?;
        publish_approvals(dir, &mut st, store::now());
    }
    Ok(out)
}

/// What the app may show: the connections waiting for the owner (client, where codes go, how it came, scopes). Never
/// the approval code: the owner reads that off the page in the browser that started the connection, so a request
/// someone else started can't be approved from a list.
pub fn publish_approvals(dir: &std::path::Path, st: &mut State, now: i64) {
    let waiting: Vec<Json> = st
        .waiting(now)
        .iter()
        .map(|p| {
            let name = st
                .clients
                .get(&p.client)
                .map(|c| c.name.clone())
                .unwrap_or_default();
            json!({
                "client": p.client,
                "name": name,
                "scopes": p.scopes,
                "redirect_host": redirect_host(&p.redirect_uri),
                "origin": p.origin,
                "unverified": st.unverified(p),
                "created": p.created,
                "expires": p.expires,
            })
        })
        .collect();
    let _ = store::write_json(
        &dir.join(APPROVALS_FILE),
        &json!({"updated": now, "waiting": waiting}),
    );
}

fn log(line: &str) {
    eprintln!("polycarp agent: {line}");
}

fn health() -> Resp {
    Resp::json(
        200,
        &crate::files::ok_json(
            json!({"name": "polycarp-agent", "version": env!("CARGO_PKG_VERSION")}),
        ),
    )
}

/// Paths a web page may load: the public metadata and the approval page, all GET.
fn browser_may(req: &Req) -> bool {
    req.method == "GET"
        && (matches!(
            req.path.as_str(),
            "/" | "/health" | "/authorize" | "/authorize/wait"
        ) || req.path.starts_with("/.well-known/"))
}

/// Everything on the loopback listener (and so everything a tunnel forwards).
pub fn route_local(ctx: &Ctx, req: &Req) -> Resp {
    let host = req.header("host").unwrap_or_default();
    let via = match ctx.via(host) {
        Ok(Some(v)) => v,
        Ok(None) => {
            return Resp::fail(
                403,
                "wrong_host",
                "this server answers only to its own names: the request named another host",
                "Use http://127.0.0.1 and the port polycarp agent serve printed.",
            )
        }
        Err(r) => return r,
    };
    if req.sent_by_page() && !browser_may(req) {
        return Resp::fail(
            403,
            "not_allowed",
            "web pages may not use this server: the request came from a browser",
            "Add Polycarp to your assistant as a connector; its server talks to this one, not the page.",
        );
    }
    let base = match &via {
        Via::Local => format!("http://{}", host.trim()),
        Via::Tunnel(t) => t.public_url.trim_end_matches('/').to_string(),
    };
    let via_tunnel = matches!(via, Via::Tunnel(_));
    let origin = if via_tunnel {
        Origin::Tunnel
    } else {
        Origin::Local
    };
    let now = store::now();
    let p = req.path.as_str();
    match (req.method.as_str(), p) {
        ("GET", "/") => Resp::json(
            200,
            &json!({"name": "polycarp-agent", "mcp": format!("{base}/mcp"),
                "docs": "https://github.com/baney75/polycarp/blob/main/docs/agents.md"}),
        ),
        ("GET", "/health") => health(),
        ("GET", _)
            if p == "/.well-known/oauth-protected-resource"
                || p.starts_with("/.well-known/oauth-protected-resource/") =>
        {
            Resp::json(
                200,
                &json!({
                    "resource": format!("{base}/mcp"),
                    "authorization_servers": [base],
                    "scopes_supported": super::auth::SCOPES,
                    "bearer_methods_supported": ["header"],
                    "resource_name": "Polycarp",
                }),
            )
        }
        ("GET", _)
            if p == "/.well-known/oauth-authorization-server"
                || p.starts_with("/.well-known/oauth-authorization-server/") =>
        {
            Resp::json(200, &as_metadata(&base))
        }
        ("POST", "/register") => register(ctx, req, origin, now),
        ("GET", "/authorize") => authorize(ctx, req, &base, origin, now),
        ("GET", "/authorize/wait") => wait(ctx, req, &base, now),
        ("POST", "/token") => token(ctx, req, now),
        ("POST", "/revoke") => revoke(ctx, req),
        (_, "/mcp") => mcp(ctx, req, &base, via_tunnel, now),
        (_, "/register" | "/token" | "/revoke") => {
            Resp::fail(405, "method_not_allowed", "use POST", "").with("Allow", "POST")
        }
        (_, "/authorize" | "/authorize/wait") => {
            Resp::fail(405, "method_not_allowed", "use GET", "").with("Allow", "GET")
        }
        _ => Resp::fail(404, "not_found", "no such endpoint", ""),
    }
}

pub fn as_metadata(base: &str) -> Json {
    json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/authorize"),
        "token_endpoint": format!("{base}/token"),
        "registration_endpoint": format!("{base}/register"),
        "revocation_endpoint": format!("{base}/revoke"),
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", concat!("client_", "secret_basic"), concat!("client_", "secret_post")],
        "revocation_endpoint_auth_methods_supported": ["none", concat!("client_", "secret_basic"), concat!("client_", "secret_post")],
        "scopes_supported": super::auth::SCOPES,
        "authorization_response_iss_parameter_supported": true,
    })
}

fn oauth_fail(status: u16, error: &str, description: &str) -> Resp {
    Resp::json(
        status,
        &json!({"error": error, "error_description": description}),
    )
}

fn content_type_is(req: &Req, want: &str) -> bool {
    req.header("content-type")
        .and_then(|c| c.split(';').next())
        .is_some_and(|c| c.trim().eq_ignore_ascii_case(want))
}

fn register(ctx: &Ctx, req: &Req, origin: Origin, now: i64) -> Resp {
    if ctx.limited("register", 20) {
        return oauth_fail(429, "slow_down", "too many registrations; wait a minute");
    }
    if !content_type_is(req, "application/json") {
        return oauth_fail(
            415,
            "invalid_client_metadata",
            "send the metadata as application/json",
        );
    }
    let Ok(body) = serde_json::from_slice::<Json>(&req.body) else {
        return oauth_fail(400, "invalid_client_metadata", "the body is not JSON");
    };
    let extra = ctx.settings.extra_redirects.clone();
    match ctx.with_state(|s| s.register(&body, &extra, origin, now)) {
        Ok(Ok(j)) => {
            log(&format!(
                "registered a connector through {}: {} ({})",
                origin.name(),
                j["client_name"].as_str().unwrap_or("?"),
                j["client_id"].as_str().unwrap_or("?")
            ));
            Resp::json(201, &j)
        }
        Ok(Err(e)) => Resp::json(e.status, &e.json()),
        Err(e) => oauth_fail(500, "server_error", &e),
    }
}

fn waiting_page(name: &str, approval: &str, scopes: &[String], request: &str) -> Resp {
    let scopes: Vec<String> = scopes
        .iter()
        .map(|s| {
            format!(
                "<li><b>{}</b>: {}</li>",
                html_escape(s),
                html_escape(super::auth::scope_meaning(s))
            )
        })
        .collect();
    page(
        200,
        "Approve this connection on your Mac",
        &format!(
            "<p><b>{}</b> wants to connect to Polycarp. Nothing is shared until you approve it on the Mac that runs \
Polycarp. In Terminal there, run:</p><p><code>polycarp agent approve {}</code></p><p>It asks for:</p><ul>{}</ul>\
<p>To give it more or less, add <code>--scopes read,files,act</code>. To say no, run <code>polycarp agent deny {}</code>.</p>\
<p>This page goes on by itself once you approve. It expires in ten minutes. If you didn't start this, close the page \
and run the deny command.</p>",
            html_escape(name),
            html_escape(approval),
            scopes.join(""),
            html_escape(approval),
        ),
        Some(&format!("/authorize/wait?request={}", crate::files::http::percent_encode(request))),
    )
}

fn authorize(ctx: &Ctx, req: &Req, base: &str, origin: Origin, now: i64) -> Resp {
    if ctx.limited("authorize", 30) {
        return page(
            429,
            "Too many requests",
            "<p>Wait a minute and try again.</p>",
            None,
        );
    }
    if let Some(k) = repeated(&req.query) {
        return page(
            400,
            "Can't connect",
            &format!("<p>The request repeats {}.</p>", html_escape(k)),
            None,
        );
    }
    let resource = format!("{base}/mcp");
    let out = ctx.with_state(|s| {
        s.authorize(&req.query, &resource, origin, now)
            .map(|(id, p)| {
                let name = s
                    .clients
                    .get(&p.client)
                    .map(|c| c.name.clone())
                    .unwrap_or_default();
                let unverified = s.unverified(&p);
                (id, p, name, unverified)
            })
    });
    match out {
        Ok(Ok((id, p, name, unverified))) => {
            // No code here: the owner approves with the code on the page in the browser that started this.
            log(&format!(
                "{name} ({}) is waiting for approval through {}, scopes {}, codes to {}{}",
                p.client,
                origin.name(),
                p.scopes.join(","),
                redirect_host(&p.redirect_uri),
                if unverified { " (unverified)" } else { "" }
            ));
            waiting_page(&name, &p.approval, &p.scopes, &id)
        }
        Ok(Err(AuthzErr::Page(m))) => page(
            400,
            "Can't connect",
            &format!("<p>{}</p>", html_escape(&m)),
            None,
        ),
        Ok(Err(AuthzErr::Redirect(u))) => Resp::redirect(&u),
        Err(e) => page(
            500,
            "Can't connect",
            &format!("<p>{}</p>", html_escape(&e)),
            None,
        ),
    }
}

fn wait(ctx: &Ctx, req: &Req, base: &str, now: i64) -> Resp {
    let id = req
        .query
        .iter()
        .find(|(k, _)| k == "request")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let out = ctx.with_state(|s| {
        let poll = s.poll(&id, base, now);
        let name = match &poll {
            Poll::Waiting(p) => s
                .clients
                .get(&p.client)
                .map(|c| c.name.clone())
                .unwrap_or_default(),
            _ => String::new(),
        };
        (poll, name)
    });
    match out {
        Ok((Poll::Waiting(p), name)) => waiting_page(&name, &p.approval, &p.scopes, &id),
        Ok((Poll::Redirect(u), _)) => Resp::redirect(&u),
        Ok((Poll::Gone(m), _)) => page(
            410,
            "This request is over",
            &format!("<p>{}</p>", html_escape(&m)),
            None,
        ),
        Err(e) => page(
            500,
            "Can't connect",
            &format!("<p>{}</p>", html_escape(&e)),
            None,
        ),
    }
}

fn token_form(req: &Req) -> Result<Vec<(String, String)>, Resp> {
    if !content_type_is(req, "application/x-www-form-urlencoded") {
        return Err(oauth_fail(
            400,
            "invalid_request",
            "send the form as application/x-www-form-urlencoded",
        ));
    }
    let Some(f) = form(&req.body) else {
        return Err(oauth_fail(400, "invalid_request", "the form is not UTF-8"));
    };
    if let Some(k) = repeated(&f) {
        return Err(oauth_fail(
            400,
            "invalid_request",
            &format!("{k} is repeated"),
        ));
    }
    Ok(f)
}

fn token(ctx: &Ctx, req: &Req, now: i64) -> Resp {
    if ctx.limited("token", 60) {
        return oauth_fail(429, "slow_down", "too many token requests; wait a minute");
    }
    let f = match token_form(req) {
        Ok(f) => f,
        Err(r) => return r,
    };
    let basic = basic_auth(req.header("authorization"));
    match ctx.with_state(|s| s.token(&f, basic.clone(), now)) {
        Ok(Ok(j)) => Resp::json(200, &j).with("Pragma", "no-cache"),
        Ok(Err(e)) => {
            let r = Resp::json(e.status, &e.json());
            if e.status == 401 && basic.is_some() {
                r.with("WWW-Authenticate", "Basic realm=\"polycarp\"")
            } else {
                r
            }
        }
        Err(e) => oauth_fail(500, "server_error", &e),
    }
}

fn revoke(ctx: &Ctx, req: &Req) -> Resp {
    if ctx.limited("revoke", 60) {
        return oauth_fail(429, "slow_down", "too many requests; wait a minute");
    }
    let f = match token_form(req) {
        Ok(f) => f,
        Err(r) => return r,
    };
    let basic = basic_auth(req.header("authorization"));
    match ctx.with_state(|s| s.revoke_token(&f, basic)) {
        Ok(Ok(())) => Resp::empty(200),
        Ok(Err(e)) => Resp::json(e.status, &e.json()),
        Err(e) => oauth_fail(500, "server_error", &e),
    }
}

fn rpc_resp(status: u16, code: i64, message: &str) -> Resp {
    Resp::json(status, &crate::mcp::rpc_error(&Json::Null, code, message))
}

/// Who a /mcp request is. Err is the 401.
fn caller_of(ctx: &Ctx, req: &Req, base: &str, via_tunnel: bool, now: i64) -> Result<Caller, Resp> {
    let resource = format!("{base}/mcp");
    let header = req.header("authorization");
    let found = ctx.state().ok().and_then(|s| {
        let c = s.verify(header, &resource, via_tunnel, now)?;
        let stale = s
            .clients
            .get(&c.id)
            .map(|x| x.last_used)
            .or_else(|| s.bearers.iter().find(|b| b.id == c.id).map(|b| b.last_used))
            .flatten()
            .is_none_or(|t| now - t >= 60);
        Some((c, stale))
    });
    match found {
        Some((c, stale)) => {
            if stale {
                let _ = ctx.with_state(|s| s.touch(&c.id, now));
            }
            Ok(c)
        }
        None => {
            let mut challenge =
                format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource\"");
            if header.is_some() {
                challenge.push_str(", error=\"invalid_token\"");
            }
            Err(Resp::fail(
                401,
                "unauthorized",
                "this needs a token: connect the assistant with OAuth, or make one with `polycarp agent token create`",
                "",
            )
            .with("WWW-Authenticate", &challenge))
        }
    }
}

fn mcp(ctx: &Ctx, req: &Req, base: &str, via_tunnel: bool, now: i64) -> Resp {
    let caller = match caller_of(ctx, req, base, via_tunnel, now) {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Some(v) = req.header("mcp-protocol-version") {
        if !crate::mcp::KNOWN.contains(&v) {
            return rpc_resp(
                400,
                -32600,
                &format!("unsupported MCP-Protocol-Version {v}"),
            );
        }
    }
    let owned = |id: &str| {
        ctx.session(id)
            .filter(|s| s.lock().map(|s| s.owner == caller.id).unwrap_or(false))
    };
    let accept = req.header("accept").unwrap_or("").to_ascii_lowercase();
    match req.method.as_str() {
        "POST" => {
            if !content_type_is(req, "application/json") {
                return rpc_resp(415, -32600, "send JSON-RPC as application/json");
            }
            let json_ok =
                accept.is_empty() || accept.contains("application/json") || accept.contains("*/*");
            let sse_ok = accept.contains("text/event-stream");
            if !json_ok && !sse_ok {
                return rpc_resp(406, -32600, "accept application/json or text/event-stream");
            }
            let msg: Json = match serde_json::from_slice(&req.body) {
                Ok(m) => m,
                Err(e) => return rpc_resp(400, -32700, &format!("parse error: {e}")),
            };
            let init = msg.get("method").and_then(Json::as_str) == Some("initialize");
            let (new_id, sess) = if init {
                match ctx.new_session(&caller.id) {
                    Some((id, s)) => (Some(id), s),
                    None => return rpc_resp(503, -32000, "too many sessions; try again later"),
                }
            } else if let Some(id) = req.header("mcp-session-id") {
                match owned(id) {
                    Some(s) => (None, s),
                    None => return rpc_resp(404, -32001, "session not found; initialize again"),
                }
            } else {
                // No session: one message on its own.
                let s = Arc::new(Mutex::new(Sess {
                    owner: caller.id.clone(),
                    last: Instant::now(),
                    s: Session::default(),
                }));
                (None, s)
            };
            let answer = {
                let Ok(mut s) = sess.lock() else {
                    return rpc_resp(500, -32603, "session lock poisoned");
                };
                s.last = Instant::now();
                ctx.gw.handle(&msg, &caller, &mut s.s)
            };
            if let Some(name) = msg.pointer("/params/name").and_then(Json::as_str) {
                log(&format!("{} ({}) called {name}", caller.name, caller.id));
            }
            let mut r = match answer {
                None => Resp::empty(202),
                Some(a) if sse_ok && !json_ok => Resp::new(
                    200,
                    "text/event-stream",
                    format!("event: message\ndata: {a}\n\n").into_bytes(),
                ),
                Some(a) => Resp::json(200, &a),
            };
            if let Some(id) = new_id {
                r = r.with("Mcp-Session-Id", &id);
            }
            r
        }
        "GET" => {
            if !accept.contains("text/event-stream") {
                return rpc_resp(
                    406,
                    -32600,
                    "GET /mcp is an event stream: accept text/event-stream",
                );
            }
            let Some(id) = req.header("mcp-session-id") else {
                return rpc_resp(400, -32600, "GET /mcp needs Mcp-Session-Id");
            };
            if owned(id).is_none() {
                return rpc_resp(404, -32001, "session not found; initialize again");
            }
            let mut r = Resp::new(200, "text/event-stream", Vec::new()).with("Mcp-Session-Id", id);
            r.stream = Some(id.to_string());
            r
        }
        "DELETE" => {
            let Some(id) = req.header("mcp-session-id") else {
                return rpc_resp(400, -32600, "DELETE /mcp needs Mcp-Session-Id");
            };
            if owned(id).is_none() {
                return rpc_resp(404, -32001, "session not found");
            }
            if let Ok(mut m) = ctx.sessions.lock() {
                m.remove(id);
            }
            Resp::empty(204)
        }
        _ => Resp::fail(405, "method_not_allowed", "use POST, GET or DELETE", "")
            .with("Allow", "POST, GET, DELETE"),
    }
}

/// The tailnet listener: the owner's own devices, after whois, MCP only.
pub fn route_tailnet(ctx: &Ctx, req: &Req, me: &Node, local: SocketAddr) -> Resp {
    if req.sent_by_page() || !host_ok(req.header("host"), me, local) {
        return Resp::fail(
            403,
            "not_allowed",
            "web pages may not use this server: the request named another host or came from a browser",
            "",
        );
    }
    let base = format!("http://{}", req.header("host").unwrap_or_default().trim());
    match req.path.as_str() {
        "/health" if req.method == "GET" => health(),
        "/mcp" => mcp(ctx, req, &base, false, store::now()),
        _ => Resp::fail(
            404,
            "not_found",
            "the tailnet listener serves /mcp and /health only",
            "",
        ),
    }
}

// ------------------------------------------------------------------------------------------------
// Connections
// ------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Listener {
    Loopback,
    Tailnet,
}

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

fn stream_events(ctx: &Ctx, out: &mut TcpStream, r: &Resp, id: &str) {
    if ctx.streams.fetch_add(1, Ordering::SeqCst) >= MAX_STREAMS {
        ctx.streams.fetch_sub(1, Ordering::SeqCst);
        let _ = write_resp(out, &rpc_resp(429, -32000, "too many open event streams"));
        return;
    }
    let _slot = Slot(&ctx.streams);
    let started = Instant::now();
    let mut ok = write_head(out, r, None)
        .and_then(|_| out.write_all(b": ready\n\n"))
        .and_then(|_| out.flush())
        .is_ok();
    let mut ticks = 0u32;
    while ok && started.elapsed() < STREAM_LIFE && ctx.session(id).is_some() {
        std::thread::sleep(Duration::from_secs(1));
        ticks += 1;
        if ticks.is_multiple_of(15) {
            ok = out
                .write_all(b": keepalive\n\n")
                .and_then(|_| out.flush())
                .is_ok();
        }
    }
}

/// One taken slot of a counter; dropping it gives the slot back, even when a panic unwinds.
struct Slot<'a>(&'a AtomicUsize);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn serve_conn(ctx: &Ctx, stream: TcpStream, peer: SocketAddr, kind: Listener) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let (Ok(read_half), Ok(keep), Ok(local)) =
        (stream.try_clone(), stream.try_clone(), stream.local_addr())
    else {
        return;
    };
    let mut out = stream;
    let mut who = String::from("local");
    if kind == Listener::Tailnet {
        let Some(tc) = &ctx.tailnet else {
            return;
        };
        match whois_authorize(tc.whois(peer), &tc.me, &ctx.settings.allow_devices) {
            Ok(n) => who = n.name,
            Err(why) => {
                log(&format!("refused a tailnet connection: {why}"));
                let _ = write_resp(
                    &mut out,
                    &Resp::fail(
                        403,
                        "not_allowed",
                        &why,
                        "Only the owner's own devices may connect.",
                    ),
                );
                close_gently(keep);
                return;
            }
        }
    } else if !peer.ip().is_loopback() {
        close_gently(keep);
        return;
    }
    let mut reader = BufReader::new(read_half);
    let resp = match read_req(&mut reader) {
        Ok(req) => {
            let r = match (kind, &ctx.tailnet) {
                (Listener::Tailnet, Some(tc)) => route_tailnet(ctx, &req, &tc.me, local),
                _ => route_local(ctx, &req),
            };
            // Never the query or a header: they can carry codes and tokens.
            log(&format!(
                "{} {} from {who} -> {}",
                req.method, req.path, r.status
            ));
            r
        }
        Err((status, why)) => Resp::fail(status, "invalid_request", &why, ""),
    };
    match &resp.stream {
        Some(id) => stream_events(ctx, &mut out, &resp, id),
        None => {
            let _ = write_resp(&mut out, &resp);
        }
    }
    close_gently(keep);
}

fn accept_loop(ctx: Arc<Ctx>, l: TcpListener, kind: Listener) {
    for conn in l.incoming() {
        let Ok(stream) = conn else {
            continue;
        };
        let Ok(peer) = stream.peer_addr() else {
            continue;
        };
        if ctx.conns.fetch_add(1, Ordering::SeqCst) >= MAX_CONNS {
            ctx.conns.fetch_sub(1, Ordering::SeqCst);
            let mut s = stream;
            let _ = write_resp(
                &mut s,
                &Resp::fail(
                    503,
                    "busy",
                    "too many connections",
                    "Try again in a moment.",
                ),
            );
            continue;
        }
        let c = Arc::clone(&ctx);
        std::thread::spawn(move || {
            // Released on any exit, a panic included, so a slot never leaks.
            let _slot = Slot(&c.conns);
            serve_conn(&c, stream, peer, kind);
        });
    }
}

/// Binds the loopback addresses (each checked) and, when given, the tailnet ones, and serves them until they fail.
/// `ready` gets the bound loopback addresses (tests bind port 0).
pub fn serve(
    ctx: Arc<Ctx>,
    loopback: &[SocketAddr],
    tailnet: &[SocketAddr],
    ready: &dyn Fn(&[SocketAddr]),
) -> Result<(), String> {
    let mut threads = Vec::new();
    let mut bound = Vec::new();
    let mut errors = Vec::new();
    for a in loopback {
        check_bind(a.ip())?;
        match TcpListener::bind(a) {
            Ok(l) => {
                let at = l.local_addr().unwrap_or(*a);
                log(&format!("listening on http://{at}/mcp"));
                bound.push(at);
                let c = Arc::clone(&ctx);
                threads.push(std::thread::spawn(move || {
                    accept_loop(c, l, Listener::Loopback)
                }));
            }
            Err(e) => errors.push(format!("{a}: {e}")),
        }
    }
    if bound.is_empty() {
        return Err(format!("could not listen: {}", errors.join("; ")));
    }
    for a in tailnet {
        debug_assert!(crate::files::serve::is_tailscale_ip(&a.ip()));
        match TcpListener::bind(a) {
            Ok(l) => {
                log(&format!("listening on the tailnet at http://{a}/mcp"));
                let c = Arc::clone(&ctx);
                threads.push(std::thread::spawn(move || {
                    accept_loop(c, l, Listener::Tailnet)
                }));
            }
            Err(e) => log(&format!("could not listen on {a}: {e}")),
        }
    }
    ready(&bound);
    for t in threads {
        let _ = t.join();
    }
    Ok(())
}

/// For tests: serves one tailnet connection on a listener the test made.
#[cfg(test)]
pub fn serve_one_tailnet(ctx: &Ctx, l: &TcpListener) {
    if let Ok((s, peer)) = l.accept() {
        serve_conn(ctx, s, peer, Listener::Tailnet);
    }
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
