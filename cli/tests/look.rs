//! Integration tests for `polycarp look`. Every run gets its own home and config folder, so nothing real is read or
//! changed.

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
        assert!(
            table.contains(&format!("\"{path}\"")),
            "{path} is not in look/fields.rs: say whether a look holds it"
        );
    }
    assert!(seen > 25, "the page's tables were not read: {seen}");
}
