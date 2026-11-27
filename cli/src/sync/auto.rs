//! `polycarp sync now --background`: the quiet run a 5-minute timer starts.
//!
//! A background run prints nothing when it works. When it fails it writes one line to the sync log and waits longer
//! before the next try: 10, 20, 40, then at most 60 minutes. Any run that works, `polycarp sync now` by hand
//! included, ends the wait.

use crate::files::config::Os;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const TICK_MIN: u64 = 5;
const MAX_WAIT_MIN: u64 = 60;
const LOG_MAX: u64 = 1 << 20;

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

/// How long a background run waits after failures. Kept in the sync folder as `auto.json`.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Backoff {
    pub failures: u32,
    pub next_ms: u64,
}

impl Backoff {
    pub fn due(&self, now_ms: u64) -> bool {
        now_ms >= self.next_ms
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
