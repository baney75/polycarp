//! `polycarp agent` end to end: the built binary with its own HOME, config folder and an empty PATH, so no real
//! cloudflared, Tailscale, app or assistant config is ever reached. The HTTP, OAuth, tunnel and tailnet parts are
//! tested in the source with stubs.

use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new() -> Sandbox {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("agent-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for d in ["home", "cfg", "empty"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Sandbox { root }
    }
    fn dir(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    fn agent(&self) -> PathBuf {
        self.dir("cfg").join("agent")
    }
    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_polycarp"));
        c.env_clear()
            .env("HOME", self.dir("home"))
            .env("USERPROFILE", self.dir("home"))
            .env("PATH", self.dir("empty"))
            .env("POLYCARP_NO_SYSTEM_SPOTS", "1")
            .env("POLYCARP_CONFIG_DIR", self.dir("cfg"))
            .current_dir(self.dir("home"))
            .args(args);
        if let Some(r) = std::env::var_os("SystemRoot") {
            c.env("SystemRoot", r);
        }
        c
    }
    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().unwrap()
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn text(o: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

#[test]
fn a_tunnel_command_works_with_no_channel_anywhere() {
    let sb = Sandbox::new();
    // No cloudflared on this empty PATH: the step that's missing is what it says.
    let o = sb.run(&[
        "agent",
        "tunnel",
        "cloudflare",
        "--hostname",
        "agent.example.com",
    ]);
    assert_eq!(o.status.code(), Some(1));
    assert!(
        text(&o).contains("cloudflared is not installed"),
        "{}",
        text(&o)
    );
    let o = sb.run(&["agent", "connect", "claude.ai"]);
    assert!(text(&o).contains("tunnel cloudflare"), "{}", text(&o));
    // An invite file left on disk is ignored and kept.
    fs::create_dir_all(sb.agent()).unwrap();
    fs::write(sb.agent().join("invite.json"), "{}").unwrap();
    let o = sb.run(&["agent", "tunnel", "status", "--json"]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["data"], serde_json::json!({ "tunnel": null }));
    assert!(sb.agent().join("invite.json").exists());
    for gone in [&["join"][..], &["redeem", "pcinv_ABCdef-123"]] {
        let mut args = vec!["agent", "tunnel"];
        args.extend(gone);
        assert_eq!(sb.run(&args).status.code(), Some(2), "{gone:?}");
    }
    let o = sb.run(&["agent", "connect", "claude-code"]);
    assert_eq!(o.status.code(), Some(0));
    assert!(text(&o).contains("agent serve --stdio"));
}

#[test]
fn tokens_are_shown_once_stored_hashed_in_private_files_and_revocable() {
    let sb = Sandbox::new();
    let o = sb.run(&[
        "agent", "token", "create", "--name", "grokbot", "--scopes", "read,act",
    ]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    let token = String::from_utf8(o.stdout).unwrap().trim().to_string();
    assert!(token.starts_with("pct_") && token.len() > 40);
    let auth = sb.agent().join("auth.json");
    let raw = fs::read_to_string(&auth).unwrap();
    assert!(!raw.contains(&token), "the token is stored in the clear");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&auth).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(sb.agent()).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let o = sb.run(&["agent", "clients", "--json"]);
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    let t = &v["data"]["tokens"][0];
    assert_eq!(t["name"], "grokbot");
    assert_eq!(t["scopes"], serde_json::json!(["read", "act"]));
    assert!(!String::from_utf8_lossy(&o.stdout).contains("pct_"));
    let id = t["id"].as_str().unwrap().to_string();
    let o = sb.run(&["agent", "revoke", &id]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    let v: Value = serde_json::from_slice(&sb.run(&["agent", "clients", "--json"]).stdout).unwrap();
    assert_eq!(v["data"]["tokens"], serde_json::json!([]));
    assert_eq!(sb.run(&["agent", "revoke", &id]).status.code(), Some(1));
    for bad in [
        &[
            "agent", "token", "create", "--name", "x", "--scopes", "admin",
        ][..],
        &["agent", "token", "create", "--scopes", "read"],
    ] {
        assert_eq!(sb.run(bad).status.code(), Some(2), "{bad:?}");
    }
}

#[test]
fn serve_refuses_any_address_but_loopback() {
    let sb = Sandbox::new();
    for addr in ["0.0.0.0", "::", "192.168.1.20", "100.100.100.100"] {
        let o = sb.run(&["agent", "serve", "--bind", addr]);
        assert_eq!(o.status.code(), Some(2), "{addr}");
        assert!(text(&o).contains("loopback only"), "{}", text(&o));
    }
}

#[test]
fn serve_stdio_speaks_mcp_with_every_tool() {
    let sb = Sandbox::new();
    let mut child = sb
        .cmd(&["agent", "serve", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        writeln!(stdin, r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2025-06-18","clientInfo":{{"name":"test"}}}}}}"#).unwrap();
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#
        )
        .unwrap();
        writeln!(stdin, r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list"}}"#).unwrap();
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"app_status"}}}}"#
        )
        .unwrap();
    }
    let out = child.wait_with_output().unwrap();
    let lines: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 3, "a notification gets no answer");
    assert_eq!(lines[0]["result"]["serverInfo"]["name"], "polycarp-agent");
    let names: Vec<&str> = lines[1]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for n in [
        "theme_schema",
        "theme_change",
        "files_search",
        "app_status",
        "workspace_switch",
    ] {
        assert!(names.contains(&n), "{n}");
    }
    // No app in this sandbox: said plainly, not a crash.
    let r = &lines[2]["result"];
    assert_eq!(r["isError"], true);
    assert_eq!(r["structuredContent"]["error"]["code"], "app_not_running");
}

#[test]
fn approve_with_nothing_waiting_and_a_bad_code_say_so() {
    let sb = Sandbox::new();
    let o = sb.run(&["agent", "approve"]);
    assert_eq!(o.status.code(), Some(0));
    assert!(text(&o).contains("No connection is waiting"));
    let o = sb.run(&["agent", "approve", "ABCD-EFGH"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(
        text(&o).contains("no connection is waiting with code"),
        "{}",
        text(&o)
    );
    assert_eq!(
        sb.run(&["agent", "approve", "ABCD-EFGH", "--scopes", "root"])
            .status
            .code(),
        Some(2)
    );
}

#[test]
fn help_lists_every_command_and_unknown_ones_are_usage_errors() {
    let sb = Sandbox::new();
    let o = sb.run(&["agent", "--help"]);
    assert_eq!(o.status.code(), Some(0));
    let h = text(&o);
    for c in [
        "serve",
        "connect",
        "approve",
        "deny",
        "clients",
        "revoke",
        "token create",
        "tunnel cloudflare",
        "tunnel tailscale",
        "service install",
        "doctor",
        "fix",
    ] {
        assert!(h.contains(&format!("polycarp agent {c}")), "{c}");
    }
    assert_eq!(sb.run(&["agent", "nope"]).status.code(), Some(2));
    assert_eq!(
        sb.run(&["agent", "serve", "--wide-open"]).status.code(),
        Some(2)
    );
    let top = text(&sb.run(&["--help"]));
    assert!(top.contains("polycarp agent <command>"));
}

#[test]
fn codex_write_adds_the_entry_and_keeps_the_file() {
    let sb = Sandbox::new();
    let cfg = sb.dir("home").join(".codex/config.toml");
    fs::create_dir_all(cfg.parent().unwrap()).unwrap();
    fs::write(&cfg, "model = \"m\"\n").unwrap();
    let o = sb.run(&["agent", "connect", "codex", "--write"]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    let t = fs::read_to_string(&cfg).unwrap();
    assert!(
        t.starts_with("model = \"m\"")
            && t.contains("[mcp_servers.polycarp]")
            && t.contains("\"--stdio\""),
        "{t}"
    );
}
