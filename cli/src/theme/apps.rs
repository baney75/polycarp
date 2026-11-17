//! Other apps that `theme set` colors, each one opted in under `[apps]` in `config.toml`.
//!
//! A writer writes only files Polycarp owns (named `polycarp*`) and, for an app that needs it, one
//! line in the app's own config that points at them. What it wrote is kept in `<config>/apps/`,
//! with the app config's bytes from before the line went in, so turning the app off, `theme off`
//! and `undo` put that config back exactly.

use super::{gone, write_atomic};
use polycarp_theme::{Code, Colors, Full, MODES};
use serde_json::{json, Value as Json};
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use toml::{Table, Value};

pub(super) const APPS: [&str; 1] = ["ghostty"];

const ANSI: [&str; 16] = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "bright_black",
    "bright_red",
    "bright_green",
    "bright_yellow",
    "bright_blue",
    "bright_magenta",
    "bright_cyan",
    "bright_white",
];

const GHOSTTY_LINE: &str = "theme = light:polycarp-light,dark:polycarp-dark";

/// Where apps keep their settings. `POLYCARP_APPS_HOME` stands in for the home folder, so tests
/// and agents never touch a person's real app settings.
fn config_home() -> Option<PathBuf> {
    let set = |k: &str| env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(h) = set("POLYCARP_APPS_HOME") {
        return Some(h.join(".config"));
    }
    if cfg!(windows) {
        return set("LOCALAPPDATA");
    }
    set("XDG_CONFIG_HOME").or_else(|| set("HOME").map(|h| h.join(".config")))
}

/// The app's settings folder, or None where it does not run.
fn app_dir(app: &str) -> Option<PathBuf> {
    let base = config_home()?;
    let override_set = env::var_os("POLYCARP_APPS_HOME").is_some_and(|v| !v.is_empty());
    match app {
        "ghostty" if override_set || !cfg!(windows) => Some(base.join(app)),
        _ => None,
    }
}

/// The colors an app is written from, for light and dark: (mode, the 13 colors, the terminal
/// palette, every code color). A forced mode's colors are used for both.
fn palettes(full: &Full, mode: &str) -> [(&'static str, Colors, Colors, Code); 2] {
    MODES.map(|m| {
        let from = if mode == "light" || mode == "dark" {
            mode
        } else {
            m
        };
        let code = full.base.code(from);
        (
            m,
            full.base.colors(from).clone(),
            code["terminal"].clone(),
            code,
        )
    })
}

/// Every file the app gets: (path, text).
fn files(app: &str, dir: &Path, full: &Full, mode: &str) -> Vec<(PathBuf, String)> {
    let head = |c: &str| {
        format!(
            "{c} Written by `polycarp theme set` from the theme {:?}. Polycarp replaces this file; change the theme instead.\n",
            full.name
        )
    };
    let p = palettes(full, mode);
    match app {
        "ghostty" => p
            .iter()
            .map(|(m, _, t, _)| {
                let mut s = head("#");
                s.push_str(&format!(
                    "background = {}\nforeground = {}\ncursor-color = {}\nselection-background = {}\nselection-foreground = {}\n",
                    t["background"], t["foreground"], t["cursor"], t["selection"], t["foreground"]
                ));
                for (i, k) in ANSI.iter().enumerate() {
                    s.push_str(&format!("palette = {i}={}\n", t[*k]));
                }
                (dir.join("themes").join(format!("polycarp-{m}")), s)
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The one line an app's own config needs to use Polycarp's files: (config file, line).
fn include(app: &str, dir: &Path) -> Option<(PathBuf, &'static str)> {
    match app {
        // Ghostty 1.2 reads `config.ghostty` first; older ones read `config`.
        "ghostty" => {
            let newer = dir.join("config.ghostty");
            let file = if newer.exists() {
                newer
            } else {
                dir.join("config")
            };
            Some((file, GHOSTTY_LINE))
        }
        _ => None,
    }
}

/// The apps `config.toml` turns on under `[apps]`, and any problem with that table.
pub(super) fn wanted(config: &Table) -> (BTreeSet<String>, Vec<String>) {
    let mut on = BTreeSet::new();
    let mut problems = Vec::new();
    match config.get("apps") {
        None => {}
        Some(Value::Table(t)) => {
            for (k, v) in t {
                match (APPS.contains(&k.as_str()), v.as_bool()) {
                    (false, _) => problems.push(format!(
                        "apps.{k}: not an app Polycarp themes ({})",
                        APPS.join(", ")
                    )),
                    (true, None) => problems.push(format!("apps.{k}: {v} is not true or false")),
                    (true, Some(true)) => {
                        on.insert(k.clone());
                    }
                    (true, Some(false)) => {}
                }
            }
        }
        Some(_) => problems.push("apps: must be a table".into()),
    }
    (on, problems)
}

/// What a writer did, kept in `<config>/apps/<app>.json`, with the app config's earlier bytes in
/// `<app>.original` when it added a line there.
fn record_path(state: &Path, app: &str) -> PathBuf {
    state.join(format!("{app}.json"))
}

fn read_record(state: &Path, app: &str) -> Option<Json> {
    serde_json::from_slice(&fs::read(record_path(state, app)).ok()?).ok()
}

/// `text` with `line` added as its last line, the way a writer adds it.
fn with_line(text: &[u8], line: &str) -> Vec<u8> {
    let mut out = text.to_vec();
    if !out.is_empty() && !out.ends_with(b"\n") {
        out.push(b'\n');
    }
    out.extend_from_slice(line.as_bytes());
    out.push(b'\n');
    out
}

/// Brings every app in line with the settings: writes the apps that are on (when the theme is
/// on) and puts back the ones that are not. Returns the files written or put back, the files
/// removed, and one message per failure.
pub(super) fn sync(
    state: &Path,
    on: &BTreeSet<String>,
    theme: Option<(&Full, &str)>,
) -> (Vec<PathBuf>, Vec<PathBuf>, Vec<String>) {
    let (mut wrote, mut removed, mut failed) = (Vec::new(), Vec::new(), Vec::new());
    for app in APPS {
        let rec = read_record(state, app);
        let dir = app_dir(app);
        let want = theme.filter(|_| on.contains(app)).zip(dir.as_ref());
        match want {
            Some(((full, mode), dir)) => {
                if let Err(e) = write_app(state, app, dir, full, mode, rec.as_ref(), &mut wrote) {
                    failed.push(format!("{app}: {e}"));
                }
            }
            None => {
                if on.contains(app) && dir.is_none() && theme.is_some() {
                    failed.push(format!("{app}: no settings folder for it on this computer"));
                }
                if let Some(rec) = rec {
                    if let Err(e) = restore_app(state, app, &rec, &mut wrote, &mut removed) {
                        failed.push(format!("{app}: {e}"));
                    }
                }
            }
        }
    }
    (wrote, removed, failed)
}

fn write_app(
    state: &Path,
    app: &str,
    dir: &Path,
    full: &Full,
    mode: &str,
    rec: Option<&Json>,
    wrote: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let new = files(app, dir, full, mode);
    let mut include_rec = rec.and_then(|r| r.get("include")).cloned();
    if include_rec.is_none() {
        if let Some((file, line)) = include(app, dir) {
            let was = match fs::read(&file) {
                Ok(b) => Some(b),
                Err(e) if gone(&e) => None,
                Err(e) => return Err(format!("could not read {}: {e}", file.display())),
            };
            fs::create_dir_all(state)
                .map_err(|e| format!("could not create {}: {e}", state.display()))?;
            if let Some(b) = &was {
                write_atomic(&state.join(format!("{app}.original")), b)?;
            }
            let lines = was.as_deref().unwrap_or_default();
            // A config that already has the line is left alone, and so is never put back.
            let added = !String::from_utf8_lossy(lines).lines().any(|l| l == line);
            if added {
                write_atomic(&file, &with_line(lines, line))?;
                wrote.push(file.clone());
            }
            include_rec =
                added.then(|| json!({"file": file, "line": line, "absent": was.is_none()}));
        }
    }
    for (p, text) in &new {
        if fs::read(p).ok().as_deref() != Some(text.as_bytes()) {
            write_atomic(p, text.as_bytes())?;
            wrote.push(p.clone());
        }
    }
    // A file an earlier write made that this one does not, such as one from another folder.
    let names: Vec<&PathBuf> = new.iter().map(|(p, _)| p).collect();
    for old in rec
        .and_then(|r| r["files"].as_array())
        .into_iter()
        .flatten()
    {
        let old = PathBuf::from(old.as_str().unwrap_or_default());
        if !names.contains(&&old) {
            let _ = fs::remove_file(&old);
        }
    }
    let rec = json!({"files": names, "include": include_rec});
    write_atomic(&record_path(state, app), format!("{rec:#}\n").as_bytes())
}

fn restore_app(
    state: &Path,
    app: &str,
    rec: &Json,
    put_back: &mut Vec<PathBuf>,
    removed: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for f in rec["files"].as_array().into_iter().flatten() {
        let p = PathBuf::from(f.as_str().unwrap_or_default());
        match fs::remove_file(&p) {
            Ok(()) => removed.push(p),
            Err(e) if gone(&e) => {}
            Err(e) => return Err(format!("could not remove {}: {e}", p.display())),
        }
    }
    let original = state.join(format!("{app}.original"));
    if let (Some(file), Some(line)) = (
        rec["include"]["file"].as_str(),
        rec["include"]["line"].as_str(),
    ) {
        let file = PathBuf::from(file);
        let was = if rec["include"]["absent"].as_bool() == Some(true) {
            None
        } else {
            Some(
                fs::read(&original)
                    .map_err(|e| format!("could not read {}: {e}", original.display()))?,
            )
        };
        if let Ok(now) = fs::read(&file) {
            let ours = with_line(was.as_deref().unwrap_or_default(), line);
            if now == ours {
                // Untouched since: put the exact bytes back.
                match &was {
                    Some(b) => {
                        write_atomic(&file, b)?;
                        put_back.push(file);
                    }
                    None => {
                        fs::remove_file(&file)
                            .map_err(|e| format!("could not remove {}: {e}", file.display()))?;
                        removed.push(file);
                    }
                }
            } else {
                // Edited since: take out only Polycarp's line and keep the rest.
                let text = String::from_utf8_lossy(&now).into_owned();
                if text.lines().any(|l| l == line) {
                    let kept: String = text
                        .split_inclusive('\n')
                        .filter(|l| l.trim_end_matches(['\n', '\r']) != line)
                        .collect();
                    write_atomic(&file, kept.as_bytes())?;
                    put_back.push(file);
                }
            }
        }
    }
    let _ = fs::remove_file(&original);
    fs::remove_file(record_path(state, app))
        .map_err(|e| format!("could not remove the record: {e}"))
}

/// What `theme apps` shows for each app: whether it is on, and the files it writes.
pub(super) fn describe(state: &Path, on: &BTreeSet<String>) -> Vec<Json> {
    APPS.iter()
        .map(|app| {
            let dir = app_dir(app);
            let written: Vec<Json> = read_record(state, app)
                .and_then(|r| r["files"].as_array().cloned())
                .unwrap_or_default();
            json!({
                "app": app,
                "on": on.contains(*app),
                "folder": dir.as_ref().map(|d| d.display().to_string()),
                "written": written,
                "include": dir.as_deref().and_then(|d| include(app, d)).map(|(f, l)| json!({"file": f, "line": l})),
            })
        })
        .collect()
}
