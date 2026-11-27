// SPDX-License-Identifier: GPL-3.0-or-later
//! Polycarp Browser's main program. It becomes Helium's own program, which sits beside it, with Polycarp's extension
//! loaded, Local Studio's when the app has it inside, and the Polycarp theme in force as a browser theme when there is one. It keeps no state and starts nothing else.

use std::ffi::OsString;
use std::os::unix::process::CommandExt;

fn main() {
    let error = match std::env::current_exe().and_then(std::fs::canonicalize) {
        Ok(me) => {
            let contents = me.ancestors().nth(2).unwrap_or(&me);
            let mut ours = vec![contents
                .join("Resources/polycarp/extension")
                .into_os_string()];
            ours.extend(local_studio(contents));
            ours.extend(theme(std::env::var_os("HOME")));
            let args = arguments(ours, std::env::args_os().skip(1));
            let program = contents.join("MacOS/Helium");
            std::process::Command::new(program).args(args).exec()
        }
        Err(e) => e,
    };
    eprintln!("Polycarp Browser could not start: {error}");
    std::process::exit(126);
}

/// Local Studio's extension, which `polycarp browser install` puts inside the app when Polycarp carries it
/// (spec/browser.md R-B20).
fn local_studio(contents: &std::path::Path) -> Option<OsString> {
    let folder = contents.join("Resources/polycarp/local-studio");
    folder
        .join("manifest.json")
        .is_file()
        .then(|| folder.into_os_string())
}

/// The theme extension Polycarp writes while a Polycarp theme is in force (spec/browser.md R-B16), when it is there.
/// Chromium reads it again at each start, so a new theme shows at the next one; with no folder the browser's own look.
fn theme(home: Option<OsString>) -> Option<OsString> {
    let folder =
        std::path::Path::new(&home?).join("Library/Application Support/Polycarp/browser-theme");
    folder
        .join("manifest.json")
        .is_file()
        .then(|| folder.into_os_string())
}

/// What the person gave, with Polycarp's extensions first among the ones to load. The browser restarts itself with the
/// arguments it was started with, so the extension may be there already. Remote debugging hands the whole browser to
/// any program on the Mac, so it is never turned on. Read as Chromium reads them: without the space around them.
fn arguments(ours: Vec<OsString>, given: impl Iterator<Item = OsString>) -> Vec<OsString> {
    let mut load = ours.clone();
    let mut rest = Vec::new();
    let mut switches = true;
    for arg in given {
        let text = arg.to_string_lossy();
        let text = text.trim_matches(|c| matches!(c, ' ' | '\t'..='\r'));
        switches &= text != "--";
        let switch = text.trim_start_matches('-');
        let (name, value) = switch.split_once('=').unwrap_or((switch, ""));
        if !switches || !text.starts_with('-') {
            rest.push(arg);
        } else if name == "load-extension" {
            let more = value.split(',').filter(|m| !m.is_empty());
            load.extend(more.map(OsString::from).filter(|m| !ours.contains(m)));
        } else if !name.starts_with("remote-debugging-") {
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
    rest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn got(given: &[&str]) -> Vec<String> {
        let given = given.iter().map(OsString::from);
        let args = arguments(vec!["/a/ext".into()], given);
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
            [OsString::from("--load-extension=/b")].into_iter(),
        );
        assert_eq!(once, [OsString::from(format!("{line},/b"))]);
        // The browser restarts itself with these: still each one once.
        assert_eq!(arguments(ours, once.clone().into_iter()), once);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn local_studio_is_loaded_only_when_the_app_has_it_inside() {
        let contents = std::env::temp_dir().join(format!("launcher-ls-{}", std::process::id()));
        let folder = contents.join("Resources/polycarp/local-studio");
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(local_studio(&contents), None);
        std::fs::write(folder.join("manifest.json"), "{}").unwrap();
        assert_eq!(local_studio(&contents), Some(folder.into_os_string()));
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
}
