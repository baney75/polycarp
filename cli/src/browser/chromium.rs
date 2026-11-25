//! Importing from the other Chromium browsers: bookmarks and history go into a new profile that this browser's own code
//! laid out, so another version's files are never opened by it. The source is copied first, and only the copy is read.

use std::fs;
use std::io;
use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::import::{self, Browser, Profile};
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

/// What came over. A part that could not be read is left out, and the line says so.
#[derive(Debug, Default, PartialEq)]
pub struct Brought {
    pub dir: String,
    pub bookmarks: bool,
    pub history: Option<usize>,
    /// Web Store ids and names.
    pub extensions: Vec<(String, String)>,
}

pub fn import(
    tools: &dyn Tools,
    place: &Place,
    from: &Browser,
    profile: &Profile,
) -> Result<Brought, Refused> {
    let Some(app) = place.spot.installed().map(|_| place.spot.app()) else {
        let why = "Polycarp Browser is not installed; run `polycarp browser install` first";
        return Err(Refused::new(CHECK, why));
    };
    let mut brought = Brought::default();
    let dir = import::into_profile(place, from, &profile.name, |part| {
        let work = place.work(tools)?;
        let made = start::empty_profile(tools, &app, &work);
        let filled = made.and_then(|empty| {
            fill(&empty, &profile.folder, part, &work, &mut brought)
                .map_err(refuse(CHECK, "writing the new profile"))
        });
        let cleared = clear(&work).map_err(refuse(CHECK, "clearing the copies"));
        filled.and(cleared)
    })?;
    brought.dir = dir;
    Ok(brought)
}

fn fill(empty: &Path, from: &Path, part: &Path, work: &Path, to: &mut Brought) -> io::Result<()> {
    fs::write(part.join("Preferences"), pages::first_prefs())?;
    if let Some(bookmarks) = bookmarks(from) {
        fs::write(part.join("Bookmarks"), bookmarks)?;
        to.bookmarks = true;
    }
    if let Some(copy) = copied(&from.join("History"), work)? {
        let file = part.join("History");
        fs::copy(empty.join("History"), &file)?;
        // Its own errors could quote a row, so none is kept.
        to.history = history(&file, &copy).ok();
        if to.history.is_none() {
            fs::remove_file(&file)?;
        }
    }
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
    for end in ["", "-wal", "-journal"] {
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
    t.execute_batch("DELETE FROM main.visits; DELETE FROM main.urls;")?;
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
        let text = fs::read(from.join(file)).unwrap_or_default();
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
        let mut text = format!(
            "{}'s profile {} is copied ({}): {}, {history}. Passwords and sign-ins stay there.",
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
        INSERT INTO visits VALUES (1, 1, 1, 0, 0, 0);";
    const THEIRS: &str = "CREATE TABLE urls(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
        visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER, odd TEXT);
        CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, from_visit INTEGER,
        transition INTEGER, originator_cache_guid TEXT);
        INSERT INTO urls VALUES (7, 'https://made-up.example/', 'Made up', 3, 1, 99, 0, 'x'),
            (8, 'chrome://settings/', 'Settings', 1, 0, 98, 0, 'x');
        INSERT INTO visits VALUES (70, 7, 99, 0, 1, 'device'), (80, 8, 98, 0, 1, 'device');";

    /// A browser whose first start writes an empty history, as the real one does.
    struct Starts<'a>(&'a Fake, bool);

    impl Tools for Starts<'_> {
        fn run(&self, call: &Call) -> io::Result<Ran> {
            let data = call.args.iter().find_map(|a| {
                let a = a.to_str()?;
                a.strip_prefix("--user-data-dir=").map(PathBuf::from)
            });
            let first = data.expect("only the browser is started").join("Default");
            let db = Connection::open(first.join("History")).unwrap();
            db.execute_batch(OURS).unwrap();
            if self.1 {
                fs::write(first.join("Cookies"), "").unwrap();
            }
            self.0.run(call)
        }
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
        let brought = import(&Starts(&t, true), &place, chrome, &profile).unwrap();
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
    fn only_web_store_extensions_that_are_on_are_named() {
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        let text = import(&Starts(&t, true), &place, chrome, &profile).unwrap();
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
        let brought = import(&Starts(&t, true), &place, chrome, &profile).unwrap();
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
        let brought = import(&Starts(&t, true), &place, chrome, &profile).unwrap();
        assert_eq!(brought.history, Some(2));
        drop(db);
    }

    #[test]
    fn what_a_link_leads_to_is_not_read() {
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        for name in ["History", "Bookmarks"] {
            let elsewhere = t.work().join(name);
            fs::rename(profile.folder.join(name), &elsewhere).unwrap();
            std::os::unix::fs::symlink(elsewhere, profile.folder.join(name)).unwrap();
        }
        let brought = import(&Starts(&t, true), &place, chrome, &profile).unwrap();
        assert_eq!(brought.history, None);
        assert!(!place.data.join("Default/Bookmarks").exists());
    }

    #[test]
    fn it_needs_the_browser_installed_and_able_to_start() {
        let t = Fake::new();
        let (place, chrome, profile) = made_up(&t);
        let e = import(&Starts(&t, false), &place, chrome, &profile).unwrap_err();
        assert_eq!(e.check, "headless start");
        assert!(pages::untouched(&place.data));
        assert!(!place.data.join(".import").exists());
        fs::remove_dir_all(place.spot.app()).unwrap();
        let e = import(&Starts(&t, true), &place, chrome, &profile).unwrap_err();
        assert!(e.why.contains("install"), "{e}");
    }
}
