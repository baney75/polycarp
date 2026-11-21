//! Everything this feature asks Tailscale, behind a trait so tests run without it. The real one runs the
//! `tailscale` command (found like every other tool: never from the current folder, never through a shell).

use serde_json::Value as Json;
use std::env;
use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// One node of the tailnet.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    /// The short MagicDNS name (`parish1`), lowercase.
    pub name: String,
    /// The full MagicDNS name without the final dot.
    pub dns: String,
    pub ips: Vec<IpAddr>,
    /// The Tailscale user that owns it. Tagged nodes have the tagged-devices user.
    pub user: i64,
    pub online: bool,
    pub os: String,
}

impl Node {
    /// True when `wanted` names this node: its short name or full MagicDNS name, without case.
    pub fn is_named(&self, wanted: &str) -> bool {
        let w = wanted.trim().trim_end_matches('.').to_lowercase();
        !w.is_empty() && (w == self.name || w == self.dns.to_lowercase())
    }
}

#[derive(Debug, Clone, Default)]
pub struct Status {
    /// Tailscale's BackendState: Running when up and logged in.
    pub backend: String,
    pub me: Option<Node>,
    pub peers: Vec<Node>,
}

impl Status {
    pub fn running(&self) -> bool {
        self.backend == "Running" && self.me.is_some()
    }
}

/// What the files feature needs from the local Tailscale daemon.
pub trait Tailnet: Send + Sync {
    fn status(&self) -> Result<Status, String>;
    /// The node behind a connection's source address.
    fn whois(&self, addr: SocketAddr) -> Result<Node, String>;
}

fn short_name(dns: &str, host: &str) -> String {
    let first = dns.split('.').next().unwrap_or_default();
    if first.is_empty() { host } else { first }.to_lowercase()
}

fn ips(v: &Json) -> Vec<IpAddr> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str())
        .filter_map(|s| s.split('/').next()?.parse().ok())
        .collect()
}

fn node_of_status(v: &Json) -> Node {
    let dns = v["DNSName"]
        .as_str()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_string();
    Node {
        name: short_name(&dns, v["HostName"].as_str().unwrap_or_default()),
        dns,
        ips: ips(&v["TailscaleIPs"]),
        user: v["UserID"].as_i64().unwrap_or(-1),
        online: v["Online"].as_bool().unwrap_or(false),
        os: v["OS"].as_str().unwrap_or_default().to_string(),
    }
}

/// `tailscale status --json`.
pub fn parse_status(text: &str) -> Result<Status, String> {
    let v: Json =
        serde_json::from_str(text).map_err(|e| format!("tailscale status: bad JSON: {e}"))?;
    let me = v.get("Self").filter(|s| s.is_object()).map(node_of_status);
    let mut peers: Vec<Node> = v["Peer"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .map(node_of_status)
        .collect();
    peers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Status {
        backend: v["BackendState"].as_str().unwrap_or_default().to_string(),
        me,
        peers,
    })
}

/// `tailscale whois --json <ip:port>`.
pub fn parse_whois(text: &str) -> Result<Node, String> {
    let v: Json =
        serde_json::from_str(text).map_err(|e| format!("tailscale whois: bad JSON: {e}"))?;
    let n = &v["Node"];
    let user = n["User"]
        .as_i64()
        .or_else(|| v["UserProfile"]["ID"].as_i64())
        .ok_or("tailscale whois: no owner in the answer")?;
    let dns = n["Name"]
        .as_str()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_string();
    let host = n["Hostinfo"]["Hostname"]
        .as_str()
        .or(n["ComputedName"].as_str())
        .unwrap_or_default();
    Ok(Node {
        name: short_name(&dns, host),
        dns,
        ips: ips(&n["Addresses"]),
        user,
        online: true,
        os: n["Hostinfo"]["OS"].as_str().unwrap_or_default().to_string(),
    })
}

/// Where the `tailscale` command is: POLYCARP_TAILSCALE, the Mac app's own copy, PATH, then the usual spots. Each
/// candidate passes the same gate as every other tool.
pub fn find_tailscale() -> Option<PathBuf> {
    if let Some(v) = env::var_os("POLYCARP_TAILSCALE").filter(|v| !v.is_empty()) {
        let p = PathBuf::from(v);
        return crate::check(&p).ok().map(|()| p);
    }
    let exe = if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    };
    let mut cands: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        cands.extend(crate::spot_path(
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ));
    }
    if let Some(path) = env::var_os("PATH") {
        cands.extend(env::split_paths(&path).map(|d| d.join(exe)));
    }
    for spot in [
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/bin/tailscale",
        "C:\\Program Files\\Tailscale\\tailscale.exe",
    ] {
        cands.extend(crate::spot_path(spot));
    }
    cands.into_iter().find(|c| crate::check(c).is_ok())
}

/// Runs a program with a time limit and returns its stdout. Never through a shell.
pub fn run_for(program: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", program.display()))?;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut o = String::new();
        let mut e = String::new();
        if let Some(s) = out.as_mut() {
            let _ = s.read_to_string(&mut o);
        }
        if let Some(s) = err.as_mut() {
            let _ = s.read_to_string(&mut e);
        }
        (o, e)
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{} took longer than {}s",
                    program.display(),
                    limit.as_secs()
                ));
            }
        }
    };
    let (o, e) = reader.join().unwrap_or_default();
    if status.success() {
        Ok(o)
    } else {
        let msg = e.lines().next().unwrap_or("").trim().to_string();
        Err(if msg.is_empty() {
            format!("{} failed ({status})", program.display())
        } else {
            msg
        })
    }
}

/// The real tailnet: the `tailscale` command.
pub struct Cli {
    pub bin: PathBuf,
}

impl Cli {
    pub fn find() -> Result<Cli, String> {
        find_tailscale().map(|bin| Cli { bin }).ok_or_else(|| {
            "Tailscale is not installed here (no `tailscale` command found)".to_string()
        })
    }

    /// Taildrop: `tailscale file cp <path> <device>:`.
    pub fn file_cp(&self, path: &Path, device: &str) -> Result<(), String> {
        let p = path.to_string_lossy();
        let target = format!("{device}:");
        run_for(
            &self.bin,
            &["file", "cp", &p, &target],
            Duration::from_secs(600),
        )
        .map(|_| ())
    }

    /// Taildrop: moves waiting files into `dir`, renaming on a clash.
    pub fn file_get(&self, dir: &Path) -> Result<(), String> {
        let d = dir.to_string_lossy();
        run_for(
            &self.bin,
            &["file", "get", "--conflict=rename", &d],
            Duration::from_secs(600),
        )
        .map(|_| ())
    }
}

impl Tailnet for Cli {
    fn status(&self) -> Result<Status, String> {
        let text = run_for(&self.bin, &["status", "--json"], Duration::from_secs(10))?;
        parse_status(&text)
    }
    fn whois(&self, addr: SocketAddr) -> Result<Node, String> {
        let a = addr.to_string();
        let text = run_for(&self.bin, &["whois", "--json", &a], Duration::from_secs(5))?;
        parse_whois(&text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_whois_parse_the_fields_used() {
        let s = parse_status(r#"{"BackendState":"Running",
            "Self":{"DNSName":"chapel1.tail1.ts.net.","HostName":"Chapel1","TailscaleIPs":["100.1.2.3","fd7a:115c:a1e0::1"],"UserID":7,"Online":true,"OS":"linux"},
            "Peer":{"k":{"DNSName":"parish1.tail1.ts.net.","HostName":"parish1","TailscaleIPs":["100.1.2.4"],"UserID":7,"Online":false,"OS":"linux"}}}"#).unwrap();
        assert!(s.running());
        let me = s.me.unwrap();
        assert_eq!(me.name, "chapel1");
        assert_eq!(me.ips.len(), 2);
        assert_eq!(s.peers[0].name, "parish1");
        assert!(!s.peers[0].online);
        let w = parse_whois(r#"{"Node":{"Name":"mac.tail1.ts.net.","User":7,"Addresses":["100.1.2.5/32"],"Hostinfo":{"Hostname":"Mac","OS":"macOS"}},"UserProfile":{"ID":7}}"#).unwrap();
        assert_eq!((w.name.as_str(), w.user), ("mac", 7));
        assert!(w.is_named("MAC") && w.is_named("mac.tail1.ts.net.") && !w.is_named(""));
    }
}
