//! `polycarp theme`: one theme file drives every Polycarp product and the site.
//!
//! A theme is a TOML file. This module checks it, resolves `extends`, merges per-product
//! overrides, and writes the result where products read it. It never starts another process.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use toml::{Table, Value};

const NOTE: &str =
    "Products read these files once their adapters land. Until then only the files change.";

pub const USAGE: &str = "\
polycarp theme: one theme for every Polycarp product and the site

Usage:
  polycarp theme list [--json]
  polycarp theme show [name] [--json]
  polycarp theme current [--json]
  polycarp theme set <name> [--mode auto|light|dark]
  polycarp theme accent <#rrggbb> [--mode light|dark] | --clear [--mode light|dark]
  polycarp theme create <name> --extends <base> [--force]
  polycarp theme edit-path <name>
  polycarp theme delete <name>
  polycarp theme validate <file>
  polycarp theme export <css|json> [name] [--surface spaces|voice|browser|site]
  polycarp theme undo
  polycarp theme history [--json]
  polycarp theme reset

Built-in themes: polycarp (default), still-water, evening, parchment, blocks, calm.
Your own themes live in <config>/themes/<name>.toml. The config folder is
$XDG_CONFIG_HOME/polycarp (default ~/.config/polycarp), or %APPDATA%\\Polycarp on Windows.
Set POLYCARP_CALLER to record who made a change (default: user).

Products read the files in <config>/current/ once their adapters land.
Until then only the files change.
";

const BUILTINS: &[(&str, &str)] = &[
    ("polycarp", include_str!("../../themes/polycarp.toml")),
    ("still-water", include_str!("../../themes/still-water.toml")),
    ("evening", include_str!("../../themes/evening.toml")),
    ("parchment", include_str!("../../themes/parchment.toml")),
    ("blocks", include_str!("../../themes/blocks.toml")),
    ("calm", include_str!("../../themes/calm.toml")),
];

const DEFAULT_THEME: &str = "polycarp";
const SURFACES: [&str; 4] = ["spaces", "voice", "browser", "site"];
const SECTIONS: [&str; 5] = ["light", "dark", "shape", "type", "motion"];
const MODES: [&str; 2] = ["light", "dark"];
const MAX_DEPTH: usize = 8;
const HISTORY_KEEP: usize = 50;
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

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Kind {
    Hex,
    Int(i64, i64),
    Float(f64, f64),
    Enum(&'static [&'static str]),
    Font,
    Easing,
    Bool,
}

const SHAPE: &[(&str, Kind)] = &[
    ("radius_small", Kind::Int(0, 64)),
    ("radius", Kind::Int(0, 64)),
    ("radius_large", Kind::Int(0, 64)),
    ("border_width", Kind::Int(0, 8)),
    ("blur", Kind::Int(0, 80)),
    ("shadow", Kind::Float(0.0, 1.0)),
    ("density", Kind::Enum(&["compact", "regular", "spacious"])),
    ("indicator", Kind::Enum(&["dot", "bar", "number-block"])),
];
const TYPE: &[(&str, Kind)] = &[
    ("display", Kind::Font),
    ("ui", Kind::Font),
    ("mono", Kind::Font),
    ("size", Kind::Int(10, 24)),
    ("weight", Kind::Int(300, 800)),
    ("line_height", Kind::Float(1.0, 2.0)),
];
const MOTION: &[(&str, Kind)] = &[
    ("fast", Kind::Int(0, 1000)),
    ("normal", Kind::Int(0, 1000)),
    ("slow", Kind::Int(0, 1000)),
    ("easing", Kind::Easing),
    ("scale_from", Kind::Float(0.5, 1.0)),
    ("reduced", Kind::Bool),
];

fn fields(section: &str) -> Vec<(&'static str, Kind)> {
    match section {
        "light" | "dark" => ROLES.iter().map(|r| (*r, Kind::Hex)).collect(),
        "shape" => SHAPE.to_vec(),
        "type" => TYPE.to_vec(),
        "motion" => MOTION.to_vec(),
        _ => Vec::new(),
    }
}

pub fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 48
        && !n.starts_with('-')
        && n.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn is_hex(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn check_easing(s: &str) -> Result<(), String> {
    if matches!(
        s,
        "ease" | "linear" | "ease-in" | "ease-out" | "ease-in-out"
    ) {
        return Ok(());
    }
    let bad = || {
        format!(
            "{s:?} is not ease, ease-in, ease-out, ease-in-out, linear or cubic-bezier(a, b, c, d)"
        )
    };
    let inner = s
        .strip_prefix("cubic-bezier(")
        .and_then(|r| r.strip_suffix(')'))
        .ok_or_else(bad)?;
    let parts: Vec<&str> = inner.split(',').collect();
    if parts.len() != 4 {
        return Err(bad());
    }
    let mut nums = Vec::new();
    for p in parts {
        match p.trim().parse::<f64>() {
            Ok(n) if n.is_finite() => nums.push(n),
            _ => return Err(bad()),
        }
    }
    if !(0.0..=1.0).contains(&nums[0]) || !(0.0..=1.0).contains(&nums[2]) {
        return Err(format!(
            "{s:?} needs its x values (first and third) between 0 and 1"
        ));
    }
    Ok(())
}

fn check_value(path: &str, v: &Value, kind: Kind, out: &mut Vec<String>) {
    match kind {
        Kind::Hex => match v.as_str() {
            Some(s) if is_hex(s) => {}
            Some(s) => out.push(format!("{path}: {s:?} is not a color like \"#rrggbb\"")),
            None => out.push(format!("{path}: must be a string like \"#rrggbb\"")),
        },
        Kind::Int(lo, hi) => match v.as_integer() {
            Some(n) if (lo..=hi).contains(&n) => {}
            Some(n) => out.push(format!("{path}: {n} is out of range {lo}..{hi}")),
            None => out.push(format!("{path}: must be a whole number from {lo} to {hi}")),
        },
        Kind::Float(lo, hi) => {
            let n = v.as_float().or_else(|| v.as_integer().map(|i| i as f64));
            match n {
                Some(n) if n >= lo && n <= hi => {}
                Some(n) => out.push(format!("{path}: {n:?} is out of range {lo:?}..{hi:?}")),
                None => out.push(format!("{path}: must be a number from {lo:?} to {hi:?}")),
            }
        }
        Kind::Enum(options) => match v.as_str() {
            Some(s) if options.contains(&s) => {}
            Some(s) => out.push(format!(
                "{path}: {s:?} is not one of {}",
                options.join(", ")
            )),
            None => out.push(format!("{path}: must be one of {}", options.join(", "))),
        },
        Kind::Font => match v.as_str() {
            Some(s) if s.trim().is_empty() => out.push(format!("{path}: must not be empty")),
            Some(s) if s.chars().any(|c| c.is_control() || ";{}<>\\".contains(c)) => out.push(
                format!("{path}: must not contain ; {{ }} < > \\ or control characters"),
            ),
            Some(_) => {}
            None => out.push(format!("{path}: must be a font stack string")),
        },
        Kind::Easing => match v.as_str() {
            Some(s) => {
                if let Err(e) = check_easing(s) {
                    out.push(format!("{path}: {e}"));
                }
            }
            None => out.push(format!("{path}: must be a CSS easing string")),
        },
        Kind::Bool => {
            if v.as_bool().is_none() {
                out.push(format!("{path}: must be true or false"));
            }
        }
    }
}

fn check_section(path: &str, section: &str, v: &Value, out: &mut Vec<String>) {
    let Some(t) = v.as_table() else {
        out.push(format!("{path}: must be a table"));
        return;
    };
    let known = fields(section);
    for (k, val) in t {
        match known.iter().find(|(n, _)| n == k) {
            Some((_, kind)) => check_value(&format!("{path}.{k}"), val, *kind, out),
            None => out.push(format!("{path}.{k}: unknown key")),
        }
    }
}

/// Checks one theme file by itself: names, types, ranges, unknown keys.
fn check_doc(t: &Table, expected_name: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    match t.get("name") {
        None => out.push("name: missing".to_string()),
        Some(v) => match v.as_str() {
            Some(s) if !valid_name(s) => out.push(format!(
                "name: {s:?} must be lowercase letters, digits and hyphens (up to 48, not starting with a hyphen)"
            )),
            Some(s) => {
                if let Some(e) = expected_name {
                    if s != e {
                        out.push(format!("name: {s:?} must match the file name {e:?}"));
                    }
                }
            }
            None => out.push("name: must be a string".to_string()),
        },
    }
    for (k, v) in t {
        match k.as_str() {
            "name" => {}
            "title" => match v.as_str() {
                Some(s) if s.trim().is_empty() => out.push("title: must not be empty".into()),
                Some(_) => {}
                None => out.push("title: must be a string".into()),
            },
            "description" => {
                if v.as_str().is_none() {
                    out.push("description: must be a string".into());
                }
            }
            "extends" => match v.as_str() {
                Some(s) if valid_name(s) => {}
                Some(s) => out.push(format!("extends: {s:?} is not a valid theme name")),
                None => out.push("extends: must be a string".into()),
            },
            "light" | "dark" | "shape" | "type" | "motion" => check_section(k, k, v, &mut out),
            "surface" => match v.as_table() {
                None => out.push("surface: must be a table".into()),
                Some(st) => {
                    for (s, sv) in st {
                        if !SURFACES.contains(&s.as_str()) {
                            out.push(format!(
                                "surface.{s}: unknown surface (use {})",
                                SURFACES.join(", ")
                            ));
                            continue;
                        }
                        let Some(sec_t) = sv.as_table() else {
                            out.push(format!("surface.{s}: must be a table"));
                            continue;
                        };
                        for (sec, secv) in sec_t {
                            if SECTIONS.contains(&sec.as_str()) {
                                check_section(&format!("surface.{s}.{sec}"), sec, secv, &mut out);
                            } else {
                                out.push(format!("surface.{s}.{sec}: unknown key"));
                            }
                        }
                    }
                }
            },
            _ => out.push(format!("{k}: unknown key")),
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------------------------

fn channel(c: u8) -> f64 {
    let c = f64::from(c) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn luminance(hex: &str) -> f64 {
    let b = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
    0.2126 * channel(b(1)) + 0.7152 * channel(b(3)) + 0.0722 * channel(b(5))
}

/// WCAG contrast ratio of two `#rrggbb` colors, 1 to 21.
pub fn contrast(a: &str, b: &str) -> f64 {
    let (x, y) = (luminance(a), luminance(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

type Colors = BTreeMap<String, String>;

/// The pairs that must stay readable: (text, on, minimum).
fn pairs() -> Vec<(&'static str, &'static str, f64)> {
    let mut v = Vec::new();
    for fg in ["foreground", "strong", "muted"] {
        for bg in ["background", "surface"] {
            v.push((fg, bg, 4.5));
        }
    }
    v.push(("on_accent", "accent", 4.5));
    v.push(("accent", "background", 3.0));
    for fg in ["urgent", "working", "done"] {
        v.push((fg, "background", 3.0));
    }
    v
}

fn contrast_on(light: &Colors, dark: &Colors) -> Vec<String> {
    let mut out = Vec::new();
    for (mode, colors) in [("light", light), ("dark", dark)] {
        for (fg, bg, min) in pairs() {
            if let (Some(f), Some(b)) = (colors.get(fg), colors.get(bg)) {
                let ratio = contrast(f, b);
                if ratio < min {
                    let shown = ((ratio * 100.0 + 1e-9).floor()) / 100.0;
                    out.push(format!(
                        "{mode}.{fg} on {mode}.{bg} is {shown:.2}, needs {min:?}"
                    ));
                }
            }
        }
    }
    out
}

/// Problems of the theme itself, then the ones a surface adds on top.
fn combine(base: Vec<String>, per_surface: Vec<(String, Vec<String>)>) -> Vec<String> {
    let seen: BTreeSet<String> = base.iter().cloned().collect();
    let mut out = base;
    for (s, probs) in per_surface {
        for p in probs {
            if !seen.contains(&p) {
                out.push(format!("surface.{s}: {p}"));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Resolved theme
// ---------------------------------------------------------------------------------------------

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Shape {
    radius_small: i64,
    radius: i64,
    radius_large: i64,
    border_width: i64,
    blur: i64,
    shadow: f64,
    density: String,
    indicator: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Typo {
    display: String,
    ui: String,
    mono: String,
    size: i64,
    weight: i64,
    line_height: f64,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Motion {
    fast: i64,
    normal: i64,
    slow: i64,
    easing: String,
    scale_from: f64,
    reduced: bool,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Resolved {
    light: Colors,
    dark: Colors,
    shape: Shape,
    #[serde(rename = "type")]
    typ: Typo,
    motion: Motion,
}

impl Resolved {
    fn colors(&self, mode: &str) -> &Colors {
        if mode == "dark" {
            &self.dark
        } else {
            &self.light
        }
    }
    fn colors_mut(&mut self, mode: &str) -> &mut Colors {
        if mode == "dark" {
            &mut self.dark
        } else {
            &mut self.light
        }
    }
    /// What products read: with `reduced` on, every duration is 0.
    fn exported(&self) -> Resolved {
        let mut r = self.clone();
        if r.motion.reduced {
            r.motion.fast = 0;
            r.motion.normal = 0;
            r.motion.slow = 0;
        }
        r
    }
    fn contrast_problems(&self) -> Vec<String> {
        contrast_on(&self.light, &self.dark)
    }
}

#[derive(Clone)]
struct Full {
    name: String,
    title: String,
    description: Option<String>,
    base: Resolved,
    surfaces: BTreeMap<String, Resolved>,
}

impl Full {
    fn surface(&self, s: &str) -> &Resolved {
        self.surfaces.get(s).unwrap_or(&self.base)
    }
    fn contrast_problems(&self) -> Vec<String> {
        combine(
            self.base.contrast_problems(),
            SURFACES
                .iter()
                .map(|s| (s.to_string(), self.surface(s).contrast_problems()))
                .collect(),
        )
    }
}

fn parse_toml(src: &str) -> Result<Table, String> {
    src.parse::<Table>().map_err(|e| {
        let line = e
            .span()
            .map(|s| src[..s.start.min(src.len())].matches('\n').count() + 1);
        match line {
            Some(l) => format!(
                "could not read the file as TOML (line {l}): {}",
                e.message()
            ),
            None => format!("could not read the file as TOML: {}", e.message()),
        }
    })
}

fn merge(base: &mut Table, over: &Table) {
    for (k, v) in over {
        if let Value::Table(o) = v {
            if let Some(Value::Table(b)) = base.get_mut(k) {
                merge(b, o);
                continue;
            }
        }
        base.insert(k.clone(), v.clone());
    }
}

fn ext_of(t: &Table) -> Option<String> {
    t.get("extends").and_then(Value::as_str).map(str::to_string)
}

fn colors_of(t: &Table, mode: &str) -> Colors {
    let mut c = Colors::new();
    if let Some(Value::Table(m)) = t.get(mode) {
        for (k, v) in m {
            if let Some(s) = v.as_str().filter(|s| is_hex(s)) {
                c.insert(k.clone(), s.to_lowercase());
            }
        }
    }
    c
}

fn without_meta(t: &Table) -> Table {
    let mut b = t.clone();
    for k in ["name", "title", "description", "extends", "surface"] {
        b.remove(k);
    }
    b
}

fn is_builtin(name: &str) -> bool {
    BUILTINS.iter().any(|(n, _)| *n == name)
}

// ---------------------------------------------------------------------------------------------
// Where things live
// ---------------------------------------------------------------------------------------------

struct Cfg {
    dir: PathBuf,
}

impl Cfg {
    fn from_env() -> Result<Cfg, String> {
        let nonempty = |k: &str| env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        let dir = if cfg!(windows) {
            nonempty("APPDATA")
                .ok_or("APPDATA is not set, so there is no place for the theme files")?
                .join("Polycarp")
        } else if let Some(x) = nonempty("XDG_CONFIG_HOME").filter(|p| p.is_absolute()) {
            x.join("polycarp")
        } else {
            nonempty("HOME")
                .ok_or("HOME is not set, so there is no place for the theme files")?
                .join(".config")
                .join("polycarp")
        };
        Ok(Cfg { dir })
    }
    fn file(&self) -> PathBuf {
        self.dir.join("config.toml")
    }
    fn themes(&self) -> PathBuf {
        self.dir.join("themes")
    }
    fn current(&self) -> PathBuf {
        self.dir.join("current")
    }
    fn history(&self) -> PathBuf {
        self.dir.join("history")
    }
    fn theme_path(&self, name: &str) -> PathBuf {
        self.themes().join(format!("{name}.toml"))
    }
}

// ---------------------------------------------------------------------------------------------
// Resolving a theme
// ---------------------------------------------------------------------------------------------

fn load_raw(cfg: &Cfg, name: &str) -> Result<Table, String> {
    if !valid_name(name) {
        return Err(format!("{name:?} is not a valid theme name"));
    }
    if let Some((_, src)) = BUILTINS.iter().find(|(n, _)| *n == name) {
        return parse_toml(src);
    }
    let path = cfg.theme_path(name);
    match fs::read_to_string(&path) {
        Ok(src) => parse_toml(&src),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("no theme named {name:?}"))
        }
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

fn resolve_name(cfg: &Cfg, name: &str) -> Result<Full, Vec<String>> {
    let t = load_raw(cfg, name).map_err(|e| vec![e])?;
    resolve_doc(cfg, t, Some(name))
}

/// Checks a theme and everything it extends, reporting every problem, then resolves it.
fn resolve_doc(cfg: &Cfg, start: Table, expect: Option<&str>) -> Result<Full, Vec<String>> {
    let mut problems = check_doc(&start, expect);
    let mut chain = vec![start.clone()];
    let mut seen: Vec<String> = start
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .into_iter()
        .collect();
    let mut next = ext_of(&start);
    while let Some(ext) = next.take() {
        if !valid_name(&ext) {
            break; // check_doc already said so
        }
        if seen.contains(&ext) {
            seen.push(ext);
            problems.push(format!("extends: cycle {}", seen.join(" -> ")));
            break;
        }
        if chain.len() > MAX_DEPTH {
            problems.push(format!("extends: more than {MAX_DEPTH} themes deep"));
            break;
        }
        match load_raw(cfg, &ext) {
            Err(e) => {
                problems.push(format!("extends: {e}"));
                break;
            }
            Ok(t) => {
                for p in check_doc(&t, Some(&ext)) {
                    problems.push(format!("in {ext}: {p}"));
                }
                next = ext_of(&t);
                seen.push(ext);
                chain.push(t);
            }
        }
    }

    let mut merged = Table::new();
    for t in chain.iter().rev() {
        merge(&mut merged, t);
    }
    merged.remove("extends");

    if merged.get("title").is_none() {
        problems.push("title: missing (set it, or extend a theme that has one)".into());
    }
    for sec in SECTIONS {
        match merged.get(sec).and_then(Value::as_table) {
            None if merged.get(sec).is_none() => problems.push(format!(
                "{sec}: missing (add the table, or extend a theme that has it)"
            )),
            None => {} // wrong type, already reported
            Some(t) => {
                for (f, _) in fields(sec) {
                    if !t.contains_key(f) {
                        problems.push(format!("{sec}.{f}: missing"));
                    }
                }
            }
        }
    }

    // Contrast runs on whatever colors are valid, so it can be reported with the other problems.
    let base_t = without_meta(&merged);
    let surface_t = merged
        .get("surface")
        .and_then(Value::as_table)
        .cloned()
        .unwrap_or_default();
    let base_probs = contrast_on(&colors_of(&base_t, "light"), &colors_of(&base_t, "dark"));
    let mut per = Vec::new();
    for s in SURFACES {
        if let Some(Value::Table(over)) = surface_t.get(s) {
            let mut st = base_t.clone();
            merge(&mut st, over);
            per.push((
                s.to_string(),
                contrast_on(&colors_of(&st, "light"), &colors_of(&st, "dark")),
            ));
        }
    }
    problems.extend(combine(base_probs, per));

    if !problems.is_empty() {
        return Err(problems);
    }

    let build = |t: &Table| -> Result<Resolved, Vec<String>> {
        let mut r: Resolved = Value::Table(t.clone())
            .try_into()
            .map_err(|e| vec![format!("internal: {e}")])?;
        for c in [&mut r.light, &mut r.dark] {
            for v in c.values_mut() {
                *v = v.to_lowercase();
            }
        }
        Ok(r)
    };
    let base = build(&base_t)?;
    let mut surfaces = BTreeMap::new();
    for s in SURFACES {
        let r = match surface_t.get(s) {
            Some(Value::Table(over)) => {
                let mut st = base_t.clone();
                merge(&mut st, over);
                build(&st)?
            }
            _ => base.clone(),
        };
        surfaces.insert(s.to_string(), r);
    }
    let text = |k: &str| merged.get(k).and_then(Value::as_str).map(str::to_string);
    Ok(Full {
        name: text("name").unwrap_or_default(),
        title: text("title").unwrap_or_default(),
        description: text("description"),
        base,
        surfaces,
    })
}

/// Applies accent overrides to every surface. `on_accent` is the theme's own, black or white:
/// the first that reads on the new accent.
fn apply_accents(
    full: &Full,
    light: Option<&str>,
    dark: Option<&str>,
) -> Result<Full, Vec<String>> {
    let mut out = full.clone();
    let apply = |r: &mut Resolved| {
        for (mode, accent) in [("light", light), ("dark", dark)] {
            let Some(a) = accent else { continue };
            let c = r.colors_mut(mode);
            let own = c.get("on_accent").cloned().unwrap_or_default();
            let pick = [own.as_str(), "#000000", "#ffffff"]
                .into_iter()
                .find(|cand| is_hex(cand) && contrast(cand, a) >= 4.5)
                .unwrap_or("#000000")
                .to_string();
            c.insert("accent".into(), a.to_lowercase());
            c.insert("on_accent".into(), pick);
        }
    };
    apply(&mut out.base);
    for r in out.surfaces.values_mut() {
        apply(r);
    }
    let probs = out.contrast_problems();
    if probs.is_empty() {
        Ok(out)
    } else {
        Err(probs)
    }
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

#[derive(Clone, PartialEq, Debug)]
struct State {
    theme: String,
    mode: String,
    accent_light: Option<String>,
    accent_dark: Option<String>,
}

impl State {
    fn default_state() -> State {
        State {
            theme: DEFAULT_THEME.into(),
            mode: "auto".into(),
            accent_light: None,
            accent_dark: None,
        }
    }
}

/// Reads `config.toml`. Anything wrong is reported and the defaults are used.
fn load_state(cfg: &Cfg) -> (State, Vec<String>) {
    let bytes = match fs::read(cfg.file()) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (State::default_state(), vec![]);
        }
        Err(e) => {
            return (
                State::default_state(),
                vec![format!("could not read {}: {e}", cfg.file().display())],
            )
        }
    };
    let table = match String::from_utf8(bytes)
        .map_err(|_| "the file is not text".to_string())
        .and_then(|s| parse_toml(&s))
    {
        Ok(t) => t,
        Err(e) => {
            return (
                State::default_state(),
                vec![format!("{}: {e}", cfg.file().display())],
            )
        }
    };
    let Some(app) = table.get("appearance") else {
        return (State::default_state(), vec![]);
    };
    let Some(app) = app.as_table() else {
        return (
            State::default_state(),
            vec!["appearance: must be a table".into()],
        );
    };
    let mut st = State::default_state();
    let mut problems = Vec::new();
    for (k, v) in app {
        match k.as_str() {
            "theme" => match v.as_str() {
                Some(s) if valid_name(s) => st.theme = s.to_string(),
                _ => problems.push(format!("appearance.theme: {v} is not a theme name")),
            },
            "mode" => match v.as_str() {
                Some(s @ ("auto" | "light" | "dark")) => st.mode = s.to_string(),
                _ => problems.push(format!(
                    "appearance.mode: {v} is not one of auto, light, dark"
                )),
            },
            "accent_light" | "accent_dark" => match v.as_str() {
                Some(s) if is_hex(s) => {
                    let s = Some(s.to_lowercase());
                    if k == "accent_light" {
                        st.accent_light = s;
                    } else {
                        st.accent_dark = s;
                    }
                }
                _ => problems.push(format!(
                    "appearance.{k}: {v} is not a color like \"#rrggbb\""
                )),
            },
            _ => problems.push(format!("appearance.{k}: unknown key")),
        }
    }
    if problems.is_empty() {
        (st, problems)
    } else {
        (State::default_state(), problems)
    }
}

struct Eff {
    state: State,
    full: Full,
    problems: Vec<String>,
}

fn build_full(cfg: &Cfg, st: &State) -> Result<Full, Vec<String>> {
    let f = resolve_name(cfg, &st.theme)?;
    apply_accents(&f, st.accent_light.as_deref(), st.accent_dark.as_deref())
}

/// The state in force: the file's if it is good, else the default, with the reasons.
fn effective(cfg: &Cfg) -> Eff {
    let (st, mut problems) = load_state(cfg);
    if problems.is_empty() {
        match build_full(cfg, &st) {
            Ok(full) => {
                return Eff {
                    state: st,
                    full,
                    problems,
                }
            }
            Err(ps) => {
                for p in ps {
                    problems.push(format!("theme {:?}: {p}", st.theme));
                }
            }
        }
    }
    let def = State::default_state();
    // The built-in default always resolves; the tests hold that.
    let full = resolve_name(cfg, DEFAULT_THEME).unwrap_or_else(|e| {
        panic!("built-in default theme is invalid: {}", e.join("; "));
    });
    Eff {
        state: def,
        full,
        problems,
    }
}

fn state_table(cfg: &Cfg, st: &State) -> String {
    let mut table = fs::read_to_string(cfg.file())
        .ok()
        .and_then(|s| s.parse::<Table>().ok())
        .unwrap_or_default();
    let mut app = Table::new();
    app.insert("theme".into(), Value::String(st.theme.clone()));
    app.insert("mode".into(), Value::String(st.mode.clone()));
    if let Some(a) = &st.accent_light {
        app.insert("accent_light".into(), Value::String(a.clone()));
    }
    if let Some(a) = &st.accent_dark {
        app.insert("accent_dark".into(), Value::String(a.clone()));
    }
    table.insert("appearance".into(), Value::Table(app));
    toml::to_string(&table).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Writes to a temp file in the same folder, then renames it into place. Mode 0644 on Unix.
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let file = path.file_name().map(|f| f.to_string_lossy().into_owned());
    let tmp = dir.join(format!(
        ".{}.tmp-{}-{n}",
        file.unwrap_or_default(),
        std::process::id()
    ));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644))?;
        }
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("could not write {}: {e}", path.display()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

fn num(f: f64) -> String {
    format!("{f}")
}

fn shared_vars(r: &Resolved) -> Vec<(String, String)> {
    let px = |n: i64| format!("{n}px");
    let ms = |n: i64| format!("{n}ms");
    vec![
        ("radius-small".into(), px(r.shape.radius_small)),
        ("radius".into(), px(r.shape.radius)),
        ("radius-large".into(), px(r.shape.radius_large)),
        ("border-width".into(), px(r.shape.border_width)),
        ("blur".into(), px(r.shape.blur)),
        ("shadow".into(), num(r.shape.shadow)),
        ("density".into(), r.shape.density.clone()),
        ("indicator".into(), r.shape.indicator.clone()),
        ("font-display".into(), r.typ.display.clone()),
        ("font-ui".into(), r.typ.ui.clone()),
        ("font-mono".into(), r.typ.mono.clone()),
        ("font-size".into(), px(r.typ.size)),
        ("font-weight".into(), r.typ.weight.to_string()),
        ("line-height".into(), num(r.typ.line_height)),
        ("motion-fast".into(), ms(r.motion.fast)),
        ("motion-normal".into(), ms(r.motion.normal)),
        ("motion-slow".into(), ms(r.motion.slow)),
        ("motion-easing".into(), r.motion.easing.clone()),
        ("motion-scale-from".into(), num(r.motion.scale_from)),
    ]
}

fn color_lines(r: &Resolved, mode: &str, indent: &str) -> String {
    let mut s = String::new();
    let c = r.colors(mode);
    for role in ROLES {
        if let Some(v) = c.get(role) {
            s.push_str(&format!("{indent}--pc-{}: {v};\n", role.replace('_', "-")));
        }
    }
    s
}

/// CSS for one surface. `forced` is a fixed mode ("light" or "dark"); None follows the system.
fn css(full: &Full, surface: Option<&str>, forced: Option<&str>) -> String {
    let r = match surface {
        Some(s) => full.surface(s),
        None => &full.base,
    }
    .exported();
    let mut s = format!(
        "/* Polycarp theme \"{}\", {}. Written by `polycarp theme`; do not edit. */\n",
        full.name,
        surface.map_or("no surface overrides".to_string(), |x| format!(
            "surface \"{x}\""
        ))
    );
    s.push_str(":root {\n");
    s.push_str(&format!(
        "  color-scheme: {};\n",
        forced.unwrap_or("light dark")
    ));
    for (k, v) in shared_vars(&r) {
        s.push_str(&format!("  --pc-{k}: {v};\n"));
    }
    s.push_str(&color_lines(&r, forced.unwrap_or("light"), "  "));
    s.push_str("}\n");
    for mode in MODES {
        s.push_str(&format!(
            ":root[data-theme-mode=\"{mode}\"] {{\n  color-scheme: {mode};\n{}}}\n",
            color_lines(&r, mode, "  ")
        ));
    }
    if forced.is_none() {
        s.push_str("@media (prefers-color-scheme: dark) {\n  :root:not([data-theme-mode=\"light\"]) {\n    color-scheme: dark;\n");
        s.push_str(&color_lines(&r, "dark", "    "));
        s.push_str("  }\n}\n");
    }
    s
}

fn resolved_json(r: &Resolved) -> Json {
    serde_json::to_value(r.exported()).unwrap_or(Json::Null)
}

fn theme_json(full: &Full, state: Option<&State>) -> Json {
    let mut surfaces = serde_json::Map::new();
    for s in SURFACES {
        surfaces.insert(s.to_string(), resolved_json(full.surface(s)));
    }
    let mut v = json!({
        "schema": 1,
        "name": full.name,
        "title": full.title,
        "description": full.description,
        "reduced_motion": full.base.motion.reduced,
        "surfaces": surfaces,
    });
    if let (Some(st), Some(o)) = (state, v.as_object_mut()) {
        o.insert("mode".into(), json!(st.mode));
        o.insert("accent_light".into(), json!(st.accent_light));
        o.insert("accent_dark".into(), json!(st.accent_dark));
    }
    v
}

fn write_outputs(cfg: &Cfg, eff: &Eff) -> Result<Vec<PathBuf>, String> {
    let dir = cfg.current();
    let mut wrote = Vec::new();
    let json = serde_json::to_string_pretty(&theme_json(&eff.full, Some(&eff.state)))
        .map_err(|e| e.to_string())?;
    let p = dir.join("theme.json");
    write_atomic(&p, format!("{json}\n").as_bytes())?;
    wrote.push(p);
    let forced = (eff.state.mode != "auto").then_some(eff.state.mode.as_str());
    for s in SURFACES {
        let p = dir.join(format!("{s}.css"));
        write_atomic(&p, css(&eff.full, Some(s), forced).as_bytes())?;
        wrote.push(p);
    }
    Ok(wrote)
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (compact stamp for file names, ISO time) in UTC, to the millisecond.
fn stamps() -> (String, String) {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let (secs, milli) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (y, mo, d) = civil(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    (
        format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}{milli:03}Z"),
        format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z"),
    )
}

fn caller() -> String {
    let raw = env::var("POLYCARP_CALLER").unwrap_or_default();
    let clean: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect::<String>()
        .trim()
        .to_string();
    if clean.is_empty() {
        "user".into()
    } else {
        clean
    }
}

struct Hist {
    file: PathBuf,
    time: String,
    caller: String,
    action: String,
    absent: bool,
    body: Vec<u8>,
}

const MARK: &[u8] = b"# ---\n";

fn parse_hist(file: PathBuf, bytes: Vec<u8>) -> Hist {
    let mut h = Hist {
        file,
        time: String::new(),
        caller: String::new(),
        action: String::new(),
        absent: false,
        body: Vec::new(),
    };
    let head_len = bytes
        .windows(MARK.len())
        .position(|w| w == MARK)
        .filter(|_| bytes.starts_with(b"# polycarp-history"));
    let Some(pos) = head_len else {
        h.body = bytes;
        return h;
    };
    for line in String::from_utf8_lossy(&bytes[..pos]).lines() {
        if let Some(v) = line.strip_prefix("# time = ") {
            h.time = v.into();
        } else if let Some(v) = line.strip_prefix("# caller = ") {
            h.caller = v.into();
        } else if let Some(v) = line.strip_prefix("# action = ") {
            h.action = v.into();
        } else if line == "# absent = true" {
            h.absent = true;
        }
    }
    h.body = bytes[pos + MARK.len()..].to_vec();
    h
}

/// Newest first.
fn read_history(cfg: &Cfg) -> Vec<Hist> {
    let Ok(rd) = fs::read_dir(cfg.history()) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|x| x == "toml")
                && p.file_name()
                    .is_some_and(|n| !n.to_string_lossy().starts_with('.'))
        })
        .collect();
    files.sort();
    files.reverse();
    files
        .into_iter()
        .filter_map(|p| fs::read(&p).ok().map(|b| parse_hist(p, b)))
        .collect()
}

/// Keeps the current `config.toml` in `history/` before a change, and trims to the last 50.
fn record(cfg: &Cfg, action: &str) -> Result<(), String> {
    let (compact, iso) = stamps();
    let who = caller();
    let current = fs::read(cfg.file()).ok();
    let mut data =
        format!("# polycarp-history 1\n# time = {iso}\n# caller = {who}\n# action = {action}\n")
            .into_bytes();
    if current.is_none() {
        data.extend_from_slice(b"# absent = true\n");
    }
    data.extend_from_slice(MARK);
    data.extend_from_slice(current.as_deref().unwrap_or(b""));

    let dir = cfg.history();
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let same = fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with(&compact))
                .count()
        })
        .unwrap_or(0);
    let safe: String = who
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    write_atomic(&dir.join(format!("{compact}-{same:03}-{safe}.toml")), &data)?;
    for old in read_history(cfg).into_iter().skip(HISTORY_KEEP) {
        let _ = fs::remove_file(old.file);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

struct Fail {
    code: i32,
    msg: String,
}

fn fail(msg: impl Into<String>) -> Fail {
    Fail {
        code: 1,
        msg: format!("polycarp: {}", msg.into()),
    }
}
fn usage_fail(msg: impl Into<String>) -> Fail {
    Fail {
        code: 2,
        msg: format!(
            "polycarp: theme: {}\nRun `polycarp theme --help`.",
            msg.into()
        ),
    }
}
fn problems_fail(what: &str, problems: &[String]) -> Fail {
    let n = problems.len();
    let mut msg = format!(
        "polycarp: {what} ({n} problem{}):",
        if n == 1 { "" } else { "s" }
    );
    for p in problems {
        msg.push_str(&format!("\n  {p}"));
    }
    Fail { code: 1, msg }
}

type R = Result<(), Fail>;

struct Parsed {
    pos: Vec<String>,
    vals: BTreeMap<String, String>,
    flags: BTreeSet<String>,
}

impl Parsed {
    fn val(&self, k: &str) -> Option<&str> {
        self.vals.get(k).map(String::as_str)
    }
    fn flag(&self, k: &str) -> bool {
        self.flags.contains(k)
    }
}

fn parse_args(args: &[String], valued: &[&str], bools: &[&str]) -> Result<Parsed, Fail> {
    let mut p = Parsed {
        pos: Vec::new(),
        vals: BTreeMap::new(),
        flags: BTreeSet::new(),
    };
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if let Some(rest) = a.strip_prefix("--").filter(|r| !r.is_empty()) {
            let (key, inline) = match rest.split_once('=') {
                Some((k, v)) => (k, Some(v.to_string())),
                None => (rest, None),
            };
            if valued.contains(&key) {
                let v = match inline {
                    Some(v) => v,
                    None => {
                        let v = args
                            .get(i)
                            .ok_or_else(|| usage_fail(format!("--{key} needs a value")))?;
                        i += 1;
                        v.clone()
                    }
                };
                p.vals.insert(key.to_string(), v);
            } else if bools.contains(&key) && inline.is_none() {
                p.flags.insert(key.to_string());
            } else {
                return Err(usage_fail(format!("unknown option --{key}")));
            }
        } else {
            p.pos.push(a.clone());
        }
    }
    Ok(p)
}

fn exactly(p: &Parsed, n: usize, what: &str) -> Result<(), Fail> {
    if p.pos.len() == n {
        Ok(())
    } else {
        Err(usage_fail(format!("expected {what}")))
    }
}

fn cfg() -> Result<Cfg, Fail> {
    Cfg::from_env().map_err(fail)
}

fn warn(problems: &[String]) {
    for p in problems {
        eprintln!("polycarp: warning: {p}");
    }
    if !problems.is_empty() {
        eprintln!("polycarp: warning: using the default theme (polycarp, auto, no accent) instead");
    }
}

fn print_json(v: &Json) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

pub fn run(args: &[OsString]) -> i32 {
    let Some(args) = args
        .iter()
        .map(|a| a.to_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()
    else {
        eprintln!("polycarp: theme: arguments must be valid text");
        return 2;
    };
    let Some((sub, rest)) = args.split_first() else {
        eprint!("{USAGE}");
        return 2;
    };
    let r = match sub.as_str() {
        "list" => cmd_list(rest),
        "show" => cmd_show(rest),
        "current" => cmd_current(rest),
        "set" => cmd_set(rest),
        "accent" => cmd_accent(rest),
        "create" => cmd_create(rest),
        "edit-path" => cmd_edit_path(rest),
        "delete" => cmd_delete(rest),
        "validate" => cmd_validate(rest),
        "export" => cmd_export(rest),
        "undo" => cmd_undo(rest),
        "history" => cmd_history(rest),
        "reset" => cmd_reset(rest),
        "--help" | "-h" | "help" => {
            print!("{USAGE}");
            Ok(())
        }
        other => Err(usage_fail(format!("unknown command {other}"))),
    };
    match r {
        Ok(()) => 0,
        Err(f) => {
            eprintln!("{}", f.msg);
            f.code
        }
    }
}

struct Entry {
    name: String,
    source: &'static str,
    title: Option<String>,
    problems: Vec<String>,
}

fn entries(cfg: &Cfg) -> Vec<Entry> {
    let mut out = Vec::new();
    let mk = |name: &str, source: &'static str, r: Result<Full, Vec<String>>| match r {
        Ok(f) => Entry {
            name: name.into(),
            source,
            title: Some(f.title),
            problems: vec![],
        },
        Err(p) => Entry {
            name: name.into(),
            source,
            title: None,
            problems: p,
        },
    };
    for (n, _) in BUILTINS {
        out.push(mk(n, "built-in", resolve_name(cfg, n)));
    }
    let mut users: Vec<String> = fs::read_dir(cfg.themes())
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter_map(|e| {
                    let p = e.path();
                    if p.extension().is_some_and(|x| x == "toml") {
                        p.file_stem().map(|s| s.to_string_lossy().into_owned())
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    users.sort();
    for n in users {
        if is_builtin(&n) {
            out.push(mk(
                &n,
                "user",
                Err(vec![
                    "this name belongs to a built-in theme, so the file is ignored".into(),
                ]),
            ));
        } else if !valid_name(&n) {
            out.push(mk(
                &n,
                "user",
                Err(vec!["the file name is not a valid theme name".into()]),
            ));
        } else {
            out.push(mk(&n, "user", resolve_name(cfg, &n)));
        }
    }
    out
}

fn cmd_list(args: &[String]) -> R {
    let p = parse_args(args, &[], &["json"])?;
    exactly(&p, 0, "no arguments")?;
    let cfg = cfg()?;
    let eff = effective(&cfg);
    let list = entries(&cfg);
    if p.flag("json") {
        let arr: Vec<Json> = list
            .iter()
            .map(|e| {
                json!({
                    "name": e.name,
                    "source": e.source,
                    "title": e.title,
                    "current": e.name == eff.state.theme,
                    "valid": e.problems.is_empty(),
                    "problems": e.problems,
                })
            })
            .collect();
        print_json(&Json::Array(arr));
    } else {
        for e in &list {
            let mark = if e.name == eff.state.theme { "*" } else { " " };
            let tail = match &e.title {
                Some(t) => t.clone(),
                None => format!(
                    "(invalid: {} problem(s); run `polycarp theme validate`)",
                    e.problems.len()
                ),
            };
            println!("{mark} {:<16} {:<9} {tail}", e.name, e.source);
        }
    }
    warn(&eff.problems);
    Ok(())
}

fn view_json(full: &Full) -> Json {
    theme_json(full, None)
}

fn resolve_for_view(cfg: &Cfg, name: Option<&str>) -> Result<(Full, Vec<String>), Fail> {
    match name {
        Some(n) => {
            let f = resolve_name(cfg, n)
                .map_err(|p| problems_fail(&format!("theme {n:?} cannot be used"), &p))?;
            Ok((f, vec![]))
        }
        None => {
            let eff = effective(cfg);
            Ok((eff.full, eff.problems))
        }
    }
}

fn cmd_show(args: &[String]) -> R {
    let p = parse_args(args, &[], &["json"])?;
    if p.pos.len() > 1 {
        return Err(usage_fail("expected at most one theme name"));
    }
    let cfg = cfg()?;
    let (full, problems) = resolve_for_view(&cfg, p.pos.first().map(String::as_str))?;
    if p.flag("json") {
        // As authored here: durations are not zeroed; the exports zero them.
        let mut v = view_json(&full);
        if let Some(o) = v.as_object_mut() {
            let mut s = serde_json::Map::new();
            for n in SURFACES {
                s.insert(
                    n.to_string(),
                    serde_json::to_value(full.surface(n)).unwrap_or(Json::Null),
                );
            }
            o.insert("surfaces".into(), Json::Object(s));
        }
        print_json(&v);
    } else {
        let mut t = Value::try_from(&full.base)
            .ok()
            .and_then(|v| v.as_table().cloned())
            .unwrap_or_default();
        t.insert("name".into(), Value::String(full.name.clone()));
        t.insert("title".into(), Value::String(full.title.clone()));
        if let Some(d) = &full.description {
            t.insert("description".into(), Value::String(d.clone()));
        }
        print!("{}", toml::to_string(&t).unwrap_or_default());
        for s in SURFACES {
            if full.surface(s) != &full.base {
                println!("# surface {s} overrides some of the values above");
            }
        }
    }
    warn(&problems);
    Ok(())
}

fn cmd_current(args: &[String]) -> R {
    let p = parse_args(args, &[], &["json"])?;
    exactly(&p, 0, "no arguments")?;
    let cfg = cfg()?;
    let eff = effective(&cfg);
    let source = if is_builtin(&eff.state.theme) {
        "built-in"
    } else {
        "user"
    };
    if p.flag("json") {
        print_json(&json!({
            "theme": eff.state.theme,
            "source": source,
            "mode": eff.state.mode,
            "accent_light": eff.state.accent_light,
            "accent_dark": eff.state.accent_dark,
            "config": cfg.file().display().to_string(),
            "problems": eff.problems,
            "fell_back": !eff.problems.is_empty(),
        }));
    } else {
        println!("theme: {} ({source})", eff.state.theme);
        println!("mode: {}", eff.state.mode);
        println!(
            "accent_light: {}",
            eff.state.accent_light.as_deref().unwrap_or("none")
        );
        println!(
            "accent_dark: {}",
            eff.state.accent_dark.as_deref().unwrap_or("none")
        );
        println!("config: {}", cfg.file().display());
        warn(&eff.problems);
    }
    Ok(())
}

/// Writes the state, then the outputs, and says what it did.
fn commit(cfg: &Cfg, st: &State, action: &str) -> R {
    record(cfg, action).map_err(fail)?;
    let text = state_table(cfg, st);
    write_atomic(&cfg.file(), text.as_bytes()).map_err(fail)?;
    finish(cfg)
}

/// Writes the outputs for whatever state is now in force, and prints what changed.
fn finish(cfg: &Cfg) -> R {
    let eff = effective(cfg);
    warn(&eff.problems);
    let wrote = write_outputs(cfg, &eff).map_err(fail)?;
    println!("theme: {}", eff.state.theme);
    println!("mode: {}", eff.state.mode);
    if eff.state.accent_light.is_some() || eff.state.accent_dark.is_some() {
        println!(
            "accent: light {}, dark {}",
            eff.state.accent_light.as_deref().unwrap_or("theme's own"),
            eff.state.accent_dark.as_deref().unwrap_or("theme's own")
        );
    }
    println!("wrote {}", cfg.file().display());
    for w in wrote {
        println!("wrote {}", w.display());
    }
    println!("{NOTE}");
    Ok(())
}

fn cmd_set(args: &[String]) -> R {
    let p = parse_args(args, &["mode"], &[])?;
    exactly(&p, 1, "one theme name")?;
    let name = &p.pos[0];
    let cfg = cfg()?;
    let full = resolve_name(&cfg, name)
        .map_err(|ps| problems_fail(&format!("theme {name:?} cannot be used"), &ps))?;
    let (mut st, old_problems) = load_state(&cfg);
    if !old_problems.is_empty() {
        eprintln!("polycarp: warning: the old settings were invalid and are replaced:");
        for o in &old_problems {
            eprintln!("  {o}");
        }
    }
    if let Some(m) = p.val("mode") {
        if !matches!(m, "auto" | "light" | "dark") {
            return Err(usage_fail("--mode must be auto, light or dark"));
        }
        st.mode = m.to_string();
    }
    st.theme = name.clone();
    if apply_accents(&full, st.accent_light.as_deref(), st.accent_dark.as_deref()).is_err() {
        eprintln!(
            "polycarp: note: your accent override does not read well on {name}, so it is cleared"
        );
        st.accent_light = None;
        st.accent_dark = None;
    }
    commit(&cfg, &st, &format!("theme set {name}"))
}

fn cmd_accent(args: &[String]) -> R {
    let p = parse_args(args, &["mode"], &["clear"])?;
    let both = ["light", "dark"];
    let modes: Vec<&str> = match p.val("mode") {
        None | Some("auto") | Some("both") => both.to_vec(),
        Some("light") => vec!["light"],
        Some("dark") => vec!["dark"],
        Some(_) => return Err(usage_fail("--mode must be light or dark")),
    };
    let new = if p.flag("clear") {
        exactly(&p, 0, "--clear alone")?;
        None
    } else {
        exactly(&p, 1, "a color like #rrggbb, or --clear")?;
        let c = &p.pos[0];
        if !is_hex(c) {
            return Err(fail(format!("{c:?} is not a color like #rrggbb")));
        }
        Some(c.to_lowercase())
    };
    let cfg = cfg()?;
    let eff = effective(&cfg);
    let mut st = eff.state.clone();
    for m in &modes {
        if *m == "light" {
            st.accent_light = new.clone();
        } else {
            st.accent_dark = new.clone();
        }
    }
    let full = build_full(&cfg, &st).map_err(|ps| {
        problems_fail(
            &format!(
                "accent {} is refused, nothing changed",
                new.as_deref().unwrap_or("")
            ),
            &ps,
        )
    })?;
    drop(full);
    let action = match &new {
        Some(c) => format!("theme accent {c}"),
        None => "theme accent --clear".to_string(),
    };
    commit(&cfg, &st, &action)
}

fn title_case(name: &str) -> String {
    name.split('-')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn cmd_create(args: &[String]) -> R {
    let p = parse_args(args, &["extends"], &["force"])?;
    exactly(&p, 1, "one theme name")?;
    let name = &p.pos[0];
    let Some(base_name) = p.val("extends") else {
        return Err(usage_fail("create needs --extends <base>"));
    };
    if !valid_name(name) {
        return Err(fail(format!(
            "{name:?} is not a valid theme name (lowercase letters, digits and hyphens)"
        )));
    }
    if is_builtin(name) {
        return Err(fail(format!(
            "{name:?} is a built-in theme name; pick another"
        )));
    }
    let cfg = cfg()?;
    let base = resolve_name(&cfg, base_name)
        .map_err(|ps| problems_fail(&format!("cannot extend {base_name:?}"), &ps))?;
    let path = cfg.theme_path(name);
    if path.exists() && !p.flag("force") {
        return Err(fail(format!(
            "{} already exists; use --force to overwrite it",
            path.display()
        )));
    }
    let mut s = format!(
        "# Polycarp theme {name:?}. It starts from {base_name:?}.\n\
         # Uncomment a line and change it to override that value.\n\
         # Check it with `polycarp theme validate {name}.toml`, then use `polycarp theme set {name}`.\n\
         name = {}\n\
         title = {}\n\
         extends = {}\n\
         # description = \"One line about this theme.\"\n\n",
        json!(name),
        json!(title_case(name)),
        json!(base_name),
    );
    let notes = [
        ("light", "Colors for light mode. Each is \"#rrggbb\". Text colors need contrast 4.5 on background and surface."),
        ("dark", "Colors for dark mode. Same rules as light."),
        ("shape", "Corners and borders in px, shadow as 0.0 to 1.0, density compact|regular|spacious, indicator dot|bar|number-block."),
        ("type", "Font stacks, base size in px (10 to 24), weight (300 to 800), line_height (1.0 to 2.0)."),
        ("motion", "Durations in ms (0 to 1000), easing as a CSS string, scale_from 0.5 to 1.0. reduced = true makes every duration 0."),
    ];
    let table = Value::try_from(&base.base)
        .ok()
        .and_then(|v| v.as_table().cloned())
        .unwrap_or_default();
    for (sec, note) in notes {
        s.push_str(&format!("# {note}\n# [{sec}]\n"));
        if let Some(Value::Table(t)) = table.get(sec) {
            for (f, _) in fields(sec) {
                if let Some(v) = t.get(f) {
                    s.push_str(&format!("# {f} = {v}\n"));
                }
            }
        }
        s.push('\n');
    }
    s.push_str(
        "# Overrides for one product only: spaces, voice, browser or site.\n\
         # Any section above works inside a surface, for example:\n\
         # [surface.site.light]\n\
         # accent = \"#3f6b6a\"\n",
    );
    write_atomic(&path, s.as_bytes()).map_err(fail)?;
    println!("created {}", path.display());
    println!("It extends {base_name}. Edit it, then run `polycarp theme validate` on it.");
    Ok(())
}

fn cmd_edit_path(args: &[String]) -> R {
    let p = parse_args(args, &[], &[])?;
    exactly(&p, 1, "one theme name")?;
    let name = &p.pos[0];
    if !valid_name(name) {
        return Err(fail(format!("{name:?} is not a valid theme name")));
    }
    if is_builtin(name) {
        return Err(fail(format!(
            "{name:?} is built in and cannot be edited; run `polycarp theme create <name> --extends {name}`"
        )));
    }
    let cfg = cfg()?;
    println!("{}", cfg.theme_path(name).display());
    Ok(())
}

/// The theme name in `config.toml` even when the rest of the file is bad.
fn current_name_lenient(cfg: &Cfg) -> Option<String> {
    let t = fs::read_to_string(cfg.file()).ok()?.parse::<Table>().ok()?;
    t.get("appearance")?
        .as_table()?
        .get("theme")?
        .as_str()
        .map(str::to_string)
}

fn cmd_delete(args: &[String]) -> R {
    let p = parse_args(args, &[], &[])?;
    exactly(&p, 1, "one theme name")?;
    let name = &p.pos[0];
    if !valid_name(name) {
        return Err(fail(format!("{name:?} is not a valid theme name")));
    }
    if is_builtin(name) {
        return Err(fail(format!("{name:?} is built in and cannot be deleted")));
    }
    let cfg = cfg()?;
    let path = cfg.theme_path(name);
    if !path.is_file() {
        return Err(fail(format!("no user theme named {name:?}")));
    }
    let eff = effective(&cfg);
    if eff.state.theme == *name || current_name_lenient(&cfg).as_deref() == Some(name.as_str()) {
        return Err(fail(format!(
            "{name:?} is the current theme; run `polycarp theme set <other>` first"
        )));
    }
    fs::remove_file(&path)
        .map_err(|e| fail(format!("could not delete {}: {e}", path.display())))?;
    println!("deleted {}", path.display());
    Ok(())
}

fn cmd_validate(args: &[String]) -> R {
    let p = parse_args(args, &[], &[])?;
    exactly(&p, 1, "one file")?;
    let file = Path::new(&p.pos[0]);
    let cfg = cfg()?;
    let src = fs::read_to_string(file)
        .map_err(|e| fail(format!("could not read {}: {e}", file.display())))?;
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let table = parse_toml(&src)
        .map_err(|e| problems_fail(&format!("{} is not valid", file.display()), &[e]))?;
    match resolve_doc(&cfg, table, Some(&stem)) {
        Ok(full) => {
            println!(
                "ok: {} ({}) is valid in all {} surfaces, light and dark",
                file.display(),
                full.name,
                SURFACES.len()
            );
            Ok(())
        }
        Err(ps) => Err(problems_fail(
            &format!("{} is not valid", file.display()),
            &ps,
        )),
    }
}

fn cmd_export(args: &[String]) -> R {
    let p = parse_args(args, &["surface"], &[])?;
    if p.pos.is_empty() || p.pos.len() > 2 {
        return Err(usage_fail("expected `export <css|json> [name]`"));
    }
    let format = p.pos[0].as_str();
    if !matches!(format, "css" | "json") {
        return Err(usage_fail("export format must be css or json"));
    }
    let surface = match p.val("surface") {
        None => None,
        Some(s) if SURFACES.contains(&s) => Some(s),
        Some(_) => {
            return Err(usage_fail(format!(
                "--surface must be one of {}",
                SURFACES.join(", ")
            )))
        }
    };
    let cfg = cfg()?;
    let (full, problems) = resolve_for_view(&cfg, p.pos.get(1).map(String::as_str))?;
    if format == "css" {
        print!("{}", css(&full, surface, None));
    } else if let Some(s) = surface {
        let mut v = resolved_json(full.surface(s));
        if let Some(o) = v.as_object_mut() {
            o.insert("name".into(), json!(full.name));
            o.insert("title".into(), json!(full.title));
            o.insert("surface".into(), json!(s));
        }
        print_json(&v);
    } else {
        print_json(&theme_json(&full, None));
    }
    warn(&problems);
    Ok(())
}

fn cmd_undo(args: &[String]) -> R {
    let p = parse_args(args, &[], &[])?;
    exactly(&p, 0, "no arguments")?;
    let cfg = cfg()?;
    let hist = read_history(&cfg);
    let Some(last) = hist.first() else {
        return Err(fail("nothing to undo"));
    };
    if last.absent {
        match fs::remove_file(cfg.file()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(fail(format!(
                    "could not remove {}: {e}",
                    cfg.file().display()
                )))
            }
        }
    } else {
        write_atomic(&cfg.file(), &last.body).map_err(fail)?;
    }
    fs::remove_file(&last.file)
        .map_err(|e| fail(format!("could not remove {}: {e}", last.file.display())))?;
    println!("undid: {} ({}, {})", last.action, last.caller, last.time);
    finish(&cfg)
}

fn cmd_history(args: &[String]) -> R {
    let p = parse_args(args, &[], &["json"])?;
    exactly(&p, 0, "no arguments")?;
    let cfg = cfg()?;
    let hist = read_history(&cfg);
    if p.flag("json") {
        let arr: Vec<Json> = hist
            .iter()
            .map(|h| {
                json!({
                    "time": h.time,
                    "caller": h.caller,
                    "action": h.action,
                    "file": h.file.display().to_string(),
                })
            })
            .collect();
        print_json(&Json::Array(arr));
    } else if hist.is_empty() {
        println!("no history yet");
    } else {
        for (i, h) in hist.iter().enumerate() {
            println!("{:>2}  {}  {:<16} {}", i + 1, h.time, h.caller, h.action);
        }
    }
    Ok(())
}

fn cmd_reset(args: &[String]) -> R {
    let p = parse_args(args, &[], &[])?;
    exactly(&p, 0, "no arguments")?;
    let cfg = cfg()?;
    commit(&cfg, &State::default_state(), "theme reset")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contrast_black_white_is_21() {
        assert!((contrast("#000000", "#ffffff") - 21.0).abs() < 1e-9);
    }

    #[test]
    fn civil_epoch() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(19_723), (2024, 1, 1));
    }

    #[test]
    fn names() {
        assert!(valid_name("still-water"));
        assert!(!valid_name("Still"));
        assert!(!valid_name("../x"));
        assert!(!valid_name("-x"));
        assert!(!valid_name(""));
    }
}
