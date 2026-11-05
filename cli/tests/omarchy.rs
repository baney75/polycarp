//! `polycarp theme follow`: every test gets its own HOME and config folder, so nothing real is
//! touched. The fixtures are the colors.toml of every theme bundled with Omarchy 4.0.4.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/omarchy")
}

fn fixture_names() -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(fixtures())
        .unwrap()
        .filter_map(|e| {
            let e = e.unwrap();
            e.path()
                .join("colors.toml")
                .is_file()
                .then(|| e.file_name().to_string_lossy().into_owned())
        })
        .collect();
    v.sort();
    v
}

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new() -> Sandbox {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("omarchy-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for d in ["home", "cwd", "tmp"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Sandbox { root }
    }
    fn home(&self) -> PathBuf {
        self.root.join("home")
    }
    fn cfg(&self) -> PathBuf {
        self.root.join("cfg")
    }
    fn state(&self) -> PathBuf {
        self.home().join(".local/state/omarchy")
    }
    fn hook(&self) -> PathBuf {
        self.home()
            .join(".config/omarchy/hooks/theme-set.d/polycarp")
    }
    /// Makes this an Omarchy machine whose current theme has these colors.
    fn omarchy(&self, name: &str, colors: &str) {
        let dir = self.state().join("current/theme");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("colors.toml"), colors).unwrap();
        fs::write(self.state().join("current/theme.name"), format!("{name}\n")).unwrap();
    }
    fn omarchy_fixture(&self, name: &str) {
        let colors = fs::read_to_string(fixtures().join(name).join("colors.toml")).unwrap();
        self.omarchy(name, &colors);
    }
    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_polycarp"));
        c.env_clear()
            .env("HOME", self.home())
            .env("POLYCARP_CONFIG_DIR", self.cfg())
            .env("TMPDIR", self.root.join("tmp"))
            .current_dir(self.root.join("cwd"))
            .args(args);
        c
    }
    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().unwrap()
    }
    fn json(&self, args: &[&str]) -> (bool, Value) {
        let mut a = args.to_vec();
        a.push("--json");
        let out = self.run(&a);
        let v: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)));
        (out.status.success(), v)
    }
    fn theme_file(&self) -> String {
        fs::read_to_string(self.cfg().join("themes/omarchy.toml")).unwrap()
    }
    fn exported(&self) -> Value {
        let (ok, v) = self.json(&["theme", "export", "json"]);
        assert!(ok, "{v}");
        v["data"].clone()
    }
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

const TOKYO: &str = r##"mode = "dark"
accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"
background = "#1a1b26"
dark_background = "#13141c"
darker_background = "#0e0e14"
lighter_background = "#24283b"
foreground = "#a9b1d6"
dark_foreground = "#565f89"
light_foreground = "#b4bee6"
bright_foreground = "#c0caf5"
red = "#f7768e"
yellow = "#e0af68"
green = "#9ece6a"
blue = "#7aa2f7"
"##;

fn first_failure(v: &Value) -> String {
    format!("{}", v["error"])
}

#[test]
fn every_bundled_omarchy_theme_becomes_a_theme_that_passes_the_contrast_rules() {
    let names = fixture_names();
    assert_eq!(names.len(), 22, "{names:?}");
    let mut moved = Vec::new();
    for name in &names {
        let b = Sandbox::new();
        b.omarchy_fixture(name);
        let (ok, v) = b.json(&["theme", "follow", "omarchy"]);
        assert!(ok, "{name} was refused: {}", first_failure(&v));
        let src: toml::Table = fs::read_to_string(fixtures().join(name).join("colors.toml"))
            .unwrap()
            .parse()
            .unwrap();
        let mode = src.get("mode").and_then(|m| m.as_str()).unwrap_or("dark");
        assert_eq!(
            v["data"]["mode"], mode,
            "{name}: the mode is Omarchy's, not auto"
        );
        assert_eq!(v["data"]["theme"], "omarchy");
        // The engine's own check agrees.
        let theme = b.theme_file();
        let file = b.root.join("omarchy.toml");
        fs::write(&file, &theme).unwrap();
        let (valid, vv) = b.json(&["theme", "validate", file.to_str().unwrap()]);
        assert!(valid, "{name}: {vv}");
        // Background is never moved. The accent is Omarchy's unless the notes say it was moved.
        let out = b.exported();
        let colors = &out["surfaces"]["spaces"][mode];
        assert_eq!(
            s(&colors["background"]),
            src["background"].as_str().unwrap().to_lowercase(),
            "{name}"
        );
        let nudges = v["data"]["nudges"].as_array().unwrap();
        let accent_moved = nudges.iter().any(|n| n["path"] == format!("{mode}.accent"));
        if !accent_moved {
            let want = src
                .get("accent")
                .or_else(|| src.get("blue"))
                .and_then(|a| a.as_str())
                .unwrap()
                .to_lowercase();
            assert_eq!(s(&colors["accent"]), want, "{name}");
        }
        // Every role Omarchy supplies and that passed is exactly Omarchy's.
        for n in nudges
            .iter()
            .filter(|n| s(&n["path"]).starts_with(&format!("{mode}.")))
        {
            assert_eq!(
                s(&colors[s(&n["path"]).split('.').nth(1).unwrap()]),
                s(&n["to"]).as_str().to_string(),
                "{name}: a nudge is what is written"
            );
        }
        // Each nudge is in the notes.
        let notes = v["data"]["notes"].as_array().cloned().unwrap_or_default();
        for n in nudges {
            let p = s(&n["path"]);
            assert!(
                notes
                    .iter()
                    .any(|x| x.as_str().unwrap().starts_with(&format!("{p}:"))),
                "{name}: no note for {p}"
            );
            moved.push(format!("{name}: {p} {} -> {}", s(&n["from"]), s(&n["to"])));
        }
    }
    eprintln!("themes tested: {}", names.len());
    for m in &moved {
        eprintln!("nudged: {m}");
    }
}

#[test]
fn a_passing_palette_is_kept_exactly() {
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    let (ok, v) = b.json(&["theme", "follow", "omarchy"]);
    assert!(ok, "{v}");
    let out = b.exported();
    let d = &out["surfaces"]["spaces"]["dark"];
    assert_eq!(d["background"], "#1a1b26");
    assert_eq!(d["accent"], "#7aa2f7");
    assert_eq!(d["foreground"], "#a9b1d6");
    assert_eq!(d["surface"], "#24283b");
    assert_eq!(d["sunken"], "#13141c");
    assert_eq!(d["selection"], "#292e42");
    // Omarchy's dark_foreground (#565f89) reads under 4.5 on its own background, so it moves; the
    // others stay.
    let nudges = v["data"]["nudges"].as_array().unwrap();
    assert!(
        nudges.iter().any(|n| n["path"] == "dark.muted"),
        "{nudges:?}"
    );
    assert!(!nudges.iter().any(|n| n["path"] == "dark.accent"));
    assert_eq!(out["mode"], "dark");
    // The shape is Omarchy's own look: the blocks theme.
    assert_eq!(out["surfaces"]["spaces"]["shape"]["radius"], 0);
}

#[test]
fn a_nudge_is_the_smallest_lightness_step() {
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    let (_, v) = b.json(&["theme", "follow", "omarchy"]);
    let n = v["data"]["nudges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["path"] == "dark.muted")
        .unwrap()
        .clone();
    assert_eq!(s(&n["from"]), "#565f89");
    let to = s(&n["to"]);
    // Same hue family, lighter, and it reads 4.5 on the three backgrounds.
    let out = b.exported();
    let d = &out["surfaces"]["spaces"]["dark"];
    assert_eq!(s(&d["muted"]), to);
    let lum = |h: &str| {
        let c = |i: usize| {
            let v = f64::from(u8::from_str_radix(&h[i..i + 2], 16).unwrap()) / 255.0;
            if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * c(1) + 0.7152 * c(3) + 0.0722 * c(5)
    };
    let ratio = |a: &str, b: &str| {
        let (x, y) = (lum(a), lum(b));
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    };
    for bg in ["background", "surface", "sunken"] {
        assert!(ratio(&to, &s(&d[bg])) >= 4.5, "muted on {bg}");
    }
    assert!(n["reason"].as_str().unwrap().contains("needs 4.5"));
}

#[test]
fn older_themes_with_missing_keys_still_follow() {
    let b = Sandbox::new();
    // No mode, no light/dark backgrounds, no status colors, no bright_*: only the basics.
    b.omarchy(
        "old",
        "background = \"#101010\"\nforeground = \"#e0e0e0\"\naccent = \"#ff8800\"\n",
    );
    let (ok, v) = b.json(&["theme", "follow", "omarchy"]);
    assert!(ok, "{v}");
    assert_eq!(v["data"]["mode"], "dark");
    let out = b.exported();
    let d = &out["surfaces"]["spaces"]["dark"];
    assert_eq!(d["background"], "#101010");
    assert_eq!(d["foreground"], "#e0e0e0");
    assert_eq!(d["accent"], "#ff8800");
    let notes = v["data"]["notes"].to_string();
    assert!(
        notes.contains("dark.urgent: this Omarchy theme has none of"),
        "{notes}"
    );
    // Colors may be written in other shapes.
    let b = Sandbox::new();
    b.omarchy(
        "odd",
        "mode = \"light\"\nbackground = \"0xFFFFFF\"\nforeground = \"#000\"\naccent = \"1D4ED8\"\n",
    );
    let (ok, v) = b.json(&["theme", "follow", "omarchy"]);
    assert!(ok, "{v}");
    let l = &b.exported()["surfaces"]["spaces"]["light"];
    assert_eq!(l["background"], "#ffffff");
    assert_eq!(l["foreground"], "#000000");
    assert_eq!(l["accent"], "#1d4ed8");
}

#[test]
fn the_other_mode_is_readable_and_keeps_the_accent_hue() {
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    let (ok, v) = b.json(&["theme", "follow", "omarchy"]);
    assert!(ok, "{v}");
    let out = b.exported();
    let l = &out["surfaces"]["spaces"]["light"];
    assert_ne!(l["background"], "#1a1b26");
    // The file lists only the accent pair for the mode Omarchy is not in.
    let file = b.theme_file();
    let t: toml::Table = file.parse().unwrap();
    let light = t["light"].as_table().unwrap();
    assert_eq!(light.len(), 2, "{light:?}");
    assert_eq!(t["extends"].as_str(), Some("blocks"));
    assert_eq!(t["dark"].as_table().unwrap().len(), 13);
}

#[test]
fn no_omarchy_means_a_clear_error_and_no_change() {
    let b = Sandbox::new();
    let (ok, v) = b.json(&["theme", "follow", "omarchy"]);
    assert!(!ok);
    assert_eq!(v["error"]["code"], "no_omarchy");
    assert!(
        !b.cfg().exists()
            || fs::read_dir(b.cfg()).unwrap().all(|e| {
                let n = e.unwrap().file_name();
                n == ".lock"
            })
    );
    assert!(!b.home().join(".config").exists());
    let out = b.run(&["theme", "follow", "omarchy"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("Omarchy was not found"));
    // The state is readable and says no.
    let (ok, v) = b.json(&["theme", "follow"]);
    assert!(ok);
    assert_eq!(v["data"]["omarchy_detected"], false);
    assert_eq!(v["data"]["following"], false);
}

#[test]
fn the_hook_is_marked_runs_the_binary_by_absolute_path_and_always_exits_zero() {
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    let (ok, _) = b.json(&["theme", "follow", "omarchy"]);
    assert!(ok);
    let text = fs::read_to_string(b.hook()).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "#!/bin/bash");
    assert!(
        lines[1].starts_with("# polycarp-managed-hook"),
        "{}",
        lines[1]
    );
    let exe = fs::canonicalize(env!("CARGO_BIN_EXE_polycarp")).unwrap();
    assert!(text.contains(&format!("'{}' theme follow omarchy --sync", exe.display())));
    assert!(text.trim_end().ends_with("exit 0"));
    assert!(
        text.contains("POLYCARP_CONFIG_DIR="),
        "the hook keeps the config folder"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(b.hook()).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
    // Run it the way Omarchy does: `bash <file> <theme name>`, with no terminal and no input.
    #[cfg(unix)]
    {
        let run = |dir: &Sandbox| {
            Command::new("bash")
                .arg(dir.hook())
                .arg("tokyo-night")
                .env_clear()
                .env("HOME", dir.home())
                .stdin(std::process::Stdio::null())
                .output()
                .unwrap()
        };
        // Switch Omarchy to another theme, then run the hook: the Polycarp theme follows.
        b.omarchy_fixture("white");
        let o = run(&b);
        assert_eq!(o.status.code(), Some(0));
        assert!(o.stdout.is_empty() && o.stderr.is_empty());
        let out = b.exported();
        assert_eq!(out["mode"], "light");
        assert_eq!(out["surfaces"]["spaces"]["light"]["background"], "#ffffff");
        let log = fs::read_to_string(b.cfg().join("follow.log")).unwrap();
        assert_eq!(log.lines().count(), 1, "{log}");
        assert!(log.contains("white"));
        // Colors unchanged: the hook changes nothing and logs nothing more.
        let before = fs::read(b.cfg().join("current/theme.json")).unwrap();
        run(&b);
        assert_eq!(
            fs::read(b.cfg().join("current/theme.json")).unwrap(),
            before
        );
        assert_eq!(
            fs::read_to_string(b.cfg().join("follow.log"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        // Even with Omarchy's colors gone and the binary unreachable, the hook exits 0.
        fs::remove_file(b.state().join("current/theme/colors.toml")).unwrap();
        assert_eq!(run(&b).status.code(), Some(0));
        fs::write(
            b.hook(),
            text.replace(&exe.display().to_string(), "/nonexistent/polycarp"),
        )
        .unwrap();
        let o = run(&b);
        assert_eq!(o.status.code(), Some(0));
        assert!(o.stdout.is_empty());
    }
}

#[test]
fn history_gets_nothing_from_a_sync() {
    let b = Sandbox::new();
    b.omarchy_fixture("tokyo-night");
    b.json(&["theme", "follow", "omarchy"]);
    let n = |b: &Sandbox| {
        fs::read_dir(b.cfg().join("history"))
            .map(|d| d.count())
            .unwrap_or(0)
    };
    let before = n(&b);
    for t in ["white", "nord", "white"] {
        b.omarchy_fixture(t);
        let o = b.run(&["theme", "follow", "omarchy", "--sync"]);
        assert!(o.status.success(), "{}", stdout(&o));
    }
    assert_eq!(n(&b), before);
    assert_eq!(
        fs::read_to_string(b.cfg().join("follow.log"))
            .unwrap()
            .lines()
            .count(),
        3
    );
}

#[test]
fn a_hook_that_is_not_ours_is_never_overwritten_or_removed() {
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    fs::create_dir_all(b.hook().parent().unwrap()).unwrap();
    fs::write(b.hook(), "#!/bin/bash\necho mine\n").unwrap();
    let (ok, v) = b.json(&["theme", "follow", "omarchy"]);
    assert!(!ok);
    assert_eq!(v["error"]["code"], "exists");
    assert!(v["error"]["message"].as_str().unwrap().contains("polycarp"));
    assert_eq!(
        fs::read_to_string(b.hook()).unwrap(),
        "#!/bin/bash\necho mine\n"
    );
    assert!(!b.cfg().join("themes").exists(), "nothing was written");
    assert!(!b.cfg().join("config.toml").exists());
    // off leaves it too.
    let (ok, v) = b.json(&["theme", "follow", "off"]);
    assert!(ok, "{v}");
    assert_eq!(
        fs::read_to_string(b.hook()).unwrap(),
        "#!/bin/bash\necho mine\n"
    );
    assert!(v.to_string().contains("not Polycarp's"));
}

#[test]
fn off_removes_only_our_hook_and_goes_back_to_the_theme_from_before() {
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    let sibling = b.hook().parent().unwrap().join("other");
    fs::create_dir_all(sibling.parent().unwrap()).unwrap();
    fs::write(&sibling, "#!/bin/bash\n").unwrap();
    assert!(b
        .run(&["theme", "set", "evening", "--mode", "light"])
        .status
        .success());
    let (ok, v) = b.json(&["theme", "follow", "omarchy"]);
    assert!(ok, "{v}");
    assert_eq!(v["data"]["theme"], "omarchy");
    let (_, st) = b.json(&["theme", "follow"]);
    assert_eq!(st["data"]["following"], true);
    assert_eq!(st["data"]["previous_theme"], "evening");
    assert_eq!(st["data"]["hook_installed"], true);
    let doctor = b.run(&["doctor"]);
    assert!(
        stdout(&doctor).contains("omarchy: found, and Polycarp is following"),
        "{}",
        stdout(&doctor)
    );

    let (ok, v) = b.json(&["theme", "follow", "off"]);
    assert!(ok, "{v}");
    assert_eq!(v["data"]["theme"], "evening");
    assert_eq!(v["data"]["mode"], "light");
    assert!(!b.hook().exists());
    assert!(sibling.exists());
    let (_, st) = b.json(&["theme", "follow"]);
    assert_eq!(st["data"]["following"], false);
    let cfg = fs::read_to_string(b.cfg().join("config.toml")).unwrap();
    assert!(!cfg.contains("omarchy"), "{cfg}");
    // Off when not following changes no setting.
    let before = fs::read(b.cfg().join("config.toml")).unwrap();
    let (ok, v) = b.json(&["theme", "follow", "off"]);
    assert!(ok);
    assert_eq!(v["data"]["was_following"], false);
    assert_eq!(fs::read(b.cfg().join("config.toml")).unwrap(), before);
    let doctor = b.run(&["doctor"]);
    assert!(
        stdout(&doctor).contains("not following"),
        "{}",
        stdout(&doctor)
    );
}

#[test]
fn choosing_another_theme_stops_following_and_says_so() {
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    b.json(&["theme", "follow", "omarchy"]);
    assert!(b.hook().exists());
    let (ok, v) = b.json(&["theme", "set", "calm"]);
    assert!(ok, "{v}");
    let notes = v["data"]["notes"].to_string();
    assert!(notes.contains("no longer does"), "{notes}");
    assert!(!b.hook().exists());
    let (_, st) = b.json(&["theme", "follow"]);
    assert_eq!(st["data"]["following"], false);
    // A later switch in Omarchy changes nothing.
    b.omarchy_fixture("white");
    let before = fs::read(b.cfg().join("current/theme.json")).unwrap();
    b.run(&["theme", "follow", "omarchy", "--sync"]);
    assert_eq!(
        fs::read(b.cfg().join("current/theme.json")).unwrap(),
        before
    );
    // Setting `omarchy` itself keeps following.
    b.json(&["theme", "follow", "omarchy"]);
    let (_, v) = b.json(&["theme", "set", "omarchy"]);
    assert!(!v["data"]["notes"].to_string().contains("no longer does"));
    assert!(b.hook().exists());
}

#[test]
fn following_twice_keeps_the_theme_from_before_the_first_time() {
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    b.run(&["theme", "set", "parchment"]);
    b.json(&["theme", "follow", "omarchy"]);
    b.omarchy_fixture("nord");
    b.json(&["theme", "follow", "omarchy"]);
    let (ok, v) = b.json(&["theme", "follow", "off"]);
    assert!(ok);
    assert_eq!(v["data"]["theme"], "parchment");
}

#[test]
fn a_user_theme_called_omarchy_that_is_not_ours_is_not_replaced() {
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    fs::create_dir_all(b.cfg().join("themes")).unwrap();
    fs::write(
        b.cfg().join("themes/omarchy.toml"),
        "name = \"omarchy\"\ntitle = \"Mine\"\nextends = \"calm\"\n",
    )
    .unwrap();
    let (ok, v) = b.json(&["theme", "follow", "omarchy"]);
    assert!(!ok);
    assert_eq!(v["error"]["code"], "exists");
    assert!(!b.hook().exists());
}

#[test]
fn an_accent_override_is_cleared_so_the_accent_is_omarchys() {
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    assert!(b.run(&["theme", "accent", "#7090ff"]).status.success());
    let (ok, v) = b.json(&["theme", "follow", "omarchy"]);
    assert!(ok, "{v}");
    assert!(v["data"]["notes"]
        .to_string()
        .contains("accent override is cleared"));
    assert_eq!(
        b.exported()["surfaces"]["spaces"]["dark"]["accent"],
        "#7aa2f7"
    );
}

#[test]
fn undo_steps_back_over_a_follow() {
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    b.run(&["theme", "set", "evening"]);
    b.json(&["theme", "follow", "omarchy"]);
    let (ok, v) = b.json(&["theme", "undo"]);
    assert!(ok, "{v}");
    let (_, cur) = b.json(&["theme", "current"]);
    assert_eq!(cur["data"]["theme"], "evening");
}

#[test]
fn mcp_theme_follow_has_the_same_envelope() {
    use std::io::Write;
    use std::process::Stdio;
    let b = Sandbox::new();
    b.omarchy("tokyo-night", TOKYO);
    let mut child = b
        .cmd(&["mcp"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let msgs = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"theme_follow","arguments":{}}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"theme_follow","arguments":{"target":"omarchy"}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"theme_follow","arguments":{"target":"off"}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"theme_follow","arguments":{"target":"sideways"}}}),
    ];
    for m in msgs {
        writeln!(input, "{m}").unwrap();
    }
    drop(input);
    let out = child.wait_with_output().unwrap();
    let replies: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let by = |id: i64| replies.iter().find(|r| r["id"] == id).unwrap()["result"].clone();
    assert_eq!(by(2)["structuredContent"]["data"]["following"], false);
    let on = by(3);
    assert_eq!(on["isError"], false);
    assert_eq!(on["structuredContent"]["ok"], true);
    assert_eq!(on["structuredContent"]["data"]["theme"], "omarchy");
    assert!(on["structuredContent"]["data"]["notes"].is_array());
    assert_eq!(by(4)["structuredContent"]["data"]["following"], false);
    assert!(!b.hook().exists());
    assert_eq!(by(5)["isError"], true);
}

#[test]
fn doctor_says_nothing_about_omarchy_where_there_is_none() {
    let b = Sandbox::new();
    let o = b.run(&["doctor"]);
    assert!(!stdout(&o).contains("omarchy"));
}
