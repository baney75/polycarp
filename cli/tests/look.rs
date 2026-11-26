//! Integration tests for `polycarp look`. Every run gets its own home, config folder and (on Unix) a stand-in for
//! `polycarp-spaces` that keeps its state in files, so nothing real is read or changed.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
    fn text(&self, p: &str) -> Option<String> {
        fs::read_to_string(self.at(p)).ok()
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
        if self.at("polycarp-spaces").exists() {
            c.env("POLYCARP_SPACES_BIN", self.at("polycarp-spaces"));
        }
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
    /// The paths a look file is refused for. Nothing may be saved.
    fn refused(&self, look: &str) -> Vec<String> {
        let v = self.json_in(&["look", "import", "-"], look);
        assert_eq!(v["ok"], false, "not refused: {look}");
        assert!(!self.at("cfg/looks/hostile.polycarp-look").exists());
        let errors = v["error"]["data"]["errors"].as_array().unwrap();
        errors
            .iter()
            .map(|e| e["path"].as_str().unwrap_or_default().to_string())
            .collect()
    }
    fn current(&self) -> Vec<String> {
        let d = self.ok(&["look", "list"]);
        let on = d["looks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| l["current"] == true);
        on.map(|l| l["name"].as_str().unwrap().to_string())
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

fn base64(b: &[u8]) -> String {
    let abc = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = c
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, x)| n | (*x as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= c.len() {
                abc[(n >> (18 - 6 * i)) as usize & 63] as char
            } else {
                '='
            });
        }
    }
    out
}

fn sha(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot much of a picture, but its own bytes say PNG";

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
fn a_look_that_is_fine_is_imported_and_nothing_on_screen_changes() {
    let sb = Sandbox::new();
    let v = sb.json_in(&["look", "import", "-"], &hostile().to_string());
    assert_eq!(v["ok"], true, "{v}");
    assert!(sb.at("cfg/looks/hostile.polycarp-look").exists());
    assert_eq!(sb.ok(&["theme", "current"])["theme"], "polycarp");
    assert!(sb.text("cfg/config.toml").is_none());
    // Not over one that is there, unless asked to.
    let v = sb.json_in(&["look", "import", "-"], &hostile().to_string());
    assert_eq!(v["error"]["code"], "exists");
    let v = sb.json_in(&["look", "import", "-", "--force"], &hostile().to_string());
    assert_eq!(v["ok"], true);
    let v = sb.json_in(
        &["look", "import", "-", "--name", "other"],
        &hostile().to_string(),
    );
    assert_eq!(v["data"]["name"], "other");
}

#[test]
fn unknown_keys_are_refused_with_their_path() {
    let sb = Sandbox::new();
    assert_eq!(sb.refused(&with("command", json!("rm -rf"))), ["command"]);
    assert_eq!(
        sb.refused(&with("accent", json!({"sepia": "#111111"}))),
        ["accent.sepia"]
    );
    assert_eq!(
        sb.refused(&with("surfaces", json!({"bar": {"launch": "x"}}))),
        ["surfaces.bar.launch"]
    );
    assert_eq!(
        sb.refused(&with("surfaces", json!({"plugins": true}))),
        ["surfaces.plugins"]
    );
    assert_eq!(
        sb.refused(&with("paper", json!({"lock": "olive"}))),
        ["paper.lock"]
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
        let v = sb.json_in(
            &["look", "import", "-", "--name", &n.replace('\u{0}', "/")],
            &hostile().to_string(),
        );
        assert_eq!(v["ok"], false, "{n:?}");
        // The file's own name is checked however the file is read, not only when it is imported.
        let f = sb.at("bad.polycarp-look");
        fs::write(&f, with("name", json!(n))).unwrap();
        let f = f.display().to_string();
        assert_eq!(sb.no(&["look", "show", &f]), "invalid_look", "{n:?}");
        assert_eq!(sb.no(&["look", "apply", &f]), "invalid_look", "{n:?}");
    }
    assert_eq!(sb.refused(&with("name", json!("polycarp"))), ["name"]);
    assert!(!sb.at("cfg/looks").exists(), "nothing was written");
    let doc = json!({"document": {"name": "../evil", "title": "x"}});
    assert!(sb
        .refused(&with("theme", doc))
        .contains(&"theme.document.name".to_string()));
}

#[test]
fn settings_that_are_not_looks_are_dropped_with_a_note() {
    let sb = Sandbox::new();
    let s = json!({
        "bar": {"height": 30, "enabled": true, "modules": {"left": ["mark", "custom:steal"]}},
        "search": {"engine": "https://evil.example/?q=%s"}, "newtab": {"searchURL": "https://evil.example", "question": "Password?"},
        "menu": {"hidden": ["update"]}, "rooms": {"root": "/"}, "text": {"verseSource": "/etc/passwd"},
        "desktop": {"scene": "image:/etc/passwd"}, "idle": {"enabled": true, "showMachineName": true},
        "dock": {"tileLabel": "purpose", "restTile": false},
        "tiling": {"enabled": true, "keys": {"toggle": "ctrl+opt+T"}},
    });
    let v = sb.json_in(&["look", "import", "-"], &with("surfaces", s));
    assert_eq!(v["ok"], true, "{v}");
    let notes = v["data"]["notes"].to_string();
    for left in [
        "bar.enabled",
        "custom:steal",
        "search.engine",
        "newtab.searchURL",
        "newtab.question",
        "menu.hidden",
        "rooms.root",
        "text.verseSource",
        "desktop.scene",
        "idle.enabled",
        "idle.showMachineName",
        "dock.tileLabel",
        "dock.restTile",
        "left out tiling:",
    ] {
        assert!(notes.contains(left), "{left} in {notes}");
    }
    let saved: Value =
        serde_json::from_str(&sb.text("cfg/looks/hostile.polycarp-look").unwrap()).unwrap();
    assert_eq!(
        saved["surfaces"],
        json!({"bar": {"height": 30, "modules": {"left": ["mark"]}}})
    );
}

#[test]
fn values_that_name_a_place_or_are_not_values_are_refused() {
    let sb = Sandbox::new();
    for v in [
        "https://evil.example",
        "/etc/passwd",
        "~/x",
        "a/../../b",
        "two\nlines",
        &"x".repeat(200),
    ] {
        let s = json!({"idle": {"style": v}});
        assert_eq!(
            sb.refused(&with("surfaces", s)),
            ["surfaces.idle.style"],
            "{v:?}"
        );
        let s = json!({"bar": {"modules": {"left": [v]}}});
        assert_eq!(
            sb.refused(&with("surfaces", s)),
            ["surfaces.bar.modules.left"],
            "{v:?}"
        );
    }
    for v in [
        json!("custom:steal"),
        json!("image:x.png"),
        json!(true),
        json!(5),
    ] {
        let s = json!({"bar": {"modules": {"left": v}}});
        assert_eq!(
            sb.refused(&with("surfaces", s)),
            ["surfaces.bar.modules.left"],
            "{v}"
        );
    }
    assert_eq!(
        sb.refused(&with("surfaces", json!({"bar": {"height": {"a": 1}}}))),
        ["surfaces.bar.height"]
    );
    assert_eq!(sb.refused(&with("surfaces", json!("x"))), ["surfaces"]);
    assert_eq!(sb.refused(&with("mode", json!("sepia"))), ["mode"]);
    assert_eq!(sb.refused(&with("title", json!("a\u{1b}[2J"))), ["title"]);
    assert_eq!(sb.refused(&with("style", json!(7))), ["style"]);
    assert_eq!(
        sb.refused(&with("style", json!("x".repeat(64 * 1024 + 1)))),
        ["style"]
    );
    assert_eq!(sb.refused(&with("schema", json!(2))), ["schema"]);
    assert_eq!(sb.refused("[]"), ["$"]);
    assert_eq!(sb.refused("not json"), ["$"]);
    for p in ["https://evil.example/x.png", "/etc/passwd", "#12", "nebula"] {
        assert_eq!(
            sb.refused(&with("paper", json!({"all": p}))),
            ["paper.all"],
            "{p}"
        );
    }
}

#[test]
fn pictures_are_checked_by_their_own_bytes() {
    let sb = Sandbox::new();
    let look = |pics: Value, paper: &str| {
        let mut l = hostile();
        l["paper"] = json!({"all": {"picture": paper}});
        l["pictures"] = pics;
        l.to_string()
    };
    let one = |kind: &str, b: &[u8]| json!({sha(b): {"type": kind, "base64": base64(b)}});
    let v = sb.json_in(
        &["look", "import", "-", "--name", "good"],
        &look(one("image/png", PNG), &sha(PNG)),
    );
    assert_eq!(v["ok"], true, "{v}");
    let script = b"#!/bin/sh\nrm -rf ~\n";
    let at = |b: &[u8]| format!("pictures.{}", sha(b));
    assert!(sb
        .refused(&look(one("image/png", script), &sha(script)))
        .contains(&at(script)));
    let svg = b"<svg onload='x()'/>";
    assert!(sb
        .refused(&look(one("image/svg+xml", svg), &sha(svg)))
        .contains(&at(svg)));
    assert!(sb
        .refused(&look(one("image/jpeg", PNG), &sha(PNG)))
        .contains(&format!("{}.type", at(PNG))));
    let wrong = json!({"0".repeat(64): {"type": "image/png", "base64": base64(PNG)}});
    assert!(sb
        .refused(&look(wrong, &"0".repeat(64)))
        .contains(&format!("pictures.{}", "0".repeat(64))));
    for b64 in ["****", "AAA", "AA=A", "A===", "iVBORw0K Ggo="] {
        let p = json!({sha(PNG): {"type": "image/png", "base64": b64}});
        assert!(sb.refused(&look(p, &sha(PNG))).contains(&at(PNG)), "{b64}");
    }
    // Padding in the middle reads as zeros in a loose decoder, which would give these very bytes.
    let zeros = [PNG, &[0, 0, 0]].concat();
    let loose = base64(&zeros).replacen('A', "=", 1);
    assert_ne!(loose, base64(&zeros));
    let p = json!({sha(&zeros): {"type": "image/png", "base64": loose}});
    assert!(sb.refused(&look(p, &sha(&zeros))).contains(&at(&zeros)));
    let mut extra = one("image/png", PNG);
    extra[sha(PNG)]["path"] = json!("/etc/passwd");
    assert!(sb
        .refused(&look(extra, &sha(PNG)))
        .contains(&format!("{}.path", at(PNG))));
    // One no paper uses has no business in the file.
    assert_eq!(
        sb.refused(&with("pictures", one("image/png", PNG))),
        [at(PNG)]
    );
    let mut big = PNG.to_vec();
    big.resize(25 * 1024 * 1024 + 1, 0);
    assert!(
        sb.refused(&look(one("image/png", &big), &sha(&big)))
            .contains(&"$".to_string()),
        "over 32 MB in all"
    );
}

#[test]
fn a_theme_is_held_to_every_theme_rule() {
    let sb = Sandbox::new();
    let toml = include_str!("../../themes/polycarp.toml");
    let mut j = serde_json::to_value(toml::from_str::<toml::Table>(toml).unwrap()).unwrap();
    j["name"] = json!("theirs");
    let good = with("theme", json!({"document": j}));
    let v = sb.json_in(&["look", "import", "-", "--name", "good"], &good);
    assert_eq!(v["ok"], true, "{v}");
    // Text that can't be read on its background.
    j["light"]["foreground"] = j["light"]["background"].clone();
    let v = sb.json_in(
        &["look", "import", "-"],
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

#[cfg(unix)]
#[test]
fn links_are_never_followed() {
    use std::os::unix::fs::symlink;
    let sb = Sandbox::new();
    let f = sb.at("real.polycarp-look");
    fs::write(&f, hostile().to_string()).unwrap();
    symlink(&f, sb.at("link.polycarp-look")).unwrap();
    let link = sb.at("link.polycarp-look").display().to_string();
    assert_eq!(sb.no(&["look", "import", &link]), "io_error");
    assert_eq!(sb.no(&["look", "show", &link]), "io_error");
    let f = f.display().to_string();
    sb.ok(&["look", "import", &f]);
    // Not through a link in the looks folder, nor out through one.
    fs::write(sb.at("secret"), "keep me").unwrap();
    let out = sb.at("out.polycarp-look");
    symlink(sb.at("secret"), &out).unwrap();
    let out = out.display().to_string();
    assert_eq!(
        sb.no(&["look", "export", "hostile", &out, "--force"]),
        "io_error"
    );
    symlink(sb.at("secret"), sb.at("cfg/looks/two.polycarp-look")).unwrap();
    let two = ["look", "import", &f, "--name", "two", "--force"];
    assert_eq!(sb.no(&two), "io_error");
    assert_eq!(sb.no(&["look", "show", "two"]), "io_error");
    assert_eq!(sb.text("secret").unwrap(), "keep me");
    fs::remove_dir_all(sb.at("cfg/looks")).unwrap();
    symlink(sb.at("empty"), sb.at("cfg/looks")).unwrap();
    assert_eq!(
        sb.no(&["look", "import", &f, "--name", "three"]),
        "io_error"
    );
    assert_eq!(fs::read_dir(sb.at("empty")).unwrap().count(), 0);
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
        sb.no(&["look", "import", &f.display().to_string()]),
        "io_error"
    );
}

// Keeping and sharing one's own ------------------------------------------------------------------------------------

#[test]
fn without_spaces_a_look_holds_the_theme() {
    let sb = Sandbox::new();
    sb.ok(&["theme", "create", "base", "--extends", "evening"]);
    sb.ok(&["theme", "set", "base"]);
    sb.ok(&["theme", "change", "light.accent", "#1f3d7a"]);
    sb.ok(&["theme", "create", "mine", "--extends", "base"]);
    sb.ok(&["theme", "set", "mine", "--mode", "dark"]);
    let d = sb.ok(&["look", "save", "evening-mine", "--title", "Evening, mine"]);
    assert!(d["notes"].to_string().contains("theme alone"), "{d}");
    let saved: Value =
        serde_json::from_str(&sb.text("cfg/looks/evening-mine.polycarp-look").unwrap()).unwrap();
    let doc = &saved["theme"]["document"];
    // Whole in itself: what it extended is in it.
    assert_eq!(
        (&doc["extends"], &doc["light"]["accent"]),
        (&Value::Null, &json!("#1f3d7a"))
    );
    assert_eq!(
        (&saved["mode"], &saved["style"], &saved["paper"]),
        (&json!("dark"), &Value::Null, &Value::Null)
    );
    assert_eq!(sb.current(), ["evening-mine"]);
    let row = &sb.ok(&["look", "list"])["looks"][1];
    assert_eq!(
        (&row["name"], &row["problems"]),
        (&json!("evening-mine"), &json!([]))
    );
    let d = sb.ok(&["look", "show", "evening-mine"]);
    assert_eq!(d["changes"], json!([]));
    assert_eq!(d["leaves_alone"], json!(["style", "surfaces", "paper"]));
    assert!(d["colors"]["dark"]["accent"]
        .as_str()
        .unwrap()
        .starts_with('#'));
    let d = sb.ok(&["look", "show", "polycarp"]);
    assert!(
        d["changes"].to_string().contains("mode: auto (now dark)"),
        "{d}"
    );
    assert!(sb.ok(&["look", "list"])["looks"][0]["name"] == "polycarp");
}

#[test]
fn save_writes_over_nothing_unasked() {
    let sb = Sandbox::new();
    assert_eq!(sb.no(&["look", "save", "polycarp"]), "builtin_read_only");
    assert_eq!(sb.no(&["look", "save", "../x"]), "invalid_look");
    sb.ok(&["look", "save", "one", "--title", "The one"]);
    assert_eq!(sb.no(&["look", "save", "one"]), "exists");
    assert_eq!(
        sb.ok(&["look", "save", "one", "--force"])["title"],
        "The one"
    );
}

#[test]
fn export_writes_over_nothing_unasked() {
    let sb = Sandbox::new();
    let one = ["look", "import", "-", "--name", "one"];
    assert_eq!(sb.json_in(&one, &hostile().to_string())["ok"], true);
    let f = sb.at("one.polycarp-look").display().to_string();
    sb.ok(&["look", "export", "one", &f]);
    let saved = sb.text("cfg/looks/one.polycarp-look");
    assert_eq!(sb.text("one.polycarp-look"), saved);
    assert_eq!(sb.no(&["look", "export", "one", &f]), "exists");
    sb.ok(&["look", "export", "one", &f, "--force"]);
    assert_eq!(
        sb.no(&["look", "export", "one", "/tmp/x.txt"]),
        "invalid_args"
    );
    let o = sb.run(&["look", "export", "one", "-"], "");
    assert_eq!(String::from_utf8(o.stdout).ok(), saved);
    assert_eq!(sb.no(&["look", "show", "nope"]), "unknown_look");
}

#[test]
fn a_damaged_look_is_listed_and_not_used() {
    let sb = Sandbox::new();
    let one = ["look", "import", "-", "--name", "one"];
    assert_eq!(sb.json_in(&one, &hostile().to_string())["ok"], true);
    fs::write(sb.at("cfg/looks/bad.polycarp-look"), "{").unwrap();
    fs::write(sb.at("cfg/looks/Not A Name.polycarp-look"), "{}").unwrap();
    let d = sb.ok(&["look", "list"]);
    let rows = d["looks"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["polycarp", "bad", "one"]
    );
    let why = rows[1]["problems"][0].as_str().unwrap();
    let o = sb.run(&["look", "list"], "");
    let text = String::from_utf8(o.stdout).unwrap();
    assert!(
        text.contains("can't be used") && text.contains(why),
        "{text}"
    );
    assert_eq!(sb.no(&["look", "show", "bad"]), "invalid_look");
}

#[test]
fn show_says_what_a_look_holds_and_where_it_was_read() {
    let sb = Sandbox::new();
    let mut l = hostile();
    l["mode"] = json!("dark");
    l["accent"] = json!({"dark": "#a9bb8a"});
    let f = sb.at("sent.polycarp-look");
    fs::write(&f, l.to_string()).unwrap();
    let path = f.display().to_string();
    let here = |d: &Value, source: &str, file: Option<&Path>| {
        assert_eq!(d["source"], source, "{d}");
        assert_eq!(d["file"].as_str().map(Path::new), file, "{d}");
        assert_eq!(
            (&d["theme"], &d["mode"]),
            (&json!("Evening"), &json!("dark"))
        );
        assert_eq!(d["accent"], json!({"light": null, "dark": "#a9bb8a"}));
    };
    // A file that was sent is a file, whatever it calls itself.
    here(&sb.ok(&["look", "show", &path]), "file", Some(&f));
    let saved = sb.at("cfg/looks/hostile.polycarp-look");
    sb.ok(&["look", "import", &path]);
    here(&sb.ok(&["look", "show", &path]), "file", Some(&f));
    here(&sb.ok(&["look", "show", "hostile"]), "saved", Some(&saved));
    let v = sb.json_in(&["look", "show", "-"], &l.to_string());
    here(&v["data"], "stdin", None);
    l["name"] = json!("polycarp");
    fs::write(&f, l.to_string()).unwrap();
    here(&sb.ok(&["look", "show", &path]), "file", Some(&f));
    let d = sb.ok(&["look", "show", "polycarp"]);
    assert_eq!(
        (&d["source"], &d["file"]),
        (&json!("shipped"), &json!(null))
    );
    let o = sb.run(&["look", "show", "hostile"], "");
    let text = String::from_utf8(o.stdout).unwrap();
    assert!(
        text.contains("theme: Evening, mode: dark, dark accent: #a9bb8a"),
        "{text}"
    );
    assert!(text.contains("read from "), "{text}");
    // A stranger's look that calls itself the shipped one is told apart in words too.
    let said = |arg: &str| String::from_utf8(sb.run(&["look", "show", arg], "").stdout).unwrap();
    assert!(
        said(&path).contains(&format!("read from {path}")),
        "{}",
        said(&path)
    );
    assert!(said("polycarp").contains("the look Polycarp ships with"));
    // A file renamed by hand is called what it is listed as.
    let two = sb.at("cfg/looks/two.polycarp-look");
    fs::rename(saved, &two).unwrap();
    let d = sb.ok(&["look", "show", "two"]);
    assert_eq!(d["name"], "two");
    here(&d, "saved", Some(&two));
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

#[test]
fn the_fields_table_covers_the_surfaces_page() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let page = fs::read_to_string(root.join("spaces/docs/surfaces.md")).unwrap();
    let table = fs::read_to_string(root.join("cli/src/look/fields.rs")).unwrap();
    // Rows of the field tables: | `bar.height` | ...
    let mut seen = 0;
    for line in page.lines() {
        let Some(path) = line.strip_prefix("| `").and_then(|l| l.split('`').next()) else {
            continue;
        };
        if !path.contains('.')
            || path.contains(' ')
            || path.contains('<')
            || path.ends_with(".paper")
        {
            continue;
        }
        seen += 1;
        // Its own row, or a group's left out whole.
        let tight: String = table.split_whitespace().collect();
        let mut groups = path.match_indices('.').map(|(i, _)| &path[..i]);
        assert!(
            tight.contains(&format!("(\"{path}\","))
                || groups.any(|g| tight.contains(&format!("(\"{g}\",false,"))),
            "{path} is not in look/fields.rs: say whether a look holds it"
        );
    }
    assert!(seen > 25, "the page's tables were not read: {seen}");
    // And a kept field is one Polycarp still has: reading one that is gone fails, and takes `save` with it.
    let tight: String = table.split_whitespace().collect();
    let kept: Vec<&str> = tight
        .split("(\"")
        .filter_map(|r| r.split_once("\",true,"))
        .map(|(path, _)| path)
        .collect();
    assert!(kept.len() > 15, "the table was not read: {kept:?}");
    for path in kept {
        assert!(
            page.contains(&format!("| `{path}`")),
            "a look holds {path}, which spaces/docs/surfaces.md doesn't have"
        );
    }
}

// With Polycarp Spaces ---------------------------------------------------------------------------------------------

/// A stand-in for `polycarp-spaces` that keeps each setting and paper in a file of its own under `live/`, and the
/// style sheet in the config folder. A line in `fail` such as `paper set` refuses that command once; a setting named
/// in `unknown` is one it doesn't know, as an older one wouldn't.
#[cfg(unix)]
fn with_spaces() -> Sandbox {
    use std::os::unix::fs::PermissionsExt;
    let sb = Sandbox::new();
    let script = r#"#!/bin/sh
PATH=/usr/bin:/bin
S='@ROOT@/live'; C='@ROOT@/cfg/style.css'
no() { printf '{"ok":false,"error":{"code":"%s","message":"%s","data":{"errors":[{"path":"$","message":"%s"}]}}}' "$1" "$2" "$2"; exit 1; }
ok() { printf '{"ok":true,"data":%s}' "$1"; exit 0; }
echo "$*" >> '@ROOT@/calls'
if [ -f '@ROOT@/fail' ] && [ "$1 $2" = "$(cat '@ROOT@/fail')" ]; then rm '@ROOT@/fail'; no write_failed "told to fail"; fi
if [ "$1 $2" = "surfaces get" ] && grep -qx "$3" '@ROOT@/unknown' 2>/dev/null; then no unknown_path "no field $3"; fi
case "$1 $2" in
"style path") ok "{\"file\":\"$C\"}" ;;
"style show") if [ -f "$C" ]; then ok "{\"exists\":true,\"text\":\"$(sed 's/"/\\"/g' "$C" | awk '{printf "%s\\n", $0}')\"}"; else ok '{"exists":false,"text":""}'; fi ;;
"style check") grep -q 'url(' "$3" && no invalid_style "line 1: \u001b[2Jnot a color"; ok '{}' ;;
"style reset") mv "$C" "$C.bak"; ok "{\"backup\":\"$C.bak\"}" ;;
"surfaces get") if [ -f "$S/$3" ]; then ok "{\"set\":true,\"value\":$(cat "$S/$3")}"; else ok '{"set":false,"value":null}'; fi ;;
"surfaces set")
  if [ "$3" = bar.modules ]; then
    rm -f "$S"/bar.modules.*
    for r in left center right; do
      v=$(printf '%s' "$4" | sed -n "s/.*\"$r\":\(\[[^]]*\]\).*/\1/p"); [ -n "$v" ] && printf '%s' "$v" > "$S/bar.modules.$r"
    done
  else printf '%s' "$4" > "$S/$3"; fi; ok '{}' ;;
"surfaces reset") rm -f "$S/$3" "$S/$3".*; ok '{}' ;;
"surfaces validate") grep -q 'bogus' "$3" && no invalid_value "bar.style must be islands"; grep -q 'newer' "$3" && ok '{"warnings":[{"path":"bar.hourNames","message":"not a field this build knows"}]}'; ok '{"warnings":[]}' ;;
"surfaces schema") ok '{"properties":{"bar":{"properties":{"modules":{"properties":{"left":{"default":["mark","workspaces"]},"center":{"default":["clock"]},"right":{"default":["status"]}}}}}}}' ;;
"paper get")
  one() { v=$(cat "$S/paper.$1"); case "$v" in /*) printf '{"value":"picture:p","picture":"%s","from":"%s"}' "$v" "$2" ;; *) printf '{"value":"%s","from":"%s"}' "$v" "$2" ;; esac; }
  place() { if [ -f "$S/paper.$1" ]; then one "$1" "$1.paper"; elif [ -f "$S/paper.all" ]; then one all paper; else printf '{"value":null,"from":null}'; fi; }
  if [ -f "$S/paper.all" ]; then all=$(one all paper); else all=null; fi
  ok "{\"paper\":$all,\"desktop\":$(place desktop),\"newtab\":$(place newtab),\"idle\":$(place idle)}" ;;
"paper set")
  v=$3; case "$v" in /*) mkdir -p '@ROOT@/store'; cp "$v" '@ROOT@/store/' || no io "copy"; v="@ROOT@/store/$(basename "$v")" ;; esac
  if [ "$4" = --on ]; then printf '%s' "$v" > "$S/paper.$5"; else rm -f "$S"/paper.*; printf '%s' "$v" > "$S/paper.all"; fi; ok '{}' ;;
"paper reset") rm -f "$S"/paper.*; ok '{}' ;;
*) echo "usage: polycarp-spaces" >&2; exit 2 ;;
esac
"#;
    let script = script.replace("@ROOT@", &sb.root.display().to_string());
    fs::write(sb.at("polycarp-spaces"), script).unwrap();
    fs::set_permissions(sb.at("polycarp-spaces"), fs::Permissions::from_mode(0o755)).unwrap();
    sb
}

/// A whole look of the person's: their own theme, sheet, bar and paper, and things a look leaves alone.
#[cfg(unix)]
fn dress(sb: &Sandbox) {
    sb.ok(&["theme", "create", "mine", "--extends", "evening"]);
    sb.ok(&["theme", "set", "mine", "--mode", "dark"]);
    sb.ok(&["theme", "accent", "#7aa2f7"]);
    let put = |f: &str, v: &str| fs::write(sb.at(f), v).unwrap();
    put(
        "cfg/style.css",
        "/* \"mine\" */\nbar { border-radius: 6px; }\n",
    );
    put("live/bar.height", "32");
    put("live/bar.style", "\"solid\"");
    put("live/bar.modules.left", "[\"mark\",\"custom:me\"]");
    put("live/search.engine", "\"kagi\"");
    fs::write(sb.at("pic.png"), PNG).unwrap();
    put("live/paper.all", &sb.at("pic.png").display().to_string());
    put("live/paper.idle", "olive");
}

/// Everything a look can change, byte for byte (a picture by what is in it).
#[cfg(unix)]
fn whole(sb: &Sandbox) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for f in ["cfg/config.toml", "cfg/style.css", "cfg/current/theme.json"] {
        out.push((f.to_string(), fs::read(sb.at(f)).unwrap_or_default()));
    }
    for d in ["live", "cfg/themes"] {
        for e in fs::read_dir(sb.at(d)).into_iter().flatten().flatten() {
            let mut b = fs::read(e.path()).unwrap();
            if b.starts_with(b"/") {
                b = fs::read(String::from_utf8(b).unwrap()).unwrap();
            }
            out.push((format!("{d}/{}", e.file_name().to_string_lossy()), b));
        }
    }
    out.sort();
    out
}

#[cfg(unix)]
#[test]
fn save_reads_everything_and_leaves_out_what_is_the_persons_own() {
    let sb = with_spaces();
    dress(&sb);
    let d = sb.ok(&["look", "save", "mine"]);
    assert!(d["notes"].to_string().contains("custom:me"), "{d}");
    assert!(d.get("current").is_none(), "{d}");
    let l: Value = serde_json::from_str(&sb.text("cfg/looks/mine.polycarp-look").unwrap()).unwrap();
    assert_eq!(l["style"], json!(sb.text("cfg/style.css").unwrap()));
    assert_eq!(
        l["surfaces"],
        json!({"bar": {"height": 32, "style": "solid", "modules": {"left": ["mark"]}}})
    );
    assert_eq!(
        l["paper"],
        json!({"all": {"picture": sha(PNG)}, "idle": "olive"})
    );
    assert_eq!(
        l["pictures"],
        json!({sha(PNG): {"type": "image/png", "base64": base64(PNG)}})
    );
    assert_eq!(l["accent"]["dark"], "#7aa2f7");
    assert!(
        !l.to_string().contains("kagi") && !l.to_string().contains(&sb.root.display().to_string())
    );
    assert_eq!(sb.current(), ["mine"]);
    let d = sb.ok(&["look", "show", "polycarp"]);
    let changes = d["changes"].to_string();
    for c in [
        "theme: Polycarp (now ",
        "mode: auto (now dark)",
        "style sheet: none (now one of 2 lines)",
        "bar.height: its default (now 32)",
        "paper: none (now a png picture",
        "paper on the idle screen: none (now olive)",
    ] {
        assert!(changes.contains(c), "{c} in {changes}");
    }
}

#[cfg(unix)]
#[test]
fn polycarps_own_checks_run_before_a_look_is_kept() {
    let sb = with_spaces();
    let v = sb.json_in(
        &["look", "import", "-"],
        &with("style", json!("bar { color: url(https://x); }")),
    );
    assert_eq!(
        (
            &v["error"]["code"],
            &v["error"]["data"]["errors"][0]["path"]
        ),
        (&json!("invalid_look"), &json!("style"))
    );
    // Nor does a refusal that quotes the sheet print its escapes.
    let o = sb.run(
        &["look", "import", "-"],
        &with("style", json!("bar { color: url(https://x); }")),
    );
    let out = String::from_utf8([o.stdout, o.stderr].concat()).unwrap();
    assert!(
        out.contains("not a color") && !out.contains('\u{1b}'),
        "{out:?}"
    );
    let s = json!({"bar": {"style": "bogus"}});
    assert_eq!(sb.refused(&with("surfaces", s)), ["surfaces"]);
    let s = json!({"bar": {"style": "newer"}});
    assert_eq!(sb.refused(&with("surfaces", s)), ["surfaces.bar.hourNames"]);
    fs::write(sb.at("cfg/style.css"), "bar { color: url(x); }").unwrap();
    assert_eq!(sb.no(&["look", "save", "mine"]), "invalid_look");
    assert!(!sb.at("cfg/looks/mine.polycarp-look").exists());
    let left: Vec<_> = fs::read_dir(sb.at("cfg/looks"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert!(left.is_empty(), "work files are gone: {left:?}");
}

#[cfg(unix)]
#[test]
fn a_look_is_in_force_only_when_every_part_of_it_is() {
    let sb = with_spaces();
    dress(&sb);
    sb.ok(&["look", "save", "mine"]);
    for (file, other) in [
        ("cfg/style.css", "bar { border-radius: 2px; }\n"),
        ("live/bar.height", "40"),
        ("live/paper.idle", "water"),
    ] {
        let was = sb.text(file).unwrap();
        assert_eq!(sb.current(), ["mine"], "before {file}");
        fs::write(sb.at(file), other).unwrap();
        assert!(sb.current().is_empty(), "{file} differs");
        fs::write(sb.at(file), was).unwrap();
    }
    sb.ok(&["theme", "set", "mine", "--mode", "light"]);
    assert!(sb.current().is_empty(), "the mode differs");
    // What a look holds can still be shown when the present can't be read.
    fs::write(sb.at("fail"), "style show").unwrap();
    let v = sb.json(&["look", "show", "mine"]);
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(
        (&v["data"]["changes"], &v["data"]["current"]),
        (&Value::Null, &json!(false))
    );
    assert!(
        v["data"]["warnings"].to_string().contains("can't be read"),
        "{v}"
    );
}

#[cfg(unix)]
#[test]
fn a_look_comes_back_byte_for_byte() {
    let sb = with_spaces();
    dress(&sb);
    let was = whole(&sb);
    sb.ok(&["look", "save", "mine"]);
    let file = sb.at("sent.polycarp-look").display().to_string();
    sb.ok(&["look", "export", "mine", &file]);
    // Change everything.
    let d = sb.ok(&["look", "apply", "polycarp"]);
    assert_eq!(d["changed"], true);
    assert_eq!(sb.current(), ["polycarp"]);
    assert_eq!(sb.text("cfg/style.css"), None);
    assert_eq!(
        sb.text("live/search.engine").unwrap(),
        "\"kagi\"",
        "not a look's to change"
    );
    assert_eq!(
        sb.text("live/bar.modules.left").unwrap(),
        r#"["mark","custom:me","workspaces"]"#,
        "theirs stays"
    );
    assert!(!sb.at("live/paper.all").exists() && !sb.at("live/paper.idle").exists());
    fs::remove_file(sb.at("pic.png")).unwrap();
    // And put it on again, from the file.
    sb.ok(&["look", "apply", &file]);
    fs::write(sb.at("pic.png"), PNG).unwrap();
    assert_eq!(whole(&sb), was);
    sb.ok(&["look", "save", "again", "--title", "Mine"]);
    let again = sb
        .text("cfg/looks/again.polycarp-look")
        .unwrap()
        .replace("\"again\"", "\"mine\"");
    assert_eq!(Some(again), sb.text("cfg/looks/mine.polycarp-look"));
}

#[cfg(unix)]
#[test]
fn someone_elses_look_brings_its_theme_and_never_replaces_yours() {
    let (a, b) = (with_spaces(), with_spaces());
    dress(&a);
    a.ok(&["look", "save", "mine"]);
    let file = a.at("cfg/looks/mine.polycarp-look").display().to_string();
    b.ok(&["look", "apply", &file]);
    assert_eq!(b.ok(&["theme", "current"])["theme"], "mine");
    b.ok(&["look", "undo"]);
    assert!(
        !b.at("cfg/themes/mine.toml").exists(),
        "undo takes the theme it brought away"
    );
    // Unless it was edited, or another theme is built on it.
    b.ok(&["look", "apply", &file]);
    let edited = format!("{}# my edit\n", b.text("cfg/themes/mine.toml").unwrap());
    fs::write(b.at("cfg/themes/mine.toml"), &edited).unwrap();
    b.ok(&["look", "undo"]);
    assert_eq!(b.text("cfg/themes/mine.toml"), Some(edited));
    fs::remove_file(b.at("cfg/themes/mine.toml")).unwrap();
    b.ok(&["look", "apply", &file]);
    b.ok(&["theme", "create", "child", "--extends", "mine"]);
    b.ok(&["look", "undo"]);
    assert!(b.at("cfg/themes/mine.toml").exists(), "child extends it");
    b.ok(&["theme", "delete", "child"]);
    b.ok(&["theme", "delete", "mine"]);
    // Their own theme of that name stays as it is.
    b.ok(&["theme", "create", "mine", "--extends", "parchment"]);
    let own = b.text("cfg/themes/mine.toml");
    let d = b.ok(&["look", "apply", &file]);
    assert!(d["notes"].to_string().contains("mine-look"), "{d}");
    assert_eq!(b.ok(&["theme", "current"])["theme"], "mine-look");
    assert_eq!(b.text("cfg/themes/mine.toml"), own);
    // Once is enough: the same look again finds the theme it brought.
    b.ok(&["theme", "set", "evening"]);
    b.ok(&["look", "apply", &file]);
    assert!(!b.at("cfg/themes/mine-look-2.toml").exists());
}

#[cfg(unix)]
#[test]
fn undo_goes_back_and_undo_again_comes_forward() {
    let sb = with_spaces();
    assert_eq!(sb.no(&["look", "undo"]), "nothing_to_undo");
    assert_eq!(sb.ok(&["look", "list"])["can_undo"], false);
    let fresh = whole(&sb);
    sb.ok(&["theme", "current"]);
    dress(&sb);
    let was = whole(&sb);
    sb.json_in(&["look", "import", "-"], &json!({"schema": 1, "name": "plain", "theme": {"builtin": "parchment"}, "mode": "light",
        "style": "bar { color: #ffffff; }\n", "surfaces": {"bar": {"height": 24}}, "paper": {"desktop": "#112233"}}).to_string());
    sb.ok(&["look", "apply", "plain"]);
    assert_eq!(sb.ok(&["look", "list"])["can_undo"], true);
    let then = whole(&sb);
    assert_eq!(sb.text("live/paper.desktop").unwrap(), "#112233");
    for _ in 0..2 {
        let d = sb.ok(&["look", "undo"]);
        assert_eq!(whole(&sb), was, "{d}");
        sb.ok(&["look", "undo"]);
        assert_eq!(whole(&sb), then);
    }
    assert_eq!(
        fs::read_dir(sb.at("cfg/looks/.history")).unwrap().count(),
        1
    );
    // The shipped look is undoable too, and the sheet written by hand is in a backup besides.
    sb.ok(&["look", "undo"]);
    sb.ok(&["look", "apply", "polycarp"]);
    assert_eq!(
        sb.text("cfg/style.css.bak").unwrap(),
        "/* \"mine\" */\nbar { border-radius: 6px; }\n"
    );
    sb.ok(&["look", "undo"]);
    assert_eq!(whole(&sb), was);
    // What was never there is not there again.
    let sb = with_spaces();
    sb.ok(&["theme", "current"]);
    sb.json_in(&["look", "import", "-"], &hostile().to_string());
    sb.ok(&["look", "apply", "hostile"]);
    sb.ok(&["look", "undo"]);
    assert!(!sb.at("cfg/config.toml").exists());
    assert_eq!(fresh.iter().filter(|(_, b)| !b.is_empty()).count(), 0);
}

#[cfg(unix)]
#[test]
fn an_undone_theme_that_was_off_is_off_again_and_edits_are_kept() {
    let sb = with_spaces();
    dress(&sb);
    sb.ok(&["theme", "off"]);
    let d = sb.ok(&["look", "apply", "polycarp"]);
    assert!(d["notes"].to_string().contains("the theme was off"), "{d}");
    assert!(sb.at("cfg/current/theme.json").exists());
    sb.ok(&["look", "undo"]);
    assert!(!sb.at("cfg/current/theme.json").exists());
    sb.ok(&["theme", "on"]);
    sb.ok(&["look", "apply", "polycarp"]);
    let edited = format!("{}# my edit\n", sb.text("cfg/themes/mine.toml").unwrap());
    fs::write(sb.at("cfg/themes/mine.toml"), &edited).unwrap();
    let d = sb.ok(&["look", "undo"]);
    assert!(d["notes"].to_string().contains("edited since"), "{d}");
    assert_eq!(sb.text("cfg/themes/mine.toml"), Some(edited));
}

#[cfg(unix)]
#[test]
fn a_step_that_fails_puts_everything_back() {
    let sb = with_spaces();
    dress(&sb);
    let was = whole(&sb);
    let history = sb.ok(&["theme", "history"]);
    for (fail, step) in [
        ("style reset", "style"),
        ("surfaces reset", "surfaces"),
        ("paper reset", "paper"),
    ] {
        fs::write(sb.at("fail"), fail).unwrap();
        let v = sb.json(&["look", "apply", "polycarp"]);
        assert_eq!(v["error"]["code"], "step_failed", "{v}");
        let m = v["error"]["message"].as_str().unwrap();
        assert!(
            m.starts_with(&format!(
                "the {step} step failed, so everything was put back"
            )),
            "{m}"
        );
        assert_eq!(whole(&sb), was, "after {step}");
        assert_eq!(
            sb.ok(&["theme", "history"]),
            history,
            "the theme change is not in history"
        );
        assert_eq!(
            sb.no(&["look", "undo"]),
            "nothing_to_undo",
            "nothing happened, so there is nothing to undo"
        );
    }
    // A sheet that is a link, such as into a person's dotfiles, is neither replaced nor followed.
    fs::rename(sb.at("cfg/style.css"), sb.at("sheet.css")).unwrap();
    std::os::unix::fs::symlink(sb.at("sheet.css"), sb.at("cfg/style.css")).unwrap();
    assert_eq!(sb.no(&["look", "apply", "polycarp"]), "step_failed");
    assert!(sb.at("cfg/style.css").is_symlink());
    assert_eq!(whole(&sb), was);
    fs::remove_file(sb.at("cfg/style.css")).unwrap();
    fs::rename(sb.at("sheet.css"), sb.at("cfg/style.css")).unwrap();
    // The same when undoing: what was there stays there.
    sb.ok(&["look", "apply", "polycarp"]);
    let then = whole(&sb);
    fs::write(sb.at("fail"), "paper set").unwrap();
    assert_eq!(sb.no(&["look", "undo"]), "step_failed");
    assert_eq!(whole(&sb), then);
    sb.ok(&["look", "undo"]);
    assert_eq!(whole(&sb), was);
}

#[cfg(unix)]
#[test]
fn a_look_is_checked_whole_before_anything_changes() {
    let sb = with_spaces();
    dress(&sb);
    let was = whole(&sb);
    let calls = |sb: &Sandbox| sb.text("calls").unwrap_or_default();
    for (key, v) in [
        ("surfaces", json!({"bar": {"style": "bogus"}})),
        ("style", json!("bar { color: url(x); }")),
    ] {
        let f = sb.at("bad.polycarp-look");
        fs::write(&f, with(key, v)).unwrap();
        assert_eq!(
            sb.no(&["look", "apply", &f.display().to_string()]),
            "invalid_look"
        );
        assert_eq!(whole(&sb), was);
    }
    assert!(!calls(&sb).contains(" set ") && !calls(&sb).contains(" reset"));
    // A dry run says what would change, and changes nothing.
    let d = sb.ok(&["look", "apply", "polycarp", "--dry-run"]);
    assert_eq!(
        (&d["dry_run"], &d["changed"]),
        (&json!(true), &json!(false))
    );
    assert!(
        d["changes"].to_string().contains("style sheet: none"),
        "{d}"
    );
    assert_eq!(whole(&sb), was);
    assert_eq!(sb.no(&["look", "undo"]), "nothing_to_undo");
    // What is already in force is left alone, and is no step to undo.
    sb.ok(&["look", "save", "mine"]);
    assert_eq!(sb.ok(&["look", "apply", "mine"])["changed"], false);
    assert_eq!(sb.no(&["look", "undo"]), "nothing_to_undo");
}

#[cfg(unix)]
#[test]
fn the_newest_ten_are_kept() {
    let sb = with_spaces();
    sb.json_in(&["look", "import", "-"], &hostile().to_string());
    for i in 0..12 {
        sb.ok(&[
            "look",
            "apply",
            if i % 2 == 0 { "hostile" } else { "polycarp" },
        ]);
    }
    let mut names: Vec<_> = fs::read_dir(sb.at("cfg/looks/.history"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(
        (names.len(), names[0].as_str(), names[9].as_str()),
        (10, "00000003.json", "00000012.json")
    );
    fs::write(sb.at("cfg/looks/.history/00000012.json"), "{").unwrap();
    assert_eq!(sb.no(&["look", "undo"]), "io_error");
}

#[test]
fn without_spaces_the_theme_part_still_applies() {
    let sb = Sandbox::new();
    let l = json!({"schema": 1, "name": "full", "theme": {"builtin": "evening"}, "style": "bar { color: #fff; }",
        "surfaces": {"bar": {"height": 30}}, "paper": {"all": "olive"}});
    let v = sb.json_in(&["look", "import", "-"], &l.to_string());
    assert!(
        v["data"]["notes"].to_string().contains("were not checked"),
        "{v}"
    );
    let d = sb.ok(&["look", "apply", "full"]);
    assert!(d["notes"].to_string().contains("wait for it"), "{d}");
    assert_eq!(sb.ok(&["theme", "current"])["theme"], "evening");
    sb.ok(&["look", "undo"]);
    assert_eq!(sb.ok(&["theme", "current"])["theme"], "polycarp");
}

#[cfg(unix)]
#[test]
fn what_no_look_holds_stays_as_the_person_has_it() {
    let sb = with_spaces();
    dress(&sb);
    fs::write(sb.at("live/desktop.scene"), "\"image:sunset\"").unwrap();
    sb.ok(&["look", "apply", "polycarp"]);
    assert_eq!(
        sb.text("live/desktop.scene").as_deref(),
        Some("\"image:sunset\"")
    );
    assert!(
        sb.text("live/bar.height").is_none(),
        "the look's own settings still apply"
    );
}

#[test]
fn delete_removes_a_saved_look_and_asks_for_the_one_in_force() {
    let sb = Sandbox::new();
    sb.ok(&["look", "save", "one"]);
    assert_eq!(sb.no(&["look", "delete", "one"]), "current_look");
    sb.ok(&["theme", "set", "evening"]);
    sb.ok(&["look", "delete", "one"]);
    assert_eq!(sb.no(&["look", "delete", "one"]), "unknown_look");
    assert_eq!(sb.no(&["look", "delete", "polycarp"]), "builtin_read_only");
    sb.ok(&["look", "save", "two"]);
    sb.ok(&["look", "delete", "two", "--force"]);
    fs::write(sb.at("cfg/looks/bad.polycarp-look"), "{").unwrap();
    sb.ok(&["look", "delete", "bad"]);
}

#[cfg(unix)]
#[test]
fn undo_puts_back_only_the_parts_the_look_changed() {
    let sb = with_spaces();
    dress(&sb);
    let l = json!({"schema": 1, "name": "plain", "theme": {"builtin": "evening"}});
    let v = sb.json_in(&["look", "import", "-"], &l.to_string());
    assert_eq!(v["ok"], true, "{v}");
    sb.ok(&["look", "apply", "plain"]);
    // A theme alone keeps no picture to put back.
    let kept = fs::read_dir(sb.at("cfg/looks/.history"))
        .unwrap()
        .flatten()
        .map(|e| fs::read_to_string(e.path()).unwrap())
        .collect::<String>();
    assert!(!kept.contains(&base64(PNG)), "{kept}");
    fs::write(sb.at("live/bar.height"), "30").unwrap();
    sb.ok(&["look", "undo"]);
    assert_eq!(sb.text("live/bar.height").as_deref(), Some("30"));
    assert_eq!(sb.ok(&["theme", "current"])["theme"], "mine");
}

#[cfg(unix)]
#[test]
fn no_look_is_in_force_while_the_theme_is_off() {
    let sb = with_spaces();
    dress(&sb);
    sb.ok(&["look", "save", "mine"]);
    sb.ok(&["theme", "off"]);
    assert!(sb.current().is_empty());
    let d = sb.ok(&["look", "show", "mine"]);
    assert!(
        d["changes"]
            .to_string()
            .contains("theme switch: on (now off)"),
        "{d}"
    );
    // So applying it turns the theme on, where it found nothing to change before.
    assert_eq!(sb.ok(&["look", "apply", "mine"])["changed"], true);
    assert_eq!(sb.current(), ["mine"]);
}

#[cfg(unix)]
#[test]
fn delete_asks_when_what_is_in_force_cant_be_read() {
    let sb = with_spaces();
    sb.ok(&["look", "save", "one"]);
    fs::write(sb.at("fail"), "style show").unwrap();
    assert_eq!(sb.no(&["look", "delete", "one"]), "current_look");
    assert!(sb.at("cfg/looks/one.polycarp-look").exists());
    fs::write(sb.at("fail"), "style show").unwrap();
    sb.ok(&["look", "delete", "one", "--force"]);
}

#[cfg(unix)]
#[test]
fn a_setting_an_older_spaces_does_not_know_is_left_out() {
    let sb = with_spaces();
    dress(&sb);
    fs::write(sb.at("unknown"), "bar.height\n").unwrap();
    let d = sb.ok(&["look", "save", "mine"]);
    assert!(
        d["notes"].to_string().contains("doesn't know bar.height"),
        "{d}"
    );
    let l: Value = serde_json::from_str(&sb.text("cfg/looks/mine.polycarp-look").unwrap()).unwrap();
    assert_eq!(
        l["surfaces"],
        json!({"bar": {"style": "solid", "modules": {"left": ["mark"]}}})
    );
    assert_eq!(sb.current(), ["mine"]);
    // A look that holds the setting says this Spaces can't set it, and shows no change to it.
    fs::remove_file(sb.at("unknown")).unwrap();
    fs::write(sb.at("live/bar.height"), "32").unwrap();
    sb.ok(&["look", "save", "tall"]);
    fs::write(sb.at("unknown"), "bar.height\n").unwrap();
    let d = sb.ok(&["look", "show", "tall"]);
    assert!(!d["changes"].to_string().contains("bar.height"), "{d}");
    assert!(
        d["notes"]
            .to_string()
            .contains("doesn't know bar.height, so applying this look needs a newer one"),
        "{d}"
    );
    // Any other refusal still stops it.
    fs::write(sb.at("fail"), "surfaces get").unwrap();
    assert_eq!(sb.no(&["look", "save", "other"]), "refused");
}

#[cfg(unix)]
#[test]
fn pictures_too_big_for_a_look_are_named_with_the_limit() {
    let sb = with_spaces();
    for (f, b) in [("a.png", 1), ("b.png", 2)] {
        let mut pic = PNG.to_vec();
        pic.resize(13 * 1024 * 1024, b);
        fs::write(sb.at(f), pic).unwrap();
    }
    for (place, f) in [("all", "a.png"), ("idle", "b.png")] {
        let file = sb.at(f).display().to_string();
        fs::write(sb.at(&format!("live/paper.{place}")), file).unwrap();
    }
    let v = sb.json(&["look", "save", "mine"]);
    let e = v["error"].to_string();
    assert_eq!(v["error"]["code"], "invalid_look", "{e}");
    // One picture on two places is named once, since the file holds it once.
    fs::write(
        sb.at("live/paper.desktop"),
        sb.at("a.png").display().to_string(),
    )
    .unwrap();
    let v = sb.json(&["look", "save", "mine"]);
    let e = v["error"].to_string();
    for part in [
        "over the 32 MB",
        "a.png is 13.0 MB (paper.all, paper.desktop)",
        "b.png is 13.0 MB (paper.idle)",
    ] {
        assert!(e.contains(part), "{part} in {e}");
    }
    assert!(!sb.at("cfg/looks/mine.polycarp-look").exists());
    fs::remove_file(sb.at("live/paper.idle")).unwrap();
    sb.ok(&["look", "save", "mine"]);
}

#[test]
fn save_refuses_a_theme_that_fails_the_health_check() {
    let sb = Sandbox::new();
    sb.ok(&["theme", "create", "mine", "--extends", "evening"]);
    sb.ok(&["theme", "set", "mine"]);
    let head = "name = \"mine\"\ntitle = \"Mine\"\n";
    for (body, why) in [
        // Text that can't be read on its background.
        (
            "extends = \"evening\"\n[light]\nforeground = \"#eeeeee\"\n",
            "light.foreground on light.background is 1.02, needs 4.5",
        ),
        // A role it doesn't have.
        (
            "[light]\nforeground = \"#272e37\"\n",
            "light.background: missing",
        ),
    ] {
        fs::write(sb.at("cfg/themes/mine.toml"), format!("{head}{body}")).unwrap();
        let v = sb.json(&["look", "save", "mine"]);
        assert_eq!(v["error"]["code"], "invalid_theme", "{v}");
        assert!(v["error"].to_string().contains(why), "{why} in {v}");
        assert!(!sb.at("cfg/looks/mine.polycarp-look").exists());
    }
}

#[test]
fn each_field_is_listed_once() {
    // Two branches can each add the same row in different places and still merge clean.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let table = fs::read_to_string(root.join("cli/src/look/fields.rs")).unwrap();
    let tight: String = table.split_whitespace().collect();
    let mut seen = std::collections::HashSet::new();
    for row in tight.split("(\"").skip(1) {
        let Some((path, rest)) = row.split_once('"') else {
            continue;
        };
        if !rest.starts_with(",true,") && !rest.starts_with(",false,") {
            continue;
        }
        assert!(
            seen.insert(path.to_string()),
            "{path} is listed twice in look/fields.rs"
        );
    }
    assert!(seen.len() > 25, "the table was not read: {}", seen.len());
}
