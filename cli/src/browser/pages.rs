//! What Polycarp adds to the app: its extension, loaded at every start, and the settings a new profile begins with.

use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde_json::json;

use super::change::{files, plutil, Changes};
use super::tools::Tools;
use super::{refuse, Place, Refused};

const CHECK: &str = "built-in pages";
/// Tells the extension it is part of this browser.
pub const BUILT_IN: &str = "builtin.txt";
/// The id Chromium gives the extension, from the key in its manifest.
const EXTENSION: &str = "kdaddaaobomjfjcgjeabgbenfddkcfcl";
const HOST: &str = "com.polycarp.newtab";

/// Puts the extension and the program that loads it into the app, which starts through that program from then on.
pub fn put_in(
    tools: &dyn Tools,
    app: &Path,
    place: &Place,
    changes: &Changes,
) -> Result<(), Refused> {
    let launcher = app.join("Contents/MacOS").join(&changes.to.name);
    fs::copy(place.parts.join("launcher"), &launcher)
        .and_then(|_| fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)))
        .map_err(refuse(CHECK, "putting the launcher in"))?;
    let info = app.join("Contents/Info.plist");
    let set = [
        "-replace",
        "CFBundleExecutable",
        "-string",
        &changes.to.name,
    ];
    plutil(tools, &info, &set)?;
    let to = app.join("Contents/Resources/polycarp/extension");
    copy(&place.extension, &to).map_err(refuse(CHECK, "copying the extension"))?;
    if !to.join("manifest.json").is_file() {
        return Err(Refused::new(CHECK, "the extension has no manifest"));
    }
    fs::write(to.join(BUILT_IN), "Polycarp Browser\n").map_err(refuse(CHECK, "marking it"))
}

/// Plain files only: a link in the extension would lead out of the signed app.
fn copy(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for file in files(from)? {
        let to = to.join(file.strip_prefix(from).map_err(io::Error::other)?);
        fs::create_dir_all(to.parent().unwrap_or(Path::new("/")))?;
        fs::write(to, fs::read(&file)?)?;
    }
    Ok(())
}

pub fn first_prefs() -> String {
    json!({ "helium": { "completed_onboarding": true } }).to_string()
}

/// No one has used the first profile: it isn't there, or holds only what `first_run` wrote.
pub fn untouched(data: &Path) -> bool {
    let first = data.join("Default");
    let Ok(files) = fs::read_dir(&first) else {
        return fs::symlink_metadata(first).is_err();
    };
    let only = |f: io::Result<fs::DirEntry>| f.is_ok_and(|f| f.file_name() == "Preferences");
    let prefs = fs::read_to_string(first.join("Preferences"));
    files.into_iter().all(only) && prefs.is_ok_and(|p| p == first_prefs())
}

/// The settings a new profile begins with: no welcome tour and no question about the default browser. Helium's own
/// online services are the person's choice, so they stay off until chosen. A profile that exists is never changed.
pub fn first_run(data: &Path) -> io::Result<bool> {
    if data.join("Local State").exists() || data.join("Default").exists() {
        return Ok(false);
    }
    fs::create_dir_all(data.join("Default"))?;
    fs::set_permissions(data, fs::Permissions::from_mode(0o700))?;
    let local = json!({ "helium": { "browser": { "default_browser_infobar_rejected": true } } });
    fs::write(data.join("Default/Preferences"), first_prefs())?;
    fs::write(data.join("First Run"), "")?;
    // Last: it is what says the profile exists.
    fs::write(data.join("Local State"), local.to_string())?;
    Ok(true)
}

/// Lets the new tab page ask Polycarp, at `host`, for the Mac's theme, paper and verse.
fn register_host(data: &Path, host: &Path) -> io::Result<()> {
    let dir = data.join("NativeMessagingHosts");
    fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{HOST}.json"));
    let text = json!({
        "name": HOST,
        "description": "Polycarp's new tab page",
        "path": host,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION}/")],
    });
    fs::write(file, format!("{text:#}\n"))
}

/// What the browser's own data folder needs. The app is in by now, so a failure is a line to print.
pub fn set_up(data: &Path, host: Option<&Path>) -> Vec<String> {
    let mut lines = Vec::new();
    match first_run(data) {
        Ok(true) => lines.push(
            "Helium's online services stay off until you choose them at helium://settings/privacy/services.".into(),
        ),
        Ok(false) => {}
        Err(e) => lines.push(format!("Its first profile could not be prepared: {e}")),
    }
    if let Some(Err(e)) = host.map(|host| register_host(data, host)) {
        lines.push(format!(
            "Its new tab can't ask Polycarp for your theme: {e}"
        ));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::super::change::plist_string;
    use super::super::testing::*;
    use super::super::tools::System;
    use super::*;

    #[test]
    fn the_app_starts_through_the_launcher_with_the_extension_inside() {
        let t = Fake::new();
        let app = t.fixture_app();
        let place = t.place();
        std::os::unix::fs::symlink("/etc/hosts", place.extension.join("out")).unwrap();
        let changes = Changes::read(&place.parts).unwrap();
        put_in(&System, &app, &place, &changes).unwrap();
        let info = app.join("Contents/Info.plist");
        let program = plist_string(&System, &info, "CFBundleExecutable").unwrap();
        assert_eq!(program, "Polycarp Browser");
        let program = app.join("Contents/MacOS").join(program);
        let mode = fs::metadata(program).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        assert!(app.join("Contents/MacOS/Helium").is_file());
        let extension = app.join("Contents/Resources/polycarp/extension");
        assert!(extension.join("newtab/newtab.html").is_file());
        assert!(extension.join(BUILT_IN).is_file());
        let out = extension.join("out");
        assert!(fs::symlink_metadata(out).is_err(), "a link was copied");
        fs::remove_file(place.extension.join("manifest.json")).unwrap();
        fs::remove_dir_all(extension).unwrap();
        let e = put_in(&System, &app, &place, &changes).unwrap_err();
        assert_eq!(e.check, "built-in pages");
    }

    #[test]
    fn a_new_profile_skips_the_tour_and_one_that_exists_is_left_alone() {
        let t = Fake::new();
        let data = t.work().join("Polycarp/Browser");
        assert!(first_run(&data).unwrap());
        let read = |file: &str| fs::read_to_string(data.join(file)).unwrap();
        assert!(read("Default/Preferences").contains("\"completed_onboarding\":true"));
        assert!(read("Local State").contains("default_browser_infobar_rejected"));
        assert!(!read("Default/Preferences").contains("consented"));
        let mode = fs::metadata(&data).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        fs::write(data.join("Default/Preferences"), "mine").unwrap();
        assert!(!first_run(&data).unwrap());
        fs::remove_file(data.join("Local State")).unwrap();
        assert!(!first_run(&data).unwrap());
        assert_eq!(read("Default/Preferences"), "mine");
    }

    #[test]
    fn only_polycarps_extension_may_ask_the_host() {
        let t = Fake::new();
        register_host(&t.work(), Path::new("/x/polycarp-spaces")).unwrap();
        let hosts = t.work().join("NativeMessagingHosts");
        let file = hosts.join("com.polycarp.newtab.json");
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
        assert_eq!(value["path"], "/x/polycarp-spaces");
        let origin = format!("chrome-extension://{EXTENSION}/");
        assert_eq!(value["allowed_origins"], json!([origin]));
    }
}
