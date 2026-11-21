//! The owner's other devices: found with `tailscale status`, asked in parallel, each with a short time limit.

use super::http;
use super::index::Hit;
use super::tailnet::{Node, Status};
use serde_json::Value as Json;
use std::net::SocketAddr;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub name: String,
    pub addr: SocketAddr,
}

/// The peers worth asking: online, owned by the same user as this node, in `allow_devices` when that is set.
/// IPv4 first, since every node has one.
pub fn targets(status: &Status, allow: &[String], port: u16) -> Vec<Target> {
    let Some(me) = &status.me else {
        return Vec::new();
    };
    status
        .peers
        .iter()
        .filter(|p| p.online && p.same_owner(me) && p.name != me.name)
        .filter(|p| allow.is_empty() || allow.iter().any(|d| p.is_named(d)))
        .filter_map(|p| target_of(p, port))
        .collect()
}

pub fn target_of(p: &Node, port: u16) -> Option<Target> {
    let ip = p
        .ips
        .iter()
        .find(|ip| ip.is_ipv4())
        .or_else(|| p.ips.first())?;
    Some(Target {
        name: p.name.clone(),
        addr: SocketAddr::new(*ip, port),
    })
}

/// A peer by name, among all peers of the same user (online or not, so the error can say which).
pub fn find_peer<'a>(status: &'a Status, name: &str) -> Result<&'a Node, String> {
    let me = status.me.as_ref().ok_or("Tailscale is not running here")?;
    let p = status
        .peers
        .iter()
        .find(|p| p.is_named(name))
        .ok_or_else(|| format!("no device named {name} in your tailnet"))?;
    if !me.personal() {
        return Err("this device is tagged, so it has no owner's devices to reach".into());
    }
    if !p.tags.is_empty() {
        return Err(format!("{} is a tagged device, not one of yours", p.name));
    }
    if !p.same_owner(me) {
        return Err(format!("{} belongs to another Tailscale user", p.name));
    }
    if !p.online {
        return Err(format!("{} is offline", p.name));
    }
    Ok(p)
}

pub type Ask<T> = Arc<dyn Fn(&Target) -> Result<T, String> + Send + Sync>;

/// Asks every target at once and waits at most `limit` in all. One that has not answered by then is reported as
/// timed out; it never holds the others back.
pub fn fan_out<T: Send + 'static>(
    targets: &[Target],
    limit: Duration,
    ask: Ask<T>,
) -> Vec<(Target, Result<T, String>)> {
    let (tx, rx) = mpsc::channel();
    for (i, t) in targets.iter().enumerate() {
        let tx = tx.clone();
        let t = t.clone();
        let ask = Arc::clone(&ask);
        std::thread::spawn(move || {
            let _ = tx.send((i, ask(&t)));
        });
    }
    drop(tx);
    let mut got: Vec<Option<Result<T, String>>> = targets.iter().map(|_| None).collect();
    let deadline = Instant::now() + limit;
    let mut left = targets.len();
    while left > 0 {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        match rx.recv_timeout(deadline - now) {
            Ok((i, r)) => {
                got[i] = Some(r);
                left -= 1;
            }
            Err(_) => break,
        }
    }
    targets
        .iter()
        .cloned()
        .zip(got)
        .map(|(t, r)| {
            let r =
                r.unwrap_or_else(|| Err(format!("no answer within {:.1}s", limit.as_secs_f64())));
            (t, r)
        })
        .collect()
}

/// Results from every device in one list, best match first, each still labeled with its device.
pub fn merge(lists: Vec<Vec<Hit>>, limit: usize) -> Vec<Hit> {
    let mut all: Vec<Hit> = lists.into_iter().flatten().collect();
    all.sort_by(|a, b| {
        a.score
            .total_cmp(&b.score)
            .then(b.modified.cmp(&a.modified))
    });
    all.truncate(limit);
    all
}

fn get_json(t: &Target, target: &str, limit: Duration) -> Result<Json, String> {
    let r = http::request(t.addr, "GET", target, None, limit)
        .map_err(|e| format!("{}: {e}", t.name))?;
    let v: Json = serde_json::from_slice(&r.body).map_err(|_| {
        format!(
            "{}: answered with something other than Polycarp Files",
            t.name
        )
    })?;
    if r.status != 200 || v["ok"] != Json::Bool(true) {
        return Err(format!(
            "{}: {}",
            t.name,
            v["error"]["message"].as_str().unwrap_or("refused")
        ));
    }
    Ok(v)
}

pub fn remote_search(
    t: &Target,
    q: &str,
    kind: Option<&str>,
    limit: usize,
    timeout: Duration,
) -> Result<Vec<Hit>, String> {
    let lim = limit.to_string();
    let mut pairs = vec![("q", q), ("limit", lim.as_str())];
    if let Some(k) = kind {
        pairs.push(("kind", k));
    }
    let v = get_json(
        t,
        &format!("/v1/search?{}", http::query_string(&pairs)),
        timeout,
    )?;
    let mut hits: Vec<Hit> = serde_json::from_value(v["data"]["results"].clone())
        .map_err(|e| format!("{}: bad results: {e}", t.name))?;
    for h in &mut hits {
        // Label with the name we asked, not the one it claims.
        h.device = Some(t.name.clone());
    }
    Ok(hits)
}

pub fn remote_health(t: &Target, timeout: Duration) -> Result<Json, String> {
    get_json(t, "/v1/health", timeout).map(|v| v["data"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(device: &str, name: &str, score: f64) -> Hit {
        Hit {
            device: Some(device.into()),
            id: 1,
            path: format!("/x/{name}"),
            name: name.into(),
            kind: "md".into(),
            size: 1,
            modified: 0,
            snippet: String::new(),
            score,
        }
    }

    #[test]
    fn a_peer_that_times_out_does_not_hold_back_the_rest() {
        let ts: Vec<Target> = ["fast", "slow"]
            .iter()
            .enumerate()
            .map(|(i, n)| Target {
                name: n.to_string(),
                addr: SocketAddr::from(([100, 64, 0, i as u8 + 1], 41771)),
            })
            .collect();
        let ask: Ask<Vec<Hit>> = Arc::new(|t: &Target| {
            if t.name == "slow" {
                std::thread::sleep(Duration::from_secs(3));
            }
            Ok(vec![hit(&t.name, "remote.md", -2.0)])
        });
        let start = Instant::now();
        let got = fan_out(&ts, Duration::from_millis(300), ask);
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "waited for the slow peer"
        );
        assert!(got[0].1.is_ok());
        assert!(got[1].1.as_ref().unwrap_err().contains("no answer"));
        let local = vec![hit("mac", "local.md", -1.0), hit("mac", "best.md", -5.0)];
        let remote: Vec<Vec<Hit>> = got.into_iter().filter_map(|(_, r)| r.ok()).collect();
        let merged = merge([vec![local], remote].concat(), 10);
        let names: Vec<_> = merged.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["best.md", "remote.md", "local.md"]);
        assert_eq!(merged[1].device.as_deref(), Some("fast"));
    }

    #[test]
    fn only_online_peers_of_the_same_user_are_asked() {
        use super::super::tailnet::parse_status;
        let s = parse_status(r#"{"BackendState":"Running",
            "Self":{"DNSName":"mac.t.ts.net.","TailscaleIPs":["100.64.0.1"],"UserID":7,"Online":true},
            "Peer":{
              "a":{"DNSName":"parish1.t.ts.net.","TailscaleIPs":["100.64.0.2","fd7a:115c:a1e0::2"],"UserID":7,"Online":true},
              "b":{"DNSName":"friend.t.ts.net.","TailscaleIPs":["100.64.0.3"],"UserID":9,"Online":true},
              "c":{"DNSName":"chapel1.t.ts.net.","TailscaleIPs":["100.64.0.4"],"UserID":7,"Online":false}}}"#).unwrap();
        let t = targets(&s, &[], 41771);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].name, "parish1");
        assert_eq!(t[0].addr, "100.64.0.2:41771".parse().unwrap());
        assert!(targets(&s, &["chapel1".into()], 41771).is_empty());
        assert!(find_peer(&s, "friend").unwrap_err().contains("another"));
        assert!(find_peer(&s, "chapel1").unwrap_err().contains("offline"));
        assert!(find_peer(&s, "PARISH1").is_ok());
    }

    #[test]
    fn tagged_peers_and_a_tagged_self_ask_no_one() {
        use super::super::tailnet::parse_status;
        let s = parse_status(r#"{"BackendState":"Running",
            "Self":{"DNSName":"mac.t.ts.net.","TailscaleIPs":["100.64.0.1"],"UserID":7,"Online":true},
            "Peer":{"a":{"DNSName":"ci.t.ts.net.","TailscaleIPs":["100.64.0.2"],"UserID":7,"Online":true,"Tags":["tag:ci"]}}}"#).unwrap();
        assert!(targets(&s, &[], 41771).is_empty(), "tagged peer");
        assert!(find_peer(&s, "ci").is_err());
        let s = parse_status(r#"{"BackendState":"Running",
            "Self":{"DNSName":"srv.t.ts.net.","TailscaleIPs":["100.64.0.1"],"UserID":42,"Online":true,"Tags":["tag:server"]},
            "Peer":{"a":{"DNSName":"box.t.ts.net.","TailscaleIPs":["100.64.0.2"],"UserID":42,"Online":true}}}"#).unwrap();
        assert!(targets(&s, &[], 41771).is_empty(), "tagged self");
        assert!(find_peer(&s, "box").is_err());
    }
}
