// SPDX-License-Identifier: GPL-3.0-or-later
//! Polycarp Browser's main program. It starts Helium's own program, which sits beside it, with Polycarp's extension
//! loaded, Local Studio's when the build has it inside, and on the Mac the Polycarp theme in force as a browser theme
//! when there is one. On Windows and Linux it also names the browser's own profile folder, so Helium's is never used,
//! and loads no theme folder yet. It keeps no state and starts nothing else.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::ffi::OsString;
use std::path::{Path, PathBuf};

fn main() {
    let error = match std::env::current_exe().and_then(std::fs::canonicalize) {
        Ok(me) => start(&me),
        Err(e) => e,
    };
    eprintln!("Polycarp Browser could not start: {error}");
    std::process::exit(126);
}

/// Where Helium's program and Polycarp's extensions sit, from the launcher's own resolved path.
#[derive(Debug, PartialEq)]
struct Layout {
    program: PathBuf,
    extension: PathBuf,
    local_studio_root: PathBuf,
}

/// The Mac app: the launcher is `Contents/MacOS/<name>`, Helium's program `Contents/MacOS/Helium`.
#[cfg(any(target_os = "macos", test))]
fn mac_layout(me: &Path) -> Layout {
    let contents = me.ancestors().nth(2).unwrap_or(me);
    let polycarp = contents.join("Resources").join("polycarp");
    Layout {
        program: contents.join("MacOS").join("Helium"),
        extension: polycarp.join("extension"),
        local_studio_root: polycarp.join("local-studio"),
    }
}

/// Windows: the launcher sits beside Helium's `chrome.exe`, with Polycarp's pages in `polycarp\`.
#[cfg(any(windows, test))]
fn windows_layout(me: &Path) -> Layout {
    let dir = me.parent().unwrap_or(me);
    let polycarp = dir.join("polycarp");
    Layout {
        program: dir.join("chrome.exe"),
        extension: polycarp.join("extension"),
        local_studio_root: polycarp.join("local-studio"),
    }
}

/// Linux: the launcher sits beside `helium-wrapper`, Helium's own script, which sets `LD_LIBRARY_PATH` and execs
/// `helium`, with Polycarp's pages in `polycarp/`.
#[cfg(any(target_os = "linux", test))]
fn linux_layout(me: &Path) -> Layout {
    let dir = me.parent().unwrap_or(me);
    let polycarp = dir.join("polycarp");
    Layout {
        program: dir.join("helium-wrapper"),
        extension: polycarp.join("extension"),
        local_studio_root: polycarp.join("local-studio"),
    }
}

/// Windows' `canonicalize` gives a `\\?\` path, which Chromium may not take in a switch; the plain form names the
/// same file. Anything else is left as it is.
#[cfg(any(windows, test))]
fn plain(me: &Path) -> PathBuf {
    let Some(text) = me.to_str() else {
        return me.to_path_buf();
    };
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if windows_absolute(rest) => PathBuf::from(rest),
        _ => me.to_path_buf(),
    }
}

/// An absolute Windows path, read the same way on every OS: `C:\...`, `C:/...` or `\\...`.
#[cfg(any(windows, test))]
fn windows_absolute(text: &str) -> bool {
    let b = text.as_bytes();
    let drive =
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/');
    drive || text.starts_with(r"\\")
}

/// The browser's own profile on Windows: `<LOCALAPPDATA>\Polycarp\Browser`, only when `LOCALAPPDATA` is absolute.
#[cfg(any(windows, test))]
fn windows_profile(local_app_data: Option<OsString>) -> Option<PathBuf> {
    let base = local_app_data?;
    windows_absolute(base.to_str()?).then(|| Path::new(&base).join("Polycarp").join("Browser"))
}

/// The browser's own profile on Linux: `<XDG_CONFIG_HOME>/Polycarp/Browser`, else `<HOME>/.config/Polycarp/Browser`,
/// each only when absolute. Never the lowercase `polycarp/browser`, which belongs to the retired helper.
#[cfg(any(target_os = "linux", test))]
fn linux_profile(xdg: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    let absolute = |v: &Option<OsString>| {
        v.as_ref()
            .is_some_and(|v| v.to_string_lossy().starts_with('/'))
    };
    if absolute(&xdg) {
        return Some(Path::new(&xdg?).join("Polycarp").join("Browser"));
    }
    if absolute(&home) {
        return Some(
            Path::new(&home?)
                .join(".config")
                .join("Polycarp")
                .join("Browser"),
        );
    }
    None
}

/// The extensions Polycarp loads, first among the ones to load.
fn ours(layout: &Layout) -> Vec<OsString> {
    let mut ours = vec![layout.extension.clone().into_os_string()];
    ours.extend(local_studio(&layout.local_studio_root));
    #[cfg(target_os = "macos")]
    ours.extend(theme(std::env::var_os("HOME")));
    ours
}

#[cfg(target_os = "macos")]
fn start(me: &Path) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    let layout = mac_layout(me);
    let args = arguments(ours(&layout), None, std::env::args_os().skip(1));
    std::process::Command::new(&layout.program)
        .args(args)
        .exec()
}

#[cfg(target_os = "linux")]
fn start(me: &Path) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    let layout = linux_layout(me);
    let env = std::env::var_os;
    let Some(profile) = linux_profile(env("XDG_CONFIG_HOME"), env("HOME")) else {
        no_profile("HOME")
    };
    let args = arguments(ours(&layout), Some(profile), std::env::args_os().skip(1));
    std::process::Command::new(&layout.program)
        .args(args)
        .exec()
}

#[cfg(windows)]
fn start(me: &Path) -> std::io::Error {
    let layout = windows_layout(&plain(me));
    let Some(profile) = windows_profile(std::env::var_os("LOCALAPPDATA")) else {
        no_profile("LOCALAPPDATA")
    };
    let args = arguments(ours(&layout), Some(profile), std::env::args_os().skip(1));
    match std::process::Command::new(&layout.program)
        .args(args)
        .status()
    {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(e) => e,
    }
}

/// With no folder for its own profile the browser does not start, so Helium's default profile is never used.
#[cfg(any(windows, target_os = "linux"))]
fn no_profile(variable: &str) -> ! {
    eprintln!("Polycarp Browser could not start: no folder for its profile (set {variable})");
    std::process::exit(126);
}

/// Local Studio's extension, which `polycarp browser install` puts inside the build when Polycarp carries it
/// (spec/browser.md R-B20).
fn local_studio(folder: &Path) -> Option<OsString> {
    folder
        .join("manifest.json")
        .is_file()
        .then(|| folder.to_path_buf().into_os_string())
}

/// The theme extension Polycarp writes while a Polycarp theme is in force (spec/browser.md R-B16), when it is there.
/// Chromium reads it again at each start, so a new theme shows at the next one; with no folder the browser's own look.
/// Mac only: Windows and Linux load no theme folder yet.
#[cfg(any(target_os = "macos", test))]
fn theme(home: Option<OsString>) -> Option<OsString> {
    let folder = Path::new(&home?).join("Library/Application Support/Polycarp/browser-theme");
    folder
        .join("manifest.json")
        .is_file()
        .then(|| folder.into_os_string())
}

/// What the person gave, with Polycarp's extensions first among the ones to load and, when there is one, the browser's
/// own profile right after, unless the person named a profile folder of their own. The browser restarts itself with
/// the arguments it was started with, so these may be there already. Remote debugging hands the whole browser to any
/// program on the computer, so it is never turned on. Read as Chromium reads them: without the space around them.
fn arguments(
    ours: Vec<OsString>,
    profile: Option<PathBuf>,
    given: impl Iterator<Item = OsString>,
) -> Vec<OsString> {
    arguments_as(cfg!(windows), ours, profile, given)
}

/// `windows`: read switches as Chromium on Windows does, where `/` starts one too and their names ignore case.
fn arguments_as(
    windows: bool,
    ours: Vec<OsString>,
    profile: Option<PathBuf>,
    given: impl Iterator<Item = OsString>,
) -> Vec<OsString> {
    let mut load = ours.clone();
    let mut rest = Vec::new();
    let mut switches = true;
    let mut theirs = false;
    for arg in given {
        let text = arg.to_string_lossy();
        let text = text.trim_matches(|c| matches!(c, ' ' | '\t'..='\r'));
        switches &= text != "--";
        let slash = windows && text.starts_with('/');
        let switch = if slash {
            &text[1..]
        } else {
            text.trim_start_matches('-')
        };
        let (name, value) = switch.split_once('=').unwrap_or((switch, ""));
        let name = if windows {
            name.to_ascii_lowercase()
        } else {
            name.to_string()
        };
        if !switches || !(text.starts_with('-') || slash) {
            rest.push(arg);
        } else if name.to_ascii_lowercase().starts_with("remote-debugging-") {
            // Dropped in any case on every system: the port is never opened.
        } else if name == "load-extension" {
            let more = value.split(',').filter(|m| !m.is_empty());
            load.extend(more.map(OsString::from).filter(|m| !ours.contains(m)));
        } else if name == "user-data-dir" {
            // One with no folder would leave Chromium on its default, Helium's own profile: it is dropped, and ours given.
            if !value.is_empty() {
                theirs = true;
                rest.push(arg);
            }
        } else {
            rest.push(arg);
        }
    }
    let mut first = OsString::from("--load-extension=");
    for (i, one) in load.iter().enumerate() {
        if i > 0 {
            first.push(",");
        }
        first.push(one);
    }
    rest.insert(0, first);
    if let Some(profile) = profile.filter(|_| !theirs) {
        let mut switch = OsString::from("--user-data-dir=");
        switch.push(profile);
        rest.insert(1, switch);
    }
    rest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn got(given: &[&str]) -> Vec<String> {
        with(None, given)
    }

    fn with(profile: Option<&str>, given: &[&str]) -> Vec<String> {
        let given = given.iter().map(OsString::from);
        let args = arguments(vec!["/a/ext".into()], profile.map(PathBuf::from), given);
        args.into_iter().map(|a| a.into_string().unwrap()).collect()
    }

    #[test]
    fn the_extension_is_loaded_once_beside_the_persons_own() {
        assert_eq!(got(&[]), ["--load-extension=/a/ext"]);
        let mine = ["-load-extension=/b,/a/ext", "https://example.com"];
        assert_eq!(got(&mine), ["--load-extension=/a/ext,/b", mine[1]]);
        // A bare one after ours would take its place.
        assert_eq!(got(&["--load-extension"]), ["--load-extension=/a/ext"]);
        assert_eq!(
            got(&["\t--load-extension=/b "]),
            ["--load-extension=/a/ext,/b"]
        );
        let once: Vec<String> = got(&mine);
        let again: Vec<&str> = once.iter().map(String::as_str).collect();
        assert_eq!(got(&again), once);
    }

    #[test]
    fn the_theme_folder_is_loaded_after_ours_only_while_it_holds_a_theme() {
        let home = std::env::temp_dir().join(format!("launcher-theme-{}", std::process::id()));
        let folder = home.join("Library/Application Support/Polycarp/browser-theme");
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(
            theme(Some(home.clone().into_os_string())),
            None,
            "a folder with no manifest is no theme"
        );
        std::fs::write(folder.join("manifest.json"), "{}").unwrap();
        let found = theme(Some(home.clone().into_os_string())).unwrap();
        assert_eq!(found, folder.clone().into_os_string());
        assert_eq!(theme(None), None);
        let ours = vec![OsString::from("/a/ext"), found.clone()];
        let line = format!("--load-extension=/a/ext,{}", folder.display());
        let once = arguments(
            ours.clone(),
            None,
            [OsString::from("--load-extension=/b")].into_iter(),
        );
        assert_eq!(once, [OsString::from(format!("{line},/b"))]);
        // The browser restarts itself with these: still each one once.
        assert_eq!(arguments(ours, None, once.clone().into_iter()), once);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn local_studio_is_loaded_only_when_the_app_has_it_inside() {
        let contents = std::env::temp_dir().join(format!("launcher-ls-{}", std::process::id()));
        let me = contents.join("MacOS").join("Polycarp Browser");
        let folder = contents
            .join("Resources")
            .join("polycarp")
            .join("local-studio");
        assert_eq!(mac_layout(&me).local_studio_root, folder);
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(local_studio(&mac_layout(&me).local_studio_root), None);
        std::fs::write(folder.join("manifest.json"), "{}").unwrap();
        assert_eq!(
            local_studio(&mac_layout(&me).local_studio_root),
            Some(folder.into_os_string())
        );
        std::fs::remove_dir_all(&contents).unwrap();
    }

    #[test]
    fn remote_debugging_is_never_passed_on() {
        let given = [
            "--remote-debugging-port=9222",
            "-remote-debugging-pipe",
            " --remote-debugging-port=9222",
            "\u{b}--remote-debugging-port=9222\n",
            "x",
        ];
        assert_eq!(got(&given), ["--load-extension=/a/ext", "x"]);
        assert_eq!(
            with(Some("/p"), &given),
            ["--load-extension=/a/ext", "--user-data-dir=/p", "x"]
        );
    }

    fn on_windows(profile: Option<&str>, given: &[&str]) -> Vec<String> {
        let given = given.iter().map(OsString::from);
        let args = arguments_as(
            true,
            vec!["/a/ext".into()],
            profile.map(PathBuf::from),
            given,
        );
        args.into_iter().map(|a| a.into_string().unwrap()).collect()
    }

    #[test]
    fn windows_switches_with_a_slash_or_any_case_are_read_as_switches() {
        let debugging = [
            "/remote-debugging-port=9222",
            "--Remote-Debugging-Port=1",
            "/REMOTE-DEBUGGING-PIPE",
            "x",
        ];
        assert_eq!(
            on_windows(Some("/p"), &debugging),
            ["--load-extension=/a/ext", "--user-data-dir=/p", "x"]
        );
        assert_eq!(
            on_windows(Some("/p"), &["/User-Data-Dir=C:\\mine", "x"]),
            ["--load-extension=/a/ext", "/User-Data-Dir=C:\\mine", "x"]
        );
        assert_eq!(
            on_windows(None, &["/Load-Extension=/b", "x"]),
            ["--load-extension=/a/ext,/b", "x"]
        );
        // Elsewhere a slash starts a path, not a switch.
        let given = ["/user-data-dir=/mine"].iter().map(OsString::from);
        let elsewhere = arguments_as(false, vec!["/a/ext".into()], Some("/p".into()), given);
        let elsewhere: Vec<String> = elsewhere
            .into_iter()
            .map(|a| a.into_string().unwrap())
            .collect();
        assert_eq!(
            elsewhere,
            [
                "--load-extension=/a/ext",
                "--user-data-dir=/p",
                "/user-data-dir=/mine"
            ]
        );
        // And mixed-case remote debugging is dropped on every system.
        assert_eq!(
            got(&["--Remote-Debugging-Port=1"]),
            ["--load-extension=/a/ext"]
        );
    }

    #[test]
    fn what_follows_two_dashes_is_not_a_switch() {
        let given = ["--", "--load-extension=/b"];
        assert_eq!(
            got(&given),
            ["--load-extension=/a/ext", "--", "--load-extension=/b"]
        );
        let given = [" -- ", "--load-extension=/b"];
        assert_eq!(got(&given)[1..], given);
    }

    #[test]
    fn the_mac_layout_is_the_apps_own() {
        let contents = Path::new("/A/Polycarp Browser.app/Contents");
        let layout = mac_layout(&contents.join("MacOS/Polycarp Browser"));
        assert_eq!(layout.program, contents.join("MacOS/Helium"));
        assert_eq!(
            layout.extension,
            contents.join("Resources/polycarp/extension")
        );
    }

    #[test]
    fn the_windows_layout_is_beside_chrome() {
        let dir = std::env::temp_dir().join("Polycarp Browser");
        let layout = windows_layout(&dir.join("Polycarp Browser.exe"));
        assert_eq!(layout.program, dir.join("chrome.exe"));
        assert_eq!(layout.extension, dir.join("polycarp").join("extension"));
        assert_eq!(
            layout.local_studio_root,
            dir.join("polycarp").join("local-studio")
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_layout_has_windows_paths() {
        let dir = r"C:\Users\a\AppData\Local\Programs\Polycarp Browser";
        let layout = windows_layout(&Path::new(dir).join("Polycarp Browser.exe"));
        assert_eq!(layout.program, PathBuf::from(format!(r"{dir}\chrome.exe")));
        assert_eq!(
            layout.extension,
            PathBuf::from(format!(r"{dir}\polycarp\extension"))
        );
    }

    #[test]
    fn the_linux_layout_is_beside_helium_wrapper() {
        let dir = std::env::temp_dir().join("polycarp-browser");
        let layout = linux_layout(&dir.join("polycarp-browser"));
        assert_eq!(layout.program, dir.join("helium-wrapper"));
        assert_eq!(layout.extension, dir.join("polycarp").join("extension"));
        assert_eq!(
            layout.local_studio_root,
            dir.join("polycarp").join("local-studio")
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_linux_layout_has_linux_paths() {
        let layout = linux_layout(Path::new(
            "/home/a/.local/share/polycarp-browser/polycarp-browser",
        ));
        let dir = "/home/a/.local/share/polycarp-browser";
        assert_eq!(
            layout.program,
            PathBuf::from(format!("{dir}/helium-wrapper"))
        );
        assert_eq!(
            layout.extension,
            PathBuf::from(format!("{dir}/polycarp/extension"))
        );
    }

    #[test]
    fn windows_paths_lose_only_the_verbatim_prefix() {
        let p = |s: &str| plain(Path::new(s));
        assert_eq!(
            p(r"\\?\C:\Programs\x.exe"),
            PathBuf::from(r"C:\Programs\x.exe")
        );
        assert_eq!(
            p(r"\\?\UNC\srv\share\x.exe"),
            PathBuf::from(r"\\srv\share\x.exe")
        );
        assert_eq!(p(r"C:\Programs\x.exe"), PathBuf::from(r"C:\Programs\x.exe"));
        assert_eq!(p(r"\\?\GLOBALROOT\x"), PathBuf::from(r"\\?\GLOBALROOT\x"));
    }

    #[test]
    fn the_windows_profile_is_under_local_app_data_only() {
        let base = r"C:\Users\a\AppData\Local";
        let found = windows_profile(Some(base.into())).unwrap();
        assert_eq!(found, Path::new(base).join("Polycarp").join("Browser"));
        #[cfg(windows)]
        assert_eq!(
            found,
            PathBuf::from(r"C:\Users\a\AppData\Local\Polycarp\Browser")
        );
        assert_eq!(windows_profile(None), None);
        assert_eq!(windows_profile(Some("".into())), None);
        assert_eq!(windows_profile(Some(r"AppData\Local".into())), None);
        assert_eq!(windows_profile(Some("C:".into())), None);
    }

    #[test]
    fn the_linux_profile_is_its_own_folder_under_the_config_home() {
        let home = Some(OsString::from("/home/a"));
        let xdg = linux_profile(Some("/x/cfg".into()), home.clone()).unwrap();
        assert_eq!(xdg, Path::new("/x/cfg").join("Polycarp").join("Browser"));
        let fallback = Path::new("/home/a")
            .join(".config")
            .join("Polycarp")
            .join("Browser");
        assert_eq!(linux_profile(None, home.clone()).as_ref(), Some(&fallback));
        assert_eq!(
            linux_profile(Some("cfg".into()), home.clone()).as_ref(),
            Some(&fallback)
        );
        assert_eq!(
            linux_profile(Some("".into()), home.clone()).as_ref(),
            Some(&fallback)
        );
        assert_eq!(linux_profile(None, None), None);
        assert_eq!(linux_profile(Some("cfg".into()), Some("home".into())), None);
        assert_eq!(linux_profile(Some("".into()), Some("".into())), None);
    }

    /// The retired helper owns `~/.config/polycarp/browser/` (browser/AGENTS.md); this folder is never that one.
    #[cfg(unix)]
    #[test]
    fn the_linux_profile_is_spelled_exactly() {
        let found = linux_profile(None, Some("/home/a".into())).unwrap();
        assert_eq!(found.to_str(), Some("/home/a/.config/Polycarp/Browser"));
        assert_ne!(found.to_str(), Some("/home/a/.config/polycarp/browser"));
        let xdg = linux_profile(Some("/x/cfg".into()), None).unwrap();
        assert_eq!(xdg.to_str(), Some("/x/cfg/Polycarp/Browser"));
    }

    #[test]
    fn the_browsers_own_profile_follows_our_extensions_once() {
        let ours = ["--load-extension=/a/ext", "--user-data-dir=/p"];
        assert_eq!(with(Some("/p"), &[]), ours);
        // The browser restarts with what it was given: still each switch once.
        assert_eq!(with(Some("/p"), &ours), ours);
        let mine = ["--load-extension=/b", "https://example.com"];
        assert_eq!(
            with(Some("/p"), &mine),
            ["--load-extension=/a/ext,/b", "--user-data-dir=/p", mine[1]]
        );
    }

    #[test]
    fn the_persons_own_profile_folder_stands() {
        assert_eq!(
            with(Some("/p"), &["--user-data-dir=/mine", "x"]),
            ["--load-extension=/a/ext", "--user-data-dir=/mine", "x"]
        );
        assert_eq!(
            with(Some("/p"), &[" -user-data-dir=/mine"]),
            ["--load-extension=/a/ext", " -user-data-dir=/mine"]
        );
        // One that names no folder is not the person's choice of one: it would leave Helium's own profile in force.
        for bare in ["--user-data-dir", "--user-data-dir=", " -user-data-dir= "] {
            assert_eq!(
                with(Some("/p"), &[bare, "x"]),
                ["--load-extension=/a/ext", "--user-data-dir=/p", "x"]
            );
        }
        // After two dashes it is not a switch, so ours is still given.
        assert_eq!(
            with(Some("/p"), &["--", "--user-data-dir=/mine"]),
            [
                "--load-extension=/a/ext",
                "--user-data-dir=/p",
                "--",
                "--user-data-dir=/mine"
            ]
        );
    }
}
