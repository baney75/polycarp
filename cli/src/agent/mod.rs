//! `polycarp agent`: one MCP gateway for every assistant (Grok Bot, Claude Code, Codex, claude.ai, ChatGPT, grok.com),
//! locally, over the tailnet, or through a tunnel. docs/agents.md has the routes and the threat model.
//!
//! - `store`: the private folder, hashing, the lock.
//! - `policy`: the routes every install has.
//! - `auth`: OAuth 2.1 for web connectors, bearer tokens for local clients, owner approval.
//! - `gateway`: the tool catalog, scopes and the extension points for surfaces and contacts.
//! - `app`: pass-through to the running app.
//! - `server`: Streamable HTTP on loopback, and the tailnet listener.
//! - `tunnel`, `service`, `doctor`, `connect`: the commands around it.

pub mod app;
pub mod auth;
pub mod connect;
pub mod doctor;
pub mod gateway;
pub mod policy;
pub mod server;
pub mod service;
pub mod store;
pub mod tunnel;

use crate::files::config::Os;
use serde_json::json;
use std::ffi::OsString;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const USAGE: &str = "\
polycarp agent: one MCP gateway for Grok Bot, Claude Code, Codex and web assistants

Usage:
  polycarp agent serve [--stdio] [--tailnet] [--port <n>] [--bind <loopback address>]
  polycarp agent connect <claude-code|codex|grokbot|claude.ai|chatgpt|grok.com> [--run] [--write] [--tailnet]
  polycarp agent approve [<code>] [--scopes read,files,act,contacts] [--unverified]
  polycarp agent deny <code>
  polycarp agent clients [--json]
  polycarp agent revoke <id>
  polycarp agent token create --name <name> --scopes <scopes> [--remote]
  polycarp agent tunnel cloudflare --hostname <name> [--name <tunnel>] [--dry-run]
  polycarp agent tunnel tailscale [--public] [--dry-run]
  polycarp agent tunnel status [--json] | off [--dry-run] | run
  polycarp agent service install|uninstall|status [--tunnel] [--tailnet]
  polycarp agent doctor [--json]
  polycarp agent fix

serve listens on loopback only (127.0.0.1:41772). --stdio serves one local client over stdin and stdout instead.
--tailnet also listens on this device's Tailscale addresses, for your own devices only.
Scopes: read (look), files (search and move your files), act (change settings, themes and workspaces), contacts.
Every install has local MCP, the tailnet and its own tunnel (Cloudflare or Tailscale). There is no hosted tunnel.
";

fn usage(msg: &str) -> i32 {
    eprintln!("polycarp agent: {msg}\n");
    eprint!("{USAGE}");
    2
}

fn fail(msg: &str) -> i32 {
    eprintln!("polycarp agent: {msg}");
    1
}

/// Flags and plain words, from the arguments after the subcommand.
struct Args {
    words: Vec<String>,
    flags: Vec<(String, Option<String>)>,
}

const VALUED: [&str; 6] = [
    "--port",
    "--bind",
    "--scopes",
    "--name",
    "--hostname",
    "--tailnet-name",
];

fn parse(args: &[OsString]) -> Result<Args, String> {
    let mut out = Args {
        words: Vec::new(),
        flags: Vec::new(),
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let a = a.to_str().ok_or("arguments must be text")?;
        if let Some((k, v)) = a.split_once('=').filter(|(k, _)| k.starts_with("--")) {
            out.flags.push((k.to_string(), Some(v.to_string())));
        } else if VALUED.contains(&a) {
            let v = it
                .next()
                .and_then(|v| v.to_str())
                .ok_or_else(|| format!("{a} needs a value"))?;
            out.flags.push((a.to_string(), Some(v.to_string())));
        } else if a.starts_with("--") {
            out.flags.push((a.to_string(), None));
        } else {
            out.words.push(a.to_string());
        }
    }
    Ok(out)
}

impl Args {
    fn flag(&self, k: &str) -> bool {
        self.flags.iter().any(|(f, _)| f == k)
    }
    fn value(&self, k: &str) -> Option<&str> {
        self.flags
            .iter()
            .find(|(f, _)| f == k)
            .and_then(|(_, v)| v.as_deref())
    }
    /// Refuses flags this command doesn't take.
    fn only(&self, allowed: &[&str]) -> Result<(), String> {
        match self
            .flags
            .iter()
            .find(|(f, _)| !allowed.contains(&f.as_str()))
        {
            Some((f, _)) => Err(format!("unknown option {f}")),
            None => Ok(()),
        }
    }
}

fn dir() -> Result<PathBuf, String> {
    let d = store::agent_dir()?;
    store::ensure_dir(&d)?;
    Ok(d)
}

fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

pub fn run(args: &[OsString]) -> i32 {
    let Some(sub) = args.first().and_then(|a| a.to_str()) else {
        eprint!("{USAGE}");
        return 2;
    };
    if matches!(sub, "--help" | "-h" | "help") {
        print!("{USAGE}");
        return 0;
    }
    let a = match parse(&args[1..]) {
        Ok(a) => a,
        Err(e) => return usage(&e),
    };
    if a.flag("--help") || a.flag("-h") {
        print!("{USAGE}");
        return 0;
    }
    let result = match sub {
        "serve" => return serve(&a),
        "connect" => connect(&a),
        "approve" => approve(&a),
        "deny" => deny(&a),
        "clients" => clients(&a),
        "revoke" => revoke(&a),
        "token" => token(&a),
        "tunnel" => return tunnel_cmd(&a),
        "service" => service_cmd(&a),
        "doctor" => return doctor_cmd(&a),
        "fix" => fix_cmd(&a),
        other => return usage(&format!("unknown command {other}")),
    };
    match result {
        Ok(()) => 0,
        Err(Exit::Usage(m)) => usage(&m),
        Err(Exit::Fail(m)) => fail(&m),
    }
}

enum Exit {
    Usage(String),
    Fail(String),
}

impl From<String> for Exit {
    fn from(s: String) -> Exit {
        Exit::Fail(s)
    }
}

impl From<&str> for Exit {
    fn from(s: &str) -> Exit {
        Exit::Fail(s.to_string())
    }
}

fn need_only(a: &Args, allowed: &[&str]) -> Result<(), Exit> {
    a.only(allowed).map_err(Exit::Usage)
}

// ------------------------------------------------------------------------------------------------

fn serve(a: &Args) -> i32 {
    if let Err(e) = a.only(&["--stdio", "--tailnet", "--port", "--bind"]) {
        return usage(&e);
    }
    if !a.words.is_empty() {
        return usage("serve takes no words");
    }
    let link: Arc<dyn app::AppLink> = Arc::new(app::Local::new());
    let gw = gateway::Gateway::new(link);
    if a.flag("--stdio") {
        if a.flags.len() > 1 {
            return usage("--stdio takes no other option");
        }
        return gateway::serve_stdio(&gw);
    }
    let binds: Vec<IpAddr> = match a.value("--bind") {
        Some(b) => match b.trim_matches(|c| c == '[' || c == ']').parse::<IpAddr>() {
            Ok(ip) => match server::check_bind(ip) {
                Ok(()) => vec![ip],
                Err(e) => return usage(&e),
            },
            Err(_) => return usage("--bind takes an IP address, like 127.0.0.1"),
        },
        None => vec![
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ],
    };
    let dir = match dir() {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };
    let settings = match store::Settings::load(&dir) {
        Ok(s) => s,
        Err(e) => return fail(&e),
    };
    let port = match a.value("--port").map(str::parse::<u16>) {
        None => settings.port(),
        Some(Ok(p)) if p > 0 => p,
        Some(_) => return usage("--port takes a number from 1 to 65535"),
    };
    let want_tailnet = a.flag("--tailnet") || settings.tailnet;
    let routes: &[policy::Route] = if want_tailnet {
        &[policy::Route::Local, policy::Route::Tailnet]
    } else {
        &[policy::Route::Local]
    };
    let mut ctx = server::Ctx::new(dir.clone(), gw, settings);
    let mut tail_addrs = Vec::new();
    if want_tailnet {
        let cli = match crate::files::tailnet::Cli::find() {
            Ok(c) => c,
            Err(e) => return fail(&format!("--tailnet: {e}")),
        };
        use crate::files::tailnet::Tailnet;
        let me = match cli.status() {
            Ok(s) if s.running() => match s.me {
                Some(me) => me,
                None => return fail("--tailnet: Tailscale isn't running and signed in"),
            },
            Ok(_) => return fail("--tailnet: Tailscale isn't running and signed in"),
            Err(e) => return fail(&format!("--tailnet: {e}")),
        };
        if let Err(e) = crate::files::serve::may_serve(&me) {
            return fail(&format!("--tailnet: {e}"));
        }
        match crate::files::serve::bind_addrs(&me.ips, port) {
            Ok(v) => tail_addrs = v,
            Err(e) => return fail(&format!("--tailnet: {e}")),
        }
        ctx.tailnet = Some(server::TailCtx::new(Arc::new(cli), me));
    }
    let loopback: Vec<SocketAddr> = binds
        .into_iter()
        .map(|ip| SocketAddr::new(ip, port))
        .collect();
    eprintln!(
        "polycarp agent: routes {}; state in {}",
        routes
            .iter()
            .map(|r| r.name())
            .collect::<Vec<_>>()
            .join(", "),
        dir.display()
    );
    if let Some(t) = store::Tunnel::load(&dir).filter(|t| t.route().is_some()) {
        eprintln!("polycarp agent: tunnel {} at {}/mcp", t.kind, t.public_url);
    }
    // With ::1 unavailable (IPv6 off), 127.0.0.1 alone is enough.
    let ctx = Arc::new(ctx);
    let result = server::serve(Arc::clone(&ctx), &loopback, &tail_addrs, &|_| {});
    match result {
        Ok(()) => 0,
        Err(e) if loopback.len() > 1 => {
            let v4: Vec<SocketAddr> = loopback.iter().filter(|a| a.is_ipv4()).copied().collect();
            match server::serve(ctx, &v4, &tail_addrs, &|_| {}) {
                Ok(()) => 0,
                Err(_) => fail(&e),
            }
        }
        Err(e) => fail(&e),
    }
}

// ------------------------------------------------------------------------------------------------

fn approve(a: &Args) -> Result<(), Exit> {
    need_only(a, &["--scopes", "--unverified"])?;
    let dir = dir()?;
    let now = store::now();
    let Some(code) = a.words.first() else {
        if a.flag("--scopes") || a.flag("--unverified") {
            return Err(Exit::Usage(
                "--scopes and --unverified go with a code".into(),
            ));
        }
        // No codes in this list: approve only the code on the page in the browser you started the connection from.
        let waiting = server::change_state(&dir, |s| {
            let w = s.waiting(now);
            w.into_iter()
                .map(|p| {
                    let name = s
                        .clients
                        .get(&p.client)
                        .map(|c| c.name.clone())
                        .unwrap_or_default();
                    let unverified = s.unverified(&p);
                    (p, name, unverified)
                })
                .collect::<Vec<_>>()
        })?;
        if waiting.is_empty() {
            println!("No connection is waiting for approval.");
        } else {
            println!(
                "Waiting for approval. Approve one with the code its page shows, in the browser you started it from:"
            );
        }
        for (p, name, unverified) in waiting {
            println!(
                "  {}  \"{name}\" through {}, codes to {}{}, asks for {}, since {}, {} minutes left",
                p.client,
                p.origin.name(),
                auth::redirect_host(&p.redirect_uri),
                if unverified { " (unverified)" } else { "" },
                p.scopes.join(","),
                crate::files::date(p.created),
                ((p.expires - now) / 60).max(0)
            );
        }
        return Ok(());
    };
    if a.words.len() > 1 {
        return Err(Exit::Usage("approve takes one code".into()));
    }
    let scopes = match a.value("--scopes") {
        Some(s) => Some(auth::parse_scopes(s).map_err(Exit::Usage)?),
        None => None,
    };
    let unverified_ok = a.flag("--unverified");
    let (p, name) = server::change_state(&dir, |s| {
        s.approve(code, scopes, unverified_ok, now).map(|p| {
            let name = s
                .clients
                .get(&p.client)
                .map(|c| c.name.clone())
                .unwrap_or_default();
            (p, name)
        })
    })??;
    let granted = match &p.decision {
        Some(auth::Decision::Approved(s)) => s.join(","),
        _ => String::new(),
    };
    println!(
        "Approved \"{name}\" ({}), which came through {} and sends its code to {}, with {granted}. Its page goes on \
by itself. `polycarp agent clients` lists it; `polycarp agent revoke {}` ends it.",
        p.client,
        p.origin.name(),
        auth::redirect_host(&p.redirect_uri),
        p.client
    );
    if p.scopes.iter().any(|s| s == auth::BY_NAME)
        && !granted.split(',').any(|s| s == auth::BY_NAME)
    {
        println!(
            "It also asked for {0}, which is granted only by name, so it was left out. To add it, approve its next \
request with `--scopes {granted},{0}`.",
            auth::BY_NAME
        );
    }
    Ok(())
}

fn deny(a: &Args) -> Result<(), Exit> {
    need_only(a, &[])?;
    let [code] = a.words.as_slice() else {
        return Err(Exit::Usage("deny takes one code".into()));
    };
    let dir = dir()?;
    server::change_state(&dir, |s| s.deny(code, store::now()))??;
    println!("Said no. The assistant's page tells it so.");
    Ok(())
}

fn when(t: Option<i64>) -> String {
    t.map(crate::files::date).unwrap_or_else(|| "never".into())
}

fn clients(a: &Args) -> Result<(), Exit> {
    need_only(a, &["--json"])?;
    let dir = dir()?;
    let now = store::now();
    let st: auth::State = store::read_json(&dir.join(store::AUTH_FILE))?;
    let list = st.listing(now);
    if a.flag("--json") {
        println!(
            "{}",
            serde_json::to_string_pretty(&crate::files::ok_json(list)).unwrap_or_default()
        );
        return Ok(());
    }
    let rows: Vec<&serde_json::Value> = list["clients"]
        .as_array()
        .into_iter()
        .chain(list["tokens"].as_array())
        .flatten()
        .collect();
    if rows.is_empty() {
        println!("No clients yet. `polycarp agent connect <client>` says how to add one.");
    }
    for r in rows {
        let scopes: Vec<&str> = r["scopes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s.as_str())
            .collect();
        let mut extra = String::new();
        if r["kind"] == "token" && r["remote"] == json!(true) {
            extra.push_str(", also through tunnels");
        }
        if r["kind"] == "oauth" && r["approved"].is_null() {
            extra.push_str(", never approved");
        }
        println!(
            "{}  {} ({}): {}{extra}; last used {}",
            r["id"].as_str().unwrap_or_default(),
            r["name"].as_str().unwrap_or_default(),
            r["kind"].as_str().unwrap_or_default(),
            if scopes.is_empty() {
                "no scopes".to_string()
            } else {
                scopes.join(",")
            },
            when(r["last_used"].as_i64())
        );
    }
    Ok(())
}

fn revoke(a: &Args) -> Result<(), Exit> {
    need_only(a, &[])?;
    let [id] = a.words.as_slice() else {
        return Err(Exit::Usage(
            "revoke takes one id from `polycarp agent clients`".into(),
        ));
    };
    let dir = dir()?;
    let kind = server::change_state(&dir, |s| s.revoke(id, store::now()))??;
    println!(
        "Revoked {kind} {id}. Its tokens stop working now, on the next request{}.",
        if kind == "client" {
            "; to use it again, connect it again"
        } else {
            ""
        }
    );
    Ok(())
}

fn token(a: &Args) -> Result<(), Exit> {
    match a.words.first().map(String::as_str) {
        Some("create") if a.words.len() == 1 => {}
        Some("list") if a.words.len() == 1 => return clients(a),
        _ => {
            return Err(Exit::Usage(
                "token create --name <name> --scopes <scopes> [--remote]".into(),
            ))
        }
    }
    need_only(a, &["--name", "--scopes", "--remote"])?;
    let name = a
        .value("--name")
        .ok_or_else(|| Exit::Usage("token create needs --name".into()))?;
    let scopes = auth::parse_scopes(
        a.value("--scopes")
            .ok_or_else(|| Exit::Usage("token create needs --scopes".into()))?,
    )
    .map_err(Exit::Usage)?;
    let remote = a.flag("--remote");
    let dir = dir()?;
    let (id, tok) = server::change_state(&dir, |s| {
        s.create_bearer(name, scopes.clone(), remote, store::now())
    })??;
    eprintln!(
        "Made {id} for {name} with {}{}. This is the only time the token is shown; only its hash is kept. Give it to \
the client as `Authorization: Bearer <token>`. `polycarp agent revoke {id}` ends it.",
        scopes.join(","),
        if remote { ", also through tunnels" } else { ", on this Mac and the tailnet only" }
    );
    println!("{tok}");
    Ok(())
}

// ------------------------------------------------------------------------------------------------

fn tunnel_env<'a>(dir: &'a Path, runner: &'a dyn tunnel::Runner, dry_run: bool) -> tunnel::Env<'a> {
    let port = store::Settings::load(dir)
        .map(|s| s.port())
        .unwrap_or(store::PORT);
    tunnel::Env {
        dir,
        port,
        home: crate::home(),
        cloudflared: tunnel::find_cloudflared(),
        tailscale: crate::files::tailnet::find_tailscale(),
        runner,
        dry_run,
    }
}

fn print_done(d: &tunnel::Done, dry_run: bool) {
    if dry_run {
        println!("Would run:");
        for c in &d.ran {
            println!("  {}", c.join(" "));
        }
    }
    for l in &d.lines {
        println!("{l}");
    }
}

fn tunnel_cmd(a: &Args) -> i32 {
    let dir = match dir() {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };
    let runner = tunnel::Real;
    let dry = a.flag("--dry-run");
    let env = tunnel_env(&dir, &runner, dry);
    let sub = a.words.first().map(String::as_str);
    let check = |allowed: &[&str], words: usize| -> Result<(), String> {
        a.only(allowed)?;
        if a.words.len() != words {
            return Err("wrong number of words".into());
        }
        Ok(())
    };
    let shape = match sub {
        Some("cloudflare") => check(&["--hostname", "--name", "--dry-run"], 1),
        Some("tailscale") => check(&["--public", "--dry-run"], 1),
        Some("status") => check(&["--json"], 1),
        Some("off") => check(&["--dry-run"], 1),
        Some("run") => check(&[], 1),
        _ => Err("tunnel takes cloudflare, tailscale, status, off or run".into()),
    };
    if let Err(e) = shape {
        return usage(&e);
    }
    let done = |r: Result<tunnel::Done, String>| match r {
        Ok(d) => {
            print_done(&d, dry);
            0
        }
        Err(e) => fail(&e),
    };
    match sub {
        Some("cloudflare") => {
            let Some(h) = a.value("--hostname") else {
                return usage(
                    "tunnel cloudflare needs --hostname <name on your Cloudflare domain>",
                );
            };
            done(tunnel::cloudflare(&env, h, a.value("--name")))
        }
        Some("tailscale") => {
            let public = a.flag("--public");
            if public {
                eprintln!("polycarp agent: {}", tunnel::FUNNEL_WARNING);
            }
            done(tunnel::tailscale(&env, public))
        }
        Some("off") => done(tunnel::off(&env)),
        Some("status") => {
            let s = tunnel::status(&env);
            if a.flag("--json") {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&crate::files::ok_json(s)).unwrap_or_default()
                );
                return 0;
            }
            match s["tunnel"].as_object() {
                None => println!("Tunnel: none"),
                Some(t) => println!(
                    "Tunnel: {} at {}",
                    t["kind"].as_str().unwrap_or_default(),
                    t["url"].as_str().unwrap_or_default()
                ),
            }
            0
        }
        Some("run") => match tunnel::run_argv(&env) {
            Ok((prog, args)) => match std::process::Command::new(&prog).args(&args).status() {
                Ok(s) => s.code().unwrap_or(1),
                Err(e) => fail(&format!("could not start {}: {e}", prog.display())),
            },
            Err(e) => fail(&e),
        },
        _ => usage("tunnel takes cloudflare, tailscale, status, off or run"),
    }
}

// ------------------------------------------------------------------------------------------------

fn service_cmd(a: &Args) -> Result<(), Exit> {
    need_only(a, &["--tunnel", "--tailnet"])?;
    let unit = if a.flag("--tunnel") {
        service::Unit::Tunnel
    } else {
        service::Unit::Gateway
    };
    let os = Os::current();
    let home = crate::home().ok_or("no home folder")?;
    let path = service::unit_path(unit, os, &home, local_app_data().as_deref());
    match a.words.first().map(String::as_str) {
        Some("install") if a.words.len() == 1 => {
            if unit == service::Unit::Tunnel {
                let dir = dir()?;
                let t = store::Tunnel::load(&dir)
                    .ok_or("No tunnel is set up yet: `polycarp agent tunnel --help`.")?;
                if t.kind != "cloudflare" {
                    return Err(Exit::Fail(
                        "Tailscale keeps its own tunnel running; no service is needed.".into(),
                    ));
                }
            }
            let exe = crate::files::service::service_exe().ok_or("can't tell where polycarp is")?;
            let user = std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .unwrap_or_default();
            let text = service::render(
                unit,
                os,
                &exe,
                &service::log_path(unit, &home),
                &user,
                a.flag("--tailnet"),
            );
            crate::files::service::write_unit(os, &path, &text)?;
            println!(
                "Wrote {}. Start it with:\n  {}",
                path.display(),
                service::start_cmd(unit, os, &path)
            );
            Ok(())
        }
        Some("uninstall") if a.words.len() == 1 => {
            if !path.exists() {
                println!(
                    "No {} service is installed.",
                    if unit == service::Unit::Tunnel {
                        "tunnel"
                    } else {
                        "gateway"
                    }
                );
                return Ok(());
            }
            println!("Stop it first with:\n  {}", service::stop_cmd(unit, os));
            std::fs::remove_file(&path)
                .map_err(|e| format!("could not remove {}: {e}", path.display()))?;
            println!("Removed {}.", path.display());
            Ok(())
        }
        Some("status") if a.words.len() == 1 => {
            if !path.exists() {
                println!(
                    "Not installed: `polycarp agent service install{}`.",
                    if unit == service::Unit::Tunnel {
                        " --tunnel"
                    } else {
                        ""
                    }
                );
                return Ok(());
            }
            let loaded =
                service::query_argv(unit, os, crate::files::service::uid()).map(|(prog, args)| {
                    let v: Vec<&str> = args.iter().map(String::as_str).collect();
                    crate::files::tailnet::run_for(&prog, &v, std::time::Duration::from_secs(5))
                        .is_ok()
                });
            println!(
                "{}: {}",
                path.display(),
                match loaded {
                    Some(true) => "loaded".to_string(),
                    _ => format!(
                        "written, not loaded. Start it with: {}",
                        service::start_cmd(unit, os, &path)
                    ),
                }
            );
            Ok(())
        }
        _ => Err(Exit::Usage(
            "service install|uninstall|status [--tunnel] [--tailnet]".into(),
        )),
    }
}

fn doctor_cmd(a: &Args) -> i32 {
    if let Err(e) = a.only(&["--json"]) {
        return usage(&e);
    }
    let dir = match dir() {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };
    let link = app::Local::new();
    let f = doctor::gather(&dir, true, Some(&link));
    let hints = doctor::fixes(&f);
    if a.flag("--json") {
        let mut facts = serde_json::to_value(&f).unwrap_or_default();
        facts["healthy"] = json!(f.healthy());
        facts["fixes"] = json!(hints);
        println!(
            "{}",
            serde_json::to_string_pretty(&crate::files::ok_json(facts)).unwrap_or_default()
        );
    } else {
        println!(
            "Gateway: {}",
            if f.serve_running {
                format!("answering on 127.0.0.1:{}", f.port)
            } else {
                format!(
                    "not answering on port {} ({})",
                    f.port,
                    f.serve_error.as_deref().unwrap_or("?")
                )
            }
        );
        println!("Tunnel: {}", f.tunnel_url.as_deref().unwrap_or("none"));
        println!("Clients: {} connectors, {} tokens", f.clients, f.tokens);
        if hints.is_empty() {
            println!("Nothing to fix.");
        }
        for h in &hints {
            println!("- {h}");
        }
    }
    if f.healthy() {
        0
    } else {
        1
    }
}

fn fix_cmd(a: &Args) -> Result<(), Exit> {
    need_only(a, &[])?;
    let dir = dir()?;
    let f = doctor::gather(&dir, true, None);
    let plan = doctor::fix_plan(&f);
    if plan.is_empty() {
        println!("Nothing `fix` can do on its own.");
    }
    for step in plan {
        match step {
            doctor::Action::MakePrivate => {
                let n = doctor::make_private(&dir)?;
                println!("Made {} private ({n} files).", dir.display());
            }
            doctor::Action::Restart(u) => {
                let (prog, args) =
                    service::restart_argv(u, Os::current(), crate::files::service::uid())
                        .ok_or("can't tell how to restart the service here")?;
                let v: Vec<&str> = args.iter().map(String::as_str).collect();
                crate::files::tailnet::run_for(&prog, &v, std::time::Duration::from_secs(20))?;
                println!("Restarted {}.", u.label());
            }
        }
    }
    let after = doctor::fixes(&doctor::gather(&dir, false, None));
    for h in after {
        println!("- {h}");
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------------

fn connect(a: &Args) -> Result<(), Exit> {
    need_only(a, &["--run", "--write", "--tailnet"])?;
    let [client] = a.words.as_slice() else {
        return Err(Exit::Usage(format!(
            "connect takes one of {}",
            connect::CLIENTS.join(", ")
        )));
    };
    let dir = dir()?;
    let exe = crate::files::service::service_exe().ok_or("can't tell where polycarp is")?;
    let tailnet_name = if a.flag("--tailnet") {
        use crate::files::tailnet::Tailnet;
        crate::files::tailnet::Cli::find()
            .ok()
            .and_then(|c| c.status().ok())
            .and_then(|s| s.me)
            .map(|m| m.dns)
            .filter(|d| !d.is_empty())
    } else {
        None
    };
    let c = connect::Ctx {
        exe,
        dir: &dir,
        port: store::Settings::load(&dir)
            .map(|s| s.port())
            .unwrap_or(store::PORT),
        home: crate::home(),
        tailnet_name,
    };
    if a.flag("--run") {
        if client != "claude-code" {
            return Err(Exit::Usage("--run is for claude-code".into()));
        }
        let claude = find_on_path("claude")
            .ok_or("the `claude` command isn't on PATH; run the command below yourself")?;
        let status = std::process::Command::new(&claude)
            .args(connect::claude_code_argv(&c))
            .status()
            .map_err(|e| format!("could not run {}: {e}", claude.display()))?;
        return if status.success() {
            println!("Added. Check with `claude mcp list`.");
            Ok(())
        } else {
            Err(Exit::Fail(format!("claude mcp add failed ({status})")))
        };
    }
    if a.flag("--write") {
        if client != "codex" {
            return Err(Exit::Usage("--write is for codex".into()));
        }
        let home = crate::home().ok_or("no home folder")?;
        let path = connect::codex_config(&home);
        let what = connect::add_entry(&path, &connect::stdio_toml(&c))?;
        println!(
            "{}: polycarp {what}. Start a new Codex session to use it.",
            path.display()
        );
        return Ok(());
    }
    let text = connect::instructions(&c, client, a.flag("--tailnet"))?;
    println!("{text}");
    Ok(())
}

/// A program on PATH that passes the same gate as every tool polycarp runs.
fn find_on_path(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(&exe))
        .find(|c| crate::check(c).is_ok())
}
