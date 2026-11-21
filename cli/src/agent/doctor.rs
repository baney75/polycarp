//! `polycarp agent doctor` and `fix`: what is up, what is not, and the one step that fixes each. `fix` does only the
//! safe steps: make the gateway's files private again and restart a loaded unit that stopped answering.

use super::auth::State;
use super::policy;
use super::service::{self, Unit};
use super::store::{self, Settings, Tunnel, AUTH_FILE};
use super::tunnel;
use crate::channel::Channel;
use crate::files::config::Os;
use serde::Serialize;
use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Facts {
    pub channel: String,
    pub version: String,
    pub dir: String,
    pub port: u16,
    pub serve_running: bool,
    pub serve_error: Option<String>,
    pub settings_error: Option<String>,
    pub auth_error: Option<String>,
    /// Files in the gateway's folder that others can read, and the folder itself when it is.
    pub not_private: Vec<String>,
    pub gateway_unit: Option<String>,
    pub gateway_loaded: Option<bool>,
    pub tunnel_unit: Option<String>,
    pub tunnel_loaded: Option<bool>,
    pub tunnel_kind: Option<String>,
    pub tunnel_url: Option<String>,
    /// Why this channel refuses the tunnel that is set up.
    pub tunnel_refused: Option<String>,
    pub invite: bool,
    pub clients: usize,
    pub tokens: usize,
    pub waiting: Vec<Waiting>,
    pub cloudflared: Option<String>,
    pub cloudflared_signed_in: bool,
    pub tailscale: Option<String>,
    pub tailnet: bool,
    pub app_running: Option<bool>,
}

/// A connection waiting for the owner, as doctor shows it: never its approval code, which the owner reads off the page
/// in the browser that started it.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Waiting {
    pub client: String,
    pub name: String,
    pub redirect_host: String,
    pub origin: String,
    pub unverified: bool,
    pub created: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    MakePrivate,
    Restart(Unit),
}

impl Facts {
    pub fn healthy(&self) -> bool {
        self.serve_running
            && self.not_private.is_empty()
            && self.tunnel_refused.is_none()
            && self.auth_error.is_none()
            && self.settings_error.is_none()
    }
}

fn unit_hint(
    out: &mut Vec<String>,
    what: &str,
    unit: Unit,
    path: &Option<String>,
    loaded: Option<bool>,
    install: &str,
) {
    match (path, loaded) {
        (None, _) => out.push(format!("{what}: run `{install}`, then the start command it prints.")),
        (Some(_), Some(true)) => out.push(format!(
            "{what}: its service is loaded but not answering. Run `polycarp agent fix` to restart it."
        )),
        (Some(p), _) => out.push(format!(
            "{what}: its service is written but not started. Run `{}`.",
            service::start_cmd(unit, Os::current(), Path::new(p))
        )),
    }
}

/// One line per problem: what is wrong, then the step that fixes it.
pub fn fixes(f: &Facts) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(e) = &f.settings_error {
        out.push(format!("agent.toml has a mistake: {e}"));
    }
    if let Some(e) = &f.auth_error {
        out.push(e.clone());
    }
    if !f.not_private.is_empty() {
        out.push(format!(
            "{} can be read by other users of this computer. Run `polycarp agent fix` to make it private.",
            f.not_private.join(", ")
        ));
    }
    if !f.serve_running {
        unit_hint(
            &mut out,
            &format!("The gateway isn't answering on port {}", f.port),
            Unit::Gateway,
            &f.gateway_unit,
            f.gateway_loaded,
            "polycarp agent service install",
        );
    }
    if let Some(why) = &f.tunnel_refused {
        out.push(format!(
            "A {} tunnel is set up, but the {} channel doesn't allow it, so it is refused. Run `polycarp agent tunnel off`. {why}",
            f.tunnel_kind.as_deref().unwrap_or("?"),
            f.channel
        ));
    } else if f.tunnel_kind.as_deref() == Some("cloudflare") {
        if f.cloudflared.is_none() {
            out.push(
                "The Cloudflare tunnel needs cloudflared, which isn't installed here anymore."
                    .into(),
            );
        } else if f.tunnel_loaded != Some(true) {
            unit_hint(
                &mut out,
                "The Cloudflare tunnel isn't kept running",
                Unit::Tunnel,
                &f.tunnel_unit,
                f.tunnel_loaded,
                "polycarp agent service install --tunnel",
            );
        }
    }
    for w in &f.waiting {
        out.push(format!(
            "\"{}\" ({}) is waiting for approval: it came through {} and its code goes to {}{}. If you started it, \
approve it with the code on its page: `polycarp agent approve <code>`. If you didn't, let it expire or run \
`polycarp agent revoke {}`.",
            w.name,
            w.client,
            w.origin,
            w.redirect_host,
            if w.unverified {
                ", which is not an assistant's own host (unverified)"
            } else {
                ""
            },
            w.client,
        ));
    }
    if f.app_running == Some(false) {
        out.push("The Polycarp app isn't running, so app and workspace tools will say so. Open Polycarp.".into());
    }
    out
}

/// What `fix` does on its own: only safe steps. Installing a unit, a tunnel or Tailscale stays a hint.
pub fn fix_plan(f: &Facts) -> Vec<Action> {
    let mut plan = Vec::new();
    if !f.not_private.is_empty() {
        plan.push(Action::MakePrivate);
    }
    if !f.serve_running && f.gateway_unit.is_some() && f.gateway_loaded == Some(true) {
        plan.push(Action::Restart(Unit::Gateway));
    }
    if f.tunnel_refused.is_none()
        && f.tunnel_kind.as_deref() == Some("cloudflare")
        && f.tunnel_unit.is_some()
        && f.tunnel_loaded == Some(true)
        && !f.serve_running
    {
        plan.push(Action::Restart(Unit::Tunnel));
    }
    plan
}

/// Makes the folder 0700 and every file in it 0600.
pub fn make_private(dir: &Path) -> Result<usize, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut n = 0;
        store::ensure_dir(dir)?;
        for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
            let p = e.path();
            if p.is_file() && store::mode(&p).is_some_and(|m| m & 0o077 != 0) {
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
                n += 1;
            }
        }
        Ok(n)
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(0)
    }
}

fn not_private(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if store::mode(dir).is_some_and(|m| m & 0o077 != 0) {
        out.push(dir.display().to_string());
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() && store::mode(&p).is_some_and(|m| m & 0o077 != 0) {
                out.push(p.display().to_string());
            }
        }
    }
    out.sort();
    out
}

fn loaded(unit: Unit) -> Option<bool> {
    service::query_argv(unit, Os::current(), crate::files::service::uid()).map(|(prog, args)| {
        let a: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::files::tailnet::run_for(&prog, &a, Duration::from_secs(5)).is_ok()
    })
}

/// Looks at everything. `probe_units` false skips asking launchd or systemd (tests).
pub fn gather(
    dir: &Path,
    channel: Channel,
    probe_units: bool,
    app: Option<&dyn super::app::AppLink>,
) -> Facts {
    let mut f = Facts {
        channel: channel.name().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        dir: dir.display().to_string(),
        port: store::PORT,
        ..Facts::default()
    };
    match Settings::load(dir) {
        Ok(s) => {
            f.port = s.port();
            f.tailnet = s.tailnet;
        }
        Err(e) => f.settings_error = Some(e),
    }
    match store::read_json::<State>(&dir.join(AUTH_FILE)) {
        Ok(mut st) => {
            let now = store::now();
            f.clients = st.clients.len();
            f.tokens = st.bearers.iter().filter(|b| b.revoked.is_none()).count();
            f.waiting = st
                .waiting(now)
                .iter()
                .map(|p| Waiting {
                    client: p.client.clone(),
                    name: st
                        .clients
                        .get(&p.client)
                        .map(|c| c.name.clone())
                        .unwrap_or_default(),
                    redirect_host: super::auth::redirect_host(&p.redirect_uri),
                    origin: p.origin.name().into(),
                    unverified: st.unverified(p),
                    created: p.created,
                })
                .collect();
        }
        Err(e) => f.auth_error = Some(e),
    }
    f.not_private = not_private(dir);
    let addr = SocketAddr::from(([127, 0, 0, 1], f.port));
    match crate::files::http::request(addr, "GET", "/health", None, Duration::from_secs(2)) {
        Ok(r) if r.status == 200 && String::from_utf8_lossy(&r.body).contains("polycarp-agent") => {
            f.serve_running = true
        }
        Ok(r) => {
            f.serve_error = Some(format!(
                "port {} answers, but not as the gateway (HTTP {})",
                f.port, r.status
            ))
        }
        Err(e) => f.serve_error = Some(e.to_string()),
    }
    if let Some(t) = Tunnel::load(dir) {
        f.tunnel_kind = Some(t.kind.clone());
        f.tunnel_url = Some(format!("{}/mcp", t.public_url));
        if let Some(route) = t.route() {
            let invited = policy::load_invite(dir).is_some();
            f.tunnel_refused = policy::check(channel, route, invited)
                .err()
                .map(|r| r.message);
        }
    }
    f.invite = policy::load_invite(dir).is_some();
    f.cloudflared = tunnel::find_cloudflared().map(|p| p.display().to_string());
    if let Some(home) = crate::home() {
        f.cloudflared_signed_in = home.join(".cloudflared/cert.pem").is_file();
        let local = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);
        for unit in [Unit::Gateway, Unit::Tunnel] {
            let p = service::unit_path(unit, Os::current(), &home, local.as_deref());
            if p.is_file() {
                let l = if probe_units { loaded(unit) } else { None };
                match unit {
                    Unit::Gateway => {
                        (f.gateway_unit, f.gateway_loaded) = (Some(p.display().to_string()), l)
                    }
                    Unit::Tunnel => {
                        (f.tunnel_unit, f.tunnel_loaded) = (Some(p.display().to_string()), l)
                    }
                }
            }
        }
    }
    f.tailscale = crate::files::tailnet::find_tailscale().map(|p| p.display().to_string());
    if let Some(link) = app {
        f.app_running = Some(
            link.request(&serde_json::json!({"op": "ping", "caller": "polycarp agent doctor"}))
                .is_ok(),
        );
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up() -> Facts {
        Facts {
            channel: "dev".into(),
            port: 41772,
            serve_running: true,
            ..Facts::default()
        }
    }

    #[test]
    fn a_healthy_gateway_needs_nothing() {
        let f = up();
        assert!(f.healthy());
        assert!(fixes(&f).is_empty());
        assert!(fix_plan(&f).is_empty());
    }

    #[test]
    fn fix_makes_files_private_and_restarts_only_a_loaded_unit() {
        let mut f = up();
        f.not_private = vec!["/c/agent/auth.json".into()];
        f.serve_running = false;
        assert_eq!(fix_plan(&f), vec![Action::MakePrivate], "no unit: a hint");
        assert!(fixes(&f)
            .iter()
            .any(|l| l.contains("polycarp agent service install")));
        f.gateway_unit = Some("/h/Library/LaunchAgents/com.polycarp.agent.plist".into());
        f.gateway_loaded = Some(false);
        assert_eq!(fix_plan(&f), vec![Action::MakePrivate]);
        assert!(fixes(&f)
            .iter()
            .any(|l| l.contains("written but not started")));
        f.gateway_loaded = Some(true);
        assert_eq!(
            fix_plan(&f),
            vec![Action::MakePrivate, Action::Restart(Unit::Gateway)]
        );
    }

    #[test]
    fn a_refused_tunnel_is_named_with_the_way_out_and_never_restarted() {
        let mut f = up();
        f.channel = "stable".into();
        f.tunnel_kind = Some("cloudflare".into());
        f.tunnel_unit = Some("/u".into());
        f.tunnel_loaded = Some(true);
        f.serve_running = false;
        f.tunnel_refused = Some(policy::waitlist_message());
        let h = fixes(&f).join("\n");
        assert!(
            h.contains("polycarp agent tunnel off") && h.contains(policy::WAITLIST_URL),
            "{h}"
        );
        assert!(!fix_plan(&f).contains(&Action::Restart(Unit::Tunnel)));
        assert!(!f.healthy());
    }

    #[test]
    fn waiting_connectors_are_listed_by_client_and_redirect_host() {
        let mut f = up();
        f.waiting = vec![Waiting {
            client: "pcl_abc".into(),
            name: "Claude".into(),
            redirect_host: "claude.ai".into(),
            origin: "the public tunnel".into(),
            unverified: false,
            created: 0,
        }];
        let h = fixes(&f)[0].clone();
        assert!(h.contains("pcl_abc") && h.contains("claude.ai"), "{h}");
    }

    #[test]
    fn gather_reads_a_folder_and_finds_what_isnt_private() {
        let d = std::env::temp_dir().join(format!("pc-agent-doc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        store::write_json(&d.join(AUTH_FILE), &State::default()).unwrap();
        let f = gather(&d, Channel::Nightly, false, None);
        assert!(f.not_private.is_empty(), "{:?}", f.not_private);
        assert_eq!(f.channel, "nightly");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(d.join(AUTH_FILE), std::fs::Permissions::from_mode(0o644))
                .unwrap();
            assert_eq!(
                gather(&d, Channel::Nightly, false, None).not_private.len(),
                1
            );
            assert_eq!(make_private(&d).unwrap(), 1);
            assert!(gather(&d, Channel::Nightly, false, None)
                .not_private
                .is_empty());
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
