//! The watchdog: a second, windowless `baneyspaces watchdog` process that the daemon starts once it is ready and
//! starts again if it ever goes. It waits on the daemon's process handle and does nothing else.
//!
//! - A clean stop (exit code 0, or the daemon's own note in `daemon-stopped` that it put everything back) ends it.
//! - Anything else (a crash, `Stop-Process -Force`, Task Manager's End task) and it takes the daemon's lock, puts
//!   every hidden window back from `state.json` at once, then starts the daemon again with `--recover`. That daemon
//!   reads the places the dead one saved (`places` and each display's workspace in `state.json`) and puts each window
//!   that is still the same window (handle, process and class) back on its workspace, hidden or shown to match.
//!
//! GlazeWM's wm-watcher restores windows when the manager exits and stops there; komorebi's reaper drops windows
//! that are gone. This does the first, then brings the workspaces back too. A crash loop is cut short: a daemon that
//! dies within `QUICK_MS` of starting `LIMIT` times in a row is not started again (its windows are still put back).
//! `BANEYSPACES_WATCHDOG=0` in the daemon's environment starts no watchdog.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// A daemon that dies within this long of starting counts toward the crash loop.
pub const QUICK_MS: u64 = 5_000;
/// This many quick deaths in a row and the daemon is not started again.
pub const LIMIT: usize = 3;
pub const HISTORY_FILE: &str = "watchdog.json";
/// The daemon writes its pid here as the last thing a clean stop does (after every window is back).
pub const STOPPED_FILE: &str = "daemon-stopped";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Crash {
    /// When the daemon died (Unix ms).
    pub at_ms: u64,
    /// How long it had run.
    pub ran_ms: u64,
}

/// Whether to start the daemon again, given every crash so far (oldest first, the one just seen last).
pub fn should_relaunch(history: &[Crash]) -> bool {
    history.iter().rev().take_while(|c| c.ran_ms < QUICK_MS).count() < LIMIT
}

pub fn parse_history(text: &str) -> Vec<Crash> {
    serde_json::from_str::<Value>(text).ok().and_then(|v| serde_json::from_value(v["crashes"].clone()).ok()).unwrap_or_default()
}

/// The last 20 crashes, which is all `should_relaunch` ever needs.
pub fn render_history(history: &[Crash]) -> String {
    let keep = &history[history.len().saturating_sub(20)..];
    serde_json::to_string_pretty(&json!({ "crashes": keep })).unwrap_or_default()
}

/// One window's workspace as the daemon last saved it, with what tells that window apart after a restart.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    pub hwnd: i64,
    pub pid: u32,
    pub start: u64,
    pub class: String,
    pub n: u8,
}

/// What a dead daemon left in `state.json`: each window's workspace and what each display showed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Recorded {
    pub places: Vec<Place>,
    pub current: BTreeMap<String, u8>,
}

impl Recorded {
    pub fn parse(state_json: &str) -> Self {
        let v: Value = serde_json::from_str(state_json).unwrap_or(Value::Null);
        let places = serde_json::from_value(v["places"].clone()).unwrap_or_default();
        let current = v["monitors"]
            .as_object()
            .map(|m| m.iter().filter_map(|(name, x)| x["current"].as_u64().filter(|n| (1..=9).contains(n)).map(|n| (name.clone(), n as u8))).collect())
            .unwrap_or_default();
        Self { places, current }
    }

    /// The saved workspace of this window, only if it is the same window: the same handle, the same process (pid and
    /// a known start time) and the same class. A handle Windows gave to another window gets nothing.
    pub fn workspace_of(&self, hwnd: i64, pid: u32, start: u64, class: &str) -> Option<u8> {
        if start == 0 {
            return None;
        }
        self.places.iter().find(|p| p.hwnd == hwnd && p.pid == pid && p.start == start && p.class == class).map(|p| p.n).filter(|n| (1..=9).contains(n))
    }
}

/// A process start time (FILETIME: 100 ns since 1601) as Unix milliseconds.
pub fn filetime_to_unix_ms(ft: u64) -> u64 {
    (ft / 10_000).saturating_sub(11_644_473_600_000)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::paths::Paths;
    use crate::winapi;
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, WaitForSingleObject, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION};

    /// SYNCHRONIZE: wait on the process handle.
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Starts `cmd` with no console, in its own process group, out of any job the caller is in (so whatever ends the
    /// daemon's job does not end this too). A job that forbids breaking away gets a plain detached start.
    fn detached(mut cmd: Command) -> std::io::Result<Child> {
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
        cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
        cmd.spawn().or_else(|_| {
            cmd.creation_flags(base);
            cmd.spawn()
        })
    }

    /// The daemon starts its watchdog: `baneyspaces watchdog --pid <this> --start <this process's start time>`.
    pub fn spawn(log: Option<&Path>, trace: bool) -> Option<Child> {
        if std::env::var("BANEYSPACES_WATCHDOG").as_deref() == Ok("0") {
            return None;
        }
        let pid = std::process::id();
        let mut cmd = Command::new(std::env::current_exe().ok()?);
        cmd.arg("watchdog").arg("--pid").arg(pid.to_string()).arg("--start").arg(winapi::process_start(pid).to_string());
        if let Some(l) = log {
            cmd.arg("--log").arg(l);
        }
        if trace {
            cmd.arg("--trace");
        }
        detached(cmd).ok()
    }

    fn note(log: &Option<PathBuf>, msg: &str) {
        let line = format!("baneyspaces watchdog: {msg}");
        match log.as_ref().and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok()) {
            Some(mut f) => {
                let _ = writeln!(f, "{line}");
            }
            None => eprintln!("{line}"),
        }
    }

    pub fn run(pid: u32, start: u64, log: Option<PathBuf>, trace: bool) -> i32 {
        let paths = Paths::from_env();
        // The handle keeps the pid from going to another process while it is open, so the start time read after
        // opening it is the watched process's own.
        let h = unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() || winapi::process_start(pid) != start {
            if !h.is_null() {
                unsafe { CloseHandle(h) };
            }
            note(&log, &format!("daemon {pid} is not running; nothing to watch"));
            return 0;
        }
        let mut code = 0u32;
        unsafe {
            WaitForSingleObject(h, INFINITE);
            GetExitCodeProcess(h, &mut code);
            CloseHandle(h);
        }
        let ran_ms = now_ms().saturating_sub(filetime_to_unix_ms(start));
        if code == 0 || paths.read(STOPPED_FILE).is_some_and(|s| s.trim() == pid.to_string()) {
            if trace {
                note(&log, &format!("daemon {pid} stopped cleanly (exit {code})"));
            }
            return 0;
        }
        // The daemon's own lock, so a new daemon cannot start while its windows are being put back. If one already
        // holds it, that daemon put them back when it started.
        let Some(lock) = crate::daemon::single_instance(&paths) else {
            note(&log, &format!("daemon {pid} ended (exit {code:#x}); a new daemon is already running"));
            return 0;
        };
        let (shown, kept, failed) = crate::daemon::restore_from_file(&paths, true);
        note(&log, &format!("daemon {pid} ended (exit {code:#x}) after {ran_ms} ms: put back {shown} window(s), {kept} agent window(s) stay, {failed} not shown yet"));
        let mut history = parse_history(&paths.read(HISTORY_FILE).unwrap_or_default());
        history.push(Crash { at_ms: now_ms(), ran_ms });
        let _ = paths.write_atomic(HISTORY_FILE, &render_history(&history));
        unsafe { CloseHandle(lock) };
        if !should_relaunch(&history) {
            note(&log, &format!("not starting the daemon again: it ended within {} s of starting {LIMIT} times in a row. Start it with `baneyspaces daemon --background`.", QUICK_MS / 1000));
            return 0;
        }
        let log_path = log.clone().unwrap_or_else(|| paths.state.join("daemon.log"));
        let mut cmd = Command::new(std::env::current_exe().unwrap_or_default());
        cmd.arg("daemon").arg("--recover").arg("--log").arg(&log_path);
        if trace {
            cmd.arg("--trace");
        }
        match detached(cmd) {
            Ok(c) => note(&log, &format!("started the daemon again (pid {}) to put your windows back on their workspaces", c.id())),
            Err(e) => note(&log, &format!("could not start the daemon again: {e}")),
        }
        0
    }
}

#[cfg(windows)]
pub use imp::{run, spawn};

#[cfg(test)]
mod tests {
    use super::*;

    fn crash(ran_ms: u64) -> Crash {
        Crash { at_ms: 0, ran_ms }
    }

    #[test]
    fn a_daemon_that_keeps_dying_at_start_is_not_started_again() {
        assert!(should_relaunch(&[crash(60_000)]));
        assert!(should_relaunch(&[crash(100), crash(100)]));
        assert!(!should_relaunch(&[crash(100), crash(100), crash(100)]));
        // One long run in between: the loop is broken, the count starts again.
        assert!(should_relaunch(&[crash(100), crash(100), crash(9_000), crash(100), crash(100)]));
        // Twenty kills of a daemon that had been up a while are not a loop.
        assert!(should_relaunch(&[crash(QUICK_MS); 20]));
    }

    #[test]
    fn the_crash_history_keeps_the_last_twenty() {
        let h: Vec<Crash> = (0..30).map(|i| Crash { at_ms: i, ran_ms: 1 }).collect();
        let back = parse_history(&render_history(&h));
        assert_eq!(back.len(), 20);
        assert_eq!(back[0].at_ms, 10);
        assert!(parse_history("not json").is_empty());
    }

    #[test]
    fn only_the_same_window_gets_its_saved_workspace_back() {
        let r = Recorded::parse(
            r#"{ "monitors": { "\\\\.\\DISPLAY1": { "slot": 0, "current": 3 }, "X": { "current": 0 } },
                 "places": [ { "hwnd": 100, "pid": 7, "start": 55, "class": "Notepad", "n": 2 } ] }"#,
        );
        assert_eq!(r.current.get("\\\\.\\DISPLAY1"), Some(&3));
        assert!(!r.current.contains_key("X"), "0 is no workspace");
        assert_eq!(r.workspace_of(100, 7, 55, "Notepad"), Some(2));
        assert_eq!(r.workspace_of(100, 7, 56, "Notepad"), None, "another process with the same pid");
        assert_eq!(r.workspace_of(100, 8, 55, "Notepad"), None);
        assert_eq!(r.workspace_of(100, 7, 55, "Other"), None, "the handle went to another window");
        assert_eq!(r.workspace_of(101, 7, 55, "Notepad"), None);
        assert_eq!(Recorded::parse("{}"), Recorded::default());
    }

    #[test]
    fn an_unknown_start_time_never_matches() {
        let r = Recorded { places: vec![Place { hwnd: 1, pid: 2, start: 0, class: "C".into(), n: 4 }], current: BTreeMap::new() };
        assert_eq!(r.workspace_of(1, 2, 0, "C"), None);
    }

    #[test]
    fn a_filetime_is_read_as_unix_milliseconds() {
        // 2026-01-01T00:00:00Z: 1767225600000 ms after 1970, 11644473600000 ms between 1601 and 1970.
        assert_eq!(filetime_to_unix_ms((1_767_225_600_000 + 11_644_473_600_000) * 10_000), 1_767_225_600_000);
        assert_eq!(filetime_to_unix_ms(0), 0);
    }
}
