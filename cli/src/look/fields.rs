//! Which of Polycarp's settings (surfaces.json) a look may hold. A look comes from a stranger, so this list is the
//! whole of it: appearance in, and anything that names a place, a file, an app or the person out.

use super::format::shown;
use serde_json::{json, Map, Value as Json};
use std::collections::BTreeMap;

/// Every field of surfaces.json (spaces/docs/surfaces.md): whether a look holds it, and why. A test keeps this and
/// that page the same, so a new field is decided here. A group left out whole is one row. `paper` and each place's
/// are the look's own `paper` part.
pub const FIELDS: &[(&str, bool, &str)] = &[
    (
        "bar.enabled",
        false,
        "turns the bar on over the macOS menu bar: what the Mac does, not how it looks",
    ),
    ("bar.height", true, "size"),
    ("bar.style", true, "how the bar is drawn"),
    (
        "bar.modules.left",
        true,
        "what the bar shows; a custom: module is the person's own and is dropped",
    ),
    ("bar.modules.center", true, "as left"),
    ("bar.modules.right", true, "as left"),
    ("bar.clockFormat", true, "how the time is written"),
    ("bar.hourNames", true, "how the hour is written"),
    (
        "bar.tray",
        true,
        "whether apps' status items fold into a drawer",
    ),
    (
        "desktop.scene",
        true,
        "a drawn scene; an image: names a file of the person's and is dropped",
    ),
    ("desktop.followDaylight", true, "the scene's light"),
    ("desktop.verse", true, "whether the desktop shows its verse"),
    ("desktop.versePosition", true, "where it is"),
    (
        "desktop.verseRotation",
        true,
        "which verse, by reference into the built-in text",
    ),
    (
        "dock.tileLabel",
        false,
        "went with the Workspace Dock; an older file may still have it",
    ),
    ("dock.restTile", false, "as dock.tileLabel"),
    ("menu.order", false, "where the controls are"),
    ("menu.hidden", false, "could hide a control, such as Update"),
    ("search.engine", false, "a search engine or a URL"),
    (
        "newtab.question",
        false,
        "words on the person's own page, which a stranger could use to ask for something",
    ),
    ("newtab.verse", true, "whether the page shows its verse"),
    ("newtab.searchURL", false, "a URL"),
    (
        "idle.enabled",
        false,
        "covers the screen when the Mac is left alone",
    ),
    ("idle.style", true, "how the idle screen is drawn"),
    ("idle.effects", true, "its motion"),
    (
        "idle.showMachineName",
        false,
        "shows the Mac's name, the person's own to show",
    ),
    ("idle.showVerse", true, "whether it shows a verse"),
    ("idle.showKierkegaard", true, "whether it shows its line"),
    ("idle.startAfterMinutes", false, "when it comes up"),
    ("text.translation", false, "the text read, not how it looks"),
    ("text.verseSource", false, "names a file"),
    ("rooms.root", false, "a folder"),
    ("rooms.menu", false, "what the menu lists"),
    (
        "tiling",
        false,
        "how windows are arranged and the keys that do it: what Polycarp does, not how it looks",
    ),
];

/// The bar's module lists, set as one so a module can move from one place to another.
pub const MODULES: &str = "bar.modules";

/// Whether a look may hold a surfaces path: its row in `FIELDS`, and whether it is kept.
fn field(path: &str) -> Option<bool> {
    FIELDS
        .iter()
        .find(|(p, ..)| *p == path)
        .map(|(_, keep, _)| *keep)
}

/// Walks a look's `surfaces` by path: kept fields go to `out`, known ones a look doesn't hold to `notes`, and
/// anything else is refused.
pub fn read(
    v: &Json,
    at: &str,
    out: &mut BTreeMap<String, Json>,
    notes: &mut Vec<String>,
    bad: &mut Vec<String>,
) {
    let here = if at.is_empty() {
        "surfaces".to_string()
    } else {
        format!("surfaces.{at}")
    };
    let Some(o) = v.as_object() else {
        bad.push(format!("{here}: must be an object"));
        return;
    };
    for (k, v) in o {
        let path = if at.is_empty() {
            k.clone()
        } else {
            format!("{at}.{k}")
        };
        match field(&path) {
            Some(true) => match kept(&path, v, notes) {
                Ok(Some(v)) => {
                    out.insert(path, v);
                }
                Ok(None) => {}
                Err(why) => bad.push(format!("surfaces.{path}: {why}")),
            },
            Some(false) => notes.push(format!("left out {path}: a look doesn't hold it")),
            None if FIELDS
                .iter()
                .any(|(p, ..)| p.starts_with(&format!("{path}."))) =>
            {
                read(v, &path, out, notes, bad)
            }
            None => bad.push(format!(
                "surfaces.{}: not a setting a look can hold",
                shown(&path)
            )),
        }
    }
}

/// What a look keeps of one field's value: None drops it, with a note. Polycarp checks the value itself when the look
/// is applied; this only refuses what could never be appearance.
pub fn kept(path: &str, v: &Json, notes: &mut Vec<String>) -> Result<Option<Json>, String> {
    let plain = |s: &str| s.chars().count() <= 160 && !s.chars().any(char::is_control);
    let names_place = |s: &str| s.contains("://") || s.starts_with(['/', '~']) || s.contains("..");
    let check = |s: &str| match plain(s) && !names_place(s) {
        true => Ok(()),
        false => Err(format!(
            "{:?} is not a look's value: no URLs, files or long text",
            shown(s)
        )),
    };
    if path.starts_with(MODULES) && !v.is_array() {
        return Err("must be a list of module names".into());
    }
    match v {
        Json::Bool(_) | Json::Number(_) => Ok(Some(v.clone())),
        Json::String(s) if s.starts_with("image:") || s.starts_with("picture:") => {
            notes.push(format!(
                "left out {path}: it names a picture file (a look carries pictures as paper)"
            ));
            Ok(None)
        }
        Json::String(s) => check(s).map(|()| Some(v.clone())),
        Json::Array(a) if path.starts_with(MODULES) => {
            let mut keep = Vec::new();
            for item in a {
                let Some(s) = item.as_str() else {
                    return Err("must be a list of module names".into());
                };
                check(s)?;
                if s.starts_with("custom:") {
                    notes.push(format!(
                        "left out {s} in {path}: a custom module is the person's own"
                    ));
                } else {
                    keep.push(item.clone());
                }
            }
            Ok(Some(Json::Array(keep)))
        }
        _ => Err("must be a string, a number or true or false".into()),
    }
}

/// Values by path as one object.
pub fn tree(values: &BTreeMap<String, Json>) -> Json {
    let mut root = Map::new();
    for (path, v) in values {
        put(&mut root, path, v.clone());
    }
    Json::Object(root)
}

/// Sets a dotted path in an object, making the objects on the way.
pub fn put(o: &mut Map<String, Json>, path: &str, v: Json) {
    match path.split_once('.') {
        None => {
            o.insert(path.into(), v);
        }
        Some((k, rest)) => {
            let child = o.entry(k.to_string()).or_insert_with(|| json!({}));
            if !child.is_object() {
                *child = json!({});
            }
            if let Some(m) = child.as_object_mut() {
                put(m, rest, v);
            }
        }
    }
}
