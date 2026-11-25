//! What this device keeps on disk: a SQLite file in which every value is sealed with the device's storage key.

use crate::record::Record;
use crate::seal::Key;
use crate::secret::Secret;
use rusqlite::{params, Connection, OptionalExtension};
use std::fmt;
use std::path::Path;

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    /// It does not open with this device's key: another device's file, or one that was changed.
    Sealed,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Sqlite(e) => write!(f, "the sync file can't be used: {e}"),
            StoreError::Io(e) => write!(f, "the sync file can't be used: {e}"),
            StoreError::Sealed => {
                f.write_str("the sync file was not written by this device, or was changed")
            }
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}

pub struct Store {
    db: Connection,
    key: Key,
    names: Key,
}

impl Store {
    pub fn open(path: &Path, key: &Key) -> Result<Store, StoreError> {
        private(path)?;
        Self::with(Connection::open(path)?, key)
    }

    pub fn memory(key: &Key) -> Result<Store, StoreError> {
        Self::with(Connection::open_in_memory()?, key)
    }

    fn with(db: Connection, key: &Key) -> Result<Store, StoreError> {
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        // secure_delete writes zeros over what is deleted, so an old value does not stay in the file's free space.
        db.execute_batch(
            "PRAGMA secure_delete = ON;
             CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, sealed BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS record (name BLOB PRIMARY KEY, rev INTEGER NOT NULL, sealed BLOB NOT NULL);",
        )?;
        let (key, names) = (
            key.derive("polycarp-sync store v1", b"values"),
            key.derive("polycarp-sync store v1", b"names"),
        );
        Ok(Store { db, key, names })
    }

    pub fn get(&self, name: &str) -> Result<Option<Secret>, StoreError> {
        let ask = "SELECT sealed FROM meta WHERE name = ?1";
        let sealed: Option<Vec<u8>> = self.db.query_row(ask, [name], |r| r.get(0)).optional()?;
        let open = |s: Vec<u8>| {
            self.key
                .open(name.as_bytes(), &s)
                .map_err(|_| StoreError::Sealed)
        };
        sealed.map(open).transpose()
    }

    pub fn put(&self, name: &str, value: &[u8]) -> Result<(), StoreError> {
        let sealed = self.key.seal(name.as_bytes(), value);
        self.db.execute(
            "INSERT OR REPLACE INTO meta VALUES (?1, ?2)",
            params![name, sealed],
        )?;
        Ok(())
    }

    /// Both or neither: a member list and the key that goes with it.
    pub fn put_all(&self, values: &[(&str, &[u8])]) -> Result<(), StoreError> {
        let tx = self.db.unchecked_transaction()?;
        for (name, value) in values {
            self.put(name, value)?;
        }
        Ok(tx.commit()?)
    }

    pub fn put_records<'a>(
        &self,
        records: impl IntoIterator<Item = (u64, &'a Record)>,
    ) -> Result<(), StoreError> {
        let tx = self.db.unchecked_transaction()?;
        for (rev, record) in records {
            let name = self.name(record);
            // The place holds the revision too, so a row can't be moved to another one or given another's number.
            let sealed = self
                .key
                .seal(&place(&name, rev), record.to_bytes().expose());
            self.db.execute(
                "INSERT OR REPLACE INTO record VALUES (?1, ?2, ?3)",
                params![name, rev as i64, sealed],
            )?;
        }
        Ok(tx.commit()?)
    }

    pub fn drop_records<'a>(
        &self,
        records: impl IntoIterator<Item = &'a Record>,
    ) -> Result<(), StoreError> {
        let tx = self.db.unchecked_transaction()?;
        for record in records {
            self.db
                .execute("DELETE FROM record WHERE name = ?1", [self.name(record)])?;
        }
        Ok(tx.commit()?)
    }

    /// Every record with the revision it was written at.
    pub fn records(&self) -> Result<Vec<(u64, Record)>, StoreError> {
        let mut ask = self
            .db
            .prepare("SELECT name, rev, sealed FROM record ORDER BY rev")?;
        let mut rows = ask.query([])?;
        let mut all = Vec::new();
        while let Some(row) = rows.next()? {
            let (name, rev, sealed): (Vec<u8>, i64, Vec<u8>) =
                (row.get(0)?, row.get(1)?, row.get(2)?);
            let rev = rev as u64;
            let bytes = self
                .key
                .open(&place(&name, rev), &sealed)
                .map_err(|_| StoreError::Sealed)?;
            let record = Record::from_bytes(bytes.expose()).map_err(|_| StoreError::Sealed)?;
            all.push((rev, record));
        }
        Ok(all)
    }

    /// Forgets everything.
    pub fn wipe(&self) -> Result<(), StoreError> {
        Ok(self
            .db
            .execute_batch("BEGIN; DELETE FROM meta; DELETE FROM record; COMMIT; VACUUM;")?)
    }

    /// A row's name says nothing without the device's key: a cookie's site or a page's address is in none of it.
    fn name(&self, record: &Record) -> Vec<u8> {
        let of = format!("{}\0{}", record.kind.name(), record.key);
        self.names
            .derive("polycarp-sync row v1", of.as_bytes())
            .expose()
            .to_vec()
    }
}

fn place(name: &[u8], rev: u64) -> Vec<u8> {
    [name, &rev.to_be_bytes()].concat()
}

/// Makes the file so that only its owner can read it, before anything is in it.
fn private(path: &Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        private_dir(dir)?;
    }
    let mut new = std::fs::OpenOptions::new();
    new.write(true).create(true).truncate(false);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut new, 0o600);
    new.open(path).map(|_| ())
}

pub fn private_dir(dir: &Path) -> std::io::Result<()> {
    let mut new = std::fs::DirBuilder::new();
    new.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut new, 0o700);
    new.create(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hlc::Stamp;
    use crate::record::Kind;

    fn record(key: &str, value: &str) -> Record {
        let stamp = Stamp {
            ms: 1,
            count: 2,
            device: [3; 32],
        };
        Record {
            kind: Kind::History,
            key: key.into(),
            stamp,
            value: Some(Secret::new(value.into())),
        }
    }

    #[test]
    fn it_gives_back_what_it_was_given() {
        let key = Key::random();
        let s = Store::memory(&key).unwrap();
        assert!(s.get("a").unwrap().is_none());
        s.put_all(&[("a", b"1"), ("b", b"2")]).unwrap();
        s.put("a", b"3").unwrap();
        assert_eq!(s.get("a").unwrap().unwrap().expose(), b"3");
        let (one, two) = (
            record("https://a.example/", "{}"),
            record("https://b.example/", "{}"),
        );
        s.put_records([(1, &one), (2, &two)]).unwrap();
        s.put_records([(3, &one)]).unwrap();
        assert_eq!(s.records().unwrap(), [(2, two.clone()), (3, one)]);
        s.drop_records([&two]).unwrap();
        assert_eq!(s.records().unwrap().len(), 1);
        s.wipe().unwrap();
        assert!(s.records().unwrap().is_empty() && s.get("a").unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private_and_shows_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let name = crate::seal::random::<8>()
            .map(|b| format!("{b:02x}"))
            .concat();
        let dir = std::env::temp_dir()
            .join(format!("polycarp-sync-store-{name}"))
            .join("new");
        let (file, key) = (dir.join("sync.db"), Key::random());
        let s = Store::open(&file, &key).unwrap();
        s.put("note", b"planted-meta").unwrap();
        s.put_records([(1, &record("https://planted-site.example/", "planted-value"))])
            .unwrap();
        s.drop_records([&record("https://planted-site.example/", "")])
            .unwrap();
        s.put_records([(2, &record("https://planted-site.example/", "planted-value"))])
            .unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode(&dir), mode(&file)), (0o700, 0o600));
        for found in std::fs::read_dir(&dir).unwrap() {
            let bytes = std::fs::read(found.unwrap().path()).unwrap();
            assert!(!bytes.windows(7).any(|w| w == b"planted"));
        }
        // Another device's key opens none of it, and a row moved or renumbered does not open.
        assert!(matches!(
            Store::open(&file, &Key::random()).unwrap().get("note"),
            Err(StoreError::Sealed)
        ));
        s.db.execute("UPDATE record SET rev = 9", []).unwrap();
        assert!(matches!(s.records(), Err(StoreError::Sealed)));
        s.db.execute("UPDATE meta SET name = 'other'", []).unwrap();
        assert!(matches!(s.get("other"), Err(StoreError::Sealed)));
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }
}
