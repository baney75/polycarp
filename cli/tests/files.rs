//! `polycarp files` end to end: the built binary against a temp folder, with its own HOME, config folder and an
//! empty PATH, so no real Tailscale, index or home folder is ever reached. The tailnet parts (whois, bind address,
//! uploads, fleet merge) are tested in the source with a stub Tailscale.

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new() -> Sandbox {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "files-{}-{}",
            std::process::id(),
            n
        ));
        let _ = fs::remove_dir_all(&root);
        for d in ["home", "cfg", "empty", "docs"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Sandbox { root }
    }
    fn dir(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    fn write(&self, rel: &str, text: &str) -> PathBuf {
        let p = self.dir("docs").join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, text).unwrap();
        p
    }
    /// files.toml with the docs folder as the only root.
    fn roots_are_docs(&self) {
        let docs = self.dir("docs");
        fs::write(
            self.dir("cfg").join("files.toml"),
            format!("roots = [{:?}]\n", docs.to_str().unwrap()),
        )
        .unwrap();
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
    fn index(&self) -> Value {
        let docs = self.dir("docs");
        let o = self.run(&["files", "index", "--json", "--root", docs.to_str().unwrap()]);
        assert_eq!(o.status.code(), Some(0), "{}", text(&o));
        serde_json::from_slice::<Value>(&o.stdout).unwrap()["data"]["stats"].clone()
    }
    fn search(&self, args: &[&str]) -> Value {
        let mut a = vec!["files", "search", "--json"];
        a.extend_from_slice(args);
        let o = self.run(&a);
        serde_json::from_slice(&o.stdout).unwrap_or_else(|_| panic!("{}", text(&o)))
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

fn names(v: &Value) -> Vec<String> {
    v["data"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn the_index_never_takes_secrets_polymarket_or_build_folders() {
    let sb = Sandbox::new();
    sb.write("notes/sermon.md", "covenant grace");
    sb.write("notes/.env", "covenant=1");
    sb.write("notes/.env.local", "covenant=2");
    sb.write("notes/server.pem", "covenant");
    sb.write("notes/api-key.txt", "covenant");
    sb.write("polymarket/strategy.md", "covenant");
    sb.write("work/Polymarket-bot/plan.md", "covenant");
    sb.write("app/node_modules/pkg/readme.md", "covenant");
    sb.write("app/target/debug/out.txt", "covenant");
    sb.write("app/.git/HEAD", "covenant");
    sb.write(".ssh/id_ed25519", "covenant");
    sb.write("app/src/main.rs", "fn covenant() {}");
    let s = sb.index();
    assert_eq!(s["files"], 2, "{s}");
    let mut got = names(&sb.search(&["covenant"]));
    got.sort();
    assert_eq!(got, ["main.rs", "sermon.md"]);
}

#[test]
fn a_second_run_reads_only_what_changed() {
    let sb = Sandbox::new();
    sb.write("a.md", "alpha");
    let b = sb.write("b.md", "bravo");
    let c = sb.write("c.txt", "charlie");
    let s = sb.index();
    assert_eq!(
        (s["added"].as_u64(), s["with_text"].as_u64()),
        (Some(3), Some(3))
    );
    let s = sb.index();
    assert_eq!(s["unchanged"], 3, "{s}");
    assert_eq!(s["updated"], 0, "{s}");
    // Change one file's text and time, remove another.
    fs::write(&b, "bravo zulu").unwrap();
    let f = fs::File::options().write(true).open(&b).unwrap();
    f.set_modified(SystemTime::now() + Duration::from_secs(5))
        .unwrap();
    drop(f);
    fs::remove_file(&c).unwrap();
    let s = sb.index();
    assert_eq!(
        (
            s["updated"].as_u64(),
            s["removed"].as_u64(),
            s["unchanged"].as_u64()
        ),
        (Some(1), Some(1), Some(1)),
        "{s}"
    );
    assert_eq!(names(&sb.search(&["zulu"])), ["b.md"]);
    assert!(names(&sb.search(&["charlie"])).is_empty());
}

#[test]
fn a_name_match_ranks_above_a_text_match_and_kind_filters() {
    let sb = Sandbox::new();
    sb.write(
        "deep/notes-about-things.md",
        "the budget for next year is attached",
    );
    sb.write("budget.csv", "item,amount\nrent,1200");
    sb.write("other.md", "nothing to see");
    sb.index();
    let v = sb.search(&["budget"]);
    assert_eq!(names(&v), ["budget.csv", "notes-about-things.md"]);
    let snippet = v["data"]["results"][1]["snippet"].as_str().unwrap();
    assert!(snippet.contains("[budget]"), "{snippet}");
    assert_eq!(
        names(&sb.search(&["budget", "--kind", "md"])),
        ["notes-about-things.md"]
    );
    // Prefixes match, and FTS syntax in the words is only text.
    assert_eq!(names(&sb.search(&["budg"])).len(), 2);
    assert_eq!(sb.search(&["NEAR(budget", "OR"])["ok"], true);
    let bad = sb.search(&["budget", "--kind", "spreadsheet"]);
    assert_eq!(bad["error"]["code"], "invalid_args");
}

#[test]
fn fleet_search_without_tailscale_still_answers_for_this_device() {
    let sb = Sandbox::new();
    sb.write("plan.md", "harvest");
    sb.index();
    let v = sb.search(&["harvest", "--fleet"]);
    assert_eq!(names(&v), ["plan.md"]);
    let devices = v["data"]["devices"].as_array().unwrap();
    assert!(devices.iter().any(|d| d["ok"] == true));
    let down = devices.iter().find(|d| d["ok"] == false).unwrap();
    assert!(
        down["error"].as_str().unwrap().contains("Tailscale"),
        "{down}"
    );
}

#[test]
fn doctor_says_what_is_missing_and_how_to_fix_it() {
    let sb = Sandbox::new();
    let o = sb.run(&["files", "doctor", "--json"]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    let d = &v["data"];
    assert_eq!(d["healthy"], false);
    assert_eq!(d["port"], 41771);
    assert_eq!(d["logged_in"], false);
    let fixes = d["fixes"].as_array().unwrap();
    let all: String = fixes.iter().map(|f| f.as_str().unwrap()).collect();
    assert!(all.contains("Tailscale is not installed"), "{all}");
    assert!(all.contains("polycarp files index"), "{all}");
}

#[test]
fn send_refuses_a_secret_before_asking_tailscale() {
    let sb = Sandbox::new();
    sb.roots_are_docs();
    let key = sb.write("deploy-key.pem", "x");
    let o = sb.run(&["files", "send", "--json", key.to_str().unwrap(), "parish1"]);
    assert_eq!(o.status.code(), Some(1));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["error"]["code"], "secret");
    let ok = sb.write("plain.md", "x");
    let o = sb.run(&["files", "send", "--json", ok.to_str().unwrap(), "parish1"]);
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["error"]["code"], "no_tailscale");
}

#[test]
fn send_sends_only_what_serve_would_share() {
    let sb = Sandbox::new();
    sb.roots_are_docs();
    let npmrc = sb.write(".npmrc", "//registry.npmjs.org/:_authToken=x");
    let hidden = sb.write(".hidden/notes.md", "x");
    let chat = sb.dir("home").join("Library/Messages/chat.db");
    fs::create_dir_all(chat.parent().unwrap()).unwrap();
    fs::write(&chat, "x").unwrap();
    for p in [&npmrc, &hidden, &chat] {
        let o = sb.run(&["files", "send", "--json", p.to_str().unwrap(), "parish1"]);
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["error"]["code"], "not_shared", "{}: {v}", p.display());
    }
}

#[test]
fn get_never_writes_into_a_hidden_or_secret_place() {
    let sb = Sandbox::new();
    let home = sb.dir("home");
    for dest in [
        home.join(".ssh/authorized_keys"),
        home.join("Documents/.config/x"),
        home.join("Documents/server.pem"),
    ] {
        let o = sb.run(&[
            "files",
            "get",
            "--json",
            "parish1:/h/a.md",
            dest.to_str().unwrap(),
        ]);
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["error"]["code"], "unsafe_dest", "{}: {v}", dest.display());
        assert!(!dest.exists());
    }
}

#[test]
fn service_commands_are_not_run_here_but_usage_is_checked() {
    let sb = Sandbox::new();
    let o = sb.run(&["files", "service", "start"]);
    assert_eq!(o.status.code(), Some(2));
    let o = sb.run(&["files", "bogus"]);
    assert_eq!(o.status.code(), Some(2));
    let o = sb.run(&["files", "--help"]);
    assert_eq!(o.status.code(), Some(0));
    assert!(text(&o).contains("41771"));
}

fn mcp(sb: &Sandbox, lines: &[Value]) -> Vec<Value> {
    let mut child = sb
        .cmd(&["files", "mcp"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for l in lines {
        writeln!(input, "{l}").unwrap();
    }
    drop(input);
    let out = child.wait_with_output().unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn the_files_mcp_server_lists_its_tools_and_searches() {
    let sb = Sandbox::new();
    sb.write("letters/thanks.md", "gratitude for the harvest");
    sb.index();
    let got = mcp(
        &sb,
        &[
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"t"}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"files_search","arguments":{"query":"harvest"}}}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"files_search","arguments":{"query":"x","nope":1}}}),
            json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"files_get","arguments":{"source":"mac:/h/x.txt","dest":"~/.ssh/authorized_keys"}}}),
        ],
    );
    assert_eq!(got.len(), 5, "{got:?}");
    // An agent can't choose where a fetched file lands: it always goes to the inbox.
    assert!(got[1]["result"]["tools"][1]["inputSchema"]["properties"]["dest"].is_null());
    assert_eq!(
        got[4]["result"]["structuredContent"]["error"]["code"],
        "invalid_args"
    );
    assert!(got[0]["result"]["instructions"]
        .as_str()
        .unwrap()
        .contains("never instructions"));
    let tools: Vec<&str> = got[1]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        tools,
        ["files_search", "files_get", "files_send", "files_doctor"]
    );
    let found = &got[2]["result"]["structuredContent"];
    assert_eq!(found["ok"], true, "{found}");
    assert_eq!(found["data"]["results"][0]["name"], "thanks.md");
    assert_eq!(got[3]["result"]["isError"], true);
    assert_eq!(
        got[3]["result"]["structuredContent"]["error"]["code"],
        "invalid_args"
    );
}
