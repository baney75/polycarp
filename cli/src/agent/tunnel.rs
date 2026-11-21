//! `polycarp agent tunnel ...`: reach the gateway from the internet, or from the whole tailnet over HTTPS.
//!
//! Every command passes `policy::check` first. dev and nightly bring their own tunnel:
//! - `cloudflare --hostname <name>`: a named tunnel on the person's own Cloudflare account, through their own
//!   `cloudflared`, after Tychicus D31. Sign-in is `cloudflared tunnel login`, done by the person; this command only
//!   checks that it happened (`~/.cloudflared/cert.pem` exists; it is never read). No API key is asked for or stored.
//!   The tunnel's config goes under Polycarp's config folder; its credentials stay where cloudflared put them.
//! - `tailscale [--public]`: Tailscale Serve on port 8443 (the tailnet only), or Funnel (public) with a warning.
//!
//! stable sets up neither and says so: its hosted tunnel is waitlisted (`join`, `redeem`). There is no hosted relay
//! in this build; with an invite stored, `status` says the hosted tunnel isn't open yet.

use super::policy::{self, Route};
use super::store::{self, Tunnel, TUNNEL_FILE};
use crate::channel::Channel;
use serde_json::{json, Value as Json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The HTTPS port Tailscale Serve and Funnel use for the gateway (443 is often taken by the person's own serve).
pub const TS_PORT: u16 = 8443;
pub const DEFAULT_TUNNEL_NAME: &str = "polycarp-agent";
const CLOUDFLARED_CONFIG: &str = "cloudflared.yml";

/// Runs programs. Tests use a stub; the real one never goes through a shell.
pub trait Runner {
    fn run(&self, program: &Path, args: &[&str]) -> Result<String, String>;
}

pub struct Real;

impl Runner for Real {
    fn run(&self, program: &Path, args: &[&str]) -> Result<String, String> {
        crate::files::tailnet::run_for(program, args, Duration::from_secs(90))
    }
}

/// What a tunnel command needs to know about this machine.
pub struct Env<'a> {
    pub dir: &'a Path,
    pub channel: Channel,
    pub port: u16,
    pub home: Option<PathBuf>,
    pub cloudflared: Option<PathBuf>,
    pub tailscale: Option<PathBuf>,
    pub runner: &'a dyn Runner,
    /// Print what would run instead of running it.
    pub dry_run: bool,
}

/// What a tunnel command did, for the person.
#[derive(Debug, Default, PartialEq)]
pub struct Done {
    pub lines: Vec<String>,
    /// The commands it ran (or would run, with --dry-run), program first.
    pub ran: Vec<Vec<String>>,
    pub tunnel: Option<Tunnel>,
}

fn gate(env: &Env, route: Route) -> Result<(), String> {
    let invited = policy::load_invite(env.dir).is_some();
    policy::check(env.channel, route, invited).map_err(|r| r.message)
}

impl Env<'_> {
    fn exec(&self, done: &mut Done, program: &Path, args: &[&str]) -> Result<String, String> {
        let mut line = vec![program.display().to_string()];
        line.extend(args.iter().map(|a| a.to_string()));
        done.ran.push(line);
        if self.dry_run {
            return Ok(String::new());
        }
        self.runner.run(program, args)
    }
}

/// A host name as DNS takes it: labels of letters, digits and dashes, at least two labels, no scheme or path.
pub fn hostname_ok(h: &str) -> bool {
    let labels: Vec<&str> = h.split('.').collect();
    h.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| {
            (1..=63).contains(&l.len())
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn name_ok(n: &str) -> bool {
    (1..=64).contains(&n.len())
        && n.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The tunnel id for `name` from `cloudflared tunnel list --output json`.
fn tunnel_id(list: &str, name: &str) -> Option<String> {
    let v: Json = serde_json::from_str(list).ok()?;
    v.as_array()?
        .iter()
        .find(|t| {
            t["name"] == json!(name)
                && t["deleted_at"]
                    .as_str()
                    .is_none_or(|d| d.is_empty() || d.starts_with("0001"))
        })
        .and_then(|t| t["id"].as_str())
        .map(str::to_string)
}

pub fn cloudflared_config(dir: &Path) -> PathBuf {
    dir.join(CLOUDFLARED_CONFIG)
}

/// The config `cloudflared tunnel run` reads: everything for this host goes to the gateway on loopback, anything
/// else gets a 404 from cloudflared itself.
pub fn render_cloudflared(id: &str, credentials: &Path, host: &str, port: u16) -> String {
    format!(
        "# Written by `polycarp agent tunnel cloudflare`. The credentials file is cloudflared's own; Polycarp never reads it.\n\
tunnel: {id}\ncredentials-file: \"{}\"\nno-autoupdate: true\ningress:\n  - hostname: {host}\n    service: http://127.0.0.1:{port}\n  - service: http_status:404\n",
        credentials.display().to_string().replace('\\', "\\\\").replace('"', "\\\"")
    )
}

pub fn cloudflare(env: &Env, hostname: &str, name: Option<&str>) -> Result<Done, String> {
    gate(env, Route::Cloudflare)?;
    let host = hostname.trim().trim_end_matches('.').to_ascii_lowercase();
    if !hostname_ok(&host) {
        return Err(format!(
            "--hostname takes a host name on a domain in your Cloudflare account, like agent.example.com (not {hostname:?})"
        ));
    }
    let name = name.unwrap_or(DEFAULT_TUNNEL_NAME);
    if !name_ok(name) {
        return Err("--name takes letters, digits, dashes and underscores".into());
    }
    let cf = env.cloudflared.as_deref().ok_or(
        "cloudflared is not installed. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ \
then run `cloudflared tunnel login` and this command again.",
    )?;
    let home = env.home.as_deref().ok_or("no home folder")?;
    // Signed in means cloudflared saved its origin certificate. Only its presence is checked; it is never read.
    if !home.join(".cloudflared/cert.pem").is_file() {
        return Err(
            "cloudflared isn't signed in to your Cloudflare account. Run `cloudflared tunnel login`, pick the domain \
for the host name, then run this command again. Polycarp never asks for a Cloudflare API key."
                .into(),
        );
    }
    let mut done = Done::default();
    let list = env.exec(
        &mut done,
        cf,
        &["tunnel", "list", "--output", "json", "--name", name],
    )?;
    let id = match tunnel_id(&list, name) {
        Some(id) => {
            done.lines.push(format!("Using your tunnel {name} ({id})."));
            id
        }
        None => {
            env.exec(&mut done, cf, &["tunnel", "create", name])?;
            let list = env.exec(
                &mut done,
                cf,
                &["tunnel", "list", "--output", "json", "--name", name],
            )?;
            match tunnel_id(&list, name) {
                Some(id) => {
                    done.lines
                        .push(format!("Made the tunnel {name} ({id}) on your account."));
                    id
                }
                None if env.dry_run => "<tunnel-id>".into(),
                None => {
                    return Err(format!(
                    "cloudflared made {name} but doesn't list it; run `cloudflared tunnel list`"
                ))
                }
            }
        }
    };
    env.exec(&mut done, cf, &["tunnel", "route", "dns", &id, &host]).map_err(|e| {
        format!(
            "{e}\nIf {host} already points somewhere else, pick another host name, or remove that DNS record in \
Cloudflare yourself; Polycarp won't overwrite it."
        )
    })?;
    let credentials = home.join(".cloudflared").join(format!("{id}.json"));
    let config = cloudflared_config(env.dir);
    let t = Tunnel {
        kind: "cloudflare".into(),
        public_url: format!("https://{host}"),
        host: host.clone(),
        name: Some(name.to_string()),
        created: store::now(),
    };
    if !env.dry_run {
        store::write_private(
            &config,
            render_cloudflared(&id, &credentials, &host, env.port).as_bytes(),
        )?;
        store::write_json(&env.dir.join(TUNNEL_FILE), &t)?;
    }
    done.lines.push(format!("Wrote {}.", config.display()));
    done.lines.push(format!(
        "Run the tunnel with `polycarp agent tunnel run`, or keep it running with `polycarp agent service install --tunnel`. \
Then connect an assistant to {}/mcp (`polycarp agent connect claude.ai`).",
        t.public_url
    ));
    done.tunnel = Some(t);
    Ok(done)
}

/// The proxy Tailscale Serve has on this host and port, from `tailscale serve status --json`.
fn serve_proxy(status: &str, dns: &str) -> Option<String> {
    let v: Json = serde_json::from_str(status).ok()?;
    let key = format!("{dns}:{TS_PORT}");
    v["Web"][&key]["Handlers"]["/"]["Proxy"]
        .as_str()
        .map(str::to_string)
}

pub const FUNNEL_WARNING: &str = "Funnel puts the gateway on the public internet. Anyone can reach its sign-in pages; \
only a connector the owner approved on this machine, or a token made with --remote, can call a tool. Use Serve (no \
--public) when every assistant runs on your own devices.";

pub fn tailscale(env: &Env, public: bool) -> Result<Done, String> {
    let route = if public {
        Route::TailscaleFunnel
    } else {
        Route::TailscaleServe
    };
    gate(env, route)?;
    let ts = env
        .tailscale
        .as_deref()
        .ok_or("Tailscale is not installed here: install it from https://tailscale.com/download and sign in.")?;
    let mut done = Done::default();
    // Read-only questions run even with --dry-run: the plan depends on them.
    let status = env
        .runner
        .run(ts, &["status", "--json"])
        .and_then(|s| crate::files::tailnet::parse_status(&s))?;
    let me = status
        .me
        .filter(|_| status.backend == "Running")
        .ok_or("Tailscale isn't running and signed in: open Tailscale and sign in.")?;
    if me.dns.is_empty() {
        return Err("this device has no MagicDNS name: turn on MagicDNS and HTTPS in the Tailscale admin console.".into());
    }
    let ours = format!("http://127.0.0.1:{}", env.port);
    if let Ok(s) = env.runner.run(ts, &["serve", "status", "--json"]) {
        match serve_proxy(&s, &me.dns) {
            Some(p) if p.trim_end_matches('/') != ours => {
                return Err(format!(
                    "Tailscale already serves {p} on port {TS_PORT} of this device. Polycarp won't replace it; free \
the port (`tailscale serve --https={TS_PORT} off`) and run this again."
                ))
            }
            _ => {}
        }
    }
    let verb = if public { "funnel" } else { "serve" };
    let https = format!("--https={TS_PORT}");
    env.exec(&mut done, ts, &[verb, "--bg", &https, &ours]).map_err(|e| {
        if public && e.to_ascii_lowercase().contains("lock") {
            format!("{e}\nTailnet Lock refuses Funnel. Use Serve (no --public), or a Cloudflare tunnel.")
        } else {
            format!("{e}\nTailscale may need HTTPS certificates (and, for --public, the funnel attribute) turned on in its admin console.")
        }
    })?;
    if public {
        done.lines.push(FUNNEL_WARNING.into());
    }
    let t = Tunnel {
        kind: if public { "funnel" } else { "tailscale" }.into(),
        public_url: format!("https://{}:{TS_PORT}", me.dns),
        host: me.dns.clone(),
        name: None,
        created: store::now(),
    };
    if !env.dry_run {
        store::write_json(&env.dir.join(TUNNEL_FILE), &t)?;
    }
    done.lines.push(format!(
        "Tailscale {} {}/mcp to the gateway. It keeps doing so across restarts; `polycarp agent tunnel off` stops it.",
        if public { "now publishes" } else { "now serves your tailnet" },
        t.public_url
    ));
    done.tunnel = Some(t);
    Ok(done)
}

/// Undoes what a tunnel command set up here. The Cloudflare tunnel itself stays on the account: deleting it is the
/// person's call, and the command for it is printed.
pub fn off(env: &Env) -> Result<Done, String> {
    let mut done = Done::default();
    let Some(t) = Tunnel::load(env.dir) else {
        done.lines.push("No tunnel is set up.".into());
        return Ok(done);
    };
    match t.kind.as_str() {
        "tailscale" | "funnel" => {
            let ts = env
                .tailscale
                .as_deref()
                .ok_or("Tailscale is not installed here")?;
            let verb = if t.kind == "funnel" {
                "funnel"
            } else {
                "serve"
            };
            env.exec(&mut done, ts, &[verb, &format!("--https={TS_PORT}"), "off"])?;
        }
        _ => {
            if !env.dry_run {
                let _ = fs::remove_file(cloudflared_config(env.dir));
            }
            done.lines.push(format!(
                "Stop the tunnel service with `polycarp agent service uninstall --tunnel`. The tunnel stays on your \
Cloudflare account; delete it there with `cloudflared tunnel delete {}` if you're done with it.",
                t.name.as_deref().unwrap_or(DEFAULT_TUNNEL_NAME)
            ));
        }
    }
    if !env.dry_run {
        let _ = fs::remove_file(env.dir.join(TUNNEL_FILE));
    }
    done.lines
        .insert(0, format!("Turned off {} ({}).", t.public_url, t.kind));
    Ok(done)
}

/// What `tunnel run` starts: cloudflared with our config. Checked against the policy each time, so an install that
/// moved to stable stops publishing.
pub fn run_argv(env: &Env) -> Result<(PathBuf, Vec<String>), String> {
    let t = Tunnel::load(env.dir).ok_or("No tunnel is set up: `polycarp agent tunnel --help`.")?;
    let route = t.route().ok_or("tunnel.json names an unknown kind")?;
    gate(env, route)?;
    if t.kind != "cloudflare" {
        return Err("Tailscale serves this tunnel itself; nothing to run here.".into());
    }
    let cf = env
        .cloudflared
        .clone()
        .ok_or("cloudflared is not installed")?;
    let config = cloudflared_config(env.dir);
    if !config.is_file() {
        return Err(format!(
            "{} is missing: run `polycarp agent tunnel cloudflare` again.",
            config.display()
        ));
    }
    Ok((
        cf,
        vec![
            "tunnel".into(),
            "--config".into(),
            config.display().to_string(),
            "run".into(),
        ],
    ))
}

/// `tunnel status`: the route, whether this channel allows it, and the hosted tunnel's waitlist state.
pub fn status(env: &Env) -> Json {
    let t = Tunnel::load(env.dir);
    let invite = policy::load_invite(env.dir);
    let allowed = t.as_ref().and_then(|t| t.route()).map(|r| gate(env, r));
    let hosted = match env.channel {
        Channel::Stable if invite.is_some() => {
            "invited: Polycarp's hosted tunnel isn't open yet; your invite is stored for when it is"
        }
        Channel::Stable => "waitlisted: `polycarp agent tunnel join`",
        _ => "not on this channel: bring your own tunnel",
    };
    json!({
        "channel": env.channel.name(),
        "tunnel": t.as_ref().map(|t| json!({
            "kind": t.kind,
            "url": format!("{}/mcp", t.public_url),
            "allowed": allowed.as_ref().is_some_and(|a| a.is_ok()),
            "refused": allowed.and_then(|a| a.err()),
        })),
        "hosted": hosted,
        "invite": invite.is_some(),
    })
}

/// Where `cloudflared` is: POLYCARP_CLOUDFLARED, PATH, then the usual spots; each passes the same gate as every tool.
pub fn find_cloudflared() -> Option<PathBuf> {
    if let Some(v) = std::env::var_os("POLYCARP_CLOUDFLARED").filter(|v| !v.is_empty()) {
        let p = PathBuf::from(v);
        return crate::check(&p).ok().map(|()| p);
    }
    let exe = if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        cands.extend(std::env::split_paths(&path).map(|d| d.join(exe)));
    }
    for spot in [
        "/opt/homebrew/bin/cloudflared",
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
        "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    ] {
        cands.extend(crate::spot_path(spot));
    }
    cands.into_iter().find(|c| crate::check(c).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Answers like cloudflared and tailscale would, and records every call.
    struct Stub {
        calls: RefCell<Vec<Vec<String>>>,
        listed: RefCell<bool>,
        serve_status: String,
        fail_with: Option<String>,
    }

    impl Stub {
        fn new() -> Stub {
            Stub {
                calls: RefCell::new(Vec::new()),
                listed: RefCell::new(false),
                serve_status: "{}".into(),
                fail_with: None,
            }
        }
    }

    impl Runner for Stub {
        fn run(&self, program: &Path, args: &[&str]) -> Result<String, String> {
            let mut c = vec![program.display().to_string()];
            c.extend(args.iter().map(|a| a.to_string()));
            self.calls.borrow_mut().push(c);
            match args {
                ["tunnel", "list", ..] if *self.listed.borrow() => {
                    Ok(r#"[{"id":"6ff42ae2-765d-4adf-8112-31c55c1551ef","name":"polycarp-agent","deleted_at":"0001-01-01T00:00:00Z"}]"#.into())
                }
                ["tunnel", "list", ..] => Ok("[]".into()),
                ["tunnel", "create", ..] => {
                    *self.listed.borrow_mut() = true;
                    Ok(String::new())
                }
                ["status", "--json"] => Ok(r#"{"BackendState":"Running","Self":{"DNSName":"mac.tail1234.ts.net.","HostName":"mac","TailscaleIPs":["100.64.0.5"],"UserID":7,"Online":true,"OS":"macOS"},"Peer":{}}"#.into()),
                ["serve", "status", "--json"] => Ok(self.serve_status.clone()),
                ["serve" | "funnel", "--bg", ..] => match &self.fail_with {
                    Some(e) => Err(e.clone()),
                    None => Ok(String::new()),
                },
                _ => Ok(String::new()),
            }
        }
    }

    fn setup(tag: &str) -> (PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("pc-agent-tunnel-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        fs::create_dir_all(home.join(".cloudflared")).unwrap();
        (root.join("agent"), home)
    }

    fn env<'a>(dir: &'a Path, home: &Path, channel: Channel, stub: &'a Stub) -> Env<'a> {
        Env {
            dir,
            channel,
            port: 41772,
            home: Some(home.to_path_buf()),
            cloudflared: Some(PathBuf::from("/opt/homebrew/bin/cloudflared")),
            tailscale: Some(PathBuf::from("/usr/local/bin/tailscale")),
            runner: stub,
            dry_run: false,
        }
    }

    #[test]
    fn stable_refuses_both_own_tunnels_before_running_anything() {
        let (dir, home) = setup("stable");
        let stub = Stub::new();
        let e = env(&dir, &home, Channel::Stable, &stub);
        for r in [
            cloudflare(&e, "agent.example.com", None),
            tailscale(&e, false),
            tailscale(&e, true),
        ] {
            let m = r.unwrap_err();
            assert!(
                m.contains(policy::WAITLIST_URL) && m.contains("local MCP works now"),
                "{m}"
            );
        }
        assert!(
            stub.calls.borrow().is_empty(),
            "stable ran {:?}",
            stub.calls.borrow()
        );
        let s = status(&e);
        assert_eq!(
            s["hosted"].as_str().unwrap().split(':').next(),
            Some("waitlisted")
        );
    }

    #[test]
    fn cloudflare_needs_the_persons_own_sign_in_and_never_a_key() {
        let (dir, home) = setup("cflogin");
        let stub = Stub::new();
        let e = env(&dir, &home, Channel::Nightly, &stub);
        let m = cloudflare(&e, "agent.example.com", None).unwrap_err();
        assert!(
            m.contains("cloudflared tunnel login")
                && m.contains("never asks for a Cloudflare API key"),
            "{m}"
        );
        assert!(stub.calls.borrow().is_empty());
        for bad in [
            "https://agent.example.com",
            "agent",
            "a b.com",
            "-x.example.com",
            "x.example.com/mcp",
        ] {
            assert!(
                cloudflare(&e, bad, None)
                    .unwrap_err()
                    .contains("--hostname"),
                "{bad}"
            );
        }
    }

    #[test]
    fn cloudflare_makes_a_named_tunnel_routes_dns_and_writes_config_under_polycarp() {
        let (dir, home) = setup("cf");
        fs::write(home.join(".cloudflared/cert.pem"), "stub").unwrap();
        let stub = Stub::new();
        let e = env(&dir, &home, Channel::Dev, &stub);
        let d = cloudflare(&e, "Agent.Example.com.", None).unwrap();
        let calls: Vec<String> = stub
            .calls
            .borrow()
            .iter()
            .map(|c| c[1..].join(" "))
            .collect();
        assert_eq!(
            calls,
            vec![
                "tunnel list --output json --name polycarp-agent",
                "tunnel create polycarp-agent",
                "tunnel list --output json --name polycarp-agent",
                "tunnel route dns 6ff42ae2-765d-4adf-8112-31c55c1551ef agent.example.com",
            ]
        );
        let t = d.tunnel.unwrap();
        assert_eq!(
            (t.kind.as_str(), t.public_url.as_str()),
            ("cloudflare", "https://agent.example.com")
        );
        assert_eq!(Tunnel::load(&dir), Some(t));
        let yml = fs::read_to_string(cloudflared_config(&dir)).unwrap();
        assert!(
            yml.contains("service: http://127.0.0.1:41772") && yml.contains("http_status:404"),
            "{yml}"
        );
        assert!(yml.contains("6ff42ae2-765d-4adf-8112-31c55c1551ef.json"));
        if cfg!(unix) {
            assert_eq!(store::mode(&cloudflared_config(&dir)), Some(0o600));
        }
        // Run it the way the service does.
        let (prog, args) = run_argv(&e).unwrap();
        assert!(prog.ends_with("cloudflared"));
        assert_eq!(args[0], "tunnel");
        assert_eq!(args.last().map(String::as_str), Some("run"));
        // The same install moved to stable stops publishing.
        let stable = env(&dir, &home, Channel::Stable, &stub);
        assert!(run_argv(&stable)
            .unwrap_err()
            .contains(policy::WAITLIST_URL));
        // A second run reuses the tunnel.
        stub.calls.borrow_mut().clear();
        cloudflare(&e, "agent.example.com", None).unwrap();
        assert!(!stub.calls.borrow().iter().any(|c| c[2] == "create"));
        // Off removes our files and leaves the tunnel on the account.
        let d = off(&e).unwrap();
        assert!(d
            .lines
            .join(" ")
            .contains("cloudflared tunnel delete polycarp-agent"));
        assert!(Tunnel::load(&dir).is_none() && !cloudflared_config(&dir).exists());
    }

    #[test]
    fn tailscale_serves_on_8443_and_funnel_warns() {
        let (dir, home) = setup("ts");
        let stub = Stub::new();
        let e = env(&dir, &home, Channel::Nightly, &stub);
        let d = tailscale(&e, false).unwrap();
        assert!(stub
            .calls
            .borrow()
            .iter()
            .any(|c| c[1..] == ["serve", "--bg", "--https=8443", "http://127.0.0.1:41772"]));
        assert_eq!(
            d.tunnel.as_ref().unwrap().public_url,
            "https://mac.tail1234.ts.net:8443"
        );
        assert!(!d.lines.join(" ").contains("public internet"));
        let d = tailscale(&e, true).unwrap();
        assert!(stub.calls.borrow().iter().any(|c| c[1] == "funnel"));
        assert!(d.lines.join(" ").contains("public internet"));
        assert_eq!(Tunnel::load(&dir).unwrap().kind, "funnel");
        off(&e).unwrap();
        assert!(stub
            .calls
            .borrow()
            .iter()
            .any(|c| c[1..] == ["funnel", "--https=8443", "off"]));
    }

    #[test]
    fn tailscale_wont_replace_someone_elses_serve_and_explains_tailnet_lock() {
        let (dir, home) = setup("tsbusy");
        let mut stub = Stub::new();
        stub.serve_status = r#"{"Web":{"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#.into();
        let e = env(&dir, &home, Channel::Dev, &stub);
        assert!(tailscale(&e, false)
            .unwrap_err()
            .contains("won't replace it"));
        let mut stub = Stub::new();
        stub.fail_with = Some("funnel not available; tailnet lock is enabled".into());
        let e = env(&dir, &home, Channel::Dev, &stub);
        assert!(tailscale(&e, true)
            .unwrap_err()
            .contains("Tailnet Lock refuses Funnel"));
    }

    #[test]
    fn dry_run_changes_nothing() {
        let (dir, home) = setup("dry");
        fs::write(home.join(".cloudflared/cert.pem"), "stub").unwrap();
        let stub = Stub::new();
        let mut e = env(&dir, &home, Channel::Dev, &stub);
        e.dry_run = true;
        let d = cloudflare(&e, "agent.example.com", None).unwrap();
        assert!(stub.calls.borrow().is_empty());
        assert!(d
            .ran
            .iter()
            .any(|c| c[1..3] == ["tunnel".to_string(), "create".to_string()]));
        assert!(Tunnel::load(&dir).is_none());
    }
}
