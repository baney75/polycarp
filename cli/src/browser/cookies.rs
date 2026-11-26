//! Sign-ins from another Chromium browser: each cookie is opened with that browser's key and sealed with this one's, in
//! memory only. Nothing here prints or returns a host, a name or a value.

use std::path::Path;

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection};
use sha2::{Digest, Sha256};

use super::chromium::{open, shared};
use super::keys::{Cipher, Secret};

/// Every column of a cookie that is not its value.
const COLUMNS: [&str; 18] = [
    "host_key",
    "creation_utc",
    "top_frame_site_key",
    "name",
    "path",
    "expires_utc",
    "is_secure",
    "is_httponly",
    "last_access_utc",
    "has_expires",
    "is_persistent",
    "priority",
    "samesite",
    "source_scheme",
    "source_port",
    "last_update_utc",
    "source_type",
    "has_cross_site_ancestor",
];
/// From this version on, a cookie's value is sealed with a hash of its host in front.
const WITH_HOST: i64 = 24;

#[derive(Debug, Default, PartialEq)]
pub struct Counted {
    pub came: usize,
    pub left: usize,
}

/// Fills the new `file` from the copied `source`. None where either can't be read as what it should be.
pub fn bring(file: &Path, source: &Path, theirs: &Cipher, ours: &Cipher) -> Option<Counted> {
    // The errors could quote a row, so none is kept.
    fill(file, source, theirs, ours).ok().flatten()
}

fn fill(
    file: &Path,
    source: &Path,
    theirs: &Cipher,
    ours: &Cipher,
) -> rusqlite::Result<Option<Counted>> {
    let mut db = open(file, source)?;
    let version = |db: &Connection, schema: &str| -> rusqlite::Result<i64> {
        let sql = format!("SELECT CAST(value AS INTEGER) FROM {schema}.meta WHERE key = 'version'");
        db.query_row(&sql, [], |row| row.get(0))
    };
    let (our_version, their_version) = (version(&db, "main")?, version(&db, "source")?);
    let columns = shared(&db, "cookies", &COLUMNS)?;
    if our_version < WITH_HOST || !columns.starts_with("host_key,") {
        return Ok(None);
    }
    let width = columns.split(',').count();
    let mut counted = Counted::default();
    let t = db.transaction()?;
    {
        let mut read = t.prepare(&format!(
            "SELECT {columns}, value, encrypted_value FROM source.cookies"
        ))?;
        let marks = vec!["?"; width + 2].join(",");
        let mut write = t.prepare(&format!(
            "INSERT OR IGNORE INTO main.cookies ({columns}, value, encrypted_value) VALUES ({marks})"
        ))?;
        let mut rows = read.query([])?;
        while let Some(row) = rows.next()? {
            let host: String = row.get(0)?;
            let plain = Secret::new(row.get::<_, String>(width)?.into_bytes());
            let sealed: Vec<u8> = row.get(width + 1)?;
            let value = match sealed.is_empty() {
                true => Some(with_host(&host, plain.bytes())),
                false => theirs.open(&sealed).and_then(|v| match their_version {
                    WITH_HOST.. => v.bytes().starts_with(&hash(&host)).then_some(v),
                    _ => Some(with_host(&host, v.bytes())),
                }),
            };
            let Some(sealed) = value.and_then(|v| ours.seal(&v)) else {
                counted.left += 1;
                continue;
            };
            let mut values = (0..width)
                .map(|i| row.get(i))
                .collect::<rusqlite::Result<Vec<Value>>>()?;
            values.extend([Value::Text(String::new()), Value::Blob(sealed)]);
            counted.came += write.execute(params_from_iter(values))?;
        }
    }
    t.commit()?;
    Ok(Some(counted))
}

fn hash(host: &str) -> [u8; 32] {
    Sha256::digest(host).into()
}

fn with_host(host: &str, value: &[u8]) -> Secret {
    let mut all = Vec::with_capacity(32 + value.len());
    all.extend(hash(host));
    all.extend(value);
    Secret::new(all)
}

#[cfg(test)]
pub mod tests {
    use super::super::testing::*;
    use super::*;

    /// The table as the browser makes it.
    pub const OURS: &str = "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
        INSERT INTO meta VALUES ('version', '24');
        CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL,
        name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL,
        expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
        last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL,
        priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL,
        source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,
        has_cross_site_ancestor INTEGER NOT NULL);";

    fn cipher(password: &str) -> Cipher {
        Cipher::new(&Secret::new(password.into())).unwrap()
    }

    /// One made-up cookie for `host`, sealed over `plain`.
    fn put(db: &Connection, host: &str, value: &str, sealed: &[u8]) {
        db.execute(
            "INSERT INTO cookies VALUES (1, ?1, '', 'n', ?2, ?3, '/', 9, 1, 1, 2, 1, 1, 1, 0, 2, 443, 3, 0, 0)",
            rusqlite::params![host, value, sealed],
        )
        .unwrap();
    }

    /// One with a value of "made up", sealed as `cipher` does.
    pub fn seal_one(db: &Connection, host: &str, cipher: &Cipher) {
        let sealed = cipher.seal(&with_host(host, b"made up")).unwrap();
        put(db, host, "", &sealed);
    }

    fn made(t: &Fake, version: i64) -> (std::path::PathBuf, std::path::PathBuf) {
        let (file, source) = (t.work().join("ours"), t.work().join("source"));
        for f in [&file, &source] {
            let _ = std::fs::remove_file(f);
            Connection::open(f).unwrap().execute_batch(OURS).unwrap();
        }
        let db = Connection::open(&source).unwrap();
        db.execute("UPDATE meta SET value = ?1", [version.to_string()])
            .unwrap();
        (file, source)
    }

    #[test]
    fn cookies_are_sealed_again_with_this_browsers_key() {
        let t = Fake::new();
        let (theirs, ours) = (cipher("theirs"), cipher("ours"));
        for version in [20, 24, 30] {
            let (file, source) = made(&t, version);
            let db = Connection::open(&source).unwrap();
            let plain = match version {
                20 => Secret::new(b"made up".to_vec()),
                _ => with_host("a.example", b"made up"),
            };
            put(&db, "a.example", "", &theirs.seal(&plain).unwrap());
            put(&db, "b.example", "never sealed", b"");
            let counted = bring(&file, &source, &theirs, &ours).unwrap();
            assert_eq!(counted, Counted { came: 2, left: 0 });
            let db = Connection::open(&file).unwrap();
            let mut read = db
                .prepare("SELECT host_key, value, encrypted_value, expires_utc, source_port FROM cookies ORDER BY host_key")
                .unwrap();
            let mut rows = read.query([]).unwrap();
            for (host, value) in [("a.example", "made up"), ("b.example", "never sealed")] {
                let row = rows.next().unwrap().unwrap();
                assert_eq!(row.get::<_, String>(0).unwrap(), host);
                // Nothing readable is written.
                assert_eq!(row.get::<_, String>(1).unwrap(), "");
                let sealed: Vec<u8> = row.get(2).unwrap();
                assert!(theirs
                    .open(&sealed)
                    .is_none_or(|v| !v.bytes().ends_with(value.as_bytes())));
                let opened = ours.open(&sealed).unwrap();
                assert!(opened.bytes() == with_host(host, value.as_bytes()).bytes());
                let rest: (i64, i64) = (row.get(3).unwrap(), row.get(4).unwrap());
                assert_eq!(rest, (9, 443));
            }
        }
    }

    #[test]
    fn a_cookie_that_is_not_what_it_says_is_left_and_counted() {
        let t = Fake::new();
        let (theirs, ours) = (cipher("theirs"), cipher("ours"));
        let (file, source) = made(&t, 24);
        let db = Connection::open(&source).unwrap();
        // Sealed for another host, with another key, and in a way not known.
        let moved = theirs.seal(&with_host("other.example", b"x")).unwrap();
        put(&db, "a.example", "", &moved);
        let other = cipher("another").seal(&with_host("b.example", b"x"));
        put(&db, "b.example", "", &other.unwrap());
        put(&db, "c.example", "", b"v99abcdefghijklmnop");
        put(
            &db,
            "d.example",
            "",
            &theirs.seal(&with_host("d.example", b"x")).unwrap(),
        );
        let counted = bring(&file, &source, &theirs, &ours).unwrap();
        assert_eq!(counted, Counted { came: 1, left: 3 });
    }

    #[test]
    fn a_file_that_is_not_cookies_brings_nothing() {
        let t = Fake::new();
        let (theirs, ours) = (cipher("theirs"), cipher("ours"));
        let (file, source) = made(&t, 24);
        std::fs::write(&source, "not a database at all").unwrap();
        assert!(bring(&file, &source, &theirs, &ours).is_none());
        // This browser's own table, in a form from before the host was in the seal.
        let (file, source) = made(&t, 24);
        let db = Connection::open(&file).unwrap();
        db.execute("UPDATE meta SET value = '20'", []).unwrap();
        assert!(bring(&file, &source, &theirs, &ours).is_none());
    }
}
