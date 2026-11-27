//! `polycarp sync auto on|off|status`: an opt-in run of `polycarp sync now --background` every 5 minutes. A launchd
//! agent on the Mac, a systemd user timer on Linux, a Task Scheduler entry on Windows; none needs admin rights.
//!
//! A background run prints nothing when it works. When it fails it writes one line to the sync log and waits longer
//! before the next try: 10, 20, 40, then at most 60 minutes. Any run that works, `polycarp sync now` by hand
//! included, ends the wait.
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
}
