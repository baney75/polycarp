//! `polycarp features`: which parts of Polycarp run. The app watches the same file
//! (`spaces/Sources/BaneySpacesCore/Features.swift` reads it) and applies a change within a second or two.

use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;

/// The browser was a third part until it moved to Tychicus; a `browser` line in an older file is ignored.
pub const PARTS: [(&str, &str, &str); 2] = [
    (
        "workspaces",
        "Workspaces",
        "Nine workspaces, the dock, the overview and the launcher.",
    ),
    (
        "voice",
        "Silas",
        "Hold a key, speak and it types. Speech stays on this Mac.",
    ),
];

const USAGE: &str = "\
usage: polycarp features                 show which parts are on
       polycarp features on <part>       turn a part on
       polycarp features off <part>      turn a part off

Parts: workspaces, voice. Both ship in the one app. A part that's off doesn't run,
asks macOS for nothing and downloads nothing. To remove what a part downloaded, use Settings > General.
The browser helper is now Tychicus: https://github.com/baney75/tychicus
";

/// Anything missing counts as on, so a damaged line can't take away something that worked.
pub fn parse(text: &str) -> [bool; 2] {
    let mut on = [true; 2];
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("");
        if let Some((key, value)) = line.split_once('=') {
            if value.trim() == "false" {
                if let Some(i) = PARTS.iter().position(|p| p.0 == key.trim()) {
                    on[i] = false;
                }
            }
        }
    }
    on
}

pub fn render(on: [bool; 2]) -> String {
    let mut out =
        String::from("# Which parts of Polycarp run. Change it in Settings > General or with `polycarp features`.\n");
    for (i, part) in PARTS.iter().enumerate() {
        out.push_str(&format!("{} = {}\n", part.0, on[i]));
    }
    out
}

/// Applies `on`/`off` to a state. Err when the name is unknown, or when it would turn off the last part.
pub fn change(state: [bool; 2], verb: &str, part: &str) -> Result<[bool; 2], String> {
    let Some(i) = PARTS.iter().position(|p| p.0 == part) else {
        return Err(format!("no part called {part}. Parts: workspaces, voice"));
    };
    let mut next = state;
    next[i] = verb == "on";
    if next == [false; 2] {
        return Err("that would turn off all of Polycarp. To stop it, quit the app.".into());
    }
    Ok(next)
}

fn file() -> Result<PathBuf, String> {
    let dir = crate::theme::config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("features.toml"))
}

pub fn run(args: &[OsString]) -> i32 {
    let args: Vec<String> = args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let path = match file() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("polycarp: {e}");
            return 1;
        }
    };
    let state = parse(&fs::read_to_string(&path).unwrap_or_default());
    match args.as_slice() {
        [] | ["list"] => {
            for (i, part) in PARTS.iter().enumerate() {
                println!(
                    "{:<4}{:<12}{}",
                    if state[i] { "on" } else { "off" },
                    part.0,
                    part.2
                );
            }
            0
        }
        ["--help"] | ["-h"] => {
            print!("{USAGE}");
            0
        }
        // The browser was a part before it moved; turning it on or off here only says where it went.
        ["on" | "off", "browser"] => {
            eprintln!("{}", crate::BROWSER_MOVED);
            2
        }
        [verb @ ("on" | "off"), part] => match change(state, verb, part) {
            Ok(next) => {
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                match fs::write(&path, render(next)) {
                    Ok(()) => {
                        let title = PARTS.iter().find(|p| p.0 == *part).map_or(*part, |p| p.1);
                        println!("{title} is {verb}.");
                        0
                    }
                    Err(e) => {
                        eprintln!("polycarp: can't write {}: {e}", path.display());
                        1
                    }
                }
            }
            Err(e) => {
                eprintln!("polycarp: {e}");
                2
            }
        },
        _ => {
            eprint!("{USAGE}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_round_trips() {
        let state = [false, true];
        assert_eq!(parse(&render(state)), state);
        assert!(render(state).contains("workspaces = false\n"));
        assert!(
            !render(state).contains("browser"),
            "the browser is Tychicus now"
        );
    }

    #[test]
    fn only_an_explicit_false_turns_a_part_off() {
        assert_eq!(parse(""), [true; 2]);
        assert_eq!(parse("voice = maybe\nnonsense\nbrowser"), [true; 2]);
        assert_eq!(parse("voice = false # not today\n"), [true, false]);
        // A file from before the browser moved still reads.
        assert_eq!(
            parse("workspaces = true\nvoice = true\nbrowser = false\n"),
            [true; 2]
        );
    }

    #[test]
    fn a_change_names_a_real_part() {
        assert_eq!(change([true; 2], "off", "voice"), Ok([true, false]));
        assert_eq!(change([true, false], "on", "voice"), Ok([true; 2]));
        assert!(change([true; 2], "off", "browser")
            .unwrap_err()
            .contains("no part called browser"));
        assert!(change([true; 2], "off", "typo")
            .unwrap_err()
            .contains("no part called typo"));
    }

    #[test]
    fn the_last_part_cannot_be_turned_off() {
        assert!(change([false, true], "off", "voice").is_err());
    }
}
