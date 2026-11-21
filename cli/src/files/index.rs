//! The local index: one SQLite file with an FTS5 table over each file's name, folder and text.
//! Updated by size and modification time, so a second run only reads what changed.

use super::config::Root;
use super::rules;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  has_text INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(name, folder, body, tokenize = 'unicode61 remove_diacritics 2');
";

/// One search result. `device` is set on fleet results; `id` only means something on the device that made it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Hit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    pub id: i64,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    /// Seconds since 1970 (UTC).
    pub modified: i64,
    pub snippet: String,
    /// FTS5 bm25: lower is a better match.
    pub score: f64,
}

/// What one index run did.
#[derive(Debug, Default, Clone, Serialize, PartialEq)]
pub struct Stats {
    pub roots: usize,
    pub files: usize,
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub with_text: usize,
    pub skipped: usize,
    pub missing_roots: Vec<String>,
    /// Folders that could not be read, with the reason. Their rows were kept as they were.
    pub unreadable: Vec<String>,
}

/// The index at a glance, for `doctor`.
#[derive(Debug, Clone, Serialize)]
pub struct Info {
    pub path: String,
    pub files: i64,
    pub with_text: i64,
    pub bytes: u64,
    /// Seconds since 1970 of the last full run, if any.
    pub last_full: Option<i64>,
    /// Folders the last full run could not read.
    pub unreadable: Vec<String>,
    /// How `--watch` keeps the index current: `events`, or `rescan: <why watching failed>`.
    pub watch: Option<String>,
}

pub struct Index {
    conn: Connection,
    path: PathBuf,
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn nanos(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn db_err(e: rusqlite::Error) -> String {
    format!("index: {e}")
}

/// A file a cloud drive keeps only in the cloud. Reading it would download it, so it is indexed by name.
#[cfg(target_os = "macos")]
pub fn dataless(m: &fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    // SF_DATALESS
    m.st_flags() & 0x4000_0000 != 0
}

#[cfg(windows)]
pub fn dataless(m: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // OFFLINE, RECALL_ON_OPEN, RECALL_ON_DATA_ACCESS
    m.file_attributes() & (0x1000 | 0x4_0000 | 0x40_0000) != 0
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn dataless(_m: &fs::Metadata) -> bool {
    false
}

/// The text of a plain-text file, or None for a binary one.
fn read_text(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    f.by_ref()
        .take(rules::MAX_TEXT_BYTES)
        .read_to_end(&mut buf)
        .ok()?;
    if buf[..buf.len().min(8192)].contains(&0) {
        return None;
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// The folder shown and searched for a file: its parent, with the home folder left off.
fn folder_of(path: &Path) -> String {
    let parent = path.parent().unwrap_or(path);
    let shown = crate::home()
        .and_then(|h| parent.strip_prefix(h).ok().map(Path::to_path_buf))
        .unwrap_or_else(|| parent.to_path_buf());
    shown.to_string_lossy().into_owned()
}

/// The user's words as an FTS5 query: each word quoted (so no word is read as syntax) and matched as a prefix.
pub fn fts_query(q: &str) -> Option<String> {
    let words: Vec<String> = q
        .split_whitespace()
        .map(|w| w.replace('"', ""))
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .map(|w| format!("\"{w}\"*"))
        .collect();
    (!words.is_empty()).then(|| words.join(" "))
}

/// `path` as text with a separator on the end, for "everything under this folder".
fn under(dir: &Path) -> String {
    let mut s = dir.to_string_lossy().into_owned();
    let sep = std::path::MAIN_SEPARATOR;
    if !s.ends_with(sep) {
        s.push(sep);
    }
    s
}

/// The first string after every string that starts with `prefix`.
fn prefix_end(prefix: &str) -> String {
    let mut s = prefix.to_string();
    let last = s.pop().unwrap_or('/');
    s.push(char::from_u32(last as u32 + 1).unwrap_or(char::MAX));
    s
}

impl Index {
    /// Opens (and creates) the index for writing.
    pub fn open(path: &Path) -> Result<Index, String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)
                .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        let conn = Connection::open(path).map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(db_err)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
            .map_err(db_err)?;
        conn.execute_batch(SCHEMA).map_err(db_err)?;
        Ok(Index {
            conn,
            path: path.to_path_buf(),
        })
    }

    /// Opens an index that must already exist, for reading.
    pub fn open_read(path: &Path) -> Result<Index, String> {
        if !path.is_file() {
            return Err(format!(
                "there is no index at {} yet. Run `polycarp files index`.",
                path.display()
            ));
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_err)?;
        Ok(Index {
            conn,
            path: path.to_path_buf(),
        })
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
            .map_err(db_err)
    }

    fn meta(&self, key: &str) -> Option<String> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    fn next_run(&self) -> Result<i64, String> {
        let run = self
            .meta("run")
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
            + 1;
        self.set_meta("run", &run.to_string())?;
        Ok(run)
    }

    /// Walks every root and brings the index up to date. Rows under a root that was walked and no longer exist go,
    /// and so do rows under no root at all (a folder taken out of files.toml). A root files.toml lists that is
    /// missing (an unplugged drive) keeps its rows; a cloud folder only the default roots found leaves the roots when
    /// it is signed out, and its rows go with it.
    pub fn update(&mut self, roots: &[Root], extra: &[String]) -> Result<Stats, String> {
        self.walk_roots(roots, roots, extra, true)
    }

    /// Walks only `folders` (each under the rules of the `keep` root it is in), then drops every row under none
    /// of `keep` (the configured roots). Not a full run: doctor still goes by the last `update`.
    pub fn update_within(
        &mut self,
        folders: &[Root],
        keep: &[Root],
        extra: &[String],
    ) -> Result<Stats, String> {
        self.walk_roots(folders, keep, extra, false)
    }

    fn walk_roots(
        &mut self,
        folders: &[Root],
        keep: &[Root],
        extra: &[String],
        full: bool,
    ) -> Result<Stats, String> {
        let run = self.next_run()?;
        let mut stats = Stats::default();
        let tx = self.conn.transaction().map_err(db_err)?;
        let mut walked = Vec::new();
        for root in folders {
            if !root.path.is_dir() || rules::never(&root.path.join("x")) {
                stats.missing_roots.push(root.path.display().to_string());
                // Seen, so an outer root's sweep leaves a missing inner root's rows alone.
                self::keep(&tx, &root.path, run)?;
                continue;
            }
            stats.roots += 1;
            let owner = owner(keep, &root.path).unwrap_or(root);
            walk(&tx, owner, &root.path, extra, run, &mut stats)?;
            walked.push(&root.path);
        }
        // Every walk before any sweep: a root inside a folder an outer root skips has its rows marked seen by its own
        // walk before the outer root's sweep looks, so they keep their ids.
        for dir in walked {
            sweep(&tx, dir, run, &mut stats)?;
        }
        prune(&tx, keep, &mut stats)?;
        tx.commit().map_err(db_err)?;
        let now = now_secs().to_string();
        if full {
            let unreadable = serde_json::to_string(&stats.unreadable).unwrap_or_default();
            self.set_meta("unreadable", &unreadable)?;
            self.set_meta("last_full", &now)?;
        }
        self.set_meta("last_update", &now)?;
        Ok(stats)
    }

    /// Brings just these paths up to date (from the watcher): a file is read again, a folder walked, and a path
    /// that is gone is removed with everything under it.
    pub fn update_paths(
        &mut self,
        roots: &[Root],
        extra: &[String],
        paths: &[PathBuf],
    ) -> Result<Stats, String> {
        let run = self.next_run()?;
        let mut stats = Stats::default();
        let tx = self.conn.transaction().map_err(db_err)?;
        for p in paths {
            let Some(root) = owner(roots, p) else {
                continue;
            };
            let Ok(rel) = p.strip_prefix(&root.path) else {
                continue;
            };
            match fs::symlink_metadata(p) {
                Ok(m) if m.is_dir() => {
                    if rel.as_os_str().is_empty() || dir_allowed(root, rel, extra) {
                        walk(&tx, root, p, extra, run, &mut stats)?;
                        sweep(&tx, p, run, &mut stats)?;
                    } else {
                        remove(&tx, p, &mut stats)?;
                    }
                }
                Ok(m) if m.is_file() => {
                    if rules::allowed_in_root(&root.path, rel, extra) {
                        upsert(&tx, root, p, &m, run, &mut stats)?;
                    } else {
                        remove(&tx, p, &mut stats)?;
                    }
                }
                _ => remove(&tx, p, &mut stats)?,
            }
        }
        tx.commit().map_err(db_err)?;
        self.set_meta("last_update", &now_secs().to_string())?;
        Ok(stats)
    }

    /// Matches under `within` only (the configured roots), so a row a removed root left behind is never shown.
    pub fn search(
        &self,
        q: &str,
        kind: Option<&str>,
        limit: usize,
        within: &[Root],
    ) -> Result<Vec<Hit>, String> {
        let Some(m) = fts_query(q) else {
            return Ok(Vec::new());
        };
        if within.is_empty() {
            return Ok(Vec::new());
        }
        let mut args: Vec<SqlValue> = vec![
            m.into(),
            kind.map(str::to_string).into(),
            (limit as i64).into(),
        ];
        let mut ranges = Vec::new();
        for r in within {
            let lo = under(&r.path);
            let hi = prefix_end(&lo);
            ranges.push(format!(
                "(f.path >= ?{} AND f.path < ?{})",
                args.len() + 1,
                args.len() + 2
            ));
            args.push(lo.into());
            args.push(hi.into());
        }
        let sql = format!(
            "SELECT f.id, f.path, f.name, f.kind, f.size, f.mtime,
                    snippet(fts, -1, '[', ']', '...', 12), bm25(fts, 10.0, 4.0, 1.0) AS score
             FROM fts JOIN files f ON f.id = fts.rowid
             WHERE fts MATCH ?1 AND (?2 IS NULL OR f.kind = ?2) AND ({})
             ORDER BY score, f.mtime DESC LIMIT ?3",
            ranges.join(" OR ")
        );
        let mut stmt = self.conn.prepare(&sql).map_err(db_err)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args), |r| {
                Ok(Hit {
                    device: None,
                    id: r.get(0)?,
                    path: r.get(1)?,
                    name: r.get(2)?,
                    kind: r.get(3)?,
                    size: r.get::<_, i64>(4)? as u64,
                    modified: r.get::<_, i64>(5)? / 1_000_000_000,
                    snippet: r.get::<_, String>(6)?.replace(['\n', '\r', '\t'], " "),
                    score: r.get(7)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    /// The indexed file with this id or exact path.
    pub fn lookup(&self, id: Option<i64>, path: Option<&str>) -> Result<Option<Hit>, String> {
        self.conn
            .query_row(
                "SELECT id, path, name, kind, size, mtime FROM files WHERE id = ?1 OR path = ?2",
                params![id, path],
                |r| {
                    Ok(Hit {
                        device: None,
                        id: r.get(0)?,
                        path: r.get(1)?,
                        name: r.get(2)?,
                        kind: r.get(3)?,
                        size: r.get::<_, i64>(4)? as u64,
                        modified: r.get::<_, i64>(5)? / 1_000_000_000,
                        snippet: String::new(),
                        score: 0.0,
                    })
                },
            )
            .optional()
            .map_err(db_err)
    }

    pub fn info(&self) -> Result<Info, String> {
        let count = |sql: &str| -> Result<i64, String> {
            self.conn.query_row(sql, [], |r| r.get(0)).map_err(db_err)
        };
        let bytes = [
            self.path.clone(),
            PathBuf::from(format!("{}-wal", self.path.display())),
        ]
        .iter()
        .filter_map(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .sum();
        Ok(Info {
            path: self.path.display().to_string(),
            files: count("SELECT count(*) FROM files")?,
            with_text: count("SELECT count(*) FROM files WHERE has_text = 1")?,
            bytes,
            last_full: self.meta("last_full").and_then(|v| v.parse().ok()),
            unreadable: self
                .meta("unreadable")
                .and_then(|v| serde_json::from_str(&v).ok())
                .unwrap_or_default(),
            watch: self.meta("watch"),
        })
    }

    /// Records how `--watch` keeps the index current, for `doctor`.
    pub fn set_watch(&self, mode: &str) -> Result<(), String> {
        self.set_meta("watch", mode)
    }
}

/// The root `p` is in. With one root inside another, the deepest, so a root under a folder the outer one skips
/// (`~/Library/CloudStorage/Dropbox` inside `~`) keeps its own rules.
pub fn owner<'a>(roots: &'a [Root], p: &Path) -> Option<&'a Root> {
    roots
        .iter()
        .filter(|r| p.starts_with(&r.path))
        .max_by_key(|r| r.path.components().count())
}

/// A folder inside a root that the walk would go into.
pub fn dir_allowed(root: &Root, rel: &Path, extra: &[String]) -> bool {
    !rules::never(&root.path.join(rel).join("x"))
        && rel.components().all(|c| match c {
            std::path::Component::Normal(s) => {
                let n = s.to_string_lossy();
                !rules::noise_dir(&n, extra) && !rules::secret_dir(&n)
            }
            _ => false,
        })
}

fn walk(
    tx: &Connection,
    root: &Root,
    start: &Path,
    extra: &[String],
    run: i64,
    stats: &mut Stats,
) -> Result<(), String> {
    let mut stack = vec![start.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) => {
                // Not the same as empty (a permission the service lacks, a volume that dropped): keep what the
                // index knew about it, and say so.
                keep(tx, &dir, run)?;
                stats.unreadable.push(format!("{}: {e}", dir.display()));
                continue;
            }
        };
        for entry in rd.filter_map(Result::ok) {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            // Links are never followed: they could lead out of the root or around in a circle.
            if ft.is_symlink() {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if ft.is_dir() {
                if rules::noise_dir(&name, extra) || rules::secret_dir(&name) {
                    stats.skipped += 1;
                } else {
                    stack.push(path);
                }
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let Ok(rel) = path.strip_prefix(&root.path) else {
                continue;
            };
            if !rules::allowed_in_root(&root.path, rel, extra) {
                stats.skipped += 1;
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            upsert(tx, root, &path, &meta, run, stats)?;
        }
    }
    Ok(())
}

fn upsert(
    tx: &Connection,
    root: &Root,
    path: &Path,
    meta: &fs::Metadata,
    run: i64,
    stats: &mut Stats,
) -> Result<(), String> {
    stats.files += 1;
    let p = path.to_string_lossy().into_owned();
    let size = meta.len() as i64;
    let mtime = meta.modified().map(nanos).unwrap_or(0);
    let old: Option<(i64, i64, i64)> = tx
        .prepare_cached("SELECT id, size, mtime FROM files WHERE path = ?1")
        .and_then(|mut s| {
            s.query_row([&p], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()
        })
        .map_err(db_err)?;
    if let Some((id, s, m)) = old {
        if s == size && m == mtime {
            tx.prepare_cached("UPDATE files SET seen = ?1 WHERE id = ?2")
                .and_then(|mut st| st.execute(params![run, id]))
                .map_err(db_err)?;
            stats.unchanged += 1;
            return Ok(());
        }
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let kind = rules::kind(&name);
    let text = if root.text
        && rules::text_kind(kind)
        && meta.len() <= rules::MAX_TEXT_BYTES
        && !dataless(meta)
    {
        read_text(path)
    } else {
        None
    };
    let has_text = text.is_some();
    if has_text {
        stats.with_text += 1;
    }
    let id = match old {
        Some((id, ..)) => {
            tx.prepare_cached(
                "UPDATE files SET name = ?1, kind = ?2, size = ?3, mtime = ?4, has_text = ?5, seen = ?6 WHERE id = ?7",
            )
            .and_then(|mut s| s.execute(params![name, kind, size, mtime, has_text, run, id]))
            .map_err(db_err)?;
            tx.prepare_cached("DELETE FROM fts WHERE rowid = ?1")
                .and_then(|mut s| s.execute([id]))
                .map_err(db_err)?;
            stats.updated += 1;
            id
        }
        None => {
            tx.prepare_cached(
                "INSERT INTO files(path, name, kind, size, mtime, has_text, seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .and_then(|mut s| s.execute(params![p, name, kind, size, mtime, has_text, run]))
            .map_err(db_err)?;
            stats.added += 1;
            tx.last_insert_rowid()
        }
    };
    tx.prepare_cached("INSERT INTO fts(rowid, name, folder, body) VALUES (?1, ?2, ?3, ?4)")
        .and_then(|mut s| s.execute(params![id, name, folder_of(path), text.unwrap_or_default()]))
        .map_err(db_err)?;
    Ok(())
}

/// Marks every row under `dir` as seen, so the sweep leaves them.
fn keep(tx: &Connection, dir: &Path, run: i64) -> Result<(), String> {
    let lo = under(dir);
    let hi = prefix_end(&lo);
    tx.execute(
        "UPDATE files SET seen = ?1 WHERE path >= ?2 AND path < ?3",
        params![run, lo, hi],
    )
    .map(|_| ())
    .map_err(db_err)
}

/// Removes rows under `dir` that this run did not see.
fn sweep(tx: &Connection, dir: &Path, run: i64, stats: &mut Stats) -> Result<(), String> {
    let lo = under(dir);
    let hi = prefix_end(&lo);
    let ids: Vec<i64> = tx
        .prepare("SELECT id FROM files WHERE path >= ?1 AND path < ?2 AND seen != ?3")
        .and_then(|mut s| {
            s.query_map(params![lo, hi, run], |r| r.get(0))?
                .collect::<Result<Vec<i64>, _>>()
        })
        .map_err(db_err)?;
    delete_ids(tx, &ids, stats)
}

/// Removes every row under none of `keep`.
fn prune(tx: &Connection, keep: &[Root], stats: &mut Stats) -> Result<(), String> {
    let prefixes: Vec<String> = keep.iter().map(|r| under(&r.path)).collect();
    let ids: Vec<i64> = tx
        .prepare("SELECT id, path FROM files")
        .and_then(|mut s| {
            s.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(db_err)?
        .into_iter()
        .filter(|(_, p)| !prefixes.iter().any(|pre| p.starts_with(pre.as_str())))
        .map(|(id, _)| id)
        .collect();
    delete_ids(tx, &ids, stats)
}

/// Removes `p` and everything under it.
fn remove(tx: &Connection, p: &Path, stats: &mut Stats) -> Result<(), String> {
    let exact = p.to_string_lossy().into_owned();
    let lo = under(p);
    let hi = prefix_end(&lo);
    let ids: Vec<i64> = tx
        .prepare("SELECT id FROM files WHERE path = ?1 OR (path >= ?2 AND path < ?3)")
        .and_then(|mut s| {
            s.query_map(params![exact, lo, hi], |r| r.get(0))?
                .collect::<Result<Vec<i64>, _>>()
        })
        .map_err(db_err)?;
    delete_ids(tx, &ids, stats)
}

fn delete_ids(tx: &Connection, ids: &[i64], stats: &mut Stats) -> Result<(), String> {
    for id in ids {
        tx.prepare_cached("DELETE FROM files WHERE id = ?1")
            .and_then(|mut s| s.execute([id]))
            .map_err(db_err)?;
        tx.prepare_cached("DELETE FROM fts WHERE rowid = ?1")
            .and_then(|mut s| s.execute([id]))
            .map_err(db_err)?;
        stats.removed += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_are_quoted_so_no_word_is_syntax() {
        assert_eq!(fts_query("sermon notes").unwrap(), "\"sermon\"* \"notes\"*");
        assert_eq!(fts_query("a\"b OR").unwrap(), "\"ab\"* \"OR\"*");
        assert!(fts_query("  -- ").is_none());
    }

    #[test]
    fn prefix_ranges_cover_only_the_folder() {
        let lo = "/a/b/".to_string();
        let hi = prefix_end(&lo);
        assert!("/a/b/c" >= lo.as_str() && "/a/b/c" < hi.as_str());
        assert!("/a/bc" < lo.as_str() || "/a/bc" >= hi.as_str());
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("polycarp-index-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn root(path: &Path) -> Root {
        Root {
            path: path.to_path_buf(),
            text: true,
        }
    }

    #[test]
    fn a_root_inside_a_skipped_folder_keeps_its_rows_and_ids_run_after_run() {
        let d = scratch("nested");
        let outer = d.join("home");
        let inner = outer.join("Library/CloudStorage/Dropbox");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("plan.md"), "zephyr").unwrap();
        fs::write(outer.join("top.md"), "quokka").unwrap();
        let roots = [root(&outer), root(&inner)];
        let mut idx = Index::open(&d.join("index.sqlite")).unwrap();
        let first = idx.update(&roots, &[]).unwrap();
        assert_eq!(first.added, 2, "{first:?}");
        let plan = inner.join("plan.md").to_string_lossy().into_owned();
        let id = idx.lookup(None, Some(&plan)).unwrap().unwrap().id;
        let again = idx.update(&roots, &[]).unwrap();
        assert_eq!((again.added, again.removed), (0, 0), "{again:?}");
        assert_eq!(idx.lookup(None, Some(&plan)).unwrap().unwrap().id, id);
        // The inner root signed out: its rows wait for it under the outer root's sweep.
        let away = d.join("away");
        fs::rename(&inner, &away).unwrap();
        let gone = idx.update(&roots, &[]).unwrap();
        assert_eq!(gone.removed, 0, "{gone:?}");
        fs::rename(&away, &inner).unwrap();
        idx.update(&roots, &[]).unwrap();
        assert_eq!(idx.lookup(None, Some(&plan)).unwrap().unwrap().id, id);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_one_folder_refresh_is_not_a_full_run() {
        let d = scratch("partial");
        let top = d.join("docs");
        fs::create_dir_all(top.join("sub")).unwrap();
        fs::write(top.join("sub/a.md"), "walrus").unwrap();
        let mut idx = Index::open(&d.join("index.sqlite")).unwrap();
        idx.update_within(&[root(&top.join("sub"))], &[root(&top)], &[])
            .unwrap();
        assert_eq!(idx.info().unwrap().last_full, None);
        idx.update(&[root(&top)], &[]).unwrap();
        assert!(idx.info().unwrap().last_full.is_some());
        let _ = fs::remove_dir_all(&d);
    }
}
