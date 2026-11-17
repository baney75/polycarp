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

pub(super) const APPS: [&str; 5] = ["ghostty", "neovim", "btop", "zed", "windows-terminal"];

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

fn var(k: &str) -> Option<PathBuf> {
    env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Where apps keep their settings. `POLYCARP_APPS_HOME` stands in for the home folder, so tests
/// and agents never touch a person's real app settings; under it the Windows folders are
/// `AppData/Local` and `AppData/Roaming`.
fn config_home() -> Option<PathBuf> {
    if let Some(h) = var("POLYCARP_APPS_HOME") {
        return Some(h.join(".config"));
    }
    if cfg!(windows) {
        return var("LOCALAPPDATA");
    }
    var("XDG_CONFIG_HOME").or_else(|| var("HOME").map(|h| h.join(".config")))
}

/// The app's settings folder, or None where it does not run.
fn app_dir(app: &str) -> Option<PathBuf> {
    let over = var("POLYCARP_APPS_HOME");
    let windows = cfg!(windows) && over.is_none();
    match app {
        "neovim" => Some(config_home()?.join("nvim")),
        "ghostty" | "btop" if !windows => Some(config_home()?.join(app)),
        "zed" if windows => Some(var("APPDATA")?.join("Zed")),
        "zed" => Some(config_home()?.join("zed")),
        "windows-terminal" => {
            let local = match over {
                Some(h) => h.join("AppData").join("Local"),
                None if cfg!(windows) => var("LOCALAPPDATA")?,
                None => return None,
            };
            Some(local.join("Microsoft/Windows Terminal/Fragments/Polycarp"))
        }
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
        "btop" => p
            .iter()
            .map(|(m, c, t, _)| {
                let mut s = head("#");
                let mut put = |k: &str, v: &str| s.push_str(&format!("theme[{k}]=\"{v}\"\n"));
                for (k, role) in [
                    ("main_bg", "background"),
                    ("main_fg", "foreground"),
                    ("title", "strong"),
                    ("hi_fg", "accent"),
                    ("selected_bg", "selection"),
                    ("selected_fg", "strong"),
                    ("inactive_fg", "muted"),
                    ("graph_text", "muted"),
                    ("meter_bg", "sunken"),
                    ("proc_misc", "accent"),
                    ("cpu_box", "border"),
                    ("mem_box", "border"),
                    ("net_box", "border"),
                    ("proc_box", "border"),
                    ("div_line", "border"),
                ] {
                    put(k, &c[role]);
                }
                for (k, [a, b, d]) in [
                    ("temp", ["green", "yellow", "red"]),
                    ("cpu", ["green", "yellow", "red"]),
                    ("free", ["green", "cyan", "blue"]),
                    ("cached", ["blue", "cyan", "magenta"]),
                    ("available", ["cyan", "green", "yellow"]),
                    ("used", ["yellow", "red", "red"]),
                    ("download", ["blue", "cyan", "green"]),
                    ("upload", ["magenta", "red", "yellow"]),
                    ("process", ["green", "yellow", "red"]),
                ] {
                    put(&format!("{k}_start"), &t[a]);
                    put(&format!("{k}_mid"), &t[b]);
                    put(&format!("{k}_end"), &t[d]);
                }
                (dir.join("themes").join(format!("polycarp-{m}.theme")), s)
            })
            .collect(),
        "neovim" => {
            let mut s = head("--");
            s.push_str("vim.cmd(\"highlight clear\")\nvim.g.colors_name = \"polycarp\"\n");
            if mode == "light" || mode == "dark" {
                s.push_str(&format!("vim.o.background = \"{mode}\"\n"));
            }
            s.push_str("local palettes = {\n");
            for (m, c, t, code) in &p {
                s.push_str(&format!("  {m} = {{\n"));
                for (k, v) in c.iter().chain(t.iter().filter(|(k, _)| ANSI.contains(&k.as_str()))) {
                    s.push_str(&format!("    {k} = \"{v}\",\n"));
                }
                for (k, v) in &code["syntax"] {
                    s.push_str(&format!("    syntax_{k} = \"{v}\",\n"));
                }
                for (k, v) in &code["diff"] {
                    s.push_str(&format!("    diff_{k} = \"{v}\",\n"));
                }
                s.push_str("  },\n");
            }
            s.push_str(NVIM_BODY);
            vec![(dir.join("colors").join("polycarp.lua"), s)]
        }
        "zed" => {
            let themes: Vec<Json> = p
                .iter()
                .map(|(m, c, t, code)| zed_theme(m, c, t, code))
                .collect();
            let doc = json!({
                "$schema": "https://zed.dev/schema/themes/v0.2.0.json",
                "name": "Polycarp",
                "author": "Polycarp",
                "themes": themes,
            });
            let mut s = format!("{doc:#}\n");
            // Zed's theme files are JSON, which has no comments, so the note is a field.
            s.insert_str(1, &format!("\n  \"$comment\": {},", json!(head("").trim())));
            vec![(dir.join("themes").join("polycarp.json"), s)]
        }
        // A fragment Windows Terminal reads at start; its schemes join the user's own.
        "windows-terminal" => {
            let schemes: Vec<Json> = p
                .iter()
                .map(|(m, _, t, _)| {
                    let mut o = serde_json::Map::new();
                    o.insert("name".into(), json!(format!("Polycarp {}", title(m))));
                    for (k, v) in [
                        ("background", "background"),
                        ("foreground", "foreground"),
                        ("cursorColor", "cursor"),
                        ("selectionBackground", "selection"),
                    ] {
                        o.insert(k.into(), json!(t[v]));
                    }
                    for k in ANSI {
                        o.insert(wt_name(k), json!(t[k]));
                    }
                    Json::Object(o)
                })
                .collect();
            let doc = json!({"schemes": schemes});
            let mut s = format!("{doc:#}\n");
            s.insert_str(1, &format!("\n  \"$comment\": {},", json!(head("").trim())));
            vec![(dir.join("polycarp.json"), s)]
        }
        _ => Vec::new(),
    }
}

fn title(mode: &str) -> &'static str {
    if mode == "light" {
        "Light"
    } else {
        "Dark"
    }
}

/// Windows Terminal's name for a terminal color: `bright_magenta` is `brightPurple`.
fn wt_name(k: &str) -> String {
    let k = k.replace("magenta", "purple");
    match k.strip_prefix("bright_") {
        Some(rest) => format!("bright{}{}", rest[..1].to_uppercase(), &rest[1..]),
        None => k,
    }
}

/// One theme of Zed's theme family.
fn zed_theme(mode: &str, c: &Colors, t: &Colors, code: &Code) -> Json {
    let mut style = serde_json::Map::new();
    let mut put = |k: &str, v: &str| {
        style.insert(k.into(), json!(v));
    };
    for (k, role) in [
        ("background", "background"),
        ("surface.background", "surface"),
        ("elevated_surface.background", "surface"),
        ("panel.background", "surface"),
        ("editor.background", "background"),
        ("editor.gutter.background", "background"),
        ("editor.active_line.background", "sunken"),
        ("editor.foreground", "foreground"),
        ("editor.line_number", "muted"),
        ("editor.active_line_number", "accent"),
        ("tab_bar.background", "sunken"),
        ("tab.active_background", "background"),
        ("tab.inactive_background", "sunken"),
        ("title_bar.background", "sunken"),
        ("status_bar.background", "sunken"),
        ("toolbar.background", "background"),
        ("border", "border"),
        ("border.variant", "border"),
        ("border.focused", "accent"),
        ("element.background", "surface"),
        ("element.hover", "sunken"),
        ("element.selected", "selection"),
        ("ghost_element.hover", "sunken"),
        ("ghost_element.selected", "selection"),
        ("text", "foreground"),
        ("text.muted", "muted"),
        ("text.placeholder", "muted"),
        ("text.accent", "accent"),
        ("icon", "foreground"),
        ("icon.muted", "muted"),
        ("icon.accent", "accent"),
        ("error", "urgent"),
        ("warning", "working"),
        ("success", "done"),
        ("info", "accent"),
    ] {
        put(k, &c[role]);
    }
    put("terminal.background", &t["background"]);
    put("terminal.foreground", &t["foreground"]);
    for k in ANSI {
        put(&format!("terminal.ansi.{k}"), &t[k]);
    }
    let diff = &code["diff"];
    put("created", &diff["added"]);
    put("deleted", &diff["removed"]);
    put("modified", &diff["modified"]);
    put("version_control.added", &diff["gutter_added"]);
    put("version_control.deleted", &diff["gutter_removed"]);
    put("version_control.modified", &diff["modified"]);
    let syntax: serde_json::Map<String, Json> = code["syntax"]
        .iter()
        .map(|(k, v)| (k.clone(), json!({ "color": v })))
        .collect();
    style.insert("syntax".into(), Json::Object(syntax));
    style.insert(
        "players".into(),
        json!([{"cursor": c["accent"], "background": c["accent"], "selection": c["selection"]}]),
    );
    json!({
        "name": format!("Polycarp {}", title(mode)),
        "appearance": mode,
        "style": style,
    })
}

const NVIM_BODY: &str = r#"}
local p = palettes[vim.o.background == "light" and "light" or "dark"]
local function hl(group, spec) vim.api.nvim_set_hl(0, group, spec) end
for i, k in ipairs({ "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright_black", "bright_red", "bright_green", "bright_yellow", "bright_blue", "bright_magenta",
  "bright_cyan", "bright_white" }) do
  vim.g["terminal_color_" .. (i - 1)] = p[k]
end
hl("Normal", { fg = p.foreground, bg = p.background })
hl("NormalFloat", { fg = p.foreground, bg = p.surface })
hl("FloatBorder", { fg = p.border, bg = p.surface })
hl("Cursor", { fg = p.on_accent, bg = p.accent })
hl("CursorLine", { bg = p.sunken })
hl("CursorLineNr", { fg = p.accent, bold = true })
hl("LineNr", { fg = p.muted })
hl("Visual", { bg = p.selection })
hl("Search", { fg = p.on_accent, bg = p.accent })
hl("IncSearch", { fg = p.on_accent, bg = p.accent })
hl("MatchParen", { fg = p.accent, bold = true })
hl("Pmenu", { fg = p.foreground, bg = p.surface })
hl("PmenuSel", { fg = p.on_accent, bg = p.accent })
hl("StatusLine", { fg = p.foreground, bg = p.surface })
hl("StatusLineNC", { fg = p.muted, bg = p.sunken })
hl("WinSeparator", { fg = p.border })
hl("NonText", { fg = p.border })
hl("Title", { fg = p.strong, bold = true })
hl("Directory", { fg = p.syntax_function })
hl("ErrorMsg", { fg = p.urgent })
hl("WarningMsg", { fg = p.working })
hl("DiagnosticError", { fg = p.urgent })
hl("DiagnosticWarn", { fg = p.working })
hl("DiagnosticInfo", { fg = p.accent })
hl("DiagnosticOk", { fg = p.done })
hl("Comment", { fg = p.syntax_comment, italic = true })
hl("Keyword", { fg = p.syntax_keyword })
hl("Statement", { fg = p.syntax_keyword })
hl("String", { fg = p.syntax_string })
hl("Number", { fg = p.syntax_number })
hl("Function", { fg = p.syntax_function })
hl("Type", { fg = p.syntax_type })
hl("Identifier", { fg = p.syntax_variable })
hl("Constant", { fg = p.syntax_constant })
hl("Operator", { fg = p.syntax_operator })
hl("Delimiter", { fg = p.syntax_punctuation })
hl("Tag", { fg = p.syntax_tag })
hl("@tag", { fg = p.syntax_tag })
hl("@tag.attribute", { fg = p.syntax_attribute })
hl("@property", { fg = p.syntax_property })
hl("@variable", { fg = p.syntax_variable })
hl("DiffAdd", { fg = p.diff_added, bg = p.diff_added_surface })
hl("DiffDelete", { fg = p.diff_removed, bg = p.diff_removed_surface })
hl("DiffChange", { fg = p.diff_modified })
hl("Added", { fg = p.diff_gutter_added })
hl("Removed", { fg = p.diff_gutter_removed })
hl("Changed", { fg = p.diff_modified })
"#;

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
