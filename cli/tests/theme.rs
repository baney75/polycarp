//! Integration tests for `polycarp theme`. Every run gets its own config folder through
//! POLYCARP_CONFIG_DIR, so nothing real is touched.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

const BUILTINS: [&str; 6] = [
    "polycarp",
    "still-water",
    "evening",
    "parchment",
    "blocks",
    "calm",
];
const SURFACES: [&str; 4] = ["spaces", "voice", "browser", "site"];
const ROLES: [&str; 13] = [
    "background",
    "surface",
    "sunken",
    "foreground",
    "strong",
    "muted",
    "border",
    "accent",
    "on_accent",
    "selection",
    "urgent",
    "working",
    "done",
];

struct Box {
    root: PathBuf,
}

impl Box {
    fn new() -> Box {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "theme-{}-{}",
            std::process::id(),
            n
        ));
        let _ = fs::remove_dir_all(&root);
        for d in ["home", "xdg", "appdata", "cwd", "tmp"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Box { root }
    }
    /// The folder the command should use for its files.
    fn cfg(&self) -> PathBuf {
        self.root.join("cfg")
    }
    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_polycarp"));
        c.env_clear()
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("POLYCARP_CONFIG_DIR", self.root.join("cfg"))
            .env("TMPDIR", self.root.join("tmp"))
            .env("TEMP", self.root.join("tmp"))
            .env("TMP", self.root.join("tmp"))
            .current_dir(self.root.join("cwd"))
            .args(args);
        if let Some(r) = std::env::var_os("SystemRoot") {
            c.env("SystemRoot", r);
        }
        c
    }
    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().unwrap()
    }
    /// Runs with `input` on standard input.
    fn run_stdin(&self, args: &[&str], input: &str) -> Output {
        use std::io::Write;
        use std::process::Stdio;
        let mut child = self
            .cmd(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }
    /// Runs `polycarp theme <args> --json`; returns (exit code, parsed stdout).
    fn jrun(&self, args: &[&str]) -> (i32, Value) {
        let mut a = vec!["theme"];
        a.extend_from_slice(args);
        a.push("--json");
        let o = self.run(&a);
        let v: Value = serde_json::from_str(&out(&o))
            .unwrap_or_else(|e| panic!("{args:?}: stdout is not JSON ({e}): {}", out(&o)));
        (code(&o), v)
    }
    /// Everything a refusal must not change: state file, user themes, history count.
    fn snapshot(&self) -> (Option<String>, Vec<(String, String)>, usize) {
        let mut themes = Vec::new();
        if let Ok(rd) = fs::read_dir(self.cfg().join("themes")) {
            for e in rd.flatten() {
                themes.push((
                    e.file_name().to_string_lossy().into_owned(),
                    fs::read_to_string(e.path()).unwrap(),
                ));
            }
        }
        themes.sort();
        (
            fs::read_to_string(self.state_file()).ok(),
            themes,
            self.history_count(),
        )
    }
    fn run_as(&self, who: &str, args: &[&str]) -> Output {
        self.cmd(args).env("POLYCARP_CALLER", who).output().unwrap()
    }
    /// Runs `polycarp theme <args>` and expects success.
    fn ok(&self, args: &[&str]) -> String {
        let mut a = vec!["theme"];
        a.extend_from_slice(args);
        let o = self.run(&a);
        assert_eq!(code(&o), 0, "args {args:?}\nstderr: {}", err(&o));
        out(&o)
    }
    /// Runs `polycarp theme <args>`, expects exit 1 and returns stderr.
    fn refused(&self, args: &[&str]) -> String {
        let mut a = vec!["theme"];
        a.extend_from_slice(args);
        let o = self.run(&a);
        assert_eq!(code(&o), 1, "args {args:?}\nstdout: {}", out(&o));
        err(&o)
    }
    /// Parses stdout. An `--json` envelope is unwrapped to its `data`; raw JSON is returned as is.
    fn json(&self, args: &[&str]) -> Value {
        let v: Value = serde_json::from_str(&self.ok(args)).unwrap();
        match (v.get("ok"), v.get("data")) {
            (Some(Value::Bool(true)), Some(d)) => d.clone(),
            _ => v,
        }
    }
    fn write_theme(&self, name: &str, text: &str) -> PathBuf {
        let dir = self.cfg().join("themes");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{name}.toml"));
        fs::write(&p, text).unwrap();
        p
    }
    fn state_file(&self) -> PathBuf {
        self.cfg().join("config.toml")
    }
    fn history_count(&self) -> usize {
        fs::read_dir(self.cfg().join("history"))
            .map(|r| r.count())
            .unwrap_or(0)
    }
}

fn code(o: &Output) -> i32 {
    o.status.code().unwrap()
}
fn out(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}
fn err(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn user_theme(name: &str, extends: &str, body: &str) -> String {
    format!("name = \"{name}\"\ntitle = \"{name}\"\nextends = \"{extends}\"\n{body}\n")
}

fn repo_theme(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("themes")
        .join(format!("{name}.toml"))
}

fn files_under(dir: &Path, found: &mut Vec<PathBuf>) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                files_under(&p, found);
            } else {
                found.push(p);
            }
        }
    }
}

// --- built-ins ---------------------------------------------------------------------------------

#[test]
fn every_builtin_validates_in_all_surfaces_and_modes() {
    let b = Box::new();
    for name in BUILTINS {
        let file = repo_theme(name);
        let o = b.run(&["theme", "validate", file.to_str().unwrap()]);
        assert_eq!(code(&o), 0, "{name}: {}", err(&o));
        let v = b.json(&["export", "json", name]);
        for s in SURFACES {
            let surf = &v["surfaces"][s];
            for mode in ["light", "dark"] {
                for role in ROLES {
                    let c = surf[mode][role].as_str().unwrap_or("");
                    assert!(
                        c.len() == 7 && c.starts_with('#'),
                        "{name}.{s}.{mode}.{role} = {c:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn themes_folder_holds_exactly_the_builtins() {
    let dir = repo_theme("polycarp").parent().unwrap().to_path_buf();
    let mut on_disk: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            (p.extension()? == "toml")
                .then(|| p.file_stem().unwrap().to_string_lossy().into_owned())
        })
        .collect();
    on_disk.sort();
    let mut want: Vec<String> = BUILTINS.iter().map(|s| s.to_string()).collect();
    want.sort();
    assert_eq!(on_disk, want);
}

#[test]
fn polycarp_theme_has_the_brand_values() {
    let b = Box::new();
    let v = b.json(&["show", "polycarp", "--json"]);
    let base = &v["surfaces"]["spaces"];
    assert_eq!(base["light"]["background"], "#f6f3e8");
    assert_eq!(base["dark"]["accent"], "#a9bb8a");
    assert_eq!(base["shape"]["radius_large"], 16);
    assert_eq!(base["type"]["size"], 16);
    assert_eq!(base["motion"]["easing"], "cubic-bezier(0.2, 0, 0, 1)");
}

#[test]
fn builtin_variants_differ_as_described() {
    let b = Box::new();
    let blocks = b.json(&["export", "json", "blocks", "--surface", "spaces"]);
    assert_eq!(blocks["shape"]["radius"], 0);
    assert_eq!(blocks["shape"]["border_width"], 2);
    assert_eq!(blocks["shape"]["indicator"], "number-block");
    assert_eq!(blocks["motion"]["scale_from"], 1.0);
    let parchment = b.json(&["export", "json", "parchment", "--surface", "spaces"]);
    assert_eq!(parchment["shape"]["radius_small"], 2);
    assert_eq!(parchment["shape"]["radius"], 4);
    assert_eq!(parchment["shape"]["radius_large"], 6);
    let calm = b.json(&["export", "json", "calm", "--surface", "spaces"]);
    assert_eq!(calm["shape"]["density"], "spacious");
    assert_eq!(calm["shape"]["shadow"], 0.0);
    // Reduced motion: every duration exports as 0.
    assert_eq!(calm["motion"]["fast"], 0);
    assert_eq!(calm["motion"]["normal"], 0);
    assert_eq!(calm["motion"]["slow"], 0);
    assert_eq!(calm["motion"]["reduced"], true);
    let css = b.ok(&["export", "css", "calm"]);
    assert!(css.contains("--pc-motion-normal: 0ms;"));
}

// --- inheritance and surfaces ------------------------------------------------------------------

#[test]
fn inheritance_and_surface_merge() {
    let b = Box::new();
    b.write_theme(
        "mine",
        &user_theme(
            "mine",
            "still-water",
            "[light]\naccent = \"#3f6b6a\"\n[shape]\nradius = 3\n[surface.site.light]\naccent = \"#2d5f4a\"\n[surface.voice.shape]\nradius = 20\n",
        ),
    );
    b.write_theme(
        "deeper",
        &user_theme("deeper", "mine", "[shape]\nblur = 9\n"),
    );
    let v = b.json(&["export", "json", "deeper"]);
    let s = |surf: &str| v["surfaces"][surf].clone();
    // Deep merge: the child changes one color, the rest comes from still-water.
    assert_eq!(s("spaces")["light"]["accent"], "#3f6b6a");
    assert_eq!(s("spaces")["light"]["background"], "#f1f5f5");
    assert_eq!(s("spaces")["dark"]["accent"], "#a5cfcb");
    assert_eq!(s("spaces")["shape"]["radius"], 3);
    assert_eq!(s("spaces")["shape"]["blur"], 9);
    assert_eq!(s("spaces")["shape"]["radius_large"], 16);
    // Surface overrides touch only their own surface, and are inherited too.
    assert_eq!(s("site")["light"]["accent"], "#2d5f4a");
    assert_eq!(s("browser")["light"]["accent"], "#3f6b6a");
    assert_eq!(s("voice")["shape"]["radius"], 20);
    assert_eq!(s("spaces")["shape"]["radius"], 3);
    assert_eq!(s("site")["shape"]["radius"], 3);
    assert_eq!(v["name"], "deeper");
}

#[test]
fn surface_override_can_be_validated_on_its_own() {
    let b = Box::new();
    b.write_theme(
        "bad-site",
        &user_theme(
            "bad-site",
            "polycarp",
            "[surface.site.light]\nmuted = \"#c8c8c8\"\n",
        ),
    );
    let e = b.refused(&[
        "validate",
        b.cfg().join("themes/bad-site.toml").to_str().unwrap(),
    ]);
    assert!(
        e.contains("surface.site: light.muted on light.background is"),
        "{e}"
    );
    // The same value on the theme itself is reported without the surface prefix.
    b.write_theme(
        "bad-all",
        &user_theme("bad-all", "polycarp", "[light]\nmuted = \"#c8c8c8\"\n"),
    );
    let e = b.refused(&[
        "validate",
        b.cfg().join("themes/bad-all.toml").to_str().unwrap(),
    ]);
    assert!(e.contains("\n  light.muted on light.background is"), "{e}");
    assert!(!e.contains("surface.site"), "{e}");
}

#[test]
fn cycle_is_refused() {
    let b = Box::new();
    b.write_theme("a", &user_theme("a", "b", ""));
    let pb = b.write_theme("b", &user_theme("b", "a", ""));
    let e = b.refused(&["validate", pb.to_str().unwrap()]);
    assert!(e.contains("extends: cycle b -> a -> b"), "{e}");
    let e = b.refused(&["set", "a"]);
    assert!(e.contains("cycle a -> b -> a"), "{e}");
    // A theme that extends itself.
    let p = b.write_theme("me", &user_theme("me", "me", ""));
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    assert!(e.contains("cycle me -> me"), "{e}");
}

#[test]
fn depth_limit_is_eight() {
    let b = Box::new();
    // t1 extends polycarp, t2 extends t1, and so on.
    for i in 1..=9 {
        let base = if i == 1 {
            "polycarp".to_string()
        } else {
            format!("t{}", i - 1)
        };
        b.write_theme(&format!("t{i}"), &user_theme(&format!("t{i}"), &base, ""));
    }
    // t8 has 8 ancestors (t7..t1 and polycarp): allowed.
    b.ok(&["show", "t8"]);
    // t9 has 9: refused.
    let e = b.refused(&["show", "t9"]);
    assert!(e.contains("more than 8 themes deep"), "{e}");
}

#[test]
fn missing_base_and_hostile_names_are_refused() {
    let b = Box::new();
    let p = b.write_theme("lost", &user_theme("lost", "nowhere", ""));
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    assert!(e.contains("extends: no theme named \"nowhere\""), "{e}");
    let p = b.write_theme("sneaky", &user_theme("sneaky", "../../etc/passwd", ""));
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    assert!(
        e.contains("extends: \"../../etc/passwd\" is not a valid theme name"),
        "{e}"
    );
    let e = b.refused(&["set", "../x"]);
    assert!(e.contains("not a valid theme name"), "{e}");
}

// --- validation --------------------------------------------------------------------------------

#[test]
fn unknown_keys_are_refused_with_their_path() {
    let b = Box::new();
    let p = b.write_theme(
        "typo",
        &user_theme(
            "typo",
            "polycarp",
            "colour = 1\n[shape]\nradis = 3\n[surface.site.motion]\nfastt = 5\n[surface.web]\nx = 1\n[surface.site.extra]\ny = 1\n",
        ),
    );
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    for want in [
        "colour: unknown key",
        "shape.radis: unknown key",
        "surface.site.motion.fastt: unknown key",
        "surface.web: unknown surface",
        "surface.site.extra: unknown key",
    ] {
        assert!(e.contains(want), "missing {want:?} in:\n{e}");
    }
    assert!(e.contains("(5 problems)"), "{e}");
}

#[test]
fn font_values_that_could_break_the_stylesheet_are_refused_with_their_path() {
    let b = Box::new();
    let bad = [
        "Georgia, /* x */ serif",
        "Georgia */ serif",
        "Georgia}body{color:red",
        "url(http://x/f.woff)",
        "Georgia (serif)",
        "\"Times New Roman, serif",
        "'Times New Roman, serif",
        "\"Times\" \"Roman\"",
        "\"a/*b\", serif",
        "\"a\\b\", serif",
        "\"a</style>\"",
        "Georgia,",
        ",Georgia",
        "Georgia,, serif",
        "\"\"",
        "Georgia; color: red",
        "a\nb",
    ];
    for path in [
        "type.display",
        "type.ui",
        "type.mono",
        "surface.site.type.ui",
    ] {
        for value in bad {
            let before = b.snapshot();
            let (c, v) = b.jrun(&["change", path, value]);
            assert_eq!(c, 1, "{path} {value:?}: {v}");
            assert_eq!(v["error"]["data"]["errors"][0]["path"], path, "{value:?}");
            assert_eq!(b.snapshot(), before, "{value:?} changed something");
        }
    }
    // The same text in a whole theme names the full path.
    let p = b.write_theme(
        "evil",
        &user_theme("evil", "polycarp", "[type]\nmono = \"a } b\"\n"),
    );
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    assert!(
        e.contains("type.mono: \"a } b\" is not a font stack"),
        "{e}"
    );
    // Plain names, quoted names with spaces and commas, and the built-in stacks all pass.
    for good in [
        "Georgia",
        "Georgia, serif",
        "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace",
        "'Times New Roman', Times_New-2, serif",
        "\"Name, with comma\", serif",
    ] {
        let (c, v) = Box::new().jrun(&["change", "type.mono", good]);
        assert_eq!(c, 0, "{good}: {v}");
    }
    for n in BUILTINS {
        b.ok(&["show", n]);
    }
}

#[test]
fn bad_hex_range_and_enum_are_refused_together() {
    let b = Box::new();
    let body = "[light]\naccent = \"red\"\nsurface = \"#12345\"\ndone = 7\n\
                [shape]\nradius = 70\nborder_width = -1\nshadow = 1.5\ndensity = \"huge\"\nindicator = \"star\"\nblur = 2.5\n\
                [type]\nsize = 9\nweight = 900\nline_height = 0.5\ndisplay = \"\"\nui = \"a; b\"\n\
                [motion]\nfast = 1001\neasing = \"bounce\"\nscale_from = 0.2\nreduced = \"yes\"\nnormal = 5\nslow = 1.5\n";
    let p = b.write_theme("broken", &user_theme("broken", "polycarp", body));
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    for want in [
        "light.accent: \"red\" is not a color like \"#rrggbb\"",
        "light.surface: \"#12345\" is not a color like \"#rrggbb\"",
        "light.done: must be a string like \"#rrggbb\"",
        "shape.radius: 70 is out of range 0..64",
        "shape.border_width: -1 is out of range 0..8",
        "shape.shadow: 1.5 is out of range 0.0..1.0",
        "shape.density: \"huge\" is not one of compact, regular, spacious",
        "shape.indicator: \"star\" is not one of dot, bar, number-block",
        "shape.blur: must be a whole number from 0 to 80",
        "type.size: 9 is out of range 10..24",
        "type.weight: 900 is out of range 300..800",
        "type.line_height: 0.5 is out of range 1.0..2.0",
        "type.display: must not be empty",
        "type.ui: \"a; b\" is not a font stack",
        "motion.fast: 1001 is out of range 0..1000",
        "motion.easing: \"bounce\" is not",
        "motion.scale_from: 0.2 is out of range 0.5..1.0",
        "motion.reduced: must be true or false",
        "motion.slow: must be a whole number from 0 to 1000",
    ] {
        assert!(e.contains(want), "missing {want:?} in:\n{e}");
    }
    assert!(!e.contains("motion.normal"), "{e}");
}

#[test]
fn easing_rules() {
    let b = Box::new();
    let check = |easing: &str| {
        let p = b.write_theme(
            "ease",
            &user_theme(
                "ease",
                "polycarp",
                &format!("[motion]\neasing = '{easing}'\n"),
            ),
        );
        b.run(&["theme", "validate", p.to_str().unwrap()])
    };
    for good in [
        "ease",
        "linear",
        "cubic-bezier(0.1,0.2, 0.3 ,1.4)",
        "cubic-bezier(0,0,1,1)",
    ] {
        let o = check(good);
        assert_eq!(code(&o), 0, "{good}: {}", err(&o));
    }
    for bad in [
        "cubic-bezier(1,2,3)",
        "cubic-bezier(a,b,c,d)",
        "cubic-bezier(2,0,0,1)",
        "ease; color: red",
        "",
    ] {
        assert_eq!(code(&check(bad)), 1, "{bad}");
    }
}

#[test]
fn name_must_match_file_and_pattern() {
    let b = Box::new();
    let p = b.write_theme(
        "one",
        "name = \"two\"\ntitle = \"T\"\nextends = \"polycarp\"\n",
    );
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    assert!(
        e.contains("name: \"two\" must match the file name \"one\""),
        "{e}"
    );
    let p = b.write_theme(
        "Upper",
        "name = \"Upper\"\ntitle = \"T\"\nextends = \"polycarp\"\n",
    );
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    assert!(
        e.contains("name: \"Upper\" must be lowercase letters, digits and hyphens"),
        "{e}"
    );
    let p = b.write_theme("noname", "title = \"T\"\nextends = \"polycarp\"\n");
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    assert!(e.contains("name: missing"), "{e}");
}

#[test]
fn incomplete_theme_lists_what_is_missing() {
    let b = Box::new();
    let p = b.write_theme(
        "partial",
        "name = \"partial\"\n[light]\nbackground = \"#ffffff\"\n[shape]\nradius = 4\n",
    );
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    for want in [
        "title: missing",
        "light.surface: missing",
        "dark: missing",
        "shape.blur: missing",
        "type: missing",
        "motion: missing",
    ] {
        assert!(e.contains(want), "missing {want:?} in:\n{e}");
    }
    // Colors that are present still get checked against each other.
    assert!(!e.contains("light.background: missing"), "{e}");
}

#[test]
fn toml_syntax_errors_say_the_line() {
    let b = Box::new();
    let p = b.write_theme("syntax", "name = \"syntax\"\ntitle = \n");
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    assert!(
        e.contains("could not read the file as TOML (line 2)"),
        "{e}"
    );
}

#[test]
fn contrast_refusal_message_is_exact() {
    let b = Box::new();
    // #7f8272 on dark.surface #34382e is 3.0485, shown as 3.04 (never rounded up past the limit).
    let p = b.write_theme(
        "dim",
        &user_theme("dim", "polycarp", "[dark]\nmuted = \"#7f8272\"\n"),
    );
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    assert!(
        e.contains("\n  dark.muted on dark.surface is 3.04, needs 4.5\n")
            || e.ends_with("  dark.muted on dark.surface is 3.04, needs 4.5\n"),
        "{e}"
    );
    assert!(e.contains("dark.muted on dark.background is"), "{e}");
    // Light mode is checked as well. The accent is text too, so it needs 4.5 there.
    let p = b.write_theme(
        "pale",
        &user_theme(
            "pale",
            "polycarp",
            "[light]\naccent = \"#f0e0a0\"\nurgent = \"#f0c0c0\"\n",
        ),
    );
    let e = b.refused(&["validate", p.to_str().unwrap()]);
    assert!(
        e.contains("light.accent on light.background is 1.19, needs 4.5"),
        "{e}"
    );
    assert!(e.contains("light.accent on light.sunken is"), "{e}");
    assert!(e.contains(", needs 3.0\n"), "{e}");
    assert!(e.contains("light.urgent on light.background is"), "{e}");
    assert!(e.contains("light.on_accent on light.accent is"), "{e}");
}

#[test]
fn every_pair_the_ui_draws_is_checked_in_both_modes() {
    let b = Box::new();
    // (what to change, a message that must appear). Each case passed the older, shorter rules.
    let cases = [
        // Text on the selected row.
        (
            "[light]\nselection = \"#6a6a6a\"",
            "light.foreground on light.selection is",
        ),
        (
            "[dark]\nselection = \"#8a8a8a\"",
            "dark.strong on dark.selection is",
        ),
        // Text on the recessed wells.
        (
            "[light]\nsunken = \"#8a8a7a\"",
            "light.muted on light.sunken is",
        ),
        (
            "[dark]\nsunken = \"#7a7a6a\"",
            "dark.foreground on dark.sunken is",
        ),
        // Accent and status colors are text, so they need 4.5 on background and surface.
        (
            "[dark]\naccent = \"#7a8a6a\"",
            "dark.accent on dark.background is 3.72, needs 4.5",
        ),
        (
            "[dark]\nworking = \"#8a7e5a\"",
            "dark.working on dark.background is 3.42, needs 4.5",
        ),
        ("[dark]\ndone = \"#6a8a86\"", "dark.done on dark.surface is"),
        (
            "[light]\nurgent = \"#c0584a\"",
            "light.urgent on light.background is",
        ),
        // Indicators need 3.0 on sunken.
        (
            "[light]\nsunken = \"#b5ad92\"",
            "light.urgent on light.sunken is 2.92, needs 3.0",
        ),
    ];
    for (i, (body, want)) in cases.iter().enumerate() {
        let name = format!("case-{i}");
        let p = b.write_theme(&name, &user_theme(&name, "polycarp", body));
        let e = b.refused(&["validate", p.to_str().unwrap()]);
        assert!(e.contains(want), "{body}: wanted {want:?} in\n{e}");
    }
    // The built-ins themselves pass all of it (they are validated again by every other test).
    for n in BUILTINS {
        b.ok(&["show", n]);
    }
}

#[test]
fn set_refuses_an_invalid_theme_and_changes_nothing() {
    let b = Box::new();
    b.ok(&["set", "evening"]);
    let before = fs::read(b.state_file()).unwrap();
    let hist = b.history_count();
    b.write_theme(
        "dim",
        &user_theme("dim", "polycarp", "[dark]\nmuted = \"#7f8272\"\n"),
    );
    let e = b.refused(&["set", "dim"]);
    assert!(
        e.contains("dark.muted on dark.surface is 3.04, needs 4.5"),
        "{e}"
    );
    assert_eq!(fs::read(b.state_file()).unwrap(), before);
    assert_eq!(b.history_count(), hist);
    let e = b.refused(&["set", "no-such-theme"]);
    assert!(e.contains("no theme named"), "{e}");
}

// --- set, outputs, export ----------------------------------------------------------------------

#[test]
fn set_writes_all_files_and_they_parse() {
    let b = Box::new();
    let o = b.ok(&["set", "still-water", "--mode", "dark"]);
    assert!(o.contains("theme: still-water"));
    assert!(o.contains(
        "Products read these files once their adapters land. Until then only the files change."
    ));
    let cur = b.cfg().join("current");
    for s in SURFACES {
        let p = cur.join(format!("{s}.css"));
        assert!(p.is_file(), "{p:?}");
        assert!(o.contains(p.to_str().unwrap()), "{o}");
        let css = fs::read_to_string(p).unwrap();
        assert!(css.contains("--pc-accent: #a5cfcb;"));
        assert!(css.contains("still-water"));
    }
    let v: Value =
        serde_json::from_str(&fs::read_to_string(cur.join("theme.json")).unwrap()).unwrap();
    assert_eq!(v["name"], "still-water");
    assert_eq!(v["mode"], "dark");
    for s in SURFACES {
        assert_eq!(v["surfaces"][s]["dark"]["accent"], "#a5cfcb");
    }
    let state = fs::read_to_string(b.state_file()).unwrap();
    assert!(state.contains("[appearance]") && state.contains("theme = \"still-water\""));
    assert!(state.contains("mode = \"dark\""));
    // The mode is kept when it is not given again.
    b.ok(&["set", "evening"]);
    assert_eq!(b.json(&["current", "--json"])["mode"], "dark");
    b.ok(&["set", "evening", "--mode", "auto"]);
    assert_eq!(b.json(&["current", "--json"])["mode"], "auto");
    let e = b.run(&["theme", "set", "evening", "--mode", "purple"]);
    assert_eq!(code(&e), 2);
}

#[cfg(unix)]
#[test]
fn outputs_are_mode_0644() {
    use std::os::unix::fs::PermissionsExt;
    let b = Box::new();
    b.ok(&["set", "evening"]);
    let mut files = Vec::new();
    files_under(&b.cfg(), &mut files);
    assert!(files.len() >= 6);
    for f in files {
        let mode = fs::metadata(&f).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644, "{f:?}");
    }
}

#[test]
fn forced_mode_css_is_fixed_and_auto_follows_the_system() {
    let b = Box::new();
    b.ok(&["set", "polycarp", "--mode", "dark"]);
    let forced = fs::read_to_string(b.cfg().join("current/site.css")).unwrap();
    assert!(!forced.contains("@media"));
    let root = &forced[..forced.find(":root[data-theme-mode").unwrap()];
    assert!(root.contains("--pc-background: #2b2e26;"), "{root}");
    b.ok(&["set", "polycarp", "--mode", "auto"]);
    let auto = fs::read_to_string(b.cfg().join("current/site.css")).unwrap();
    assert!(auto.contains("@media (prefers-color-scheme: dark)"));
}

#[test]
fn export_css_has_every_role_in_both_modes() {
    let b = Box::new();
    let css = b.ok(&["export", "css", "polycarp"]);
    let light_start = css.find(":root[data-theme-mode=\"light\"] {").unwrap();
    let dark_start = css.find(":root[data-theme-mode=\"dark\"] {").unwrap();
    let media_start = css
        .find("@media (prefers-color-scheme: dark) {\n  :root:not([data-theme-mode=\"light\"]) {")
        .unwrap();
    assert!(light_start < dark_start && dark_start < media_start);
    let light = &css[light_start..dark_start];
    let dark = &css[dark_start..media_start];
    let media = &css[media_start..];
    for role in ROLES {
        let var = format!("--pc-{}:", role.replace('_', "-"));
        for (label, block) in [("light", light), ("dark", dark), ("media", media)] {
            assert!(block.contains(&var), "{var} missing in {label} block");
        }
    }
    assert!(light.contains("--pc-on-accent: #f6f3e8;"));
    assert!(dark.contains("--pc-on-accent: #20231a;"));
    assert!(media.contains("--pc-on-accent: #20231a;"));
    let root = &css[..light_start];
    for var in [
        "--pc-radius-small: 6px;",
        "--pc-radius: 10px;",
        "--pc-radius-large: 16px;",
        "--pc-border-width: 1px;",
        "--pc-blur: 0px;",
        "--pc-shadow: 0.12;",
        "--pc-density: regular;",
        "--pc-indicator: dot;",
        "--pc-font-display: Newsreader, \"Iowan Old Style\", Georgia, serif;",
        "--pc-font-ui:",
        "--pc-font-mono:",
        "--pc-font-size: 16px;",
        "--pc-font-weight: 400;",
        "--pc-line-height: 1.5;",
        "--pc-motion-fast: 120ms;",
        "--pc-motion-normal: 200ms;",
        "--pc-motion-slow: 320ms;",
        "--pc-motion-easing: cubic-bezier(0.2, 0, 0, 1);",
        "--pc-motion-scale-from: 0.98;",
    ] {
        assert!(root.contains(var), "{var} missing from :root:\n{root}");
    }
    // Braces balance, so the file is well-formed.
    assert_eq!(css.matches('{').count(), css.matches('}').count());
}

#[test]
fn export_by_surface_uses_that_surfaces_values() {
    let b = Box::new();
    b.write_theme(
        "mine",
        &user_theme(
            "mine",
            "polycarp",
            "[surface.site.light]\naccent = \"#3f6b6a\"\n",
        ),
    );
    let site = b.ok(&["export", "css", "mine", "--surface", "site"]);
    let spaces = b.ok(&["export", "css", "mine", "--surface", "spaces"]);
    assert!(site.contains("--pc-accent: #3f6b6a;"));
    assert!(!spaces.contains("--pc-accent: #3f6b6a;"));
    let j = b.json(&["export", "json", "mine", "--surface", "site"]);
    assert_eq!(j["surface"], "site");
    assert_eq!(j["light"]["accent"], "#3f6b6a");
    let o = b.run(&["theme", "export", "css", "--surface", "phone"]);
    assert_eq!(code(&o), 2);
    let o = b.run(&["theme", "export", "xml"]);
    assert_eq!(code(&o), 2);
}

#[test]
fn show_prints_the_resolved_theme() {
    let b = Box::new();
    let text = b.ok(&["show", "blocks"]);
    assert!(text.contains("indicator = \"number-block\""), "{text}");
    assert!(text.contains("radius = 0"), "{text}");
    assert!(text.contains("[light]") && text.contains("[dark]") && text.contains("[motion]"));
    let v = b.json(&["show", "calm", "--json"]);
    // Show keeps the authored durations; the exports are the ones that zero them.
    assert_eq!(v["surfaces"]["site"]["motion"]["normal"], 200);
    assert_eq!(v["surfaces"]["site"]["motion"]["reduced"], true);
}

#[test]
fn list_marks_the_current_theme() {
    let b = Box::new();
    b.write_theme("mine", &user_theme("mine", "polycarp", ""));
    b.write_theme("polycarp-copy", "not toml at all [");
    b.ok(&["set", "evening"]);
    let text = b.ok(&["list"]);
    let cur: Vec<&str> = text.lines().filter(|l| l.starts_with('*')).collect();
    assert_eq!(cur.len(), 1, "{text}");
    assert!(cur[0].contains("evening"));
    for n in BUILTINS {
        assert!(text.contains(n), "{text}");
    }
    assert!(text.contains("mine") && text.contains("user"));
    assert!(text.contains("polycarp-copy") && text.contains("invalid"));
    let j = b.json(&["list", "--json"])["themes"].clone();
    let arr = j.as_array().unwrap();
    let by = |n: &str| arr.iter().find(|e| e["name"] == n).unwrap().clone();
    assert_eq!(by("evening")["current"], true);
    assert_eq!(by("polycarp")["current"], false);
    assert_eq!(by("mine")["source"], "user");
    assert_eq!(by("polycarp-copy")["valid"], false);
}

#[test]
fn a_user_file_cannot_shadow_a_builtin() {
    let b = Box::new();
    b.write_theme(
        "calm",
        &user_theme("calm", "polycarp", "[shape]\nradius = 1\n"),
    );
    let j = b.json(&["export", "json", "calm", "--surface", "site"]);
    assert_eq!(j["shape"]["radius"], 10);
    let j = b.json(&["list", "--json"])["themes"].clone();
    let calm: Vec<&Value> = j
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["name"] == "calm")
        .collect();
    assert_eq!(calm.len(), 2);
    assert!(calm
        .iter()
        .any(|e| e["source"] == "user" && e["valid"] == false));
}

// --- accent ------------------------------------------------------------------------------------

/// A green that reads on the light themes (4.5 on background and surface) and one that reads on
/// the dark ones. No single color reads on both, so `accent` is set one mode at a time.
const GREEN_L: &str = "#2f6b55";
const GREEN_D: &str = "#8fcfb2";

#[test]
fn accent_override_and_automatic_on_accent() {
    let b = Box::new();
    b.ok(&["accent", GREEN_L, "--mode", "light"]);
    let o = b.ok(&["accent", &GREEN_D.to_uppercase(), "--mode", "dark"]);
    assert!(o.contains("wrote"), "{o}");
    let v: Value =
        serde_json::from_str(&fs::read_to_string(b.cfg().join("current/theme.json")).unwrap())
            .unwrap();
    for s in SURFACES {
        assert_eq!(v["surfaces"][s]["light"]["accent"], GREEN_L);
        assert_eq!(v["surfaces"][s]["dark"]["accent"], GREEN_D);
        // The theme's own on_accent reads on both, so it is kept.
        assert_eq!(v["surfaces"][s]["light"]["on_accent"], "#f6f3e8");
        assert_eq!(v["surfaces"][s]["dark"]["on_accent"], "#20231a");
    }
    assert_eq!(v["accent_light"], GREEN_L);
    assert_eq!(v["accent_dark"], GREEN_D);
    let state = fs::read_to_string(b.state_file()).unwrap();
    assert!(state.contains(&format!("accent_light = \"{GREEN_L}\"")));
    assert!(state.contains(&format!("accent_dark = \"{GREEN_D}\"")));
    let cur = b.json(&["current", "--json"]);
    assert_eq!(cur["accent_light"], GREEN_L);

    // With --mode only that mode changes.
    b.ok(&["accent", "--clear"]);
    b.ok(&["accent", "#3f6b6a", "--mode", "light"]);
    let v = b.json(&["export", "json"]);
    assert_eq!(v["surfaces"]["site"]["light"]["accent"], "#3f6b6a");
    assert_eq!(v["surfaces"]["site"]["dark"]["accent"], "#a9bb8a");
    let cur = b.json(&["current", "--json"]);
    assert_eq!(cur["accent_light"], "#3f6b6a");
    assert!(cur["accent_dark"].is_null());

    // The override applies to everything `export` and `show` print for the current theme.
    let css = b.ok(&["export", "css"]);
    assert!(css.contains("--pc-accent: #3f6b6a;"));

    // Clearing puts the theme's own accent back.
    b.ok(&["accent", "--clear"]);
    let v = b.json(&["export", "json"]);
    assert_eq!(v["surfaces"]["site"]["light"]["accent"], "#59693f");
    assert!(b.json(&["current", "--json"])["accent_light"].is_null());
}

#[test]
fn accent_picks_on_accent_by_the_same_rule_the_checker_uses() {
    let b = Box::new();
    // This theme's own light on_accent is too weak on a new accent, and black is too, so white is
    // picked. The picked label must read on the accent (4.5), as the checker requires.
    let doc = user_theme(
        "odd",
        "polycarp",
        "[light]\naccent = \"#0f2a1e\"\non_accent = \"#9a9a9a\"",
    );
    let o = b.run_stdin(&["theme", "apply", "-"], &doc);
    assert_eq!(code(&o), 0, "{}{}", err(&o), out(&o));
    b.ok(&["accent", GREEN_L, "--mode", "light"]);
    let v = b.json(&["export", "json"]);
    assert_eq!(v["surfaces"]["site"]["light"]["accent"], GREEN_L);
    assert_eq!(v["surfaces"]["site"]["light"]["on_accent"], "#ffffff");
}

#[test]
fn one_accent_with_no_mode_stays_where_it_reads_and_moves_where_it_does_not() {
    let b = Box::new();
    let (c, v) = b.jrun(&["accent", GREEN_L]);
    assert_eq!(c, 0, "{v}");
    assert_eq!(v["data"]["accent_light"], GREEN_L.to_lowercase(), "{v}");
    let dark = v["data"]["accent_dark"].as_str().unwrap().to_string();
    assert_ne!(dark, GREEN_L.to_lowercase(), "dark needs a lighter color");
    let notes = v["data"]["notes"].to_string();
    assert!(notes.contains(&format!("dark uses {dark}")), "{notes}");
    // What it chose is a real, readable theme, and undo takes it all back.
    let t = b.json(&["show", "--json"]);
    assert_eq!(
        t["surfaces"]["site"]["dark"]["accent"],
        dark.as_str(),
        "{t}"
    );
    b.ok(&["undo"]);
    assert!(b.json(&["current", "--json"])["accent_dark"].is_null());
}

#[test]
fn accent_that_fails_contrast_is_refused_and_state_is_unchanged() {
    let b = Box::new();
    b.ok(&["set", "polycarp"]);
    let before = fs::read(b.state_file()).unwrap();
    let outputs_before = fs::read(b.cfg().join("current/theme.json")).unwrap();
    let hist = b.history_count();
    // With --mode the color is taken exactly or refused, never moved.
    let e = b.refused(&["accent", "#2255aa", "--mode", "dark"]);
    assert!(
        e.contains("dark.accent on dark.background is 1.93, needs 4.5"),
        "{e}"
    );
    assert!(e.contains("nothing changed"), "{e}");
    // Too pale in light mode.
    let e = b.refused(&["accent", "#f0f0a0", "--mode", "light"]);
    assert!(e.contains("light.accent on light.background is"), "{e}");
    assert_eq!(fs::read(b.state_file()).unwrap(), before);
    assert_eq!(
        fs::read(b.cfg().join("current/theme.json")).unwrap(),
        outputs_before
    );
    assert_eq!(b.history_count(), hist);
    // Not a color at all.
    let e = b.refused(&["accent", "blue"]);
    assert!(e.contains("not a color"), "{e}");
    assert_eq!(fs::read(b.state_file()).unwrap(), before);
    // Limited to light, the first color is accepted.
    b.ok(&["accent", "#2255aa", "--mode", "light"]);
    assert_eq!(b.json(&["current", "--json"])["accent_light"], "#2255aa");
    assert_eq!(b.history_count(), hist + 1);
}

#[test]
fn accent_is_kept_by_set_when_it_reads_and_cleared_when_it_does_not() {
    let b = Box::new();
    // 4.57 on evening's light background, 4.29 on parchment's (it needs 4.5).
    b.ok(&["accent", "#666e76", "--mode", "light"]);
    b.ok(&["set", "evening"]);
    assert_eq!(b.json(&["current", "--json"])["accent_light"], "#666e76");
    let o = b.run(&["theme", "set", "parchment"]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert!(
        err(&o).contains("accent override does not read well on parchment"),
        "{}",
        err(&o)
    );
    let cur = b.json(&["current", "--json"]);
    assert_eq!(cur["theme"], "parchment");
    assert!(cur["accent_light"].is_null());
}

// --- create, edit-path, delete -----------------------------------------------------------------

#[test]
fn create_writes_a_valid_commented_theme_and_never_overwrites() {
    let b = Box::new();
    let o = b.ok(&["create", "my-theme", "--extends", "parchment"]);
    let path = b.cfg().join("themes").join("my-theme.toml");
    assert!(o.contains(path.to_str().unwrap()), "{o}");
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("name = \"my-theme\""));
    assert!(text.contains("title = \"My Theme\""));
    assert!(text.contains("extends = \"parchment\""));
    for section in [
        "# [light]",
        "# [dark]",
        "# [shape]",
        "# [type]",
        "# [motion]",
        "# [surface.site.light]",
    ] {
        assert!(text.contains(section), "{section}");
    }
    assert!(text.contains("# radius_small = 2"), "{text}");
    b.ok(&["validate", path.to_str().unwrap()]);
    b.ok(&["set", "my-theme"]);

    // No overwrite without --force.
    fs::write(&path, format!("{text}# my own note\n")).unwrap();
    let e = b.refused(&["create", "my-theme", "--extends", "polycarp"]);
    assert!(e.contains("already exists"), "{e}");
    assert!(fs::read_to_string(&path).unwrap().contains("# my own note"));
    b.ok(&["create", "my-theme", "--extends", "polycarp", "--force"]);
    let again = fs::read_to_string(&path).unwrap();
    assert!(!again.contains("# my own note") && again.contains("extends = \"polycarp\""));
}

#[test]
fn apply_refuses_an_empty_effective_name_before_writing() {
    let b = Box::new();
    let doc = user_theme("mine", "polycarp", "");
    let before = b.snapshot();
    for args in [
        vec!["apply", "-", "--name", ""],
        vec!["apply", "-", "--name", "Bad Name"],
    ] {
        let mut a = vec!["theme"];
        a.extend(args.iter());
        a.push("--json");
        let o = b.run_stdin(&a, &doc);
        assert_eq!(code(&o), 1, "{args:?}: {}", out(&o));
        let v: Value = serde_json::from_str(&out(&o)).unwrap();
        assert_eq!(v["error"]["data"]["errors"][0]["path"], "name");
    }
    assert!(!b.cfg().join("themes").join(".toml").exists());
    assert_eq!(b.snapshot(), before);
}

#[test]
fn create_refuses_reserved_and_bad_names_and_missing_bases() {
    let b = Box::new();
    for n in BUILTINS {
        let e = b.refused(&["create", n, "--extends", "polycarp"]);
        assert!(e.contains("built-in theme name"), "{n}: {e}");
        assert!(!b.cfg().join(format!("themes/{n}.toml")).exists());
    }
    let e = b.refused(&["create", "Bad_Name", "--extends", "polycarp"]);
    assert!(e.contains("not a valid theme name"), "{e}");
    let e = b.refused(&["create", "../escape", "--extends", "polycarp"]);
    assert!(e.contains("not a valid theme name"), "{e}");
    let e = b.refused(&["create", "ok-name", "--extends", "nothing"]);
    assert!(e.contains("cannot extend"), "{e}");
    let o = b.run(&["theme", "create", "ok-name"]);
    assert_eq!(code(&o), 2);
    assert!(!b.cfg().join("themes/ok-name.toml").exists());
}

#[test]
fn edit_path_prints_the_path() {
    let b = Box::new();
    let p = b.ok(&["edit-path", "mine"]);
    assert_eq!(
        p.trim(),
        b.cfg().join("themes").join("mine.toml").to_str().unwrap()
    );
    let e = b.refused(&["edit-path", "calm"]);
    assert!(e.contains("built in"), "{e}");
}

#[test]
fn delete_rules() {
    let b = Box::new();
    let e = b.refused(&["delete", "calm"]);
    assert!(e.contains("built in"), "{e}");
    let e = b.refused(&["delete", "ghost"]);
    assert!(e.contains("no user theme"), "{e}");
    b.ok(&["create", "mine", "--extends", "evening"]);
    b.ok(&["set", "mine"]);
    let e = b.refused(&["delete", "mine"]);
    assert!(e.contains("is the current theme"), "{e}");
    assert!(b.cfg().join("themes/mine.toml").exists());
    b.ok(&["set", "polycarp"]);
    b.ok(&["delete", "mine"]);
    assert!(!b.cfg().join("themes/mine.toml").exists());
    // The current theme is protected even when the state file is otherwise broken.
    b.ok(&["create", "other", "--extends", "evening"]);
    fs::write(
        b.state_file(),
        "[appearance]\ntheme = \"other\"\nmode = \"purple\"\n",
    )
    .unwrap();
    let e = b.refused(&["delete", "other"]);
    assert!(e.contains("is the current theme"), "{e}");
}

// --- history, undo, reset ----------------------------------------------------------------------

#[test]
fn history_and_undo() {
    let b = Box::new();
    let o = b.run(&["theme", "undo"]);
    assert_eq!(code(&o), 1);
    assert!(err(&o).contains("nothing to undo"));
    assert!(b.ok(&["history"]).contains("no history"));

    let o = b.run_as("agent:claude", &["theme", "set", "evening"]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    b.ok(&["set", "still-water"]);
    b.ok(&["accent", GREEN_L, "--mode", "light"]);

    let h = b.json(&["history", "--json"])["entries"].clone();
    let h = h.as_array().unwrap();
    assert_eq!(h.len(), 3);
    assert_eq!(h[0]["action"], "theme accent #2f6b55");
    assert_eq!(h[0]["caller"], "user");
    assert_eq!(h[2]["action"], "theme set evening");
    assert_eq!(h[2]["caller"], "agent:claude");
    let t = h[2]["time"].as_str().unwrap();
    assert!(
        t.len() == 24 && t.ends_with('Z') && t.as_bytes()[10] == b'T',
        "{t}"
    );
    let text = b.ok(&["history"]);
    assert!(text.contains("agent:claude") && text.contains("theme set still-water"));

    // The history file keeps the previous config.toml exactly.
    let newest = h[0]["file"].as_str().unwrap();
    let kept = fs::read_to_string(newest).unwrap();
    assert!(kept.contains("theme = \"still-water\""), "{kept}");

    // Undo steps back one change at a time and rewrites the outputs.
    let o = b.ok(&["undo"]);
    assert!(o.contains("undid: theme accent #2f6b55"), "{o}");
    let cur = b.json(&["current", "--json"]);
    assert_eq!(cur["theme"], "still-water");
    assert!(cur["accent_light"].is_null());
    let v: Value =
        serde_json::from_str(&fs::read_to_string(b.cfg().join("current/theme.json")).unwrap())
            .unwrap();
    assert_eq!(v["name"], "still-water");
    b.ok(&["undo"]);
    assert_eq!(b.json(&["current", "--json"])["theme"], "evening");
    // Undoing the first change goes back to having no config file at all.
    b.ok(&["undo"]);
    assert!(!b.state_file().exists());
    assert_eq!(b.json(&["current", "--json"])["theme"], "polycarp");
    let v: Value =
        serde_json::from_str(&fs::read_to_string(b.cfg().join("current/theme.json")).unwrap())
            .unwrap();
    assert_eq!(v["name"], "polycarp");
    assert_eq!(code(&b.run(&["theme", "undo"])), 1);
}

#[test]
fn history_survives_the_end_marker_and_newlines_in_titles_and_callers() {
    let b = Box::new();
    let doc = user_theme("mine", "polycarp", "");
    assert_eq!(code(&b.run_stdin(&["theme", "apply", "-"], &doc)), 0);
    let theme_file = b.cfg().join("themes").join("mine.toml");
    let first = fs::read_to_string(&theme_file).unwrap();
    // Titles can no longer hold line breaks; the marker text itself is still harmless.
    for title in ["# ---", "a # --- b", "# --- # time = nope # ---"] {
        let before = fs::read_to_string(&theme_file).unwrap();
        let o = b
            .cmd(&["theme", "change", "title", title])
            .env("POLYCARP_CALLER", "# ---\n# caller = evil")
            .output()
            .unwrap();
        assert_eq!(code(&o), 0, "{title:?}: {}", err(&o));
        let h = b.json(&["history", "--json"]);
        let e = &h["entries"][0];
        assert_eq!(e["caller"], "# ---# caller = evil", "{h}");
        assert!(e["action"]
            .as_str()
            .unwrap()
            .starts_with("theme change title"));
        let o = b.ok(&["undo"]);
        assert!(o.contains("undid: theme change title"), "{o}");
        assert_eq!(
            fs::read_to_string(&theme_file).unwrap(),
            before,
            "{title:?}"
        );
    }
    assert_eq!(fs::read_to_string(&theme_file).unwrap(), first);
    assert_eq!(b.json(&["current", "--json"])["theme"], "mine");
}

#[test]
fn undo_puts_back_only_appearance_and_keeps_other_tables() {
    let b = Box::new();
    // The file starts with another table and no [appearance].
    fs::create_dir_all(b.cfg()).unwrap();
    fs::write(b.state_file(), "[other]\nkeep = \"me\"\n").unwrap();
    b.ok(&["set", "evening"]);
    // Something else adds a table between the change and the undo.
    let mut live = fs::read_to_string(b.state_file()).unwrap();
    live.push_str("\n[extra]\nx = 2\n");
    fs::write(b.state_file(), live).unwrap();
    b.ok(&["set", "calm"]);
    b.ok(&["undo"]);
    let t: toml::Table = fs::read_to_string(b.state_file()).unwrap().parse().unwrap();
    assert_eq!(t["appearance"]["theme"].as_str(), Some("evening"));
    assert_eq!(t["other"]["keep"].as_str(), Some("me"));
    assert_eq!(t["extra"]["x"].as_integer(), Some(2));
    // Undoing the first change removes [appearance] and nothing else.
    b.ok(&["undo"]);
    let t: toml::Table = fs::read_to_string(b.state_file()).unwrap().parse().unwrap();
    assert!(t.get("appearance").is_none(), "{t:?}");
    assert_eq!(t["other"]["keep"].as_str(), Some("me"));
    assert_eq!(t["extra"]["x"].as_integer(), Some(2));
}

#[test]
fn undo_of_a_first_change_removes_appearance_not_other_tables() {
    let b = Box::new();
    b.ok(&["set", "evening"]);
    assert!(b.history_count() == 1);
    let mut live = fs::read_to_string(b.state_file()).unwrap();
    live.push_str("\n[extra]\nx = 2\n");
    fs::write(b.state_file(), live).unwrap();
    b.ok(&["undo"]);
    let t: toml::Table = fs::read_to_string(b.state_file()).unwrap().parse().unwrap();
    assert!(t.get("appearance").is_none());
    assert_eq!(t["extra"]["x"].as_integer(), Some(2));
}

#[test]
fn an_unreadable_config_is_an_io_error_not_an_absent_file() {
    let b = Box::new();
    // A folder where the file should be: reading it fails, and it does not simply "not exist".
    fs::create_dir_all(b.state_file()).unwrap();
    let (c, v) = b.jrun(&["set", "evening"]);
    assert_eq!(c, 1, "{v}");
    assert_eq!(v["error"]["code"], "io_error", "{v}");
    assert_eq!(b.history_count(), 0, "nothing may be recorded as absent");
}

#[test]
fn undo_refuses_a_damaged_history_entry_and_changes_nothing() {
    let b = Box::new();
    b.ok(&["set", "evening"]);
    b.ok(&["set", "calm"]);
    let newest = b.json(&["history", "--json"])["entries"][0]["file"]
        .as_str()
        .unwrap()
        .to_string();
    let before = fs::read(b.state_file()).unwrap();
    for bad in [
        "not a history file at all\n".to_string(),
        // The header promises theme bytes that are not there.
        "# polycarp-history 1\n# time = t\n# caller = \"user\"\n# action = \"x\"\n# theme_file = mine\n# theme_bytes = 500\n# ---\n[appearance]\n".to_string(),
    ] {
        fs::write(&newest, bad).unwrap();
        let (c, v) = b.jrun(&["undo"]);
        assert_eq!(c, 1, "{v}");
        assert_eq!(v["error"]["code"], "io_error", "{v}");
        assert!(v["error"]["message"].as_str().unwrap().contains("damaged"), "{v}");
        assert_eq!(fs::read(b.state_file()).unwrap(), before);
        assert!(!b.cfg().join("themes").join("mine.toml").exists());
    }
}

#[test]
fn undo_rejects_malformed_history_metadata_before_any_write() {
    let head = "# polycarp-history 1\n# time = t\n# caller = \"user\"\n# action = \"x\"\n";
    let cases = [
        // Not a number, a sign, and a length with trailing text.
        format!("{head}# theme_file = mine\n# theme_bytes = abc\n# theme_after = absent\n# ---\n[appearance]\n"),
        format!("{head}# theme_file = mine\n# theme_bytes = -3\n# theme_after = absent\n# ---\n[appearance]\n"),
        format!("{head}# theme_file = mine\n# theme_bytes = 3x\n# theme_after = absent\n# ---\n[appearance]\n"),
        // Both "was there" and "was not there".
        format!("{head}# theme_file = mine\n# theme_bytes = 0\n# theme_file_absent = true\n# theme_after = absent\n# ---\n"),
        // Neither.
        format!("{head}# theme_file = mine\n# theme_after = absent\n# ---\n"),
        // No record of what the change left behind.
        format!("{head}# theme_file = mine\n# theme_file_absent = true\n# ---\n"),
        // A length with no theme file named.
        format!("{head}# theme_bytes = 4\n# ---\n[appearance]\n"),
        // A name that is not a theme name.
        format!("{head}# theme_file = ../config\n# theme_file_absent = true\n# theme_after = absent\n# ---\n"),
        // No time, caller or action.
        "# polycarp-history 1\n# ---\n".to_string(),
    ];
    for bad in cases {
        let b = Box::new();
        b.ok(&["create", "mine", "--extends", "calm"]);
        b.ok(&["set", "evening"]);
        let newest = b.json(&["history", "--json"])["entries"][0]["file"]
            .as_str()
            .unwrap()
            .to_string();
        fs::write(&newest, &bad).unwrap();
        let theme_file = b.cfg().join("themes").join("mine.toml");
        let theme = fs::read(&theme_file).unwrap();
        let state = fs::read(b.state_file()).unwrap();
        let (c, v) = b.jrun(&["undo"]);
        assert_eq!(c, 1, "{bad:?}: {v}");
        assert!(
            v["error"]["message"].as_str().unwrap().contains("damaged"),
            "{bad:?}: {v}"
        );
        assert_eq!(fs::read(&theme_file).unwrap(), theme, "{bad:?}");
        assert_eq!(fs::read(b.state_file()).unwrap(), state, "{bad:?}");
    }
}

#[test]
fn undo_will_not_overwrite_a_hand_edited_theme_unless_forced() {
    let b = Box::new();
    b.ok(&["create", "mine", "--extends", "calm"]);
    let theme_file = b.cfg().join("themes").join("mine.toml");
    let edited = format!(
        "{}\n# my note\n[shape]\nradius = 11\n",
        fs::read_to_string(&theme_file).unwrap()
    );
    fs::write(&theme_file, &edited).unwrap();
    b.ok(&["set", "evening"]);
    // Undoing the set touches no theme file, so it goes through.
    b.ok(&["undo"]);
    let hist = b.history_count();
    // Undoing the create would delete the hand-edited file.
    let (c, v) = b.jrun(&["undo"]);
    assert_eq!(c, 1, "{v}");
    assert_eq!(v["error"]["code"], "changed_since", "{v}");
    let m = v["error"]["message"].as_str().unwrap();
    assert!(m.contains("mine.toml") && m.contains("edited"), "{m}");
    assert!(
        v["error"]["suggestion"]
            .as_str()
            .unwrap()
            .contains("--force"),
        "{v}"
    );
    assert_eq!(fs::read_to_string(&theme_file).unwrap(), edited);
    assert_eq!(b.history_count(), hist, "nothing was undone");
    // With force, the edited text is kept in history/ and the create is undone.
    let v = b.json(&["undo", "--force", "--json"]);
    let copy = v["undid"]["saved_copy"]
        .as_str()
        .expect("a saved copy is named");
    assert_eq!(fs::read_to_string(copy).unwrap(), edited);
    assert!(Path::new(copy).starts_with(b.cfg().join("history")));
    assert!(!theme_file.exists());
    assert_eq!(b.history_count(), hist, "the entry is gone, the copy stays");
}

#[test]
fn undo_of_an_unedited_theme_change_needs_no_force() {
    let b = Box::new();
    b.ok(&["create", "mine", "--extends", "calm"]);
    b.ok(&["change", "shape.radius", "7"]);
    b.ok(&["undo"]);
    b.ok(&["undo"]);
    assert!(!b.cfg().join("themes").join("mine.toml").exists());
}

#[test]
fn undo_says_who_made_the_change_it_undid() {
    let b = Box::new();
    let o = b.run_as("agent:claude-code", &["theme", "set", "evening"]);
    assert_eq!(code(&o), 0);
    let text = b.ok(&["undo"]);
    assert!(
        text.starts_with("undid: theme set evening (made by agent:claude-code, "),
        "{text}"
    );
    b.run_as("agent:other", &["theme", "set", "calm"]);
    let v = b.json(&["undo", "--json"]);
    assert_eq!(v["undid"]["caller"], "agent:other");
}

#[test]
fn history_keeps_the_last_50() {
    let b = Box::new();
    for i in 0..56 {
        let name = if i % 2 == 0 { "evening" } else { "calm" };
        b.ok(&["set", name]);
    }
    assert_eq!(b.history_count(), 50);
    let h = b.json(&["history", "--json"])["entries"].clone();
    assert_eq!(h.as_array().unwrap().len(), 50);
    // Newest first, and sorted by time.
    let times: Vec<&str> = h
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["time"].as_str().unwrap())
        .collect();
    let mut sorted = times.clone();
    sorted.sort();
    sorted.reverse();
    assert_eq!(times, sorted);
}

#[test]
fn caller_is_cleaned() {
    let b = Box::new();
    let o = b.run_as("agent:x\nmalicious = 1", &["theme", "set", "evening"]);
    assert_eq!(code(&o), 0);
    let h = b.json(&["history", "--json"])["entries"].clone();
    assert_eq!(h[0]["caller"], "agent:xmalicious = 1");
    let o = b.run_as("   ", &["theme", "set", "calm"]);
    assert_eq!(code(&o), 0);
    assert_eq!(
        b.json(&["history", "--json"])["entries"][0]["caller"],
        "user"
    );
}

#[test]
fn reset_goes_back_to_defaults_and_is_recorded() {
    let b = Box::new();
    b.ok(&["set", "blocks", "--mode", "light"]);
    b.ok(&["accent", GREEN_L, "--mode", "light"]);
    let o = b.ok(&["reset"]);
    assert!(o.contains("theme: polycarp") && o.contains("mode: auto"));
    let cur = b.json(&["current", "--json"]);
    assert_eq!(cur["theme"], "polycarp");
    assert_eq!(cur["mode"], "auto");
    assert!(cur["accent_light"].is_null() && cur["accent_dark"].is_null());
    assert_eq!(
        b.json(&["history", "--json"])["entries"][0]["action"],
        "theme reset"
    );
    // And it can be undone.
    b.ok(&["undo"]);
    assert_eq!(b.json(&["current", "--json"])["theme"], "blocks");
}

#[test]
fn reset_and_undo_work_with_a_corrupt_user_theme_and_corrupt_state() {
    let b = Box::new();
    b.ok(&["create", "mine", "--extends", "evening"]);
    b.ok(&["set", "evening"]);
    b.ok(&["set", "mine"]);
    // Break the user theme while it is current.
    fs::write(b.cfg().join("themes/mine.toml"), "this is [not toml").unwrap();
    let cur = b.run(&["theme", "current", "--json"]);
    assert_eq!(code(&cur), 0, "{}", err(&cur));
    let v: Value = serde_json::from_str::<Value>(&out(&cur)).unwrap()["data"].clone();
    assert_eq!(v["theme"], "polycarp");
    assert_eq!(v["fell_back"], true);
    assert!(v["problems"][0].as_str().unwrap().contains("mine"), "{v}");
    // Undo restores the earlier state even though the current theme is broken.
    b.ok(&["undo"]);
    assert_eq!(b.json(&["current", "--json"])["theme"], "evening");
    // Put the broken theme back in force, with binary junk in the state file too.
    fs::write(b.state_file(), [0xff, 0xfe, 0x00, b'[', 0x80]).unwrap();
    let cur = b.run(&["theme", "current"]);
    assert_eq!(code(&cur), 0);
    assert!(out(&cur).contains("theme: polycarp"));
    assert!(err(&cur).contains("warning"), "{}", err(&cur));
    let o = b.run(&["theme", "reset"]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert_eq!(b.json(&["current", "--json"])["fell_back"], false);
    // The broken file was kept in history, so undo brings it back (and falls back, not crashes).
    let o = b.run(&["theme", "undo"]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert!(err(&o).contains("warning"), "{}", err(&o));
    assert_eq!(b.json(&["current", "--json"])["fell_back"], true);
    // The outputs were written from the default theme.
    let v: Value =
        serde_json::from_str(&fs::read_to_string(b.cfg().join("current/theme.json")).unwrap())
            .unwrap();
    assert_eq!(v["name"], "polycarp");
    // And reset works while the state file is invalid TOML text.
    fs::write(b.state_file(), "[appearance\ntheme = ").unwrap();
    assert_eq!(code(&b.run(&["theme", "reset"])), 0);
    assert!(fs::read_to_string(b.state_file())
        .unwrap()
        .contains("theme = \"polycarp\""));
}

/// Breaks the outputs two ways, runs `args`, and checks the settings are saved with a warning that
/// names the files, for both a directory in a file's place and a plain file in `current`'s place.
fn outputs_fail_but_settings_are_saved(args: &[&str], expect_theme: &str) {
    for case in ["dir-at-site-css", "file-at-current"] {
        let b = Box::new();
        b.ok(&["set", "evening"]);
        let current = b.cfg().join("current");
        if case == "dir-at-site-css" {
            fs::remove_file(current.join("site.css")).unwrap();
            fs::create_dir(current.join("site.css")).unwrap();
        } else {
            fs::remove_dir_all(&current).unwrap();
            fs::write(&current, "in the way").unwrap();
        }
        let (c, v) = b.jrun(args);
        assert_eq!(c, 0, "{case} {args:?}: {v}");
        let w = v["data"]["warnings"].to_string();
        assert!(w.contains("the settings are saved"), "{case}: {w}");
        assert!(w.contains("site.css"), "{case}: {w}");
        if case == "file-at-current" {
            assert!(w.contains("theme.json") && w.contains("spaces.css"), "{w}");
        }
        let text = fs::read_to_string(b.state_file()).unwrap();
        assert!(text.contains(expect_theme), "{case}: {text}");
        assert_eq!(b.history_count(), 2, "{case}: the change is recorded once");
    }
}

#[test]
fn set_and_change_keep_saved_settings_when_an_output_cannot_be_written() {
    outputs_fail_but_settings_are_saved(&["set", "calm"], "theme = \"calm\"");
    outputs_fail_but_settings_are_saved(
        &["change", "shape.radius", "3"],
        "theme = \"evening-custom\"",
    );
}

#[test]
fn a_failed_theme_or_config_write_is_put_back_and_reported() {
    // The themes folder is a plain file, so the theme file for `change` cannot be written.
    let b = Box::new();
    b.ok(&["set", "evening"]);
    let before = fs::read_to_string(b.state_file()).unwrap();
    let hist = b.history_count();
    fs::write(b.cfg().join("themes"), "in the way").unwrap();
    let (c, v) = b.jrun(&["change", "shape.radius", "3"]);
    assert_eq!(c, 1, "{v}");
    assert_eq!(v["error"]["code"], "io_error", "{v}");
    assert_eq!(fs::read_to_string(b.state_file()).unwrap(), before);
    assert_eq!(
        b.history_count(),
        hist,
        "no entry for a change that did not happen"
    );
    // config.toml is a directory, so the state cannot be written; the theme file is put back.
    let b = Box::new();
    let first = user_theme("mine", "calm", "[shape]\nradius = 2");
    assert_eq!(
        code(&b.run_stdin(&["theme", "apply", "-", "--no-activate"], &first)),
        0
    );
    let theme_file = b.cfg().join("themes").join("mine.toml");
    let text = fs::read_to_string(&theme_file).unwrap();
    let hist = b.history_count();
    fs::create_dir_all(b.state_file()).unwrap();
    let second = user_theme("mine", "calm", "[shape]\nradius = 9");
    let o = b.run_stdin(&["theme", "apply", "-"], &second);
    assert_eq!(code(&o), 1, "{}{}", err(&o), out(&o));
    assert_eq!(fs::read_to_string(&theme_file).unwrap(), text);
    assert_eq!(b.history_count(), hist);
}

#[test]
fn reset_works_when_history_and_current_cannot_be_written() {
    let b = Box::new();
    b.ok(&["set", "evening"]);
    // A plain file where each folder should be, and a lock someone else holds.
    fs::remove_dir_all(b.cfg().join("history")).unwrap();
    fs::write(b.cfg().join("history"), "in the way").unwrap();
    fs::remove_dir_all(b.cfg().join("current")).unwrap();
    fs::write(b.cfg().join("current"), "in the way").unwrap();
    let _held = hold_lock(&b);
    let (c, v) = b.jrun(&["reset"]);
    assert_eq!(c, 0, "{v}");
    let w = v["data"]["warnings"].to_string();
    assert!(w.contains("not recorded in history"), "{w}");
    assert!(w.contains("not refreshed"), "{w}");
    assert!(w.contains("could not take the lock"), "{w}");
    assert_eq!(b.json(&["current", "--json"])["theme"], "polycarp");
    let text = fs::read_to_string(b.state_file()).unwrap();
    assert!(text.contains("theme = \"polycarp\""), "{text}");
    // On a terminal the warnings do not claim the default theme was swapped in.
    let o = b.run(&["theme", "reset"]);
    assert_eq!(code(&o), 0);
    assert!(!err(&o).contains("using the default theme"), "{}", err(&o));
}

#[test]
fn set_replaces_a_broken_state_file_and_says_so() {
    let b = Box::new();
    fs::create_dir_all(b.cfg()).unwrap();
    fs::write(b.state_file(), "[appearance]\nmode = 5\n").unwrap();
    let o = b.run(&["theme", "set", "evening"]);
    assert_eq!(code(&o), 0);
    assert!(err(&o).contains("old settings were invalid"), "{}", err(&o));
    assert_eq!(b.json(&["current", "--json"])["theme"], "evening");
    assert_eq!(b.json(&["current", "--json"])["fell_back"], false);
}

#[test]
fn broken_state_falls_back_and_current_reports_it() {
    let b = Box::new();
    fs::create_dir_all(b.cfg()).unwrap();
    let cases = [
        ("[appearance]\nmode = \"purple\"\n", "appearance.mode"),
        ("[appearance]\ntheme = \"no-such\"\n", "no-such"),
        ("[appearance]\ntheme = \"../up\"\n", "appearance.theme"),
        (
            "[appearance]\naccent_light = \"red\"\n",
            "appearance.accent_light",
        ),
        (
            "[appearance]\nthemee = \"x\"\n",
            "appearance.themee: unknown key",
        ),
        (
            "[appearance]\naccent_dark = \"#2255aa\"\n",
            "dark.accent on dark.background",
        ),
        ("appearance = 3\n", "appearance: must be a table"),
        ("not = [valid", "could not read the file as TOML"),
    ];
    for (text, want) in cases {
        fs::write(b.state_file(), text).unwrap();
        let o = b.run(&["theme", "current", "--json"]);
        assert_eq!(code(&o), 0, "{text}: {}", err(&o));
        let v: Value = serde_json::from_str::<Value>(&out(&o)).unwrap()["data"].clone();
        assert_eq!(v["theme"], "polycarp", "{text}");
        assert_eq!(v["mode"], "auto", "{text}");
        assert_eq!(v["fell_back"], true, "{text}");
        let probs = v["problems"].to_string();
        assert!(probs.contains(want), "{text}: {probs}");
        // Other commands keep working too.
        let o = b.run(&["theme", "export", "css"]);
        assert_eq!(code(&o), 0);
        assert!(out(&o).contains("--pc-accent: #59693f;"), "{text}");
        let o = b.run(&["theme", "list"]);
        assert_eq!(code(&o), 0);
    }
}

#[test]
fn other_tables_in_config_toml_are_kept() {
    let b = Box::new();
    fs::create_dir_all(b.cfg()).unwrap();
    fs::write(b.state_file(), "[dock]\nenabled = false\n").unwrap();
    b.ok(&["set", "evening"]);
    let text = fs::read_to_string(b.state_file()).unwrap();
    assert!(
        text.contains("[dock]") && text.contains("enabled = false"),
        "{text}"
    );
    assert!(text.contains("theme = \"evening\""), "{text}");
}

#[cfg(unix)]
#[test]
fn writes_follow_symlinks_keep_modes_and_new_files_are_0644() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    let b = Box::new();
    b.ok(&["set", "evening"]);
    let there = b.root.join("elsewhere");
    fs::create_dir_all(&there).unwrap();
    // current/site.css and config.toml are links to files in another folder, with their own modes.
    let css_link = b.cfg().join("current").join("site.css");
    let css_real = there.join("real.css");
    fs::rename(&css_link, &css_real).unwrap();
    fs::set_permissions(&css_real, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&css_real, &css_link).unwrap();
    let cfg_real = there.join("real-config.toml");
    fs::rename(b.state_file(), &cfg_real).unwrap();
    fs::set_permissions(&cfg_real, fs::Permissions::from_mode(0o640)).unwrap();
    symlink(&cfg_real, b.state_file()).unwrap();
    // A file that does not exist yet is created with 0644.
    let voice = b.cfg().join("current").join("voice.css");
    fs::remove_file(&voice).unwrap();

    b.ok(&["set", "calm"]);

    for link in [&css_link, &b.state_file()] {
        assert!(
            fs::symlink_metadata(link).unwrap().file_type().is_symlink(),
            "{link:?} stopped being a link"
        );
    }
    assert!(fs::read_to_string(&css_real).unwrap().contains("\"calm\""));
    assert!(fs::read_to_string(&cfg_real).unwrap().contains("calm"));
    assert_eq!((mode(&css_real), mode(&cfg_real)), (0o600, 0o640));
    assert_eq!(mode(&voice), 0o644);
    let mut files = Vec::new();
    files_under(&there, &mut files);
    files_under(&b.cfg(), &mut files);
    assert!(
        files.iter().all(|f| !f.to_string_lossy().contains(".tmp")),
        "{files:?}"
    );
}

#[test]
fn several_processes_changing_one_theme_lose_nothing() {
    let b = Box::new();
    let doc = user_theme("mine", "polycarp", "");
    assert_eq!(code(&b.run_stdin(&["theme", "apply", "-"], &doc)), 0);
    let changes = [
        ("shape.radius_small", "1"),
        ("shape.radius", "2"),
        ("shape.radius_large", "3"),
        ("shape.border_width", "4"),
        ("shape.blur", "5"),
        ("motion.fast", "6"),
        ("motion.normal", "7"),
        ("motion.slow", "8"),
        ("type.size", "17"),
        ("type.weight", "500"),
    ];
    let children: Vec<_> = changes
        .iter()
        .map(|(path, value)| {
            b.cmd(&["theme", "change", path, value])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for ch in children {
        let o = ch.wait_with_output().unwrap();
        assert_eq!(code(&o), 0, "{}", err(&o));
    }
    for (path, value) in changes {
        assert_eq!(b.ok(&["get", path]).trim(), value, "{path} was lost");
    }
    assert_eq!(b.history_count(), changes.len() + 1);
    // The lock file stays; the system lock is what is released.
    let f = fs::File::options()
        .write(true)
        .open(b.cfg().join(".lock"))
        .unwrap();
    assert!(f.try_lock().is_ok(), "the lock is released");
}

/// Takes the same operating-system lock the command uses, as another running command would.
fn hold_lock(b: &Box) -> fs::File {
    fs::create_dir_all(b.cfg()).unwrap();
    let f = fs::File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(b.cfg().join(".lock"))
        .unwrap();
    f.lock().unwrap();
    f
}

#[test]
fn a_live_lock_holder_is_never_displaced_and_busy_says_to_retry() {
    let b = Box::new();
    let held = hold_lock(&b);
    // Older than the old 10 second stale limit: a live holder keeps it anyway.
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
    held.set_modified(old).unwrap();
    let t = std::time::Instant::now();
    let (c, v) = b.jrun(&["set", "calm"]);
    assert_eq!(c, 1, "{v}");
    assert_eq!(v["error"]["code"], "busy", "{v}");
    assert_eq!(v["error"]["retry"], "after", "{v}");
    assert!(t.elapsed().as_secs() >= 4, "gave up too early");
    assert!(!b.state_file().exists());
    assert!(
        b.cfg().join(".lock").exists(),
        "the lock file is never removed"
    );
    // Once the holder lets go, the same command works and the file stays.
    drop(held);
    b.ok(&["set", "calm"]);
    assert!(b.cfg().join(".lock").exists());
}

const PARENT_V2: &str = r##"name = "parent"
title = "Parent"
extends = "polycarp"
[dark]
background = "#f0f0f0"
surface = "#fafafa"
sunken = "#e0e0e0"
foreground = "#101010"
strong = "#000000"
muted = "#404040"
selection = "#d0d0d0"
accent = "#2f4a1a"
on_accent = "#ffffff"
urgent = "#8a1f10"
working = "#6a5000"
done = "#1f4f4a"
"##;

#[test]
fn create_force_and_delete_are_recorded_and_undo_restores_them() {
    let b = Box::new();
    b.ok(&["create", "mine", "--extends", "calm"]);
    let first = fs::read_to_string(b.cfg().join("themes").join("mine.toml")).unwrap();
    b.ok(&["create", "mine", "--extends", "evening", "--force"]);
    let second = fs::read_to_string(b.cfg().join("themes").join("mine.toml")).unwrap();
    assert_ne!(first, second);
    b.ok(&["undo"]);
    assert_eq!(
        fs::read_to_string(b.cfg().join("themes").join("mine.toml")).unwrap(),
        first
    );
    b.ok(&["delete", "mine"]);
    assert!(!b.cfg().join("themes").join("mine.toml").exists());
    let h = b.json(&["history", "--json"]);
    assert_eq!(h["entries"][0]["action"], "theme delete mine");
    b.ok(&["undo"]);
    assert_eq!(
        fs::read_to_string(b.cfg().join("themes").join("mine.toml")).unwrap(),
        first
    );
    // Undoing the first create removes the file again.
    b.ok(&["undo"]);
    assert!(!b.cfg().join("themes").join("mine.toml").exists());
}

#[test]
fn create_force_over_the_current_theme_refreshes_the_files() {
    let b = Box::new();
    b.ok(&["create", "mine", "--extends", "calm"]);
    b.ok(&["set", "mine"]);
    let reduced = |b: &Box| b.json(&["export", "json"])["reduced_motion"].clone();
    assert_eq!(reduced(&b), true);
    b.ok(&["create", "mine", "--extends", "blocks", "--force"]);
    let on_disk: Value = serde_json::from_str(
        &fs::read_to_string(b.cfg().join("current").join("theme.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(on_disk["reduced_motion"], false, "current/ is stale");
}

#[test]
fn create_and_delete_refuse_loops_and_the_current_chain() {
    let b = Box::new();
    let e = b.refused(&["create", "mine", "--extends", "mine"]);
    assert!(e.contains("cannot extend itself"), "{e}");
    b.ok(&["create", "base", "--extends", "calm"]);
    b.ok(&["create", "kid", "--extends", "base"]);
    let e = b.refused(&["create", "base", "--extends", "kid", "--force"]);
    assert!(e.contains("already extends"), "{e}");
    b.ok(&["set", "kid"]);
    let before = b.snapshot();
    let e = b.refused(&["delete", "base"]);
    assert!(e.contains("base of the current theme"), "{e}");
    assert_eq!(b.snapshot(), before);
    b.ok(&["set", "calm"]);
    b.ok(&["delete", "base"].map(|x| x)[..]);
}

#[test]
fn apply_no_activate_refuses_to_break_the_current_theme_or_its_parent() {
    let b = Box::new();
    let parent = user_theme("parent", "polycarp", "");
    assert_eq!(code(&b.run_stdin(&["theme", "apply", "-"], &parent)), 0);
    let child = user_theme("child", "parent", "[dark]\nforeground = \"#f6f3e8\"");
    assert_eq!(code(&b.run_stdin(&["theme", "apply", "-"], &child)), 0);
    let before = b.snapshot();
    let o = b.run_stdin(&["theme", "apply", "-", "--no-activate"], PARENT_V2);
    assert_eq!(code(&o), 1, "{}", out(&o));
    assert!(err(&o).contains("would stop working"), "{}", err(&o));
    assert_eq!(b.snapshot(), before);
    // The same text is fine when the current theme does not use it.
    b.ok(&["set", "calm"]);
    let o = b.run_stdin(&["theme", "apply", "-", "--no-activate"], PARENT_V2);
    assert_eq!(code(&o), 0, "{}", err(&o));
}

#[test]
fn a_hand_broken_current_theme_is_not_silently_replaced() {
    let b = Box::new();
    b.ok(&["create", "mine", "--extends", "evening"]);
    b.ok(&["set", "mine"]);
    fs::write(
        b.cfg().join("themes").join("mine.toml"),
        "this is [not toml",
    )
    .unwrap();
    let before = b.snapshot();
    for args in [
        vec!["accent", GREEN_L, "--mode", "light"],
        vec!["change", "shape.radius", "3"],
    ] {
        let (c, v) = b.jrun(&args);
        assert_eq!(c, 1, "{args:?}: {v}");
        let msg = v["error"]["message"].as_str().unwrap();
        assert!(msg.contains("current settings are broken"), "{msg}");
        assert!(v["error"]["suggestion"]
            .as_str()
            .unwrap()
            .contains("theme reset"));
        assert!(!v["error"]["data"]["errors"].as_array().unwrap().is_empty());
        assert_eq!(b.snapshot(), before);
    }
    assert!(!b.cfg().join("themes").join("polycarp-custom.toml").exists());
    // The ways out still work.
    b.ok(&["set", "calm"]);
    b.ok(&["reset"]);
}

#[test]
fn a_surface_value_beats_the_global_accent_and_editing_it_keeps_the_global_one() {
    let b = Box::new();
    b.ok(&["accent", GREEN_L, "--mode", "light"]);
    let browser = "#1d5a40";
    let v = b.json(&["change", "surface.browser.light.accent", browser, "--json"]);
    assert!(!v["notes"].to_string().contains("cleared"), "{v}");
    let cur = b.json(&["current", "--json"]);
    assert_eq!(
        cur["accent_light"], GREEN_L,
        "the global accent was cleared"
    );
    let ex = b.json(&["export", "json"]);
    assert_eq!(ex["surfaces"]["browser"]["light"]["accent"], browser);
    for s in ["spaces", "voice", "site"] {
        assert_eq!(ex["surfaces"][s]["light"]["accent"], GREEN_L, "{s}");
    }
    // Only that surface and mode changed; dark is the theme's own everywhere.
    for s in SURFACES {
        assert_eq!(ex["surfaces"][s]["dark"]["accent"], "#a9bb8a", "{s}");
    }
    // A later global accent does not overwrite the surface's own value.
    let other = "#2a5f46";
    b.ok(&["accent", other, "--mode", "light"]);
    let ex = b.json(&["export", "json"]);
    assert_eq!(ex["surfaces"]["browser"]["light"]["accent"], browser);
    assert_eq!(ex["surfaces"]["site"]["light"]["accent"], other);
}

#[test]
fn export_with_no_name_uses_the_forced_mode_like_current_files() {
    let b = Box::new();
    b.ok(&["set", "evening", "--mode", "dark"]);
    let css = b.ok(&["export", "css", "--surface", "site"]);
    let file = fs::read_to_string(b.cfg().join("current").join("site.css")).unwrap();
    assert_eq!(css, file);
    assert!(css.contains("color-scheme: dark;") && !css.contains("prefers-color-scheme"));
    let v = b.json(&["export", "json"]);
    assert_eq!(v["mode"], "dark");
    assert_eq!(
        b.json(&["export", "json", "--surface", "site"])["mode"],
        "dark"
    );
    // A named theme has no forced mode.
    assert_eq!(b.json(&["export", "json", "calm"])["mode"], "auto");
    assert!(b
        .ok(&["export", "css", "calm"])
        .contains("prefers-color-scheme"));
    let on_disk: Value = serde_json::from_str(
        &fs::read_to_string(b.cfg().join("current").join("theme.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(v, on_disk);
}

#[test]
fn atomic_writes_leave_no_temp_files() {
    let b = Box::new();
    b.ok(&["set", "evening", "--mode", "dark"]);
    b.ok(&["accent", GREEN_L, "--mode", "light"]);
    b.ok(&["create", "mine", "--extends", "calm"]);
    b.ok(&["set", "mine"]);
    b.ok(&["undo"]);
    b.ok(&["reset"]);
    let _ = b.run(&["theme", "accent", "#ffff00"]);
    let _ = b.run(&["theme", "set", "no-such"]);
    let mut files = Vec::new();
    files_under(&b.cfg(), &mut files);
    assert!(!files.is_empty());
    for f in &files {
        let n = f.file_name().unwrap().to_string_lossy();
        assert!(
            !n.contains(".tmp") && (n == ".lock" || !n.starts_with('.')),
            "stray file {f:?}"
        );
    }
    // Every file in current/ is complete and parses.
    for s in SURFACES {
        let css = fs::read_to_string(b.cfg().join(format!("current/{s}.css"))).unwrap();
        assert_eq!(css.matches('{').count(), css.matches('}').count());
    }
    let _: Value =
        serde_json::from_str(&fs::read_to_string(b.cfg().join("current/theme.json")).unwrap())
            .unwrap();
}

// --- the command line --------------------------------------------------------------------------

#[test]
fn usage_mentions_theme_and_the_files_note() {
    let b = Box::new();
    let o = b.run(&["--help"]);
    assert!(out(&o).contains("polycarp theme"), "{}", out(&o));
    let o = b.run(&["theme", "--help"]);
    assert_eq!(code(&o), 0);
    let t = out(&o);
    for sub in [
        "list",
        "show",
        "current",
        "set",
        "accent",
        "create",
        "edit-path",
        "delete",
        "validate",
        "export",
        "undo",
        "history",
        "reset",
    ] {
        assert!(t.contains(&format!("polycarp theme {sub}")), "{sub}");
    }
    assert!(t.contains("Until then only the files change."));
    let o = b.run(&["theme"]);
    assert_eq!(code(&o), 2);
    let o = b.run(&["theme", "frobnicate"]);
    assert_eq!(code(&o), 2);
    assert!(err(&o).contains("unknown command frobnicate"));
    let o = b.run(&["theme", "set"]);
    assert_eq!(code(&o), 2);
    let o = b.run(&["theme", "set", "calm", "--bogus"]);
    assert_eq!(code(&o), 2);
}

#[test]
fn validate_reports_ok_and_missing_files() {
    let b = Box::new();
    let o = b.run(&["theme", "validate", repo_theme("evening").to_str().unwrap()]);
    assert_eq!(code(&o), 0);
    assert!(out(&o).starts_with("ok:"), "{}", out(&o));
    let o = b.run(&["theme", "validate", "/definitely/not/here.toml"]);
    assert_eq!(code(&o), 1);
    assert!(err(&o).contains("could not read"));
}

#[test]
fn config_folder_comes_from_polycarp_config_dir_then_the_system_variables() {
    let b = Box::new();
    // A relative folder is refused, with the variable named.
    let mut c = b.cmd(&["theme", "set", "calm", "--json"]);
    c.env("POLYCARP_CONFIG_DIR", "relative/dir");
    let o = c.output().unwrap();
    assert_eq!(code(&o), 1);
    let v: Value = serde_json::from_str(&out(&o)).unwrap();
    assert_eq!(v["error"]["code"], "config_error");
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("POLYCARP_CONFIG_DIR must be an absolute path"),
        "{v}"
    );
    assert!(!b.root.join("cwd").join("relative").exists());

    // Without it, XDG_CONFIG_HOME (or APPDATA on Windows) still picks the folder.
    let mut c = b.cmd(&["theme", "set", "calm"]);
    c.env_remove("POLYCARP_CONFIG_DIR")
        .env("XDG_CONFIG_HOME", b.root.join("xdg"))
        .env("APPDATA", b.root.join("appdata"));
    assert_eq!(code(&c.output().unwrap()), 0);
    let legacy = if cfg!(windows) {
        b.root.join("appdata").join("Polycarp")
    } else {
        b.root.join("xdg").join("polycarp")
    };
    assert!(legacy.join("config.toml").exists());
    assert!(!b.cfg().join("config.toml").exists());

    // The override wins when both are set.
    let mut c = b.cmd(&["theme", "set", "evening"]);
    c.env("XDG_CONFIG_HOME", b.root.join("xdg"))
        .env("APPDATA", b.root.join("appdata"));
    assert_eq!(code(&c.output().unwrap()), 0);
    assert!(b.cfg().join("config.toml").exists());
}

#[test]
fn nothing_is_written_outside_the_temp_config() {
    let b = Box::new();
    b.ok(&["set", "evening"]);
    // The fake home stays empty: only POLYCARP_CONFIG_DIR was used.
    let home: Vec<_> = fs::read_dir(b.root.join("home")).unwrap().collect();
    assert!(home.is_empty());
    let cwd: Vec<_> = fs::read_dir(b.root.join("cwd")).unwrap().collect();
    assert!(cwd.is_empty());
}

#[test]
fn readme_example_is_valid() {
    let b = Box::new();
    let readme = repo_text("themes/README.md");
    let start = readme
        .find("# ~/.config/polycarp/themes/mine.toml")
        .unwrap();
    let end = start + readme[start..].find("```").unwrap();
    let p = b.write_theme("mine", &readme[start..end]);
    let o = b.run(&["theme", "validate", p.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    // Its per-product overrides reach only their own product.
    let v = b.json(&["export", "json", "mine"]);
    assert_eq!(v["surfaces"]["site"]["shape"]["radius"], 0);
    assert_eq!(v["surfaces"]["spaces"]["shape"]["radius"], 14);
    assert_eq!(v["surfaces"]["spaces"]["shape"]["density"], "compact");
    assert_eq!(v["surfaces"]["voice"]["shape"]["density"], "regular");
}

// --- agent interface ---------------------------------------------------------------------------

fn repo_file(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(rel)
}

/// A repo text file with line endings as LF, because a Windows checkout may convert them.
fn repo_text(rel: &str) -> String {
    fs::read_to_string(repo_file(rel))
        .unwrap()
        .replace("\r\n", "\n")
}

/// A schema node's properties, following a `$ref` into `$defs`.
fn props<'a>(schema: &'a Value, node: &'a Value) -> &'a serde_json::Map<String, Value> {
    let node = match node.get("$ref").and_then(Value::as_str) {
        Some(r) => &schema["$defs"][r.trim_start_matches("#/$defs/")],
        None => node,
    };
    node["properties"]
        .as_object()
        .unwrap_or_else(|| panic!("no properties in {node}"))
}

fn described(node: &Value) -> bool {
    node["description"]
        .as_str()
        .is_some_and(|d| d.trim().len() > 12)
}

/// Every key in a built-in theme file is a schema field with a description.
fn check_fields(schema: &Value, node: &Value, doc: &toml::Table, at: &str) {
    let ps = props(schema, node);
    for (k, v) in doc {
        let field = ps
            .get(k)
            .unwrap_or_else(|| panic!("{at}{k} is in a theme but not in the schema"));
        assert!(described(field), "{at}{k} has no description");
        if let toml::Value::Table(t) = v {
            check_fields(schema, field, t, &format!("{at}{k}."));
        }
    }
}

fn every_property_is_described(schema: &Value, node: &Value, at: &str) {
    let ps = props(schema, node);
    for (k, f) in ps {
        assert!(described(f), "{at}{k} has no description");
        if f.get("$ref").is_some() || f.get("properties").is_some() {
            every_property_is_described(schema, f, &format!("{at}{k}."));
        }
    }
}

#[test]
fn schema_describes_every_field_of_every_builtin() {
    let b = Box::new();
    let o = b.run(&["theme", "schema"]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    let plain: Value = serde_json::from_str(&out(&o)).unwrap();
    let (c, env) = b.jrun(&["schema"]);
    assert_eq!(c, 0);
    let schema = &env["data"]["schema"];
    assert_eq!(&plain, schema, "plain output is the schema itself");
    assert_eq!(
        schema["$schema"],
        "https://json-schema.org/draft/2020-12/schema"
    );
    assert!(described(schema), "the root needs a description");
    every_property_is_described(schema, schema, "");
    for name in BUILTINS {
        let text = fs::read_to_string(repo_theme(name)).unwrap();
        let doc: toml::Table = text.parse().unwrap();
        check_fields(schema, schema, &doc, &format!("{name}: "));
    }
    // A product override may hold any section, with the same fields.
    let site = &props(schema, &schema["properties"]["surface"])["site"];
    for sec in ["light", "dark", "shape", "type", "motion"] {
        assert!(props(schema, site).contains_key(sec), "{sec}");
    }
    // Ranges, choices and the rules are in the text.
    let shape = &schema["$defs"]["shape"]["properties"];
    assert_eq!(shape["radius"]["minimum"], 0);
    assert_eq!(shape["radius"]["maximum"], 64);
    assert_eq!(shape["indicator"]["enum"][2], "number-block");
    assert_eq!(
        schema["$defs"]["motion"]["properties"]["scale_from"]["minimum"],
        0.5
    );
    let root = schema["description"].as_str().unwrap();
    assert!(root.contains("4.5") && root.contains("3.0"), "{root}");
    assert_eq!(schema["x-contrast"].as_array().unwrap().len(), 24);
}

#[test]
fn schema_example_is_a_real_theme() {
    let b = Box::new();
    let (_, env) = b.jrun(&["schema"]);
    let ex = env["data"]["schema"]["examples"][0].to_string();
    let o = b.run_stdin(&["theme", "apply", "-"], &ex);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert_eq!(b.json(&["current", "--json"])["theme"], "warmer");
}

const MINE: &str = "# my notes\nname = \"mine\"\ntitle = \"Mine\"\nextends = \"evening\"\n\n[light]\naccent = \"#2f6b55\" # green\non_accent = \"#f8f9fb\"\n";

#[test]
fn apply_from_a_toml_file_keeps_its_comments_and_makes_it_current() {
    let b = Box::new();
    let f = b.root.join("cwd").join("mine.toml");
    fs::write(&f, MINE).unwrap();
    let o = b.run(&["theme", "apply", f.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert_eq!(
        fs::read_to_string(b.cfg().join("themes/mine.toml")).unwrap(),
        MINE
    );
    let cur = b.json(&["current", "--json"]);
    assert_eq!(cur["theme"], "mine");
    assert_eq!(
        b.json(&["get", "light.accent", "--json"])["value"],
        "#2f6b55"
    );
    assert!(b.cfg().join("current/theme.json").exists());
    assert!(b.ok(&["history"]).contains("theme apply mine"));
}

#[test]
fn apply_from_stdin_toml_and_json_detects_the_format_by_content() {
    let b = Box::new();
    let o = b.run_stdin(&["theme", "apply", "-"], MINE);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert_eq!(b.json(&["current", "--json"])["theme"], "mine");
    let doc = r##"  {"name":"jay","title":"Jay","extends":"calm","shape":{"radius":3,"shadow":1},"light":{"accent":"#2f6b55"}}"##;
    let o = b.run_stdin(&["theme", "apply", "-"], doc);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert_eq!(b.json(&["current", "--json"])["theme"], "jay");
    assert_eq!(b.json(&["get", "shape.radius", "--json"])["value"], 3);
    assert_eq!(b.json(&["get", "shape.shadow", "--json"])["value"], 1.0);
    // A JSON file works the same way, and the saved copy is TOML.
    let f = b.root.join("cwd").join("t.json");
    fs::write(&f, doc.replace("jay", "kay")).unwrap();
    let o = b.run(&["theme", "apply", f.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    let saved = fs::read_to_string(b.cfg().join("themes/kay.toml")).unwrap();
    assert!(saved.parse::<toml::Table>().is_ok() && saved.contains("name = \"kay\""));
}

#[test]
fn apply_name_flag_and_no_activate() {
    let b = Box::new();
    let o = b.run_stdin(
        &["theme", "apply", "-", "--name", "renamed", "--no-activate"],
        MINE,
    );
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert!(b.cfg().join("themes/renamed.toml").exists());
    assert!(!b.cfg().join("themes/mine.toml").exists());
    let saved = fs::read_to_string(b.cfg().join("themes/renamed.toml")).unwrap();
    assert!(
        saved.contains("# my notes") && saved.contains("name = \"renamed\""),
        "{saved}"
    );
    assert_eq!(b.json(&["current", "--json"])["theme"], "polycarp");
    let list = b.json(&["list", "--json"])["themes"].to_string();
    assert!(list.contains("renamed"));
}

#[test]
fn apply_failure_changes_nothing() {
    let b = Box::new();
    b.run_stdin(&["theme", "apply", "-"], MINE);
    let before = b.snapshot();
    let outs_before = fs::read_to_string(b.cfg().join("current/theme.json")).unwrap();
    let bad: [(&str, &str, &str); 6] = [
        (
            "contrast",
            "name = \"x1\"\ntitle = \"x\"\nextends = \"calm\"\n[dark]\nmuted = \"#444444\"\n",
            "contrast",
        ),
        (
            "range",
            "{\"name\":\"x2\",\"title\":\"x\",\"extends\":\"calm\",\"shape\":{\"radius\":99}}",
            "invalid_theme",
        ),
        (
            "unknown key",
            "name = \"x3\"\ntitle = \"x\"\nextends = \"calm\"\n[light]\nacent = \"#112233\"\n",
            "invalid_theme",
        ),
        ("syntax", "name = [oops", "invalid_theme"),
        ("json syntax", "{\"name\": ", "invalid_theme"),
        (
            "no base",
            "name = \"x6\"\ntitle = \"x\"\nextends = \"nowhere\"\n",
            "invalid_theme",
        ),
    ];
    for (label, doc, want) in bad {
        let o = b.run_stdin(&["theme", "apply", "-", "--json"], doc);
        assert_eq!(code(&o), 1, "{label}: {}", out(&o));
        let v: Value = serde_json::from_str(&out(&o)).unwrap();
        assert_eq!(v["error"]["code"], want, "{label}: {v}");
        assert_eq!(b.snapshot(), before, "{label} changed something");
    }
    assert_eq!(
        fs::read_to_string(b.cfg().join("current/theme.json")).unwrap(),
        outs_before
    );
    // A document with no name at all.
    let o = b.run_stdin(&["theme", "apply", "-", "--json"], "title = \"x\"\n");
    assert_eq!(code(&o), 1);
    assert_eq!(b.snapshot(), before);
}

#[test]
fn apply_refuses_a_builtin_name_even_with_the_flag() {
    let b = Box::new();
    let doc = "name = \"fresh\"\ntitle = \"F\"\nextends = \"calm\"\n";
    let o = b.run_stdin(
        &["theme", "apply", "-", "--json"],
        &doc.replace("fresh", "calm"),
    );
    assert_eq!(code(&o), 1);
    let v: Value = serde_json::from_str(&out(&o)).unwrap();
    assert_eq!(v["error"]["code"], "builtin_read_only");
    assert_eq!(v["error"]["data"]["errors"][0]["path"], "name");
    let o = b.run_stdin(&["theme", "apply", "-", "--name", "evening", "--json"], doc);
    assert_eq!(code(&o), 1);
    let v: Value = serde_json::from_str(&out(&o)).unwrap();
    assert_eq!(v["error"]["code"], "builtin_read_only");
    assert!(
        !b.cfg().join("themes").exists()
            || fs::read_dir(b.cfg().join("themes")).unwrap().count() == 0
    );
    assert_eq!(b.history_count(), 0);
}

#[test]
fn apply_over_an_existing_theme_is_undone_by_undo() {
    let b = Box::new();
    b.run_stdin(&["theme", "apply", "-"], MINE);
    let newer = MINE.replace("#2f6b55", "#3a6b4f");
    b.run_stdin(&["theme", "apply", "-"], &newer);
    assert!(fs::read_to_string(b.cfg().join("themes/mine.toml"))
        .unwrap()
        .contains("#3a6b4f"));
    b.ok(&["undo"]);
    assert_eq!(
        fs::read_to_string(b.cfg().join("themes/mine.toml")).unwrap(),
        MINE
    );
    b.ok(&["undo"]);
    assert!(!b.cfg().join("themes/mine.toml").exists());
    assert_eq!(b.json(&["current", "--json"])["theme"], "polycarp");
}

#[test]
fn get_reads_resolved_values() {
    let b = Box::new();
    assert_eq!(b.ok(&["get", "dark.accent"]), "#a9bb8a\n");
    assert_eq!(b.ok(&["get", "shape.radius"]), "10\n");
    assert_eq!(b.ok(&["get", "shape.radius", "blocks"]), "0\n");
    assert_eq!(b.ok(&["get", "title"]), "Polycarp\n");
    let v = b.json(&["get", "motion.reduced", "--json"]);
    assert_eq!(
        (v["value"].clone(), v["theme"].clone()),
        (Value::Bool(false), "polycarp".into())
    );
    assert!(v["needs"].as_str().unwrap().contains("true or false"));
    let section = b.json(&["get", "light", "--json"]);
    assert_eq!(section["value"]["accent"], "#59693f");
    // Product values come from the merged product, not the base.
    b.write_theme(
        "mine",
        &user_theme(
            "mine",
            "evening",
            "[surface.site.light]\naccent = \"#3f6b6a\"\n",
        ),
    );
    assert_eq!(
        b.ok(&["get", "surface.site.light.accent", "mine"]),
        "#3f6b6a\n"
    );
    assert_ne!(
        b.ok(&["get", "surface.spaces.light.accent", "mine"]),
        "#3f6b6a\n"
    );
    // Current theme with an accent override.
    b.ok(&["accent", GREEN_L, "--mode", "light"]);
    assert_eq!(b.ok(&["get", "light.accent"]), format!("{GREEN_L}\n"));
    let (c, v) = b.jrun(&["get", "shape.radus"]);
    assert_eq!(c, 1);
    assert_eq!(v["error"]["code"], "unknown_path");
    assert!(v["error"]["suggestion"]
        .as_str()
        .unwrap()
        .contains("radius"));
    let (c, v) = b.jrun(&["get", "dark.accent", "ghost"]);
    assert_eq!((c, v["error"]["code"].clone()), (1, "unknown_theme".into()));
}

#[test]
fn change_on_a_builtin_makes_a_custom_theme_and_says_so() {
    let b = Box::new();
    let o = b.run(&["theme", "change", "dark.accent", "#8fb37a"]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    let t = out(&o);
    assert!(
        t.contains("polycarp is built in") && t.contains("polycarp-custom"),
        "{t}"
    );
    let file = fs::read_to_string(b.cfg().join("themes/polycarp-custom.toml")).unwrap();
    assert!(
        file.contains("extends = \"polycarp\"") && file.contains("accent = \"#8fb37a\""),
        "{file}"
    );
    assert_eq!(b.json(&["current", "--json"])["theme"], "polycarp-custom");
    assert_eq!(b.ok(&["get", "dark.accent"]), "#8fb37a\n");
    assert_eq!(
        b.ok(&["get", "light.accent"]),
        "#59693f\n",
        "the rest is inherited"
    );
    // The built-in is untouched.
    assert_eq!(b.ok(&["get", "dark.accent", "polycarp"]), "#a9bb8a\n");
    let v = b.json(&["change", "shape.radius", "0", "--json"]);
    assert_eq!(v["created"], false, "second change edits the same file");
    assert_eq!(v["previous"], 10);
    assert_eq!(v["value"], 0);
    // Another built-in gets its own.
    b.ok(&["set", "calm"]);
    b.ok(&["change", "shape.radius", "4"]);
    assert!(b.cfg().join("themes/calm-custom.toml").exists());
    // A taken name is not overwritten.
    b.ok(&["set", "calm"]);
    let v = b.json(&["change", "shape.radius", "5", "--json"]);
    assert_eq!(v["theme"], "calm-custom-2");
    assert!(fs::read_to_string(b.cfg().join("themes/calm-custom.toml"))
        .unwrap()
        .contains("radius = 4"));
}

#[test]
fn change_on_a_user_theme_edits_it_in_place_and_keeps_comments() {
    let b = Box::new();
    b.run_stdin(&["theme", "apply", "-"], MINE);
    let v = b.json(&["change", "light.accent", "#2a6b50", "--json"]);
    assert_eq!(
        (v["created"].clone(), v["comments_kept"].clone()),
        (false.into(), true.into())
    );
    let f = fs::read_to_string(b.cfg().join("themes/mine.toml")).unwrap();
    assert_eq!(f, MINE.replace("#2f6b55\" # green", "#2a6b50\" # green"));
    b.ok(&["change", "motion.fast", "90"]);
    b.ok(&["change", "motion.easing", "ease-out"]);
    b.ok(&["change", "motion.reduced", "true"]);
    b.ok(&["change", "shape.density", "compact"]);
    b.ok(&["change", "shape.shadow", "0.3"]);
    b.ok(&["change", "type.mono", "Menlo, monospace"]);
    b.ok(&["change", "title", "My Own"]);
    b.ok(&["change", "surface.site.dark.accent", "#a9d0bc"]);
    let f = fs::read_to_string(b.cfg().join("themes/mine.toml")).unwrap();
    assert!(
        f.starts_with("# my notes\n") && f.contains("# green"),
        "{f}"
    );
    let t: toml::Table = f.parse().unwrap();
    assert_eq!(t["motion"]["fast"].as_integer(), Some(90));
    assert_eq!(t["motion"]["reduced"].as_bool(), Some(true));
    assert_eq!(t["shape"]["shadow"].as_float(), Some(0.3));
    assert_eq!(
        t["surface"]["site"]["dark"]["accent"].as_str(),
        Some("#a9d0bc")
    );
    assert_eq!(t["title"].as_str(), Some("My Own"));
    assert_eq!(b.json(&["current", "--json"])["theme"], "mine");
    // Undo puts the file back, not only the choice of theme.
    b.ok(&["undo"]);
    let g = fs::read_to_string(b.cfg().join("themes/mine.toml")).unwrap();
    assert!(!g.contains("#a9d0bc") && g.contains("My Own"));
    for _ in 0..7 {
        b.ok(&["undo"]);
    }
    assert!(fs::read_to_string(b.cfg().join("themes/mine.toml"))
        .unwrap()
        .contains("#2a6b50"));
    b.ok(&["undo"]);
    assert_eq!(
        fs::read_to_string(b.cfg().join("themes/mine.toml")).unwrap(),
        MINE
    );
}

#[test]
fn change_value_types_come_from_the_path() {
    let b = Box::new();
    for (path, value, why) in [
        ("shape.radius", "round", "whole number"),
        ("shape.radius", "2.5", "whole number"),
        ("shape.radius", "99", "out of range"),
        ("shape.shadow", "2", "out of range"),
        ("shape.density", "tiny", "not one of"),
        ("dark.accent", "green", "not a color"),
        ("motion.reduced", "yes", "true or false"),
        ("motion.easing", "bounce", "not ease"),
        ("type.ui", "a;b", "is not a font stack"),
        ("type.size", "9", "out of range"),
        ("title", "", "not empty"),
    ] {
        let before = b.snapshot();
        let (c, v) = b.jrun(&["change", path, value]);
        assert_eq!(c, 1, "{path} {value}");
        assert_eq!(v["error"]["code"], "invalid_value", "{path} {value}: {v}");
        let e = &v["error"]["data"]["errors"][0];
        assert_eq!(e["path"], path);
        assert!(e["needs"].is_string() && !e["actual"].is_null(), "{e}");
        assert!(
            e["message"].as_str().unwrap().contains(why)
                || e["needs"].as_str().unwrap().contains(why),
            "{path} {value}: {e}"
        );
        assert_eq!(b.snapshot(), before, "{path} {value} changed something");
    }
    let (c, v) = b.jrun(&["change", "shape.nope", "1"]);
    assert_eq!((c, v["error"]["code"].clone()), (1, "unknown_path".into()));
    let (c, v) = b.jrun(&["change", "surface.moon.light.accent", "#112233"]);
    assert_eq!((c, v["error"]["code"].clone()), (1, "unknown_path".into()));
    assert_eq!(b.history_count(), 0);
}

#[test]
fn change_refused_for_contrast_leaves_everything_unchanged() {
    let b = Box::new();
    b.ok(&["change", "dark.accent", "#8fb37a"]);
    let before = b.snapshot();
    let (c, v) = b.jrun(&["change", "dark.muted", "#444444"]);
    assert_eq!(c, 1);
    assert_eq!(v["error"]["code"], "contrast");
    let errs = v["error"]["data"]["errors"].as_array().unwrap();
    assert!(errs.len() >= 2);
    for e in errs {
        assert_eq!(e["path"], "dark.muted");
        assert!(e["actual"].as_f64().unwrap() < e["needs"].as_f64().unwrap());
        assert_eq!(e["needs"], 4.5);
    }
    assert_eq!(b.snapshot(), before);
    // A product value that fails only in that product is refused too.
    let (c, v) = b.jrun(&["change", "surface.site.dark.muted", "#444444"]);
    assert_eq!(c, 1, "{v}");
    assert_eq!(
        v["error"]["data"]["errors"][0]["path"],
        "surface.site.dark.muted"
    );
    assert_eq!(b.snapshot(), before);
    // The same refusal on a built-in does not leave a -custom file behind.
    let b2 = Box::new();
    let (c, _) = b2.jrun(&["change", "light.accent", "#f0f0a0"]);
    assert_eq!(c, 1);
    assert!(!b2.cfg().join("themes").exists());
    assert_eq!(b2.history_count(), 0);
    assert!(!b2.state_file().exists());
}

#[test]
fn change_of_an_accent_clears_a_matching_override() {
    let b = Box::new();
    b.ok(&["accent", GREEN_L, "--mode", "light"]);
    b.ok(&["accent", GREEN_D, "--mode", "dark"]);
    let v = b.json(&["change", "dark.accent", "#a9d0bc", "--json"]);
    assert!(v["notes"].to_string().contains("override for dark"), "{v}");
    assert_eq!(b.ok(&["get", "dark.accent"]), "#a9d0bc\n");
    assert_eq!(b.json(&["current", "--json"])["accent_light"], GREEN_L);
}

#[test]
fn preview_writes_one_self_contained_page() {
    let b = Box::new();
    let f = b.root.join("p.html");
    let o = b.run(&["theme", "preview", "evening", "--out", f.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert_eq!(out(&o).trim(), f.display().to_string());
    let html = fs::read_to_string(&f).unwrap();
    for bad in [
        "http://", "https://", "url(", "@import", "<script", "<link", "<img", "src=",
    ] {
        assert!(!html.contains(bad), "page contains {bad}");
    }
    assert!(!html.contains("http"), "no http at all");
    for role in ROLES {
        let var = format!("var(--pc-{})", role.replace('_', "-"));
        assert!(html.contains(&var), "{var} is never used");
    }
    for want in [
        "pc-light",
        "pc-dark",
        "Workspaces",
        "Listening",
        "Allow once",
        "Delete",
        "Needs you",
        "Working",
        "Done",
        "Disabled",
        "Dictation",
    ] {
        assert!(html.contains(want), "{want}");
    }
    assert_eq!(
        html.matches("class=\"tile ").count(),
        18,
        "nine tiles in each of two modes"
    );
    // Every color in the CSS is a variable except those that define the variables.
    let style = &html[html.find("<style>").unwrap()..html.find("</style>").unwrap()];
    let body_css = &style[style.find("* {").unwrap()..];
    assert!(!body_css.contains('#'), "hard-coded color in the page CSS");
    // Light only, dark only.
    let o = b.run(&[
        "theme",
        "preview",
        "evening",
        "--mode",
        "dark",
        "--out",
        f.to_str().unwrap(),
    ]);
    assert_eq!(code(&o), 0);
    let dark = fs::read_to_string(&f).unwrap();
    assert!(dark.contains(".pc-dark {") && !dark.contains(".pc-light {"));
    assert_eq!(dark.matches("class=\"tile ").count(), 9);
}

#[test]
fn preview_uses_the_surface_the_indicator_and_the_default_path() {
    let b = Box::new();
    b.write_theme(
        "mine",
        &user_theme(
            "mine",
            "blocks",
            "[surface.site.light]\naccent = \"#3f6b6a\"\n",
        ),
    );
    let o = b.run(&[
        "theme",
        "preview",
        "mine",
        "--surface",
        "site",
        "--mode",
        "light",
    ]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    let path = PathBuf::from(out(&o).trim());
    assert_eq!(path.parent().unwrap(), b.cfg().join("previews"));
    assert!(!b.root.join("tmp").join("polycarp-preview").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(b.cfg().join("previews"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }
    let html = fs::read_to_string(&path).unwrap();
    assert!(html.contains("--pc-accent: #3f6b6a;") && html.contains("product: site"));
    assert!(
        html.contains(".tile .num { background: var(--pc-status)"),
        "blocks uses number-block"
    );
    let o = b.run(&["theme", "preview", "polycarp", "--mode", "light"]);
    let dot = fs::read_to_string(out(&o).trim()).unwrap();
    assert!(dot.contains("border-radius: 50%; background: var(--pc-status)"));
    let o = b.run(&["theme", "preview", "still-water", "--mode", "dark"]);
    assert_eq!(code(&o), 0);
    // The current theme with its accent override is what you see when no name is given.
    b.ok(&["accent", GREEN_L, "--mode", "light"]);
    let o = b.run(&["theme", "preview", "--mode", "light"]);
    assert!(fs::read_to_string(out(&o).trim())
        .unwrap()
        .contains(&format!("--pc-accent: {GREEN_L};")));
    for bad in [["--mode", "sepia"], ["--surface", "moon"]] {
        let o = b.run(&["theme", "preview", bad[0], bad[1]]);
        assert_eq!(code(&o), 2);
    }
    assert_eq!(code(&b.run(&["theme", "preview", "ghost"])), 1);
}

#[test]
fn preview_out_replaces_only_a_file_that_is_a_preview() {
    let b = Box::new();
    let f = b.root.join("precious.txt");
    fs::write(&f, "my notes").unwrap();
    let (c, v) = b.jrun(&["preview", "calm", "--out", f.to_str().unwrap()]);
    assert_eq!(c, 1, "{v}");
    assert_eq!(v["error"]["code"], "exists");
    assert_eq!(fs::read_to_string(&f).unwrap(), "my notes");
    // An empty file, a short file and a folder are not previews either.
    fs::write(&f, "").unwrap();
    assert_eq!(
        code(&b.run(&["theme", "preview", "calm", "--out", f.to_str().unwrap()])),
        1
    );
    assert_eq!(fs::read_to_string(&f).unwrap(), "");
    // A new path works, and so does replacing our own page.
    let g = b.root.join("page.html");
    b.ok(&["preview", "calm", "--out", g.to_str().unwrap()]);
    assert!(fs::read_to_string(&g)
        .unwrap()
        .starts_with("<!-- polycarp-theme-preview -->\n"));
    b.ok(&["preview", "evening", "--out", g.to_str().unwrap()]);
    assert!(fs::read_to_string(&g).unwrap().contains("(evening)"));
    // The default folder holds the same rule.
    let dir = b.cfg().join("previews");
    fs::create_dir_all(&dir).unwrap();
    let d = dir.join("calm-both.html");
    fs::write(&d, "not ours").unwrap();
    assert_eq!(code(&b.run(&["theme", "preview", "calm"])), 1);
    assert_eq!(fs::read_to_string(&d).unwrap(), "not ours");
}

#[test]
fn dock_labels_scale_with_the_dock_so_all_nine_fit() {
    // Checked by eye and by measuring in headless Chrome at 700 to 1800 px (nothing truncated);
    // this keeps the rule that makes it work: the label size follows the dock's own width, and
    // the tiles keep their side padding small whatever the density.
    let b = Box::new();
    let f = b.root.join("p.html");
    b.ok(&["preview", "calm", "--out", f.to_str().unwrap()]);
    let html = fs::read_to_string(&f).unwrap();
    assert!(html.contains(".dock { container-type: inline-size;"));
    assert!(html.contains(".tile .lbl { font-size: clamp(6.5px, 1.5cqw, 11px);"));
    assert!(html.contains("padding: var(--pc-space-2) 2px;"));
    for label in [
        "Mail", "Code", "Notes", "Browser", "Chat", "Music", "Files", "Terminal", "Agent",
    ] {
        assert!(
            html.contains(&format!("<span class=\"lbl\">{label}</span>")),
            "{label}"
        );
    }
}

#[test]
fn agents_md_keeps_the_check_sentence_with_the_done_checks_and_themes_after_it() {
    let agents = repo_text("AGENTS.md");
    let check = agents.find("`./check.sh` at the root").unwrap();
    let themes = agents.find("## Themes").unwrap();
    let done = agents.find("## Done checks").unwrap();
    assert!(done < check && check < themes);
    assert!(agents.contains("POLYCARP_CONFIG_DIR"));
}

#[test]
fn every_builtin_previews_in_both_modes() {
    let b = Box::new();
    for name in BUILTINS {
        let f = b.root.join(format!("{name}.html"));
        let o = b.run(&["theme", "preview", name, "--out", f.to_str().unwrap()]);
        assert_eq!(code(&o), 0, "{name}: {}", err(&o));
        let html = fs::read_to_string(&f).unwrap();
        assert!(
            html.contains("pc-light") && html.contains("pc-dark"),
            "{name}"
        );
        assert!(html.contains(&format!("({name})")), "{name}");
    }
}

#[test]
fn every_failure_in_json_parses_and_carries_paths() {
    let b = Box::new();
    b.write_theme(
        "dim",
        &user_theme("dim", "evening", "[dark]\nmuted = \"#555a50\"\n"),
    );
    b.write_theme("broken", "this is [not toml");
    let ok_theme = b.root.join("cwd").join("ok.toml");
    fs::write(&ok_theme, user_theme("ok", "calm", "")).unwrap();
    let bad_theme = b.root.join("cwd").join("bad.toml");
    fs::write(
        &bad_theme,
        user_theme(
            "bad",
            "calm",
            "[shape]\nradius = 500\n[light]\nacent = \"#fff000\"\n",
        ),
    )
    .unwrap();
    let cases: Vec<(Vec<&str>, i32, &str)> = vec![
        (vec!["set", "ghost"], 1, "unknown_theme"),
        (vec!["set", "dim"], 1, "contrast"),
        (vec!["set", "broken"], 1, "invalid_theme"),
        (vec!["show", "ghost"], 1, "unknown_theme"),
        (vec!["get", "light.nope"], 1, "unknown_path"),
        (vec!["get", "dark.accent", "ghost"], 1, "unknown_theme"),
        (vec!["change", "shape.radius", "x"], 1, "invalid_value"),
        (vec!["change", "nope", "1"], 1, "unknown_path"),
        (vec!["accent", "blue"], 1, "invalid_value"),
        (vec!["accent", "#2255aa", "--mode", "dark"], 1, "contrast"),
        (
            vec!["create", "calm", "--extends", "polycarp"],
            1,
            "builtin_read_only",
        ),
        (vec!["create", "dim", "--extends", "polycarp"], 1, "exists"),
        (
            vec!["create", "x", "--extends", "ghost"],
            1,
            "unknown_theme",
        ),
        (vec!["edit-path", "calm"], 1, "builtin_read_only"),
        (vec!["delete", "calm"], 1, "builtin_read_only"),
        (vec!["delete", "ghost"], 1, "unknown_theme"),
        (vec!["undo"], 1, "nothing_to_undo"),
        (vec!["validate", "/no/such/file.toml"], 1, "io_error"),
        (vec!["export", "css", "ghost"], 1, "unknown_theme"),
        (vec!["preview", "ghost"], 1, "unknown_theme"),
        (vec!["frobnicate"], 2, "invalid_args"),
        (vec!["set"], 2, "invalid_args"),
        (vec!["set", "calm", "--bogus"], 2, "invalid_args"),
        (vec!["change", "only-one"], 2, "invalid_args"),
        (vec!["export", "pdf"], 2, "invalid_args"),
        (vec!["preview", "--mode", "sepia"], 2, "invalid_args"),
    ];
    for (args, want_exit, want_code) in cases {
        let (c, v) = b.jrun(&args);
        assert_eq!(c, want_exit, "{args:?}: {v}");
        assert_eq!(v["ok"], false, "{args:?}");
        assert!(v.get("data").is_none(), "{args:?}");
        assert_eq!(v["error"]["code"], want_code, "{args:?}: {v}");
        assert!(!v["error"]["message"].as_str().unwrap().is_empty());
        assert!(
            !v["error"]["suggestion"].as_str().unwrap().is_empty(),
            "{args:?}"
        );
        assert!(v["error"]["retry"].is_string());
        let errs = v["error"]["data"]["errors"]
            .as_array()
            .unwrap_or_else(|| panic!("{args:?}: {v}"));
        assert!(!errs.is_empty(), "{args:?}");
        for e in errs {
            assert!(
                e["path"].is_string() && e["message"].is_string(),
                "{args:?}: {e}"
            );
        }
    }
    // Validation lists every problem with its path, and contrast carries numbers.
    let (c, v) = b.jrun(&["validate", bad_theme.to_str().unwrap()]);
    assert_eq!(c, 1);
    let paths: Vec<&str> = v["error"]["data"]["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["path"].as_str().unwrap())
        .collect();
    assert!(
        paths.contains(&"shape.radius") && paths.contains(&"light.acent"),
        "{paths:?}"
    );
    let (c, v) = b.jrun(&["set", "dim"]);
    assert_eq!(c, 1);
    let e = &v["error"]["data"]["errors"][0];
    assert_eq!(e["path"], "dark.muted");
    assert!(e["actual"].is_number() && e["needs"] == 4.5, "{e}");
    // The same successes are envelopes too.
    let (c, v) = b.jrun(&["validate", ok_theme.to_str().unwrap()]);
    assert_eq!(
        (c, v["ok"].clone(), v["data"]["valid"].clone()),
        (0, true.into(), true.into())
    );
    for args in [
        vec!["list"],
        vec!["current"],
        vec!["history"],
        vec!["show"],
        vec!["schema"],
        vec!["export", "css"],
        vec!["export", "json"],
        vec!["set", "calm"],
        vec!["accent", GREEN_L, "--mode", "light"],
        vec!["reset"],
        vec!["--help"],
    ] {
        let (c, v) = b.jrun(&args);
        assert_eq!((c, v["ok"].clone()), (0, true.into()), "{args:?}: {v}");
        assert!(v["data"].is_object(), "{args:?}");
    }
    // Refusals under --json write nothing to stderr.
    let o = b.run(&["theme", "set", "ghost", "--json"]);
    assert!(err(&o).is_empty(), "{}", err(&o));
}

#[test]
fn skill_is_short_and_its_examples_work() {
    let skill = repo_text("skills/polycarp-theme/SKILL.md");
    assert!(
        skill.lines().count() < 100,
        "{} lines",
        skill.lines().count()
    );
    let mut lines = skill.lines();
    assert_eq!(lines.next(), Some("---"));
    assert_eq!(lines.next(), Some("name: polycarp-theme"));
    let desc = lines.next().unwrap();
    assert!(desc.starts_with("description: Use when"), "{desc}");
    assert_eq!(lines.next(), Some("---"));

    // "warmer": the TOML block in the skill is applied as it stands.
    let b = Box::new();
    let start = skill.find("<<'EOF'\n").unwrap() + "<<'EOF'\n".len();
    let doc = &skill[start..start + skill[start..].find("\nEOF").unwrap() + 1];
    let o = b.run_stdin(&["theme", "apply", "-"], doc);
    assert_eq!(code(&o), 0, "warmer: {}{}", err(&o), out(&o));
    assert_eq!(b.ok(&["get", "light.accent"]), "#a4502a\n");
    assert_eq!(b.ok(&["get", "dark.background"]), "#2f2822\n");
    assert_eq!(
        b.ok(&["get", "shape.radius"]),
        "10\n",
        "the rest comes from polycarp"
    );

    // The commands in the other two examples are the ones run here.
    let cmds: Vec<Vec<String>> = skill
        .lines()
        .filter(|l| l.starts_with("polycarp theme change "))
        .map(|l| {
            let rest = &l["polycarp theme change ".len()..];
            let (path, value) = rest.split_once(' ').unwrap();
            let value = value.trim_matches('\'').to_string();
            vec![path.to_string(), value]
        })
        .collect();
    assert_eq!(cmds.len(), 7, "{cmds:?}");
    let mono = r#"ui-monospace, "SF Mono", Menlo, Consolas, monospace"#;
    let square = Box::new();
    for c in &cmds[..5] {
        square.ok(&["change", &c[0], &c[1]]);
    }
    assert_eq!(square.ok(&["get", "shape.radius_large"]), "0\n");
    assert_eq!(square.ok(&["get", "type.ui"]), format!("{mono}\n"));
    assert_eq!(square.ok(&["get", "type.display"]), format!("{mono}\n"));
    assert_eq!(
        square.json(&["current", "--json"])["theme"],
        "polycarp-custom"
    );

    let green = Box::new();
    for c in &cmds[5..] {
        green.ok(&["change", &c[0], &c[1]]);
    }
    assert_eq!(
        green.ok(&["get", "surface.browser.light.accent"]),
        "#2f6b3a\n"
    );
    assert_eq!(
        green.ok(&["get", "surface.browser.dark.accent"]),
        "#8fcf9a\n"
    );
    for other in ["spaces", "voice", "site"] {
        assert_eq!(
            green.ok(&["get", &format!("surface.{other}.light.accent")]),
            "#59693f\n",
            "{other}"
        );
    }
    let o = green.run(&["theme", "preview", "--surface", "browser", "--mode", "dark"]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert!(fs::read_to_string(out(&o).trim())
        .unwrap()
        .contains("--pc-accent: #8fcf9a;"));
}

#[test]
fn docs_and_plan_describe_the_agent_interface() {
    let themes = repo_text("themes/README.md");
    assert!(themes.contains("## For agents"));
    for w in [
        "theme schema",
        "theme change",
        "theme apply",
        "theme preview",
        "polycarp mcp",
        "theme_undo",
        "agent:",
    ] {
        assert!(themes.contains(w), "themes/README.md lacks {w}");
    }
    assert!(fs::read_to_string(repo_file("README.md"))
        .unwrap()
        .contains("polycarp mcp"));
    let plan = repo_text("PLAN.md");
    let one = plan.find("- [ ] One theme file drives").unwrap();
    let agents = plan
        .find("- [ ] Agents can customize everything for their user.")
        .unwrap();
    let looks = plan
        .find("- [ ] The default themes look good, not just pass contrast.")
        .unwrap();
    let next = plan.find("- [ ] Every color, radius, font").unwrap();
    assert!(one < agents && agents < looks && looks < next);
    let b = Box::new();
    let help = out(&b.run(&["--help"]));
    assert!(help.contains("polycarp mcp"), "{help}");
    let t = out(&b.run(&["theme", "--help"]));
    for sub in ["schema", "get", "change", "apply", "preview"] {
        assert!(t.contains(&format!("polycarp theme {sub}")), "{sub}");
    }
}

#[test]
fn the_preview_code_sample_uses_only_text_colors_checked_on_sunken() {
    let b = Box::new();
    let f = b.root.join("p.html");
    let o = b.run(&["theme", "preview", "evening", "--out", f.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    let html = fs::read_to_string(&f).unwrap();
    let rules: Vec<&str> = html.lines().filter(|l| l.starts_with(".code")).collect();
    assert!(rules.len() >= 5, "{rules:?}");
    for r in rules {
        for bad in ["accent", "urgent", "working", "done", "selection"] {
            assert!(!r.contains(&format!("--pc-{bad}")), "{r}");
        }
    }
}

#[test]
fn create_refuses_a_theme_that_would_not_load_such_as_too_deep_an_extends_chain() {
    let b = Box::new();
    let mut base = "polycarp".to_string();
    let mut made = 0;
    let mut refused = None;
    for i in 1..=12 {
        let name = format!("t{i}");
        let o = b.run(&["theme", "create", &name, "--extends", &base, "--json"]);
        if code(&o) == 0 {
            made += 1;
            base = name;
        } else {
            refused = Some((name, serde_json::from_str::<Value>(&out(&o)).unwrap()));
            break;
        }
    }
    let (name, v) = refused.expect("a chain this long must be refused");
    assert!(made >= 5, "the limit is generous but exists: {made}");
    assert_eq!(v["error"]["code"], "invalid_theme", "{v}");
    assert!(!b.cfg().join("themes").join(format!("{name}.toml")).exists());
    assert_eq!(b.history_count(), made, "nothing recorded for the refusal");
    assert!(b.run(&["theme", "list"]).status.success());
    let list = b.ok(&["list"]);
    assert!(!list.contains("problem"), "{list}");
}

#[test]
fn apply_keeps_mode_and_accents_when_only_the_old_theme_was_broken() {
    let b = Box::new();
    let mine = user_theme("mine", "polycarp", "");
    assert_eq!(code(&b.run_stdin(&["theme", "apply", "-"], &mine)), 0);
    b.ok(&["set", "mine", "--mode", "dark"]);
    b.ok(&["accent", GREEN_L, "--mode", "light"]);
    // Break the theme that is in force. config.toml is still fine.
    fs::write(
        b.cfg().join("themes").join("mine.toml"),
        "this is = not [valid",
    )
    .unwrap();
    let other = user_theme("other", "calm", "");
    let o = b.run_stdin(&["theme", "apply", "-", "--json"], &other);
    assert_eq!(code(&o), 0, "{}{}", err(&o), out(&o));
    let cur = b.json(&["current", "--json"]);
    assert_eq!(cur["theme"], "other", "{cur}");
    assert_eq!(cur["mode"], "dark", "{cur}");
    assert_eq!(cur["accent_light"], GREEN_L, "{cur}");
}

#[test]
fn apply_says_when_it_replaced_invalid_settings() {
    let b = Box::new();
    fs::create_dir_all(b.cfg()).unwrap();
    fs::write(b.state_file(), "[appearance]\nmode = \"sideways\"\n").unwrap();
    let doc = user_theme("other", "calm", "");
    let o = b.run_stdin(&["theme", "apply", "-", "--json"], &doc);
    assert_eq!(code(&o), 0, "{}{}", err(&o), out(&o));
    let v: Value = serde_json::from_str(&out(&o)).unwrap();
    assert!(
        v["data"]["notes"]
            .to_string()
            .contains("old settings were invalid"),
        "{v}"
    );
}

#[test]
fn title_and_description_refuse_control_characters() {
    for (key, value) in [
        ("title", "Two\\nlines"),
        ("title", "Tab\\there"),
        ("title", "Esc\\u001b[31m"),
        ("description", "Line one\\nline two"),
        ("description", "bell\\u0007"),
    ] {
        let b = Box::new();
        let doc = format!(
            "name = \"odd\"\nextends = \"polycarp\"\n{}{key} = \"{value}\"\n",
            if key == "title" {
                ""
            } else {
                "title = \"Odd\"\n"
            }
        );
        let o = b.run_stdin(&["theme", "apply", "-", "--json"], &doc);
        assert_eq!(code(&o), 1, "{key} {value:?}: {}", out(&o));
        let v: Value = serde_json::from_str(&out(&o)).unwrap();
        assert_eq!(v["error"]["data"]["errors"][0]["path"], key, "{v}");
        assert!(
            v["error"]["data"]["errors"][0]["message"]
                .as_str()
                .unwrap()
                .contains("control characters"),
            "{v}"
        );
        assert!(!b.cfg().join("themes").join("odd.toml").exists());
    }
    // Ordinary text, including non-ASCII, still works.
    let b = Box::new();
    let doc = "name = \"fine\"\ntitle = \"Caf\u{e9} bleu\"\ndescription = \"A calm theme.\"\nextends = \"polycarp\"\n";
    assert_eq!(code(&b.run_stdin(&["theme", "apply", "-"], doc)), 0);
}

#[test]
fn windows_reserved_names_are_refused_everywhere() {
    for name in ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"] {
        let b = Box::new();
        let (c, v) = b.jrun(&["create", name, "--extends", "polycarp"]);
        assert_eq!(c, 1, "{name}: {v}");
        assert_eq!(v["error"]["code"], "invalid_theme", "{name}: {v}");
        assert!(!b.cfg().join("themes").join(format!("{name}.toml")).exists());
    }
    let b = Box::new();
    b.ok(&["create", "com10", "--extends", "polycarp"]);
}
