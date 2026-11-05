//! Integration tests for `polycarp theme`. Every run gets its own config folder through
//! XDG_CONFIG_HOME and APPDATA, so nothing real is touched.

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
        for d in ["home", "xdg", "appdata", "cwd"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Box { root }
    }
    /// The folder the command should use for its files.
    fn cfg(&self) -> PathBuf {
        if cfg!(windows) {
            self.root.join("appdata").join("Polycarp")
        } else {
            self.root.join("xdg").join("polycarp")
        }
    }
    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_polycarp"));
        c.env_clear()
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("XDG_CONFIG_HOME", self.root.join("xdg"))
            .env("APPDATA", self.root.join("appdata"))
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
    fn json(&self, args: &[&str]) -> Value {
        serde_json::from_str(&self.ok(args)).unwrap()
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
        "type.ui: must not contain",
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
    // Light mode is checked as well, and the accent minimum is 3.0.
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
        e.contains("light.accent on light.background is 1.19, needs 3.0"),
        "{e}"
    );
    assert!(e.contains(", needs 3.0\n"), "{e}");
    assert!(e.contains("light.urgent on light.background is"), "{e}");
    assert!(e.contains("light.on_accent on light.accent is"), "{e}");
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
    let j = b.json(&["list", "--json"]);
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
    let j = b.json(&["list", "--json"]);
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

#[test]
fn accent_override_and_automatic_on_accent() {
    let b = Box::new();
    // The theme's own on_accent is too pale on #3a8f6b, so black is picked.
    let o = b.ok(&["accent", "#3A8F6B"]);
    assert!(o.contains("wrote"), "{o}");
    let v: Value =
        serde_json::from_str(&fs::read_to_string(b.cfg().join("current/theme.json")).unwrap())
            .unwrap();
    for s in SURFACES {
        for mode in ["light", "dark"] {
            assert_eq!(v["surfaces"][s][mode]["accent"], "#3a8f6b");
            assert_eq!(v["surfaces"][s][mode]["on_accent"], "#000000");
        }
    }
    assert_eq!(v["accent_light"], "#3a8f6b");
    assert_eq!(v["accent_dark"], "#3a8f6b");
    let state = fs::read_to_string(b.state_file()).unwrap();
    assert!(
        state.contains("accent_light = \"#3a8f6b\"") && state.contains("accent_dark = \"#3a8f6b\"")
    );
    let cur = b.json(&["current", "--json"]);
    assert_eq!(cur["accent_light"], "#3a8f6b");

    // With --mode only that mode changes, and the theme's own on_accent is kept when it reads.
    b.ok(&["accent", "--clear"]);
    b.ok(&["accent", "#3f6b6a", "--mode", "light"]);
    let v = b.json(&["export", "json"]);
    assert_eq!(v["surfaces"]["site"]["light"]["accent"], "#3f6b6a");
    assert_eq!(v["surfaces"]["site"]["light"]["on_accent"], "#f6f3e8");
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
fn accent_that_fails_contrast_is_refused_and_state_is_unchanged() {
    let b = Box::new();
    b.ok(&["set", "polycarp"]);
    let before = fs::read(b.state_file()).unwrap();
    let outputs_before = fs::read(b.cfg().join("current/theme.json")).unwrap();
    let hist = b.history_count();
    // Fine in light mode, too dark against the dark background.
    let e = b.refused(&["accent", "#2255aa"]);
    assert!(
        e.contains("dark.accent on dark.background is 1.93, needs 3.0"),
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
    // 3.12 on evening's light background, 2.93 on parchment's.
    b.ok(&["accent", "#7d8a95", "--mode", "light"]);
    b.ok(&["set", "evening"]);
    assert_eq!(b.json(&["current", "--json"])["accent_light"], "#7d8a95");
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
    let path = b.cfg().join("themes/my-theme.toml");
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
    assert_eq!(p.trim(), b.cfg().join("themes/mine.toml").to_str().unwrap());
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
    b.ok(&["accent", "#3a8f6b"]);

    let h = b.json(&["history", "--json"]);
    let h = h.as_array().unwrap();
    assert_eq!(h.len(), 3);
    assert_eq!(h[0]["action"], "theme accent #3a8f6b");
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
    assert!(o.contains("undid: theme accent #3a8f6b"), "{o}");
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
fn history_keeps_the_last_50() {
    let b = Box::new();
    for i in 0..56 {
        let name = if i % 2 == 0 { "evening" } else { "calm" };
        b.ok(&["set", name]);
    }
    assert_eq!(b.history_count(), 50);
    let h = b.json(&["history", "--json"]);
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
    let h = b.json(&["history", "--json"]);
    assert_eq!(h[0]["caller"], "agent:xmalicious = 1");
    let o = b.run_as("   ", &["theme", "set", "calm"]);
    assert_eq!(code(&o), 0);
    assert_eq!(b.json(&["history", "--json"])[0]["caller"], "user");
}

#[test]
fn reset_goes_back_to_defaults_and_is_recorded() {
    let b = Box::new();
    b.ok(&["set", "blocks", "--mode", "light"]);
    b.ok(&["accent", "#3a8f6b"]);
    let o = b.ok(&["reset"]);
    assert!(o.contains("theme: polycarp") && o.contains("mode: auto"));
    let cur = b.json(&["current", "--json"]);
    assert_eq!(cur["theme"], "polycarp");
    assert_eq!(cur["mode"], "auto");
    assert!(cur["accent_light"].is_null() && cur["accent_dark"].is_null());
    assert_eq!(b.json(&["history", "--json"])[0]["action"], "theme reset");
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
    let v: Value = serde_json::from_str(&out(&cur)).unwrap();
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
        let v: Value = serde_json::from_str(&out(&o)).unwrap();
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

#[test]
fn atomic_writes_leave_no_temp_files() {
    let b = Box::new();
    b.ok(&["set", "evening", "--mode", "dark"]);
    b.ok(&["accent", "#3a8f6b"]);
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
            !n.contains(".tmp") && !n.starts_with('.'),
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
fn nothing_is_written_outside_the_temp_config() {
    let b = Box::new();
    b.ok(&["set", "evening"]);
    // The fake home stays empty: only XDG_CONFIG_HOME / APPDATA were used.
    let home: Vec<_> = fs::read_dir(b.root.join("home")).unwrap().collect();
    assert!(home.is_empty());
    let cwd: Vec<_> = fs::read_dir(b.root.join("cwd")).unwrap().collect();
    assert!(cwd.is_empty());
}

#[test]
fn readme_example_is_valid() {
    let b = Box::new();
    let readme = fs::read_to_string(repo_theme("polycarp").with_file_name("README.md")).unwrap();
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
