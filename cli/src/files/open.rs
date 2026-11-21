//! Opening a file with the system's own opener. Each program is an absolute system path or passes the same gate
//! as every other tool; nothing runs through a shell.

use super::config::Os;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// How to open: the default app, Word, a text editor, or show it in the file manager.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum With {
    Default,
    Word,
    Editor,
    Reveal,
}

impl With {
    pub fn parse(s: &str) -> Option<With> {
        match s {
            "default" => Some(With::Default),
            "word" => Some(With::Word),
            "editor" => Some(With::Editor),
            "reveal" => Some(With::Reveal),
            _ => None,
        }
    }
}

fn windows_dir() -> Option<PathBuf> {
    env::var_os("SystemRoot")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn winword() -> Option<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|v| env::var_os(v).map(PathBuf::from))
        .flat_map(|pf| {
            [
                "Microsoft Office\\root\\Office16",
                "Microsoft Office\\Office16",
            ]
            .map(|d| pf.join(d).join("WINWORD.EXE"))
        })
        .find(|p| p.is_file())
}

fn xdg_open() -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|d| d.join("xdg-open"))
        .find(|c| crate::check(c).is_ok())
}

/// The program and arguments that open `path`.
pub fn argv(os: Os, with: With, path: &Path) -> Result<(PathBuf, Vec<OsString>), String> {
    let p = path.as_os_str().to_os_string();
    match os {
        Os::Mac => {
            let open = PathBuf::from("/usr/bin/open");
            let args: Vec<OsString> = match with {
                With::Default => vec![p],
                With::Reveal => vec!["-R".into(), p],
                With::Editor => vec!["-t".into(), p],
                With::Word => vec!["-a".into(), "Microsoft Word".into(), p],
            };
            Ok((open, args))
        }
        Os::Windows => {
            let win = windows_dir().ok_or("SystemRoot is not set")?;
            match with {
                With::Default => Ok((win.join("explorer.exe"), vec![p])),
                With::Reveal => {
                    let mut a = OsString::from("/select,");
                    a.push(&p);
                    Ok((win.join("explorer.exe"), vec![a]))
                }
                With::Editor => Ok((win.join("System32").join("notepad.exe"), vec![p])),
                With::Word => winword()
                    .map(|w| (w, vec![p]))
                    .ok_or_else(|| "Microsoft Word is not installed here".to_string()),
            }
        }
        Os::Linux => {
            let x = xdg_open().ok_or("xdg-open is not installed")?;
            match with {
                With::Default | With::Editor => Ok((x, vec![p])),
                With::Reveal => Ok((
                    x,
                    vec![path.parent().unwrap_or(path).as_os_str().to_os_string()],
                )),
                With::Word => Err("Microsoft Word does not run on Linux".into()),
            }
        }
    }
}

pub fn open(path: &Path, with: With) -> Result<(), String> {
    let (prog, args) = argv(Os::current(), with, path)?;
    let status = std::process::Command::new(&prog)
        .args(&args)
        .status()
        .map_err(|e| format!("could not start {}: {e}", prog.display()))?;
    // explorer.exe answers 1 even when it opened the file.
    if status.success() || Os::current() == Os::Windows {
        Ok(())
    } else {
        Err(format!("{} failed ({status})", prog.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_openers() {
        let p = Path::new("/Users/d/a.docx");
        let (prog, args) = argv(Os::Mac, With::Word, p).unwrap();
        assert_eq!(prog, PathBuf::from("/usr/bin/open"));
        assert_eq!(
            args,
            vec![OsString::from("-a"), "Microsoft Word".into(), p.into()]
        );
        assert_eq!(argv(Os::Mac, With::Reveal, p).unwrap().1[0], "-R");
        assert_eq!(With::parse("editor"), Some(With::Editor));
        assert_eq!(With::parse("shell"), None);
    }
}
