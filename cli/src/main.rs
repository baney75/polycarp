//! `polycarp`: one command that hands off to the existing tools.
//! Nothing runs through a shell.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

mod features;
mod mcp;
mod theme;

struct Tool {
    /// Subcommand name.
    sub: &'static str,
    /// Product name, for messages.
    product: &'static str,
    /// Executable name on PATH (without `.exe`).
    exe: &'static str,
    /// Older names for the same command, tried after `exe` (on PATH, then at the fixed spots).
    old_exes: &'static [&'static str],
    /// Environment variable that overrides the search.
    env: &'static str,
    /// Where the app carries its own copy, tried before PATH: the bundled one is the one that matches the app.
    /// `~` means the home folder; the absolute ones are skipped like the other system spots in tests.
    bundled: &'static [&'static str],
    /// Fixed install spots; `~` means the home folder.
    spots: &'static [&'static str],
    install: &'static str,
}

const SPACES: Tool = Tool {
    sub: "spaces",
    product: "Polycarp",
    exe: "polycarp-spaces",
    // The command's old names, still installed as links by the app and called by agents and hooks.
    old_exes: &["baneyspaces"],
    env: "POLYCARP_SPACES_BIN",
    bundled: &[],
    // The Polycarp app first, then BaneySpaces' own copy as the fallback.
    spots: &[
        "~/.local/bin/polycarp-spaces",
        "~/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces",
        "/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces",
        "~/.local/bin/baneyspaces",
        "~/Applications/BaneySpaces.app/Contents/Resources/bin/baneyspaces",
        "/Applications/BaneySpaces.app/Contents/Resources/bin/baneyspaces",
    ],
    install: "https://github.com/baney75/polycarp",
};

const BROWSER: Tool = Tool {
    sub: "browser",
    product: "the Polycarp browser helper",
    // Also the name the helper runs under (arg0), so `ps` shows `polycarp-browser mcp`.
    exe: "polycarp-browser",
    // The npm command's name before the rename: installs made then still have only it.
    old_exes: &["tabkyra"],
    env: "POLYCARP_BROWSER_BIN",
    // The helper inside Polycarp.app is one executable with no Node needed; `polycarp-browser` on PATH is the same program.
    bundled: &[
        "~/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser",
        "/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser",
    ],
    spots: &[
        "~/.config/tabkyra/tabkyra",
        "/opt/homebrew/bin/tabkyra",
        "/usr/local/bin/tabkyra",
    ],
    install: "https://github.com/baney75/polycarp",
};

const VOICE: Tool = Tool {
    sub: "voice",
    product: "Silas",
    exe: "silas",
    old_exes: &[],
    env: "POLYCARP_VOICE_BIN",
    bundled: &[],
    spots: &["/Applications/Silas.app/Contents/MacOS/silas"],
    install: "https://github.com/baney75/silas",
};

const USAGE: &str = "\
polycarp: one command for Polycarp Spaces, the Polycarp browser helper and Silas

Usage:
  polycarp spaces [args...]    run the Spaces command
  polycarp browser [args...]   run the browser helper (polycarp-browser)
  polycarp voice               open Silas's settings in Polycarp (the Silas app only if Polycarp isn't installed)
  polycarp theme <command>     choose and check the theme (polycarp theme --help)
  polycarp features            show or change which parts run (polycarp features --help)
  polycarp mcp                 serve the theme commands to an agent over MCP (stdio)
  polycarp doctor              show which tools were found
  polycarp --version
  polycarp --help

The apps must already be installed. Each tool can be set with
POLYCARP_SPACES_BIN, POLYCARP_BROWSER_BIN or POLYCARP_VOICE_BIN.
";

fn main() {
    let mut args = env::args_os().skip(1);
    let first = match args.next() {
        Some(a) => a,
        None => {
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    };
    let rest: Vec<OsString> = args.collect();
    let code = match first.to_str() {
        Some("spaces") => handoff(&SPACES, &rest),
        Some("browser") => handoff(&BROWSER, &rest),
        Some("voice") => voice(&rest),
        Some("theme") => theme::run(&rest),
        Some("features") => features::run(&rest),
        Some("mcp") => mcp::run(&rest),
        Some("doctor") => doctor(),
        Some("--version") | Some("-V") => {
            println!("polycarp {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("--help") | Some("-h") => {
            print!("{USAGE}");
            0
        }
        _ => {
            eprintln!("polycarp: unknown command {}\n", first.to_string_lossy());
            eprint!("{USAGE}");
            2
        }
    };
    std::process::exit(code);
}

fn home() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn is_executable_file(p: &Path) -> bool {
    let Ok(meta) = fs::metadata(p) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// True when `p` is this program, so we never call ourselves.
fn is_self(p: &Path) -> bool {
    let Ok(me) = env::current_exe().and_then(fs::canonicalize) else {
        return false;
    };
    fs::canonicalize(p).map(|c| c == me).unwrap_or(false)
}

/// Why a candidate was turned down, when it was not simply missing or not runnable.
#[derive(Debug, PartialEq)]
enum Miss {
    /// Nothing usable was found.
    Nothing,
    /// A tool is there but sits inside the current folder's tree.
    InCwd(PathBuf),
    /// The current folder could not be resolved, so nothing can be shown to be outside it.
    NoCwd,
    /// A `.cmd` or `.bat` file, which only runs through a shell.
    Script(PathBuf),
}

/// True when this system runs `.cmd` and `.bat` only through a shell. Tests set
/// POLYCARP_SHIM_CHECK to exercise the rule on any system.
fn shims_matter() -> bool {
    cfg!(windows) || env::var_os("POLYCARP_SHIM_CHECK").is_some()
}

fn is_script(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// Specific places that stay allowed when the current folder is the home folder or an ancestor
/// of it: where per-user installers put tools and the folders their links lead to. Relative to
/// the home folder. Whole trees such as `~/.local` are not listed, since a cloned repo can sit
/// in them.
const HOME_ALLOWED: [&str; 17] = [
    ".local/bin",
    ".local/lib/node_modules",
    ".local/share/mise",
    ".cargo/bin",
    ".bun/bin",
    ".bun/install/global",
    ".volta/bin",
    ".nvm/versions",
    ".asdf/shims",
    ".asdf/installs",
    ".npm-global/bin",
    ".npm-global/lib/node_modules",
    ".config/tabkyra",
    "Library/pnpm",
    // Windows per-user installs.
    "AppData/Local/Programs",
    "scoop/shims",
    "scoop/apps",
];

/// Absolute places allowed in the same case, for candidates outside the home folder only.
/// Tests replace the list with POLYCARP_TEST_SYSTEM_ALLOWED (paths separated like `PATH`).
fn system_allowed() -> Vec<PathBuf> {
    match env::var_os("POLYCARP_TEST_SYSTEM_ALLOWED") {
        Some(v) => env::split_paths(&v).collect(),
        None => vec![PathBuf::from("/opt"), PathBuf::from("/usr")],
    }
}

/// A real app bundle directly in the canonical `~/Applications`: a directory, not a link, with
/// a `Contents` folder.
fn is_app_bundle(p: &Path, apps: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(p) else {
        return false;
    };
    meta.is_dir()
        && p.extension().is_some_and(|e| e == "app")
        && p.parent().and_then(|d| fs::canonicalize(d).ok()).as_deref() == Some(apps)
        && fs::metadata(p.join("Contents")).is_ok_and(|m| m.is_dir())
}

/// True when the resolved path `c` is somewhere a normal per-user or system install lives. The
/// home folder is looked at first: a home under `/usr` does not open its project folders.
fn allowed_from_home(c: &Path, home: &Path) -> bool {
    if !c.starts_with(home) {
        return system_allowed().iter().any(|a| c.starts_with(a));
    }
    if HOME_ALLOWED
        .iter()
        .filter_map(|a| fs::canonicalize(home.join(a)).ok())
        .any(|a| c.starts_with(a))
    {
        return true;
    }
    // An app bundle in ~/Applications, and inside it only under Contents/.
    let Ok(apps) = fs::canonicalize(home.join("Applications")) else {
        return false;
    };
    let Ok(rest) = c.strip_prefix(&apps) else {
        return false;
    };
    let mut parts = rest.components();
    let Some(bundle) = parts.next() else {
        return false;
    };
    is_app_bundle(&apps.join(bundle), &apps)
        && parts.next().is_none_or(|n| n.as_os_str() == "Contents")
}

/// Where `p` stands against the current folder. Anything inside the current folder's tree is
/// refused. Both the candidate's target and the folder it sits in are judged, so a link can't
/// carry a tool in or out of an allowed place. Two exceptions: from `/` nothing is refused, and
/// when the current folder is the home folder or an ancestor of it, `allowed_from_home` places
/// are still fine. `$HOME/node_modules/.bin`, a file directly in `~`, and anything inside a
/// project folder stay refused. A real app bundle in `~/Applications` is judged by itself only.
/// If the current folder or `p` can't be resolved, this fails closed.
fn against_cwd(p: &Path) -> Result<(), Miss> {
    let Ok(cwd) = env::current_dir().and_then(fs::canonicalize) else {
        return Err(Miss::NoCwd);
    };
    if cwd.parent().is_none() {
        return Ok(());
    }
    let home = home().and_then(|h| fs::canonicalize(h).ok());
    let bundle = home
        .as_ref()
        .and_then(|h| fs::canonicalize(h.join("Applications")).ok())
        .is_some_and(|apps| is_app_bundle(p, &apps));
    let parent = if bundle {
        None
    } else {
        p.parent().and_then(|d| fs::canonicalize(d).ok())
    };
    let resolved: Vec<PathBuf> = [fs::canonicalize(p).ok(), parent]
        .into_iter()
        .flatten()
        .collect();
    if resolved.is_empty() {
        return Err(Miss::NoCwd);
    }
    let from_home_or_above = home.as_ref().is_some_and(|h| h.starts_with(&cwd));
    let allowed =
        |c: &Path| from_home_or_above && home.as_ref().is_some_and(|h| allowed_from_home(c, h));
    if resolved.iter().any(|c| c.starts_with(&cwd) && !allowed(c)) {
        return Err(Miss::InCwd(p.to_path_buf()));
    }
    Ok(())
}

/// The one gate every candidate passes, from an override, PATH or a fixed spot.
fn check(p: &Path) -> Result<(), Miss> {
    if !p.is_absolute() || !is_executable_file(p) || is_self(p) {
        return Err(Miss::Nothing);
    }
    if shims_matter() && is_script(p) {
        return Err(Miss::Script(p.to_path_buf()));
    }
    against_cwd(p)
}

/// A fixed spot as a path: `~/…` under the home folder, anything else absolute (skipped in tests that
/// set POLYCARP_NO_SYSTEM_SPOTS, so a machine's real installs are never reached).
fn spot_path(spot: &str) -> Option<PathBuf> {
    match spot.strip_prefix("~/") {
        Some(rest) => match home() {
            Some(h) if cfg!(windows) => Some(h.join(format!("{rest}.exe"))),
            Some(h) => Some(h.join(rest)),
            None => None,
        },
        None if env::var_os("POLYCARP_NO_SYSTEM_SPOTS").is_some() => None,
        None => Some(PathBuf::from(spot)),
    }
}

/// First match wins: environment override, the app's own copy, PATH, fixed spots. If nothing is usable, says the
/// first reason a candidate was refused.
fn find(tool: &Tool) -> Result<PathBuf, Miss> {
    if let Some(v) = env::var_os(tool.env).filter(|v| !v.is_empty()) {
        let p = PathBuf::from(v);
        return check(&p).map(|()| p);
    }
    let mut miss = Miss::Nothing;
    let mut note = |r: Result<(), Miss>| {
        if let Err(m) = r {
            if miss == Miss::Nothing {
                miss = m;
            }
        }
    };
    // The app's own copy first: it is the one built with the app.
    for spot in tool.bundled {
        let Some(cand) = spot_path(spot) else {
            continue;
        };
        match check(&cand) {
            Ok(()) => return Ok(cand),
            r => note(r),
        }
    }
    let path = env::var_os("PATH");
    if let Some(path) = &path {
        for name in std::iter::once(&tool.exe).chain(tool.old_exes) {
            let file = if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.to_string()
            };
            for dir in env::split_paths(path) {
                let cand = dir.join(&file);
                match check(&cand) {
                    Ok(()) => return Ok(cand),
                    r => note(r),
                }
            }
        }
    }
    for spot in tool.spots {
        let Some(cand) = spot_path(spot) else {
            continue;
        };
        match check(&cand) {
            Ok(()) => return Ok(cand),
            r => note(r),
        }
    }
    // npm gives polycarp-browser.cmd, not polycarp-browser.exe. Say so instead of "not found".
    if shims_matter() {
        if let Some(path) = &path {
            for dir in env::split_paths(path).filter(|d| d.is_absolute()) {
                for name in std::iter::once(&tool.exe).chain(tool.old_exes) {
                    for ext in ["cmd", "bat"] {
                        let cand = dir.join(format!("{name}.{ext}"));
                        if cand.is_file() {
                            note(Err(Miss::Script(cand)));
                        }
                    }
                }
            }
        }
    }
    Err(miss)
}

fn script_advice(tool: &Tool, p: &Path) -> String {
    format!(
        "{} ({}) is a .cmd or .bat file at {}. Those only run through a shell, and polycarp never uses one. Run Node on the tool's entry point, or set {} to a real executable.",
        tool.exe,
        tool.sub,
        p.display(),
        tool.env
    )
}

fn not_found(tool: &Tool, why: &Miss) -> i32 {
    match why {
        Miss::Nothing => eprintln!(
            "polycarp: {} ({}) not found. Install {} from {} or set {} to its path.",
            tool.exe, tool.sub, tool.product, tool.install, tool.env
        ),
        Miss::InCwd(p) => eprintln!(
            "polycarp: {} ({}) was found at {} but not run: it is in the current folder, and polycarp never runs a tool from there. Run polycarp from another folder, or set {} to a path outside it.",
            tool.exe, tool.sub, p.display(), tool.env
        ),
        Miss::NoCwd => eprintln!(
            "polycarp: could not tell what the current folder is, so {} ({}) was not run. Change to a folder that exists and try again.",
            tool.exe, tool.sub
        ),
        Miss::Script(p) => eprintln!("polycarp: {}", script_advice(tool, p)),
    }
    127
}

#[cfg(unix)]
fn run(mut cmd: Command) -> i32 {
    use std::os::unix::process::CommandExt;
    let err = cmd.exec();
    eprintln!("polycarp: could not start {:?}: {err}", cmd.get_program());
    126
}

#[cfg(windows)]
mod console {
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }
    unsafe extern "system" fn leave_it_to_the_child(_event: u32) -> i32 {
        1
    }
    /// Ctrl-C reaches both processes. Stay alive so the child decides and its exit code comes back.
    /// A real handler, not NULL: NULL's ignore flag would be inherited by the child.
    pub fn outlive_ctrl_c() {
        // SAFETY: registers a handler with no captures that touches nothing.
        unsafe {
            SetConsoleCtrlHandler(Some(leave_it_to_the_child), 1);
        }
    }
}

#[cfg(not(unix))]
fn run(mut cmd: Command) -> i32 {
    #[cfg(windows)]
    console::outlive_ctrl_c();
    match cmd.status() {
        Ok(s) => s.code().unwrap_or(1),
        Err(err) => {
            eprintln!("polycarp: could not start {:?}: {err}", cmd.get_program());
            126
        }
    }
}

fn handoff(tool: &Tool, args: &[OsString]) -> i32 {
    let path = match find(tool) {
        Ok(p) => p,
        Err(why) => return not_found(tool, &why),
    };
    let mut cmd = Command::new(path);
    cmd.args(args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // What a shell would pass, so usage text and errors read the same.
        cmd.arg0(tool.exe);
    }
    run(cmd)
}

/// On a Mac the Silas app is one fixed place: `/Applications/Silas.app`, else
/// `~/Applications/Silas.app`. `voice` and `doctor` both use it, so they cannot disagree.
#[cfg(target_os = "macos")]
fn silas_app() -> Result<PathBuf, Miss> {
    let mut spots = Vec::new();
    // Tests set this so the machine's real installs are never reached.
    if env::var_os("POLYCARP_NO_SYSTEM_SPOTS").is_none() {
        spots.push(PathBuf::from("/Applications/Silas.app"));
    }
    if let Some(h) = home() {
        spots.push(h.join("Applications/Silas.app"));
    }
    let mut miss = Miss::Nothing;
    for app in spots.into_iter().filter(|a| a.is_dir()) {
        match against_cwd(&app) {
            Ok(()) => return Ok(app),
            Err(m) if miss == Miss::Nothing => miss = m,
            Err(_) => {}
        }
    }
    Err(miss)
}

/// The Polycarp app, where voice lives now: `/Applications/Polycarp.app`, else `~/Applications/Polycarp.app`.
/// Same rules as `silas_app`. Only the Mac has the integrated voice.
#[cfg(target_os = "macos")]
fn polycarp_app() -> Option<PathBuf> {
    let mut spots = Vec::new();
    if env::var_os("POLYCARP_NO_SYSTEM_SPOTS").is_none() {
        spots.push(PathBuf::from("/Applications/Polycarp.app"));
    }
    if let Some(h) = home() {
        spots.push(h.join("Applications/Polycarp.app"));
    }
    spots
        .into_iter()
        .filter(|a| a.is_dir())
        .find(|a| against_cwd(a).is_ok())
}

#[cfg(not(target_os = "macos"))]
fn polycarp_app() -> Option<PathBuf> {
    None
}

/// Voice is inside Polycarp when the app is installed and no explicit POLYCARP_VOICE_BIN says otherwise.
fn integrated_voice() -> Option<PathBuf> {
    if env::var_os(VOICE.env).is_some_and(|v| !v.is_empty()) {
        return None;
    }
    polycarp_app()
}

/// Where a tool is, by the one rule for it.
fn locate(tool: &Tool) -> Result<PathBuf, Miss> {
    #[cfg(target_os = "macos")]
    if tool.sub == "voice" && env::var_os(tool.env).is_none_or(|v| v.is_empty()) {
        return silas_app();
    }
    find(tool)
}

/// Opens the Voice settings in Polycarp through its own `polycarp://voice` address.
#[cfg(target_os = "macos")]
fn open_polycarp_voice(app: &Path) -> i32 {
    // POLYCARP_OPEN_BIN lets a test stand in for `open`, so no app is launched.
    let open = match env::var_os("POLYCARP_OPEN_BIN").filter(|v| !v.is_empty()) {
        Some(v) => {
            let v = PathBuf::from(v);
            if check(&v).is_err() {
                eprintln!(
                    "polycarp: POLYCARP_OPEN_BIN {} was refused: it must be an absolute path to a program outside the current folder.",
                    v.display()
                );
                return 127;
            }
            v
        }
        None => PathBuf::from("/usr/bin/open"),
    };
    match Command::new(open)
        .arg("-a")
        .arg(app)
        .arg("polycarp://voice")
        .status()
    {
        Ok(s) => s.code().unwrap_or(1),
        Err(e) => {
            eprintln!("polycarp: could not run open: {e}");
            126
        }
    }
}

fn voice(args: &[OsString]) -> i32 {
    if !args.is_empty() {
        eprintln!(
            "polycarp: voice has no commands yet. Run `polycarp voice` alone to open Silas's settings in Polycarp."
        );
        return 2;
    }
    // Dictation is inside Polycarp. Silas is only the fallback for a Mac that doesn't have Polycarp installed.
    #[cfg(target_os = "macos")]
    if let Some(app) = integrated_voice() {
        return open_polycarp_voice(&app);
    }
    let path = match locate(&VOICE) {
        Ok(p) => p,
        Err(why) => return not_found(&VOICE, &why),
    };
    #[cfg(target_os = "macos")]
    if path.is_dir() {
        // The app bundle: open it without taking focus.
        // POLYCARP_OPEN_BIN lets a test stand in for `open`, so no app is launched.
        // It passes the same gate as every other program, so it can't be a file in the project.
        let open = match env::var_os("POLYCARP_OPEN_BIN").filter(|v| !v.is_empty()) {
            Some(v) => {
                let v = PathBuf::from(v);
                if check(&v).is_err() {
                    eprintln!(
                        "polycarp: POLYCARP_OPEN_BIN {} was refused: it must be an absolute path to a program outside the current folder.",
                        v.display()
                    );
                    return 127;
                }
                v
            }
            None => PathBuf::from("/usr/bin/open"),
        };
        return match Command::new(open).arg("-g").arg(&path).status() {
            Ok(s) => s.code().unwrap_or(1),
            Err(e) => {
                eprintln!("polycarp: could not run open: {e}");
                126
            }
        };
    }
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    match cmd.spawn() {
        Ok(_) => 0,
        Err(e) => {
            eprintln!("polycarp: could not start Silas: {e}");
            126
        }
    }
}

/// How long `doctor` waits for a tool's `--version`, reading included. Tests shorten it.
fn doctor_limit() -> Duration {
    env::var("POLYCARP_DOCTOR_LIMIT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map_or(Duration::from_secs(10), Duration::from_millis)
}

fn doctor() -> i32 {
    // A locked handle, and a closed pipe (`polycarp doctor | head -1`) is a quiet end, not a panic.
    let mut out = std::io::stdout().lock();
    let mut printing = true;
    let mut ok = true;
    for tool in [&SPACES, &BROWSER, &VOICE] {
        let integrated = if tool.sub == "voice" {
            integrated_voice()
        } else {
            None
        };
        let line = match integrated.map(Ok).unwrap_or_else(|| locate(tool)) {
            Ok(p) if tool.sub == "voice" && integrated_voice().as_ref() == Some(&p) => {
                format!("voice: inside Polycarp ({})", p.display())
            }
            Ok(p) => {
                let mut line = format!("{}: {}", tool.sub, p.display());
                if tool.sub == "browser" {
                    match first_version_line(&p) {
                        Some(v) => line.push_str(&format!(" ({v})")),
                        None => {
                            line.push_str(" (found, but --version did not work)");
                            ok = false;
                        }
                    }
                }
                line
            }
            Err(Miss::Script(p)) => {
                ok = tool.sub == "voice" && ok;
                format!(
                    "{}: present but not runnable. {}",
                    tool.sub,
                    script_advice(tool, &p)
                )
            }
            Err(Miss::InCwd(p)) => {
                ok = tool.sub == "voice" && ok;
                format!(
                    "{}: {} is in the current folder, so it is not used. Run doctor from another folder",
                    tool.sub,
                    p.display()
                )
            }
            Err(Miss::NoCwd) => {
                ok = tool.sub == "voice" && ok;
                format!(
                    "{}: not checked, because the current folder can't be resolved",
                    tool.sub
                )
            }
            Err(Miss::Nothing) => {
                if tool.sub != "voice" {
                    ok = false;
                }
                format!("{}: not found", tool.sub)
            }
        };
        // Stop printing after a write error, but finish the checks, so the exit code stays true.
        if printing && writeln!(out, "{line}").is_err() {
            printing = false;
        }
    }
    if let Some(line) = theme::doctor_line() {
        if printing {
            let _ = writeln!(out, "{line}");
        }
    }
    let _ = out.flush();
    if ok {
        0
    } else {
        1
    }
}

/// The tool's version, or None if it can't start, fails, prints nothing or takes past the limit.
/// The limit covers reading too: a tool that leaves a background process holding its output
/// open can't stall `doctor`.
fn first_version_line(p: &Path) -> Option<String> {
    let mut child = Command::new(p)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let read = stdout.take(64 * 1024).read_to_string(&mut text);
        let _ = tx.send(read.ok().map(|_| text));
    });
    let started = Instant::now();
    let limit = doctor_limit();
    let text = match rx.recv_timeout(limit) {
        Ok(Some(text)) => text,
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    loop {
        match child.try_wait().ok()? {
            Some(status) if status.success() => break,
            Some(_) => return None,
            None if started.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    text.lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}
