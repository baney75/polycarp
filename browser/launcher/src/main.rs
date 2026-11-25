// SPDX-License-Identifier: GPL-3.0-or-later
//! Polycarp Browser's main program. It becomes Helium's own program, which sits beside it, with Polycarp's extension
//! loaded. It keeps no state and starts nothing else.

#[cfg(unix)]
fn main() {
    use std::os::unix::process::CommandExt;
    let error = match std::env::current_exe().and_then(std::fs::canonicalize) {
        Ok(me) => {
            let contents = me.ancestors().nth(2).unwrap_or(&me);
            let extension = contents.join("Resources/polycarp/extension");
            let args = arguments(extension.into_os_string(), std::env::args_os().skip(1));
            let program = contents.join("MacOS/Helium");
            std::process::Command::new(program).args(args).exec()
        }
        Err(e) => e,
    };
    eprintln!("Polycarp Browser could not start: {error}");
    std::process::exit(126);
}

#[cfg(not(unix))]
fn main() {}

use std::ffi::OsString;

const LOAD: &str = "load-extension=";

/// What the person gave, with Polycarp's extension among the ones to load. The browser restarts itself with the
/// arguments it was started with, so the extension may be there already. Remote debugging hands the whole browser to
/// any program on the Mac, so it is never turned on.
#[cfg_attr(not(unix), allow(dead_code))]
fn arguments(extension: OsString, given: impl Iterator<Item = OsString>) -> Vec<OsString> {
    let mut load = vec![extension.clone()];
    let mut rest = Vec::new();
    let mut switches = true;
    for arg in given {
        let text = arg.to_string_lossy();
        switches &= text != "--";
        if !switches || !text.starts_with('-') {
            rest.push(arg);
        } else if let Some(more) = text.trim_start_matches('-').strip_prefix(LOAD) {
            let more = more.split(',').filter(|m| !m.is_empty());
            load.extend(more.map(OsString::from).filter(|m| *m != extension));
        } else if !text
            .trim_start_matches('-')
            .starts_with("remote-debugging-")
        {
            rest.push(arg);
        }
    }
    let mut first = OsString::from("--");
    first.push(LOAD);
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
        let args = arguments("/a/ext".into(), given);
        args.into_iter().map(|a| a.into_string().unwrap()).collect()
    }

    #[test]
    fn the_extension_is_loaded_once_beside_the_persons_own() {
        assert_eq!(got(&[]), ["--load-extension=/a/ext"]);
        let mine = ["-load-extension=/b,/a/ext", "https://example.com"];
        assert_eq!(got(&mine), ["--load-extension=/a/ext,/b", mine[1]]);
        let once: Vec<String> = got(&mine);
        let again: Vec<&str> = once.iter().map(String::as_str).collect();
        assert_eq!(got(&again), once);
    }

    #[test]
    fn remote_debugging_is_never_passed_on() {
        let given = [
            "--remote-debugging-port=9222",
            "-remote-debugging-pipe",
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
    }
}
