//! Resolving a theme: `extends`, per-product overrides and accent overrides.

use super::{
    check_doc, combine, contrast, contrast_on, fields, is_hex, valid_name, Colors, BUILTINS,
    MAX_DEPTH, MODES, SECTIONS, SURFACES, TEXT_MIN,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use toml::{Table, Value};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Shape {
    pub radius_small: i64,
    pub radius: i64,
    pub radius_large: i64,
    pub border_width: i64,
    pub blur: i64,
    pub shadow: f64,
    pub density: String,
    pub indicator: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Typo {
    pub display: String,
    pub ui: String,
    pub mono: String,
    pub size: i64,
    pub weight: i64,
    pub line_height: f64,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Motion {
    pub fast: i64,
    pub normal: i64,
    pub slow: i64,
    pub easing: String,
    pub scale_from: f64,
    pub reduced: bool,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Resolved {
    pub light: Colors,
    pub dark: Colors,
    pub shape: Shape,
    #[serde(rename = "type")]
    pub typ: Typo,
    pub motion: Motion,
}

impl Resolved {
    pub fn colors(&self, mode: &str) -> &Colors {
        if mode == "dark" {
            &self.dark
        } else {
            &self.light
        }
    }
    pub fn colors_mut(&mut self, mode: &str) -> &mut Colors {
        if mode == "dark" {
            &mut self.dark
        } else {
            &mut self.light
        }
    }
    /// What products read: with `reduced` on, every duration is 0.
    pub fn exported(&self) -> Resolved {
        let mut r = self.clone();
        if r.motion.reduced {
            r.motion.fast = 0;
            r.motion.normal = 0;
            r.motion.slow = 0;
        }
        r
    }
    pub fn contrast_problems(&self) -> Vec<String> {
        contrast_on(&self.light, &self.dark)
    }
}

#[derive(Clone)]
pub struct Full {
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    pub base: Resolved,
    pub surfaces: BTreeMap<String, Resolved>,
    /// "<surface>.<mode>" for each surface that sets its own `accent` or `on_accent` in that mode.
    /// An accent override from `theme accent` does not replace those.
    pub pinned: BTreeSet<String>,
}

impl Full {
    pub fn surface(&self, s: &str) -> &Resolved {
        self.surfaces.get(s).unwrap_or(&self.base)
    }
    pub fn contrast_problems(&self) -> Vec<String> {
        combine(
            self.base.contrast_problems(),
            SURFACES
                .iter()
                .map(|s| (s.to_string(), self.surface(s).contrast_problems()))
                .collect(),
        )
    }
}

pub fn parse_toml(src: &str) -> Result<Table, String> {
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

pub fn merge(base: &mut Table, over: &Table) {
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

pub fn ext_of(t: &Table) -> Option<String> {
    t.get("extends").and_then(Value::as_str).map(str::to_string)
}

pub fn colors_of(t: &Table, mode: &str) -> Colors {
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

pub fn without_meta(t: &Table) -> Table {
    let mut b = t.clone();
    for k in ["name", "title", "description", "extends", "surface"] {
        b.remove(k);
    }
    b
}

pub fn is_builtin(name: &str) -> bool {
    BUILTINS.iter().any(|(n, _)| *n == name)
}

/// Where a theme that is not built in comes from, by name: a file in the config folder's `themes/`,
/// or text not saved yet. The name is already valid and not a built-in's.
pub trait Themes {
    fn user_theme(&self, name: &str) -> Result<Table, String>;
}

/// Reads the theme file at `path`, which holds the theme `name`.
pub fn read_theme_file(path: &Path, name: &str) -> Result<Table, String> {
    match fs::read_to_string(path) {
        Ok(src) => parse_toml(&src),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("no theme named {name:?}"))
        }
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

pub fn load_raw(cfg: &impl Themes, name: &str) -> Result<Table, String> {
    if !valid_name(name) {
        return Err(format!("{name:?} is not a valid theme name"));
    }
    if let Some((_, src)) = BUILTINS.iter().find(|(n, _)| *n == name) {
        return parse_toml(src);
    }
    cfg.user_theme(name)
}

pub fn resolve_name(cfg: &impl Themes, name: &str) -> Result<Full, Vec<String>> {
    let t = load_raw(cfg, name).map_err(|e| vec![e])?;
    resolve_doc(cfg, t, Some(name))
}

/// Checks a theme and everything it extends, reporting every problem, then resolves it.
pub fn resolve_doc(
    cfg: &impl Themes,
    start: Table,
    expect: Option<&str>,
) -> Result<Full, Vec<String>> {
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
    let mut pinned = BTreeSet::new();
    for s in SURFACES {
        for m in MODES {
            let own = surface_t.get(s).and_then(|v| v.get(m));
            if own.is_some_and(|t| t.get("accent").is_some() || t.get("on_accent").is_some()) {
                pinned.insert(format!("{s}.{m}"));
            }
        }
    }
    let text = |k: &str| merged.get(k).and_then(Value::as_str).map(str::to_string);
    Ok(Full {
        pinned,
        name: text("name").unwrap_or_default(),
        title: text("title").unwrap_or_default(),
        description: text("description"),
        base,
        surfaces,
    })
}

/// Applies accent overrides to every surface. `on_accent` is the theme's own, black or white:
/// the first that reads on the new accent.
pub fn apply_accents(
    full: &Full,
    light: Option<&str>,
    dark: Option<&str>,
) -> Result<Full, Vec<String>> {
    let mut out = full.clone();
    let apply = |r: &mut Resolved, surface: Option<&str>| {
        for (mode, accent) in [("light", light), ("dark", dark)] {
            let Some(a) = accent else { continue };
            // A value the theme sets for this product itself wins over the override.
            if surface.is_some_and(|s| full.pinned.contains(&format!("{s}.{mode}"))) {
                continue;
            }
            let c = r.colors_mut(mode);
            let own = c.get("on_accent").cloned().unwrap_or_default();
            let pick = [own.as_str(), "#000000", "#ffffff"]
                .into_iter()
                .find(|cand| is_hex(cand) && contrast(cand, a) >= TEXT_MIN)
                .unwrap_or("#000000")
                .to_string();
            c.insert("accent".into(), a.to_lowercase());
            c.insert("on_accent".into(), pick);
        }
    };
    apply(&mut out.base, None);
    for (name, r) in out.surfaces.iter_mut() {
        apply(r, Some(name.as_str()));
    }
    let probs = out.contrast_problems();
    if probs.is_empty() {
        Ok(out)
    } else {
        Err(probs)
    }
}
