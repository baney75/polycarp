//! `polycarp`: one command that hands off to the existing tools.
//! Standard library only. Nothing runs through a shell.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct Tool {
    /// Subcommand name.
    sub: &'static str,
    /// Product name, for messages.
    product: &'static str,
    /// Executable name on PATH (without `.exe`).
    exe: &'static str,
    /// Environment variable that overrides the search.
    env: &'static str,
    /// Fixed install spots; `~` means the home folder.
    spots: &'static [&'static str],
    install: &'static str,
}

const SPACES: Tool = Tool {
    sub: "spaces",
    product: "BaneySpaces",
    exe: "baneyspaces",
    env: "POLYCARP_SPACES_BIN",
    spots: &[
        "~/.local/bin/baneyspaces",
        "/Applications/BaneySpaces.app/Contents/Resources/bin/baneyspaces",
    ],
    install: "https://github.com/baney75/baneyspaces",
};

const BROWSER: Tool = Tool {
    sub: "browser",
    product: "Tabkyra",
    exe: "tabkyra",
    env: "POLYCARP_BROWSER_BIN",
    spots: &[
        "~/.config/tabkyra/tabkyra",
        "/opt/homebrew/bin/tabkyra",
        "/usr/local/bin/tabkyra",
    ],
    install: "https://github.com/baney75/tabkyra",
};

const VOICE: Tool = Tool {
    sub: "voice",
    product: "Silas",
    exe: "silas",
    env: "POLYCARP_VOICE_BIN",
    spots: &["/Applications/Silas.app/Contents/MacOS/silas"],
    install: "https://github.com/baney75/silas",
};

const USAGE: &str = "\
polycarp: one command for BaneySpaces, Tabkyra and Silas

Usage:
  polycarp spaces [args...]    run the BaneySpaces command
  polycarp browser [args...]   run the Tabkyra command
  polycarp voice               open the Silas app
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

fn usable(p: &Path) -> bool {
    is_executable_file(p) && !is_self(p)
}

/// First match wins: environment override, PATH, fixed spots.
fn find(tool: &Tool) -> Option<PathBuf> {
    if let Some(v) = env::var_os(tool.env).filter(|v| !v.is_empty()) {
        let p = PathBuf::from(v);
        return usable(&p).then_some(p);
    }
    let file = if cfg!(windows) {
        format!("{}.exe", tool.exe)
    } else {
        tool.exe.to_string()
    };
    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            // Empty and relative entries would run files from the current folder.
            if dir.as_os_str().is_empty() || !dir.is_absolute() {
                continue;
            }
            let cand = dir.join(&file);
            if usable(&cand) {
                return Some(cand);
            }
        }
    }
    for spot in tool.spots {
        let cand = match spot.strip_prefix("~/") {
            Some(rest) => match home() {
                Some(h) => h.join(rest),
                None => continue,
            },
            // Tests set this so the machine's real installs are never reached.
            None if env::var_os("POLYCARP_NO_SYSTEM_SPOTS").is_some() => continue,
            None => PathBuf::from(spot),
        };
        if usable(&cand) {
            return Some(cand);
        }
    }
    None
}

fn not_found(tool: &Tool) -> i32 {
    eprintln!(
        "polycarp: {} ({}) not found. Install {} from {} or set {} to its path.",
        tool.exe, tool.sub, tool.product, tool.install, tool.env
    );
    127
}

#[cfg(unix)]
fn run(mut cmd: Command) -> i32 {
    use std::os::unix::process::CommandExt;
    let err = cmd.exec();
    eprintln!("polycarp: could not start {:?}: {err}", cmd.get_program());
    126
}

#[cfg(not(unix))]
fn run(mut cmd: Command) -> i32 {
    match cmd.status() {
        Ok(s) => s.code().unwrap_or(1),
        Err(err) => {
            eprintln!("polycarp: could not start {:?}: {err}", cmd.get_program());
            126
        }
    }
}

fn handoff(tool: &Tool, args: &[OsString]) -> i32 {
    let Some(path) = find(tool) else {
        return not_found(tool);
    };
    let mut cmd = Command::new(path);
    cmd.args(args);
    run(cmd)
}

fn voice(args: &[OsString]) -> i32 {
    if !args.is_empty() {
        eprintln!(
            "polycarp: voice has no commands yet (they arrive with baney75/silas#6). Run `polycarp voice` alone to open the app."
        );
        return 2;
    }
    #[cfg(target_os = "macos")]
    {
        // An explicit override is run directly; otherwise open the app without focus.
        if env::var_os(VOICE.env).is_none_or(|v| v.is_empty()) {
            return match Command::new("/usr/bin/open")
                .args(["-g", "-a", "Silas"])
                .status()
            {
                Ok(s) => s.code().unwrap_or(1),
                Err(e) => {
                    eprintln!("polycarp: could not run open: {e}");
                    126
                }
            };
        }
    }
    let Some(path) = find(&VOICE) else {
        return not_found(&VOICE);
    };
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

fn doctor() -> i32 {
    let mut ok = true;
    for tool in [&SPACES, &BROWSER, &VOICE] {
        match find(tool) {
            Some(p) => {
                let mut line = format!("{}: {}", tool.sub, p.display());
                if tool.sub == "browser" {
                    if let Some(v) = first_version_line(&p) {
                        line.push_str(&format!(" ({v})"));
                    }
                }
                println!("{line}");
            }
            None => {
                println!("{}: not found", tool.sub);
                if tool.sub != "voice" {
                    ok = false;
                }
            }
        }
    }
    if ok {
        0
    } else {
        1
    }
}

fn first_version_line(p: &Path) -> Option<String> {
    let out = Command::new(p)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}
