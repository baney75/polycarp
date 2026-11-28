//! `polycarp sync auto on|off|status`: an opt-in run of `polycarp sync now --background` every 5 minutes. A launchd
//! agent on the Mac, a systemd user timer on Linux, a Task Scheduler entry on Windows; none needs admin rights.
//!
//! A background run prints nothing when it works. When it fails it writes one line to the sync log and waits longer
//! before the next try: 10, 20, 40, then at most 60 minutes. Any run that works, `polycarp sync now` by hand
//! included, ends the wait.
//!
//! On a Mac a background run never lets the Keychain ask. When it would have to, the run skips its turn without
//! counting a failure, leaves `needs-keychain` ([`Paused`]) in the sync folder and logs that at most once an hour,
//! until a read of the key works again (`polycarp sync now` by hand, where the Keychain may ask).
//!
//! Test hook, never set in real use: `POLYCARP_SYNC_SERVICE=write` writes the unit files and loads nothing, so no test
//! reaches launchd, systemd or Task Scheduler.

use crate::files::config::Os;
use crate::files::service::{systemd_quote, xml_escape};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const LABEL: &str = "com.polycarp.sync";
pub const SYSTEMD: &str = "polycarp-sync";
pub const TASK: &str = "Polycarp Sync";
const TICK_MIN: u64 = 5;
const MAX_WAIT_MIN: u64 = 60;
const LOG_MAX: u64 = 1 << 20;

/// The files `on` writes, by OS. Linux has a service and its timer.
pub fn unit_paths(os: Os, home: &Path, local_app_data: Option<&Path>) -> Vec<PathBuf> {
    match os {
        Os::Mac => vec![home.join(format!("Library/LaunchAgents/{LABEL}.plist"))],
        Os::Linux => {
            let d = home.join(".config/systemd/user");
            vec![
                d.join(format!("{SYSTEMD}.service")),
                d.join(format!("{SYSTEMD}.timer")),
            ]
        }
        Os::Windows => vec![app_data(home, local_app_data).join("sync-task.xml")],
    }
}

fn app_data(home: &Path, local_app_data: Option<&Path>) -> PathBuf {
    local_app_data
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join("AppData").join("Local"))
        .join("Polycarp")
}

/// Polycarp's log folder: where a background run writes its lines.
pub fn log_path(os: Os, home: &Path, local_app_data: Option<&Path>) -> PathBuf {
    match os {
        Os::Mac => home.join("Library/Logs/polycarp-sync.log"),
        Os::Linux => home.join(".local/state/polycarp/sync.log"),
        Os::Windows => app_data(home, local_app_data).join("sync.log"),
    }
}

/// Each unit's text, in the order of `unit_paths`. `exe` is the polycarp command it runs.
/// `start` is when the Windows task's own 5-minute repeat begins (UTC, `YYYY-MM-DDTHH:MM:SSZ`), so it runs from now and
/// not only from the next logon.
pub fn render(os: Os, exe: &Path, log: &Path, user: &str, start: &str) -> Vec<String> {
    let e = exe.to_string_lossy();
    match os {
        Os::Mac => vec![format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>sync</string>
    <string>now</string>
    <string>--background</string>
  </array>
  <key>StartInterval</key><integer>{secs}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
            exe = xml_escape(&e),
            secs = TICK_MIN * 60,
            log = xml_escape(&log.to_string_lossy()),
        )],
        Os::Linux => vec![
            format!(
                "[Unit]\nDescription=Polycarp settings sync, one run\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart={} sync now --background\nNoNewPrivileges=true\nNice=10\n",
                systemd_quote(&e)
            ),
            format!(
                "[Unit]\nDescription=Polycarp settings sync every {TICK_MIN} minutes\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec={TICK_MIN}min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n"
            ),
        ],
        Os::Windows => vec![format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Polycarp settings sync every {TICK_MIN} minutes</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger><StartBoundary>{start}</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT{TICK_MIN}M</Interval></Repetition></TimeTrigger>
    <LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId><Repetition><Interval>PT{TICK_MIN}M</Interval></Repetition></LogonTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author"><Exec><Command>{conhost}</Command><Arguments>--headless "{exe}" sync now --background</Arguments></Exec></Actions>
</Task>
"#,
            // polycarp.exe is a console program; started bare, each run would open a console window. A headless
            // console host runs it with none.
            conhost = xml_escape(&system32("conhost.exe").to_string_lossy()),
            exe = xml_escape(&e),
            user = xml_escape(user),
            start = xml_escape(start),
        )],
    }
}

/// The programs `on` runs to load the units it wrote, and `off` to unload them. Fixed paths, no shell.
pub fn load_argv(os: Os, uid: Option<u32>, units: &[PathBuf]) -> Vec<(PathBuf, Vec<String>)> {
    match os {
        Os::Mac => vec![(
            PathBuf::from("/bin/launchctl"),
            vec![
                "bootstrap".into(),
                format!("gui/{}", uid.unwrap_or(0)),
                units[0].to_string_lossy().into(),
            ],
        )],
        Os::Linux => vec![
            (systemctl(), vec!["--user".into(), "daemon-reload".into()]),
            (
                systemctl(),
                vec![
                    "--user".into(),
                    "enable".into(),
                    "--now".into(),
                    format!("{SYSTEMD}.timer"),
                ],
            ),
        ],
        Os::Windows => vec![(
            schtasks(),
            vec![
                "/Create".into(),
                "/TN".into(),
                TASK.into(),
                "/XML".into(),
                units[0].to_string_lossy().into(),
                "/F".into(),
            ],
        )],
    }
}

pub fn unload_argv(os: Os, uid: Option<u32>) -> Vec<(PathBuf, Vec<String>)> {
    match os {
        Os::Mac => vec![(
            PathBuf::from("/bin/launchctl"),
            vec![
                "bootout".into(),
                format!("gui/{}/{LABEL}", uid.unwrap_or(0)),
            ],
        )],
        Os::Linux => vec![(
            systemctl(),
            vec![
                "--user".into(),
                "disable".into(),
                "--now".into(),
                format!("{SYSTEMD}.timer"),
            ],
        )],
        Os::Windows => vec![(
            schtasks(),
            vec!["/Delete".into(), "/TN".into(), TASK.into(), "/F".into()],
        )],
    }
}

fn systemctl() -> PathBuf {
    PathBuf::from("/usr/bin/systemctl")
}

fn system32(name: &str) -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join(name)
}

fn schtasks() -> PathBuf {
    system32("schtasks.exe")
}

/// The program that exits 0 only while the unit is loaded.
pub fn loaded_argv(os: Os, uid: Option<u32>) -> (PathBuf, Vec<String>) {
    match os {
        Os::Mac => (
            PathBuf::from("/bin/launchctl"),
            vec!["print".into(), format!("gui/{}/{LABEL}", uid.unwrap_or(0))],
        ),
        Os::Linux => (
            systemctl(),
            vec![
                "--user".into(),
                "is-active".into(),
                "--quiet".into(),
                format!("{SYSTEMD}.timer"),
            ],
        ),
        Os::Windows => (schtasks(), vec!["/Query".into(), "/TN".into(), TASK.into()]),
    }
}

/// How long a background run waits after failures. Kept in the sync folder as `auto.json`.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Backoff {
    pub failures: u32,
    pub next_ms: u64,
}

impl Backoff {
    /// Due once the wait is over, or when it ends further off than the longest wait, as after the clock was set back.
    pub fn due(&self, now_ms: u64) -> bool {
        now_ms >= self.next_ms || self.next_ms - now_ms > MAX_WAIT_MIN * 60_000
    }
    /// After one more failure: the wait doubles from 10 minutes up to 60.
    pub fn failed(&self, now_ms: u64) -> Backoff {
        let failures = self.failures.saturating_add(1);
        let wait = (TICK_MIN << failures.min(4)).min(MAX_WAIT_MIN);
        Backoff {
            failures,
            next_ms: now_ms + wait * 60_000,
        }
    }
    pub fn wait_min(&self, now_ms: u64) -> u64 {
        self.next_ms.saturating_sub(now_ms).div_ceil(60_000)
    }
}

/// The log line for a run skipped because the Keychain would have asked. Fixed text: nothing from the store.
pub const PAUSED_LOG: &str = "skipped: the Keychain must ask before polycarp can read the sync key, and a background run never lets it; run `polycarp sync now` once to allow it";

/// What `auto status` says while that is so.
pub const PAUSED_STATUS: &str =
    "on, but paused: run `polycarp sync now` once to allow Keychain access";

/// The skipped run's note at most this often.
pub const PAUSED_LOG_EVERY_MS: u64 = 60 * 60_000;

/// Background runs skipped since `since_ms` because the Keychain would have asked. Kept in the sync folder as
/// `needs-keychain`; any read of the key that works removes it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Paused {
    pub since_ms: u64,
    pub logged_ms: u64,
}

impl Paused {
    /// After one more skipped run: the marker to keep, and whether to log it. It logs when there was no marker, an
    /// hour after the last note, or when the clock went back past the last note.
    pub fn skipped(prev: Option<Paused>, now_ms: u64) -> (Paused, bool) {
        match prev {
            Some(p) if now_ms >= p.logged_ms && now_ms - p.logged_ms < PAUSED_LOG_EVERY_MS => {
                (p, false)
            }
            Some(p) => (
                Paused {
                    since_ms: p.since_ms.min(now_ms),
                    logged_ms: now_ms,
                },
                true,
            ),
            None => (
                Paused {
                    since_ms: now_ms,
                    logged_ms: now_ms,
                },
                true,
            ),
        }
    }
}

/// Adds one line to the log, keeping one older log of about 1 MB.
pub fn log_line(log: &Path, line: &str) {
    if let Some(d) = log.parent() {
        let _ = fs::create_dir_all(d);
    }
    if fs::metadata(log).is_ok_and(|m| m.len() > LOG_MAX) {
        let _ = fs::rename(log, log.with_extension("log.1"));
    }
    let (_, iso) = crate::theme::stamps();
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(log) {
        use std::io::Write;
        let _ = writeln!(f, "{iso} {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wait_doubles_to_an_hour_and_any_success_ends_it() {
        let b = Backoff::default();
        assert!(b.due(0));
        let waits: Vec<u64> = (0..6)
            .scan(Backoff::default(), |b, _| {
                *b = b.failed(0);
                Some(b.wait_min(0))
            })
            .collect();
        assert_eq!(waits, [10, 20, 40, 60, 60, 60]);
        let b = Backoff::default().failed(1_000);
        assert!(!b.due(1_000 + 9 * 60_000) && b.due(1_000 + 10 * 60_000));
        let mut b = Backoff::default();
        for _ in 0..100 {
            b = b.failed(0);
        }
        assert_eq!(b.wait_min(0), 60);
    }

    #[test]
    fn a_wait_set_while_the_clock_ran_ahead_ends_when_it_comes_back() {
        // A failure at a clock two days ahead; the clock is then set right.
        let ahead = 2 * 24 * 60 * 60_000;
        let b = Backoff::default().failed(ahead);
        assert!(b.due(0));
        assert!(!b.due(ahead + 60_000));
    }

    #[test]
    fn a_skipped_run_is_logged_once_an_hour() {
        let min = 60_000;
        let t = 1_000 * min;
        // No marker: log, and the pause starts now.
        assert_eq!(
            Paused::skipped(None, t),
            (
                Paused {
                    since_ms: t,
                    logged_ms: t
                },
                true
            )
        );
        let p = Paused {
            since_ms: t - 90 * min,
            logged_ms: t - 10 * min,
        };
        // Ten minutes after the last note: quiet, marker kept as it was.
        assert_eq!(Paused::skipped(Some(p), t), (p, false));
        // Just under an hour: still quiet.
        let p = Paused {
            logged_ms: t - 59 * min,
            ..p
        };
        assert_eq!(Paused::skipped(Some(p), t), (p, false));
        // An hour on: one more note, the pause keeps its start.
        let p = Paused {
            logged_ms: t - 60 * min,
            ..p
        };
        assert_eq!(
            Paused::skipped(Some(p), t),
            (
                Paused {
                    since_ms: t - 90 * min,
                    logged_ms: t
                },
                true
            )
        );
        // The clock went back past the last note: log again rather than stay quiet for days.
        let ahead = Paused {
            since_ms: t + 5 * min,
            logged_ms: t + 5 * min,
        };
        assert_eq!(
            Paused::skipped(Some(ahead), t),
            (
                Paused {
                    since_ms: t,
                    logged_ms: t
                },
                true
            )
        );
    }

    #[test]
    fn the_skip_note_names_the_fix_and_carries_nothing_from_the_store() {
        assert!(PAUSED_LOG.contains("`polycarp sync now`"));
        assert!(PAUSED_STATUS.contains("`polycarp sync now`"));
        for s in [PAUSED_LOG, PAUSED_STATUS] {
            assert!(!s.contains('{') && !s.to_lowercase().contains("secret-key"));
        }
    }

    const START: &str = "2026-11-27T05:00:00Z";

    #[test]
    fn units_run_a_quiet_sync_every_five_minutes_without_admin() {
        let exe = Path::new("/Users/d/.local/bin/polycarp");
        let log = Path::new("/Users/d/Library/Logs/polycarp-sync.log");
        let mac = &render(Os::Mac, exe, log, "d", START)[0];
        assert!(
            mac.contains("<string>--background</string>") && mac.contains("<integer>300</integer>")
        );
        assert!(!mac.contains("KeepAlive") && mac.contains(LABEL));
        let linux = render(Os::Linux, exe, log, "d", START);
        assert!(linux[0].contains("sync now --background") && linux[0].contains("Type=oneshot"));
        assert!(linux[1].contains("OnUnitActiveSec=5min"));
        let win = &render(
            Os::Windows,
            Path::new(r"C:\p\polycarp.exe"),
            log,
            "d & e",
            START,
        )[0];
        assert!(
            win.contains("PT5M") && win.contains("LeastPrivilege") && win.contains("d &amp; e")
        );
        assert!(win.contains(
            r#"<Arguments>--headless "C:\p\polycarp.exe" sync now --background</Arguments>"#
        ));
        assert!(win.contains("conhost.exe</Command>"));
        // It starts from now, not only at the next logon.
        assert!(win.contains(&format!("<StartBoundary>{START}</StartBoundary>")));
        for os in [Os::Mac, Os::Linux, Os::Windows] {
            let paths = unit_paths(os, Path::new("/h"), None);
            assert_eq!(paths.len(), render(os, exe, log, "d", START).len());
            for (prog, _) in load_argv(os, Some(501), &paths)
                .into_iter()
                .chain(unload_argv(os, Some(501)))
            {
                if os != Os::Windows {
                    // A Unix path, checked as text: on Windows `/bin/launchctl` has no drive, so is_absolute says no.
                    assert!(prog.to_string_lossy().starts_with('/'), "{prog:?}");
                }
            }
        }
        // Its own label, unit and task: none of the other services', and none retire removes.
        assert!(!crate::retire::LABELS.contains(&LABEL));
        assert_ne!(LABEL, crate::files::service::LABEL);
        assert_ne!(TASK, crate::files::service::TASK_NAME);
    }

    #[test]
    fn the_log_rolls_over_past_a_megabyte() {
        let d = std::env::temp_dir().join(format!("polycarp-sync-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let log = d.join("polycarp-sync.log");
        log_line(&log, "first");
        assert!(fs::read_to_string(&log).unwrap().ends_with(" first\n"));
        fs::write(&log, vec![b'x'; (LOG_MAX + 1) as usize]).unwrap();
        log_line(&log, "second");
        assert!(fs::read_to_string(&log).unwrap().ends_with(" second\n"));
        assert!(d.join("polycarp-sync.log.1").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn install_app_reloads_every_polycarp_launch_agent_and_no_retired_ones() {
        let script = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../spaces/scripts/install-app.sh"),
        )
        .unwrap();
        let line = script
            .lines()
            .find(|l| l.starts_with("POLYCARP_AGENT_LABELS="))
            .expect("install-app.sh defines POLYCARP_AGENT_LABELS");
        let labels: Vec<&str> = line
            .trim_start_matches("POLYCARP_AGENT_LABELS=")
            .trim_matches('"')
            .split_whitespace()
            .collect();
        let expected = [
            LABEL,
            crate::files::service::LABEL,
            crate::agent::service::Unit::Gateway.label(),
            crate::agent::service::Unit::Tunnel.label(),
        ];
        for label in expected {
            assert!(
                labels.contains(&label),
                "install-app.sh is missing LaunchAgent label {label}: {labels:?}"
            );
        }
        assert_eq!(
            labels.len(),
            expected.len(),
            "unexpected labels: {labels:?}"
        );
        for retired in crate::retire::LABELS {
            assert!(
                !labels.contains(&retired),
                "install-app.sh must not reload retired label {retired}"
            );
        }
    }
}
