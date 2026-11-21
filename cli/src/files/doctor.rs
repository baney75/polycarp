//! `polycarp files doctor` and `fix`: what is up, what is not, and the one step that fixes each.

use super::config::{Config, Os};
use super::fleet::{self, Target};
use super::index::{self, Index};
use super::service;
use super::tailnet::{Status, Tailnet};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Peer {
    pub name: String,
    pub os: String,
    pub online: bool,
    /// None when it was not asked (offline).
    pub reachable: Option<bool>,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Facts {
    /// files.toml could not be read. Nothing else is trusted, and `fix` does nothing, until it is fixed.
    pub config_error: Option<String>,
    /// The `tailscale` command, if found.
    pub tailscale: Option<String>,
    pub backend: String,
    pub logged_in: bool,
    pub device: Option<String>,
    pub ips: Vec<String>,
    pub port: u16,
    pub version: String,
    pub serve_running: bool,
    pub serve_error: Option<String>,
    pub service_unit: Option<String>,
    pub service_loaded: Option<bool>,
    pub index_path: String,
    pub index_files: Option<i64>,
    pub index_bytes: Option<u64>,
    pub index_age_secs: Option<i64>,
    pub index_stale: bool,
    pub roots: Vec<String>,
    pub missing_roots: Vec<String>,
    /// Folders the last full index run could not read; their old rows are kept.
    pub unreadable: Vec<String>,
    /// How the watching index keeps up: `events`, or `rescan: <why watching failed>`.
    pub watch: Option<String>,
    pub allow_save: bool,
    pub peers: Vec<Peer>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Reindex,
    RestartService,
}

impl Facts {
    pub fn healthy(&self) -> bool {
        self.config_error.is_none()
            && self.logged_in
            && self.serve_running
            && !self.index_stale
            && self.index_files.is_some()
    }
}

/// One line per problem: what is wrong, then the step that fixes it.
pub fn fixes(f: &Facts) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(e) = &f.config_error {
        out.push(format!(
            "files.toml: {e}; fix it, then run `polycarp files doctor` again."
        ));
    }
    if f.tailscale.is_none() {
        out.push("Tailscale is not installed: install it from https://tailscale.com/download and sign in.".into());
    } else if !f.logged_in {
        out.push(format!(
            "Tailscale is {}: open Tailscale and sign in (or run `tailscale up`).",
            if f.backend.is_empty() {
                "not running"
            } else {
                &f.backend
            }
        ));
    }
    // While files.toml is broken, `index` and `fix` refuse to run, so no line sends the owner to them.
    let roots_known = f.config_error.is_none();
    if roots_known && f.index_files.is_none() {
        out.push(
            "There is no index yet: run `polycarp files index` (or `polycarp files fix`).".into(),
        );
    } else if roots_known && f.index_stale {
        out.push("The index is stale: run `polycarp files fix` to update it.".into());
    }
    if let Some(first) = f.unreadable.first().filter(|_| roots_known) {
        let more = match f.unreadable.len() {
            1 => String::new(),
            n => format!(" and {} more", n - 1),
        };
        let how = if Os::current() == Os::Mac {
            "If the files service runs it, allow polycarp in System Settings > Privacy & Security > Files and Folders (or Full Disk Access), then run `polycarp files index`."
        } else {
            "Check that folder's permissions, or reconnect its drive, then run `polycarp files index`."
        };
        out.push(format!(
            "polycarp can't read {first}{more}; what was indexed there is kept. {how}"
        ));
    }
    if let Some(why) = f.watch.as_deref().and_then(|w| w.strip_prefix("rescan: ")) {
        let linux = if Os::current() == Os::Linux {
            " Raising fs.inotify.max_user_watches lets watching work again."
        } else {
            ""
        };
        out.push(format!(
            "Watching for changes failed ({why}), so the index is rescanned every 10 minutes instead.{linux}"
        ));
    }
    // The service stops on the same files.toml error, and doctor can't tell which port it was given.
    if roots_known && f.logged_in && !f.serve_running {
        match (&f.service_unit, f.service_loaded) {
            (None, _) => out.push(
                "Other devices can't reach this one: run `polycarp files service install`, then the start command it prints.".into(),
            ),
            (Some(_), Some(true)) => out.push(
                "The files service is loaded but not answering: run `polycarp files fix` to restart it.".into(),
            ),
            (Some(unit), _) => out.push(format!(
                "The files service is written but not started: run `{}`.",
                service::start_cmd(Os::current(), std::path::Path::new(unit))
            )),
        }
    }
    for p in &f.peers {
        match (p.reachable, &p.version) {
            (Some(false), _) => out.push(format!(
                "{} does not answer on port {}: on {}, run `polycarp files doctor`.",
                p.name, f.port, p.name
            )),
            (Some(true), Some(v)) if *v != f.version => out.push(format!(
                "{} runs polycarp {v}, this device {}: update the older one with `polycarp update`.",
                p.name, f.version
            )),
            _ => {}
        }
    }
    out
}

/// What `fix` does on its own: only safe steps. Installing a service or starting Tailscale stays a hint.
pub fn fix_plan(f: &Facts) -> Vec<Action> {
    let mut plan = Vec::new();
    // With files.toml broken the roots are unknown: indexing the defaults could pull in folders the owner left out.
    if f.config_error.is_some() {
        return plan;
    }
    if f.index_files.is_none() || f.index_stale {
        plan.push(Action::Reindex);
    }
    if f.logged_in && !f.serve_running && f.service_unit.is_some() && f.service_loaded == Some(true)
    {
        plan.push(Action::RestartService);
    }
    plan
}

/// Looks at everything. `tailnet` is None when Tailscale is not installed.
pub fn gather(cfg: &Config, tailscale: Option<(String, Arc<dyn Tailnet>)>) -> Facts {
    let mut f = Facts {
        port: cfg.port(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        allow_save: cfg.allow_save,
        ..Facts::default()
    };
    let roots = cfg.roots();
    f.roots = roots.iter().map(|r| r.path.display().to_string()).collect();
    f.missing_roots = roots
        .iter()
        .filter(|r| !r.path.is_dir())
        .map(|r| r.path.display().to_string())
        .collect();
    if let Ok(p) = cfg.index_path() {
        f.index_path = p.display().to_string();
        if let Ok(info) = Index::open_read(&p).and_then(|i| i.info()) {
            f.index_files = Some(info.files);
            f.unreadable = info.unreadable;
            f.watch = info.watch;
            f.index_bytes = Some(info.bytes);
            f.index_age_secs = info.last_full.map(|t| index::now_secs() - t);
            f.index_stale = f.index_age_secs.is_none_or(|a| a > cfg.stale_secs() as i64);
        }
    }
    let os = Os::current();
    if let Some(home) = crate::home() {
        let local = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);
        let unit = service::unit_path(os, &home, local.as_deref());
        if unit.is_file() {
            f.service_unit = Some(unit.display().to_string());
            f.service_loaded = service::query_argv(os, service::uid()).map(|(prog, args)| {
                let a: Vec<&str> = args.iter().map(String::as_str).collect();
                super::tailnet::run_for(&prog, &a, Duration::from_secs(5)).is_ok()
            });
        }
    }
    let Some((path, tn)) = tailscale else {
        return f;
    };
    f.tailscale = Some(path);
    let status = match tn.status() {
        Ok(s) => s,
        Err(e) => {
            f.backend = e;
            return f;
        }
    };
    f.backend = status.backend.clone();
    f.logged_in = status.running();
    if let Some(me) = &status.me {
        f.device = Some(me.name.clone());
        f.ips = me.ips.iter().map(|i| i.to_string()).collect();
        if let Some(t) = fleet::target_of(me, cfg.port()) {
            match fleet::remote_health(&t, Duration::from_secs(2)) {
                Ok(_) => f.serve_running = true,
                Err(e) => f.serve_error = Some(e),
            }
        }
    }
    f.peers = probe_peers(&status, cfg);
    f
}

fn probe_peers(status: &Status, cfg: &Config) -> Vec<Peer> {
    let Some(me) = &status.me else {
        return Vec::new();
    };
    let mine: Vec<_> = status
        .peers
        .iter()
        .filter(|p| p.same_owner(me))
        .filter(|p| cfg.allow_devices.is_empty() || cfg.allow_devices.iter().any(|d| p.is_named(d)))
        .collect();
    let targets: Vec<Target> = mine
        .iter()
        .filter(|p| p.online)
        .filter_map(|p| fleet::target_of(p, cfg.port()))
        .collect();
    let answers = fleet::fan_out(
        &targets,
        Duration::from_secs(3),
        Arc::new(|t: &Target| fleet::remote_health(t, Duration::from_millis(2500))),
    );
    mine.iter()
        .map(|p| {
            let got = answers.iter().find(|(t, _)| t.name == p.name);
            let mut peer = Peer {
                name: p.name.clone(),
                os: p.os.clone(),
                online: p.online,
                ..Peer::default()
            };
            if let Some((_, r)) = got {
                match r {
                    Ok(h) => {
                        peer.reachable = Some(true);
                        peer.version = h["version"].as_str().map(str::to_string);
                    }
                    Err(e) => {
                        peer.reachable = Some(false);
                        peer.error = Some(e.clone());
                    }
                }
            }
            peer
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up() -> Facts {
        Facts {
            tailscale: Some("/usr/local/bin/tailscale".into()),
            backend: "Running".into(),
            logged_in: true,
            device: Some("mac".into()),
            port: 41771,
            version: "0.1.0".into(),
            serve_running: true,
            index_files: Some(10),
            index_age_secs: Some(60),
            ..Facts::default()
        }
    }

    #[test]
    fn a_healthy_device_needs_nothing() {
        let f = up();
        assert!(f.healthy());
        assert!(fixes(&f).is_empty());
        assert!(fix_plan(&f).is_empty());
    }

    #[test]
    fn fix_reindexes_and_restarts_only_a_loaded_service() {
        let mut f = up();
        f.index_stale = true;
        f.serve_running = false;
        assert_eq!(
            fix_plan(&f),
            vec![Action::Reindex],
            "no unit: nothing to restart"
        );
        f.service_unit = Some("/h/Library/LaunchAgents/com.polycarp.files.plist".into());
        f.service_loaded = Some(false);
        assert_eq!(
            fix_plan(&f),
            vec![Action::Reindex],
            "written but not loaded: a hint"
        );
        assert!(fixes(&f).iter().any(|l| l.contains("not started")));
        f.service_loaded = Some(true);
        assert_eq!(fix_plan(&f), vec![Action::Reindex, Action::RestartService]);
        f.logged_in = false;
        assert_eq!(
            fix_plan(&f),
            vec![Action::Reindex],
            "Tailscale down: serve can't bind"
        );
    }

    #[test]
    fn a_broken_files_toml_plans_nothing_and_sends_no_one_to_fix() {
        let mut f = up();
        f.config_error = Some("unknown field `alow_save`".into());
        f.index_files = None;
        f.serve_running = false;
        f.service_unit = Some("/h/Library/LaunchAgents/com.polycarp.files.plist".into());
        f.service_loaded = Some(true);
        assert!(fix_plan(&f).is_empty());
        let lines = fixes(&f);
        assert!(lines[0].starts_with("files.toml: "), "{lines:?}");
        // Only the files.toml line: no index, fix or service steps, whatever state the service is in.
        assert_eq!(lines.len(), 1, "{lines:?}");
        for (unit, loaded) in [(None, None), (f.service_unit.clone(), Some(false))] {
            f.service_unit = unit;
            f.service_loaded = loaded;
            assert_eq!(fixes(&f).len(), 1, "{:?}", fixes(&f));
        }
        f.index_files = Some(3);
        f.index_stale = true;
        assert!(fix_plan(&f).is_empty());
        assert!(!fixes(&f).iter().any(|l| l.contains("files fix")));
    }

    #[test]
    fn hints_name_the_unreachable_and_the_older_peer() {
        let mut f = up();
        f.peers = vec![
            Peer {
                name: "parish1".into(),
                online: true,
                reachable: Some(false),
                ..Peer::default()
            },
            Peer {
                name: "chapel1".into(),
                online: true,
                reachable: Some(true),
                version: Some("0.0.9".into()),
                ..Peer::default()
            },
        ];
        let h = fixes(&f).join("\n");
        assert!(h.contains("parish1 does not answer on port 41771"), "{h}");
        assert!(h.contains("chapel1 runs polycarp 0.0.9"), "{h}");
    }
}
