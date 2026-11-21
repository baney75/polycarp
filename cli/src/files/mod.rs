//! `polycarp files`: one place to search every file on every device the owner has, and to open, fetch and send
//! them. Devices talk over Tailscale only, on port 41771 of their Tailscale addresses, and each lets in only
//! nodes of the same Tailscale user. See docs/files.md.

pub mod config;
pub mod doctor;
pub mod fleet;
pub mod http;
pub mod index;
pub mod mcp;
pub mod open;
pub mod rules;
pub mod serve;
pub mod service;
pub mod tailnet;
pub mod watch;

use config::{Config, Os};
use index::{Hit, Index};
use serde_json::{json, Value as Json};
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tailnet::{Cli, Tailnet};

pub const USAGE: &str = "\
polycarp files: search, open and send your files across your devices, over Tailscale only

Usage:
  polycarp files index [--watch] [--root <dir>]...   build or update this device's index
  polycarp files search <words...> [--fleet] [--json] [--kind <kind>] [--limit N]
  polycarp files open <id|path|device:path> [--with default|word|editor|reveal]
  polycarp files get <device>:<path> [dest]          copy a file from another of your devices
  polycarp files send <path> <device>                send a file with Taildrop
  polycarp files inbox                               take files sent to this device (Taildrop)
  polycarp files serve [--watch]                     answer your other devices on port 41771
  polycarp files doctor [--json]                     what works, what doesn't, and the fix for each
  polycarp files fix                                 update a stale index, restart a stuck service
  polycarp files service install|uninstall|status    the per-user service that runs serve --watch
  polycarp files mcp                                 the files tools for an agent over MCP (stdio)

Kinds: md, txt, code, csv, json, doc, pdf, sheet, slides, image, audio, video, archive, other.
Settings: files.toml in the polycarp config folder (roots, extra_roots, skip, allow_save, allow_devices).
";

/// A refusal, the same shape everywhere: the command line's --json, the server and MCP.
#[derive(Debug)]
pub struct Fail {
    pub code: &'static str,
    pub message: String,
    pub suggestion: String,
    pub exit: i32,
}

impl Fail {
    pub fn new(
        code: &'static str,
        message: impl Into<String>,
        suggestion: impl Into<String>,
    ) -> Fail {
        Fail {
            code,
            message: message.into(),
            suggestion: suggestion.into(),
            exit: 1,
        }
    }
    pub fn usage(message: impl Into<String>) -> Fail {
        Fail {
            exit: 2,
            ..Fail::new("invalid_args", message, "Run `polycarp files --help`.")
        }
    }
    pub fn json(&self) -> Json {
        fail_json(self.code, &self.message, &self.suggestion)
    }
}

pub fn ok_json(data: Json) -> Json {
    json!({"ok": true, "data": data})
}

pub fn fail_json(code: &str, message: &str, suggestion: &str) -> Json {
    json!({"ok": false, "error": {"code": code, "message": message, "retry": "never", "suggestion": suggestion}})
}

type Res = Result<Json, Fail>;

fn cfg() -> Result<Config, Fail> {
    Config::load().map_err(|e| {
        Fail::new(
            "config_error",
            e,
            "Fix files.toml; `polycarp files --help` lists its keys.",
        )
    })
}

fn tailscale() -> Result<Cli, Fail> {
    Cli::find().map_err(|e| {
        Fail::new(
            "no_tailscale",
            e,
            "Install Tailscale from https://tailscale.com/download and sign in.",
        )
    })
}

fn status(cli: &Cli) -> Result<tailnet::Status, Fail> {
    let s = cli.status().map_err(|e| {
        Fail::new(
            "tailscale_down",
            e,
            "Open Tailscale and sign in, then try again.",
        )
    })?;
    if !s.running() {
        return Err(Fail::new(
            "tailscale_down",
            format!(
                "Tailscale is {}",
                if s.backend.is_empty() {
                    "not running"
                } else {
                    &s.backend
                }
            ),
            "Open Tailscale and sign in, then try again.",
        ));
    }
    Ok(s)
}

// ---------------------------------------------------------------------------------------------
// Operations: the command line and `polycarp files mcp` call the same ones.
// ---------------------------------------------------------------------------------------------

pub fn op_search(q: &str, kind: Option<&str>, limit: usize, fleet_wide: bool) -> Res {
    if let Some(k) = kind {
        if !rules::KINDS.contains(&k) {
            return Err(Fail::usage(format!(
                "unknown kind {k:?} (one of {})",
                rules::KINDS.join(", ")
            )));
        }
    }
    if index::fts_query(q).is_none() {
        return Err(Fail::usage("give at least one word to search for"));
    }
    let limit = limit.clamp(1, 200);
    let c = cfg()?;
    let db = c
        .index_path()
        .map_err(|e| Fail::new("config_error", e, ""))?;
    let local = Index::open_read(&db)
        .and_then(|i| i.search(q, kind, limit))
        .map_err(|e| Fail::new("no_index", e, "Run `polycarp files index`."));
    if !fleet_wide {
        let hits = local?;
        return Ok(
            json!({"results": hits, "devices": [{"device": "this device", "ok": true, "count": hits.len()}]}),
        );
    }
    let mut devices = Vec::new();
    let mut lists = Vec::new();
    let me_name = match tailscale().and_then(|cli| status(&cli)) {
        Ok(s) => {
            let me = s.me.as_ref().map(|m| m.name.clone()).unwrap_or_default();
            let targets = fleet::targets(&s, &c.allow_devices, c.port());
            let (q2, k2) = (q.to_string(), kind.map(str::to_string));
            let answers = fleet::fan_out(
                &targets,
                Duration::from_secs(3),
                Arc::new(move |t: &fleet::Target| {
                    fleet::remote_search(t, &q2, k2.as_deref(), limit, Duration::from_millis(2500))
                }),
            );
            for (t, r) in answers {
                match r {
                    Ok(h) => {
                        devices.push(json!({"device": t.name, "ok": true, "count": h.len()}));
                        lists.push(h);
                    }
                    Err(e) => devices.push(json!({"device": t.name, "ok": false, "error": e})),
                }
            }
            me
        }
        Err(f) => {
            devices.push(json!({"device": "tailnet", "ok": false, "error": f.message}));
            String::new()
        }
    };
    let me_label = if me_name.is_empty() {
        "this device".to_string()
    } else {
        me_name
    };
    match local {
        Ok(mut h) => {
            for x in &mut h {
                x.device = Some(me_label.clone());
            }
            devices.insert(0, json!({"device": me_label, "ok": true, "count": h.len()}));
            lists.insert(0, h);
        }
        Err(f) => devices.insert(
            0,
            json!({"device": me_label, "ok": false, "error": f.message}),
        ),
    }
    Ok(json!({"results": fleet::merge(lists, limit), "devices": devices}))
}

/// `device:path`, split at the first colon (Windows paths keep their drive letter).
pub fn split_source(s: &str) -> Option<(&str, &str)> {
    let (d, p) = s.split_once(':')?;
    let plain = d.len() > 1 && !d.contains(['/', '\\']) && !p.is_empty();
    plain.then_some((d, p))
}

fn file_name_of(remote: &str) -> String {
    remote
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or("file")
        .to_string()
}

/// A place `get` may write: no hidden folder or file anywhere in it, and nothing the index would never read.
fn safe_dest(d: &Path) -> Result<(), Fail> {
    let abs = std::env::current_dir()
        .map(|cwd| cwd.join(d))
        .unwrap_or_else(|_| d.to_path_buf());
    let hidden = abs.components().any(
        |c| matches!(c, std::path::Component::Normal(s) if s.to_string_lossy().starts_with('.')),
    );
    if hidden || rules::never(&abs) {
        return Err(Fail::new(
            "unsafe_dest",
            format!(
                "{} is a hidden or private place, so nothing is saved there",
                d.display()
            ),
            "Leave dest out to save into the inbox, or pick a plain folder.",
        ));
    }
    Ok(())
}

pub fn op_get(source: &str, dest: Option<&Path>) -> Res {
    let Some((device, remote)) = split_source(source) else {
        return Err(Fail::usage(
            "name the file as <device>:<path>, for example parish1:/home/d/notes.md",
        ));
    };
    if let Some(d) = dest {
        safe_dest(d)?;
    }
    let c = cfg()?;
    let cli = tailscale()?;
    let s = status(&cli)?;
    let me =
        s.me.clone()
            .ok_or_else(|| Fail::new("tailscale_down", "no node", ""))?;
    let name = file_name_of(remote);
    if !serve::safe_name(&name) {
        return Err(Fail::new(
            "not_shared",
            format!("{name} is not a file that is shared"),
            "",
        ));
    }
    let (dir, file) = match dest {
        Some(d) if d.is_dir() => (d.to_path_buf(), None),
        Some(d) => (
            d.parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(".")),
            Some(d.to_path_buf()),
        ),
        None => (
            c.inbox().map_err(|e| Fail::new("config_error", e, ""))?,
            None,
        ),
    };
    fs::create_dir_all(&dir).map_err(|e| {
        Fail::new(
            "io_error",
            format!("could not create {}: {e}", dir.display()),
            "",
        )
    })?;
    let out = match file {
        Some(f) if f.exists() => {
            return Err(Fail::new(
                "exists",
                format!("{} is already there", f.display()),
                "Pick another name, or leave dest out.",
            ))
        }
        Some(f) => f,
        None => serve::unique_path(&dir, &name),
    };
    if me.is_named(device) {
        let src = serve::shareable(&c.roots(), &c.skip, remote)
            .map_err(|(_, code, m)| Fail::new(code, m, ""))?;
        let n = fs::copy(&src, &out).map_err(|e| Fail::new("io_error", e.to_string(), ""))?;
        return Ok(json!({"device": me.name, "path": out.display().to_string(), "size": n}));
    }
    let peer = fleet::find_peer(&s, device).map_err(|e| {
        Fail::new(
            "no_device",
            e,
            "Run `polycarp files doctor` to see your devices.",
        )
    })?;
    let t = fleet::target_of(peer, c.port())
        .ok_or_else(|| Fail::new("no_device", "that device has no address", ""))?;
    let tmp = dir.join(format!(".{name}.{}.part", std::process::id()));
    let mut f = fs::File::create(&tmp).map_err(|e| Fail::new("io_error", e.to_string(), ""))?;
    let target = format!("/v1/file?{}", http::query_string(&[("path", remote)]));
    let r = http::download(t.addr, &target, Duration::from_secs(60), &mut f);
    let _ = f.flush();
    drop(f);
    let fail = |code: &'static str, m: String| {
        let _ = fs::remove_file(&tmp);
        Fail::new(
            code,
            m,
            "Run `polycarp files doctor` to check the connection.",
        )
    };
    let r = r.map_err(|e| fail("unreachable", format!("{}: {e}", t.name)))?;
    if r.status != 200 {
        let v: Json = serde_json::from_slice(&r.body).unwrap_or(Json::Null);
        let m = v["error"]["message"]
            .as_str()
            .unwrap_or("refused")
            .to_string();
        return Err(fail("refused", format!("{}: {m}", t.name)));
    }
    let size = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    fs::rename(&tmp, &out).map_err(|e| fail("io_error", e.to_string()))?;
    Ok(json!({"device": t.name, "path": out.display().to_string(), "size": size}))
}

pub fn op_send(path: &Path, device: &str) -> Res {
    if !path.is_file() {
        return Err(Fail::usage(format!("{} is not a file", path.display())));
    }
    let abs = fs::canonicalize(path).map_err(|e| Fail::new("io_error", e.to_string(), ""))?;
    if rules::never(&abs) {
        return Err(Fail::new(
            "secret",
            format!(
                "{} looks like a secret or private data, so it is not sent",
                abs.display()
            ),
            "Send it by hand if you mean to.",
        ));
    }
    // The same gate as serve: only a file another device could fetch is sent.
    let c = cfg()?;
    let abs =
        serve::shareable(&c.roots(), &c.skip, &abs.to_string_lossy()).map_err(|(_, code, m)| {
            Fail::new(
                code,
                format!("{}: {m}, so it is not sent", path.display()),
                "Only files in your indexed folders are sent. Send it by hand if you mean to.",
            )
        })?;
    let cli = tailscale()?;
    let s = status(&cli)?;
    let peer = fleet::find_peer(&s, device).map_err(|e| {
        Fail::new(
            "no_device",
            e,
            "Run `polycarp files doctor` to see your devices.",
        )
    })?;
    let ip = peer.ips.iter().find(|i| i.is_ipv4()).or(peer.ips.first());
    let target = ip
        .map(|i| i.to_string())
        .unwrap_or_else(|| peer.name.clone());
    cli.file_cp(&abs, &target).map_err(|e| {
        Fail::new(
            "taildrop_failed",
            e,
            "Check that Taildrop is on for both devices in the Tailscale admin console.",
        )
    })?;
    Ok(json!({"device": peer.name, "path": abs.display().to_string(), "via": "taildrop"}))
}

pub fn op_doctor() -> doctor::Facts {
    let c = cfg().unwrap_or_default();
    let tn = Cli::find().ok().map(|cli| {
        let p = cli.bin.display().to_string();
        (p, Arc::new(cli) as Arc<dyn Tailnet>)
    });
    doctor::gather(&c, tn)
}

pub fn doctor_json(f: &doctor::Facts) -> Json {
    let mut v = serde_json::to_value(f).unwrap_or(Json::Null);
    if let Some(o) = v.as_object_mut() {
        o.insert("healthy".into(), json!(f.healthy()));
        o.insert("fixes".into(), json!(doctor::fixes(f)));
    }
    v
}

// ---------------------------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------------------------

struct Flags {
    words: Vec<String>,
    json: bool,
    fleet: bool,
    watch: bool,
    kind: Option<String>,
    limit: usize,
    with: Option<String>,
    roots: Vec<String>,
}

fn parse(args: &[OsString]) -> Result<Flags, Fail> {
    let mut f = Flags {
        words: Vec::new(),
        json: false,
        fleet: false,
        watch: false,
        kind: None,
        limit: 20,
        with: None,
        roots: Vec::new(),
    };
    let mut it = args.iter().map(|a| a.to_string_lossy().into_owned());
    while let Some(a) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .ok_or_else(|| Fail::usage(format!("{name} needs a value")))
        };
        match a.as_str() {
            "--json" => f.json = true,
            "--fleet" => f.fleet = true,
            "--watch" => f.watch = true,
            "--kind" => f.kind = Some(value("--kind")?),
            "--limit" => {
                f.limit = value("--limit")?
                    .parse()
                    .map_err(|_| Fail::usage("--limit takes a number"))?
            }
            "--with" => f.with = Some(value("--with")?),
            "--root" => f.roots.push(value("--root")?),
            "--" => f.words.extend(it.by_ref()),
            s if s.starts_with("--") => return Err(Fail::usage(format!("unknown option {s}"))),
            _ => f.words.push(a),
        }
    }
    Ok(f)
}

fn human_size(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < units.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", units[u])
    }
}

/// YYYY-MM-DD in UTC from seconds since 1970.
pub fn date(secs: i64) -> String {
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

fn print_hits(hits: &[Hit], fleet_wide: bool) {
    let mut out = std::io::stdout().lock();
    for h in hits {
        let place = match (&h.device, fleet_wide) {
            (Some(d), true) => format!("{d}:{}", h.path),
            _ => h.path.clone(),
        };
        let id = if fleet_wide {
            String::new()
        } else {
            format!("{:>6}  ", h.id)
        };
        if writeln!(
            out,
            "{id}{:<6} {:>9}  {}  {place}",
            h.kind,
            human_size(h.size),
            date(h.modified)
        )
        .is_err()
        {
            return;
        }
        let bare = h.snippet.replace(['[', ']'], "");
        if !h.snippet.is_empty() && bare != h.name {
            let s: String = h.snippet.chars().take(160).collect();
            let pad = if fleet_wide { "" } else { "        " };
            let _ = writeln!(out, "{pad}    {s}");
        }
    }
}

fn report(r: Res, json_out: bool, human: impl FnOnce(&Json)) -> i32 {
    match r {
        Ok(data) => {
            if json_out {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&ok_json(data)).unwrap_or_default()
                );
            } else {
                human(&data);
            }
            0
        }
        Err(f) => {
            if json_out {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&f.json()).unwrap_or_default()
                );
            } else {
                eprintln!("polycarp files: {}", f.message);
                if !f.suggestion.is_empty() {
                    eprintln!("{}", f.suggestion);
                }
            }
            f.exit
        }
    }
}

pub fn run(args: &[OsString]) -> i32 {
    let Some(cmd) = args.first().map(|a| a.to_string_lossy().into_owned()) else {
        eprint!("{USAGE}");
        return 2;
    };
    if matches!(cmd.as_str(), "--help" | "-h" | "help") {
        print!("{USAGE}");
        return 0;
    }
    if cmd == "mcp" {
        return mcp::run(&args[1..]);
    }
    if cmd == "service" {
        return service_cmd(&args[1..]);
    }
    let f = match parse(&args[1..]) {
        Ok(f) => f,
        Err(e) => return report(Err(e), false, |_| {}),
    };
    match cmd.as_str() {
        "index" => cmd_index(&f),
        "search" => {
            let q = f.words.join(" ");
            let fleet_wide = f.fleet;
            report(
                op_search(&q, f.kind.as_deref(), f.limit, f.fleet),
                f.json,
                |d| {
                    let hits: Vec<Hit> =
                        serde_json::from_value(d["results"].clone()).unwrap_or_default();
                    print_hits(&hits, fleet_wide);
                    for dev in d["devices"].as_array().into_iter().flatten() {
                        if dev["ok"] == json!(false) {
                            eprintln!(
                                "polycarp files: {}: {}",
                                dev["device"].as_str().unwrap_or("?"),
                                dev["error"].as_str().unwrap_or("")
                            );
                        }
                    }
                    if hits.is_empty() {
                        eprintln!("polycarp files: nothing found");
                    }
                },
            )
        }
        "open" => cmd_open(&f),
        "get" => {
            let (src, dest) = match f.words.as_slice() {
                [s] => (s.clone(), None),
                [s, d] => (s.clone(), Some(PathBuf::from(d))),
                _ => {
                    return report(
                        Err(Fail::usage("get takes <device>:<path> [dest]")),
                        false,
                        |_| {},
                    )
                }
            };
            report(op_get(&src, dest.as_deref()), f.json, |d| {
                println!("{}", d["path"].as_str().unwrap_or_default())
            })
        }
        "send" => {
            let [p, dev] = f.words.as_slice() else {
                return report(
                    Err(Fail::usage("send takes <path> <device>")),
                    false,
                    |_| {},
                );
            };
            report(op_send(Path::new(p), dev), f.json, |d| {
                println!(
                    "Sent {} to {} with Taildrop.",
                    d["path"].as_str().unwrap_or_default(),
                    d["device"].as_str().unwrap_or_default()
                )
            })
        }
        "inbox" => report(op_inbox(), f.json, |d| {
            let got = d["received"].as_array().cloned().unwrap_or_default();
            if got.is_empty() {
                println!(
                    "Nothing waiting. Files land in {}.",
                    d["inbox"].as_str().unwrap_or_default()
                );
            }
            for g in got {
                println!("{}", g.as_str().unwrap_or_default());
            }
        }),
        "serve" => cmd_serve(f.watch),
        "doctor" => {
            let facts = op_doctor();
            if f.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&ok_json(doctor_json(&facts))).unwrap_or_default()
                );
            } else {
                print_doctor(&facts);
            }
            if facts.healthy() {
                0
            } else {
                1
            }
        }
        "fix" => cmd_fix(),
        other => {
            eprintln!("polycarp files: unknown command {other}\n");
            eprint!("{USAGE}");
            2
        }
    }
}

fn cmd_index(f: &Flags) -> i32 {
    let c = match cfg() {
        Ok(c) => c,
        Err(e) => return report(Err(e), f.json, |_| {}),
    };
    let roots = if f.roots.is_empty() {
        c.roots()
    } else {
        let home = config::home();
        f.roots
            .iter()
            .map(|r| {
                let p = config::expand(r, home.as_deref());
                let p = if p.is_absolute() {
                    p
                } else {
                    std::env::current_dir().map(|d| d.join(&p)).unwrap_or(p)
                };
                config::Root {
                    path: if cfg!(windows) {
                        p
                    } else {
                        fs::canonicalize(&p).unwrap_or(p)
                    },
                    text: true,
                }
            })
            .collect()
    };
    let db = match c.index_path() {
        Ok(p) => p,
        Err(e) => return report(Err(Fail::new("config_error", e, "")), f.json, |_| {}),
    };
    if f.watch {
        let every = Duration::from_secs((c.stale_secs() / 2).max(600));
        return match watch::watch(&db, &roots, &c.skip, every) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("polycarp files: {e}");
                1
            }
        };
    }
    let started = std::time::Instant::now();
    let r = Index::open(&db)
        .and_then(|mut i| i.update(&roots, &c.skip))
        .map(|s| json!({"index": db.display().to_string(), "seconds": started.elapsed().as_secs_f64(), "stats": s}))
        .map_err(|e| Fail::new("io_error", e, ""));
    report(r, f.json, |d| {
        let s = &d["stats"];
        println!(
            "Indexed {} files under {} folders in {:.1}s: {} new, {} changed, {} removed, {} read for text.",
            s["files"], s["roots"], d["seconds"].as_f64().unwrap_or(0.0), s["added"], s["updated"], s["removed"], s["with_text"]
        );
        for u in s["unreadable"].as_array().into_iter().flatten() {
            println!(
                "  could not read, kept as it was: {}",
                u.as_str().unwrap_or_default()
            );
        }
        for m in s["missing_roots"].as_array().into_iter().flatten() {
            println!(
                "  not there, kept as it was: {}",
                m.as_str().unwrap_or_default()
            );
        }
        println!("Index: {}", d["index"].as_str().unwrap_or_default());
    })
}

fn cmd_open(f: &Flags) -> i32 {
    let with = match f.with.as_deref().map(open::With::parse) {
        None => open::With::Default,
        Some(Some(w)) => w,
        Some(None) => {
            return report(
                Err(Fail::usage("--with takes default, word, editor or reveal")),
                false,
                |_| {},
            )
        }
    };
    let [target] = f.words.as_slice() else {
        return report(
            Err(Fail::usage("open takes one id, path or device:path")),
            false,
            |_| {},
        );
    };
    let path = match resolve_open(target) {
        Ok(p) => p,
        Err(e) => return report(Err(e), f.json, |_| {}),
    };
    report(
        open::open(&path, with)
            .map(|()| json!({"path": path.display().to_string()}))
            .map_err(|e| Fail::new("open_failed", e, "")),
        f.json,
        |_| {},
    )
}

/// An id from this device's index, a local path, or `device:path` (fetched into the inbox first).
fn resolve_open(target: &str) -> Result<PathBuf, Fail> {
    if let Ok(id) = target.parse::<i64>() {
        let c = cfg()?;
        let db = c
            .index_path()
            .map_err(|e| Fail::new("config_error", e, ""))?;
        let hit = Index::open_read(&db)
            .and_then(|i| i.lookup(Some(id), None))
            .map_err(|e| Fail::new("no_index", e, "Run `polycarp files index`."))?
            .ok_or_else(|| {
                Fail::new(
                    "not_found",
                    format!("no file with id {id} in this device's index"),
                    "Search again; ids are per device.",
                )
            })?;
        return Ok(PathBuf::from(hit.path));
    }
    let local = PathBuf::from(target);
    if local.exists() {
        return Ok(local);
    }
    if split_source(target).is_some() {
        let got = op_get(target, None)?;
        return Ok(PathBuf::from(got["path"].as_str().unwrap_or_default()));
    }
    Err(Fail::new(
        "not_found",
        format!("{target} does not exist"),
        "",
    ))
}

fn op_inbox() -> Res {
    let c = cfg()?;
    let dir = c.inbox().map_err(|e| Fail::new("config_error", e, ""))?;
    fs::create_dir_all(&dir).map_err(|e| Fail::new("io_error", e.to_string(), ""))?;
    let list = |d: &Path| -> std::collections::BTreeSet<String> {
        fs::read_dir(d)
            .map(|rd| {
                rd.filter_map(Result::ok)
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    };
    let before = list(&dir);
    let cli = tailscale()?;
    status(&cli)?;
    cli.file_get(&dir)
        .map_err(|e| Fail::new("taildrop_failed", e, ""))?;
    let received: Vec<String> = list(&dir)
        .difference(&before)
        .map(|n| dir.join(n).display().to_string())
        .collect();
    Ok(json!({"inbox": dir.display().to_string(), "received": received}))
}

fn cmd_serve(with_watch: bool) -> i32 {
    let run = || -> Result<(), Fail> {
        let c = cfg()?;
        let cli = tailscale()?;
        let s = status(&cli)?;
        let me =
            s.me.clone()
                .ok_or_else(|| Fail::new("tailscale_down", "no node", ""))?;
        serve::may_serve(&me).map_err(|e| Fail::new("tagged", e, ""))?;
        let addrs =
            serve::bind_addrs(&me.ips, c.port()).map_err(|e| Fail::new("tailscale_down", e, ""))?;
        let db = c
            .index_path()
            .map_err(|e| Fail::new("config_error", e, ""))?;
        let inbox = c.inbox().map_err(|e| Fail::new("config_error", e, ""))?;
        let roots = c.roots();
        if with_watch {
            let (db2, roots2, skip) = (db.clone(), roots.clone(), c.skip.clone());
            let every = Duration::from_secs((c.stale_secs() / 2).max(600));
            std::thread::spawn(move || {
                if let Err(e) = watch::watch(&db2, &roots2, &skip, every) {
                    eprintln!("polycarp files index: {e}");
                }
            });
        }
        let ctx = serve::Ctx::new(c, roots, db, inbox, Arc::new(cli), me);
        serve::serve(Arc::new(ctx), &addrs)
            .map_err(|e| Fail::new("io_error", e, "Is another `polycarp files serve` running?"))
    };
    match run() {
        Ok(()) => 0,
        Err(f) => report(Err(f), false, |_| {}),
    }
}

fn print_doctor(f: &doctor::Facts) {
    let yes = |b: bool| if b { "yes" } else { "no" };
    println!(
        "tailscale: {}",
        f.tailscale.as_deref().unwrap_or("not found")
    );
    println!(
        "  state: {}, signed in: {}",
        if f.backend.is_empty() {
            "unknown"
        } else {
            &f.backend
        },
        yes(f.logged_in)
    );
    if let Some(d) = &f.device {
        println!("  this device: {d} ({})", f.ips.join(", "));
    }
    println!(
        "serve: port {}, answering: {}, saving allowed: {}",
        f.port,
        yes(f.serve_running),
        yes(f.allow_save)
    );
    match &f.service_unit {
        Some(u) => println!(
            "  service: {u} (loaded: {})",
            f.service_loaded.map(yes).unwrap_or("unknown")
        ),
        None => println!("  service: not installed"),
    }
    match f.index_files {
        Some(n) => println!(
            "index: {n} files, {}, updated {} ago{}",
            human_size(f.index_bytes.unwrap_or(0)),
            f.index_age_secs.map(age).unwrap_or_else(|| "never".into()),
            if f.index_stale { " (stale)" } else { "" }
        ),
        None => println!("index: none yet"),
    }
    println!("  at {}", f.index_path);
    for p in &f.peers {
        let state = match (p.online, p.reachable) {
            (false, _) => "offline".to_string(),
            (true, Some(true)) => format!(
                "answering, polycarp {}",
                p.version.as_deref().unwrap_or("?")
            ),
            (true, Some(false)) => format!("not answering ({})", p.error.as_deref().unwrap_or("")),
            (true, None) => "not asked".into(),
        };
        println!("peer {}: {state}", p.name);
    }
    let fixes = doctor::fixes(f);
    println!(
        "{}",
        if fixes.is_empty() {
            "All good."
        } else {
            "To fix:"
        }
    );
    for line in fixes {
        println!("  {line}");
    }
}

fn age(secs: i64) -> String {
    match secs {
        s if s < 120 => format!("{s}s"),
        s if s < 7200 => format!("{}m", s / 60),
        s if s < 172_800 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86_400),
    }
}

fn cmd_fix() -> i32 {
    let facts = op_doctor();
    let plan = doctor::fix_plan(&facts);
    let mut ok = true;
    for step in &plan {
        match step {
            doctor::Action::Reindex => {
                let c = cfg().unwrap_or_default();
                let r = c
                    .index_path()
                    .and_then(|db| Index::open(&db))
                    .and_then(|mut i| i.update(&c.roots(), &c.skip));
                match r {
                    Ok(s) => println!(
                        "Updated the index: {} files ({} new, {} changed, {} removed).",
                        s.files, s.added, s.updated, s.removed
                    ),
                    Err(e) => {
                        ok = false;
                        println!("Could not update the index: {e}");
                    }
                }
            }
            doctor::Action::RestartService => {
                match service::restart_argv(Os::current(), service::uid()) {
                    Some((prog, args)) => {
                        let a: Vec<&str> = args.iter().map(String::as_str).collect();
                        match tailnet::run_for(&prog, &a, Duration::from_secs(20)) {
                            Ok(_) => println!("Restarted the files service."),
                            Err(e) => {
                                ok = false;
                                println!("Could not restart the files service: {e}");
                            }
                        }
                    }
                    None => println!("Could not tell how to restart the service here."),
                }
            }
        }
    }
    let after = if plan.is_empty() { facts } else { op_doctor() };
    let left = doctor::fixes(&after);
    if plan.is_empty() && left.is_empty() {
        println!("Nothing to fix.");
    }
    for l in &left {
        println!("Still to do: {l}");
    }
    if ok && after.healthy() {
        0
    } else {
        1
    }
}

fn service_cmd(args: &[OsString]) -> i32 {
    let sub = args
        .first()
        .map(|a| a.to_string_lossy().into_owned())
        .unwrap_or_default();
    let os = Os::current();
    let Some(home) = config::home() else {
        eprintln!("polycarp files: the home folder is not set");
        return 1;
    };
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let unit = service::unit_path(os, &home, local.as_deref());
    match sub.as_str() {
        "install" => {
            let Some(exe) = service::service_exe() else {
                eprintln!("polycarp files: could not tell where this polycarp command is");
                return 1;
            };
            let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
                (Ok(d), Ok(u)) => format!("{d}\\{u}"),
                (_, Ok(u)) => u,
                _ => String::new(),
            };
            let text = service::render(os, &exe, &service::log_path(&home), &user);
            if let Err(e) = service::write_unit(os, &unit, &text) {
                eprintln!("polycarp files: {e}");
                return 1;
            }
            println!(
                "Wrote {} (runs {} files serve --watch).",
                unit.display(),
                exe.display()
            );
            println!(
                "Nothing was started. Start it with:\n  {}",
                service::start_cmd(os, &unit)
            );
            0
        }
        "uninstall" => {
            if !unit.exists() {
                println!("Not installed ({} is not there).", unit.display());
                return 0;
            }
            if let Err(e) = fs::remove_file(&unit) {
                eprintln!("polycarp files: could not remove {}: {e}", unit.display());
                return 1;
            }
            println!("Removed {}.", unit.display());
            println!(
                "If it is running, stop it with:\n  {}",
                service::stop_cmd(os, &unit)
            );
            0
        }
        "status" => {
            if !unit.exists() {
                println!(
                    "Not installed. `polycarp files service install` writes {}.",
                    unit.display()
                );
                return 1;
            }
            let loaded = service::query_argv(os, service::uid()).map(|(prog, a)| {
                let a: Vec<&str> = a.iter().map(String::as_str).collect();
                tailnet::run_for(&prog, &a, Duration::from_secs(5)).is_ok()
            });
            println!("Installed: {}", unit.display());
            match loaded {
                Some(true) => {
                    println!("Loaded and running.");
                    0
                }
                _ => {
                    println!(
                        "Not running. Start it with:\n  {}",
                        service::start_cmd(os, &unit)
                    );
                    1
                }
            }
        }
        _ => {
            eprintln!("polycarp files: service takes install, uninstall or status");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_split_at_the_device() {
        assert_eq!(
            split_source("parish1:/home/d/a.md"),
            Some(("parish1", "/home/d/a.md"))
        );
        assert_eq!(
            split_source("abbey1:C:\\Users\\d\\a.docx"),
            Some(("abbey1", "C:\\Users\\d\\a.docx"))
        );
        assert_eq!(split_source("C:\\Users\\d\\a.docx"), None);
        assert_eq!(split_source("/tmp/a:b"), None);
        assert_eq!(file_name_of("C:\\Users\\d\\a.docx"), "a.docx");
    }

    #[test]
    fn dates_are_civil_utc() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(1_763_683_200), "2025-11-21");
    }
}
