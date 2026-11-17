//! Which apps an agent may start on Windows: the ones the user lists, and none on their own.
//!
//! The line is drawn by process: an agent drives only a process BaneySpaces started for it as a new
//! instance. On Windows no app is known to be safe to hand an agent:
//!
//! * Notepad forwards a second launch into a copy of yours that is already running (seen live), and
//!   restores your unsaved tabs into a new process, so an agent's Notepad can show text you never saved.
//! * Explorer, the Store apps and browsers forward to a running copy too.
//!
//! So no app is on the list by default. The user lists the ones they trust in
//! `%APPDATA%\Polycarp\agent-apps.toml` (`apps = ["charmap", 'C:\Tools\viewer.exe']`, the same file the Mac
//! reads from its own config folder), read on every `agent open`. A listed app still starts as its own process in
//! the agent's job, and only a window of that process is the agent's: an app that hands the launch to a copy you
//! already run is `single_instance`, and nothing is driven. Shells, browsers, Explorer, Notepad (it restores your
//! unsaved tabs), settings, password managers, apps that run code and apps signed in to your accounts are never
//! started, listed or not (`never_listed`). A listed app gets no arguments: files arrive with a handoff folder.
//! Everything else is `needs_sandbox` before launch. A Windows sandbox is still a later part.
//!
//! The live tests need something to drive. `bs-testapp` (platforms/windows/testapp) is a window with a
//! text box, its own process every time, nothing remembered. A daemon started with
//! `BANEYSPACES_TEST_OPS` set, **built with the `test-ops` feature**, may start it (and `cmd`, for the tests'
//! agent-peer check). A release build made without the feature ignores the variable.

/// The test window's program name.
const TEST_APP: &str = "bs-testapp";

fn base(app: &str) -> String {
    let name = app.rsplit(['\\', '/']).next().unwrap_or(app).to_lowercase();
    name.strip_suffix(".exe").map(String::from).unwrap_or(name)
}

/// The apps an agent may start in production: the user's list, less anything never started.
pub fn allowed() -> Vec<String> {
    load().apps
}

/// Programs an agent never starts, even when listed, by program name (no `.exe`), and why.
const NEVER: &[(&[&str], &str)] = &[
    (&["cmd", "powershell", "pwsh", "wt", "windowsterminal", "conhost", "bash", "wsl", "wslhost", "ssh", "python", "pythonw", "py", "node", "java",
       "javaw", "wscript", "cscript", "mshta", "rundll32", "regsvr32", "msiexec", "schtasks", "sc", "reg", "regedit", "mmc", "taskmgr", "control",
       "systemsettings", "explorer", "code", "cursor", "devenv", "notepad++", "sublime_text", "mstsc", "baneyspaces", "polycarp"],
     "it runs code, changes settings or shows your files"),
    (&["msedge", "chrome", "firefox", "brave", "opera", "vivaldi", "iexplore", "helium", "chromium", "arc"],
     "a browser holds your logins"),
    (&["1password", "bitwarden", "keepass", "keepassxc", "lastpass", "credentialuibroker"], "it holds your passwords"),
    (&["notepad", "outlook", "olk", "winword", "excel", "powerpnt", "onenote", "teams", "ms-teams", "slack", "discord", "telegram", "whatsapp",
       "signal", "zoom", "thunderbird", "hxoutlook"],
     "it holds your own data or is signed in to your accounts"),
];

/// Why `app` is never started for an agent, listed or not; None when it may be listed.
pub fn never_listed(app: &str) -> Option<&'static str> {
    let b = base(app);
    NEVER.iter().find(|(names, _)| names.contains(&b.as_str())).map(|(_, why)| *why)
}

/// The user's list: the apps it allows, and what it skipped and why.
#[derive(Debug, Default, PartialEq)]
pub struct AgentApps {
    pub apps: Vec<String>,
    pub problems: Vec<String>,
}

/// The file's name, in Polycarp's config folder.
pub const LIST_FILE: &str = "agent-apps.toml";

/// `POLYCARP_CONFIG_DIR`, else `%APPDATA%\Polycarp` (where the Mac app looks on Windows too).
pub fn list_path() -> Option<std::path::PathBuf> {
    let dir = std::env::var_os("POLYCARP_CONFIG_DIR")
        .filter(|d| !d.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("APPDATA").filter(|d| !d.is_empty()).map(|d| std::path::PathBuf::from(d).join("Polycarp")))?;
    Some(dir.join(LIST_FILE))
}

/// The list as the file holds it now; empty when there is no file.
pub fn load() -> AgentApps {
    list_path().and_then(|p| std::fs::read_to_string(p).ok()).map(|t| parse(&t)).unwrap_or_default()
}

/// Reads `apps = [ "name", 'C:\path\app.exe', ... ]`, which may span lines; `#` starts a comment.
pub fn parse(text: &str) -> AgentApps {
    let body: String = text.lines().map(|l| l.split('#').next().unwrap_or("")).collect::<Vec<_>>().join("\n");
    let mut out = AgentApps::default();
    // Where `apps = [` is: the key at the start of a line, then `=`, then `[` on the same line.
    let mut at = 0;
    let mut start = None;
    for line in body.split('\n') {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("apps").map(str::trim_start).and_then(|r| r.strip_prefix('=')) {
            match rest.trim_start().starts_with('[') {
                true => start = Some(at + line.len() - rest.trim_start().len()),
                false => out.problems.push("apps: the list must start with [ on the same line".into()),
            }
            break;
        }
        at += line.len() + 1;
    }
    let Some(start) = start else { return out };
    let Some(len) = body[start..].find(']') else {
        out.problems.push("apps: the list has no closing ]".into());
        return out;
    };
    for item in body[start + 1..start + len].split(',') {
        let raw = item.trim();
        if raw.is_empty() { continue; }
        let quoted = raw.len() >= 2 && ((raw.starts_with('"') && raw.ends_with('"')) || (raw.starts_with('\'') && raw.ends_with('\'')));
        if !quoted {
            out.problems.push(format!("{raw}: not a quoted program name or path"));
            continue;
        }
        // A double-quoted TOML string escapes its backslashes; a single-quoted one is literal.
        let name = if raw.starts_with('"') { raw[1..raw.len() - 1].replace("\\\\", "\\") } else { raw[1..raw.len() - 1].to_string() };
        let name = name.as_str();
        if name.is_empty() || name.contains(['"', '*', '?', '<', '>', '|']) {
            out.problems.push(format!("{name}: not a program name or path"));
            continue;
        }
        if let Some(why) = never_listed(name) {
            out.problems.push(format!("{name}: never started for an agent: {why}"));
            continue;
        }
        out.apps.push(name.to_string());
    }
    out
}

/// Whether `app` as asked is on `list`: a bare name matches a bare entry (found on PATH, the daemon's own), and
/// a path only the same path. Case does not matter; `.exe` is optional on both sides.
pub fn listed_in(app: &str, list: &[String]) -> bool {
    if never_listed(app).is_some() { return false; }
    let is_path = |s: &str| s.contains(['\\', '/']);
    let norm = |s: &str| { let l = s.replace('/', "\\").to_lowercase(); l.strip_suffix(".exe").map(String::from).unwrap_or(l) };
    list.iter().any(|e| is_path(e) == is_path(app) && norm(e) == norm(app))
}

/// Is this program the bundled test window?
pub fn is_test_app(app: &str) -> bool {
    base(app) == TEST_APP
}

/// What a test build may start besides the test window: only `cmd`, which the live test runs
/// `baneyspaces` from inside an agent's job with, to check that user operations are refused to it.
const TEST_EXTRA: &[&str] = &["cmd"];

/// The rule, as a pure function: with test ops off nothing starts; with them on, the test window and
/// the one extra program.
pub fn may_start_with(app: &str, test_ops: bool) -> bool {
    test_ops && (is_test_app(app) || TEST_EXTRA.contains(&base(app).as_str()))
}

/// Test ops are on only in a build made with the `test-ops` feature, and then only when the daemon
/// was started with `BANEYSPACES_TEST_OPS` set. A production build (no feature) ignores the variable.
pub fn test_ops_enabled() -> bool {
    cfg!(feature = "test-ops") && std::env::var_os("BANEYSPACES_TEST_OPS").is_some()
}

/// May the daemon start `app` for an agent? The test window (test builds only), or an app the user listed.
pub fn may_start(app: &str) -> bool {
    may_start_with(app, test_ops_enabled()) || listed_in(app, &load().apps)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list is read from `POLYCARP_CONFIG_DIR`, which is the whole process's: tests that read or set it take turns.
    static CONFIG_DIR: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Runs `f` with the config folder at a fresh empty folder, then puts the variable back.
    fn with_config<T>(name: &str, f: impl FnOnce(&std::path::Path) -> T) -> T {
        let _turn = CONFIG_DIR.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("polycarp-agent-apps-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let old = std::env::var_os("POLYCARP_CONFIG_DIR");
        std::env::set_var("POLYCARP_CONFIG_DIR", &dir);
        let out = f(&dir);
        match old {
            Some(v) => std::env::set_var("POLYCARP_CONFIG_DIR", v),
            None => std::env::remove_var("POLYCARP_CONFIG_DIR"),
        }
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    #[test]
    fn production_allows_nothing() {
        with_config("none", |_| assert!(allowed().is_empty()));
        for app in ["notepad", "explorer", "bs-testapp", r"C:\x\bs-testapp.exe", "cmd.exe", "powershell", ""] {
            assert!(!may_start_with(app, false), "{app}");
        }
    }

    #[test]
    fn test_ops_allow_the_test_window_and_cmd_and_nothing_else() {
        assert!(may_start_with(r"C:\bs\target\release\bs-testapp.exe", true));
        assert!(may_start_with("cmd.exe", true));
        for app in ["notepad", "explorer", "powershell", "msedge", "calc", "baneyspaces"] {
            assert!(!may_start_with(app, false) && !may_start_with(app, true), "{app}");
        }
    }

    #[test]
    fn a_build_without_the_feature_ignores_the_environment() {
        // Whatever BANEYSPACES_TEST_OPS holds, a build without the feature is not in test mode.
        if !cfg!(feature = "test-ops") {
            std::env::set_var("BANEYSPACES_TEST_OPS", "1");
            assert!(!test_ops_enabled());
            with_config("feature", |_| assert!(!may_start("bs-testapp")));
            std::env::remove_var("BANEYSPACES_TEST_OPS");
        }
    }

    /// Council gap A1 on Windows: an app the user lists starts; before the list, nothing did.
    #[test]
    fn a_listed_app_may_start_and_only_then() {
        with_config("listed", |dir| {
            assert!(!may_start("charmap"), "nothing listed, nothing starts");
            std::fs::write(dir.join("agent-apps.toml"), "# apps agents may open\napps = [\n  \"charmap\", # Character Map\n  'C:\\Tools\\viewer.exe',\n]\n").unwrap();
            assert!(may_start("charmap"));
            assert!(may_start("CharMap.exe"));
            assert!(may_start(r"C:\tools\VIEWER"));
            assert!(!may_start(r"D:\evil\charmap.exe"), "a bare entry never matches some other path");
            assert!(!may_start("viewer"), "a path entry never matches a bare name");
            assert!(!may_start("calc"));
        });
    }

    /// The scope guard holds: a kind that is never an agent's stays refused when listed, under any spelling.
    #[test]
    fn a_kind_never_started_stays_refused_when_listed() {
        let never = ["cmd", "PowerShell.exe", "wt", "explorer", "notepad", "msedge", "chrome", "1password", "code", "regedit", "outlook", "baneyspaces", r"C:\Windows\System32\cmd.exe"];
        let text = format!("apps = [{}]", never.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", "));
        let list = parse(&text);
        assert!(list.apps.is_empty(), "{:?}", list.apps);
        assert_eq!(list.problems.len(), never.len());
        let all: Vec<String> = never.iter().map(|s| s.to_string()).collect();
        for n in never {
            assert!(!listed_in(n, &all), "{n}");
        }
    }

    #[test]
    fn the_file_is_read_strictly() {
        assert_eq!(parse(""), AgentApps::default());
        assert_eq!(parse("[other]\nx = 1\n").apps, Vec::<String>::new());
        assert_eq!(parse("apps = [\"charmap\"]").apps, vec!["charmap"]);
        assert!(parse("# apps = [\"charmap\"]").apps.is_empty(), "a commented line lists nothing");
        let bad = parse("apps = [charmap, \"a*b\", \"charmap\"]");
        assert_eq!(bad.apps, vec!["charmap"]);
        assert_eq!(bad.problems.len(), 2);
        assert_eq!(parse("apps = [\"charmap\"").problems, vec!["apps: the list has no closing ]"]);
    }

    #[test]
    fn the_test_window_is_found_by_name_or_path() {
        assert!(is_test_app("bs-testapp"));
        assert!(is_test_app(r"C:\bs\target\release\BS-TestApp.EXE"));
        assert!(!is_test_app("notepad"));
    }
}
