//! The relay: a place every device can reach that holds only sealed files. It is a host you own reached over SSH (by
//! default Parish1, in `~/.local/share/polycarp-sync/`), or a folder, which can be on a second device. There is no
//! Polycarp server. The relay sees file names, sizes and times, never what is in them.
//!
//! The address is a setting: `ssh:HOST` or `ssh:HOST:DIR` (DIR relative to the home folder there), or `dir:/ABS/PATH`.
//! Nothing runs through a local shell; `ssh` is a fixed system path, and every name sent is checked first.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub const DEFAULT: &str = "ssh:parish1";
const DEFAULT_DIR: &str = ".local/share/polycarp-sync";

#[derive(Debug, PartialEq)]
pub enum Relay {
    Dir(PathBuf),
    Ssh { host: String, dir: String },
}

/// A file name on the relay: lowercase letters, digits, dots and dashes, not starting with a dot.
pub fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 80
        && !n.starts_with('.')
        && n.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn safe_part(s: &str, slash: bool) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-@".contains(&b) || (slash && b == b'/'))
        && !s.split('/').any(|p| p == "..")
}

impl Relay {
    pub fn parse(addr: &str) -> Result<Relay, String> {
        let bad = || {
            format!(
                "{addr} is not a relay address; use ssh:HOST, ssh:HOST:DIR or dir:/ABSOLUTE/PATH"
            )
        };
        if let Some(p) = addr.strip_prefix("dir:") {
            let p = PathBuf::from(p);
            return p.is_absolute().then_some(Relay::Dir(p)).ok_or_else(bad);
        }
        let rest = addr.strip_prefix("ssh:").ok_or_else(bad)?;
        let (host, dir) = rest.split_once(':').unwrap_or((rest, DEFAULT_DIR));
        if !safe_part(host, false) || !safe_part(dir, true) || dir.starts_with('/') {
            return Err(bad());
        }
        Ok(Relay::Ssh {
            host: host.into(),
            dir: dir.into(),
        })
    }

    /// A file's bytes, or None when the relay has no such file. An error means the relay could not be reached.
    pub fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        assert!(valid_name(name), "relay names are fixed by the caller");
        match self {
            Relay::Dir(d) => match fs::read(d.join(name)) {
                Ok(b) => Ok(Some(b)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(format!("could not read the relay at {}: {e}", d.display())),
            },
            Relay::Ssh { host, dir } => {
                // `test -e` first, so a missing file (exit 3) is told apart from an unreachable host (255).
                let script =
                    format!("if test -e {dir}/{name}; then cat {dir}/{name}; else exit 3; fi");
                let out = ssh(host, &script, None)?;
                match out.0 {
                    0 => Ok(Some(out.1)),
                    3 => Ok(None),
                    c => Err(format!("the relay {host} did not answer (ssh exit {c})")),
                }
            }
        }
    }

    /// Puts a file whole: a temp file, then a rename, so no device reads half of one.
    pub fn put(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        assert!(valid_name(name), "relay names are fixed by the caller");
        match self {
            Relay::Dir(d) => {
                fs::create_dir_all(d)
                    .map_err(|e| format!("could not make the relay {}: {e}", d.display()))?;
                let tmp = d.join(format!("{name}.tmp"));
                fs::write(&tmp, bytes)
                    .and_then(|_| fs::rename(&tmp, d.join(name)))
                    .map_err(|e| format!("could not write the relay at {}: {e}", d.display()))
            }
            Relay::Ssh { host, dir } => {
                let script =
                    format!("umask 077 && mkdir -p {dir} && cat > {dir}/{name}.tmp && mv {dir}/{name}.tmp {dir}/{name}");
                match ssh(host, &script, Some(bytes))? {
                    (0, _) => Ok(()),
                    (c, _) => Err(format!(
                        "could not write to the relay {host} (ssh exit {c})"
                    )),
                }
            }
        }
    }

    pub fn remove(&self, name: &str) -> Result<(), String> {
        assert!(valid_name(name), "relay names are fixed by the caller");
        match self {
            Relay::Dir(d) => match fs::remove_file(d.join(name)) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("could not remove {name} from the relay: {e}")),
            },
            Relay::Ssh { host, dir } => match ssh(host, &format!("rm -f {dir}/{name}"), None)? {
                (0, _) => Ok(()),
                (c, _) => Err(format!(
                    "could not remove {name} from the relay {host} (ssh exit {c})"
                )),
            },
        }
    }
}

fn ssh_program() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe")
    } else {
        PathBuf::from("/usr/bin/ssh")
    }
}

/// The arguments for one remote command: no password prompt, a short connect time, and `--` before the host.
pub fn ssh_args(host: &str, script: &str) -> Vec<String> {
    [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        host,
        script,
    ]
    .map(String::from)
    .to_vec()
}

fn ssh(host: &str, script: &str, input: Option<&[u8]>) -> Result<(i32, Vec<u8>), String> {
    let mut child = Command::new(ssh_program())
        .args(ssh_args(host, script))
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run ssh to reach the relay {host}: {e}"))?;
    if let Some(b) = input {
        let mut w = child.stdin.take().expect("piped");
        w.write_all(b)
            .map_err(|e| format!("could not send to the relay {host}: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("could not reach the relay {host}: {e}"))?;
    Ok((out.status.code().unwrap_or(255), out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        assert_eq!(
            Relay::parse("ssh:parish1").unwrap(),
            Relay::Ssh {
                host: "parish1".into(),
                dir: DEFAULT_DIR.into()
            }
        );
        assert_eq!(
            Relay::parse("ssh:me@hub.tail:sync/polycarp").unwrap(),
            Relay::Ssh {
                host: "me@hub.tail".into(),
                dir: "sync/polycarp".into()
            }
        );
        assert_eq!(
            Relay::parse("dir:/srv/r").unwrap(),
            Relay::Dir("/srv/r".into())
        );
        for bad in [
            "parish1",
            "ssh:-oProxyCommand=x",
            "ssh:h:/etc",
            "ssh:h:a/../b",
            "ssh:h;rm",
            "ssh:h:a b",
            "dir:rel",
        ] {
            assert!(Relay::parse(bad).is_err(), "{bad}");
        }
        assert!(
            valid_name("settings.age.json")
                && !valid_name("../x")
                && !valid_name(".x")
                && !valid_name("a b")
        );
        assert_eq!(ssh_args("parish1", "true")[4], "--");
    }

    #[test]
    fn a_folder_relay_round_trips_and_tells_missing_from_broken() {
        let d = std::env::temp_dir().join(format!("polycarp-relay-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let r = Relay::Dir(d.clone());
        assert_eq!(r.get("devices.json").unwrap(), None);
        r.put("devices.json", b"x").unwrap();
        assert_eq!(r.get("devices.json").unwrap().unwrap(), b"x");
        r.remove("devices.json").unwrap();
        r.remove("devices.json").unwrap();
        assert_eq!(r.get("devices.json").unwrap(), None);
        fs::write(d.join("blocked"), b"").unwrap();
        assert!(Relay::Dir(d.join("blocked")).get("devices.json").is_err());
    }
}
