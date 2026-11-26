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
            Relay::Dir(d) => match there(d).and_then(|_| fs::read(d.join(name)).map_err(Some)) {
                Ok(b) => Ok(Some(b)),
                Err(Some(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(Some(e)) => Err(format!("could not read the relay at {}: {e}", d.display())),
                Err(None) => Err(gone(&d.display().to_string())),
            },
            Relay::Ssh { host, dir } => {
                let (code, out) = ssh(host, &get_script(dir, name), None)?;
                match code {
                    0 => unframe(&out).map(Some).ok_or_else(|| {
                        format!(
                            "the relay {host} sent {name} damaged or with other output mixed in"
                        )
                    }),
                    3 => Ok(None),
                    4 => Err(gone(&format!("{host}:{dir}"))),
                    c => Err(format!("the relay {host} did not answer (ssh exit {c})")),
                }
            }
        }
    }

    /// Puts a file whole: a temp file, then a rename once every byte is there, so no device reads half of one.
    pub fn put(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        assert!(valid_name(name), "relay names are fixed by the caller");
        match self {
            Relay::Dir(d) => {
                there(d).map_err(|_| gone(&d.display().to_string()))?;
                let tmp = d.join(format!("{name}.{}.tmp", std::process::id()));
                fs::write(&tmp, bytes)
                    .and_then(|_| fs::rename(&tmp, d.join(name)))
                    .map_err(|e| format!("could not write the relay at {}: {e}", d.display()))
            }
            Relay::Ssh { host, dir } => {
                match ssh(host, &put_script(dir, name, bytes.len()), Some(bytes))? {
                    (0, _) => Ok(()),
                    (4, _) => Err(gone(&format!("{host}:{dir}"))),
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
            Relay::Dir(d) => {
                there(d).map_err(|_| gone(&d.display().to_string()))?;
                match fs::remove_file(d.join(name)) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(format!("could not remove {name} from the relay: {e}")),
                }
            }
            Relay::Ssh { host, dir } => match ssh(host, &remove_script(dir, name), None)? {
                (0, _) => Ok(()),
                (4, _) => Err(gone(&format!("{host}:{dir}"))),
                (c, _) => Err(format!(
                    "could not remove {name} from the relay {host} (ssh exit {c})"
                )),
            },
        }
    }
}

/// The file that marks a relay folder. A relay folder must already hold it: a share that is not mounted, a folder
/// name with a typo or a home that isn't there must read as a relay that can't be reached, never as one with no
/// files, or a device would start over on its own disk.
pub const MARKER: &str = "polycarp-sync";

fn there(d: &std::path::Path) -> Result<(), Option<std::io::Error>> {
    if d.join(MARKER).is_file() {
        Ok(())
    } else {
        Err(None)
    }
}

fn gone(place: &str) -> String {
    format!(
        "the relay folder {place} is missing or has no {MARKER} file; if it is a share, mount it. A new relay \
         folder needs that file once: `mkdir -p DIR && touch DIR/{MARKER}` on the relay"
    )
}

// The remote scripts. Every name in them was checked by `valid_name` and `parse`, so none needs quoting. Exit 4: the
// relay folder or its marker is not there. Exit 3: the folder is there and the file isn't.
fn get_script(dir: &str, name: &str) -> String {
    format!(
        "test -f {dir}/{MARKER} || exit 4; test -e {dir}/{name} || exit 3; \
         printf 'PCSYNC %s\\n' \"$(wc -c < {dir}/{name} | tr -d ' ')\" && cat {dir}/{name}"
    )
}

/// `head -c` takes exactly the bytes sent and the size is checked before the rename, so a put cut off partway
/// (the sender killed, the laptop asleep) leaves the old file in place.
fn put_script(dir: &str, name: &str, len: usize) -> String {
    let tmp = format!("{dir}/{name}.$$.tmp");
    format!(
        "test -f {dir}/{MARKER} || exit 4; umask 077 && head -c {len} > {tmp} && \
         test \"$(wc -c < {tmp} | tr -d ' ')\" = {len} && mv {tmp} {dir}/{name} || {{ rm -f {tmp}; exit 1; }}"
    )
}

fn remove_script(dir: &str, name: &str) -> String {
    format!("test -f {dir}/{MARKER} || exit 4; rm -f {dir}/{name}")
}

/// The bytes after a `PCSYNC <len>` line, when exactly that many follow it. Anything a login script printed comes
/// before the marker; a short or padded reply is refused.
fn unframe(out: &[u8]) -> Option<Vec<u8>> {
    let tag = b"PCSYNC ";
    out.windows(tag.len())
        .enumerate()
        .filter(|(i, w)| *w == tag && (*i == 0 || out[i - 1] == b'\n'))
        .find_map(|(i, _)| {
            let rest = &out[i + tag.len()..];
            let nl = rest.iter().position(|&b| b == b'\n')?;
            let len: usize = std::str::from_utf8(&rest[..nl]).ok()?.parse().ok()?;
            let body = &rest[nl + 1..];
            (body.len() == len).then(|| body.to_vec())
        })
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
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
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
        assert_eq!(ssh_args("parish1", "true")[8], "--");
        assert_eq!(unframe(b"PCSYNC 3\nabc").unwrap(), b"abc");
        assert_eq!(unframe(b"welcome\nPCSYNC 3\nabc").unwrap(), b"abc");
        assert!(unframe(b"PCSYNC 4\nabc").is_none() && unframe(b"abc").is_none());
    }

    /// The remote scripts, run by a local `sh` the way the relay's would run them, in a home folder of its own.
    #[cfg(unix)]
    #[test]
    fn the_ssh_scripts_keep_the_old_file_when_a_put_is_cut_off_and_tell_missing_from_gone() {
        let home = std::env::temp_dir().join(format!("polycarp-relay-sh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join("r")).unwrap();
        let sh = |script: String, input: &[u8]| {
            let mut c = Command::new("/bin/sh")
                .args(["-c", &script])
                .current_dir(&home)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            c.stdin.take().unwrap().write_all(input).unwrap();
            let o = c.wait_with_output().unwrap();
            (o.status.code().unwrap(), o.stdout)
        };
        // No marker: every script says the folder is gone (4), and nothing is written.
        assert_eq!(sh(get_script("r", "devices.json"), b"").0, 4);
        assert_eq!(sh(put_script("r", "devices.json", 1), b"x").0, 4);
        assert_eq!(sh(remove_script("r", "devices.json"), b"").0, 4);
        assert!(!home.join("r/devices.json").exists());
        fs::write(home.join("r").join(MARKER), b"").unwrap();
        assert_eq!(sh(get_script("r", "devices.json"), b"").0, 3);
        assert_eq!(sh(put_script("r", "devices.json", 5), b"hello").0, 0);
        let (code, out) = sh(get_script("r", "devices.json"), b"");
        assert_eq!((code, unframe(&out).unwrap()), (0, b"hello".to_vec()));
        // Cut off after three of five bytes: refused, the old file stands, no temp file is left.
        assert_ne!(sh(put_script("r", "devices.json", 5), b"bye").0, 0);
        assert_eq!(fs::read(home.join("r/devices.json")).unwrap(), b"hello");
        assert_eq!(fs::read_dir(home.join("r")).unwrap().count(), 2);
        assert_eq!(sh(remove_script("r", "devices.json"), b"").0, 0);
        assert!(!home.join("r/devices.json").exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_folder_relay_round_trips_and_tells_missing_from_broken() {
        let d = std::env::temp_dir().join(format!("polycarp-relay-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let r = Relay::Dir(d.clone());
        // Not there, or there and empty, as an unmounted share is: unreachable, never "no such file".
        assert!(r.get("devices.json").is_err() && r.put("devices.json", b"x").is_err());
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("other"), b"").unwrap();
        assert!(r.get("devices.json").unwrap_err().contains("mount"));
        assert!(r.put("devices.json", b"x").is_err() && r.remove("devices.json").is_err());
        fs::write(d.join("polycarp-sync"), b"").unwrap();
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
