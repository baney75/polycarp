//! `polycarp theme`: one theme file drives every Polycarp product and the site.
//!
//! A theme is a TOML file. This module checks it, resolves `extends`, merges per-product
//! overrides, and writes the result where products read it. It never starts another process.

use serde_json::{json, Value as Json};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use toml::{Table, Value};

pub(crate) use omarchy::{doctor_line, op_follow};

mod edit;
mod omarchy;
mod picture;
mod png;
mod preview;

use polycarp_theme::{
    apply_accents, check_value, color_lines, css, ext_of, fields, is_builtin, is_hex, json_of,
    load_raw, parse_toml, read_theme_file, resolve_doc, resolve_name, resolved_json, schema,
    shared_vars, theme_json, valid_name, Full, Kind, Resolved, State as Choice, Themes, BUILTINS,
    DEFAULT_THEME, MAX_DEPTH, MODES, SECTIONS, SURFACES,
};
// What the Omarchy code in `omarchy` uses from the theme library; it reads through `super::*`.
use polycarp_theme::{colors_of, contrast, merge, pairs, without_meta, Colors, ROLES, TEXT_MIN};

/// What `theme off` can say: the state of the files, which it checked. Whether an app changes,
/// and when, is up to that app, so the text says only what the apps are expected to do.
const OFF_NOTE: &str = "The theme files are gone from current/. Apps that read them are expected to use their own look when they next check.";

/// Off, but some files are still there: `remaining` names them.
const OFF_LEFT_NOTE: &str = "The theme is off in the settings, but the files in remaining are still in current/, so apps may still read them.";

/// Gone: not there, or `current` isn't a folder (so nothing can be in it).
fn gone(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

const NOTE: &str =
    "Products read these files once their adapters land. Until then only the files change.";

pub const USAGE: &str = "\
polycarp theme: one theme for every Polycarp product and the site

Usage:
  polycarp theme list [--json]
  polycarp theme show [name] [--json]
  polycarp theme current [--json]
  polycarp theme schema [--json]
  polycarp theme get <path> [name] [--json]
  polycarp theme set <name> [--mode auto|light|dark]
  polycarp theme accent <#rrggbb> [--mode light|dark] | --clear [--mode light|dark]
  polycarp theme change <path> <value> [<path> <value> ...] [--theme <name>] [--json]
  polycarp theme apply <file|-> [--name <name>] [--no-activate] [--json]
  polycarp theme preview [name] [--mode light|dark|both] [--surface <s>] [--format html|png] [--out <file|folder>] [--json]
  polycarp theme create <name> --extends <base> [--force]
  polycarp theme edit-path <name>
  polycarp theme folder [--pin | --unpin] [--json]
  polycarp theme delete <name> [--force]
  polycarp theme validate <file|->
  polycarp theme export <css|json|toml> [name] [--surface spaces|voice|browser|site|studio]
  polycarp theme undo [--force]
  polycarp theme history [--json]
  polycarp theme follow [omarchy [--sync | --if-fresh] | reset | off] [--json]
  polycarp theme off
  polycarp theme on
  polycarp theme reset

Every command takes --json and then prints the envelope {ok, data} or {ok:false, error}.
Exit codes: 0 ok, 1 refused or invalid, 2 usage. Agents: `polycarp mcp` serves the same
commands as MCP tools, and `polycarp theme schema` lists every field.

Built-in themes: polycarp (default), still-water, evening, parchment, blocks, calm.
Your own themes live in <config>/themes/<name>.toml. The config folder is
$POLYCARP_CONFIG_DIR if set (an absolute path), else the folder `theme folder --pin` recorded,
else $XDG_CONFIG_HOME/polycarp (default ~/.config/polycarp), or %APPDATA%\\Polycarp on Windows.
Set POLYCARP_CALLER to record who made a change (default: user).

Products read the files in <config>/current/ once their adapters land.
Until then only the files change.
";

const HISTORY_KEEP: usize = 50;

// ---------------------------------------------------------------------------------------------
// Where things live
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
struct Cfg {
    dir: PathBuf,
    /// A theme file that is not on disk yet: (name, TOML text). Lets a change be tried first.
    overlay: Vec<(String, String)>,
}

/// The folder that holds the pin: %APPDATA%\Polycarp on Windows, else ~/.config/polycarp. It reads no
/// override, so an app started from the Dock, which sees neither POLYCARP_CONFIG_DIR nor
/// XDG_CONFIG_HOME, finds the same file the shell's CLI wrote (first-F2 of the review of #11).
fn pin_home() -> Option<PathBuf> {
    let var = |k: &str| env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if cfg!(windows) {
        var("APPDATA").map(|d| d.join("Polycarp"))
    } else {
        var("HOME").map(|h| h.join(".config").join("polycarp"))
    }
}

/// The pin file: one line, the absolute path of the config folder every product uses.
const PIN_FILE: &str = "config-dir";

/// The pinned folder, when the pin names an absolute path to a folder that exists.
fn pinned_dir() -> Option<PathBuf> {
    let text = fs::read_to_string(pin_home()?.join(PIN_FILE)).ok()?;
    Some(PathBuf::from(text.trim())).filter(|d| d.is_absolute() && d.is_dir())
}

/// `theme folder`: the config folder in use and where it came from; `--pin` records it for apps
/// that start without the shell's environment, `--unpin` removes that record.
fn op_folder(pin: bool, unpin: bool) -> Res {
    let dir = config_dir().map_err(|e| ApiErr::new("config_error", e))?;
    let home = pin_home().ok_or_else(|| {
        ApiErr::new(
            "config_error",
            "HOME (APPDATA on Windows) is not set".to_string(),
        )
    })?;
    let file = home.join(PIN_FILE);
    if unpin || (pin && dir == home) {
        match fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err(format!("could not remove {}: {e}", file.display()))),
        }
    } else if pin {
        fs::create_dir_all(&dir)
            .map_err(|e| io_err(format!("could not create {}: {e}", dir.display())))?;
        write_atomic(&file, format!("{}\n", dir.display()).as_bytes()).map_err(io_err)?;
    }
    let pinned = pinned_dir();
    let mut text = format!("{}\n", dir.display());
    if pinned.as_ref() != Some(&dir) && dir != home {
        text.push_str("Apps started from the Dock or a menu don't see this folder's variable. Run `polycarp theme folder --pin` so they use it too.\n");
    }
    Ok(Out::new(
        json!({"folder": dir.display().to_string(), "pinned": pinned.map(|p| p.display().to_string()), "pin_file": file.display().to_string()}),
        text,
    ))
}

/// The config folder, by the same rules as the theme files.
pub fn config_dir() -> Result<PathBuf, String> {
    Ok(Cfg::from_env()?.dir)
}

impl Cfg {
    fn from_env() -> Result<Cfg, String> {
        let nonempty = |k: &str| env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        let dir = if let Some(d) = nonempty("POLYCARP_CONFIG_DIR") {
            if !d.is_absolute() {
                return Err(format!(
                    "POLYCARP_CONFIG_DIR must be an absolute path, but it is {}",
                    d.display()
                ));
            }
            d
        } else if let Some(d) = pinned_dir() {
            d
        } else if cfg!(windows) {
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
        Ok(Cfg {
            dir,
            overlay: Vec::new(),
        })
    }
    fn with_overlay(&self, name: &str, text: &str) -> Cfg {
        let mut c = self.clone();
        c.overlay.retain(|(n, _)| n != name);
        c.overlay.push((name.to_string(), text.to_string()));
        c
    }
    /// Several theme files that are not on disk yet.
    fn with_overlays(&self, files: &[(&str, &str)]) -> Cfg {
        files
            .iter()
            .fold(self.clone(), |c, (n, t)| c.with_overlay(n, t))
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
// State
// ---------------------------------------------------------------------------------------------

/// The settings `config.toml` holds. The library's `State` is the theme choice alone; the CLI
/// also keeps what to go back to while Polycarp follows the Omarchy theme.
#[derive(Clone, PartialEq, Debug)]
struct State {
    theme: String,
    mode: String,
    accent_light: Option<String>,
    accent_dark: Option<String>,
    /// False after `theme off`: the files in `current/` are removed.
    enabled: bool,
    /// Set while Polycarp follows the Omarchy theme: what to go back to when it stops.
    follow: Option<Follow>,
}

/// The `[omarchy]` table in `config.toml`.
#[derive(Clone, PartialEq, Debug)]
struct Follow {
    previous_theme: String,
    previous_mode: String,
    /// Overrides that were moved to read on the current Omarchy theme: path -> (what the person
    /// set, or "" if nothing; what is written now). A sync puts the first back before it checks.
    fits: BTreeMap<String, (String, String)>,
    /// The accents `theme accent` had set before following, put back when it stops.
    prev_accent_light: Option<String>,
    prev_accent_dark: Option<String>,
    /// A mode chosen while following (`set --mode`); it wins over Omarchy's.
    mode_override: Option<String>,
}

impl State {
    fn default_state() -> State {
        State {
            theme: DEFAULT_THEME.into(),
            mode: "auto".into(),
            accent_light: None,
            accent_dark: None,
            enabled: true,
            follow: None,
        }
    }

    /// The theme choice, as the library's `theme_json` takes it.
    fn choice(&self) -> Choice {
        Choice {
            theme: self.theme.clone(),
            mode: self.mode.clone(),
            accent_light: self.accent_light.clone(),
            accent_dark: self.accent_dark.clone(),
            enabled: self.enabled,
        }
    }
}

impl Themes for Cfg {
    fn user_theme(&self, name: &str) -> Result<Table, String> {
        if let Some((_, text)) = self.overlay.iter().find(|(n, _)| n == name) {
            return parse_toml(text);
        }
        read_theme_file(&self.theme_path(name), name)
    }
}

/// The `[omarchy]` table, if it is complete and valid. Anything else counts as not following.
fn read_follow(cfg: &Cfg) -> Option<Follow> {
    let table = parse_toml(&fs::read_to_string(cfg.file()).ok()?).ok()?;
    let t = table.get("omarchy")?.as_table()?;
    if !t.get("following")?.as_bool()? {
        return None;
    }
    let theme = t
        .get("previous_theme")?
        .as_str()
        .filter(|s| valid_name(s))?;
    let mode = t.get("previous_mode")?.as_str().filter(|m| mode_ok(m))?;
    let mut fits = BTreeMap::new();
    if let Some(f) = t.get("fits").and_then(Value::as_table) {
        for (k, v) in f {
            let pair = v.as_array().and_then(|a| match a.as_slice() {
                [Value::String(x), Value::String(y)] => Some((x.clone(), y.clone())),
                _ => None,
            });
            if let Some(pair) = pair {
                fits.insert(k.clone(), pair);
            }
        }
    }
    let hex = |k: &str| {
        t.get(k)
            .and_then(Value::as_str)
            .filter(|s| is_hex(s))
            .map(str::to_lowercase)
    };
    Some(Follow {
        previous_theme: theme.to_string(),
        previous_mode: mode.to_string(),
        fits,
        prev_accent_light: hex("prev_accent_light"),
        prev_accent_dark: hex("prev_accent_dark"),
        mode_override: t
            .get("mode_override")
            .and_then(Value::as_str)
            .filter(|m| mode_ok(m))
            .map(str::to_string),
    })
}

/// Reads `config.toml`. Anything wrong is reported and the defaults are used.
fn load_state(cfg: &Cfg) -> (State, Vec<String>) {
    let (mut st, problems) = load_appearance(cfg);
    if problems.is_empty() {
        st.follow = read_follow(cfg);
    }
    (st, problems)
}

fn load_appearance(cfg: &Cfg) -> (State, Vec<String>) {
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
            "enabled" => match v.as_bool() {
                Some(b) => st.enabled = b,
                None => problems.push(format!("appearance.enabled: {v} is not true or false")),
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
    let mut def = State::default_state();
    // Whether the theme is on is a separate choice from a theme that fails to build.
    def.enabled = st.enabled;
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
    if !st.enabled {
        app.insert("enabled".into(), Value::Boolean(false));
    }
    if let Some(a) = &st.accent_light {
        app.insert("accent_light".into(), Value::String(a.clone()));
    }
    if let Some(a) = &st.accent_dark {
        app.insert("accent_dark".into(), Value::String(a.clone()));
    }
    table.insert("appearance".into(), Value::Table(app));
    match &st.follow {
        Some(f) => {
            let mut o = Table::new();
            o.insert("following".into(), Value::Boolean(true));
            o.insert(
                "previous_theme".into(),
                Value::String(f.previous_theme.clone()),
            );
            o.insert(
                "previous_mode".into(),
                Value::String(f.previous_mode.clone()),
            );
            for (k, v) in [
                ("prev_accent_light", &f.prev_accent_light),
                ("prev_accent_dark", &f.prev_accent_dark),
                ("mode_override", &f.mode_override),
            ] {
                if let Some(v) = v {
                    o.insert(k.into(), Value::String(v.clone()));
                }
            }
            if !f.fits.is_empty() {
                let mut fits = Table::new();
                for (k, (a, b)) in &f.fits {
                    fits.insert(
                        k.clone(),
                        Value::Array(vec![Value::String(a.clone()), Value::String(b.clone())]),
                    );
                }
                o.insert("fits".into(), Value::Table(fits));
            }
            table.insert("omarchy".into(), Value::Table(o));
        }
        None => {
            table.remove("omarchy");
        }
    }
    toml::to_string(&table).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Follows symbolic links, even dangling ones, to the file that would really be written.
fn resolve_link(path: &Path) -> PathBuf {
    let mut p = path.to_path_buf();
    for _ in 0..16 {
        match fs::symlink_metadata(&p) {
            Ok(m) if m.file_type().is_symlink() => match fs::read_link(&p) {
                Ok(t) => {
                    p = if t.is_absolute() {
                        t
                    } else {
                        p.parent().map_or(t.clone(), |d| d.join(&t))
                    }
                }
                Err(_) => break,
            },
            _ => break,
        }
    }
    p
}

/// Writes to a temp file next to the real target, then renames it into place. If `path` is a
/// symbolic link the target is written and the link stays. An existing file keeps its mode; a new
/// one gets 0644 on Unix.
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let target = resolve_link(path);
    let dir = target.parent().ok_or("no parent folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let file = target.file_name().map(|f| f.to_string_lossy().into_owned());
    let tmp = dir.join(format!(
        ".{}.tmp-{}-{n}",
        file.unwrap_or_default(),
        std::process::id()
    ));
    let existing = fs::metadata(&target).ok().filter(|m| m.is_file());
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        if let Some(m) = &existing {
            fs::set_permissions(&tmp, m.permissions())?;
        }
        #[cfg(unix)]
        if existing.is_none() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644))?;
        }
        fs::rename(&tmp, &target)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("could not write {}: {e}", target.display()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------------------------

const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// An exclusive lock on the config folder, held while a change is read, checked, recorded and
/// written. It is an operating-system advisory lock on a `.lock` file that is never removed, so
/// nobody can take it from a live holder, and the system frees it when the process ends, even
/// after a crash. Dropping it (or closing the file) releases it.
struct Lock {
    _file: fs::File,
}

impl Lock {
    fn acquire(cfg: &Cfg) -> Result<Lock, ApiErr> {
        fs::create_dir_all(&cfg.dir)
            .map_err(|e| io_err(format!("could not create {}: {e}", cfg.dir.display())))?;
        let path = cfg.dir.join(".lock");
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| io_err(format!("could not create the lock {}: {e}", path.display())))?;
        let start = std::time::Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Lock { _file: file }),
                Err(fs::TryLockError::WouldBlock) => {
                    if start.elapsed() >= LOCK_WAIT {
                        return Err(ApiErr::new(
                            "busy",
                            format!(
                                "another polycarp command is changing the theme files ({} is held)",
                                path.display()
                            ),
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(fs::TryLockError::Error(e)) => {
                    return Err(io_err(format!("could not lock {}: {e}", path.display())))
                }
            }
        }
    }
}

/// The files in `current/` that are still there, so a claim that they are gone can be checked.
fn remaining_theme_files(cfg: &Cfg) -> Vec<PathBuf> {
    let dir = cfg.current();
    let mut names = vec!["theme.json".to_string()];
    names.extend(SURFACES.iter().map(|s| format!("{s}.css")));
    names
        .into_iter()
        .map(|n| dir.join(n))
        // Only gone() means gone. Any other error (no permission to look) counts as remaining.
        .filter(|p| !matches!(fs::symlink_metadata(p), Err(e) if gone(&e)))
        .collect()
}

/// Writes every file in `current/`, trying each one even if another fails. Returns the files
/// written and one message per file that could not be.
/// Whether current/theme.json differs from what the settings build now, as after a refresh that
/// failed.
fn current_stale(cfg: &Cfg) -> bool {
    let eff = effective(cfg);
    let json = serde_json::to_string_pretty(&theme_json(&eff.full, Some(&eff.state.choice())))
        .unwrap_or_default();
    fs::read_to_string(cfg.current().join("theme.json")).ok() != Some(format!("{json}\n"))
}

fn write_outputs(cfg: &Cfg, eff: &Eff) -> (Vec<PathBuf>, Vec<String>) {
    let dir = cfg.current();
    let mut wrote = Vec::new();
    let mut failed = Vec::new();
    if !eff.state.enabled {
        // Off: the same files are removed, and the list returned is the files removed.
        let mut names = vec!["theme.json".to_string()];
        names.extend(SURFACES.iter().map(|s| format!("{s}.css")));
        for n in names {
            let p = dir.join(&n);
            match fs::remove_file(&p) {
                Ok(()) => wrote.push(p),
                Err(e) if gone(&e) => {}
                Err(e) => failed.push(format!("{n}: {e}")),
            }
        }
        return (wrote, failed);
    }
    // A Value always serializes, so the fallback is never used.
    let json = serde_json::to_string_pretty(&theme_json(&eff.full, Some(&eff.state.choice())))
        .unwrap_or_default();
    let mut files = vec![(dir.join("theme.json"), format!("{json}\n"))];
    let forced = (eff.state.mode != "auto").then_some(eff.state.mode.as_str());
    for s in SURFACES {
        files.push((
            dir.join(format!("{s}.css")),
            css(&eff.full, Some(s), forced),
        ));
    }
    for (p, data) in files {
        match write_atomic(&p, data.as_bytes()) {
            Ok(()) => wrote.push(p),
            Err(e) => failed.push(format!(
                "{}: {e}",
                p.file_name().unwrap_or_default().to_string_lossy()
            )),
        }
    }
    (wrote, failed)
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

/// A caller name with control characters removed, trimmed and cut to 64 characters.
pub(crate) fn clean_caller(raw: &str) -> String {
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
    /// False when the file has no readable header, or its theme part is cut short.
    valid: bool,
    time: String,
    caller: String,
    action: String,
    absent: bool,
    body: Vec<u8>,
    /// A user theme file this change also touched, with what it held before.
    theme_name: Option<String>,
    theme_absent: bool,
    theme_body: Vec<u8>,
    /// What the change left the theme file as: `absent`, or a hash of the text it wrote.
    theme_after: Option<String>,
}

/// A short hash of file bytes, to tell whether a file is still what a change wrote. It is for
/// spotting edits, not for security (FNV-1a, 64 bits).
fn text_hash(b: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in b {
        h ^= u64::from(*byte);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The line that ends a history header. A header value is written as a JSON string, so no value
/// can ever be this exact line.
const MARK: &[u8] = b"# ---\n";

/// A header value as one safe line. Old files held the raw text; those still read.
fn unquote(v: &str) -> String {
    if v.starts_with('"') {
        if let Ok(s) = serde_json::from_str::<String>(v) {
            return s;
        }
    }
    v.to_string()
}

/// Splits a history file at the first line that is exactly `# ---`.
fn split_header(bytes: &[u8]) -> Option<(Vec<&[u8]>, usize)> {
    if !bytes.starts_with(b"# polycarp-history") {
        return None;
    }
    let mut lines = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let end = bytes[at..].iter().position(|b| *b == b'\n')? + at;
        let line = &bytes[at..end];
        at = end + 1;
        if line == &MARK[..MARK.len() - 1] {
            return Some((lines, at));
        }
        lines.push(line);
    }
    None
}

fn parse_hist(file: PathBuf, bytes: Vec<u8>) -> Hist {
    let mut h = Hist {
        file,
        valid: false,
        time: String::new(),
        caller: String::new(),
        action: String::new(),
        absent: false,
        body: Vec::new(),
        theme_name: None,
        theme_absent: false,
        theme_body: Vec::new(),
        theme_after: None,
    };
    let Some((head, body_at)) = split_header(&bytes) else {
        h.body = bytes;
        return h;
    };
    let (mut has_time, mut has_caller, mut has_action) = (false, false, false);
    let mut theme_bytes: Option<usize> = None;
    let mut sound = true;
    for raw in head {
        let line = String::from_utf8_lossy(raw);
        if let Some(v) = line.strip_prefix("# time = ") {
            has_time = true;
            h.time = v.into();
        } else if let Some(v) = line.strip_prefix("# caller = ") {
            has_caller = true;
            h.caller = unquote(v);
        } else if let Some(v) = line.strip_prefix("# action = ") {
            has_action = true;
            h.action = unquote(v);
        } else if line == "# absent = true" {
            h.absent = true;
        } else if let Some(v) = line.strip_prefix("# theme_file = ") {
            sound &= h.theme_name.is_none();
            h.theme_name = Some(v.into());
        } else if line == "# theme_file_absent = true" {
            h.theme_absent = true;
        } else if let Some(v) = line.strip_prefix("# theme_bytes = ") {
            // Digits only: a length that does not parse is damage, not zero.
            match v.parse::<usize>() {
                Ok(n) if theme_bytes.is_none() => theme_bytes = Some(n),
                _ => sound = false,
            }
        } else if let Some(v) = line.strip_prefix("# theme_after = ") {
            sound &= h.theme_after.is_none();
            h.theme_after = Some(v.into());
        }
    }
    let mut body = bytes[body_at..].to_vec();
    // A theme part needs a safe name, exactly one of "was there (with its length)" and "was not
    // there", and what the change left behind. Without a theme part none of those may appear.
    let theme_ok = match &h.theme_name {
        Some(name) => {
            valid_name(name)
                && !is_builtin(name)
                && h.theme_absent == theme_bytes.is_none()
                && h.theme_after
                    .as_deref()
                    .is_some_and(|a| a == "absent" || (a.len() == 16 && is_lower_hex(a)))
        }
        None => !h.theme_absent && theme_bytes.is_none() && h.theme_after.is_none(),
    };
    h.valid = sound
        && has_time
        && has_caller
        && has_action
        && theme_ok
        && theme_bytes.unwrap_or(0) <= body.len();
    if h.valid {
        if let Some(n) = theme_bytes {
            h.theme_body = body.split_off(body.len() - n);
        }
    }
    h.body = body;
    h
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
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

/// The file's bytes, None only when it does not exist. Any other failure is an error, so a
/// file that could not be read is never taken for one that was not there.
fn read_or_absent(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Keeps the current `config.toml` in `history/` before a change, and trims to the last 50.
/// With `theme` (name, and the text the change will write, or None if it deletes the file), the
/// user theme file of that name is kept too, so undo can put it back. A hash of the text written
/// is kept as well, so undo can tell if someone edited the file afterwards.
fn record(
    cfg: &Cfg,
    who: &str,
    action: &str,
    theme: Option<(&str, Option<&str>)>,
) -> Result<PathBuf, String> {
    let (compact, iso) = stamps();
    let current = read_or_absent(&cfg.file())?;
    let action: String = action.chars().filter(|c| !c.is_control()).collect();
    let mut data = format!(
        "# polycarp-history 1\n# time = {iso}\n# caller = {}\n# action = {}\n",
        json!(who),
        json!(action)
    )
    .into_bytes();
    if current.is_none() {
        data.extend_from_slice(b"# absent = true\n");
    }
    let mut theme_body = Vec::new();
    if let Some((name, after)) = theme {
        data.extend_from_slice(format!("# theme_file = {name}\n").as_bytes());
        let after = after.map_or("absent".to_string(), |t| text_hash(t.as_bytes()));
        data.extend_from_slice(format!("# theme_after = {after}\n").as_bytes());
        match read_or_absent(&cfg.theme_path(name))? {
            Some(b) => {
                data.extend_from_slice(format!("# theme_bytes = {}\n", b.len()).as_bytes());
                theme_body = b;
            }
            None => data.extend_from_slice(b"# theme_file_absent = true\n"),
        }
    }
    data.extend_from_slice(MARK);
    data.extend_from_slice(current.as_deref().unwrap_or(b""));
    data.extend_from_slice(&theme_body);

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
    let kept = dir.join(format!("{compact}-{same:03}-{safe}.toml"));
    write_atomic(&kept, &data)?;
    for old in read_history(cfg).into_iter().skip(HISTORY_KEEP) {
        let _ = fs::remove_file(old.file);
    }
    Ok(kept)
}

// ---------------------------------------------------------------------------------------------
// Results and errors. The command line and `polycarp mcp` both call the `op_*` functions below
// and get the same data back, so they cannot drift.
// ---------------------------------------------------------------------------------------------

/// What an operation returns: data for `--json` and MCP, text for a person.
pub(crate) struct Out {
    data: Json,
    text: String,
    warnings: Vec<String>,
    /// True when the warnings say the default theme is being used instead.
    fallback: bool,
    notes: Vec<String>,
}

impl Out {
    pub(crate) fn data(&self) -> &Json {
        &self.data
    }
    fn new(data: Json, text: impl Into<String>) -> Out {
        Out {
            data,
            text: text.into(),
            warnings: Vec::new(),
            fallback: false,
            notes: Vec::new(),
        }
    }
    fn warn(mut self, w: Vec<String>) -> Out {
        self.fallback |= !w.is_empty();
        self.warnings.extend(w);
        self
    }
    /// A warning that is not about falling back to the default theme.
    fn caution(mut self, w: String) -> Out {
        self.warnings.push(w);
        self
    }
    fn with(mut self, extra: Json) -> Out {
        if let (Some(d), Some(e)) = (self.data.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                d.insert(k.clone(), v.clone());
            }
        }
        self
    }
}

/// A refusal. `items` is what `--json` and MCP carry as `error.data.errors`.
pub(crate) struct ApiErr {
    exit: i32,
    code: &'static str,
    message: String,
    suggestion: Option<String>,
    items: Vec<Json>,
    lines: Vec<String>,
    usage: bool,
}

pub(crate) type Res = Result<Out, ApiErr>;
/// An envelope and whether it is a success.
pub(crate) type Envelope = (Json, bool);

fn item(path: &str, message: &str) -> Json {
    json!({"path": path, "message": message})
}

fn path_like(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Turns one problem string from the checker into `{path, message, actual?, needs?}`.
fn item_of(p: &str) -> Json {
    let mut rest = p;
    let mut surface: Option<String> = None;
    let mut within: Option<String> = None;
    loop {
        if let Some(r) = rest.strip_prefix("in ") {
            if let Some((ext, tail)) = r.split_once(": ") {
                if valid_name(ext) {
                    within = Some(ext.to_string());
                    rest = tail;
                    continue;
                }
            }
        }
        if let Some(r) = rest.strip_prefix("surface.") {
            if let Some((s, tail)) = r.split_once(": ") {
                if SURFACES.contains(&s) {
                    surface = Some(s.to_string());
                    rest = tail;
                    continue;
                }
            }
        }
        break;
    }
    let scoped = |path: &str| match &surface {
        Some(s) => format!("surface.{s}.{path}"),
        None => path.to_string(),
    };
    let contrast_item = || -> Option<Json> {
        let (fg, r) = rest.split_once(" on ")?;
        let (bg, r) = r.split_once(" is ")?;
        let (actual, needs) = r.split_once(", needs ")?;
        if !path_like(fg) || !path_like(bg) {
            return None;
        }
        Some(json!({
            "path": scoped(fg),
            "message": rest,
            "actual": actual.parse::<f64>().ok()?,
            "needs": needs.parse::<f64>().ok()?,
            "on": scoped(bg),
        }))
    };
    let mut it = if let Some(c) = contrast_item() {
        c
    } else if rest.starts_with("no theme named")
        || (rest.starts_with('"') && rest.contains(" is not a valid theme name"))
    {
        item("name", rest)
    } else if let Some((head, tail)) = rest.split_once(": ").filter(|(h, _)| path_like(h)) {
        item(&scoped(head), tail)
    } else {
        item("$", rest)
    };
    if let (Some(ext), Some(o)) = (within, it.as_object_mut()) {
        o.insert("in".into(), json!(ext));
    }
    it
}

fn is_contrast_item(i: &Json) -> bool {
    i.get("actual").is_some() && i.get("needs").is_some()
}

impl ApiErr {
    fn new(code: &'static str, message: impl Into<String>) -> ApiErr {
        let message = message.into();
        ApiErr {
            exit: 1,
            code,
            items: vec![item("$", &message)],
            message,
            suggestion: None,
            lines: Vec::new(),
            usage: false,
        }
    }
    /// A refusal that points at one path.
    fn at(code: &'static str, path: &str, message: impl Into<String>) -> ApiErr {
        let message = message.into();
        let mut e = ApiErr::new(code, message.clone());
        e.items = vec![item(path, &message)];
        e
    }
    pub(crate) fn usage(msg: impl Into<String>) -> ApiErr {
        let mut e = ApiErr::new("invalid_args", msg);
        e.exit = 2;
        e.usage = true;
        e
    }
    fn suggest(mut self, s: impl Into<String>) -> ApiErr {
        self.suggestion = Some(s.into());
        self
    }
    /// A list of problems from the checker. The code says what kind they are.
    fn problems(what: &str, problems: &[String]) -> ApiErr {
        let items: Vec<Json> = problems.iter().map(|p| item_of(p)).collect();
        let code = if !items.is_empty() && items.iter().all(is_contrast_item) {
            "contrast"
        } else if problems.len() == 1 && problems[0].starts_with("no theme named") {
            "unknown_theme"
        } else {
            "invalid_theme"
        };
        ApiErr {
            exit: 1,
            code,
            message: what.to_string(),
            suggestion: None,
            items,
            lines: problems.to_vec(),
            usage: false,
        }
    }
    fn human(&self) -> String {
        if self.usage {
            return format!(
                "polycarp: theme: {}\nRun `polycarp theme --help`.",
                self.message
            );
        }
        if self.lines.is_empty() {
            return format!("polycarp: {}", self.message);
        }
        let n = self.lines.len();
        let mut msg = format!(
            "polycarp: {} ({n} problem{}):",
            self.message,
            if n == 1 { "" } else { "s" }
        );
        for p in &self.lines {
            msg.push_str(&format!("\n  {p}"));
        }
        msg
    }
    /// The envelope's `retry` value (`spaces/spec/envelope.md`): `after` means nothing was
    /// written and the same call can be sent again once the wait is over.
    fn retry(&self) -> &'static str {
        if self.code == "busy" {
            "after"
        } else {
            "never"
        }
    }
    fn suggestion(&self) -> String {
        if let Some(s) = &self.suggestion {
            return s.clone();
        }
        match self.code {
            "invalid_args" => "Check the arguments against `polycarp theme --help` or the tool's input schema.",
            "invalid_theme" => "Fix each path in `errors` and send the whole theme again. `theme schema` lists every field, range and enum.",
            "contrast" => "Pick colors that read better. Each error gives `actual` and `needs`. Do not try to get around the rule.",
            "unknown_theme" => "Run `theme list` for the names you can use.",
            "builtin_read_only" => "Built-in themes cannot be replaced. Use `theme change` (it makes a -custom copy), or apply under a new name.",
            "unknown_path" => "Run `theme schema` and read x-paths for the valid paths.",
            "invalid_value" => "Send a value of the type in `needs`.",
            "exists" => "Pick another name, or pass force.",
            "current_theme" => "Run `theme set <other>` first.",
            "changed_since" => "Look at the theme file named in the message. To undo anyway, run `theme undo --force` (MCP: theme_undo with force true); if the file is still there, its text is first saved in history/ as a .bak copy. Or leave it as it is.",
            "nothing_to_undo" => "History is empty. `theme reset` goes back to the default.",
            "not_yours" => "Ask the person first. If they agree, call again with force true.",
            "busy" => "Wait a moment and run the command again. The lock is released when the other polycarp command ends, so there is nothing to delete.",
            "io_error" => "Check that the config folder is writable, then try again.",
            "config_error" => "Set POLYCARP_CONFIG_DIR to an absolute path of a folder you can write.",
            _ => "",
        }
        .to_string()
    }
}

fn io_err(msg: String) -> ApiErr {
    ApiErr::new("io_error", msg)
}

fn pretty(v: &Json) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// The envelope in `spaces/spec/envelope.md`, for a success.
pub(crate) fn envelope_ok(out: &Out) -> Json {
    let mut data = out.data.clone();
    if let Some(o) = data.as_object_mut() {
        if !out.warnings.is_empty() {
            o.insert("warnings".into(), json!(out.warnings));
        }
        if !out.notes.is_empty() {
            o.insert("notes".into(), json!(out.notes));
        }
    }
    json!({"ok": true, "data": data})
}

/// The envelope for a refusal. `error.data.errors` is `[{path, message, actual?, needs?}]`.
pub(crate) fn envelope_err(e: &ApiErr) -> Json {
    json!({"ok": false, "error": {
        "code": e.code,
        "message": e.message,
        "retry": e.retry(),
        "suggestion": e.suggestion(),
        "data": {"errors": e.items},
    }})
}

/// Either result as an envelope, and whether it was a success.
pub(crate) fn envelope(r: &Res) -> Envelope {
    match r {
        Ok(o) => (envelope_ok(o), true),
        Err(e) => (envelope_err(e), false),
    }
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

pub(crate) struct Ctx {
    cfg: Cfg,
    caller: String,
}

impl Ctx {
    pub(crate) fn new(caller: &str) -> Result<Ctx, ApiErr> {
        let cfg = Cfg::from_env().map_err(|e| ApiErr::new("config_error", e))?;
        Ok(Ctx {
            cfg,
            caller: clean_caller(caller),
        })
    }
}

fn mode_ok(m: &str) -> bool {
    matches!(m, "auto" | "light" | "dark")
}

fn bad_theme(what: &str, ps: &[String]) -> ApiErr {
    ApiErr::problems(what, ps)
}

pub(crate) fn op_list(c: &Ctx) -> Res {
    let eff = effective(&c.cfg);
    let list = entries(&c.cfg);
    let mut text = String::new();
    let mut arr = Vec::new();
    for e in &list {
        let cur = e.name == eff.state.theme;
        let mark = if cur { "*" } else { " " };
        let tail = match &e.title {
            Some(t) => t.clone(),
            None => format!(
                "(invalid: {} problem(s); run `polycarp theme validate`)",
                e.problems.len()
            ),
        };
        text.push_str(&format!("{mark} {:<16} {:<9} {tail}\n", e.name, e.source));
        arr.push(json!({
            "name": e.name,
            "source": e.source,
            "title": e.title,
            "current": cur,
            "valid": e.problems.is_empty(),
            "problems": e.problems,
        }));
    }
    Ok(Out::new(json!({"themes": arr, "current": eff.state.theme}), text).warn(eff.problems))
}

fn resolve_for_view(cfg: &Cfg, name: Option<&str>) -> Result<(Full, Vec<String>), ApiErr> {
    match name {
        Some(n) => {
            let f = resolve_name(cfg, n)
                .map_err(|p| bad_theme(&format!("theme {n:?} cannot be used"), &p))?;
            Ok((f, vec![]))
        }
        None => {
            let eff = effective(cfg);
            Ok((eff.full, eff.problems))
        }
    }
}

pub(crate) fn op_show(c: &Ctx, name: Option<&str>) -> Res {
    let (full, problems) = resolve_for_view(&c.cfg, name)?;
    // As authored here: durations are not zeroed; the exports zero them.
    let mut v = theme_json(&full, None);
    if let Some(o) = v.as_object_mut() {
        let mut s = serde_json::Map::new();
        for n in SURFACES {
            s.insert(n.to_string(), json_of(full.surface(n)));
        }
        o.insert("surfaces".into(), Json::Object(s));
    }
    let mut t = Value::try_from(&full.base)
        .ok()
        .and_then(|v| v.as_table().cloned())
        .unwrap_or_default();
    t.insert("name".into(), Value::String(full.name.clone()));
    t.insert("title".into(), Value::String(full.title.clone()));
    if let Some(d) = &full.description {
        t.insert("description".into(), Value::String(d.clone()));
    }
    let mut text = toml::to_string(&t).unwrap_or_default();
    for s in SURFACES {
        if full.surface(s) != &full.base {
            text.push_str(&format!(
                "# surface {s} overrides some of the values above\n"
            ));
        }
    }
    Ok(Out::new(v, text).warn(problems))
}

pub(crate) fn op_current(c: &Ctx) -> Res {
    let eff = effective(&c.cfg);
    let source = if is_builtin(&eff.state.theme) {
        "built-in"
    } else {
        "user"
    };
    let text = format!(
        "state: {}\ntheme: {} ({source})\nmode: {}\naccent_light: {}\naccent_dark: {}\nconfig: {}\nfolder: {}\n",
        if eff.state.enabled { "on" } else { "off" },
        eff.state.theme,
        eff.state.mode,
        eff.state.accent_light.as_deref().unwrap_or("none"),
        eff.state.accent_dark.as_deref().unwrap_or("none"),
        c.cfg.file().display(),
        c.cfg.dir.display()
    );
    let data = json!({
        "enabled": eff.state.enabled,
        "theme": eff.state.theme,
        "title": eff.full.title,
        "source": source,
        "mode": eff.state.mode,
        "accent_light": eff.state.accent_light,
        "accent_dark": eff.state.accent_dark,
        "config": c.cfg.file().display().to_string(),
        "folder": c.cfg.dir.display().to_string(),
        "problems": eff.problems,
        "fell_back": !eff.problems.is_empty(),
    });
    Ok(Out::new(data, text).warn(eff.problems))
}

// --- paths ----------------------------------------------------------------------------------

enum Target {
    Meta(&'static str),
    Field {
        surface: Option<String>,
        section: &'static str,
        key: &'static str,
        kind: Kind,
    },
}

fn path_hint(section: Option<&str>) -> String {
    match section {
        Some(s) => format!(
            "valid keys in {s}: {}",
            fields(s)
                .iter()
                .map(|(k, _)| *k)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        None => format!(
            "valid paths look like {}, {}, surface.<{}>.<section>.<key>, or title, description; sections: {}",
            "dark.accent",
            "shape.radius",
            SURFACES.join("|"),
            SECTIONS.join(", ")
        ),
    }
}

fn parse_target(path: &str) -> Result<Target, ApiErr> {
    let segs: Vec<&str> = path.split('.').collect();
    let unknown = |msg: String, hint: String| ApiErr::at("unknown_path", path, msg).suggest(hint);
    let (surface, rest): (Option<String>, &[&str]) = if segs.first() == Some(&"surface") {
        match segs.get(1) {
            Some(s) if SURFACES.contains(s) => (Some((*s).to_string()), &segs[2..]),
            _ => {
                return Err(unknown(
                    format!(
                        "{path}: needs a product after surface (one of {})",
                        SURFACES.join(", ")
                    ),
                    path_hint(None),
                ))
            }
        }
    } else {
        (None, &segs[..])
    };
    match rest {
        ["title"] if surface.is_none() => Ok(Target::Meta("title")),
        ["description"] if surface.is_none() => Ok(Target::Meta("description")),
        [sec, key] => {
            let Some(section) = SECTIONS.iter().find(|s| *s == sec) else {
                return Err(unknown(
                    format!("{path}: {sec:?} is not a section"),
                    path_hint(None),
                ));
            };
            match fields(section).into_iter().find(|(k, _)| k == key) {
                Some((k, kind)) => Ok(Target::Field {
                    surface,
                    section,
                    key: k,
                    kind,
                }),
                None => Err(unknown(
                    format!("{path}: {key:?} is not a field of {section}"),
                    path_hint(Some(section)),
                )),
            }
        }
        _ => Err(unknown(
            format!("{path}: does not name one value"),
            path_hint(None),
        )),
    }
}

/// Turns what the caller sent into the TOML value the path needs, or says what was wrong.
fn coerce(path: &str, target: &Target, v: &Json) -> Result<Value, ApiErr> {
    let bad = |needs: String| {
        let mut e = ApiErr::at(
            "invalid_value",
            path,
            format!("{path}: {} is not {needs}", compact(v)),
        );
        e.items = vec![json!({"path": path, "message": e.message, "actual": v, "needs": needs})];
        e
    };
    let text_of = |v: &Json| v.as_str().map(str::to_string);
    match target {
        Target::Meta(which) => match text_of(v) {
            Some(s) if *which == "title" && s.trim().is_empty() => {
                Err(bad("a title that is not empty".into()))
            }
            Some(s) => Ok(Value::String(s)),
            None => Err(bad("text".into())),
        },
        Target::Field { kind, .. } => {
            let needs = schema::needs(*kind);
            match kind {
                Kind::Hex | Kind::Enum(_) | Kind::Font | Kind::Easing => match text_of(v) {
                    Some(s) => Ok(Value::String(if matches!(kind, Kind::Hex) {
                        s.to_lowercase()
                    } else {
                        s
                    })),
                    None => Err(bad(needs)),
                },
                Kind::Int(..) => match v {
                    Json::Number(n) => n.as_i64().map(Value::Integer).ok_or_else(|| bad(needs)),
                    Json::String(s) => s
                        .trim()
                        .parse::<i64>()
                        .map(Value::Integer)
                        .map_err(|_| bad(needs)),
                    _ => Err(bad(needs)),
                },
                Kind::Float(..) => match v {
                    Json::Number(n) => n.as_f64().map(Value::Float).ok_or_else(|| bad(needs)),
                    Json::String(s) => s
                        .trim()
                        .parse::<f64>()
                        .ok()
                        .filter(|f| f.is_finite())
                        .map(Value::Float)
                        .ok_or_else(|| bad(needs)),
                    _ => Err(bad(needs)),
                },
                Kind::Bool => match v {
                    Json::Bool(b) => Ok(Value::Boolean(*b)),
                    Json::String(s) if s == "true" || s == "false" => {
                        Ok(Value::Boolean(s == "true"))
                    }
                    _ => Err(bad(needs)),
                },
            }
        }
    }
}

fn compact(v: &Json) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// The value at a dotted path in a resolved theme, as JSON.
fn lookup(full: &Full, path: &str) -> Result<Json, ApiErr> {
    match path {
        "name" => return Ok(json!(full.name)),
        "title" => return Ok(json!(full.title)),
        "description" => return Ok(json!(full.description)),
        _ => {}
    }
    let segs: Vec<&str> = path.split('.').collect();
    let (resolved, rest): (&Resolved, &[&str]) = if segs.first() == Some(&"surface") {
        match segs.get(1) {
            Some(s) if SURFACES.contains(s) => (full.surface(s), &segs[2..]),
            _ => {
                return Err(ApiErr::at(
                    "unknown_path",
                    path,
                    format!(
                        "{path}: needs a product after surface (one of {})",
                        SURFACES.join(", ")
                    ),
                )
                .suggest(path_hint(None)))
            }
        }
    } else {
        (&full.base, &segs[..])
    };
    let mut v = json_of(resolved);
    let mut at = String::new();
    for seg in rest {
        let next = v.get(*seg).cloned();
        match next {
            Some(n) => {
                v = n;
                at = if at.is_empty() {
                    seg.to_string()
                } else {
                    format!("{at}.{seg}")
                };
            }
            None => {
                let sec = at.split('.').next().filter(|s| SECTIONS.contains(s));
                return Err(ApiErr::at(
                    "unknown_path",
                    path,
                    format!("{path}: {seg:?} is not a field here"),
                )
                .suggest(path_hint(if at.is_empty() { None } else { sec })));
            }
        }
    }
    Ok(v)
}

pub(crate) fn op_get(c: &Ctx, path: &str, name: Option<&str>) -> Res {
    let (full, problems) = resolve_for_view(&c.cfg, name)?;
    let value = lookup(&full, path)?;
    let text = match &value {
        Json::String(s) => format!("{s}\n"),
        Json::Null => "null\n".to_string(),
        Json::Object(_) | Json::Array(_) => format!("{}\n", pretty(&value)),
        other => format!("{other}\n"),
    };
    let needs = match parse_target(path) {
        Ok(Target::Field { kind, .. }) => json!(schema::needs(kind)),
        _ => Json::Null,
    };
    Ok(Out::new(
        json!({"path": path, "value": value, "theme": full.name, "needs": needs}),
        text,
    )
    .warn(problems))
}

// --- state changes --------------------------------------------------------------------------

/// Writes the files for whatever state is now in force, and says what is in force.
fn finish(cfg: &Cfg) -> Res {
    finish_with(cfg, false)
}

/// With `soft`, a failure to write the files in `current/` is a warning, not an error.
fn finish_with(cfg: &Cfg, soft: bool) -> Res {
    let eff = effective(cfg);
    let mut late = None;
    let (wrote, failed) = write_outputs(cfg, &eff);
    if !failed.is_empty() {
        if soft {
            late = Some(format!(
                "the settings are saved, but the files in current/ were not refreshed: {}",
                failed.join("; ")
            ));
        } else {
            return Err(io_err(failed.join("; ")));
        }
    }
    Ok(summary(cfg, eff, wrote, late))
}

/// What is in force, as a result. `wrote` is the files written (none for a no-op).
fn summary(cfg: &Cfg, eff: Eff, wrote: Vec<PathBuf>, late: Option<String>) -> Out {
    summary_with(cfg, eff, wrote, late, true)
}

/// `config_written` is false for a result that changed no settings, so it claims no write.
fn summary_with(
    cfg: &Cfg,
    eff: Eff,
    wrote: Vec<PathBuf>,
    late: Option<String>,
    config_written: bool,
) -> Out {
    let off = !eff.state.enabled;
    // Off keeps the chosen theme even if it can't be built now, so show the settings' own.
    let shown = if off {
        match load_state(cfg) {
            (st, p) if p.is_empty() => st,
            _ => eff.state.clone(),
        }
    } else {
        eff.state.clone()
    };
    let left = if off {
        remaining_theme_files(cfg)
    } else {
        Vec::new()
    };
    let mut text = if off && !left.is_empty() {
        format!(
            "the theme is off in the settings, but these files remain and apps may still read them: {}\nlast theme: {}\nmode: {}\n",
            left.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "),
            shown.theme,
            shown.mode
        )
    } else if off {
        format!(
            "the theme is off\n{OFF_NOTE}\nlast theme: {}\nmode: {}\n",
            shown.theme, shown.mode
        )
    } else {
        format!("theme: {}\nmode: {}\n", eff.state.theme, eff.state.mode)
    };
    if eff.state.accent_light.is_some() || eff.state.accent_dark.is_some() {
        text.push_str(&format!(
            "accent: light {}, dark {}\n",
            eff.state.accent_light.as_deref().unwrap_or("theme's own"),
            eff.state.accent_dark.as_deref().unwrap_or("theme's own")
        ));
    }
    if config_written {
        text.push_str(&format!("wrote {}\n", cfg.file().display()));
    }
    if off && wrote.is_empty() && left.is_empty() {
        text.push_str("no theme files were in current/\n");
    }
    for w in &wrote {
        text.push_str(&format!(
            "{} {}\n",
            if off { "removed" } else { "wrote" },
            w.display()
        ));
    }
    if off {
        text.push_str("run `polycarp theme on` to bring the theme back\n");
    } else {
        text.push_str(NOTE);
        text.push('\n');
    }
    let data = json!({
        "enabled": eff.state.enabled,
        "theme": shown.theme,
        "mode": shown.mode,
        "accent_light": shown.accent_light,
        "accent_dark": shown.accent_dark,
        "remaining": left.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        "config": cfg.file().display().to_string(),
        "wrote": if off { Vec::new() } else { wrote.iter().map(|w| w.display().to_string()).collect::<Vec<_>>() },
        "removed": if off { wrote.iter().map(|w| w.display().to_string()).collect::<Vec<_>>() } else { Vec::new() },
        "note": match (off, left.is_empty()) {
            (false, _) => NOTE,
            (true, true) => OFF_NOTE,
            (true, false) => OFF_LEFT_NOTE,
        },
        "next": if off {
            "Run theme on, or theme undo, to bring the theme back."
        } else {
            "Look at it with theme preview. If the person dislikes it, run theme undo."
        },
    });
    let out = Out::new(data, text).warn(eff.problems);
    match late {
        Some(w) => out.caution(w),
        None => out,
    }
}

/// A theme and the themes it extends, nearest first. Stops quietly at anything unreadable.
fn chain_names(cfg: &Cfg, start: &str) -> Vec<String> {
    let mut out = vec![start.to_string()];
    let mut at = start.to_string();
    while out.len() <= MAX_DEPTH {
        let Some(next) = load_raw(cfg, &at).ok().as_ref().and_then(ext_of) else {
            break;
        };
        if out.contains(&next) {
            break;
        }
        out.push(next.clone());
        at = next;
    }
    out
}

/// Refuses a change to theme `name` (new text `text`) if the current settings use it, directly
/// or as a parent, and would stop building with the new text.
fn keep_current_building(c: &Ctx, name: &str, text: &str) -> Result<(), ApiErr> {
    let (st, problems) = load_state(&c.cfg);
    if !problems.is_empty() || !chain_names(&c.cfg, &st.theme).iter().any(|n| n == name) {
        return Ok(());
    }
    build_full(&c.cfg.with_overlay(name, text), &st).map(|_| ()).map_err(|ps| {
        bad_theme(
            &format!(
                "{name:?} is part of the current theme {:?}, which would stop working with this change, so nothing changed",
                st.theme
            ),
            &ps,
        )
    })
}

/// Refuses to go on when the settings in force are not the ones in the files, so a change would
/// quietly replace them with the default theme.
fn require_healthy(eff: &Eff) -> Result<(), ApiErr> {
    if eff.problems.is_empty() {
        return Ok(());
    }
    Err(bad_theme(
        "the current settings are broken, so nothing was changed (the default theme is in use)",
        &eff.problems,
    )
    .suggest("Fix the file named in the errors, or run `polycarp theme reset` to start again from the default. `theme set <name>` also works."))
}

/// Records the old files for undo, writes a theme file if given, writes the state if given,
/// then writes the outputs. `file` is (theme name, full text), or (theme name, None) to delete it.
///
/// If the theme file or `config.toml` cannot be written, whatever was changed is put back, the
/// history entry is dropped and the error is returned. Once the settings are saved, a failure in
/// `current/` is only a warning that says which files were not written.
fn commit(c: &Ctx, st: Option<&State>, action: &str, file: Option<(&str, Option<&str>)>) -> Res {
    let theme_was = match file {
        Some((name, _)) => {
            let p = c.cfg.theme_path(name);
            let was = read_or_absent(&p).map_err(io_err)?;
            Some((p, was))
        }
        None => None,
    };
    let config_was = read_or_absent(&c.cfg.file()).map_err(io_err)?;
    // Nothing would change: do not record, do not write, so history stays accurate.
    let new_config = st.map(|st| state_table(&c.cfg, st).into_bytes());
    let theme_same = match (&theme_was, file) {
        (Some((_, was)), Some((_, Some(text)))) => was.as_deref() == Some(text.as_bytes()),
        (Some((_, was)), Some((_, None))) => was.is_none(),
        _ => true,
    };
    let config_same = new_config
        .as_ref()
        .is_none_or(|n| config_was.as_deref() == Some(n.as_slice()));
    if theme_same && config_same {
        let mut out = summary(&c.cfg, effective(&c.cfg), Vec::new(), None);
        out.text = format!("nothing to change: that is already how it is\n{}", out.text);
        out.notes.push(
            "nothing changed, so nothing was recorded in history or written to current/".into(),
        );
        return Ok(out.with(json!({"changed": false})));
    }
    let kept = record(&c.cfg, &c.caller, action, file).map_err(io_err)?;
    let undo_all = |why: String| {
        if let Some((p, was)) = &theme_was {
            put_back(p, was);
        }
        put_back(&c.cfg.file(), &config_was);
        let _ = fs::remove_file(&kept);
        io_err(format!("{why}. Nothing was changed"))
    };
    match file {
        Some((name, Some(text))) => {
            write_atomic(&c.cfg.theme_path(name), text.as_bytes()).map_err(undo_all)?
        }
        Some((name, None)) => {
            let p = c.cfg.theme_path(name);
            fs::remove_file(&p)
                .map_err(|e| undo_all(format!("could not delete {}: {e}", p.display())))?;
        }
        None => {}
    }
    if let Some(new) = &new_config {
        write_atomic(&c.cfg.file(), new).map_err(undo_all)?;
    }
    finish_with(&c.cfg, true)
}

/// A change that picks a theme also turns a theme that was off back on, and says so.
fn turn_on(st: &mut State, notes: &mut Vec<String>) {
    if !st.enabled {
        st.enabled = true;
        notes.push(
            "the theme was off; this change turned it on, so the apps use it again".to_string(),
        );
    }
}

/// Removes `current/theme.json` and the css files. The choice is
/// kept in `config.toml` as `enabled = false`, recorded in history, so `undo` and `on` restore it.
/// It works even when the theme or `config.toml` is broken: removing files needs no valid theme.
pub(crate) fn op_off(c: &Ctx) -> Res {
    set_enabled(c, false)
}

/// Turns the last theme back on and writes `current/` again. Plain files are written, whatever
/// was there before (a link that `off` removed is not remembered).
pub(crate) fn op_on(c: &Ctx) -> Res {
    omarchy::with_default(c, || {
        let out = set_enabled(c, true)?;
        Ok(omarchy::reconcile(c, out))
    })
}

fn set_enabled(c: &Ctx, want: bool) -> Res {
    let word = if want { "on" } else { "off" };
    let _lock = Lock::acquire(&c.cfg)?;
    let mut warnings = Vec::new();
    if want {
        require_healthy(&effective(&c.cfg))?;
    } else if let Some(aside) = move_config_dir_aside(&c.cfg)? {
        warnings.push(format!(
            "{} was a folder, not a file. It was moved to {}",
            c.cfg.file().display(),
            aside.display()
        ));
    }
    let (mut st, state_problems) = load_state(&c.cfg);
    let mut out = if st.enabled == want && state_problems.is_empty() {
        // The settings already say so. Still bring current/ into line with them, in case a file
        // was left behind, put back or never written. Nothing is recorded in history.
        let eff = effective(&c.cfg);
        let (done, failed) = write_outputs(&c.cfg, &eff);
        if !failed.is_empty() {
            return Err(io_err(format!(
                "the theme is already {word}, but current/ could not be brought into line: {}",
                failed.join("; ")
            )));
        }
        let mut out = summary_with(&c.cfg, eff, done, None, false);
        out.text = format!(
            "nothing to change in the settings: the theme is already {word}\n{}",
            out.text
        );
        out.with(json!({"changed": false}))
    } else {
        let mut notes = Vec::new();
        if !state_problems.is_empty() {
            notes.push(format!(
                "the old settings were invalid and are replaced (the old file is kept in history): {}",
                state_problems.join("; ")
            ));
        }
        st.enabled = want;
        let mut out = commit(c, Some(&st), &format!("theme {word}"), None)?;
        let left = remaining_theme_files(&c.cfg);
        out.notes.splice(0..0, notes);
        if !want && !left.is_empty() {
            // The settings and history have changed, so say everything that happened.
            let removed = out.data["removed"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Json::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let mut said = format!(
                "the settings now say the theme is off, but these files could not be removed, so apps may still read them: {}.",
                left.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
            );
            if !removed.is_empty() {
                said.push_str(&format!(" Removed: {removed}."));
            }
            for n in out.notes.iter().chain(warnings.iter()) {
                said.push_str(&format!(" Also: {n}."));
            }
            return Err(io_err(said));
        }
        out.with(json!({"changed": true}))
    };
    for w in warnings {
        out = out.caution(w);
    }
    Ok(out)
}

/// A folder where config.toml should be is moved aside, not deleted. Returns where it went.
fn move_config_dir_aside(cfg: &Cfg) -> Result<Option<PathBuf>, ApiErr> {
    let cfg_file = cfg.file();
    if !fs::metadata(&cfg_file).is_ok_and(|m| m.is_dir()) {
        return Ok(None);
    }
    let (compact, _) = stamps();
    let mut n = 0;
    let aside = loop {
        let p = cfg.dir.join(format!("config.toml.moved-{compact}-{n}"));
        if fs::symlink_metadata(&p).is_err() {
            break p;
        }
        n += 1;
    };
    fs::rename(&cfg_file, &aside).map_err(|e| {
        io_err(format!(
            "{} is a folder and could not be moved aside: {e}",
            cfg_file.display()
        ))
    })?;
    Ok(Some(aside))
}

pub(crate) fn op_set(c: &Ctx, name: &str, mode: Option<&str>) -> Res {
    if let Some(m) = mode {
        if !mode_ok(m) {
            return Err(ApiErr::usage("--mode must be auto, light or dark"));
        }
    }
    let (alias, alias_note) = omarchy::alias_set(c, name);
    let name = alias.as_str();
    let _lock = Lock::acquire(&c.cfg)?;
    let full = resolve_name(&c.cfg, name)
        .map_err(|ps| bad_theme(&format!("theme {name:?} cannot be used"), &ps))?;
    let (mut st, old_problems) = load_state(&c.cfg);
    let mut notes: Vec<String> = alias_note.into_iter().collect();
    if !old_problems.is_empty() {
        notes.push(format!(
            "the old settings were invalid and are replaced: {}",
            old_problems.join("; ")
        ));
    }
    if let Some(m) = mode {
        st.mode = m.to_string();
    }
    st.theme = name.to_string();
    omarchy::note_mode(&mut st, name, mode, &mut notes);
    let stopped = omarchy::stop_for_switch(&mut st, name, mode, &mut notes);
    turn_on(&mut st, &mut notes);
    if apply_accents(&full, st.accent_light.as_deref(), st.accent_dark.as_deref()).is_err() {
        notes.push(format!(
            "your accent override does not read well on {name}, so it is cleared"
        ));
        st.accent_light = None;
        st.accent_dark = None;
    }
    let mut out = commit(c, Some(&st), &format!("theme set {name}"), None)?;
    out.notes.splice(0..0, notes);
    drop(_lock);
    if stopped.is_some() || !old_problems.is_empty() {
        out = omarchy::after_stop(c, out, stopped);
    }
    Ok(out)
}

pub(crate) fn op_accent(c: &Ctx, color: Option<&str>, mode: Option<&str>) -> Res {
    if !matches!(mode, None | Some("auto" | "both" | "light" | "dark")) {
        return Err(ApiErr::usage("--mode must be light or dark"));
    }
    if let Some(col) = color.filter(|x| !is_hex(x)) {
        return Err(ApiErr::at(
            "invalid_value",
            "color",
            format!("{col:?} is not a color like #rrggbb"),
        ));
    }
    omarchy::with_default(c, || accent_inner(c, color, mode))
}

fn accent_inner(c: &Ctx, color: Option<&str>, mode: Option<&str>) -> Res {
    let both = ["light", "dark"];
    let modes: Vec<&str> = match mode {
        None | Some("auto") | Some("both") => both.to_vec(),
        Some("light") => vec!["light"],
        Some("dark") => vec!["dark"],
        Some(_) => return Err(ApiErr::usage("--mode must be light or dark")),
    };
    let new = match color {
        None => None,
        Some(c) if is_hex(c) => Some(c.to_lowercase()),
        Some(c) => {
            return Err(ApiErr::at(
                "invalid_value",
                "color",
                format!("{c:?} is not a color like #rrggbb"),
            ))
        }
    };
    let _lock = Lock::acquire(&c.cfg)?;
    let eff = effective(&c.cfg);
    require_healthy(&eff)?;
    let mut st = eff.state.clone();
    let mut turned_on = Vec::new();
    turn_on(&mut st, &mut turned_on);
    let mut adjusted = serde_json::Map::new();
    for m in &modes {
        let set = |st: &mut State, value: Option<String>| {
            if *m == "light" {
                st.accent_light = value;
            } else {
                st.accent_dark = value;
            }
        };
        set(&mut st, new.clone());
        // One color seldom reads on both a light and a dark background. With no --mode, keep the
        // color where it reads and move it the smallest step toward readable where it doesn't.
        if let (Some(color), true) = (&new, modes.len() == 2) {
            if build_full(&c.cfg, &st).is_err() {
                let target = if *m == "light" { "#000000" } else { "#ffffff" };
                let found = (1..=50)
                    .map(|step| mix(color, target, f64::from(step) * 0.02))
                    .find(|candidate| {
                        let mut trial = st.clone();
                        if *m == "light" {
                            trial.accent_light = Some(candidate.clone());
                        } else {
                            trial.accent_dark = Some(candidate.clone());
                        }
                        build_full(&c.cfg, &trial).is_ok()
                    });
                if let Some(found) = found {
                    adjusted.insert((*m).to_string(), json!(found));
                    set(&mut st, Some(found));
                }
            }
        }
    }
    build_full(&c.cfg, &st).map_err(|ps| {
        bad_theme(
            &format!(
                "accent {} is refused, nothing changed",
                new.as_deref().unwrap_or("")
            ),
            &ps,
        )
    })?;
    let action = match &new {
        Some(c) => format!("theme accent {c}"),
        None => "theme accent --clear".to_string(),
    };
    omarchy::accept(&mut st, modes.iter().map(|m| format!("accent.{m}")));
    let mut done = commit(c, Some(&st), &action, None)?;
    done.notes.splice(0..0, turned_on);
    if !adjusted.is_empty() {
        let says = adjusted
            .iter()
            .map(|(mode, color)| {
                format!(
                    "{mode} uses {} to stay readable",
                    color.as_str().unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        done.notes.push(says);
    }
    Ok(done)
}

/// Blends `from` toward `to` in sRGB. `amount` 0.0 keeps `from`, 1.0 gives `to`.
fn mix(from: &str, to: &str, amount: f64) -> String {
    let channel =
        |hex: &str, at: usize| f64::from(u8::from_str_radix(&hex[at..at + 2], 16).unwrap_or(0));
    let blend = |at: usize| {
        (channel(from, at) + (channel(to, at) - channel(from, at)) * amount).round() as u8
    };
    format!("#{:02x}{:02x}{:02x}", blend(1), blend(3), blend(5))
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

pub(crate) fn op_create(c: &Ctx, name: &str, base_name: &str, force: bool) -> Res {
    if !valid_name(name) {
        return Err(ApiErr::at(
            "invalid_theme",
            "name",
            format!("{name:?} is not a valid theme name (lowercase letters, digits and hyphens)"),
        ));
    }
    if is_builtin(name) {
        return Err(ApiErr::at(
            "builtin_read_only",
            "name",
            format!("{name:?} is a built-in theme name; pick another"),
        ));
    }
    if chain_names(&c.cfg, base_name).iter().any(|n| n == name) {
        return Err(ApiErr::at(
            "invalid_theme",
            "extends",
            if base_name == name {
                format!("{name:?} cannot extend itself")
            } else {
                format!("{base_name:?} already extends {name:?}, so {name:?} cannot extend it back")
            },
        ));
    }
    let _lock = Lock::acquire(&c.cfg)?;
    let base = resolve_name(&c.cfg, base_name)
        .map_err(|ps| bad_theme(&format!("cannot extend {base_name:?}"), &ps))?;
    let path = c.cfg.theme_path(name);
    if path.exists() && !force {
        return Err(ApiErr::at(
            "exists",
            "name",
            format!(
                "{} already exists; use --force to overwrite it",
                path.display()
            ),
        ));
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
    // The new theme must load before anything is recorded or written, so `create` cannot leave
    // a theme that fails (for example one that extends too deep a chain).
    resolve_name(&c.cfg.with_overlay(name, &s), name)
        .map_err(|ps| bad_theme(&format!("theme {name:?} would not load"), &ps))?;
    keep_current_building(c, name, &s)?;
    let mut out = commit(
        c,
        None,
        &format!("theme create {name}"),
        Some((name, Some(&s))),
    )?;
    out.text = format!(
        "created {}\nIt extends {base_name}. Edit it, then run `polycarp theme validate` on it.\n{}",
        path.display(),
        out.text
    );
    Ok(out.with(json!({"name": name, "extends": base_name, "path": path.display().to_string()})))
}

/// True when `name` is a user theme with a file on disk (not a built-in).
pub(crate) fn user_theme_exists(c: &Ctx, name: &str) -> bool {
    valid_name(name) && !is_builtin(name) && c.cfg.theme_path(name).is_file()
}

/// An agent asked to remove or replace a user theme it did not make in this session.
pub(crate) fn not_yours(name: &str, what: &str) -> ApiErr {
    ApiErr::at(
        "not_yours",
        "name",
        format!("{name:?} is a user theme this session did not make, so it was not {what}"),
    )
    .suggest(
        "Ask the person first. If they agree, call again with force true. To work on a copy instead, theme_create a new theme that extends it.",
    )
}

fn user_theme_name(name: &str) -> Result<(), ApiErr> {
    if !valid_name(name) {
        return Err(ApiErr::at(
            "invalid_theme",
            "name",
            format!("{name:?} is not a valid theme name"),
        ));
    }
    Ok(())
}

pub(crate) fn op_edit_path(c: &Ctx, name: &str) -> Res {
    user_theme_name(name)?;
    if is_builtin(name) {
        return Err(ApiErr::at(
            "builtin_read_only",
            "name",
            format!(
                "{name:?} is built in and cannot be edited; run `polycarp theme create <name> --extends {name}`"
            ),
        ));
    }
    let p = c.cfg.theme_path(name).display().to_string();
    Ok(Out::new(json!({"name": name, "path": p}), format!("{p}\n")))
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

/// The user themes that extend `name`, and the theme files that could not be read or parsed
/// (they might extend it). Only a folder that can't be listed is an error.
fn dependents_of(cfg: &Cfg, name: &str) -> Result<(Vec<String>, Vec<String>), ApiErr> {
    let dir = cfg.themes();
    let no_list = |e: std::io::Error| {
        io_err(format!(
            "could not read {}, so it is not known whether another theme extends {name:?}: {e}",
            dir.display()
        ))
    };
    let rd = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), Vec::new())),
        Err(e) => return Err(no_list(e)),
    };
    let (mut found, mut unreadable) = (Vec::new(), Vec::new());
    for entry in rd {
        let entry = entry.map_err(no_list)?;
        let file = entry.file_name().to_string_lossy().into_owned();
        let Some(other) = file.strip_suffix(".toml") else {
            continue;
        };
        if other == name || !valid_name(other) || is_builtin(other) {
            continue;
        }
        match load_raw(cfg, other) {
            Ok(t) if ext_of(&t).as_deref() == Some(name) => found.push(other.to_string()),
            Ok(_) => {}
            Err(e) => unreadable.push(format!("{} ({e})", entry.path().display())),
        }
    }
    found.sort();
    unreadable.sort();
    Ok((found, unreadable))
}

/// True only when the theme's file was read fine and its text does not parse. A file that can't
/// be read is not this.
fn unparsable(cfg: &Cfg, name: &str) -> bool {
    fs::read_to_string(cfg.theme_path(name)).is_ok_and(|text| parse_toml(&text).is_err())
}

/// Refuses to remove theme `name` while another theme extends it. A theme file that can't be
/// read might extend it, so that refuses too, unless `force`, or unless `name` is itself
/// unparsable (then only other unreadable themes are in the way). `hint` is the way out.
fn check_dependents(
    cfg: &Cfg,
    name: &str,
    force: bool,
    what: &str,
    hint: &str,
    safe: &str,
) -> Result<(), ApiErr> {
    let (found, unreadable) = dependents_of(cfg, name)?;
    if !found.is_empty() {
        return Err(in_use(name, &found, what));
    }
    if unreadable.is_empty() || force || unparsable(cfg, name) {
        return Ok(());
    }
    Err(io_err(format!(
        "could not read {}, so it is not known whether it extends {name:?}; nothing was {what}",
        unreadable.join("; ")
    ))
    .suggest(format!(
        "Fix or delete the unreadable theme, or use `{hint}` to go on anyway. {safe}"
    )))
}

fn in_use(name: &str, dependents: &[String], what: &str) -> ApiErr {
    ApiErr::at(
        "in_use",
        "name",
        format!(
            "{name:?} is extended by {}, which would stop loading; delete or change those first, so nothing was {what}",
            dependents.join(", ")
        ),
    )
}

pub(crate) fn op_delete(c: &Ctx, name: &str, force: bool) -> Res {
    user_theme_name(name)?;
    if is_builtin(name) {
        return Err(ApiErr::at(
            "builtin_read_only",
            "name",
            format!("{name:?} is built in and cannot be deleted"),
        ));
    }
    let _lock = Lock::acquire(&c.cfg)?;
    let path = c.cfg.theme_path(name);
    if !path.is_file() {
        return Err(ApiErr::at(
            "unknown_theme",
            "name",
            format!("no user theme named {name:?}"),
        ));
    }
    let eff = effective(&c.cfg);
    let current = current_name_lenient(&c.cfg).unwrap_or_else(|| eff.state.theme.clone());
    if eff.state.theme == name || current == name {
        return Err(ApiErr::at(
            "current_theme",
            "name",
            format!("{name:?} is the current theme; run `polycarp theme set <other>` first"),
        ));
    }
    if chain_names(&c.cfg, &current).iter().any(|n| n == name) {
        return Err(ApiErr::at(
            "current_theme",
            "name",
            format!(
                "{name:?} is a base of the current theme {current:?}; run `polycarp theme set <other>` first"
            ),
        ));
    }
    // Another user theme that extends this one would stop loading.
    check_dependents(
        &c.cfg,
        name,
        force,
        "deleted",
        &format!("polycarp theme delete {name} --force"),
        "A copy of the theme is kept in history, so `polycarp theme undo` brings it back.",
    )?;
    let mut out = commit(c, None, &format!("theme delete {name}"), Some((name, None)))?;
    out.text = format!("deleted {}\n{}", path.display(), out.text);
    Ok(out.with(json!({"name": name, "path": path.display().to_string()})))
}

// --- whole documents ------------------------------------------------------------------------

fn json_to_toml(v: &Json, at: &str) -> Result<Value, String> {
    Ok(match v {
        Json::Null => {
            return Err(format!(
                "{at}: null has no TOML equivalent; leave the key out"
            ))
        }
        Json::Bool(b) => Value::Boolean(*b),
        Json::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Float(n.as_f64().ok_or(format!("{at}: number out of range"))?),
        },
        Json::String(s) => Value::String(s.clone()),
        Json::Array(a) => Value::Array(
            a.iter()
                .enumerate()
                .map(|(i, x)| json_to_toml(x, &format!("{at}[{i}]")))
                .collect::<Result<_, _>>()?,
        ),
        Json::Object(o) => {
            let mut t = Table::new();
            for (k, x) in o {
                let p = if at.is_empty() {
                    k.clone()
                } else {
                    format!("{at}.{k}")
                };
                t.insert(k.clone(), json_to_toml(x, &p)?);
            }
            Value::Table(t)
        }
    })
}

/// A theme document and, when it came as TOML, its original text (so comments survive).
pub(crate) struct Doc {
    table: Table,
    toml_text: Option<String>,
}

impl Doc {
    /// The theme's own `name`, if it has one.
    pub(crate) fn name(&self) -> Option<&str> {
        self.table.get("name").and_then(Value::as_str)
    }
}

/// Reads a theme given as TOML or JSON. The format is decided by the content: JSON starts
/// with `{`.
pub(crate) fn parse_doc(text: &str) -> Result<Doc, ApiErr> {
    if text.trim_start().starts_with('{') {
        let v: Json = serde_json::from_str(text).map_err(|e| {
            ApiErr::problems(
                "the theme is not valid",
                &[format!(
                    "could not read the text as JSON (line {}, column {}): {e}",
                    e.line(),
                    e.column()
                )],
            )
        })?;
        match json_to_toml(&v, "") {
            Ok(Value::Table(table)) => Ok(Doc {
                table,
                toml_text: None,
            }),
            Ok(_) => Err(ApiErr::at(
                "invalid_theme",
                "$",
                "a theme must be an object",
            )),
            Err(e) => Err(ApiErr::problems("the theme is not valid", &[e])),
        }
    } else {
        let table =
            parse_toml(text).map_err(|e| ApiErr::problems("the theme is not valid", &[e]))?;
        Ok(Doc {
            table,
            toml_text: Some(text.to_string()),
        })
    }
}

/// A theme given inside a tool call: an object, or a string of TOML or JSON.
pub(crate) fn doc_from_json(v: &Json) -> Result<Doc, ApiErr> {
    match v {
        Json::String(s) => parse_doc(s),
        Json::Object(_) => match json_to_toml(v, "") {
            Ok(Value::Table(table)) => Ok(Doc {
                table,
                toml_text: None,
            }),
            Ok(_) => Err(ApiErr::at(
                "invalid_theme",
                "$",
                "a theme must be an object",
            )),
            Err(e) => Err(ApiErr::problems("the theme is not valid", &[e])),
        },
        _ => Err(ApiErr::usage(
            "theme must be a JSON object or a string of TOML or JSON",
        )),
    }
}

pub(crate) fn op_validate(c: &Ctx, doc: &Doc, expect: Option<&str>, label: &str) -> Res {
    match resolve_doc(&c.cfg, doc.table.clone(), expect) {
        Ok(full) => Ok(Out::new(
            json!({
                "valid": true,
                "name": full.name,
                "title": full.title,
                "surfaces": SURFACES,
                "modes": MODES,
            }),
            format!(
                "ok: {label} ({}) is valid in all {} surfaces, light and dark\n",
                full.name,
                SURFACES.len()
            ),
        )),
        Err(ps) => Err(bad_theme(&format!("{label} is not valid"), &ps)),
    }
}

pub(crate) fn op_apply(c: &Ctx, doc: Doc, name: Option<&str>, activate: bool) -> Res {
    let Doc {
        mut table,
        toml_text,
    } = doc;
    let doc_name = table
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let name = match name {
        Some(n) => n.to_string(),
        None => doc_name.clone().unwrap_or_default(),
    };
    if !valid_name(&name) {
        return Err(ApiErr::at(
            "invalid_theme",
            "name",
            if name.is_empty() {
                "the theme has no name; set `name` in the theme or pass --name".to_string()
            } else {
                format!(
                    "{name:?} is not a valid theme name (lowercase letters, digits and hyphens)"
                )
            },
        ));
    }
    if is_builtin(&name) {
        return Err(ApiErr::at(
            "builtin_read_only",
            "name",
            format!(
                "{name:?} is a built-in theme and cannot be replaced; apply it under another name"
            ),
        ));
    }
    table.insert("name".into(), Value::String(name.clone()));
    let _lock = Lock::acquire(&c.cfg)?;
    let full = resolve_doc(&c.cfg, table.clone(), Some(name.as_str()))
        .map_err(|ps| bad_theme("the theme is refused, nothing changed", &ps))?;

    // The text to save. TOML keeps its comments; JSON is written as TOML.
    let saved = match toml_text {
        Some(t) if doc_name.as_deref() == Some(name.as_str()) => t,
        Some(t) => edit::set(&t, &[], "name", &Value::String(name.clone()))
            .map(|e| e.text)
            .map_err(|e| ApiErr::at("invalid_theme", "name", e))?,
        None => format!(
            "# Saved by `polycarp theme apply`.\n{}",
            toml::to_string(&table).map_err(|e| io_err(e.to_string()))?
        ),
    };
    let path = c.cfg.theme_path(&name);
    let replaced = path.exists();
    if !activate {
        keep_current_building(c, &name, &saved)?;
    }

    let mut notes = Vec::new();
    let mut stopped = None;
    let mut bad_old = false;
    let st_opt = if activate {
        // Like `set`: keep the mode and accents when only the theme was broken.
        let (mut st, old_problems) = load_state(&c.cfg);
        if !old_problems.is_empty() {
            bad_old = true;
            notes.push(format!(
                "the old settings were invalid and are replaced: {}",
                old_problems.join("; ")
            ));
        }
        st.theme = name.clone();
        stopped = omarchy::stop_for_switch(&mut st, &name, None, &mut notes);
        turn_on(&mut st, &mut notes);
        if apply_accents(&full, st.accent_light.as_deref(), st.accent_dark.as_deref()).is_err() {
            notes.push(format!(
                "your accent override does not read well on {name}, so it is cleared"
            ));
            st.accent_light = None;
            st.accent_dark = None;
        }
        Some(st)
    } else {
        None
    };
    let mut out = commit(
        c,
        st_opt.as_ref(),
        &format!("theme apply {name}"),
        Some((&name, Some(&saved))),
    )?;
    out.notes.splice(0..0, notes);
    drop(_lock);
    if stopped.is_some() || bad_old {
        out = omarchy::after_stop(c, out, stopped);
    }
    let mut text = format!("saved {}\n", path.display());
    if !activate {
        text.push_str(&format!(
            "not made current; run `polycarp theme set {name}` to use it\n"
        ));
    }
    text.push_str(&out.text);
    out.text = text;
    Ok(out.with(json!({
        "name": name,
        "title": full.title,
        "saved": path.display().to_string(),
        "replaced": replaced,
        "activated": activate,
    })))
}

/// `<builtin>-custom`, or the first free `<builtin>-custom-2`, `-3`, ...
fn free_custom_name(cfg: &Cfg, base: &str) -> String {
    let first = format!("{base}-custom");
    if !cfg.theme_path(&first).exists() {
        return first;
    }
    (2..)
        .map(|n| format!("{first}-{n}"))
        .find(|n| !cfg.theme_path(n).exists())
        .unwrap_or(first)
}

pub(crate) fn op_change(c: &Ctx, path: &str, value: &Json) -> Res {
    op_change_many(c, None, &[(path.to_string(), value.clone())])
}

/// Several values in one change. Every value is checked first and a refusal changes nothing; the
/// edit is one entry in history, so one `undo` takes all of it back. With `theme`, it edits that
/// user theme, current or not, and does not change which theme is current.
pub(crate) fn op_change_many(c: &Ctx, theme: Option<&str>, changes: &[(String, Json)]) -> Res {
    // Refuse a request that is wrong on its face before anything starts following.
    check_changes(changes)?;
    match theme {
        None => omarchy::with_default(c, || change_inner(c, None, changes)),
        Some(t) => change_inner(c, Some(t), changes),
    }
}

/// Checks every pair and reports every refusal at once, with its path.
fn check_changes(changes: &[(String, Json)]) -> Result<Vec<(Target, Value)>, ApiErr> {
    if changes.is_empty() {
        return Err(ApiErr::usage("give at least one <path> <value> pair"));
    }
    let mut seen = BTreeSet::new();
    for (p, _) in changes {
        if !seen.insert(p.as_str()) {
            return Err(ApiErr::usage(format!(
                "{p} is given twice; give each path once"
            )));
        }
    }
    let mut ok = Vec::new();
    let mut refused: Vec<ApiErr> = Vec::new();
    for (p, v) in changes {
        match check_change(p, v) {
            Ok(x) => ok.push(x),
            Err(e) => refused.push(e),
        }
    }
    if refused.is_empty() {
        return Ok(ok);
    }
    let mut first = refused.remove(0);
    if !refused.is_empty() {
        first.message = format!(
            "{} of the {} values are refused, nothing changed",
            refused.len() + 1,
            changes.len()
        );
        for e in refused {
            first.items.extend(e.items);
            first.lines.extend(e.lines);
        }
    }
    Err(first)
}

fn check_change(path: &str, value: &Json) -> Result<(Target, Value), ApiErr> {
    let target = parse_target(path)?;
    let new = coerce(path, &target, value)?;
    // The value alone, so a bad range is reported as the value's problem.
    if let Target::Field { kind, .. } = &target {
        let mut probs = Vec::new();
        check_value(path, &new, *kind, &mut probs);
        if !probs.is_empty() {
            let mut e = ApiErr::problems("the value is refused, nothing changed", &probs);
            e.code = "invalid_value";
            e.items = vec![json!({
                "path": path,
                "message": probs[0].split_once(": ").map_or(probs[0].as_str(), |x| x.1),
                "actual": serde_json::to_value(&new).unwrap_or(Json::Null),
                "needs": schema::needs(*kind),
            })];
            return Err(e);
        }
    }
    Ok((target, new))
}

/// The table path and key a target edits in a theme file.
fn target_place(target: &Target) -> (Vec<&str>, &str) {
    match target {
        Target::Meta(k) => (vec![], k),
        Target::Field {
            surface,
            section,
            key,
            ..
        } => match surface {
            Some(s) => (vec!["surface", s.as_str(), section], key),
            None => (vec![section], key),
        },
    }
}

fn change_inner(c: &Ctx, theme: Option<&str>, changes: &[(String, Json)]) -> Res {
    let checked = check_changes(changes)?;
    if let Some(t) = theme {
        user_theme_name(t)?;
        if is_builtin(t) {
            return Err(ApiErr::at(
                "builtin_read_only",
                "theme",
                format!("{t:?} is built in and cannot be edited"),
            )
            .suggest(format!(
                "Run `polycarp theme create <name> --extends {t}` and edit that, or leave out --theme to change the current theme (a built-in gets a -custom copy)."
            )));
        }
    }

    let _lock = Lock::acquire(&c.cfg)?;
    let eff = effective(&c.cfg);
    let current = eff.state.theme.clone();
    // Editing the theme in force: the settings change too (accent overrides, turning it on).
    let in_force = theme.is_none_or(|t| t == current);
    if in_force {
        require_healthy(&eff)?;
    }
    if let Some(t) = theme {
        if !c.cfg.theme_path(t).is_file() {
            return Err(ApiErr::at(
                "unknown_theme",
                "theme",
                format!("no user theme named {t:?}"),
            ));
        }
    }
    let before = if in_force {
        Some(eff.full.clone())
    } else {
        theme.and_then(|t| resolve_name(&c.cfg, t).ok())
    };
    let previous: Vec<Option<Json>> = changes
        .iter()
        .map(|(p, _)| before.as_ref().and_then(|f| lookup(f, p).ok()))
        .collect();
    let mut st = eff.state.clone();
    let mut notes = Vec::new();
    if in_force {
        turn_on(&mut st, &mut notes);
    }

    let (name, base_text, created) = if in_force && is_builtin(&current) {
        let name = free_custom_name(&c.cfg, &current);
        let text = format!(
            "# Polycarp theme {name:?}. It extends the built-in {current:?}.\n\
             # Made by `polycarp theme change`. Only the values you changed are listed.\n\
             name = {}\n\
             title = {}\n\
             description = {}\n\
             extends = {}\n",
            json!(name),
            json!(title_case(&name)),
            json!(format!("{} with your changes.", title_case(&current))),
            json!(current),
        );
        (name, text, true)
    } else {
        let name = theme.map_or(current.clone(), str::to_string);
        let p = c.cfg.theme_path(&name);
        let text = fs::read_to_string(&p)
            .map_err(|e| io_err(format!("could not read {}: {e}", p.display())))?;
        (name, text, false)
    };

    let mut text = base_text;
    let mut kept_comments = true;
    for ((target, new), (path, _)) in checked.iter().zip(changes) {
        let (section, key) = target_place(target);
        let edited = edit::set(&text, &section, key, new).map_err(|e| {
            ApiErr::at(
                "invalid_theme",
                path,
                format!("{}: {e}", c.cfg.theme_path(&name).display()),
            )
        })?;
        kept_comments &= edited.kept_comments;
        text = edited.text;
    }
    let doc = parse_toml(&text).map_err(|e| ApiErr::problems("the edit is not valid", &[e]))?;
    let full = resolve_doc(&c.cfg, doc, Some(&name))
        .map_err(|ps| bad_theme("the change is refused, nothing changed", &ps))?;

    if in_force {
        // An explicit accent change replaces a `theme accent` override for that mode.
        for ((target, _), (path, _)) in checked.iter().zip(changes) {
            if let Target::Field {
                surface: None,
                section: sec,
                key: k,
                ..
            } = target
            {
                if MODES.contains(sec) && (*k == "accent" || *k == "on_accent") {
                    let slot = if *sec == "light" {
                        &mut st.accent_light
                    } else {
                        &mut st.accent_dark
                    };
                    if slot.take().is_some() {
                        notes.push(format!(
                            "the accent override for {sec} mode was cleared, because it would hide {path}"
                        ));
                    }
                }
            }
        }
        st.theme = name.clone();
        apply_accents(&full, st.accent_light.as_deref(), st.accent_dark.as_deref())
            .map_err(|ps| bad_theme("the change is refused, nothing changed", &ps))?;
    } else {
        // The theme may be a base of the current one, which must keep building.
        keep_current_building(c, &name, &text)?;
    }

    let pairs: Vec<String> = changes
        .iter()
        .map(|(p, v)| format!("{p} {}", compact(v).trim_matches('"')))
        .collect();
    let mut action = format!("theme change {}", pairs.join(", "));
    if let Some(t) = theme {
        action.push_str(&format!(" in {t}"));
    }
    if in_force && name == omarchy::TOP {
        omarchy::accept(&mut st, changes.iter().map(|(p, _)| p.as_str()));
    }
    let mut out = commit(
        c,
        in_force.then_some(&st),
        &action,
        Some((&name, Some(&text))),
    )?;
    let mut said = String::new();
    if created {
        let n = format!(
            "{current} is built in, so the change went into a new theme {name} that extends it, now current"
        );
        said.push_str(&format!("{n}\n"));
        notes.push(n);
    }
    let paths: Vec<&str> = changes.iter().map(|(p, _)| p.as_str()).collect();
    said.push_str(&format!("changed {}", paths.join(", ")));
    if !in_force {
        said.push_str(&format!(" in {name} (not the current theme)"));
    }
    said.push('\n');
    said.push_str(&out.text);
    out.text = said;
    out.notes.splice(0..0, notes);
    let file = c.cfg.theme_path(&name).display().to_string();
    let list: Vec<Json> = checked
        .iter()
        .zip(changes)
        .zip(&previous)
        .map(|(((_, new), (p, _)), prev)| {
            json!({"path": p, "value": serde_json::to_value(new).unwrap_or(Json::Null), "previous": prev})
        })
        .collect();
    let mut data = json!({
        "changes": list,
        "theme": name,
        "current": in_force,
        "created": created,
        "extends": created.then_some(current),
        "file": file,
        "comments_kept": kept_comments,
    });
    if let ([(path, _)], [(_, new)], Some(o)) = (changes, checked.as_slice(), data.as_object_mut())
    {
        o.insert("path".into(), json!(path));
        o.insert(
            "value".into(),
            serde_json::to_value(new).unwrap_or(Json::Null),
        );
        o.insert("previous".into(), previous[0].clone().unwrap_or(Json::Null));
    }
    Ok(out.with(data))
}

/// A theme's own file, as written: a user theme's file, or a built-in's source. It is what
/// `apply` and `validate` take, so it is the file to share. It resolves nothing.
fn export_toml(c: &Ctx, name: Option<&str>) -> Res {
    let name = match name {
        Some(n) => n.to_string(),
        None => effective(&c.cfg).state.theme,
    };
    user_theme_name(&name)?;
    let (text, source, file) = match BUILTINS.iter().find(|(n, _)| *n == name) {
        Some((_, src)) => (src.to_string(), "built-in", None),
        None => {
            let p = c.cfg.theme_path(&name);
            match fs::read_to_string(&p) {
                Ok(t) => (t, "user", Some(p.display().to_string())),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(ApiErr::at(
                        "unknown_theme",
                        "name",
                        format!("no theme named {name:?}"),
                    ))
                }
                Err(e) => return Err(io_err(format!("could not read {}: {e}", p.display()))),
            }
        }
    };
    Ok(Out::new(
        json!({"format": "toml", "theme": name, "source": source, "file": file, "toml": text}),
        text.clone(),
    ))
}

pub(crate) fn op_export(c: &Ctx, format: &str, name: Option<&str>, surface: Option<&str>) -> Res {
    if format == "toml" {
        if surface.is_some() {
            return Err(ApiErr::usage(
                "export toml prints the whole theme file; leave out --surface",
            ));
        }
        return export_toml(c, name);
    }
    if !matches!(format, "css" | "json") {
        return Err(ApiErr::usage("export format must be css, json or toml"));
    }
    if let Some(s) = surface {
        if !SURFACES.contains(&s) {
            return Err(ApiErr::usage(format!(
                "--surface must be one of {}",
                SURFACES.join(", ")
            )));
        }
    }
    // With no name, the state in force: its forced mode, like the files in current/.
    let (full, problems, state) = match name {
        Some(_) => {
            let (f, p) = resolve_for_view(&c.cfg, name)?;
            (f, p, None)
        }
        None => {
            let eff = effective(&c.cfg);
            (eff.full, eff.problems, Some(eff.state))
        }
    };
    let mode = state.as_ref().map_or("auto", |s| s.mode.as_str());
    let forced = (mode != "auto").then_some(mode);
    let out = if format == "css" {
        let css = css(&full, surface, forced);
        Out::new(
            json!({"format": "css", "theme": full.name, "surface": surface, "mode": mode, "css": css}),
            css,
        )
    } else if let Some(s) = surface {
        let mut v = resolved_json(full.surface(s));
        if let Some(o) = v.as_object_mut() {
            o.insert("name".into(), json!(full.name));
            o.insert("title".into(), json!(full.title));
            o.insert("surface".into(), json!(s));
            o.insert("mode".into(), json!(mode));
        }
        let text = format!("{}\n", pretty(&v));
        Out::new(v, text)
    } else {
        let mut v = theme_json(&full, state.as_ref().map(State::choice).as_ref());
        if let Some(o) = v.as_object_mut() {
            o.insert("mode".into(), json!(mode));
        }
        let text = format!("{}\n", pretty(&v));
        Out::new(v, text)
    };
    Ok(out.warn(problems))
}

/// The bytes `config.toml` should hold after undoing `last`: the live file with only its
/// `[appearance]` table put back as it was. None means the file should not exist.
fn undone_config(live: Option<&[u8]>, last: &Hist) -> Option<Vec<u8>> {
    let parse = |b: &[u8]| {
        std::str::from_utf8(b)
            .ok()
            .and_then(|t| t.parse::<Table>().ok())
    };
    let live_table = match live {
        None => Table::new(),
        Some(b) => match parse(b) {
            Some(t) => t,
            // The live file is not TOML: there is nothing in it to keep.
            None => return (!last.absent).then(|| last.body.clone()),
        },
    };
    let mut others = live_table;
    others.remove("appearance");
    let snapshot = if last.absent {
        Some(Table::new())
    } else {
        parse(&last.body)
    };
    let Some(snap) = snapshot else {
        // The old file was not TOML either; put its bytes back as they were.
        return Some(last.body.clone());
    };
    if others.is_empty() {
        // Only [appearance] was there, so the old file comes back byte for byte.
        return (!last.absent).then(|| last.body.clone());
    }
    if let Some(app) = snap.get("appearance") {
        others.insert("appearance".into(), app.clone());
    }
    Some(toml::to_string(&others).unwrap_or_default().into_bytes())
}

/// Puts one file back to what it held, for a rollback. Best effort.
fn put_back(path: &Path, was: &Option<Vec<u8>>) {
    match was {
        Some(b) => {
            let _ = write_atomic(path, b);
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

pub(crate) fn op_undo(c: &Ctx, force: bool) -> Res {
    omarchy::before_undo(c);
    match undo_inner(c, force) {
        Ok(out) => Ok(omarchy::reconcile(c, out)),
        Err(e) => {
            // Whatever refused it, put the colors and the hook right again.
            let _ = omarchy::reconcile(c, Out::new(json!({}), ""));
            Err(e)
        }
    }
}

fn undo_inner(c: &Ctx, force: bool) -> Res {
    let _lock = Lock::acquire(&c.cfg)?;
    let hist = read_history(&c.cfg);
    let Some(last) = hist.first() else {
        return Err(ApiErr::new("nothing_to_undo", "nothing to undo"));
    };
    if !last.valid {
        return Err(io_err(format!(
            "the newest history entry {} is damaged, so nothing was undone. Delete that file to \
             go back further, or run `polycarp theme reset`",
            last.file.display()
        )));
    }
    let live = read_or_absent(&c.cfg.file()).map_err(io_err)?;
    let new_config = undone_config(live.as_deref(), last);

    // If someone edited the theme file after the change wrote it, undoing would overwrite or
    // delete their work. Refuse, unless `force`, which first keeps their text in history/.
    let mut kept_copy = None;
    if let (Some(name), Some(after)) = (last.theme_name.as_deref(), last.theme_after.as_deref()) {
        let now = read_or_absent(&c.cfg.theme_path(name)).map_err(io_err)?;
        let unchanged = match &now {
            None => after == "absent",
            Some(b) => text_hash(b) == after,
        };
        if !unchanged {
            if !force {
                return Err(ApiErr::new(
                    "changed_since",
                    format!(
                        "the theme file {} was edited after the change you are undoing, so nothing was undone (undoing would overwrite or delete those edits)",
                        c.cfg.theme_path(name).display()
                    ),
                ));
            }
            if let Some(b) = now {
                let (compact, _) = stamps();
                let dir = c.cfg.history();
                fs::create_dir_all(&dir)
                    .map_err(|e| io_err(format!("could not create {}: {e}", dir.display())))?;
                let mut n = 0;
                let copy = loop {
                    let f = dir.join(format!("{compact}-forced-{name}-{n}.toml.bak"));
                    if !f.exists() {
                        break f;
                    }
                    n += 1;
                };
                write_atomic(&copy, &b).map_err(|e| io_err(format!("{e}. Nothing was undone")))?;
                kept_copy = Some(copy);
            }
        }
    }

    // Undoing a create removes the theme file. Refuse if another theme extends it, as `delete` does.
    if let (Some(name), true) = (last.theme_name.as_deref(), last.theme_absent) {
        if !force {
            check_dependents(
                &c.cfg,
                name,
                false,
                "undone",
                "polycarp theme undo --force",
                "Undo keeps no copy of the theme file.",
            )
            .map_err(|e| {
                if e.code == "in_use" {
                    e.suggest("Use `polycarp theme undo --force` to remove it anyway.")
                } else {
                    e
                }
            })?;
        }
    }

    // Everything is worked out. Now write; if a later step fails, the earlier ones are undone,
    // so the folder is never left half-way.
    let mut theme_was: Option<(PathBuf, Option<Vec<u8>>)> = None;
    if let Some(name) = last
        .theme_name
        .as_deref()
        .filter(|n| valid_name(n) && !is_builtin(n))
    {
        let p = c.cfg.theme_path(name);
        let was = read_or_absent(&p).map_err(io_err)?;
        let r = if last.theme_absent {
            match fs::remove_file(&p) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    Err(format!("could not remove {}: {e}", p.display()))
                }
                _ => Ok(()),
            }
        } else {
            write_atomic(&p, &last.theme_body)
        };
        r.map_err(|e| io_err(format!("{e}. Nothing was undone")))?;
        theme_was = Some((p, was));
    }
    let rollback = |why: String| {
        if let Some((p, was)) = &theme_was {
            put_back(p, was);
        }
        put_back(&c.cfg.file(), &live);
        io_err(format!("{why}. Nothing was undone"))
    };
    match &new_config {
        Some(b) => write_atomic(&c.cfg.file(), b).map_err(rollback)?,
        None => match fs::remove_file(c.cfg.file()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(rollback(format!(
                    "could not remove {}: {e}",
                    c.cfg.file().display()
                )))
            }
            _ => {}
        },
    }
    if let Err(e) = fs::remove_file(&last.file) {
        return Err(rollback(format!(
            "could not remove {}: {e}",
            last.file.display()
        )));
    }
    let mut out = finish(&c.cfg).map_err(|mut e| {
        e.message = format!(
            "the change was undone, but the files in current/ could not be refreshed: {}",
            e.message
        );
        e
    })?;
    out.text = format!(
        "undid: {} (made by {}, {})\n{}",
        last.action, last.caller, last.time, out.text
    );
    if let Some(copy) = &kept_copy {
        out.notes.push(format!(
            "the edited theme text was kept in {}",
            copy.display()
        ));
    }
    Ok(out.with(json!({"undid": {
        "action": last.action, "caller": last.caller, "time": last.time,
        "saved_copy": kept_copy.as_ref().map(|c| c.display().to_string()),
    }})))
}

pub(crate) fn op_history(c: &Ctx) -> Res {
    let hist = read_history(&c.cfg);
    let entries: Vec<Json> = hist
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
    let text = if hist.is_empty() {
        "no history yet\n".to_string()
    } else {
        hist.iter()
            .enumerate()
            .map(|(i, h)| format!("{:>2}  {}  {:<16} {}\n", i + 1, h.time, h.caller, h.action))
            .collect()
    };
    Ok(Out::new(json!({"entries": entries}), text))
}

/// Always gets back to the defaults. Once `config.toml` is written, a lock, history or output
/// failure is a warning: recovery must not depend on any of them.
pub(crate) fn op_reset(c: &Ctx) -> Res {
    if let Some(r) = omarchy::reset_on_fresh(c) {
        return r;
    }
    let mut warnings = Vec::new();
    let (before, _) = load_state(&c.cfg);
    let was_off = !before.enabled;
    let was_following = before.follow.is_some();
    let mut before = before;
    let stopped = omarchy::release_for_reset(&mut before);
    let _lock = match Lock::acquire(&c.cfg) {
        Ok(l) => Some(l),
        Err(e) => {
            warnings.push(format!(
                "could not take the lock, so another change may be running: {}",
                e.message
            ));
            None
        }
    };
    if let Err(e) = record(&c.cfg, &c.caller, "theme reset", None) {
        warnings.push(format!(
            "this reset was not recorded in history, so undo cannot bring it back: {e}"
        ));
    }
    let st = State::default_state();
    let cfg_file = c.cfg.file();
    // A folder where config.toml should be is moved aside, not deleted, so reset can write it.
    if let Some(aside) = move_config_dir_aside(&c.cfg)? {
        warnings.push(format!(
            "{} was a folder, not a file. It was moved to {}",
            cfg_file.display(),
            aside.display()
        ));
    }
    write_atomic(&cfg_file, state_table(&c.cfg, &st).as_bytes()).map_err(io_err)?;
    // An old read-only or locked-down mode is kept by write_atomic; reset must leave a file its
    // owner can read and change.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let target = resolve_link(&cfg_file);
        if let Ok(m) = fs::metadata(&target) {
            let mode = m.permissions().mode();
            if mode & 0o600 != 0o600 {
                if let Err(e) =
                    fs::set_permissions(&target, fs::Permissions::from_mode(mode | 0o600))
                {
                    warnings.push(format!(
                        "could not make {} readable and writable by you: {e}",
                        target.display()
                    ));
                }
            }
        }
    }
    let mut out = finish_with(&c.cfg, true)?;
    if was_off {
        out.notes
            .push("the theme was off; reset turned it on, with the default theme".to_string());
    }
    drop(_lock);
    if was_following {
        out.notes
            .push("Polycarp was following Omarchy's theme; it no longer does".to_string());
    }
    // Whatever the old settings held, a hook that is ours does not outlive them.
    out = omarchy::after_stop(c, out, stopped);
    for w in warnings {
        out = out.caution(w);
    }
    Ok(out)
}

pub(crate) fn op_schema() -> Res {
    let s = schema::schema();
    let text = format!("{}\n", pretty(&s));
    Ok(Out::new(json!({"schema": s}), text))
}

/// Creates `dir` for this user only (0700 on Unix).
fn private_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("could not secure {}: {e}", dir.display()))
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))
    }
}

/// A preview may replace only a file that is a preview: one that starts with our marker.
fn refuse_foreign_file(path: &Path) -> Result<(), ApiErr> {
    let target = resolve_link(path);
    let mut f = match fs::File::open(&target) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_err(format!("could not read {}: {e}", target.display()))),
    };
    let mut head = vec![0u8; preview::MARKER.len()];
    let ours = f.read_exact(&mut head).is_ok() && head == preview::MARKER.as_bytes();
    if ours {
        Ok(())
    } else {
        Err(ApiErr::at(
            "exists",
            "out",
            format!(
                "{} already exists and is not a Polycarp preview, so it was not replaced",
                path.display()
            ),
        )
        .suggest("Pick a path that does not exist, or delete the file yourself."))
    }
}

/// A preview image may replace only a file that is one: a PNG with our text chunk.
fn refuse_foreign_png(path: &Path) -> Result<(), ApiErr> {
    let target = resolve_link(path);
    let mut f = match fs::File::open(&target) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_err(format!("could not read {}: {e}", target.display()))),
    };
    let mut head = vec![0u8; png::HEAD_LEN];
    if f.read_exact(&mut head).is_ok() && png::is_ours(&head) {
        return Ok(());
    }
    Err(ApiErr::at(
        "exists",
        "out",
        format!(
            "{} already exists and is not a Polycarp preview image, so it was not replaced",
            path.display()
        ),
    )
    .suggest("Pick a folder where it does not exist, or delete the file yourself."))
}

/// One PNG per product and mode: `<name>-<product>-<mode>.png`. `out` is a folder that exists.
fn preview_png(
    c: &Ctx,
    full: &Full,
    problems: Vec<String>,
    modes: &[&str],
    mode: &str,
    surface: Option<&str>,
    out: Option<&str>,
) -> Res {
    let dir = match out {
        Some(p) if !p.is_empty() => {
            let d = PathBuf::from(p);
            if !d.is_dir() {
                return Err(ApiErr::at(
                    "invalid_args",
                    "out",
                    format!(
                        "{} is not a folder; with --format png, --out names a folder that exists",
                        d.display()
                    ),
                ));
            }
            d
        }
        _ => {
            let d = c.cfg.dir.join("previews");
            private_dir(&d).map_err(io_err)?;
            d
        }
    };
    let products: Vec<&str> = match surface {
        Some(s) => vec![s],
        None => SURFACES.to_vec(),
    };
    // Every target is checked before any is written, so a refusal writes nothing.
    let mut plan = Vec::new();
    for s in &products {
        for m in modes {
            let p = dir.join(format!("{}-{s}-{m}.png", full.name));
            refuse_foreign_png(&p)?;
            plan.push((*s, *m, p));
        }
    }
    let mut images = Vec::new();
    let mut text = String::new();
    for (s, m, p) in plan {
        let r = full.surface(s).exported();
        let bytes = picture::render(&r, &full.title, s, m).png();
        write_atomic(&p, &bytes).map_err(io_err)?;
        let shown = p.display().to_string();
        text.push_str(&format!("{shown}\n"));
        images.push(json!({
            "surface": s,
            "mode": m,
            "path": shown,
            "width": picture::WIDTH,
            "height": picture::HEIGHT,
            "bytes": bytes.len(),
        }));
    }
    Ok(Out::new(
        json!({
            "format": "png",
            "theme": full.name,
            "mode": mode,
            "surface": surface,
            "folder": dir.display().to_string(),
            "images": images,
            "how_to_view": "Look at each image. Each shows one product in one mode, drawn in the theme's colors, corners, borders, shadow, density and indicator. The text is a pixel font, so judge contrast and color, not the typeface.",
        }),
        text,
    )
    .warn(problems))
}

pub(crate) fn op_preview(
    c: &Ctx,
    name: Option<&str>,
    mode: Option<&str>,
    surface: Option<&str>,
    out: Option<&str>,
    format: Option<&str>,
) -> Res {
    let format = format.unwrap_or("html");
    if !matches!(format, "html" | "png") {
        return Err(ApiErr::usage("--format must be html or png"));
    }
    let mode = mode.unwrap_or("both");
    let modes: Vec<&str> = match mode {
        "both" => vec!["light", "dark"],
        "light" => vec!["light"],
        "dark" => vec!["dark"],
        _ => return Err(ApiErr::usage("--mode must be light, dark or both")),
    };
    if let Some(s) = surface {
        if !SURFACES.contains(&s) {
            return Err(ApiErr::usage(format!(
                "--surface must be one of {}",
                SURFACES.join(", ")
            )));
        }
    }
    let (full, problems) = resolve_for_view(&c.cfg, name)?;
    if format == "png" {
        return preview_png(c, &full, problems, &modes, mode, surface, out);
    }
    let html = preview::render(&full, surface, &modes);
    let path = match out {
        Some(p) if !p.is_empty() => {
            let p = PathBuf::from(p);
            refuse_foreign_file(&p)?;
            p
        }
        _ => {
            let dir = c.cfg.dir.join("previews");
            private_dir(&dir).map_err(io_err)?;
            let p = dir.join(format!(
                "{}{}-{mode}.html",
                full.name,
                surface.map(|s| format!("-{s}")).unwrap_or_default()
            ));
            refuse_foreign_file(&p)?;
            p
        }
    };
    write_atomic(&path, html.as_bytes()).map_err(io_err)?;
    let shown = path.display().to_string();
    Ok(Out::new(
        json!({
            "path": shown,
            "theme": full.name,
            "mode": mode,
            "surface": surface,
            "bytes": html.len(),
            "how_to_view": "Open the file in a browser and take a screenshot. It has no external requests.",
        }),
        format!("{shown}\n"),
    )
    .warn(problems))
}

// ---------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------

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

fn parse_args(args: &[String], valued: &[&str], bools: &[&str]) -> Result<Parsed, ApiErr> {
    let mut p = Parsed {
        pos: Vec::new(),
        vals: BTreeMap::new(),
        flags: BTreeSet::new(),
    };
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        // A lone `-` is a positional (stdin); `--` plus a name is an option.
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
                            .ok_or_else(|| ApiErr::usage(format!("--{key} needs a value")))?;
                        i += 1;
                        v.clone()
                    }
                };
                p.vals.insert(key.to_string(), v);
            } else if bools.contains(&key) && inline.is_none() {
                p.flags.insert(key.to_string());
            } else {
                return Err(ApiErr::usage(format!("unknown option --{key}")));
            }
        } else {
            p.pos.push(a.clone());
        }
    }
    Ok(p)
}

fn exactly(p: &Parsed, n: usize, what: &str) -> Result<(), ApiErr> {
    if p.pos.len() == n {
        Ok(())
    } else {
        Err(ApiErr::usage(format!("expected {what}")))
    }
}

fn ctx() -> Result<Ctx, ApiErr> {
    Ctx::new(&env::var("POLYCARP_CALLER").unwrap_or_default())
}

fn first(p: &Parsed) -> Option<&str> {
    p.pos.first().map(String::as_str)
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
    // `--json` works on every subcommand, so it is taken out before the rest is read.
    let json = args.iter().any(|a| a == "--json");
    let args: Vec<String> = args.into_iter().filter(|a| a != "--json").collect();
    let Some((sub, rest)) = args.split_first() else {
        if json {
            return present(Err(ApiErr::usage("expected a command")), true);
        }
        eprint!("{USAGE}");
        return 2;
    };
    let r = match sub.as_str() {
        "list" => cmd(rest, &[], &[], |c, p| {
            exactly(p, 0, "no arguments")?;
            op_list(c)
        }),
        "show" => cmd(rest, &[], &[], |c, p| {
            if p.pos.len() > 1 {
                return Err(ApiErr::usage("expected at most one theme name"));
            }
            op_show(c, first(p))
        }),
        "current" => cmd(rest, &[], &[], |c, p| {
            exactly(p, 0, "no arguments")?;
            op_current(c)
        }),
        "get" => cmd(rest, &[], &[], |c, p| {
            if p.pos.is_empty() || p.pos.len() > 2 {
                return Err(ApiErr::usage("expected `get <path> [name]`"));
            }
            op_get(c, &p.pos[0], p.pos.get(1).map(String::as_str))
        }),
        "set" => cmd(rest, &["mode"], &[], |c, p| {
            exactly(p, 1, "one theme name")?;
            op_set(c, &p.pos[0], p.val("mode"))
        }),
        "accent" => cmd(rest, &["mode"], &["clear"], |c, p| {
            if p.flag("clear") {
                exactly(p, 0, "--clear alone")?;
                op_accent(c, None, p.val("mode"))
            } else {
                exactly(p, 1, "a color like #rrggbb, or --clear")?;
                op_accent(c, Some(&p.pos[0]), p.val("mode"))
            }
        }),
        "change" => cmd(rest, &["theme"], &[], |c, p| {
            if p.pos.is_empty() || p.pos.len() % 2 != 0 {
                return Err(ApiErr::usage(
                    "expected `change <path> <value> [<path> <value> ...]`",
                ));
            }
            let pairs: Vec<(String, Json)> = p
                .pos
                .chunks(2)
                .map(|kv| (kv[0].clone(), Json::String(kv[1].clone())))
                .collect();
            op_change_many(c, p.val("theme"), &pairs)
        }),
        "apply" => cmd(rest, &["name"], &["no-activate"], |c, p| {
            exactly(p, 1, "a file, or - for standard input")?;
            let text = read_input(&p.pos[0])?;
            let doc = parse_doc(&text)?;
            op_apply(c, doc, p.val("name"), !p.flag("no-activate"))
        }),
        "create" => cmd(rest, &["extends"], &["force"], |c, p| {
            exactly(p, 1, "one theme name")?;
            let Some(base) = p.val("extends") else {
                return Err(ApiErr::usage("create needs --extends <base>"));
            };
            op_create(c, &p.pos[0], base, p.flag("force"))
        }),
        "folder" => cmd(rest, &[], &["pin", "unpin"], |_, p| {
            exactly(p, 0, "no arguments")?;
            if p.flag("pin") && p.flag("unpin") {
                return Err(ApiErr::usage("expected --pin or --unpin, not both"));
            }
            op_folder(p.flag("pin"), p.flag("unpin"))
        }),
        "edit-path" => cmd(rest, &[], &[], |c, p| {
            exactly(p, 1, "one theme name")?;
            op_edit_path(c, &p.pos[0])
        }),
        "delete" => cmd(rest, &[], &["force"], |c, p| {
            exactly(p, 1, "one theme name")?;
            op_delete(c, &p.pos[0], p.flag("force"))
        }),
        "validate" => cmd(rest, &[], &[], |c, p| {
            exactly(p, 1, "a file, or - for standard input")?;
            // Standard input has no file name to match, so only the theme itself is checked:
            // what an app runs on a dropped file before it asks where to put it.
            if p.pos[0] == "-" {
                let doc = parse_doc(&read_input("-")?).map_err(|mut e| {
                    e.message = "the theme is not valid".to_string();
                    e
                })?;
                return op_validate(c, &doc, None, "the theme");
            }
            let file = Path::new(&p.pos[0]);
            let src = fs::read_to_string(file).map_err(|e| {
                ApiErr::new(
                    "io_error",
                    format!("could not read {}: {e}", file.display()),
                )
            })?;
            let stem = file
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let label = file.display().to_string();
            let doc = parse_doc(&src).map_err(|mut e| {
                e.message = format!("{label} is not valid");
                e
            })?;
            op_validate(c, &doc, Some(&stem), &label)
        }),
        "export" => cmd(rest, &["surface"], &[], |c, p| {
            if p.pos.is_empty() || p.pos.len() > 2 {
                return Err(ApiErr::usage("expected `export <css|json|toml> [name]`"));
            }
            op_export(
                c,
                &p.pos[0],
                p.pos.get(1).map(String::as_str),
                p.val("surface"),
            )
        }),
        "undo" => cmd(rest, &[], &["force"], |c, p| {
            exactly(p, 0, "no arguments")?;
            op_undo(c, p.flag("force"))
        }),
        "history" => cmd(rest, &[], &[], |c, p| {
            exactly(p, 0, "no arguments")?;
            op_history(c)
        }),
        "off" => cmd(rest, &[], &[], |c, p| {
            exactly(p, 0, "no arguments")?;
            op_off(c)
        }),
        "on" => cmd(rest, &[], &[], |c, p| {
            exactly(p, 0, "no arguments")?;
            op_on(c)
        }),
        "follow" => cmd(rest, &[], &["sync", "if-fresh"], |c, p| {
            if p.pos.len() > 1 {
                return Err(ApiErr::usage(
                    "expected `follow`, `follow omarchy`, `follow reset` or `follow off`",
                ));
            }
            op_follow(c, first(p), p.flag("sync"), p.flag("if-fresh"))
        }),
        "reset" => cmd(rest, &[], &[], |c, p| {
            exactly(p, 0, "no arguments")?;
            op_reset(c)
        }),
        "schema" => parse_args(rest, &[], &[]).and_then(|p| {
            exactly(&p, 0, "no arguments")?;
            op_schema()
        }),
        "preview" => cmd(rest, &["mode", "surface", "out", "format"], &[], |c, p| {
            if p.pos.len() > 1 {
                return Err(ApiErr::usage("expected at most one theme name"));
            }
            op_preview(
                c,
                first(p),
                p.val("mode"),
                p.val("surface"),
                p.val("out"),
                p.val("format"),
            )
        }),
        "--help" | "-h" | "help" => Ok(Out::new(json!({"usage": USAGE}), USAGE)),
        other => Err(ApiErr::usage(format!("unknown command {other}"))),
    };
    present(r, json)
}

/// Reads the arguments, finds the config folder, and runs one operation.
fn cmd(
    args: &[String],
    valued: &[&str],
    bools: &[&str],
    f: impl FnOnce(&Ctx, &Parsed) -> Res,
) -> Res {
    let p = parse_args(args, valued, bools)?;
    f(&ctx()?, &p)
}

fn read_input(arg: &str) -> Result<String, ApiErr> {
    if arg == "-" {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| ApiErr::new("io_error", format!("could not read standard input: {e}")))?;
        Ok(s)
    } else {
        fs::read_to_string(arg)
            .map_err(|e| ApiErr::new("io_error", format!("could not read {arg}: {e}")))
    }
}

/// Prints a result as a person or a program wants it, and returns the exit code.
fn present(r: Res, json: bool) -> i32 {
    if json {
        let (env, ok) = envelope(&r);
        println!("{}", pretty(&env));
        return match r {
            Ok(_) => 0,
            Err(e) => {
                debug_assert!(!ok);
                e.exit
            }
        };
    }
    match r {
        Ok(out) => {
            for p in &out.warnings {
                eprintln!("polycarp: warning: {p}");
            }
            if out.fallback {
                eprintln!(
                    "polycarp: warning: using the default theme (polycarp, auto, no accent) instead"
                );
            }
            for n in out.notes.iter().filter(|n| !out.text.contains(n.as_str())) {
                eprintln!("polycarp: note: {n}");
            }
            print!("{}", out.text);
            0
        }
        Err(e) => {
            eprintln!("{}", e.human());
            e.exit
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_epoch() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(19_723), (2024, 1, 1));
    }

    #[test]
    fn problems_become_paths_with_numbers() {
        let i = item_of("surface.site: dark.muted on dark.surface is 3.04, needs 4.5");
        assert_eq!(i["path"], "surface.site.dark.muted");
        assert_eq!(i["actual"], 3.04);
        assert_eq!(i["needs"], 4.5);
        assert_eq!(i["on"], "surface.site.dark.surface");
        let i = item_of("shape.radius: 99 is out of range 0..64");
        assert_eq!(i["path"], "shape.radius");
        let i = item_of("in evening: light.accent: \"x\" is not a color like \"#rrggbb\"");
        assert_eq!(
            (i["path"].as_str(), i["in"].as_str()),
            (Some("light.accent"), Some("evening"))
        );
        assert_eq!(
            item_of("could not read the file as TOML (line 2): x")["path"],
            "$"
        );
    }
}
