//! `polycarp files index --watch`: one full pass, then the changes the file system reports, a few seconds after
//! they settle. A full pass again every half of `stale_hours` catches anything a watcher missed. If watching can't
//! start or stops, the index is rescanned every 10 minutes instead, and `doctor` says so.

use super::config::Root;
use super::index::{self, Index};
use super::rules;
use notify::{RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

/// How often the index is rescanned when watching failed.
pub const RESCAN: Duration = Duration::from_secs(600);

/// The folders under `start` the walk would enter, `start` included.
fn walkable(start: &Path, extra: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![start.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.filter_map(Result::ok) {
                let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
                let name = e.file_name().to_string_lossy().into_owned();
                if is_dir && !rules::noise_dir(&name, extra) && !rules::secret_dir(&name) {
                    stack.push(e.path());
                }
            }
        }
        out.push(dir);
    }
    out
}

/// What to watch. Per folder (Linux: inotify spends one watch on each), only the folders the walk would enter, so
/// hidden, build and secret trees never use one. Otherwise one recursive watch per root, which costs nothing per
/// folder (FSEvents, ReadDirectoryChangesW); events from skipped folders are dropped by `relevant`.
pub fn watch_plan(
    roots: &[Root],
    extra: &[String],
    per_folder: bool,
) -> Vec<(PathBuf, RecursiveMode)> {
    let mut out = Vec::new();
    for r in roots.iter().filter(|r| r.path.is_dir()) {
        if per_folder {
            out.extend(
                walkable(&r.path, extra)
                    .into_iter()
                    .map(|d| (d, RecursiveMode::NonRecursive)),
            );
        } else {
            out.push((r.path.clone(), RecursiveMode::Recursive));
        }
    }
    out
}

/// An event worth indexing: inside a root and not inside a folder the walk skips.
pub fn relevant(roots: &[Root], extra: &[String], p: &Path) -> bool {
    let Some(root) = index::owner(roots, p) else {
        return false;
    };
    let rel = p.strip_prefix(&root.path).unwrap_or(p);
    index::dir_allowed(root, rel.parent().unwrap_or(Path::new("")), extra)
}

pub fn watch(
    db: &Path,
    roots: &[Root],
    extra: &[String],
    full_every: Duration,
) -> Result<(), String> {
    let mut idx = Index::open(db)?;
    full(&mut idx, roots, extra);
    let why = events(&mut idx, roots, extra, full_every);
    say(&format!(
        "watching stopped ({why}); rescanning every {} minutes instead",
        RESCAN.as_secs() / 60
    ));
    let _ = idx.set_watch(&format!("rescan: {why}"));
    loop {
        std::thread::sleep(RESCAN);
        full(&mut idx, roots, extra);
    }
}

fn full(idx: &mut Index, roots: &[Root], extra: &[String]) {
    match idx.update(roots, extra) {
        Ok(s) => {
            say(&format!(
                "indexed {} files under {} folders ({} new, {} changed, {} removed)",
                s.files, s.roots, s.added, s.updated, s.removed
            ));
            for u in &s.unreadable {
                say(&format!("could not read {u}; kept what was indexed there"));
            }
        }
        Err(e) => say(&e),
    }
}

/// Indexes changes as they are reported. Returns only when watching failed, with the reason.
fn events(idx: &mut Index, roots: &[Root], extra: &[String], full_every: Duration) -> String {
    if std::env::var_os("POLYCARP_TEST_WATCH_FAIL").is_some() {
        return "watching was made to fail (POLYCARP_TEST_WATCH_FAIL)".into();
    }
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut w = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(e) => return format!("could not start watching: {e}"),
    };
    let per_folder = cfg!(target_os = "linux");
    let plan = watch_plan(roots, extra, per_folder);
    if plan.is_empty() {
        return "none of the folders is there to watch".into();
    }
    for (p, mode) in &plan {
        if let Err(e) = w.watch(p, *mode) {
            return format!("could not watch {}: {e}", p.display());
        }
    }
    let _ = idx.set_watch("events");
    say(&format!("watching {} folders", plan.len()));
    let mut last_full = Instant::now();
    loop {
        let mut batch: BTreeSet<PathBuf> = BTreeSet::new();
        let mut rescan = false;
        let mut take = |r: notify::Result<notify::Event>, batch: &mut BTreeSet<PathBuf>| match r {
            Ok(ev) => {
                rescan |= ev.need_rescan();
                batch.extend(ev.paths.into_iter().filter(|p| relevant(roots, extra, p)));
                None
            }
            Err(e) if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) => Some(format!("{e}")),
            Err(e) => {
                say(&format!("watcher: {e}"));
                None
            }
        };
        match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(r) => {
                if let Some(why) = take(r, &mut batch) {
                    return why;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return "the watcher stopped".into(),
        }
        // Let a burst settle: wait until 2 s pass with no event, at most 30 s.
        let start = Instant::now();
        while !batch.is_empty() && start.elapsed() < Duration::from_secs(30) {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(r) => {
                    if let Some(why) = take(r, &mut batch) {
                        return why;
                    }
                }
                Err(_) => break,
            }
        }
        // A new folder needs its own watch when watches are per folder.
        if per_folder {
            for p in batch.iter().filter(|p| p.is_dir()) {
                for d in walkable(p, extra) {
                    if let Err(e) = w.watch(&d, RecursiveMode::NonRecursive) {
                        return format!("could not watch {}: {e}", d.display());
                    }
                }
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
        if rescan || last_full.elapsed() >= full_every {
            full(idx, roots, extra);
            last_full = Instant::now();
        }
    }
}

fn say(line: &str) {
    eprintln!("polycarp files index: {line}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_folders_the_walk_enters_are_watched_or_reported() {
        // Not the system temp folder: on Windows it sits under AppData, which `never` refuses.
        let d = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/tmp")
            .join(format!("pc-files-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        for sub in [
            "notes/2026",
            ".cache/x",
            "app/node_modules/p",
            "app/.git/objects",
            "app/src",
            "polymarket/a",
        ] {
            fs::create_dir_all(d.join(sub)).unwrap();
        }
        let root = Root {
            path: d.clone(),
            text: true,
        };
        let roots = [root];
        let plan = watch_plan(&roots, &[], true);
        let mut got: Vec<String> = plan
            .iter()
            .map(|(p, m)| {
                assert_eq!(*m, RecursiveMode::NonRecursive);
                p.strip_prefix(&d)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        got.sort();
        assert_eq!(got, ["", "app", "app/src", "notes", "notes/2026"]);
        let whole = watch_plan(&roots, &[], false);
        assert_eq!(whole, vec![(d.clone(), RecursiveMode::Recursive)]);
        assert!(relevant(&roots, &[], &d.join("notes/2026/a.md")));
        assert!(
            relevant(&roots, &[], &d.join("app/node_modules")),
            "the folder itself, so its rows go"
        );
        assert!(!relevant(&roots, &[], &d.join("app/node_modules/p/x.js")));
        assert!(!relevant(&roots, &[], &d.join(".cache/x/y")));
        assert!(!relevant(&roots, &[], &d.join("polymarket/a/b.md")));
        assert!(!relevant(&roots, &[], Path::new("/elsewhere/a.md")));
        let _ = fs::remove_dir_all(&d);
    }
}
