//! The Settings window's preferences as sync items, and back.
//!
//! - `prefs:<key>`: each key of the Polycarp app's UserDefaults domain `com.baney.polycarp` that is in [`SYNCED`],
//!   as JSON (a bool, a string or a list of strings).
//!
//! On macOS the domain is read with `defaults export` and written one key at a time with `defaults write`, so nothing
//! else in it is touched. Other OSes have no such domain: the items are kept in `prefs.json` in the sync folder and
//! passed back unchanged. Keys in [`LOCAL`], and any key on neither list, stay on this machine. The app reads a
//! synced value the next time it starts.
//!
//! `POLYCARP_SYNC_DEFAULTS=<absolute path to a .plist file>` makes the domain that file (`defaults` takes a full path
//! as a domain). It is for tests and never set in real use.

use serde_json::Value as Json;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The Polycarp app's UserDefaults domain.
pub const DOMAIN: &str = "com.baney.polycarp";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Bool,
    Str,
    StrList,
}

/// The keys that sync, each with its kind. The test below holds this list in place.
pub const SYNCED: &[(&str, Kind)] = &[
    // The Modifier picker.
    ("modifier", Kind::Str),
    // The Overview toggle.
    ("viewerReplacesMissionControl", Kind::Bool),
    // Drag to top.
    ("topDragOpensOverview", Kind::Bool),
    // Fill the screen.
    ("fullScreenFills", Kind::Bool),
    // The Cmd-Tab picker.
    ("cmdTabMode", Kind::Str),
    // Launcher on Cmd-Space.
    ("launcherOnCmdSpace", Kind::Bool),
    // Quick terminal key.
    ("terminalQuickKey", Kind::Bool),
    // Ask questions with.
    ("launcherAgent", Kind::Str),
    // Daily update check.
    ("checkForUpdates", Kind::Bool),
    // The Hide by parking list.
    ("parkInsteadOfHide", Kind::StrList),
];

/// Keys known to belong to one machine, never synced.
pub const LOCAL: &[&str] = &[
    // Setup and update state.
    "loginItemChosen",
    "loginItemOffered",
    "setupShown",
    "welcomeFinished",
    "updatingTo",
    "updateChannel",
    "lastUpdateCheck",
    "lastBrowserUpdate",
    "browserRebuildWanted",
    "restartingForInstall",
    "quietNotices",
    // Records of this Mac's system shortcuts and Dock.
    "freedShortcuts",
    "unhideUndoesMoves",
    // Privacy choices made per device: remote control, agents reading tabs, what the browser shares.
    "agentWorkspace",
    "remoteEnabled",
    "browserAgentsRead",
    "browserSourcesOff",
    // Lists and paths that are this machine's: recents, measured slow apps, a notes file, the player's volume.
    "launcherRecents",
    "slowMovers2",
    "browserNotesFile",
    "playerVolume",
];

/// Where this machine keeps its preferences.
pub enum Store {
    /// A UserDefaults domain, or a plist file's full path, read and written with `/usr/bin/defaults`.
    Defaults(String),
    /// A JSON file of `prefs:` items, on an OS without the domain.
    File(PathBuf),
}

/// This machine's store: the domain on macOS (or the test hook's file), else `prefs.json` in `sync_dir`.
pub fn store(sync_dir: &Path) -> Result<Store, String> {
    if !cfg!(target_os = "macos") {
        return Ok(Store::File(sync_dir.join("prefs.json")));
    }
    let Some(p) = std::env::var_os("POLYCARP_SYNC_DEFAULTS").filter(|v| !v.is_empty()) else {
        return Ok(Store::Defaults(DOMAIN.into()));
    };
    let p = PathBuf::from(p);
    if !p.is_absolute() {
        return Err("POLYCARP_SYNC_DEFAULTS must be an absolute path".into());
    }
    p.into_os_string()
        .into_string()
        .map(Store::Defaults)
        .map_err(|_| "POLYCARP_SYNC_DEFAULTS must be plain text".into())
}

/// The keys that sync. A key on [`LOCAL`] never does, even if it were put in [`SYNCED`] by mistake.
fn keys() -> impl Iterator<Item = &'static (&'static str, Kind)> {
    SYNCED.iter().filter(|(k, _)| !LOCAL.contains(k))
}

fn kind(key: &str) -> Option<Kind> {
    keys().find(|(k, _)| *k == key).map(|(_, k)| *k)
}

fn fits(k: Kind, v: &Json) -> bool {
    match (k, v) {
        (Kind::Bool, Json::Bool(_)) | (Kind::Str, Json::String(_)) => true,
        (Kind::StrList, Json::Array(a)) => a.iter().all(Json::is_string),
        _ => false,
    }
}

/// The item's key when it is a `prefs:` item on the allow list and its value has the key's kind.
fn synced(id: &str, v: &Json) -> Option<(&'static str, Kind)> {
    let key = id.strip_prefix("prefs:")?;
    keys().find(|(k, kd)| *k == key && fits(*kd, v)).copied()
}

/// A plist value as JSON, or None when it is not of kind `k`.
pub fn to_json(k: Kind, v: &plist::Value) -> Option<Json> {
    match (k, v) {
        (Kind::Bool, plist::Value::Boolean(b)) => Some(Json::Bool(*b)),
        (Kind::Str, plist::Value::String(s)) => Some(Json::String(s.clone())),
        (Kind::StrList, plist::Value::Array(a)) => a
            .iter()
            .map(|e| e.as_string().map(|s| Json::String(s.into())))
            .collect::<Option<Vec<_>>>()
            .map(Json::Array),
        _ => None,
    }
}

/// The arguments to `defaults` that set `key` to `v`, or None when `v` is not the key's kind or the key does not sync.
/// Each list entry gets its own `-string`, so an entry that starts with a dash is never taken for a type.
pub fn write_args(domain: &str, key: &str, v: &Json) -> Option<Vec<String>> {
    let k = kind(key).filter(|k| fits(*k, v))?;
    let mut args = vec!["write".to_string(), domain.to_string(), key.to_string()];
    match v {
        Json::Bool(b) => args.extend(["-bool".into(), b.to_string()]),
        Json::String(s) if k == Kind::Str => args.extend(["-string".into(), s.clone()]),
        Json::Array(a) => {
            args.push("-array".into());
            for s in a.iter().filter_map(Json::as_str) {
                args.extend(["-string".into(), s.to_string()]);
            }
        }
        _ => return None,
    }
    Some(args)
}

/// The arguments to `defaults` that remove `key`.
pub fn delete_args(domain: &str, key: &str) -> Vec<String> {
    vec!["delete".into(), domain.into(), key.into()]
}

/// What one read of this machine's preferences found.
#[derive(Debug, Default, PartialEq)]
pub struct Read {
    /// The synced keys whose values this build can use, as `prefs:` items.
    pub items: BTreeMap<String, Json>,
    /// Synced keys that hold a value of another kind here, such as `checkForUpdates` written as an integer.
    pub odd: BTreeSet<String>,
    /// True when the read found no keys at all, synced or machine-only.
    pub empty: bool,
}

/// The synced items in what `defaults export <domain> -` printed. A failed run or output that is not a plist is an
/// error naming the domain, so it is never taken for deletes.
pub fn parse_export(domain: &str, ok: bool, out: &[u8]) -> Result<Read, String> {
    let fail = |why: String| {
        format!("could not read the preferences in {domain}, so settings were not synced: {why}")
    };
    if !ok {
        return Err(fail("defaults export failed".into()));
    }
    let doc = plist::Value::from_reader_xml(out).map_err(|e| fail(e.to_string()))?;
    let dict = doc
        .as_dictionary()
        .ok_or_else(|| fail("it is not a dictionary".into()))?;
    let mut read = Read {
        empty: dict.is_empty(),
        ..Read::default()
    };
    for (k, kd) in keys() {
        let Some(v) = dict.get(k) else { continue };
        let id = format!("prefs:{k}");
        match to_json(*kd, v) {
            Some(j) => {
                read.items.insert(id, j);
            }
            None => {
                read.odd.insert(id);
            }
        }
    }
    Ok(read)
}

/// Runs `/usr/bin/defaults` with no shell and no input, and returns what it printed.
fn defaults(domain: &str, args: &[String]) -> Result<Vec<u8>, String> {
    let o = Command::new("/usr/bin/defaults")
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("could not run defaults for {domain}: {e}"))?;
    if o.status.success() {
        Ok(o.stdout)
    } else {
        Err(format!("defaults {} failed for {domain}", args[0]))
    }
}

fn read_domain(domain: &str) -> Result<Read, String> {
    let out = defaults(domain, &["export".into(), domain.into(), "-".into()]);
    parse_export(domain, out.is_ok(), out.as_deref().unwrap_or(&[]))
}

fn read_file(p: &Path) -> Result<BTreeMap<String, Json>, String> {
    let text = match fs::read_to_string(p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(format!("could not read {}: {e}", p.display())),
    };
    serde_json::from_str(&text).map_err(|e| {
        format!(
            "{} can't be read, so settings were not synced: {e}",
            p.display()
        )
    })
}

/// The preferences this machine holds now, as `prefs:` items.
pub fn snapshot(s: &Store) -> Result<Read, String> {
    match s {
        Store::Defaults(d) => read_domain(d),
        // Every `prefs:` item, known to this build or not, so another OS passes them all back as they came.
        Store::File(p) => {
            let items: BTreeMap<String, Json> = read_file(p)?
                .into_iter()
                .filter(|(id, _)| id.starts_with("prefs:"))
                .collect();
            Ok(Read {
                empty: items.is_empty(),
                items,
                ..Read::default()
            })
        }
    }
}

/// What this machine holds now, or the last synced `prefs:` values when the read found no keys at all. `defaults
/// export` prints an empty domain for one it can't read, so an empty read never deletes the other devices'
/// preferences; the last values stand and are written back here. A read with only machine-only keys is a real one,
/// so resetting the last synced key here is a delete like any other.
pub fn or_last(now: Read, last: &BTreeMap<String, Json>) -> BTreeMap<String, Json> {
    if !now.empty {
        return now.items;
    }
    last.iter()
        .filter(|(id, v)| synced(id, v).is_some())
        .map(|(id, v)| (id.clone(), v.clone()))
        .collect()
}

/// This device's `prefs:` items as `observe` should see them:
///
/// - an empty read stands for the last synced values ([`or_last`]);
/// - a synced key that holds a value of another kind here is the last synced value, so it is never taken for a
///   delete;
/// - an item this build can't use, a key it doesn't know or a value of another kind from a newer build, is the last
///   synced value, so it is passed back as it came and never taken for a delete or a local edit.
pub fn local_items(now: Read, last: &BTreeMap<String, Json>) -> BTreeMap<String, Json> {
    let odd = now.odd.clone();
    let mut out = or_last(now, last);
    for id in odd {
        if let Some(v) = last.get(&id) {
            out.insert(id, v.clone());
        }
    }
    for (id, v) in last {
        if id.starts_with("prefs:") && synced(id, v).is_none() {
            out.insert(id.clone(), v.clone());
        }
    }
    out
}

/// Makes this machine's synced preferences what `values` holds. A key whose synced value is of the wrong kind, and
/// every key not in [`SYNCED`], is left as it is. Reads happen before the first write. Returns the domain or file
/// when something changed.
pub fn apply(s: &Store, values: &BTreeMap<String, Json>) -> Result<Vec<PathBuf>, String> {
    let want: BTreeMap<String, Json> = values
        .iter()
        .filter(|(id, v)| synced(id, v).is_some())
        .map(|(id, v)| (id.clone(), v.clone()))
        .collect();
    match s {
        Store::File(p) => {
            let want: BTreeMap<String, Json> = values
                .iter()
                .filter(|(id, _)| id.starts_with("prefs:"))
                .map(|(id, v)| (id.clone(), v.clone()))
                .collect();
            if read_file(p)? == want {
                return Ok(Vec::new());
            }
            if let Some(d) = p.parent() {
                fs::create_dir_all(d)
                    .map_err(|e| format!("could not make {}: {e}", d.display()))?;
            }
            let mut b = serde_json::to_vec_pretty(&want).map_err(|e| e.to_string())?;
            b.push(b'\n');
            let tmp = p.with_extension("tmp");
            fs::write(&tmp, b)
                .and_then(|_| fs::rename(&tmp, p))
                .map_err(|e| format!("could not write {}: {e}", p.display()))?;
            Ok(vec![p.clone()])
        }
        Store::Defaults(d) => {
            let read = read_domain(d)?;
            let have = read.items;
            let mut plan = Vec::new();
            for (key, _) in keys() {
                let id = format!("prefs:{key}");
                // A value of another kind here was set by hand or by another build; it is left as it is.
                if read.odd.contains(&id) {
                    continue;
                }
                match (values.get(&id), have.get(&id)) {
                    (Some(w), h) if want.contains_key(&id) && h != Some(w) => {
                        plan.extend(write_args(d, key, w))
                    }
                    (None, Some(_)) => plan.push(delete_args(d, key)),
                    _ => {}
                }
            }
            for args in &plan {
                defaults(d, args)?;
            }
            Ok(if plan.is_empty() {
                Vec::new()
            } else {
                vec![PathBuf::from(d)]
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn j(pairs: &[(&str, Json)]) -> BTreeMap<String, Json> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn read(items: BTreeMap<String, Json>, odd: &[&str]) -> Read {
        Read {
            empty: items.is_empty() && odd.is_empty(),
            items,
            odd: odd.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn what_this_build_cant_use_and_a_value_of_another_kind_pass_back_as_last_synced() {
        // A newer build's key, and a known key of another kind, come back as they were synced.
        let last = j(&[
            ("prefs:modifier", Json::from("control")),
            ("prefs:newKey", Json::from(3)),
            ("prefs:terminalQuickKey", Json::from("sometimes")),
            ("prefs:checkForUpdates", Json::Bool(false)),
        ]);
        let now = j(&[
            ("prefs:modifier", Json::from("option")),
            ("prefs:terminalQuickKey", Json::Bool(true)),
        ]);
        // `checkForUpdates` is an integer on this Mac: present, so not a delete, and the synced value stands.
        let got = local_items(
            read(now, &["prefs:checkForUpdates", "prefs:launcherAgent"]),
            &last,
        );
        assert_eq!(
            got,
            j(&[
                ("prefs:checkForUpdates", Json::Bool(false)),
                ("prefs:modifier", Json::from("option")),
                ("prefs:newKey", Json::from(3)),
                ("prefs:terminalQuickKey", Json::from("sometimes")),
            ])
        );
    }

    #[test]
    fn only_a_read_with_no_keys_at_all_keeps_the_last_synced_values() {
        let last = j(&[
            ("prefs:modifier", Json::from("control")),
            ("prefs:remoteEnabled", Json::Bool(true)),
            ("surfaces:/bar/height", Json::from(30)),
        ]);
        let kept = or_last(
            Read {
                empty: true,
                ..Read::default()
            },
            &last,
        );
        assert_eq!(kept, j(&[("prefs:modifier", Json::from("control"))]));
        // The only synced key was reset, and machine-only keys remain: that is a delete, not an unreadable domain.
        let reset = Read {
            empty: false,
            ..Read::default()
        };
        assert!(or_last(reset, &last).is_empty());
        let now = j(&[("prefs:checkForUpdates", Json::Bool(false))]);
        assert_eq!(or_last(read(now.clone(), &[]), &last), now);
    }
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("polycarp-sync-prefs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn items(pairs: &[(&str, Json)]) -> BTreeMap<String, Json> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn the_prefs_allow_list_holds() {
        use Kind::*;
        assert_eq!(
            SYNCED,
            &[
                ("modifier", Str),
                ("viewerReplacesMissionControl", Bool),
                ("topDragOpensOverview", Bool),
                ("fullScreenFills", Bool),
                ("cmdTabMode", Str),
                ("launcherOnCmdSpace", Bool),
                ("terminalQuickKey", Bool),
                ("launcherAgent", Str),
                ("checkForUpdates", Bool),
                ("parkInsteadOfHide", StrList),
            ]
        );
        let mut keys: Vec<&str> = SYNCED.iter().map(|(k, _)| *k).collect();
        keys.extend(LOCAL);
        let all = keys.len();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), all, "SYNCED and LOCAL overlap or repeat a key");
        assert_eq!(LOCAL.len(), 21);
    }

    #[test]
    fn a_plist_value_becomes_json_only_when_its_kind_fits() {
        use plist::Value as P;
        assert_eq!(to_json(Kind::Bool, &P::Boolean(false)), Some(json!(false)));
        assert_eq!(
            to_json(Kind::Str, &P::String("control".into())),
            Some(json!("control"))
        );
        assert_eq!(
            to_json(Kind::StrList, &P::Array(vec![P::String("com.a".into())])),
            Some(json!(["com.a"]))
        );
        assert_eq!(to_json(Kind::Bool, &P::String("yes".into())), None);
        assert_eq!(to_json(Kind::Str, &P::Integer(1.into())), None);
        assert_eq!(
            to_json(Kind::StrList, &P::Array(vec![P::Boolean(true)])),
            None
        );
    }

    #[test]
    fn write_and_delete_arguments_name_the_domain_and_the_key() {
        let d = "/x/p.plist";
        assert_eq!(
            write_args(d, "checkForUpdates", &json!(false)).unwrap(),
            ["write", d, "checkForUpdates", "-bool", "false"]
        );
        assert_eq!(
            write_args(d, "modifier", &json!("-bool")).unwrap(),
            ["write", d, "modifier", "-string", "-bool"]
        );
        assert_eq!(
            write_args(d, "parkInsteadOfHide", &json!(["com.a", "-int"])).unwrap(),
            [
                "write",
                d,
                "parkInsteadOfHide",
                "-array",
                "-string",
                "com.a",
                "-string",
                "-int"
            ]
        );
        assert_eq!(write_args(d, "terminalQuickKey", &json!("yes")), None);
        assert_eq!(write_args(d, "remoteEnabled", &json!(true)), None);
        assert_eq!(
            delete_args(d, "launcherAgent"),
            ["delete", d, "launcherAgent"]
        );
    }

    #[test]
    fn a_failed_or_unreadable_export_is_an_error_naming_the_domain() {
        let err = parse_export("com.baney.polycarp", false, b"").unwrap_err();
        assert!(err.contains("com.baney.polycarp"), "{err}");
        let err = parse_export("/x/p.plist", true, b"not a plist").unwrap_err();
        assert!(err.contains("/x/p.plist"), "{err}");
        let empty =
            br#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>"#;
        assert!(parse_export("d", true, empty).unwrap().empty);
        let some = br#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
            <key>checkForUpdates</key><integer>1</integer>
            <key>modifier</key><string>control</string>
            <key>loginItemChosen</key><true/>
        </dict></plist>"#;
        let r = parse_export("d", true, some).unwrap();
        assert!(!r.empty);
        assert_eq!(r.items, items(&[("prefs:modifier", json!("control"))]));
        assert_eq!(r.odd, ["prefs:checkForUpdates".to_string()].into());
    }

    #[test]
    fn another_os_keeps_the_macs_prefs_and_passes_them_back() {
        let s = Store::File(temp("file").join("prefs.json"));
        let theirs = items(&[
            ("prefs:modifier", json!("control")),
            ("prefs:remoteEnabled", json!(true)),
            ("prefs:checkForUpdates", json!("no")),
        ]);
        assert_eq!(apply(&s, &theirs).unwrap().len(), 1);
        // Every item comes back as it came; only a Mac decides which it writes.
        let back = snapshot(&s).unwrap().items;
        assert_eq!(back, theirs);
        assert!(
            apply(&s, &theirs).unwrap().is_empty(),
            "nothing changes the second time"
        );
    }

    #[cfg(target_os = "macos")]
    mod mac {
        use super::*;

        /// A temp plist the hook would name, filled with `defaults write` lines.
        fn domain(name: &str, writes: &[&[&str]]) -> String {
            let d = temp(name).join("prefs.plist").display().to_string();
            for w in writes {
                let mut args = vec!["write".to_string(), d.clone()];
                args.extend(w.iter().map(|s| s.to_string()));
                defaults(&d, &args).unwrap();
            }
            d
        }

        #[test]
        fn a_snapshot_holds_synced_keys_and_never_local_ones() {
            let d = domain(
                "snap",
                &[
                    &["modifier", "-string", "control"],
                    &["checkForUpdates", "-bool", "false"],
                    &["remoteEnabled", "-bool", "true"],
                    &["loginItemChosen", "-bool", "true"],
                    &["terminalQuickKey", "-string", "yes"],
                ],
            );
            assert_eq!(
                snapshot(&Store::Defaults(d)).unwrap().items,
                items(&[
                    ("prefs:checkForUpdates", json!(false)),
                    ("prefs:modifier", json!("control")),
                ])
            );
        }

        #[test]
        fn apply_sets_and_removes_synced_keys_and_leaves_the_rest() {
            let d = domain(
                "apply",
                &[
                    &["modifier", "-string", "command"],
                    &["remoteEnabled", "-bool", "false"],
                    &["launcherAgent", "-string", "claude"],
                ],
            );
            let s = Store::Defaults(d.clone());
            let theirs = items(&[
                ("prefs:modifier", json!("option")),
                ("prefs:remoteEnabled", json!(true)),
                ("prefs:parkInsteadOfHide", json!(["com.a", "com.b"])),
            ]);
            assert_eq!(apply(&s, &theirs).unwrap(), [PathBuf::from(&d)]);
            let out = defaults(&d, &["export".into(), d.clone(), "-".into()]).unwrap();
            let doc = plist::Value::from_reader_xml(&out[..]).unwrap();
            let doc = doc.as_dictionary().unwrap();
            assert_eq!(doc["modifier"].as_string(), Some("option"));
            assert_eq!(doc["remoteEnabled"].as_boolean(), Some(false));
            assert!(!doc.contains_key("launcherAgent"));
            let park: Vec<_> = doc["parkInsteadOfHide"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_string().unwrap())
                .collect();
            assert_eq!(park, ["com.a", "com.b"]);
        }

        #[test]
        fn apply_leaves_a_value_of_another_kind_as_it_is() {
            let d = domain("odd", &[&["checkForUpdates", "-int", "1"]]);
            let s = Store::Defaults(d.clone());
            let theirs = items(&[("prefs:checkForUpdates", json!(false))]);
            assert!(apply(&s, &theirs).unwrap().is_empty());
            let out = defaults(&d, &["read".into(), d.clone(), "checkForUpdates".into()]).unwrap();
            assert_eq!(String::from_utf8_lossy(&out).trim(), "1");
            // Absent from the values, it is not deleted either.
            assert!(apply(&s, &BTreeMap::new()).unwrap().is_empty());
        }

        #[test]
        fn apply_with_nothing_different_runs_no_write() {
            let d = domain("same", &[&["modifier", "-string", "control"]]);
            let s = Store::Defaults(d.clone());
            let theirs = items(&[
                ("prefs:modifier", json!("control")),
                ("prefs:terminalQuickKey", json!("yes")),
            ]);
            let before = fs::metadata(&d).unwrap().modified().unwrap();
            assert!(apply(&s, &theirs).unwrap().is_empty());
            assert_eq!(fs::metadata(&d).unwrap().modified().unwrap(), before);
        }
    }
}
