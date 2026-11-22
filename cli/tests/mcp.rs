//! Integration tests for `polycarp mcp`, run against the real binary over stdin and stdout.
//! Every run gets its own config folder through POLYCARP_CONFIG_DIR.

use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new() -> Sandbox {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "mcp-{}-{}",
            std::process::id(),
            n
        ));
        let _ = fs::remove_dir_all(&root);
        for d in ["home", "xdg", "appdata", "tmp"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Sandbox { root }
    }
    fn cfg(&self) -> PathBuf {
        self.root.join("cfg")
    }
    fn command(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_polycarp"));
        c.env_clear()
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("POLYCARP_CONFIG_DIR", self.root.join("cfg"))
            .env("TMPDIR", self.root.join("tmp"))
            .env("TEMP", self.root.join("tmp"))
            .env("TMP", self.root.join("tmp"));
        if let Some(r) = std::env::var_os("SystemRoot") {
            c.env("SystemRoot", r);
        }
        c
    }
    fn server(&self) -> Server {
        Sandbox::spawn(self.command())
    }
    fn spawn(mut cmd: Command) -> Server {
        let mut child = cmd
            .arg("mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Server {
            child,
            stdin,
            stdout,
            next: 1,
        }
    }
    /// `polycarp theme <args> --json`, parsed.
    fn cli(&self, args: &[&str]) -> Value {
        let mut a = vec!["theme"];
        a.extend_from_slice(args);
        a.push("--json");
        let o = self.command().args(a).output().unwrap();
        serde_json::from_slice(&o.stdout).unwrap()
    }
}

struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next: u64,
}

impl Server {
    fn send_raw(&mut self, line: &str) {
        let w = self.stdin.as_mut().unwrap();
        writeln!(w, "{line}").unwrap();
        w.flush().unwrap();
    }
    fn read(&mut self) -> Value {
        let mut line = String::new();
        let n = self.stdout.read_line(&mut line).unwrap();
        assert!(n > 0, "the server closed its output");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("not JSON ({e}): {line}"))
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.send_raw(
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string(),
        );
        let v = self.read();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], id, "{v}");
        v
    }
    fn initialize(&mut self, client: &str) -> Value {
        let v = self.request(
            "initialize",
            json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": client, "version": "1"}}),
        );
        self.send_raw(
            &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string(),
        );
        v
    }
    /// A tool call; returns the whole result object.
    fn tool(&mut self, name: &str, args: Value) -> Value {
        let v = self.request("tools/call", json!({"name": name, "arguments": args}));
        assert!(v.get("error").is_none(), "{name}: {v}");
        let r = v["result"].clone();
        // The text is the same envelope as the structured content.
        let text: Value = serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text, r["structuredContent"], "{name}");
        assert_eq!(r["content"][0]["type"], "text");
        r
    }
    fn finish(mut self) -> i32 {
        drop(self.stdin.take());
        self.child.wait().unwrap().code().unwrap()
    }
}

const TOOLS: [&str; 29] = [
    "theme_schema",
    "theme_list",
    "theme_current",
    "theme_show",
    "theme_get",
    "theme_set",
    "theme_change",
    "theme_change_many",
    "theme_apply",
    "theme_create",
    "theme_delete",
    "theme_accent",
    "theme_validate",
    "theme_preview",
    "theme_export",
    "theme_undo",
    "theme_history",
    "theme_off",
    "theme_on",
    "theme_reset",
    "surfaces_schema",
    "surfaces_get",
    "surfaces_set",
    "style_example",
    "style_get",
    "style_check",
    "style_set",
    "style_unset",
    "style_preset",
];

#[test]
fn handshake_names_the_server_and_tells_the_workflow() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    let v = s.initialize("test-agent");
    let r = &v["result"];
    assert_eq!(r["protocolVersion"], "2025-06-18");
    assert_eq!(r["serverInfo"]["name"], "polycarp");
    assert!(r["capabilities"]["tools"].is_object());
    let ins = r["instructions"].as_str().unwrap();
    let order: Vec<usize> = [
        "theme_schema",
        "theme_current",
        "theme_change",
        "theme_apply",
        "theme_preview",
        "theme_undo",
    ]
    .iter()
    .map(|w| {
        ins.find(w)
            .unwrap_or_else(|| panic!("instructions lack {w}"))
    })
    .collect();
    assert!(
        order.windows(2).all(|w| w[0] < w[1]),
        "workflow order: {order:?}"
    );
    // The initialized notification got no answer: the next line is the ping's.
    let p = s.request("ping", json!({}));
    assert_eq!(p["result"], json!({}));
    assert_eq!(s.finish(), 0);
}

#[test]
fn older_known_versions_are_echoed_and_unknown_ones_get_the_latest() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    for (asked, want) in [
        ("2025-03-26", "2025-03-26"),
        ("2024-11-05", "2024-11-05"),
        ("1999-01-01", "2025-06-18"),
    ] {
        let v = s.request(
            "initialize",
            json!({"protocolVersion": asked, "clientInfo": {"name": "x"}}),
        );
        assert_eq!(v["result"]["protocolVersion"], want);
    }
    assert_eq!(s.finish(), 0);
}

#[test]
fn tools_list_has_every_tool_with_a_schema_and_a_reason_to_use_it() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    s.initialize("t");
    let v = s.request("tools/list", json!({}));
    let tools = v["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, TOOLS);
    for t in tools {
        let name = t["name"].as_str().unwrap();
        assert!(t["description"].as_str().unwrap().len() > 60, "{name}");
        let schema = &t["inputSchema"];
        assert_eq!(schema["type"], "object", "{name}");
        assert_eq!(schema["additionalProperties"], false, "{name}");
        assert!(
            schema["properties"].is_object() && schema["required"].is_array(),
            "{name}"
        );
        for (k, p) in schema["properties"].as_object().unwrap() {
            assert!(
                p["description"].as_str().is_some_and(|d| !d.is_empty()) || p["enum"].is_array(),
                "{name}.{k}"
            );
        }
        for r in schema["required"].as_array().unwrap() {
            assert!(
                schema["properties"].get(r.as_str().unwrap()).is_some(),
                "{name}: {r}"
            );
        }
        assert!(t["annotations"]["readOnlyHint"].is_boolean(), "{name}");
    }
    let by = |n: &str| tools.iter().find(|t| t["name"] == n).unwrap();
    assert!(by("theme_schema")["description"]
        .as_str()
        .unwrap()
        .contains("first"));
    assert!(by("theme_undo")["description"]
        .as_str()
        .unwrap()
        .contains("dislikes"));
    assert!(
        by("theme_apply")["inputSchema"]["properties"]["theme"]["type"]
            .to_string()
            .contains("object")
    );
    assert_eq!(
        by("theme_change")["inputSchema"]["required"],
        json!(["path", "value"])
    );
    assert_eq!(s.finish(), 0);
}

#[test]
fn a_full_workflow_over_the_real_binary_records_the_agent_by_name() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    s.initialize("claude-code");

    // 1. Read the schema and the current state.
    let r = s.tool("theme_schema", json!({}));
    assert_eq!(r["isError"], false);
    let schema = &r["structuredContent"]["data"]["schema"];
    assert_eq!(
        schema["$schema"],
        "https://json-schema.org/draft/2020-12/schema"
    );
    assert!(
        schema["$defs"]["shape"]["properties"]["radius"]["description"]
            .as_str()
            .unwrap()
            .len()
            > 20
    );
    let r = s.tool("theme_current", json!({}));
    assert_eq!(r["structuredContent"]["data"]["theme"], "polycarp");

    // 2. Change one value from what the schema said.
    let r = s.tool(
        "theme_change",
        json!({"path": "dark.accent", "value": "#8fb37a"}),
    );
    assert_eq!(r["isError"], false, "{r}");
    let d = &r["structuredContent"]["data"];
    assert_eq!(
        (d["theme"].clone(), d["created"].clone()),
        ("polycarp-custom".into(), true.into())
    );
    let r = s.tool("theme_change", json!({"path": "shape.radius", "value": 0}));
    assert_eq!(r["structuredContent"]["data"]["previous"], 10);
    let r = s.tool("theme_get", json!({"path": "dark.accent"}));
    assert_eq!(r["structuredContent"]["data"]["value"], "#8fb37a");

    // 3. Preview it.
    let r = s.tool("theme_preview", json!({"mode": "dark"}));
    assert_eq!(r["isError"], false, "{r}");
    let out = PathBuf::from(r["structuredContent"]["data"]["path"].as_str().unwrap());
    assert_eq!(out.parent().unwrap(), sb.cfg().join("previews"));
    assert!(fs::read_to_string(&out)
        .unwrap()
        .contains("--pc-accent: #8fb37a;"));

    // 4. The history names the agent.
    let r = s.tool("theme_history", json!({}));
    let entries = r["structuredContent"]["data"]["entries"]
        .as_array()
        .unwrap();
    assert_eq!(entries.len(), 2);
    for e in entries {
        assert_eq!(e["caller"], "agent:claude-code");
    }
    assert_eq!(entries[0]["action"], "theme change shape.radius 0");

    // 5. Undo twice: the radius first, then the whole custom theme.
    let r = s.tool("theme_undo", json!({}));
    assert_eq!(
        r["structuredContent"]["data"]["undid"]["caller"],
        "agent:claude-code"
    );
    let r = s.tool("theme_get", json!({"path": "shape.radius"}));
    assert_eq!(r["structuredContent"]["data"]["value"], 10);
    let r = s.tool("theme_undo", json!({}));
    assert_eq!(r["isError"], false);
    let r = s.tool("theme_current", json!({}));
    assert_eq!(r["structuredContent"]["data"]["theme"], "polycarp");
    assert!(!sb.cfg().join("themes/polycarp-custom.toml").exists());

    // 6. Whole-theme apply as an object and as TOML, then reset.
    let r = s.tool("theme_apply", json!({"theme": {"name": "sage", "title": "Sage", "extends": "calm", "light": {"accent": "#3a6b4f"}}}));
    assert_eq!(r["isError"], false, "{r}");
    assert_eq!(r["structuredContent"]["data"]["activated"], true);
    let r = s.tool("theme_apply", json!({"theme": "name = \"toml-one\"\ntitle = \"T\"\nextends = \"calm\"\n", "activate": false}));
    assert_eq!(r["structuredContent"]["data"]["activated"], false);
    let r = s.tool(
        "theme_validate",
        json!({"theme": {"name": "draft", "title": "D", "extends": "calm"}}),
    );
    assert_eq!(r["structuredContent"]["data"]["valid"], true);
    assert!(
        !sb.cfg().join("themes/draft.toml").exists(),
        "validate saves nothing"
    );
    let r = s.tool("theme_list", json!({}));
    assert!(r["structuredContent"]["data"]["themes"]
        .to_string()
        .contains("toml-one"));
    s.tool("theme_set", json!({"name": "evening", "mode": "dark"}));
    s.tool("theme_accent", json!({"color": "#2f6b55", "mode": "light"}));
    let r = s.tool("theme_export", json!({"format": "css", "surface": "site"}));
    assert!(r["structuredContent"]["data"]["css"]
        .as_str()
        .unwrap()
        .contains("--pc-accent: #2f6b55;"));
    let r = s.tool("theme_show", json!({"name": "calm"}));
    assert_eq!(r["structuredContent"]["data"]["name"], "calm");
    s.tool("theme_accent", json!({"clear": true}));
    let r = s.tool("theme_reset", json!({}));
    assert_eq!(r["structuredContent"]["data"]["theme"], "polycarp");
    assert_eq!(s.finish(), 0);

    // The file on disk says the same thing as the tool did.
    let h = sb.cli(&["history"]);
    assert!(h["data"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["caller"] == "agent:claude-code"));
}

#[test]
fn a_refusal_is_a_tool_error_with_the_same_envelope_as_the_cli() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    s.initialize("t");
    // The empty .lock file is expected; it is never removed.
    let count = |p: &std::path::Path| {
        fs::read_dir(p)
            .map(|r| r.flatten().filter(|e| e.file_name() != ".lock").count())
            .unwrap_or(0)
    };
    let before = count(&sb.cfg());
    let r = s.tool(
        "theme_change",
        json!({"path": "dark.muted", "value": "#444444"}),
    );
    assert_eq!(r["isError"], true);
    let env = &r["structuredContent"];
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "contrast");
    let e = &env["error"]["data"]["errors"][0];
    assert_eq!(e["path"], "dark.muted");
    assert!(e["actual"].is_number() && e["needs"] == 4.5);
    assert!(!env["error"]["suggestion"].as_str().unwrap().is_empty());
    assert_eq!(count(&sb.cfg()), before, "nothing was written");
    // Same call on the command line gives the same envelope.
    let cli = sb.cli(&["change", "dark.muted", "#444444"]);
    assert_eq!(&cli, env);
    // More refusals: bad value, unknown theme, built-in name, bad arguments.
    let r = s.tool("theme_change", json!({"path": "shape.radius", "value": 99}));
    assert_eq!(
        (
            r["isError"].clone(),
            r["structuredContent"]["error"]["code"].clone()
        ),
        (true.into(), "invalid_value".into())
    );
    let r = s.tool("theme_set", json!({"name": "ghost"}));
    assert_eq!(r["structuredContent"]["error"]["code"], "unknown_theme");
    let r = s.tool(
        "theme_apply",
        json!({"theme": {"name": "calm", "title": "x", "extends": "polycarp"}}),
    );
    assert_eq!(r["structuredContent"]["error"]["code"], "builtin_read_only");
    let r = s.tool("theme_undo", json!({}));
    assert_eq!(r["structuredContent"]["error"]["code"], "nothing_to_undo");
    for (tool, args) in [
        ("theme_change", json!({"path": "dark.accent"})),
        ("theme_get", json!({})),
        ("theme_list", json!({"surprise": 1})),
        ("theme_apply", json!({"theme": 5})),
        ("theme_accent", json!({})),
        ("theme_accent", json!({"color": "#112233", "clear": true})),
    ] {
        let r = s.tool(tool, args.clone());
        assert_eq!(r["isError"], true, "{tool} {args}");
        assert_eq!(
            r["structuredContent"]["error"]["code"], "invalid_args",
            "{tool} {args}"
        );
    }
    assert_eq!(s.finish(), 0);
}

#[test]
fn apply_refuses_an_empty_or_invalid_effective_name_before_writing() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    s.initialize("t");
    for (name, theme) in [
        (
            json!(""),
            json!({"name": "ok-name", "title": "T", "extends": "calm"}),
        ),
        (json!(""), json!({"title": "T", "extends": "calm"})),
        (
            json!("Bad Name"),
            json!({"name": "ok-name", "title": "T", "extends": "calm"}),
        ),
        (
            Value::Null,
            json!({"name": "", "title": "T", "extends": "calm"}),
        ),
    ] {
        let mut args = json!({"theme": theme});
        if !name.is_null() {
            args["name"] = name.clone();
        }
        let r = s.tool("theme_apply", args.clone());
        assert_eq!(r["isError"], true, "{args}");
        assert_eq!(
            r["structuredContent"]["error"]["code"], "invalid_theme",
            "{args}"
        );
        assert_eq!(
            r["structuredContent"]["error"]["data"]["errors"][0]["path"],
            "name"
        );
    }
    assert!(!sb.cfg().exists(), "nothing was written");
    assert_eq!(s.finish(), 0);
}

#[test]
fn preview_over_mcp_cannot_name_a_file_and_says_what_it_does_to_the_disk() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    s.initialize("t");
    let victim = sb.root.join("victim.txt");
    fs::write(&victim, "keep me").unwrap();
    let r = s.tool("theme_preview", json!({"out": victim.to_str().unwrap()}));
    assert_eq!(r["isError"], true);
    assert_eq!(r["structuredContent"]["error"]["code"], "invalid_args");
    assert_eq!(fs::read_to_string(&victim).unwrap(), "keep me");
    let v = s.request("tools/list", json!({}));
    let tools = v["result"]["tools"].as_array().unwrap();
    let by = |n: &str| tools.iter().find(|t| t["name"] == n).unwrap();
    let p = by("theme_preview");
    assert!(p["inputSchema"]["properties"].get("out").is_none());
    assert_eq!(
        p["annotations"],
        json!({"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
    );
    assert_eq!(by("theme_undo")["annotations"]["idempotentHint"], false);
    assert_eq!(
        by("theme_get")["annotations"],
        json!({"readOnlyHint": true, "openWorldHint": false})
    );
    assert_eq!(s.finish(), 0);
}

#[test]
fn bad_requests_get_json_rpc_errors_and_the_server_keeps_going() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    s.initialize("t");
    let v = s.request("no/such/method", json!({}));
    assert_eq!(v["error"]["code"], -32601, "{v}");
    assert!(v.get("result").is_none());
    let v = s.request("tools/call", json!({"name": "theme_nope", "arguments": {}}));
    assert_eq!(v["error"]["code"], -32602, "{v}");
    let v = s.request("tools/call", json!({"arguments": {}}));
    assert_eq!(v["error"]["code"], -32602);
    // Garbage lines: answered with a parse error, then the server carries on.
    for junk in [
        "not json at all",
        "{\"jsonrpc\": \"2.0\", \"id\": 7, \"method\": ",
        "[1,2,3]",
        "42",
    ] {
        s.send_raw(junk);
        let v = s.read();
        assert!(
            v["error"]["code"] == -32700 || v["error"]["code"] == -32600,
            "{junk}: {v}"
        );
        assert_eq!(v["id"], Value::Null);
    }
    s.send_raw("");
    // A request with an id but no method.
    s.send_raw(&json!({"jsonrpc": "2.0", "id": 99}).to_string());
    assert_eq!(s.read()["error"]["code"], -32600);
    // Notifications never get an answer.
    s.send_raw(
        &json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {}}).to_string(),
    );
    s.send_raw(&json!({"jsonrpc": "2.0", "method": "whatever"}).to_string());
    let v = s.request("ping", json!({}));
    assert_eq!(v["result"], json!({}));
    let r = s.tool("theme_current", json!({}));
    assert_eq!(r["isError"], false);
    assert_eq!(s.finish(), 0);
}

#[test]
fn non_utf8_input_is_a_parse_error_not_a_crash() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    s.stdin
        .as_mut()
        .unwrap()
        .write_all(&[0xff, 0xfe, b'\n'])
        .unwrap();
    let v = s.read();
    assert_eq!(v["error"]["code"], -32700);
    assert_eq!(s.request("ping", json!({}))["result"], json!({}));
    assert_eq!(s.finish(), 0);
}

#[test]
fn end_of_input_exits_zero_even_with_no_messages_or_half_a_line() {
    let sb = Sandbox::new();
    let s = sb.server();
    assert_eq!(s.finish(), 0);
    let mut s = sb.server();
    s.stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"")
        .unwrap();
    let out = {
        drop(s.stdin.take());
        let mut line = String::new();
        s.stdout.read_line(&mut line).unwrap();
        line
    };
    // The half line is still a line: it fails to parse, and the server exits cleanly.
    assert!(out.contains("-32700"), "{out}");
    assert_eq!(s.child.wait().unwrap().code(), Some(0));
}

#[test]
fn a_client_without_a_name_is_recorded_as_unknown() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    s.request("initialize", json!({"protocolVersion": "2025-06-18"}));
    s.tool("theme_change", json!({"path": "shape.radius", "value": 1}));
    let h = s.tool("theme_history", json!({}));
    assert_eq!(
        h["structuredContent"]["data"]["entries"][0]["caller"],
        "agent:unknown"
    );
    let mut s2 = sb.server();
    s2.request(
        "initialize",
        json!({"clientInfo": {"name": "evil\nname # = x"}}),
    );
    s2.tool("theme_change", json!({"path": "shape.radius", "value": 2}));
    let h = s2.tool("theme_history", json!({}));
    let who = h["structuredContent"]["data"]["entries"][0]["caller"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        who.starts_with("agent:evil") && !who.contains('\n'),
        "{who}"
    );
    assert_eq!(s.finish() + s2.finish(), 0);
}

#[test]
fn mcp_refuses_arguments_and_says_where_it_is_listed() {
    let sb = Sandbox::new();
    let o = sb.command().args(["mcp", "extra"]).output().unwrap();
    assert_eq!(o.status.code(), Some(2));
    let o = sb.command().arg("--help").output().unwrap();
    assert!(String::from_utf8_lossy(&o.stdout).contains("polycarp mcp"));
}

#[test]
fn an_agent_can_create_and_delete_its_own_theme() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    s.initialize("t");
    let r = s.tool(
        "theme_create",
        json!({"name": "scratch", "extends": "calm"}),
    );
    assert_eq!(r["structuredContent"]["ok"], true, "{r}");
    assert!(sb.cfg().join("themes").join("scratch.toml").exists());
    let r = s.tool(
        "theme_create",
        json!({"name": "scratch", "extends": "calm"}),
    );
    assert_eq!(r["isError"], true);
    assert_eq!(r["structuredContent"]["error"]["code"], "exists");
    let r = s.tool("theme_delete", json!({"name": "calm"}));
    assert_eq!(
        r["structuredContent"]["error"]["code"], "builtin_read_only",
        "{r}"
    );
    let r = s.tool("theme_delete", json!({"name": "scratch"}));
    assert_eq!(r["structuredContent"]["ok"], true, "{r}");
    assert!(!sb.cfg().join("themes").join("scratch.toml").exists());
    let r = s.tool("theme_undo", json!({}));
    assert_eq!(r["structuredContent"]["ok"], true, "{r}");
    assert!(sb.cfg().join("themes").join("scratch.toml").exists());
}

#[test]
fn theme_off_and_on_work_over_mcp_with_honest_annotations() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    let init = s.initialize("claude-code");
    assert!(init["result"]["instructions"]
        .as_str()
        .unwrap()
        .contains("if the person wants the apps' own look back, use `theme_off`"));
    let v = s.request("tools/list", json!({}));
    let tools = v["result"]["tools"].as_array().unwrap();
    let ann = |n: &str| tools.iter().find(|t| t["name"] == n).unwrap()["annotations"].clone();
    assert_eq!(ann("theme_off")["readOnlyHint"], false);
    assert_eq!(ann("theme_off")["destructiveHint"], true);
    assert_eq!(ann("theme_off")["idempotentHint"], true);
    assert_eq!(ann("theme_on")["readOnlyHint"], false);
    assert_eq!(ann("theme_on")["destructiveHint"], false);
    s.tool("theme_set", json!({"name": "calm"}));
    assert!(sb.cfg().join("current/theme.json").is_file());
    let r = s.tool("theme_off", json!({}));
    assert_eq!(r["structuredContent"]["data"]["enabled"], false);
    assert!(!sb.cfg().join("current/theme.json").exists());
    let r = s.tool("theme_current", json!({}));
    assert_eq!(r["structuredContent"]["data"]["enabled"], false);
    let r = s.tool("theme_on", json!({}));
    assert_eq!(r["structuredContent"]["data"]["enabled"], true);
    assert!(sb.cfg().join("current/theme.json").is_file());
    let h = s.tool("theme_history", json!({}));
    assert!(h["structuredContent"]["data"]["entries"][1]["action"] == "theme off");
    assert_eq!(s.finish(), 0);
}

fn data(r: &Value) -> &Value {
    &r["structuredContent"]["data"]
}

fn code_of(r: &Value) -> &str {
    r["structuredContent"]["error"]["code"]
        .as_str()
        .unwrap_or("")
}

#[test]
fn the_instructions_say_how_to_iterate() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    let v = s.initialize("t");
    let text = v["result"]["instructions"].as_str().unwrap();
    for w in [
        "theme_change_many",
        "format \"png\"",
        "look at every image",
        "Repeat",
        "theme_set",
        "force true",
    ] {
        assert!(text.contains(w), "the instructions never say {w:?}");
    }
    assert_eq!(s.finish(), 0);
}

#[test]
fn an_agent_iterates_on_a_new_theme_without_touching_the_one_in_use() {
    let sb = Sandbox::new();
    assert_eq!(sb.cli(&["set", "evening"])["ok"], true);
    let mut s = sb.server();
    s.initialize("iterate-test");
    let r = s.tool("theme_create", json!({"name": "draft", "extends": "calm"}));
    assert_eq!(r["isError"], false, "{r}");
    let r = s.tool(
        "theme_change_many",
        json!({"theme": "draft", "changes": [
            {"path": "shape.radius", "value": 2},
            {"path": "shape.indicator", "value": "bar"},
            {"path": "dark.accent", "value": "#a9bb8a"},
        ]}),
    );
    assert_eq!(r["isError"], false, "{r}");
    assert_eq!(data(&r)["current"], false);
    assert_eq!(data(&r)["changes"].as_array().unwrap().len(), 3);
    let r = s.tool(
        "theme_preview",
        json!({"name": "draft", "format": "png", "mode": "dark"}),
    );
    assert_eq!(r["isError"], false, "{r}");
    let images = data(&r)["images"].as_array().unwrap();
    assert_eq!(images.len(), 4, "one per product in dark mode");
    for i in images {
        let p = PathBuf::from(i["path"].as_str().unwrap());
        assert!(p.starts_with(sb.cfg().join("previews")));
        assert_eq!(&fs::read(&p).unwrap()[..4], b"\x89PNG");
    }
    // A bad batch names each path and changes nothing.
    let before = fs::read_to_string(sb.cfg().join("themes/draft.toml")).unwrap();
    let r = s.tool(
        "theme_change_many",
        json!({"theme": "draft", "changes": [{"path": "shape.radius", "value": 99}, {"path": "shape.nope", "value": 1}]}),
    );
    assert_eq!(r["isError"], true);
    assert_eq!(
        r["structuredContent"]["error"]["data"]["errors"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "{r}"
    );
    assert_eq!(
        fs::read_to_string(sb.cfg().join("themes/draft.toml")).unwrap(),
        before
    );
    let r = s.tool(
        "theme_change_many",
        json!({"changes": [{"path": "shape.radius"}]}),
    );
    assert_eq!(code_of(&r), "invalid_args");
    // The one in use never changed until the agent sets the new one.
    assert_eq!(
        s.tool("theme_current", json!({}))["structuredContent"]["data"]["theme"],
        "evening"
    );
    let r = s.tool("theme_set", json!({"name": "draft"}));
    assert_eq!(r["isError"], false, "{r}");
    let r = s.tool("theme_undo", json!({}));
    assert_eq!(r["isError"], false, "{r}");
    assert_eq!(
        s.tool("theme_current", json!({}))["structuredContent"]["data"]["theme"],
        "evening"
    );
    assert_eq!(s.finish(), 0);
}

#[test]
fn an_agent_cannot_delete_or_replace_a_theme_it_did_not_make_without_force() {
    let sb = Sandbox::new();
    assert_eq!(sb.cli(&["create", "mine", "--extends", "calm"])["ok"], true);
    let mine = sb.cfg().join("themes/mine.toml");
    let text = fs::read_to_string(&mine).unwrap();
    let mut s = sb.server();
    s.initialize("guard-test");

    let r = s.tool("theme_delete", json!({"name": "mine"}));
    assert_eq!(
        (r["isError"].as_bool(), code_of(&r)),
        (Some(true), "not_yours"),
        "{r}"
    );
    assert!(mine.exists());
    let doc = json!({"name": "mine", "title": "Mine", "extends": "blocks"});
    let r = s.tool("theme_apply", json!({"theme": doc}));
    assert_eq!(code_of(&r), "not_yours", "{r}");
    let r = s.tool(
        "theme_apply",
        json!({"theme": {"name": "other", "title": "O", "extends": "blocks"}, "name": "mine"}),
    );
    assert_eq!(code_of(&r), "not_yours", "--name counts too: {r}");
    assert_eq!(fs::read_to_string(&mine).unwrap(), text);

    // What it made itself it may replace and delete.
    assert_eq!(
        s.tool("theme_create", json!({"name": "made", "extends": "calm"}))["isError"],
        false
    );
    let r = s.tool(
        "theme_apply",
        json!({"theme": {"name": "made", "title": "Made", "extends": "blocks"}, "activate": false}),
    );
    assert_eq!(r["isError"], false, "{r}");
    assert_eq!(
        s.tool("theme_delete", json!({"name": "made"}))["isError"],
        false
    );
    let r = s.tool(
        "theme_apply",
        json!({"theme": {"name": "fresh", "title": "Fresh", "extends": "calm"}, "activate": false}),
    );
    assert_eq!(r["isError"], false, "{r}");
    assert_eq!(
        s.tool("theme_delete", json!({"name": "fresh"}))["isError"],
        false
    );
    // A -custom copy from a change on a built-in is the agent's too.
    assert_eq!(
        s.tool("theme_set", json!({"name": "calm"}))["isError"],
        false
    );
    let r = s.tool("theme_change", json!({"path": "shape.radius", "value": 4}));
    assert_eq!(data(&r)["theme"], "calm-custom");
    assert_eq!(
        s.tool("theme_set", json!({"name": "calm"}))["isError"],
        false
    );
    assert_eq!(
        s.tool("theme_delete", json!({"name": "calm-custom"}))["isError"],
        false
    );

    // force true, which the agent sends only after the person agrees, goes ahead.
    let r = s.tool("theme_delete", json!({"name": "mine", "force": true}));
    assert_eq!(r["isError"], false, "{r}");
    assert!(!mine.exists());
    assert_eq!(s.finish(), 0);

    // A new connection is a new session: it did not make calm's copy... which is gone; make one by hand.
    assert_eq!(
        sb.cli(&["create", "again", "--extends", "calm"])["ok"],
        true
    );
    let mut s = sb.server();
    s.initialize("guard-test-2");
    assert_eq!(
        code_of(&s.tool("theme_delete", json!({"name": "again"}))),
        "not_yours"
    );
    assert_eq!(s.finish(), 0);
}

// ---- Surfaces: the tools run `polycarp-spaces surfaces ... --json` and pass its envelope on ----

/// A stand-in for polycarp-spaces: writes its arguments, one a line, to `args`, prints `reply` on stdout and
/// `stderr` on stderr, and exits with what `code` holds (0 when it is missing).
#[cfg(unix)]
fn spaces_stub(sb: &Sandbox) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let dir = sb.root.join("spaces");
    fs::create_dir_all(&dir).unwrap();
    let p = dir.join("polycarp-spaces");
    let d = dir.display();
    fs::write(
        &p,
        format!(
            "#!/bin/sh\n: > '{d}/args'\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> '{d}/args'; done\n\
             [ -f '{d}/reply' ] && cat '{d}/reply'\n[ -f '{d}/stderr' ] && cat '{d}/stderr' >&2\n\
             exit $(cat '{d}/code' 2>/dev/null || echo 0)\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    p
}

#[cfg(unix)]
fn surfaces_server(sb: &Sandbox, bin: &Path) -> Server {
    let mut c = sb.command();
    // From `/`, so the stub under the target folder is outside the current folder's tree, as a real install is.
    c.env("POLYCARP_SPACES_BIN", bin)
        .env("POLYCARP_NO_SYSTEM_SPOTS", "1")
        .current_dir("/");
    Sandbox::spawn(c)
}

#[cfg(unix)]
fn stub_args(sb: &Sandbox) -> Vec<String> {
    fs::read_to_string(sb.root.join("spaces/args"))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

#[cfg(unix)]
#[test]
fn surfaces_tools_run_the_spaces_command_and_pass_its_envelope_on_as_is() {
    let sb = Sandbox::new();
    let bin = spaces_stub(&sb);
    let reply = json!({"ok": true, "data": {"path": "bar.style", "value": "glass", "file": "~/x/surfaces.json"}});
    fs::write(sb.root.join("spaces/reply"), reply.to_string()).unwrap();
    let mut s = surfaces_server(&sb, &bin);
    s.initialize("t");
    let r = s.tool(
        "surfaces_set",
        json!({"path": "bar.style", "value": "glass"}),
    );
    assert_eq!(r["isError"], false);
    assert_eq!(r["structuredContent"], reply);
    // The value goes as JSON text, so a string stays a string and a list stays a list.
    assert_eq!(
        stub_args(&sb),
        ["surfaces", "set", "bar.style", "\"glass\"", "--json"]
    );
    s.tool(
        "surfaces_set",
        json!({"path": "bar.modules.left", "value": ["mark", "clock"]}),
    );
    assert_eq!(
        stub_args(&sb),
        [
            "surfaces",
            "set",
            "bar.modules.left",
            "[\"mark\",\"clock\"]",
            "--json"
        ]
    );
    s.tool("surfaces_get", json!({"path": "bar"}));
    assert_eq!(stub_args(&sb), ["surfaces", "get", "bar", "--json"]);
    s.tool("surfaces_get", json!({}));
    assert_eq!(stub_args(&sb), ["surfaces", "get", "--json"]);
    s.tool("surfaces_schema", json!({}));
    assert_eq!(stub_args(&sb), ["surfaces", "schema", "--json"]);

    // A refusal from the command is a tool error with its envelope unchanged.
    let refused = json!({"ok": false, "error": {"code": "invalid_value", "message": "bar.height: must be from 22 to 40, not 99",
        "retry": "never", "suggestion": "run `surfaces schema` for what bar.height takes",
        "data": {"errors": [{"path": "bar.height", "message": "must be from 22 to 40, not 99"}]}}});
    fs::write(sb.root.join("spaces/reply"), refused.to_string()).unwrap();
    fs::write(sb.root.join("spaces/code"), "1").unwrap();
    let r = s.tool("surfaces_set", json!({"path": "bar.height", "value": 99}));
    assert_eq!(r["isError"], true);
    assert_eq!(r["structuredContent"], refused);
    assert_eq!(s.finish(), 0);
}

#[cfg(unix)]
#[test]
fn surfaces_tools_check_their_arguments_before_running_anything() {
    let sb = Sandbox::new();
    let bin = spaces_stub(&sb);
    let mut s = surfaces_server(&sb, &bin);
    s.initialize("t");
    for (tool, args) in [
        ("surfaces_set", json!({"path": "bar.height"})),
        ("surfaces_set", json!({"value": 30})),
        ("surfaces_set", json!({"path": 3, "value": 30})),
        ("surfaces_get", json!({"path": ["bar"]})),
        ("surfaces_schema", json!({"path": "bar"})),
    ] {
        let r = s.tool(tool, args.clone());
        assert_eq!(r["isError"], true, "{tool} {args}");
        assert_eq!(
            r["structuredContent"]["error"]["code"], "invalid_args",
            "{tool} {args}"
        );
    }
    assert!(
        !sb.root.join("spaces/args").exists(),
        "the command never ran"
    );
    assert_eq!(s.finish(), 0);
}

#[cfg(unix)]
#[test]
fn surfaces_tools_say_when_the_spaces_command_is_missing_old_or_broken() {
    let sb = Sandbox::new();
    let mut s = surfaces_server(&sb, &sb.root.join("nowhere/polycarp-spaces"));
    s.initialize("t");
    let r = s.tool("surfaces_get", json!({}));
    assert_eq!(r["isError"], true);
    assert_eq!(r["structuredContent"]["error"]["code"], "spaces_not_found");
    assert!(r["structuredContent"]["error"]["suggestion"]
        .as_str()
        .unwrap()
        .contains("POLYCARP_SPACES_BIN"));
    assert_eq!(s.finish(), 0);

    // An app from before surfaces prints its usage and exits 2.
    let bin = spaces_stub(&sb);
    fs::write(
        sb.root.join("spaces/stderr"),
        "usage: polycarp-spaces <command>\n",
    )
    .unwrap();
    fs::write(sb.root.join("spaces/code"), "2").unwrap();
    let mut s = surfaces_server(&sb, &bin);
    s.initialize("t");
    let r = s.tool("surfaces_schema", json!({}));
    assert_eq!(r["structuredContent"]["error"]["code"], "spaces_too_old");
    // Anything else that isn't an envelope.
    fs::write(sb.root.join("spaces/stderr"), "boom\n").unwrap();
    fs::write(sb.root.join("spaces/reply"), "not json").unwrap();
    let r = s.tool("surfaces_schema", json!({}));
    let e = &r["structuredContent"]["error"];
    assert_eq!(e["code"], "spaces_failed");
    assert!(e["message"].as_str().unwrap().contains("boom"), "{e}");
    assert_eq!(e["data"]["errors"][0]["path"], "$");
    assert_eq!(s.finish(), 0);
}

#[test]
fn the_instructions_send_surfaces_work_to_the_surfaces_tools() {
    let sb = Sandbox::new();
    let mut s = sb.server();
    let v = s.initialize("t");
    let ins = v["result"]["instructions"].as_str().unwrap();
    let at = |w: &str| {
        ins.find(w)
            .unwrap_or_else(|| panic!("instructions lack {w}"))
    };
    assert!(at("surfaces_schema") < at("surfaces_get") && at("surfaces_get") < at("surfaces_set"));
    assert!(at("style_example") < at("style_set") && at("style_set") < at("style_check"));
    assert_eq!(s.finish(), 0);
}

#[cfg(unix)]
#[test]
fn style_tools_run_the_spaces_style_command_and_pass_its_envelope_on_as_is() {
    let sb = Sandbox::new();
    let bin = spaces_stub(&sb);
    let reply = json!({"ok": true, "data": {"file": "~/.config/polycarp/style.css", "selector": "bar .clock",
        "property": "color", "value": "#d4af37", "warnings": []}});
    fs::write(sb.root.join("spaces/reply"), reply.to_string()).unwrap();
    let mut s = surfaces_server(&sb, &bin);
    s.initialize("t");
    let r = s.tool(
        "style_set",
        json!({"selector": "bar .clock", "property": "color", "value": "#d4af37"}),
    );
    assert_eq!(r["isError"], false);
    assert_eq!(r["structuredContent"], reply);
    // Each argument goes as its own word, so a selector with spaces and a value with commas arrive whole.
    assert_eq!(
        stub_args(&sb),
        ["style", "set", "bar .clock", "color", "#d4af37", "--json"]
    );
    s.tool(
        "style_set",
        json!({"selector": "bar", "property": "font-family", "value": "\"SF Pro Text\", system-ui", "media": "dark"}),
    );
    assert_eq!(
        stub_args(&sb),
        [
            "style",
            "set",
            "bar",
            "font-family",
            "\"SF Pro Text\", system-ui",
            "--media",
            "dark",
            "--json"
        ]
    );
    s.tool(
        "style_unset",
        json!({"selector": "dock .tile", "property": "border-radius"}),
    );
    assert_eq!(
        stub_args(&sb),
        ["style", "unset", "dock .tile", "border-radius", "--json"]
    );
    s.tool("style_unset", json!({"selector": "bar", "media": "light"}));
    assert_eq!(
        stub_args(&sb),
        ["style", "unset", "bar", "--media", "light", "--json"]
    );
    s.tool("style_check", json!({}));
    assert_eq!(stub_args(&sb), ["style", "check", "--json"]);
    s.tool("style_preset", json!({"name": "omarchy"}));
    assert_eq!(stub_args(&sb), ["style", "preset", "omarchy", "--json"]);
    s.tool("style_preset", json!({}));
    assert_eq!(stub_args(&sb), ["style", "preset", "--json"]);
    s.tool("style_get", json!({}));
    assert_eq!(stub_args(&sb), ["style", "show", "--json"]);
    s.tool("style_example", json!({}));
    assert_eq!(stub_args(&sb), ["style", "example", "--json"]);

    // A refusal from the command is a tool error with its envelope unchanged.
    let refused = json!({"ok": false, "error": {"code": "invalid_value",
        "message": "dock .tile { height: 30px } was not set: `height` doesn't apply to `dock .tile`; it applies to bar",
        "retry": "never", "suggestion": "Run `polycarp-spaces style example`.",
        "data": {"errors": [{"line": 4, "column": 3, "severity": "error", "message": "`height` doesn't apply to `dock .tile`"}]}}});
    fs::write(sb.root.join("spaces/reply"), refused.to_string()).unwrap();
    fs::write(sb.root.join("spaces/code"), "1").unwrap();
    let r = s.tool(
        "style_set",
        json!({"selector": "dock .tile", "property": "height", "value": "30px"}),
    );
    assert_eq!(r["isError"], true);
    assert_eq!(r["structuredContent"], refused);
    assert_eq!(s.finish(), 0);
}

/// style_check takes no file: a path from the caller would let a prompt read any file through the problems' messages
/// (review of #604). The schema has no `file`, and a call that passes one is refused before anything runs.
#[cfg(unix)]
#[test]
fn style_check_reads_only_the_sheet_in_use() {
    let sb = Sandbox::new();
    let bin = spaces_stub(&sb);
    let mut s = surfaces_server(&sb, &bin);
    s.initialize("t");
    let list = s.request("tools/list", json!({}));
    let tools = list["result"]["tools"].as_array().unwrap();
    let check = tools.iter().find(|t| t["name"] == "style_check").unwrap();
    assert_eq!(
        check["inputSchema"]["properties"],
        json!({}),
        "style_check takes no arguments"
    );
    for args in [
        json!({"file": "/etc/passwd"}),
        json!({"path": "~/.ssh/id_ed25519"}),
    ] {
        let r = s.tool("style_check", args.clone());
        assert_eq!(r["isError"], true, "{args}");
        assert_eq!(
            r["structuredContent"]["error"]["code"], "invalid_args",
            "{args}"
        );
    }
    assert!(
        !sb.root.join("spaces/args").exists(),
        "the command never ran"
    );
    s.tool("style_check", json!({}));
    assert_eq!(stub_args(&sb), ["style", "check", "--json"]);
    assert_eq!(s.finish(), 0);
}

#[cfg(unix)]
#[test]
fn style_tools_check_their_arguments_and_say_when_the_command_is_missing() {
    let sb = Sandbox::new();
    let bin = spaces_stub(&sb);
    let mut s = surfaces_server(&sb, &bin);
    s.initialize("t");
    for (tool, args) in [
        ("style_set", json!({"selector": "bar", "property": "color"})),
        ("style_set", json!({"property": "color", "value": "red"})),
        (
            "style_set",
            json!({"selector": "bar", "property": "color", "value": 3}),
        ),
        (
            "style_set",
            json!({"selector": "bar", "property": "color", "value": "red", "media": "dim"}),
        ),
        ("style_unset", json!({})),
        ("style_check", json!({"file": ["x"]})),
        ("style_preset", json!({"name": 3})),
        ("style_example", json!({"selector": "bar"})),
    ] {
        let r = s.tool(tool, args.clone());
        assert_eq!(r["isError"], true, "{tool} {args}");
        assert_eq!(
            r["structuredContent"]["error"]["code"], "invalid_args",
            "{tool} {args}"
        );
    }
    assert!(
        !sb.root.join("spaces/args").exists(),
        "the command never ran"
    );
    assert_eq!(s.finish(), 0);

    let mut s = surfaces_server(&sb, &sb.root.join("nowhere/polycarp-spaces"));
    s.initialize("t");
    let r = s.tool("style_get", json!({}));
    assert_eq!(r["structuredContent"]["error"]["code"], "spaces_not_found");
    assert!(r["structuredContent"]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("style"));
    assert_eq!(s.finish(), 0);

    // An app from before the style sheet prints its usage and exits 2.
    fs::write(
        sb.root.join("spaces/stderr"),
        "usage: polycarp-spaces <command>\n",
    )
    .unwrap();
    fs::write(sb.root.join("spaces/code"), "2").unwrap();
    let mut s = surfaces_server(&sb, &bin);
    s.initialize("t");
    let r = s.tool("style_example", json!({}));
    assert_eq!(r["structuredContent"]["error"]["code"], "spaces_too_old");
    assert_eq!(
        r["structuredContent"]["error"]["message"],
        "this Polycarp has no style command"
    );
    assert_eq!(s.finish(), 0);
}
