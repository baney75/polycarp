//! `polycarp files index --watch`: one full pass, then the changes the file system reports, a few seconds after
//! they settle. A full pass again every half of `stale_hours` catches anything a watcher missed.

use super::config::Root;
use super::index::Index;
use notify::{RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

pub fn watch(
    db: &Path,
    roots: &[Root],
    extra: &[String],
    full_every: Duration,
) -> Result<(), String> {
    let mut idx = Index::open(db)?;
    let s = idx.update(roots, extra)?;
    say(&format!(
        "indexed {} files under {} folders ({} new, {} changed, {} removed)",
        s.files, s.roots, s.added, s.updated, s.removed
    ));
    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let _ = tx.send(ev.paths);
        }
    })
    .map_err(|e| format!("could not watch: {e}"))?;
    let mut watched = 0;
    for r in roots.iter().filter(|r| r.path.is_dir()) {
        match w.watch(&r.path, RecursiveMode::Recursive) {
            Ok(()) => watched += 1,
            Err(e) => say(&format!("could not watch {}: {e}", r.path.display())),
        }
    }
    if watched == 0 {
        return Err("none of the folders could be watched".into());
    }
    say(&format!("watching {watched} folders"));
    let mut last_full = Instant::now();
    loop {
        let mut batch: BTreeSet<PathBuf> = BTreeSet::new();
        match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(p) => batch.extend(p),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err("the watcher stopped".into()),
        }
        // Let a burst settle: wait until 2 s pass with no event, at most 30 s.
        let start = Instant::now();
        while !batch.is_empty() && start.elapsed() < Duration::from_secs(30) {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(p) => batch.extend(p),
                Err(_) => break,
            }
        }
        if !batch.is_empty() {
            let paths: Vec<PathBuf> = batch.into_iter().collect();
            match idx.update_paths(roots, extra, &paths) {
                Ok(s) if s.added + s.updated + s.removed > 0 => say(&format!(
                    "{} new, {} changed, {} removed",
                    s.added, s.updated, s.removed
                )),
                Ok(_) => {}
                Err(e) => say(&e),
            }
        }
        if last_full.elapsed() >= full_every {
            match idx.update(roots, extra) {
                Ok(s) => say(&format!("full pass: {} files", s.files)),
                Err(e) => say(&e),
            }
            last_full = Instant::now();
        }
    }
}

fn say(line: &str) {
    eprintln!("polycarp files index: {line}");
}
