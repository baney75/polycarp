//! Importing from the other Chromium browsers: bookmarks, history and sign-ins go into a new profile that this browser's own code
//! laid out, so another version's files are never opened by it. The source is copied first, and only the copy is read.

use std::fs;
use std::io;
use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::cookies::{self, Counted};
use super::import::{self, Browser, Profile};
use super::keys::{self, Cipher, Denied, Keys};
use super::tools::Tools;
use super::{clear, pages, refuse, start, Place, Refused};

const CHECK: &str = "import";
const URLS: [&str; 7] = [
    "id",
    "url",
    "title",
    "visit_count",
    "typed_count",
    "last_visit_time",
    "hidden",
];
/// What a visit is; nothing of who synced it.
const VISITS: [&str; 7] = [
    "id",
    "url",
    "visit_time",
    "from_visit",
    "transition",
    "visit_duration",
    "incremented_omnibox_typed_score",
];
const ROOTS: [&str; 3] = ["bookmark_bar", "other", "synced"];

/// What became of the sign-ins.
#[derive(Debug, Default, PartialEq)]
pub enum Cookies {
    /// There are none, or they can't be read.
    #[default]
    None,
    /// The person said no to one of the two keys.
    Declined,
    Came(Counted),
}

/// What came over. A part that could not be read is left out, and the line says so.
#[derive(Debug, Default, PartialEq)]
pub struct Brought {
    pub dir: String,
    pub bookmarks: bool,
    pub history: Option<usize>,
    pub cookies: Cookies,
    /// Web Store ids and names.
    pub extensions: Vec<(String, String)>,
}

pub fn import(
    tools: &dyn Tools,
    keys: &dyn Keys,
    place: &Place,
    from: &Browser,
    profile: &Profile,
) -> Result<Brought, Refused> {
    let app = installed(place)?;
    let mut brought = Brought::default();
    let dir = import::into_profile(place, from, &profile.name, |part| {
        let ciphers = ciphers(keys, from)?;
        let work = place.work(tools)?;
        let made = start::empty_profile(tools, &app, &work);
        let filled = made.and_then(|empty| {
            fill(&empty, &profile.folder, part, &work, ciphers, &mut brought)
                .map_err(refuse(CHECK, "writing the new profile"))
        });
        let cleared = clear(&work).map_err(refuse(CHECK, "clearing the copies"));
        filled.and(cleared)
    })?;
    brought.dir = dir;
    Ok(brought)
}

/// The app, which lays out the new profile.
pub fn installed(place: &Place) -> Result<std::path::PathBuf, Refused> {
    match place.spot.installed() {
        Some(_) => Ok(place.spot.app()),
        None => Err(Refused::new(
            CHECK,
            "Polycarp Browser is not installed; run `polycarp browser install` first",
        )),
    }
}

/// A database's file and what SQLite may keep beside it.
const BESIDE: [&str; 3] = ["", "-wal", "-journal"];

/// Their key and ours. None: the person said no, or there is no key to open theirs with.
fn ciphers(keys: &dyn Keys, from: &Browser) -> Result<Option<(Cipher, Cipher)>, Refused> {
    let get = |(service, account)| {
        let password = keys.password(service, account)?;
        Cipher::new(&password).ok_or(Denied::Declined)
    };
    let ours = match get(keys::OURS) {
        Ok(ours) => ours,
        Err(Denied::Declined) => return Ok(None),
        Err(Denied::Missing) => {
            let why = "Polycarp Browser has no key yet. Open it once, quit it, and import again";
            return Err(Refused::new(CHECK, why));
        }
    };
    let theirs = keys::item(from).and_then(|item| get(item).ok());
    Ok(theirs.map(|theirs| (theirs, ours)))
}

fn fill(
    empty: &Path,
    from: &Path,
    part: &Path,
    work: &Path,
    ciphers: Option<(Cipher, Cipher)>,
    to: &mut Brought,
) -> io::Result<()> {
    fs::write(part.join("Preferences"), pages::first_prefs())?;
    if let Some(bookmarks) = bookmarks(from) {
        fs::write(part.join("Bookmarks"), bookmarks)?;
        to.bookmarks = true;
    }
    if let Some(copy) = copied(&from.join("History"), work)? {
        let file = part.join("History");
        // With its log: a start that ended early may not have folded it in.
        for end in BESIDE {
            let made = empty.join(format!("History{end}"));
            if made.is_file() {
                fs::copy(made, part.join(format!("History{end}")))?;
            }
        }
        // Its own errors could quote a row, so none is kept.
        to.history = history(&file, &copy).ok();
        if to.history.is_none() {
            for end in BESIDE {
                let _ = fs::remove_file(part.join(format!("History{end}")));
            }
        }
    }
    // Where newer Chromium keeps them, and where this one does.
    let mut cookies = copied(&from.join("Network/Cookies"), work)?;
    if cookies.is_none() {
        cookies = copied(&from.join("Cookies"), work)?;
    }
    to.cookies = match (cookies, ciphers) {
        (None, _) => Cookies::None,
        (Some(_), None) => Cookies::Declined,
        (Some(copy), Some((theirs, ours))) => {
            let file = part.join("Cookies");
            // With its log, as History is.
            for end in BESIDE {
                let made = empty.join(format!("Cookies{end}"));
                if made.is_file() {
                    fs::copy(made, part.join(format!("Cookies{end}")))?;
                }
            }
            match cookies::bring(&file, &copy, &theirs, &ours) {
                Some(counted) => Cookies::Came(counted),
                None => {
                    for end in BESIDE {
                        let _ = fs::remove_file(part.join(format!("Cookies{end}")));
                    }
                    Cookies::None
                }
            }
        }
    };
    to.extensions = extensions(from);
    Ok(())
}

/// The database at `file`, with what it has not yet folded in, copied where only this person can read. None: there isn't one.
pub fn copied(file: &Path, work: &Path) -> io::Result<Option<std::path::PathBuf>> {
    let Some(name) = file.file_name().and_then(|n| n.to_str()) else {
        return Ok(None);
    };
    let is_file = |f: &Path| fs::symlink_metadata(f).is_ok_and(|m| m.is_file());
    if !is_file(file) {
        return Ok(None);
    }
    let copy = work.join(format!("source {name}"));
    for end in BESIDE {
        let from = file.with_file_name(format!("{name}{end}"));
        if is_file(&from) {
            fs::copy(from, work.join(format!("source {name}{end}")))?;
        }
    }
    Ok(Some(copy))
}

/// The folders of bookmarks, without the sync state beside them.
fn bookmarks(from: &Path) -> Option<String> {
    let file = from.join("Bookmarks");
    if !fs::symlink_metadata(&file).ok()?.is_file() {
        return None;
    }
    let all: Value = serde_json::from_slice(&fs::read(file).ok()?).ok()?;
    let mut roots = Map::new();
    for root in ROOTS {
        let found = all["roots"].get(root).filter(|r| r.is_object());
        // All three must be there, or Chromium reads none of them.
        roots.insert(root.into(), found?.clone());
    }
    Some(json!({ "roots": roots, "version": 1 }).to_string())
}

/// Columns of `table` that both databases have.
pub fn shared(db: &Connection, table: &str, wanted: &[&str]) -> rusqlite::Result<String> {
    let of = |schema: &str| -> rusqlite::Result<Vec<String>> {
        let mut columns = db.prepare("SELECT name FROM pragma_table_info(?1, ?2)")?;
        let names = columns.query_map([table, schema], |row| row.get(0))?;
        names.collect()
    };
    let (ours, theirs) = (of("main")?, of("source")?);
    let both = |c: &&&str| ours.iter().any(|o| o == **c) && theirs.iter().any(|t| t == **c);
    Ok(wanted
        .iter()
        .filter(both)
        .copied()
        .collect::<Vec<_>>()
        .join(","))
}

/// Opens `file` for writing with the copied `source` beside it.
pub fn open(file: &Path, source: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(file)?;
    db.execute(
        "ATTACH ?1 AS source",
        [source.to_string_lossy().into_owned()],
    )?;
    Ok(db)
}

/// Web pages visited. Returns how many.
fn history(file: &Path, source: &Path) -> rusqlite::Result<usize> {
    let mut db = open(file, source)?;
    let (urls, visits) = (shared(&db, "urls", &URLS)?, shared(&db, "visits", &VISITS)?);
    let t = db.transaction()?;
    // All of what the start's own visit left, so nothing points at a page by a number the import then gives another.
    let tables: Vec<String> = t
        .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'meta'")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for table in tables {
        t.execute(
            &format!("DELETE FROM main.\"{}\"", table.replace('"', "\"\"")),
            [],
        )?;
    }
    let web = "url LIKE 'http://%' OR url LIKE 'https://%'";
    let count = t.execute(
        &format!("INSERT INTO main.urls ({urls}) SELECT {urls} FROM source.urls WHERE {web}"),
        [],
    )?;
    let kept = "url IN (SELECT id FROM main.urls)";
    t.execute(
        &format!(
            "INSERT INTO main.visits ({visits}) SELECT {visits} FROM source.visits WHERE {kept}"
        ),
        [],
    )?;
    t.commit()?;
    Ok(count)
}

/// The Web Store extensions that are on, by id and name. Their data and settings stay where they are.
fn extensions(from: &Path) -> Vec<(String, String)> {
    let mut all = Vec::new();
    for file in ["Secure Preferences", "Preferences"] {
        let file = from.join(file);
        // Not what a link leads to.
        let plain = fs::symlink_metadata(&file).is_ok_and(|m| m.is_file());
        let text = plain
            .then(|| fs::read(&file).ok())
            .flatten()
            .unwrap_or_default();
        let prefs: Value = serde_json::from_slice(&text).unwrap_or_default();
        for (id, about) in prefs["extensions"]["settings"]
            .as_object()
            .into_iter()
            .flatten()
        {
            let real = id.len() == 32 && id.bytes().all(|b| b.is_ascii_lowercase() && b <= b'p');
            let update = about["manifest"]["update_url"].as_str().unwrap_or_default();
            let store = about["from_webstore"] == true && update.contains("clients2.google.com");
            let on = about["state"].as_i64().unwrap_or(1) == 1
                && about["disable_reasons"].as_i64().unwrap_or(0) == 0
                && about["disable_reasons"]
                    .as_array()
                    .is_none_or(Vec::is_empty);
            // Installed by the person, not by the browser.
            if real && store && on && about["location"] == 1 {
                let name = about["manifest"]["name"].as_str().unwrap_or_default();
                let name = name.strip_prefix("__MSG_").map_or(name, |_| "");
                let name = name.chars().filter(|c| !c.is_control()).collect();
                all.push((id.clone(), name));
            }
        }
    }
    all.sort();
    all.dedup_by(|a, b| a.0 == b.0);
    all
}

impl Brought {
    pub fn text(&self, from: &Browser, profile: &Profile) -> String {
        let part = |what: &str, came: bool| match came {
            true => what.to_string(),
            false => format!("no {what}"),
        };
        let history = match self.history {
            Some(n) => format!("history ({n} pages)"),
            None => "no history".into(),
        };
        let cookies = match &self.cookies {
            Cookies::None => "no sign-ins".into(),
            Cookies::Declined => "no sign-ins (macOS gave no key for them, or you said no)".into(),
            Cookies::Came(Counted { came, left: 0 }) => format!("sign-ins ({came} cookies)"),
            Cookies::Came(Counted { came, left }) => {
                format!("sign-ins ({came} cookies; {left} could not be read)")
            }
        };
        let mut text = format!(
            "{}'s profile {} is copied ({}): {}, {history}, {cookies}. Passwords stay there.",
            from.name,
            profile.name,
            self.dir,
            part("bookmarks", self.bookmarks),
        );
        if !self.extensions.is_empty() {
            text += "\nIts extensions are yours to add again, from the Web Store:";
        }
        for (id, name) in &self.extensions {
            let line = format!("\n  https://chromewebstore.google.com/detail/{id} {name}");
            text += line.trim_end();
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use super::super::import::BROWSERS;
    use super::super::keys::Secret;
    use super::super::testing::*;
    use super::super::tools::{Call, Ran};
    use super::*;
    use std::path::PathBuf;

    const OURS: &str = "CREATE TABLE urls(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
        visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL,
        last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL);
        CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL,
        from_visit INTEGER, transition INTEGER DEFAULT 0 NOT NULL, visit_duration INTEGER DEFAULT 0 NOT NULL);
        INSERT INTO urls VALUES (1, 'http://a.invalid/', '', 1, 0, 1, 0);
        INSERT INTO visits VALUES (1, 1, 1, 0, 0, 0);
        CREATE TABLE segments(id INTEGER PRIMARY KEY, name VARCHAR, url_id INTEGER NON NULL);
        INSERT INTO segments VALUES (1, 'a.invalid', 1);
        CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
        INSERT INTO meta VALUES ('version', '70');";
    const THEIRS: &str = "CREATE TABLE urls(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
        visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER, odd TEXT);
        CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, from_visit INTEGER,
        transition INTEGER, originator_cache_guid TEXT);
        INSERT INTO urls VALUES (7, 'https://made-up.example/', 'Made up', 3, 1, 99, 0, 'x'),
            (8, 'chrome://settings/', 'Settings', 1, 0, 98, 0, 'x');
        INSERT INTO visits VALUES (70, 7, 99, 0, 1, 'device'), (80, 8, 98, 0, 1, 'device');";

    /// A browser whose first start writes an empty history, as the real one does.
    struct Starts<'a>(&'a Fake, bool, Leave);

    /// What a start that ended badly leaves.
    #[derive(PartialEq)]
    enum Leave {
        Nothing,
        /// Its history still in the log.
        Log,
        /// A helper that runs on.
        Helper,
    }

    impl Tools for Starts<'_> {
        fn run(&self, call: &Call) -> io::Result<Ran> {
            let data = call.args.iter().find_map(|a| {
                let a = a.to_str()?;
                a.strip_prefix("--user-data-dir=").map(PathBuf::from)
            });
            let first = data.expect("only the browser is started").join("Default");
            let db = Connection::open(first.join("History")).unwrap();
            if self.2 == Leave::Log {
                db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
                    .unwrap();
            }
            db.execute_batch(OURS).unwrap();
            if self.2 == Leave::Log {
                // Never closed, as when it is stopped: what it wrote stays in the log.
                std::mem::forget(db);
            }
            if self.2 == Leave::Helper {
                let app = call.program.ancestors().nth(3).unwrap();
                std::mem::forget(self.0.start_inside(app));
            }
            if self.1 {
                let db = Connection::open(first.join("Cookies")).unwrap();
                if self.2 == Leave::Log {
                    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
                        .unwrap();
                }
                db.execute_batch(cookies::tests::OURS).unwrap();
                if self.2 == Leave::Log {
                    std::mem::forget(db);
                }
            }
            self.0.run(call)
        }
    }

    /// A made-up keychain: the service's own name is its password.
    struct FakeKeys(Option<(&'static str, Denied)>);

    impl Keys for FakeKeys {
        fn password(&self, service: &str, _: &str) -> Result<Secret, Denied> {
            match self.0 {
                Some((denied, how)) if denied == service => Err(how),
                _ => Ok(Secret::new(service.into())),
            }
        }
    }

    const KEYS: FakeKeys = FakeKeys(None);

    fn cipher(service: &str) -> Cipher {
        Cipher::new(&KEYS.password(service, "").unwrap()).unwrap()
    }

    /// A made-up Chrome, and Polycarp Browser installed.
    fn made_up(t: &Fake) -> (Place, &'static Browser, Profile) {
        let place = t.place();
        t.built_app(&place.spot.app(), "1.0", 1);
        let chrome = &BROWSERS[1];
        let folder = chrome.data(&place.home).join("Default");
        fs::create_dir_all(&folder).unwrap();
        let db = Connection::open(folder.join("History")).unwrap();
        db.execute_batch(THEIRS).unwrap();
        let root = |name: &str| json!({ "type": "folder", "name": name, "children": [] });
        let bookmarks = json!({ "checksum": "x", "sync_metadata": "secret", "version": 1, "roots": {
            "bookmark_bar": root("Bar"), "other": root("Other"), "synced": root("Phone"), "trash": root("Trash") } });
        fs::write(folder.join("Bookmarks"), bookmarks.to_string()).unwrap();
        let extension = |store: bool, state: i64, name: &str| {
            json!({ "from_webstore": store, "state": state, "location": 1, "manifest": {
                "name": name, "update_url": "https://clients2.google.com/service/update2/crx" } })
        };
        let id = |c: &str| c.repeat(32);
        let settings = json!({ "extensions": { "settings": {
            id("a"): extension(true, 1, "Reader\u{7}"), id("b"): extension(true, 0, "Off"),
            id("c"): extension(false, 1, "Own"), id("d"): extension(true, 1, "__MSG_name__"),
            "z;rm": extension(true, 1, "Odd"),
        } } });
        fs::write(folder.join("Secure Preferences"), settings.to_string()).unwrap();
        let profile = Profile {
            name: "Home".into(),
            folder,
        };
        (place, chrome, profile)
    }

    #[test]
    fn bookmarks_and_web_history_come_over_and_the_original_is_left_as_it_was() {
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        let before = t.listing(&place.home);
        let brought = import(
            &Starts(&t, true, Leave::Nothing),
            &KEYS,
            &place,
            chrome,
            &profile,
        )
        .unwrap();
        assert_eq!(t.listing(&place.home), before, "the original was changed");
        assert_eq!(brought.dir, "Default");
        assert_eq!(brought.history, Some(1));
        let data = place.data.join("Default");
        let db = Connection::open(data.join("History")).unwrap();
        let all = |sql: &str| -> Vec<String> {
            let mut ask = db.prepare(sql).unwrap();
            let rows = ask.query_map([], |r| r.get(0)).unwrap();
            rows.map(Result::unwrap).collect()
        };
        assert_eq!(
            all("SELECT url || ' ' || title || ' ' || visit_count FROM urls"),
            ["https://made-up.example/ Made up 3"]
        );
        assert_eq!(all("SELECT id || ' ' || url FROM visits"), ["70 7"]);
        // Nothing of the start's own visit, and its version kept.
        assert!(all("SELECT name FROM segments").is_empty());
        assert_eq!(all("SELECT value FROM meta"), ["70"]);
        let bookmarks = fs::read_to_string(data.join("Bookmarks")).unwrap();
        for (word, there) in [
            ("Bar", true),
            ("Phone", true),
            ("secret", false),
            ("Trash", false),
        ] {
            assert_eq!(bookmarks.contains(word), there, "{word}");
        }
        // Copies of what the person visited are not left behind.
        assert!(!place.cache.join("work").exists());
        assert!(!place.data.join(".import").exists());
    }

    #[test]
    fn sign_ins_come_over_under_this_browsers_key() {
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        let db = Connection::open(profile.folder.join("Cookies")).unwrap();
        db.execute_batch(cookies::tests::OURS).unwrap();
        cookies::tests::seal_one(&db, "a.example", &cipher("Chrome Safe Storage"));
        let brought = import(
            &Starts(&t, true, Leave::Nothing),
            &KEYS,
            &place,
            chrome,
            &profile,
        )
        .unwrap();
        assert_eq!(brought.cookies, Cookies::Came(Counted { came: 1, left: 0 }));
        let file = place.data.join("Default/Cookies");
        let sealed: Vec<u8> = Connection::open(&file)
            .unwrap()
            .query_row("SELECT encrypted_value FROM cookies", [], |r| r.get(0))
            .unwrap();
        let opened = cipher("Helium Storage Key").open(&sealed).unwrap();
        assert!(opened.bytes().ends_with(b"made up"));
        for dir in [&place.data, &place.cache] {
            for (file, bytes) in t.listing(dir) {
                let plain = bytes.windows(7).any(|w| w == b"made up");
                assert!(!plain, "a readable value is in {}", file.display());
            }
        }
        let text = brought.text(chrome, &profile);
        assert!(text.contains("sign-ins (1 cookies)"), "{text}");
        assert!(!text.contains("a.example"), "{text}");
    }

    const PRINTS: &str = "POLYCARP_TEST_IMPORT_PRINTS";
    /// Made-up keys, and a value no line may show.
    const THEIR_KEY: &str = "theirs-made-up-4f1c";
    const OUR_KEY: &str = "ours-made-up-9a27";
    const HOST: &str = "made-up-sign-in.example";

    struct PrintKeys(bool);

    impl Keys for PrintKeys {
        fn password(&self, service: &str, _: &str) -> Result<Secret, Denied> {
            match service == keys::OURS.0 {
                true if self.0 => Ok(Secret::new(OUR_KEY.into())),
                true => Err(Denied::Missing),
                false => Ok(Secret::new(THEIR_KEY.into())),
            }
        }
    }

    /// Run in a process of its own by `no_secret_reaches_stdout_or_stderr`, so that what it prints is all there is.
    #[test]
    fn imports_and_prints_when_asked() {
        if std::env::var_os(PRINTS).is_none() {
            return;
        }
        // One import that works, and one refused for want of this browser's key.
        for ours in [true, false] {
            let t = Fake::new();
            let (place, chrome, profile) = made_up(&t);
            let state = json!({ "profile": { "info_cache": { "Default": { "name": "Home" } } } });
            fs::write(
                chrome.data(&place.home).join("Local State"),
                state.to_string(),
            )
            .unwrap();
            let db = Connection::open(profile.folder.join("Cookies")).unwrap();
            db.execute_batch(cookies::tests::OURS).unwrap();
            cookies::tests::seal_one(&db, HOST, &cipher(THEIR_KEY));
            let asked = super::super::Asked {
                verb: "import".into(),
                what: Some("chrome".into()),
                flags: vec!["--yes".into()],
                ..Default::default()
            };
            let starts = Starts(&t, true, Leave::Nothing);
            let done = import::answer(&starts, &PrintKeys(ours), &place, &asked);
            super::super::print(done);
        }
    }

    #[test]
    fn no_secret_reaches_stdout_or_stderr() {
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "browser::chromium::tests::imports_and_prints_when_asked",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(PRINTS, "1")
            .output()
            .unwrap();
        let (stdout, stderr) = (
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
        assert!(out.status.success(), "{stdout}{stderr}");
        // Both ran, so the two streams are the ones to look in.
        assert!(stdout.contains("sign-ins (1 cookies)"), "{stdout}");
        assert!(stderr.contains("has no key yet"), "{stderr}");
        for (stream, text) in [("stdout", &stdout), ("stderr", &stderr)] {
            for secret in ["made up", THEIR_KEY, OUR_KEY, HOST] {
                assert!(!text.contains(secret), "{secret} is in {stream}: {text}");
            }
        }
    }

    #[test]
    fn without_a_key_everything_but_sign_ins_comes_over() {
        for denied in ["Chrome Safe Storage", keys::OURS.0] {
            let t = Fake::new();
            let (place, chrome, profile) = made_up(&t);
            let db = Connection::open(profile.folder.join("Cookies")).unwrap();
            db.execute_batch(cookies::tests::OURS).unwrap();
            let keys = FakeKeys(Some((denied, Denied::Declined)));
            let brought = import(
                &Starts(&t, true, Leave::Nothing),
                &keys,
                &place,
                chrome,
                &profile,
            )
            .unwrap();
            assert_eq!(brought.cookies, Cookies::Declined);
            assert!(!place.data.join("Default/Cookies").exists());
            assert_eq!(brought.history, Some(1));
            assert!(brought.text(chrome, &profile).contains("you said no"));
        }
        // Never opened, this browser has no key to seal with yet.
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        let keys = FakeKeys(Some((keys::OURS.0, Denied::Missing)));
        let e = import(
            &Starts(&t, true, Leave::Nothing),
            &keys,
            &place,
            chrome,
            &profile,
        )
        .unwrap_err();
        assert!(e.why.contains("Open it once"), "{e}");
        assert!(pages::untouched(&place.data));
    }

    #[test]
    fn only_web_store_extensions_that_are_on_are_named() {
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        let text = import(
            &Starts(&t, true, Leave::Nothing),
            &KEYS,
            &place,
            chrome,
            &profile,
        )
        .unwrap();
        let text = text.text(chrome, &profile);
        let store = "https://chromewebstore.google.com/detail/";
        let (a, d) = ("a".repeat(32), "d".repeat(32));
        assert!(
            text.ends_with(&format!("{store}{a} Reader\n  {store}{d}")),
            "{text}"
        );
        assert_eq!(text.matches(store).count(), 2, "{text}");
        // What was visited is counted, not shown.
        assert!(text.contains("history (1 pages)"), "{text}");
        assert!(!text.contains("made-up"), "{text}");
    }

    #[test]
    fn a_part_that_cannot_be_read_is_left_out_and_said() {
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        fs::write(profile.folder.join("History"), "not a database").unwrap();
        fs::write(profile.folder.join("Bookmarks"), "{}").unwrap();
        let brought = import(
            &Starts(&t, true, Leave::Nothing),
            &KEYS,
            &place,
            chrome,
            &profile,
        )
        .unwrap();
        assert!(!place.data.join("Default/History").exists());
        assert!(!place.data.join("Default/Bookmarks").exists());
        let text = brought.text(chrome, &profile);
        assert!(text.contains("no bookmarks, no history"), "{text}");
    }

    #[test]
    fn history_still_in_the_write_ahead_log_comes_too() {
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        let db = Connection::open(profile.folder.join("History")).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
             INSERT INTO urls VALUES (9, 'https://later.example/', 'Later', 1, 0, 100, 0, 'x');",
        )
        .unwrap();
        // Held, so the row stays in the log.
        assert!(profile.folder.join("History-wal").exists());
        let brought = import(
            &Starts(&t, true, Leave::Nothing),
            &KEYS,
            &place,
            chrome,
            &profile,
        )
        .unwrap();
        assert_eq!(brought.history, Some(2));
        drop(db);
    }

    #[test]
    fn what_a_link_leads_to_is_not_read() {
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        for name in ["History", "Bookmarks", "Secure Preferences"] {
            let elsewhere = t.work().join(name);
            fs::rename(profile.folder.join(name), &elsewhere).unwrap();
            std::os::unix::fs::symlink(elsewhere, profile.folder.join(name)).unwrap();
        }
        let brought = import(
            &Starts(&t, true, Leave::Nothing),
            &KEYS,
            &place,
            chrome,
            &profile,
        )
        .unwrap();
        assert_eq!(brought.history, None);
        assert!(!place.data.join("Default/Bookmarks").exists());
        assert!(brought.extensions.is_empty());
    }

    #[test]
    fn it_needs_the_browser_installed_and_able_to_start() {
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        let e = import(
            &Starts(&t, false, Leave::Nothing),
            &KEYS,
            &place,
            chrome,
            &profile,
        )
        .unwrap_err();
        assert_eq!(e.check, "headless start");
        assert!(pages::untouched(&place.data));
        assert!(!place.data.join(".import").exists());
        fs::remove_dir_all(place.spot.app()).unwrap();
        let e = import(
            &Starts(&t, true, Leave::Nothing),
            &KEYS,
            &place,
            chrome,
            &profile,
        )
        .unwrap_err();
        assert!(e.why.contains("install"), "{e}");
        // Nor is it offered.
        let asked = super::super::Asked {
            verb: "import".into(),
            what: Some("chrome".into()),
            ..Default::default()
        };
        let e = import::answer(&t, &KEYS, &place, &asked).unwrap_err();
        assert!(e.why.contains("install"), "{e}");
    }

    #[test]
    fn a_start_that_ended_badly_still_makes_the_profile() {
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        let db = Connection::open(profile.folder.join("Cookies")).unwrap();
        db.execute_batch(cookies::tests::OURS).unwrap();
        cookies::tests::seal_one(&db, "a.example", &cipher("Chrome Safe Storage"));
        let brought = import(
            &Starts(&t, true, Leave::Log),
            &KEYS,
            &place,
            chrome,
            &profile,
        )
        .unwrap();
        assert_eq!(brought.cookies, Cookies::Came(Counted { came: 1, left: 0 }));
        assert_eq!(brought.history, Some(1));
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        import(
            &Starts(&t, true, Leave::Helper),
            &KEYS,
            &place,
            chrome,
            &profile,
        )
        .unwrap();
        assert!(!place.spot.running());
    }
}
