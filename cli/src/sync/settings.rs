//! Polycarp's own settings as sync items, and back.
//!
//! - `surfaces:<pointer>`: each leaf of `surfaces.json` (the bar, the desktop, the tiling and role keys, ...).
//! - `config:<pointer>`: each leaf of the config folder's `config.toml` (the theme, its mode and accents).
//! - `theme-file:<name>`: the text of `themes/<name>.toml`.
//! - `style:style.css`: the text of the style sheet.
//!
//! A pointer is the keys joined with `/` (`/bar/height`); an array is one leaf. Machine-only fields stay on this
//! machine and are never sent: they are listed in [`MACHINE_ONLY`], and every string that is a local file path is one
//! too. A field this build doesn't know, from another OS or a newer Polycarp, is an item like any other: it is kept in
//! the file and passed back unchanged.

use serde_json::{Map, Value as Json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Fields that belong to one machine, by file and pointer prefix. The test below holds this list in place.
pub const MACHINE_ONLY: &[(&str, &str)] = &[
    // Where this machine keeps its rooms.
    ("surfaces", "/rooms/root"),
    // The Omarchy follow hook an older Polycarp wrote; it names this machine's files.
    ("config", "/omarchy"),
    // Where `theme folder --pin` points, on this machine.
    ("config", "/folder"),
];

/// Any key with one of these words in it is machine-only, in any file: display ids, window frames, paths, caches.
pub const MACHINE_WORDS: &[&str] = &["display", "frame", "path", "cache", "screen"];

pub struct Paths {
    /// Polycarp's config folder (`theme::config_dir`).
    pub config: PathBuf,
    /// The folder `surfaces.json` is in.
    pub support: PathBuf,
}

impl Paths {
    fn surfaces(&self) -> PathBuf {
        self.support.join("surfaces.json")
    }
    fn config_toml(&self) -> PathBuf {
        self.config.join("config.toml")
    }
    fn themes(&self) -> PathBuf {
        self.config.join("themes")
    }
    fn style(&self) -> PathBuf {
        self.config.join("style.css")
    }
}

fn is_local_path(v: &Json) -> bool {
    let Some(s) = v.as_str() else { return false };
    let b = s.as_bytes();
    s.starts_with('/')
        || s.starts_with("~/")
        || s.starts_with("file:")
        || s.starts_with("\\\\")
        || (b.len() > 2
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && (b[2] == b'\\' || b[2] == b'/'))
}

/// True when the field at `pointer` in `file` stays on this machine.
pub fn machine_only(file: &str, pointer: &str, v: &Json) -> bool {
    let listed = MACHINE_ONLY
        .iter()
        .any(|(f, p)| *f == file && (pointer == *p || pointer.starts_with(&format!("{p}/"))));
    let worded = pointer.split('/').any(|seg| {
        let seg = seg.to_ascii_lowercase();
        MACHINE_WORDS.iter().any(|w| seg.contains(w))
    });
    listed || worded || is_local_path(v)
}

fn escape(k: &str) -> String {
    k.replace('~', "~0").replace('/', "~1")
}
fn unescape(k: &str) -> String {
    k.replace("~1", "/").replace("~0", "~")
}

/// Each leaf of `v` with its pointer. An empty object is a leaf, so it survives the trip.
pub fn flatten(v: &Json, prefix: &str, out: &mut BTreeMap<String, Json>) {
    match v {
        Json::Object(m) if !m.is_empty() => {
            for (k, child) in m {
                flatten(child, &format!("{prefix}/{}", escape(k)), out);
            }
        }
        _ => {
            out.insert(prefix.to_string(), v.clone());
        }
    }
}

/// The object the leaves make. The inverse of [`flatten`].
pub fn unflatten(leaves: &BTreeMap<String, Json>) -> Json {
    let mut root = Json::Object(Map::new());
    for (ptr, v) in leaves {
        if ptr.is_empty() {
            return v.clone();
        }
        let keys: Vec<String> = ptr[1..].split('/').map(unescape).collect();
        let mut at = &mut root;
        for k in &keys[..keys.len() - 1] {
            let m = at.as_object_mut().expect("parents are objects");
            at = m
                .entry(k.clone())
                .or_insert_with(|| Json::Object(Map::new()));
            if !at.is_object() {
                *at = Json::Object(Map::new());
            }
        }
        if let Some(m) = at.as_object_mut() {
            m.insert(keys[keys.len() - 1].clone(), v.clone());
        }
    }
    root
}

fn read_doc(file: &str, p: &Path) -> Result<Option<Json>, String> {
    let text = match fs::read_to_string(p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("could not read {}: {e}", p.display())),
    };
    let doc = if file == "config" {
        toml::from_str::<toml::Value>(&text)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::to_value(t).map_err(|e| e.to_string()))
    } else {
        serde_json::from_str(&text).map_err(|e| e.to_string())
    };
    doc.map(Some).map_err(|e| {
        format!(
            "{} can't be read, so settings were not synced: {e}",
            p.display()
        )
    })
}

fn valid_theme_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && n.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The settings this machine holds now, machine-only fields left out.
pub fn snapshot(p: &Paths) -> Result<BTreeMap<String, Json>, String> {
    let mut out = BTreeMap::new();
    for (file, path) in [("surfaces", p.surfaces()), ("config", p.config_toml())] {
        let Some(doc) = read_doc(file, &path)? else {
            continue;
        };
        let mut leaves = BTreeMap::new();
        flatten(&doc, "", &mut leaves);
        for (ptr, v) in leaves {
            if !machine_only(file, &ptr, &v) {
                out.insert(format!("{file}:{ptr}"), v);
            }
        }
    }
    if let Ok(dir) = fs::read_dir(p.themes()) {
        for e in dir.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(stem) = name.strip_suffix(".toml").filter(|s| valid_theme_name(s)) else {
                continue;
            };
            if let Ok(text) = fs::read_to_string(e.path()) {
                out.insert(format!("theme-file:{stem}"), Json::String(text));
            }
        }
    }
    if let Ok(text) = fs::read_to_string(p.style()) {
        out.insert("style:style.css".into(), Json::String(text));
    }
    Ok(out)
}

/// Writes a file whole: a temp file beside it, then a rename, so nothing reads half of one.
fn write_whole(p: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| format!("could not make {}: {e}", d.display()))?;
    }
    let tmp = p.with_extension("sync-tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, p).map_err(|e| format!("could not write {}: {e}", p.display()))
}

/// Makes this machine's settings what `values` holds. Machine-only fields already in a file stay as they are, and a
/// file is only written when it changes. Returns the files written.
pub fn apply(p: &Paths, values: &BTreeMap<String, Json>) -> Result<Vec<PathBuf>, String> {
    let mut wrote = Vec::new();
    for (file, path) in [("surfaces", p.surfaces()), ("config", p.config_toml())] {
        let before = read_doc(file, &path)?;
        let mut leaves = BTreeMap::new();
        if let Some(doc) = &before {
            let mut all = BTreeMap::new();
            flatten(doc, "", &mut all);
            leaves.extend(
                all.into_iter()
                    .filter(|(ptr, v)| machine_only(file, ptr, v)),
            );
        }
        let prefix = format!("{file}:");
        for (id, v) in values {
            if let Some(ptr) = id.strip_prefix(&prefix) {
                leaves.insert(ptr.to_string(), v.clone());
            }
        }
        if leaves.is_empty() && before.is_none() {
            continue;
        }
        let doc = unflatten(&leaves);
        if before.as_ref() == Some(&doc) {
            continue;
        }
        let bytes = if file == "config" {
            let t: toml::Value = serde_json::from_value(doc).map_err(|e| e.to_string())?;
            toml::to_string(&t).map_err(|e| e.to_string())?.into_bytes()
        } else {
            let mut b = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
            b.push(b'\n');
            b
        };
        write_whole(&path, &bytes)?;
        wrote.push(path);
    }
    let mut texts: Vec<(PathBuf, Option<&Json>)> = Vec::new();
    if let Ok(dir) = fs::read_dir(p.themes()) {
        for e in dir.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(stem) = name.strip_suffix(".toml").filter(|s| valid_theme_name(s)) {
                texts.push((e.path(), values.get(&format!("theme-file:{stem}"))));
            }
        }
    }
    for (id, v) in values {
        if let Some(stem) = id
            .strip_prefix("theme-file:")
            .filter(|s| valid_theme_name(s))
        {
            texts.push((p.themes().join(format!("{stem}.toml")), Some(v)));
        }
    }
    texts.push((p.style(), values.get("style:style.css")));
    texts.sort_by(|a, b| a.0.cmp(&b.0));
    texts.dedup_by(|a, b| a.0 == b.0);
    for (path, want) in texts {
        let have = fs::read_to_string(&path).ok();
        match (want.and_then(Json::as_str), have) {
            (Some(w), h) if h.as_deref() != Some(w) => {
                write_whole(&path, w.as_bytes())?;
                wrote.push(path);
            }
            (None, Some(_)) => {
                fs::remove_file(&path)
                    .map_err(|e| format!("could not remove {}: {e}", path.display()))?;
                wrote.push(path);
            }
            _ => {}
        }
    }
    Ok(wrote)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> Paths {
        let root = std::env::temp_dir().join(format!(
            "polycarp-sync-settings-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        Paths {
            config: root.join("config"),
            support: root.join("support"),
        }
    }

    #[test]
    fn the_machine_only_list_holds() {
        assert_eq!(
            MACHINE_ONLY,
            &[
                ("surfaces", "/rooms/root"),
                ("config", "/omarchy"),
                ("config", "/folder")
            ]
        );
        assert_eq!(
            MACHINE_WORDS,
            &["display", "frame", "path", "cache", "screen"]
        );
        assert!(machine_only(
            "surfaces",
            "/bar/displayId",
            &json!("37D8832A")
        ));
        assert!(machine_only("surfaces", "/rooms/root", &json!("x")));
        assert!(machine_only(
            "surfaces",
            "/desktop/paper",
            &json!("/Users/d/Pictures/a.jpg")
        ));
        assert!(machine_only(
            "surfaces",
            "/idle/paper",
            &json!("C:\\Users\\d\\a.jpg")
        ));
        assert!(!machine_only("surfaces", "/bar/height", &json!(30)));
        assert!(!machine_only(
            "surfaces",
            "/newtab/searchURL",
            &json!("https://kagi.com/search?q=%s")
        ));
    }

    #[test]
    fn a_display_id_is_never_sent_and_stays_on_the_machine() {
        let p = temp("display");
        write_whole(
            &p.surfaces(),
            br#"{"bar":{"height":30,"displayId":"37D8832A"},"rooms":{"root":"/Users/d/Rooms"}}"#,
        )
        .unwrap();
        let snap = snapshot(&p).unwrap();
        assert_eq!(snap.keys().collect::<Vec<_>>(), ["surfaces:/bar/height"]);
        let mut theirs = snap.clone();
        theirs.insert("surfaces:/bar/height".into(), json!(28));
        apply(&p, &theirs).unwrap();
        let doc: Json = serde_json::from_str(&fs::read_to_string(p.surfaces()).unwrap()).unwrap();
        assert_eq!(
            doc,
            json!({"bar":{"height":28,"displayId":"37D8832A"},"rooms":{"root":"/Users/d/Rooms"}})
        );
    }

    #[test]
    fn a_setting_this_os_lacks_is_kept_and_passed_back_unchanged() {
        let p = temp("passthrough");
        let mut from_mac = BTreeMap::new();
        from_mac.insert(
            "surfaces:/mac/menuBarAutohide/when".to_string(),
            json!("fullscreen"),
        );
        from_mac.insert("config:/appearance/theme".to_string(), json!("still-water"));
        apply(&p, &from_mac).unwrap();
        assert_eq!(snapshot(&p).unwrap(), from_mac);
        assert!(
            apply(&p, &from_mac).unwrap().is_empty(),
            "nothing changes the second time"
        );
    }

    #[test]
    fn theme_files_and_the_style_sheet_come_and_go() {
        let p = temp("files");
        let mut v = BTreeMap::new();
        v.insert("theme-file:mine".to_string(), json!("name = \"mine\"\n"));
        v.insert(
            "style:style.css".to_string(),
            json!(".bar { opacity: 0.9 }\n"),
        );
        v.insert("theme-file:../evil".to_string(), json!("x"));
        apply(&p, &v).unwrap();
        assert_eq!(
            fs::read_to_string(p.themes().join("mine.toml")).unwrap(),
            "name = \"mine\"\n"
        );
        assert!(!p.config.join("evil.toml").exists());
        v.remove("theme-file:../evil");
        assert_eq!(snapshot(&p).unwrap(), v);
        apply(&p, &BTreeMap::new()).unwrap();
        assert!(!p.themes().join("mine.toml").exists());
        assert!(!p.style().exists());
    }

    #[test]
    fn a_file_that_is_not_json_stops_the_sync_and_is_left_alone() {
        let p = temp("broken");
        write_whole(&p.surfaces(), b"{not json").unwrap();
        assert!(snapshot(&p).unwrap_err().contains("surfaces.json"));
        assert!(apply(&p, &BTreeMap::new()).is_err());
        assert_eq!(fs::read(p.surfaces()).unwrap(), b"{not json");
    }

    #[test]
    fn flatten_and_unflatten_are_inverse() {
        let v = json!({"a":{"b/c":1,"d~":[1,2],"e":{}},"f":"g"});
        let mut leaves = BTreeMap::new();
        flatten(&v, "", &mut leaves);
        assert_eq!(unflatten(&leaves), v);
    }
}
