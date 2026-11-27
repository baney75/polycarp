//! Local Studio's extension, built into Polycarp Browser when this Polycarp build carries it (spec/browser.md R-B20).
//! It is never a reason to refuse a build: without it the browser has Polycarp's extension only, and a line says why.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The id Chromium gives Local Studio's extension, from the key in its manifest.
pub const ID: &str = "igjafcggmahiboobmnhfkndodphjdnhg";
const HOST: &str = "com.localstudio.browser";
/// Where it sits in the app, beside Polycarp's own extension. The launcher loads it from there.
pub const IN_APP: &str = "Contents/Resources/polycarp/local-studio";
/// What `browser/scripts/build-local-studio.sh` writes beside it: the commit it was built from.
pub const PIN: &str = "polycarp-pin.txt";

#[derive(Debug, PartialEq)]
pub struct About {
    pub version: String,
    pub commit: Option<String>,
}

/// The id Chromium gives an extension whose manifest has this key.
fn id_of(key: &str) -> Option<String> {
    let der = base64::engine::general_purpose::STANDARD
        .decode(key.trim())
        .ok()?;
    let digest = Sha256::digest(der);
    let letter = |n: u8| char::from(b'a' + n);
    Some(
        digest[..16]
            .iter()
            .flat_map(|b| [letter(b >> 4), letter(b & 15)])
            .collect(),
    )
}

/// What `folder` holds when it is Local Studio's extension; Err says why it isn't.
pub fn read(folder: &Path) -> Result<About, String> {
    let text = fs::read(folder.join("manifest.json")).map_err(|_| "it has no manifest")?;
    let manifest: Value = serde_json::from_slice(&text).map_err(|_| "its manifest isn't JSON")?;
    let key = manifest["key"].as_str().ok_or("its manifest has no key")?;
    let id = id_of(key).ok_or("its manifest's key isn't base64")?;
    if id != ID {
        return Err(format!("its id is {id}, not Local Studio's {ID}"));
    }
    let version = manifest["version"]
        .as_str()
        .ok_or("its manifest has no version")?;
    let pin = fs::read_to_string(folder.join(PIN)).unwrap_or_default();
    let commit = pin.lines().next().map(str::trim).map(String::from);
    let commit = commit.filter(|c| c.len() == 40 && c.bytes().all(|b| b.is_ascii_hexdigit()));
    Ok(About {
        version: version.into(),
        commit,
    })
}

/// Puts the extension staged in Polycarp.app into `app`. The line says why it was left out; it never stops the build.
pub fn put_in(staged: &Path, app: &Path) -> Option<String> {
    let left_out = |why: &str| {
        Some(format!(
            "Local Studio's extension was left out of the browser: {why}."
        ))
    };
    if !staged.exists() {
        return left_out("this Polycarp build doesn't carry it");
    }
    if let Err(why) = read(staged) {
        return left_out(&why);
    }
    let to = app.join(IN_APP);
    let copied = super::pages::copy(staged, &to).map_err(|e| e.to_string());
    match copied.and_then(|_| read(&to)) {
        Ok(_) => None,
        Err(why) => {
            let _ = fs::remove_dir_all(&to);
            left_out(&format!("copying it: {why}"))
        }
    }
}

/// Helium's registration of Local Studio's helper, which Local Studio's own installer writes and keeps current.
fn helium_host(home: &Path) -> PathBuf {
    let helium = home.join("Library/Application Support/net.imput.helium");
    helium
        .join("NativeMessagingHosts")
        .join(format!("{HOST}.json"))
}

/// The helper Helium's registration names, when it is a program there. Read only: Helium's file is never written.
/// A path inside `<folder>/versions/<one>/` becomes `<folder>/release/`'s, when that is the same program, so the next
/// Local Studio release, which moves that link, still answers.
fn helper(home: &Path) -> Result<PathBuf, String> {
    let file = helium_host(home);
    let text = fs::read(&file).map_err(|_| format!("{} isn't there", file.display()))?;
    let value: Value =
        serde_json::from_slice(&text).map_err(|_| "Helium's registration isn't JSON")?;
    let path = PathBuf::from(
        value["path"]
            .as_str()
            .ok_or("Helium's registration names no program")?,
    );
    let meta = fs::metadata(&path)
        .ok()
        .filter(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
    if !path.is_absolute() || meta.is_none() {
        return Err(format!("{} is not a program", path.display()));
    }
    let versions = path
        .ancestors()
        .nth(2)
        .filter(|v| v.file_name().is_some_and(|n| n == "versions"));
    let release = versions
        .zip(path.file_name())
        .and_then(|(v, name)| Some(v.parent()?.join("release").join(name)));
    let same = |other: &Path| fs::canonicalize(other).ok() == fs::canonicalize(&path).ok();
    Ok(release.filter(|r| same(r)).unwrap_or(path))
}

/// Lets the built-in Local Studio extension reach its helper from Polycarp Browser's data folder. Nothing to do when the
/// app has no Local Studio inside; the line says why it can't, and an earlier registration is left as it was.
pub fn register(data: &Path, home: &Path, app: &Path) -> Option<String> {
    if !app.join(IN_APP).join("manifest.json").is_file() {
        return None;
    }
    let cant = |why: String| {
        Some(format!(
            "Local Studio's extension can't reach its helper yet: {why}. Install Local Studio for Helium, then run `polycarp browser install`."
        ))
    };
    let path = match helper(home) {
        Ok(path) => path,
        Err(why) => return cant(why),
    };
    let text = json!({
        "name": HOST,
        "description": "Local Studio browser bridge",
        "path": path,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{ID}/")],
    });
    let dir = data.join("NativeMessagingHosts");
    let wrote = fs::create_dir_all(&dir)
        .and_then(|_| fs::write(dir.join(format!("{HOST}.json")), format!("{text:#}\n")));
    wrote.err().and_then(|e| cant(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::super::testing::*;
    use super::*;

    #[test]
    fn the_key_gives_local_studios_id_and_another_is_left_out() {
        let t = Fake::new();
        let staged = t.local_studio_extension();
        let about = read(&staged).unwrap();
        assert_eq!(about.version, "1.4.1");
        assert_eq!(about.commit.as_deref(), Some(PINNED));
        let app = t.work().join("Polycarp Browser.app");
        assert_eq!(put_in(&staged, &app), None);
        assert!(app.join(IN_APP).join("manifest.json").is_file());
        assert!(app.join(IN_APP).join(PIN).is_file());

        let other = t.work().join("other");
        fs::create_dir_all(&other).unwrap();
        let key = base64::engine::general_purpose::STANDARD.encode(b"another key");
        fs::write(
            other.join("manifest.json"),
            json!({"key": key, "version": "1"}).to_string(),
        )
        .unwrap();
        let app = t.work().join("Second.app");
        let line = put_in(&other, &app).unwrap();
        assert!(line.contains("not Local Studio's"), "{line}");
        assert!(!app.join(IN_APP).exists());
        for (manifest, why) in [
            ("{", "isn't JSON"),
            ("{\"version\":\"1\"}", "no key"),
            ("{\"key\":\"!!\"}", "isn't base64"),
        ] {
            fs::write(other.join("manifest.json"), manifest).unwrap();
            assert!(put_in(&other, &app).unwrap().contains(why), "{manifest}");
        }
        let line = put_in(&t.work().join("absent"), &app).unwrap();
        assert!(line.contains("doesn't carry it"), "{line}");
        // A pin that isn't a whole commit is no commit.
        fs::write(staged.join(PIN), "347571d\n").unwrap();
        assert_eq!(read(&staged).unwrap().commit, None);
    }

    fn helium_says(home: &Path, path: &Path) {
        let file = helium_host(home);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, json!({"name": HOST, "path": path}).to_string()).unwrap();
    }

    fn program(at: &Path) {
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(at, "#!/bin/sh\n").unwrap();
        fs::set_permissions(at, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn the_helper_is_helium_s_by_its_release_link_and_only_ours_may_ask_it() {
        let t = Fake::new();
        let home = t.work().join("home");
        let data = t.work().join("data");
        let app = t.work().join("Polycarp Browser.app");
        // No Local Studio inside: nothing written and nothing said.
        assert_eq!(register(&data, &home, &app), None);
        put_in(&t.local_studio_extension(), &app);
        let line = register(&data, &home, &app).unwrap();
        assert!(line.contains("isn't there"), "{line}");
        let root = home.join(".local/share/local-studio-browser");
        let versioned = root.join("versions/1.4.1-0e5766ab50c3/local-studio-browser");
        helium_says(&home, &versioned);
        assert!(register(&data, &home, &app)
            .unwrap()
            .contains("not a program"));
        program(&versioned);
        let ours = data
            .join("NativeMessagingHosts")
            .join(format!("{HOST}.json"));
        let written = || -> Value { serde_json::from_slice(&fs::read(&ours).unwrap()).unwrap() };
        assert_eq!(register(&data, &home, &app), None);
        assert_eq!(written()["path"], json!(versioned));
        std::os::unix::fs::symlink("versions/1.4.1-0e5766ab50c3", root.join("release")).unwrap();
        assert_eq!(register(&data, &home, &app), None);
        let value = written();
        assert_eq!(
            value["path"],
            json!(root.join("release/local-studio-browser"))
        );
        assert_eq!(
            value["allowed_origins"],
            json!([format!("chrome-extension://{ID}/")])
        );
        assert_eq!(
            (value["name"].as_str(), value["type"].as_str()),
            (Some(HOST), Some("stdio"))
        );
        // A release link to another program isn't the same one: Helium's own path stays.
        let newer = root.join("versions/1.5.0-aaaaaaaaaaaa/local-studio-browser");
        program(&newer);
        fs::remove_file(root.join("release")).unwrap();
        std::os::unix::fs::symlink("versions/1.5.0-aaaaaaaaaaaa", root.join("release")).unwrap();
        register(&data, &home, &app);
        assert_eq!(written()["path"], json!(versioned));
        // A relative path is no program, and what was written before stays.
        helium_says(&home, Path::new("local-studio-browser"));
        assert!(register(&data, &home, &app)
            .unwrap()
            .contains("not a program"));
        assert_eq!(written()["path"], json!(versioned));
    }
}
