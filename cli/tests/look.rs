//! Integration tests for `polycarp look`. Every run gets its own home and config folder, so nothing real is read or
//! changed.

use serde_json::{json, Value};
use std::fs;
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
        let name = format!("look-{}-{n}", std::process::id());
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
        let _ = fs::remove_dir_all(&root);
        for d in ["home", "tmp", "cfg", "live", "empty"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Sandbox { root }
    }
    fn at(&self, p: &str) -> PathBuf {
        self.root.join(p)
    }
    fn run(&self, args: &[&str], input: &str) -> Output {
        use std::io::Write;
        let mut c = Command::new(env!("CARGO_BIN_EXE_polycarp"));
        c.env_clear()
            .env("HOME", self.at("home"))
            .env("USERPROFILE", self.at("home"))
            .env("POLYCARP_CONFIG_DIR", self.at("cfg"))
            .env("TMPDIR", self.at("tmp"))
            .env("POLYCARP_NO_SYSTEM_SPOTS", "1")
            .env("PATH", self.at("empty"))
            // Outside the sandbox's tree: a tool inside the current folder's is refused.
            .current_dir(if cfg!(unix) {
                PathBuf::from("/")
            } else {
                self.at("empty")
            })
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(r) = std::env::var_os("SystemRoot") {
            c.env("SystemRoot", r);
        }
        let mut p = c.spawn().unwrap();
        let _ = p.stdin.take().unwrap().write_all(input.as_bytes());
        p.wait_with_output().unwrap()
    }
    /// The envelope of one `--json` command.
    fn json(&self, args: &[&str]) -> Value {
        self.json_in(args, "")
    }
    fn json_in(&self, args: &[&str], input: &str) -> Value {
        let mut a = args.to_vec();
        a.push("--json");
        let o = self.run(&a, input);
        let text = String::from_utf8_lossy(&o.stdout).into_owned();
        let v: Value =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("{args:?}: {e}: {text}{o:?}"));
        assert_eq!(
            o.status.code(),
            Some(if v["ok"] == true { 0 } else { v_exit(&v) }),
            "{args:?}"
        );
        v
    }
    fn ok(&self, args: &[&str]) -> Value {
        let v = self.json(args);
        assert_eq!(v["ok"], true, "{args:?}: {v}");
        v["data"].clone()
    }
    /// A refusal's code.
    fn no(&self, args: &[&str]) -> String {
        let v = self.json(args);
        assert_eq!(v["ok"], false, "{args:?}: {v}");
        v["error"]["code"].as_str().unwrap().to_string()
    }
    /// The paths a look file is refused for.
    fn refused(&self, look: &str) -> Vec<String> {
        let v = self.json_in(&["look", "show", "-"], look);
        assert_eq!(v["ok"], false, "not refused: {look}");
        let errors = v["error"]["data"]["errors"].as_array().unwrap();
        errors
            .iter()
            .map(|e| e["path"].as_str().unwrap_or_default().to_string())
            .collect()
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn v_exit(v: &Value) -> i32 {
    if v["error"]["code"] == "invalid_args" {
        2
    } else {
        1
    }
}

/// A look that is fine, for a test to spoil.
fn hostile() -> Value {
    json!({"schema": 1, "name": "hostile", "theme": {"builtin": "evening"}})
}

fn with(key: &str, v: Value) -> String {
    let mut l = hostile();
    l[key] = v;
    l.to_string()
}

// Reading a look someone sent -------------------------------------------------------------------------------------

#[test]
fn unknown_keys_are_refused_with_their_path() {
    let sb = Sandbox::new();
    assert_eq!(sb.refused(&with("command", json!("rm -rf"))), ["command"]);
    assert_eq!(
        sb.refused(&with("accent", json!({"sepia": "#111111"}))),
        ["accent.sepia"]
    );
    let doc = json!({"document": {"name": "x", "extends": "evening", "surprise": 1}});
    assert_eq!(sb.refused(&with("theme", doc)), ["theme.document.extends"]);
    let doc = json!({"document": {"name": "x", "surprise": 1}});
    assert!(sb
        .refused(&with("theme", doc))
        .contains(&"theme.document.surprise".to_string()));
}

#[test]
fn a_refusal_never_prints_a_strangers_escapes() {
    let sb = Sandbox::new();
    for doc in [
        json!({"name": "x", "\u{1b}[2Jkey": 1}),
        json!({"name": "x", "\u{1b}[2Jkey": null}),
        json!({"name": "x", "light": {"\u{1b}]52;c;eA==\u{7}": "#111111"}}),
        json!({"name": "x", "title": "\u{1b}[2J"}),
    ] {
        let look = with("theme", json!({"document": doc}));
        let o = sb.run(&["look", "show", "-"], &look);
        assert_eq!(o.status.code(), Some(1), "{o:?}");
        let out = [o.stdout, o.stderr].concat();
        assert!(
            !out.iter().any(|b| *b == 0x1b || *b == 7),
            "{:?}",
            String::from_utf8_lossy(&out)
        );
    }
}

#[test]
fn names_that_could_leave_the_folder_are_refused() {
    let sb = Sandbox::new();
    for n in [
        "../evil",
        "a/b",
        "..",
        "/etc/passwd",
        "a\\b",
        "",
        "A",
        "-x",
        "con",
        "a\u{0}b",
    ] {
        assert_eq!(sb.refused(&with("name", json!(n))), ["name"], "{n:?}");
    }
    let doc = json!({"document": {"name": "../evil", "title": "x"}});
    assert!(sb
        .refused(&with("theme", doc))
        .contains(&"theme.document.name".to_string()));
}

#[test]
fn values_that_are_not_values_are_refused() {
    let sb = Sandbox::new();
    assert_eq!(sb.refused(&with("mode", json!("sepia"))), ["mode"]);
    assert_eq!(sb.refused(&with("title", json!("a\u{1b}[2J"))), ["title"]);
    assert_eq!(sb.refused(&with("schema", json!(2))), ["schema"]);
    assert_eq!(sb.refused("[]"), ["$"]);
    assert_eq!(sb.refused("not json"), ["$"]);
}

#[test]
fn a_theme_is_held_to_every_theme_rule() {
    let sb = Sandbox::new();
    let toml = include_str!("../../themes/polycarp.toml");
    let mut j = serde_json::to_value(toml::from_str::<toml::Table>(toml).unwrap()).unwrap();
    j["name"] = json!("theirs");
    let good = with("theme", json!({"document": j}));
    let v = sb.json_in(&["look", "show", "-"], &good);
    assert_eq!(v["ok"], true, "{v}");
    // Text that can't be read on its background.
    j["light"]["foreground"] = j["light"]["background"].clone();
    let v = sb.json_in(
        &["look", "show", "-"],
        &with("theme", json!({"document": j})),
    );
    assert_eq!(v["error"]["code"], "contrast", "{v}");
    // A theme that leans on one of the person's own.
    sb.ok(&["theme", "create", "base", "--extends", "evening"]);
    let lean = json!({"document": {"name": "theirs", "extends": "base"}});
    assert_eq!(sb.refused(&with("theme", lean)), ["theme.document.extends"]);
    let same = json!({"document": {"name": "evening"}});
    assert_eq!(sb.refused(&with("theme", same)), ["theme.document.name"]);
    assert_eq!(
        sb.refused(&with("theme", json!({"builtin": "nope"}))),
        ["theme.builtin"]
    );
    assert_eq!(
        sb.refused(&with(
            "theme",
            json!({"builtin": "evening", "document": {}})
        )),
        ["theme"]
    );
}

#[test]
fn a_file_over_the_limit_is_refused() {
    let sb = Sandbox::new();
    let f = sb.at("big.polycarp-look");
    fs::File::create(&f)
        .unwrap()
        .set_len(32 * 1024 * 1024 + 1)
        .unwrap();
    assert_eq!(
        sb.no(&["look", "show", &f.display().to_string()]),
        "io_error"
    );
}

#[test]
fn a_look_that_is_fine_is_shown_and_nothing_changes() {
    let sb = Sandbox::new();
    let v = sb.json_in(&["look", "show", "-"], &hostile().to_string());
    assert_eq!(
        (&v["data"]["theme"], &v["data"]["mode"]),
        (&json!("Evening"), &json!("auto"))
    );
    assert_eq!(sb.ok(&["theme", "current"])["theme"], "polycarp");
    assert!(!sb.at("cfg/looks").exists() && !sb.at("cfg/config.toml").exists());
}

#[cfg(unix)]
#[test]
fn links_are_never_followed() {
    let sb = Sandbox::new();
    let f = sb.at("real.polycarp-look");
    fs::write(&f, hostile().to_string()).unwrap();
    sb.ok(&["look", "show", &f.display().to_string()]);
    let link = sb.at("link.polycarp-look");
    std::os::unix::fs::symlink(&f, &link).unwrap();
    assert_eq!(
        sb.no(&["look", "show", &link.display().to_string()]),
        "io_error"
    );
}

#[cfg(unix)]
#[test]
fn a_pipe_or_a_folder_is_not_waited_on() {
    let sb = Sandbox::new();
    let pipe = sb.at("pipe.polycarp-look");
    let made = Command::new("mkfifo").arg(&pipe).status().unwrap();
    assert!(made.success());
    for p in [pipe, sb.at("empty")] {
        assert_eq!(
            sb.no(&["look", "show", &p.display().to_string()]),
            "io_error"
        );
    }
}
