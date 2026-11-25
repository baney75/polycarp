//! How Polycarp's surfaces look now: the style sheet, the settings a look holds and the paper, read through
//! `polycarp-spaces` as `polycarp mcp` runs it.

use super::fields::{self, FIELDS, MODULES};
use super::format::{self, Look};
use super::paper::{self, Paper, Picture, Wall, PLACES};
use super::store;
use crate::mcp;
use crate::theme::{self, ApiErr, Ctx};
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Pictures move through the paper store, which reads and writes them.
const LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// What the surfaces are set to, raw: a module of the person's own is in here, and not in a look.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Live {
    pub style: Option<String>,
    pub surfaces: BTreeMap<String, Json>,
    pub paper: Paper,
    pub pictures: BTreeMap<String, Picture>,
    /// The bar's modules as they ship; read only when the person has modules of their own.
    pub defaults: BTreeMap<String, Json>,
}

/// Runs `polycarp-spaces <argv> --json`: its data, or its refusal.
pub fn spaces(argv: &[&str]) -> Result<Json, ApiErr> {
    let argv: Vec<String> = argv.iter().map(|a| a.to_string()).collect();
    let probe = argv.iter().take(2).cloned().collect::<Vec<_>>().join(" ");
    let (mut env, ok) = mcp::spaces_run_within(argv, &probe, LIMIT);
    if ok {
        return Ok(env["data"].take());
    }
    Err(ApiErr::from_spaces(&env))
}

pub fn no_spaces(e: &ApiErr) -> bool {
    e.code() == "spaces_not_found"
}

/// None without Polycarp Spaces (on Linux and Windows, say), where only the theme is a look's.
pub fn read() -> Result<Option<Live>, ApiErr> {
    let style = match spaces(&["style", "show"]) {
        Err(e) if no_spaces(&e) => return Ok(None),
        r => r?,
    };
    let kept: Vec<&str> = FIELDS
        .iter()
        .filter(|(_, k, _)| *k)
        .map(|(p, ..)| *p)
        .collect();
    // One process each, side by side: a look holds about twenty.
    let values = std::thread::scope(|s| {
        let jobs: Vec<_> = kept
            .iter()
            .map(|p| s.spawn(|| spaces(&["surfaces", "get", p])))
            .collect();
        jobs.into_iter()
            .map(|j| {
                j.join().unwrap_or_else(|_| {
                    Err(theme::io_err("polycarp-spaces surfaces get failed".into()))
                })
            })
            .collect::<Result<Vec<_>, _>>()
    })?;
    let surfaces: BTreeMap<String, Json> = kept
        .iter()
        .zip(values)
        .filter(|(_, d)| d["set"] == json!(true))
        .map(|(p, mut d)| (p.to_string(), d["value"].take()))
        .collect();
    let mut live = Live {
        style: (style["exists"] == json!(true))
            .then(|| style["text"].as_str().unwrap_or_default().to_string()),
        surfaces,
        ..Live::default()
    };
    if live
        .surfaces
        .iter()
        .any(|(p, v)| p.starts_with(MODULES) && has_own(v))
    {
        let schema = spaces(&["surfaces", "schema"])?;
        live.defaults = defaults(&schema);
    }
    read_paper(&spaces(&["paper", "get"])?, &mut live)?;
    Ok(Some(live))
}

fn own_module(v: &Json) -> bool {
    v.as_str().is_some_and(|s| s.starts_with("custom:"))
}

fn has_own(v: &Json) -> bool {
    v.as_array().is_some_and(|a| a.iter().any(own_module))
}

/// Each module list's default, from the settings' JSON schema.
fn defaults(schema: &Json) -> BTreeMap<String, Json> {
    let modules = &schema["properties"]["bar"]["properties"]["modules"]["properties"];
    ["left", "center", "right"]
        .iter()
        .map(|k| (format!("{MODULES}.{k}"), modules[k]["default"].clone()))
        .filter(|(_, v)| v.is_array())
        .collect()
}

fn read_paper(d: &Json, live: &mut Live) -> Result<(), ApiErr> {
    let own = |place: &str| d[place]["from"] == json!(format!("{place}.paper"));
    let mut spots = vec![("all", &d["paper"])];
    spots.extend(PLACES.iter().filter(|p| own(p)).map(|p| (*p, &d[*p])));
    for (place, v) in spots {
        let Some(value) = v["value"].as_str() else {
            continue;
        };
        let wall = if paper::is_paper(value) {
            Wall::Value(value.to_string())
        } else {
            match v["picture"]
                .as_str()
                .filter(|_| v["missing"] != json!(true))
            {
                Some(file) => {
                    let pic = store::read_plain(&expand(file), paper::MAX_PICTURE)
                        .and_then(|b| Picture::of(b).map_err(theme::io_err))?;
                    let hash = pic.sha256();
                    live.pictures.insert(hash.clone(), pic);
                    Wall::Picture(hash)
                }
                // The picture is gone, so there is no paper there to keep.
                None => continue,
            }
        };
        live.paper.insert(place.to_string(), wall);
    }
    Ok(())
}

fn expand(p: &str) -> PathBuf {
    match (p.strip_prefix("~/"), crate::home()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(p),
    }
}

impl Live {
    /// The settings as a look holds them: none of the person's own modules or pictures. `Err` is `path: why`.
    pub fn look_surfaces(&self, notes: &mut Vec<String>) -> Result<BTreeMap<String, Json>, String> {
        let mut out = BTreeMap::new();
        for (path, v) in &self.surfaces {
            match fields::kept(path, v, notes) {
                // A list that is its default once the person's own modules are out of it is not set.
                Ok(Some(k)) if has_own(v) && self.defaults.get(path) == Some(&k) => {}
                Ok(Some(k)) => {
                    out.insert(path.clone(), k);
                }
                Ok(None) => {}
                Err(why) => return Err(format!("surfaces.{path}: {why}")),
            }
        }
        Ok(out)
    }

    /// Whether the surfaces look as `look` has them, for the parts it has.
    pub fn same_as(&self, look: &Look) -> bool {
        let mut quiet = Vec::new();
        look.style.as_ref().is_none_or(|s| *s == self.style)
            && look.paper.as_ref().is_none_or(|p| *p == self.paper)
            && look
                .surfaces
                .as_ref()
                .is_none_or(|s| self.look_surfaces(&mut quiet).as_ref() == Ok(s))
    }
}

/// Polycarp's own checks of a look's sheet and settings. Nothing is changed.
pub fn check(c: &Ctx, look: &Look) -> Result<(), ApiErr> {
    let work = Work::new(c)?;
    if let Some(Some(css)) = &look.style {
        let f = work.file("style.css", css.as_bytes())?;
        spaces(&["style", "check", &f])
            .map_err(|e| e.under("style", "the look's style sheet is refused"))?;
    }
    if let Some(s) = &look.surfaces {
        let mut t = fields::tree(s);
        t["version"] = json!(1);
        let f = work.file("surfaces.json", theme::pretty(&t).as_bytes())?;
        let d = spaces(&["surfaces", "validate", &f])
            .map_err(|e| e.under("surfaces", "the look's settings are refused"))?;
        let unknown: Vec<String> = d["warnings"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|w| {
                let (p, m) = (
                    w["path"].as_str().unwrap_or("$"),
                    w["message"].as_str().unwrap_or_default(),
                );
                format!("surfaces.{p}: {m}")
            })
            .collect();
        if !unknown.is_empty() {
            return Err(store::refused(
                "this Polycarp doesn't know all of the look's settings",
                &unknown,
            ));
        }
    }
    Ok(())
}

/// A folder of the person's alone for files handed to `polycarp-spaces`, gone when it is dropped.
pub struct Work(PathBuf);

impl Work {
    pub fn new(c: &Ctx) -> Result<Work, ApiErr> {
        let looks = store::dir(c);
        store::ensure(&looks)?;
        let d = looks.join(format!(".work-{}", std::process::id()));
        store::ensure(&d)?;
        Ok(Work(d))
    }
    pub fn file(&self, name: &str, bytes: &[u8]) -> Result<String, ApiErr> {
        let p: &Path = &self.0.join(name);
        store::write_plain(p, bytes)?;
        Ok(p.display().to_string())
    }
}

impl Drop for Work {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// How everything looks now.
pub struct Now {
    pub theme: theme::ThemeLook,
    pub live: Option<Live>,
    pub notes: Vec<String>,
}

pub fn now(c: &Ctx) -> Result<Now, ApiErr> {
    let (theme, notes) = theme::capture(c)?;
    Ok(Now {
        theme,
        live: read()?,
        notes,
    })
}

impl Now {
    pub fn same_as(&self, look: &Look) -> bool {
        self.theme.same_as(&look.theme) && self.live.as_ref().is_none_or(|l| l.same_as(look))
    }

    /// What a look would change, in plain words.
    pub fn changes(&self, c: &Ctx, look: &Look) -> Vec<String> {
        let mut out = Vec::new();
        let mut line =
            |what: &str, to: String, now: String| out.push(format!("{what}: {to} (now {now})"));
        let (t, n) = (&look.theme, &self.theme);
        let bare = |t: &theme::ThemeLook| theme::ThemeLook {
            mode: "auto".into(),
            accent_light: None,
            accent_dark: None,
            ..t.clone()
        };
        if !bare(t).same_as(&bare(n)) {
            line("theme", t.theme_title(c), n.theme_title(c));
        }
        if t.mode != n.mode {
            line("mode", t.mode.clone(), n.mode.clone());
        }
        let color = |v: &Option<String>| v.clone().unwrap_or_else(|| "the theme's".into());
        for (what, to, now) in [
            ("accent in light", &t.accent_light, &n.accent_light),
            ("accent in dark", &t.accent_dark, &n.accent_dark),
        ] {
            if to != now {
                line(what, color(to), color(now));
            }
        }
        let empty = Live::default();
        let live = self.live.as_ref().unwrap_or(&empty);
        let waits = if self.live.is_none() {
            "waiting for Polycarp Spaces"
        } else {
            ""
        };
        let is = |s: String| {
            if waits.is_empty() {
                s
            } else {
                waits.to_string()
            }
        };
        if let Some(s) = look.style.as_ref().filter(|s| **s != live.style) {
            line(
                "style sheet",
                sheet(s.as_deref()),
                is(sheet(live.style.as_deref())),
            );
        }
        if let Some(s) = &look.surfaces {
            let have = live.look_surfaces(&mut Vec::new()).unwrap_or_default();
            for (path, ..) in FIELDS {
                if s.get(*path) != have.get(*path) {
                    line(path, value(s.get(*path)), is(value(have.get(*path))));
                }
            }
        }
        if let Some(p) = &look.paper {
            for (place, what) in [
                ("all", "paper"),
                ("desktop", "paper on the desktop"),
                ("newtab", "paper on the new tab page"),
                ("idle", "paper on the idle screen"),
            ] {
                if p.get(place) != live.paper.get(place) {
                    line(
                        what,
                        wall(p.get(place), &look.pictures),
                        is(wall(live.paper.get(place), &live.pictures)),
                    );
                }
            }
        }
        out
    }
}

fn sheet(s: Option<&str>) -> String {
    match s {
        None => "none".into(),
        Some(s) => format!("one of {} lines", s.lines().count()),
    }
}

fn value(v: Option<&Json>) -> String {
    match v {
        None => "its default".into(),
        Some(Json::String(s)) => format::shown(s),
        Some(v) => format::shown(&v.to_string()),
    }
}

fn wall(w: Option<&Wall>, pictures: &BTreeMap<String, Picture>) -> String {
    match w {
        None => "none".into(),
        Some(Wall::Value(v)) => v.clone(),
        Some(Wall::Picture(h)) => match pictures.get(h) {
            Some(p) => format!("a {} picture, {} KB", p.ext(), p.bytes.len().div_ceil(1024)),
            None => "a picture".into(),
        },
    }
}
