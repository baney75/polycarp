//! `polycarp features`: kept so older scripts get an answer. Polycarp has no parts to choose now: workspaces always
//! run, and the app doesn't read `features.toml`. This command writes nothing.

use std::ffi::OsString;

/// The one line `polycarp features` prints.
pub const ALWAYS_ON: &str = "Polycarp has no parts to turn on or off: workspaces always run.";

pub fn run(args: &[OsString]) -> i32 {
    let args: Vec<String> = args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        [] | ["list"] | ["--help"] | ["-h"] => {
            println!("{ALWAYS_ON}");
            0
        }
        // The browser was a part before it moved; turning it on or off here only says where it went.
        ["on" | "off", "browser"] => {
            eprintln!("{}", crate::BROWSER_MOVED);
            2
        }
        _ => {
            eprintln!("polycarp: {ALWAYS_ON}");
            2
        }
    }
}
