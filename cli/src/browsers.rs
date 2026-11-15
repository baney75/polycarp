//! Which browsers run with the extension, read from their own folders: no helper, no bridge. The update's reload step
//! asks this when the helper's `status --json` names no browser, because a read just after the helper was replaced can
//! miss one that runs (Parish1, the deploy of 53e4c4b). The same checks as `browserRunning` and
//! `extensionInProfile` in browser/cli/src/install.ts.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// `EXTENSION_ID` in browser/cli/src/install.ts: the unpacked and bundled copies.
const EXTENSION_ID: &str = "kenehmggpggpiolepbjojeenmeapgfoc";

/// Each browser's user-data folder, as `browserDirs()` in browser/cli/src/install.ts names them.
fn dirs(home: &Path) -> Vec<(&'static str, PathBuf)> {
    let (base, list): (PathBuf, &[(&str, &str)]) = if cfg!(target_os = "macos") {
        (
            home.join("Library/Application Support"),
            &[
                ("Helium", "net.imput.helium"),
                ("Chrome", "Google/Chrome"),
                ("Chrome Beta", "Google/Chrome Beta"),
                ("Chrome Canary", "Google/Chrome Canary"),
                ("Chromium", "Chromium"),
                ("Brave", "BraveSoftware/Brave-Browser"),
                ("Edge", "Microsoft Edge"),
                ("Arc", "Arc/User Data"),
                ("Vivaldi", "Vivaldi"),
                ("Opera", "com.operasoftware.Opera"),
            ],
        )
    } else if cfg!(target_os = "linux") {
        (
            std::env::var_os("XDG_CONFIG_HOME")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config")),
            &[
                ("Helium", "net.imput.helium"),
                ("Chrome", "google-chrome"),
                ("Chrome Beta", "google-chrome-beta"),
                ("Chromium", "chromium"),
                ("Brave", "BraveSoftware/Brave-Browser"),
                ("Edge", "microsoft-edge"),
                ("Vivaldi", "vivaldi"),
                ("Opera", "opera"),
            ],
        )
    } else {
        return Vec::new();
    };
    list.iter().map(|(name, d)| (*name, base.join(d))).collect()
}

/// The browsers on this computer that are running, with the extension on in a profile.
/// None on Windows, which has no list here: there the step trusts the helper alone, as before.
pub fn with_extension(home: &Path) -> Vec<String> {
    let dirs = dirs(home);
    if dirs.is_empty() {
        return Vec::new();
    }
    let Some(host) = hostname() else {
        return Vec::new();
    };
    running_with_extension(&dirs, &host, &alive)
}

/// The names in `dirs` whose folder holds a `SingletonLock` naming `host` and a live pid, and a profile with the
/// extension on.
fn running_with_extension(
    dirs: &[(&'static str, PathBuf)],
    host: &str,
    alive: &dyn Fn(u32) -> bool,
) -> Vec<String> {
    dirs.iter()
        .filter(|(_, dir)| locked_by(dir, host, alive) && extension_on(dir))
        .map(|(name, _)| name.to_string())
        .collect()
}

/// Chromium keeps a `SingletonLock` link in its user-data folder while it runs, naming "host-pid". One from another
/// computer, or from a process that is gone, is left from a crash.
fn locked_by(dir: &Path, host: &str, alive: &dyn Fn(u32) -> bool) -> bool {
    let Ok(lock) = fs::read_link(dir.join("SingletonLock")) else {
        return false;
    };
    let lock = lock.to_string_lossy();
    match lock.rsplit_once('-') {
        Some((h, pid)) if h == host => pid.parse().is_ok_and(|p: u32| p > 0 && alive(p)),
        _ => false,
    }
}

/// A profile lists the extension under `extensions.settings` in Preferences or Secure Preferences, with no disable
/// reason (a list in current Chromium, a bit mask in older ones).
fn extension_on(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .any(|e| {
            ["Preferences", "Secure Preferences"].iter().any(|file| {
                let Ok(text) = fs::read_to_string(e.path().join(file)) else {
                    return false;
                };
                let Ok(v) = serde_json::from_str::<Value>(&text) else {
                    return false;
                };
                let Some(ext) = v.pointer(&format!("/extensions/settings/{EXTENSION_ID}")) else {
                    return false;
                };
                match ext.get("disable_reasons") {
                    Some(Value::Array(list)) => list.is_empty(),
                    Some(Value::Number(n)) => n.as_u64() == Some(0),
                    _ => true,
                }
            })
        })
}

/// What Node's `os.hostname()` gives, which is what Chromium writes in the lock.
fn hostname() -> Option<String> {
    let text = if cfg!(target_os = "linux") {
        fs::read_to_string("/proc/sys/kernel/hostname").ok()?
    } else {
        let out = std::process::Command::new("/bin/hostname").output().ok()?;
        String::from_utf8(out.stdout).ok()?
    };
    Some(text.trim().to_string()).filter(|h| !h.is_empty())
}

fn alive(pid: u32) -> bool {
    if cfg!(target_os = "linux") {
        return Path::new("/proc").join(pid.to_string()).exists();
    }
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

// Unix only: the lock is a symlink there, and Windows has no browser list here yet.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn browser(root: &Path, lock: Option<&str>, prefs: Option<&str>) -> PathBuf {
        let dir = root.join("net.imput.helium");
        fs::create_dir_all(dir.join("Default")).unwrap();
        if let Some(lock) = lock {
            std::os::unix::fs::symlink(lock, dir.join("SingletonLock")).unwrap();
        }
        if let Some(prefs) = prefs {
            fs::write(dir.join("Default/Preferences"), prefs).unwrap();
        }
        dir
    }

    fn root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("polycarp-browsers-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        root
    }

    const ON: &str = r#"{"extensions":{"settings":{"kenehmggpggpiolepbjojeenmeapgfoc":{"disable_reasons":[]}}}}"#;

    #[test]
    fn a_running_browser_counts_only_with_its_lock_live_and_the_extension_on() {
        let alive = |pid: u32| pid == 702688;
        let cases = [
            ("on", Some("parish1-702688"), Some(ON), true),
            ("gone", Some("parish1-1"), Some(ON), false),
            ("other-host", Some("chapel1-702688"), Some(ON), false),
            ("closed", None, Some(ON), false),
            (
                "no-extension",
                Some("parish1-702688"),
                Some(r#"{"extensions":{"settings":{}}}"#),
                false,
            ),
            (
                "disabled",
                Some("parish1-702688"),
                Some(
                    r#"{"extensions":{"settings":{"kenehmggpggpiolepbjojeenmeapgfoc":{"disable_reasons":[1]}}}}"#,
                ),
                false,
            ),
            (
                "old-mask",
                Some("parish1-702688"),
                Some(
                    r#"{"extensions":{"settings":{"kenehmggpggpiolepbjojeenmeapgfoc":{"disable_reasons":0}}}}"#,
                ),
                true,
            ),
        ];
        for (name, lock, prefs, want) in cases {
            let root = root(name);
            let dir = browser(&root, lock, prefs);
            let got = running_with_extension(&[("Helium", dir)], "parish1", &alive);
            assert_eq!(got == ["Helium"], want, "{name}: {got:?}");
            fs::remove_dir_all(&root).unwrap();
        }
    }

    #[test]
    fn the_folders_and_the_id_match_the_helpers() {
        // The helper's own list, so a browser it adds is not missed here.
        let install = include_str!("../../browser/cli/src/install.ts");
        assert!(install.contains(&format!("EXTENSION_ID = \"{EXTENSION_ID}\"")));
        let home = Path::new("/h");
        for (name, dir) in dirs(home) {
            let tail: Vec<String> = dir
                .strip_prefix(dirs(home)[0].1.parent().unwrap())
                .unwrap()
                .components()
                .map(|c| format!("\"{}\"", c.as_os_str().to_string_lossy()))
                .collect();
            let entry = format!("{{ name: \"{name}\", dir: join(");
            let line = install
                .lines()
                .find(|l| l.contains(&entry) && l.contains(&tail.join(", ")))
                .is_some();
            assert!(line, "{name} at {} is not in browserDirs()", dir.display());
        }
    }
}
