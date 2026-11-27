//! `polycarp`: one command that hands off to the existing tools.
//! Nothing runs through a shell.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

mod agent;
#[cfg(target_os = "macos")]
mod browser;
#[cfg(any(target_os = "linux", test))]
#[allow(dead_code)]
mod browser_linux;
#[cfg(any(windows, test))]
mod browser_windows;
mod features;
mod files;
mod local_studio;
mod look;
mod mail;
mod mcp;
mod retire;
mod sync;
mod theme;
mod update;
mod version;

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
    // The Polycarp app's own copy, from the same app the other parts are read from (`app_first` orders them).
    bundled: &[
        "~/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces",
        "/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces",
    ],
    // Then the link, then BaneySpaces' own copy as the fallback.
    spots: &[
        "~/.local/bin/polycarp-spaces",
        "~/.local/bin/baneyspaces",
        "~/Applications/BaneySpaces.app/Contents/Resources/bin/baneyspaces",
        "/Applications/BaneySpaces.app/Contents/Resources/bin/baneyspaces",
    ],
    install: "https://github.com/baney75/polycarp",
};

/// Local Studio's own command, which `install --local-studio` runs to grant the plugin its tool server. Nothing
/// bundles it yet, so it is found on PATH or where a build puts it.
const LOCAL_STUDIO: Tool = Tool {
    sub: "install",
    product: "Local Studio",
    exe: "local-studio",
    old_exes: &[],
    env: "POLYCARP_LOCAL_STUDIO_BIN",
    bundled: &[],
    spots: &["~/.local/bin/local-studio", "~/.cargo/bin/local-studio"],
    install: "https://github.com/baney75/local-studio",
};

/// What `polycarp browser` (and `polycarp features on|off browser`) prints now, on stderr with exit 2: the helper moved out.
const BROWSER_MOVED: &str = "The agent browser extension was removed from Polycarp.";

const USAGE: &str = "\
polycarp: one command for Polycarp Spaces and themes

Usage:
  polycarp spaces [args...]    run the Spaces command
  polycarp theme <command>     choose and check the theme (polycarp theme --help)
  polycarp look <command>      save, share and apply how all of Polycarp looks (polycarp look --help)
  polycarp sync <command>      Polycarp's settings, the same on each of your devices (polycarp sync --help)
  polycarp mcp                 serve the theme and surfaces commands to an agent over MCP (stdio)
  polycarp browser <command>   Polycarp Browser, made on a Mac from Helium's release, and checked on Windows so far
  polycarp files <command>     search, open and send your files across your devices (polycarp files --help)
  polycarp agent <command>     one MCP gateway for Claude, Codex, Grok Bot and web assistants (polycarp agent --help)
  polycarp install --local-studio [--uninstall]   add Polycarp's plugin to Local Studio and grant its tools
  polycarp doctor              show which tools were found
  polycarp --version
  polycarp version [--json] [--check]   every part, its commit, and whether they match
  polycarp update [--check] [--dry-run] [--yes] [--source <checkout>]
  polycarp --help

The app must already be installed. POLYCARP_SPACES_BIN sets the spaces command.

The agent browser extension was removed from Polycarp.
The Linux and Omarchy desktop is retired; its last snapshot is in the archived baney75/baneyspaces.
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
        Some("browser") => browser(&rest),
        Some("voice") => voice(),
        Some("theme") => theme::run(&rest),
        Some("look") => look::run(&rest),
        Some("sync") => sync::cmd::run(&rest),
        Some("features") => features::run(&rest),
        Some("mcp") => mcp::run(&rest),
        Some("files") => files::run(&rest),
        Some("agent") => agent::run(&rest),
        Some("mail") => mail::run(&rest),
        Some("install") => local_studio::run(&rest, local_studio_command()),
        Some("doctor") => doctor(),
        Some("version") => version::run(&rest, &version_device()),
        Some("update") => update::run(
            &rest,
            &update::Device {
                home: home(),
                app: polycarp_app(),
                spaces: find(&SPACES).ok().filter(|p| trusted_tool(p)),
                config: theme::config_dir(),
                parts: &|| version::gather(&version_device()),
            },
        ),
        Some("--version") | Some("-V") => {
            println!("{}", version::own_version_line());
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

/// Polycarp Browser is made on a Mac; on Windows only its release is checked so far. Anything it does not answer is the old agent browser's command: say where that went, with the exit code for a command used wrong.
fn browser(args: &[OsString]) -> i32 {
    #[cfg(target_os = "macos")]
    if let Some(code) = browser::run(
        args,
        home(),
        home().map(|h| update::cache_dir(&h)),
        polycarp_app(),
    ) {
        return code;
    }
    #[cfg(windows)]
    if let Some(code) = browser_windows::run(args, home(), home().map(|h| update::cache_dir(&h))) {
        return code;
    }
    let _ = args;
    eprintln!("{BROWSER_MOVED}");
    2
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
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
const HOME_ALLOWED: [&str; 20] = [
    ".local/bin",
    ".local/lib/node_modules",
    // mise's shims and tools, not its plugins/ folder of git clones.
    ".local/share/mise/shims",
    ".local/share/mise/installs",
    // pnpm's home on Linux; pipx and uv tools, which ~/.local/bin links point into.
    ".local/share/pnpm",
    ".local/share/pipx/venvs",
    ".local/share/uv/tools",
    ".cargo/bin",
    ".bun/bin",
    ".bun/install/global",
    ".volta/bin",
    ".nvm/versions",
    ".asdf/shims",
    ".asdf/installs",
    ".npm-global/bin",
    ".npm-global/lib/node_modules",
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

/// Outside the current folder's tree. From the home folder or above it, only that folder itself counts.
fn clear_of_cwd(c: &Path) -> bool {
    let Ok(cwd) = env::current_dir().and_then(fs::canonicalize) else {
        return false;
    };
    let home = home().and_then(|h| fs::canonicalize(h).ok());
    clear_of(c, &cwd, home.as_deref())
}

/// `clear_of_cwd` for a given folder: `c` counts as outside `cwd`'s tree.
fn clear_of(c: &Path, cwd: &Path, home: Option<&Path>) -> bool {
    c != cwd && (home.is_some_and(|h| h.starts_with(cwd)) || !c.starts_with(cwd))
}

/// A PATH folder `update` and `version` take programs from: absolute, and where it really is (links
/// followed) is neither in the current folder's tree nor a `node_modules`.
fn trusted_dir(dir: &Path) -> bool {
    let modules = |c: &Path| c.components().any(|n| n.as_os_str() == "node_modules");
    dir.is_absolute() && fs::canonicalize(dir).is_ok_and(|c| clear_of_cwd(&c) && !modules(&c))
}

/// A program `update` and `version` run unasked: in a trusted folder, and no link into the current folder's tree.
fn trusted_tool(p: &Path) -> bool {
    let dir = p.parent().is_some_and(trusted_dir);
    dir && is_executable_file(p) && fs::canonicalize(p).is_ok_and(|c| clear_of_cwd(&c))
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
    // The app's own copy first: it is the one built with the app, and the same app the "app" part is read from.
    let bundled = tool
        .bundled
        .iter()
        .filter_map(|spot| spot_path(spot))
        .collect();
    for cand in app_first(bundled, polycarp_app().as_deref()) {
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
    // An npm-style install gives a .cmd or .bat shim, not an .exe. Say so instead of "not found".
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
        "{} ({}) is a .cmd or .bat file at {}. Those only run through a shell, and polycarp never uses one. Set {} to a real executable.",
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

/// Local Studio's command for `install --local-studio`, found as `handoff` finds a tool and only from a trusted
/// folder, since it runs unasked.
fn local_studio_command() -> Option<PathBuf> {
    find(&LOCAL_STUDIO).ok().filter(|p| trusted_tool(p))
}

/// The spaces command for `polycarp mcp`'s surfaces tools, which run it unasked: found as `handoff` finds it, and only
/// from a trusted folder, as `update` and `version` require.
pub(crate) fn spaces_command() -> Option<PathBuf> {
    find(&SPACES).ok().filter(|p| trusted_tool(p))
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

/// The Polycarp app: `/Applications/Polycarp.app`, else `~/Applications/Polycarp.app`, never one in the current folder.
#[cfg(target_os = "macos")]
fn polycarp_app() -> Option<PathBuf> {
    let mut spots = Vec::new();
    if env::var_os("POLYCARP_NO_SYSTEM_SPOTS").is_none() {
        spots.push(PathBuf::from("/Applications/Polycarp.app"));
    }
    if let Some(h) = home() {
        spots.push(h.join("Applications/Polycarp.app"));
    }
    let found: Vec<PathBuf> = spots
        .into_iter()
        .filter(|a| a.is_dir() && against_cwd(a).is_ok())
        .collect();
    let linked = home().and_then(|h| fs::canonicalize(h.join(".local/bin/polycarp")).ok());
    let found: Vec<PathBuf> = found
        .iter()
        .map(|a| fs::canonicalize(a).unwrap_or(a.clone()))
        .collect();
    pick_app(&found, linked.as_deref())
}

/// With a Polycarp.app in /Applications and another in ~/Applications, every part is read from one of them: the one
/// `~/.local/bin/polycarp` links into (the copy the last install placed), else the first. Parts read from two apps
/// would never match, and every update would end in a failed check.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pick_app(found: &[PathBuf], linked: Option<&Path>) -> Option<PathBuf> {
    linked
        .and_then(|l| found.iter().find(|a| l.starts_with(a)))
        .or(found.first())
        .cloned()
}

/// `cands` with the ones inside `app` first, the rest in their own order.
fn app_first(mut cands: Vec<PathBuf>, app: Option<&Path>) -> Vec<PathBuf> {
    if let Some(app) = app {
        cands.sort_by_key(|c| {
            !fs::canonicalize(c).unwrap_or(c.clone()).starts_with(app) && !c.starts_with(app)
        });
    }
    cands
}

#[cfg(not(target_os = "macos"))]
fn polycarp_app() -> Option<PathBuf> {
    None
}

/// `polycarp voice` is only a pointer now: dictation is not part of Polycarp.
fn voice() -> i32 {
    eprintln!("{VOICE_MOVED}");
    1
}

const VOICE_MOVED: &str =
    "polycarp: Silas is its own app now. Open Silas, or get it at https://github.com/baney75/silas.";

fn doctor() -> i32 {
    // A locked handle, and a closed pipe (`polycarp doctor | head -1`) is a quiet end, not a panic.
    let mut out = std::io::stdout().lock();
    let mut ok = true;
    let tool = &SPACES;
    let line = match find(tool) {
        Ok(p) => format!("{}: {}", tool.sub, p.display()),
        Err(Miss::Script(p)) => {
            ok = false;
            format!(
                "{}: present but not runnable. {}",
                tool.sub,
                script_advice(tool, &p)
            )
        }
        Err(Miss::InCwd(p)) => {
            ok = false;
            format!(
                "{}: {} is in the current folder, so it is not used. Run doctor from another folder",
                tool.sub,
                p.display()
            )
        }
        Err(Miss::NoCwd) => {
            ok = false;
            format!(
                "{}: not checked, because the current folder can't be resolved",
                tool.sub
            )
        }
        Err(Miss::Nothing) => {
            ok = false;
            format!("{}: not found", tool.sub)
        }
    };
    // Stop printing after a write error, but keep the check's answer, so the exit code stays true.
    let printing = writeln!(out, "{line}").is_ok();
    // The same one line `polycarp version` ends with. It informs; it does not change the exit code.
    if printing {
        let parts = version::gather(&version_device());
        let verdict = version::compare(&parts);
        let _ = writeln!(out, "{}", verdict.line());
        // Under it, the one command that fixes each part that is missing or does not match.
        for line in version::fixes(&parts, &verdict, version::Os::current()) {
            let _ = writeln!(out, "{line}");
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = home().filter(|_| printing) {
        let cache = update::cache_dir(&home);
        if let Some(line) = browser::doctor(&home, &cache, polycarp_app().as_deref()) {
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

/// What `polycarp version`, `doctor` and `update` look at. Nothing here runs the spaces command:
/// its build is read from files.
fn version_device() -> version::Device {
    version::Device {
        exe: env::current_exe().ok(),
        installed: installed_polycarp(),
        home: home(),
        app: polycarp_app(),
        spaces: find(&SPACES).ok().filter(|p| trusted_tool(p)),
    }
}

/// The `polycarp` an install or an update puts in place: `~/.local/bin/polycarp` on a Mac (a link
/// into the app) and on Linux (`cargo install --root ~/.local`). None on Windows, where there is no
/// such place yet, and wherever nothing is installed there.
fn installed_polycarp() -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    spot_path("~/.local/bin/polycarp").filter(|p| is_executable_file(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_polycarp_apps_are_read_as_one_the_installed_command_links_into() {
        let (sys, mine) = (
            PathBuf::from("/Applications/Polycarp.app"),
            PathBuf::from("/Users/u/Applications/Polycarp.app"),
        );
        let both = [sys.clone(), mine.clone()];
        let linked = mine.join("Contents/Resources/bin/polycarp");
        assert_eq!(pick_app(&both, Some(&linked)), Some(mine.clone()));
        assert_eq!(pick_app(&both, None), Some(sys.clone()));
        assert_eq!(
            pick_app(&both, Some(Path::new("/opt/polycarp"))),
            Some(sys.clone())
        );
        // The spaces command comes from that same app, though ~/Applications is listed first.
        let helper = |app: &Path| app.join("Contents/Resources/bin/polycarp-spaces");
        let order = app_first(vec![helper(&mine), helper(&sys)], Some(&sys));
        assert_eq!(order, vec![helper(&sys), helper(&mine)]);
        assert_eq!(
            app_first(vec![helper(&mine), helper(&sys)], None),
            vec![helper(&mine), helper(&sys)]
        );
    }

    #[test]
    fn the_spaces_command_comes_from_the_picked_app_not_the_other_copy() {
        let home = PathBuf::from("/Users/u");
        let (sys, mine) = (
            PathBuf::from("/Applications/Polycarp.app"),
            home.join("Applications/Polycarp.app"),
        );
        let expand = |s: &&str| match s.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => PathBuf::from(s),
        };
        let spaces = |app: &Path| app.join("Contents/Resources/bin/polycarp-spaces");
        // The app's copies are tried before PATH and the fixed spots, so the first one is the whole answer.
        let first = |app: &Path| {
            app_first(SPACES.bundled.iter().map(expand).collect(), Some(app))
                .into_iter()
                .next()
        };
        assert_eq!(first(&sys), Some(spaces(&sys)));
        assert_eq!(first(&mine), Some(spaces(&mine)));
        // The link and BaneySpaces' copy stay the fallback after them.
        assert!(SPACES.spots.contains(&"~/.local/bin/polycarp-spaces"));
        assert!(!SPACES.spots.iter().any(|s| s.contains("Polycarp.app")));
    }
}
