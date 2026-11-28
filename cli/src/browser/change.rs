//! Turns a checked Helium app into Polycarp Browser, as `changes.toml` (shipped beside this command, GPL) says.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::rename::{self, Rename};
use super::tools::{must, Call, Tools};
use super::{refuse, Refused};

const CHECK: &str = "change";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Changes {
    pub from: From,
    pub to: To,
    info: Info,
    files: Files,
    icons: Icons,
    strings: Strings,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct From {
    pub name: String,
    pub identifier: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct To {
    pub name: String,
    pub identifier: String,
    pub data_folder: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Info {
    remove: Vec<String>,
    no: Vec<String>,
    yes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Files {
    remove: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Icons {
    icns: Vec<String>,
    png32: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Strings {
    keep: Vec<String>,
}

impl Changes {
    pub fn read(parts: &Path) -> Result<Changes, Refused> {
        let text = fs::read_to_string(parts.join("changes.toml"))
            .map_err(refuse("parts", "reading changes.toml"))?;
        toml::from_str(&text).map_err(|e| Refused::new("parts", format!("changes.toml: {e}")))
    }

    fn rename(&self) -> Rename<'_> {
        Rename {
            from: &self.from.name,
            to: &self.to.name,
            keep: &self.strings.keep,
        }
    }

    /// Text with Helium's name made Polycarp's, except where it is part of a phrase that stays.
    fn renamed(&self, text: &str) -> String {
        self.rename().renamed(text)
    }

    fn path(&self, app: &Path, framework: &str, listed: &str) -> PathBuf {
        app.join(listed.replace("{framework}", framework))
    }
}

/// Every file under `dir`, links and what they lead to left out.
pub fn files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            found.extend(files(&entry.path())?);
        } else if kind.is_file() {
            found.push(entry.path());
        }
    }
    found.sort();
    Ok(found)
}

/// The framework's version folder, relative to the app. There is exactly one.
fn framework(app: &Path, name: &str) -> Result<String, Refused> {
    let versions = format!("Contents/Frameworks/{name} Framework.framework/Versions");
    let mut found = Vec::new();
    for entry in fs::read_dir(app.join(&versions)).map_err(refuse(CHECK, "its framework"))? {
        let entry = entry.map_err(refuse(CHECK, "its framework"))?;
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            found.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    match found.as_slice() {
        [one] => Ok(format!("{versions}/{one}")),
        _ => Err(Refused::new(CHECK, "it has no single framework version")),
    }
}

pub fn plutil(tools: &dyn Tools, plist: &Path, args: &[&str]) -> Result<String, Refused> {
    let mut call = Call::new("/usr/bin/plutil", &[]);
    call.args = args.iter().map(Into::into).collect();
    call.args.push(plist.into());
    Ok(must(tools, CHECK, &call)?.out.trim().to_string())
}

/// A string in a property list; None when it isn't there.
pub fn plist_string(tools: &dyn Tools, plist: &Path, key: &str) -> Option<String> {
    let args = ["-extract", key, "raw", "-expect", "string", "-o", "-"];
    plutil(tools, plist, &args).ok()
}

fn set(tools: &dyn Tools, plist: &Path, key: &str, kind: &str, to: &str) -> Result<(), Refused> {
    plutil(tools, plist, &["-replace", key, kind, to]).map(|_| ())
}

/// Every change, in an order where a failure leaves only this half-made copy behind.
pub fn apply(
    tools: &dyn Tools,
    app: &Path,
    parts: &Path,
    changes: &Changes,
) -> Result<(), Refused> {
    let framework = framework(app, &changes.from.name)?;
    for listed in &changes.files.remove {
        remove(&changes.path(app, &framework, listed))?;
    }
    let all = files(app).map_err(refuse(CHECK, "listing its files"))?;
    for file in &all {
        match file.file_name().and_then(OsStr::to_str) {
            Some(n) if n.ends_with("Info.plist") => rename_plist(tools, file, changes)?,
            Some("InfoPlist.strings") => rename_strings(tools, file, changes)?,
            _ => {}
        }
    }
    main_plist(tools, &app.join("Contents/Info.plist"), changes)?;
    rename_paks(&all, changes)?;
    let copies = [
        ("icon.icns", &changes.icons.icns),
        ("icon-32.png", &changes.icons.png32),
    ];
    for (part, places) in copies {
        for listed in places {
            let to = changes.path(app, &framework, listed);
            if !to.is_file() {
                return Err(Refused::new(CHECK, format!("it has no {listed}")));
            }
            fs::copy(parts.join(part), &to).map_err(refuse(CHECK, "putting the icon in"))?;
        }
    }
    Ok(())
}

/// Where Polycarp.app keeps the browser's icon in the Polycarp theme's colors, beside the browser theme (spec/themes.md,
/// "The icons"). It is there only while a theme is in force.
pub fn theme_icon_path(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Polycarp/browser-theme/icon.icns")
}

/// That icon, when it is a whole `.icns`: its header, then a length that is the file's, at most 8 MB.
pub fn theme_icon(home: &Path) -> Option<Vec<u8>> {
    const MOST: usize = 8 << 20;
    let file = theme_icon_path(home);
    let meta = fs::metadata(&file).ok()?;
    if !meta.is_file() || meta.len() > MOST as u64 {
        return None;
    }
    let bytes = fs::read(file).ok()?;
    let length = u32::from_be_bytes(bytes.get(4..8)?.try_into().ok()?) as usize;
    (bytes.starts_with(b"icns") && length == bytes.len() && length <= MOST).then_some(bytes)
}

/// Puts the theme's icon where `apply` put the shipped one, so the build is signed with it. Without one, or one that is
/// not whole, the shipped icon stays. True when the theme's went in.
pub fn put_theme_icon(app: &Path, home: &Path, changes: &Changes) -> Result<bool, Refused> {
    let Some(icon) = theme_icon(home) else {
        return Ok(false);
    };
    let framework = framework(app, &changes.from.name)?;
    for listed in &changes.icons.icns {
        let to = changes.path(app, &framework, listed);
        fs::write(&to, &icon).map_err(refuse(CHECK, "putting the theme's icon in"))?;
    }
    Ok(true)
}

fn remove(path: &Path) -> Result<(), Refused> {
    let gone = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    };
    gone.map_err(refuse(CHECK, "removing a file"))
}

/// A nested plist of Helium's own: its identifier, and the name System Settings and Activity Monitor show.
fn rename_plist(tools: &dyn Tools, plist: &Path, changes: &Changes) -> Result<(), Refused> {
    let key = "CFBundleIdentifier";
    let Some(id) = plist_string(tools, plist, key) else {
        return Ok(());
    };
    let Some(tail) = id.strip_prefix(&changes.from.identifier) else {
        return Ok(());
    };
    if !tail.is_empty() && !tail.starts_with('.') {
        return Ok(());
    }
    let id = format!("{}{tail}", changes.to.identifier);
    set(tools, plist, key, "-string", &id)?;
    for key in ["CFBundleName", "CFBundleDisplayName"] {
        if let Some(name) = plist_string(tools, plist, key) {
            set(tools, plist, key, "-string", &changes.renamed(&name))?;
        }
    }
    Ok(())
}

fn main_plist(tools: &dyn Tools, plist: &Path, changes: &Changes) -> Result<(), Refused> {
    for (key, to) in [
        ("CFBundleName", &changes.to.name),
        ("CFBundleDisplayName", &changes.to.name),
        ("CrProductDirName", &changes.to.data_folder),
    ] {
        set(tools, plist, key, "-string", to)?;
    }
    for (keys, to) in [(&changes.info.no, "NO"), (&changes.info.yes, "YES")] {
        for key in keys {
            set(tools, plist, key, "-bool", to)?;
        }
    }
    let there = plutil(tools, plist, &["-convert", "json", "-o", "-"])?;
    let there: serde_json::Value = serde_json::from_str(&there)
        .map_err(|e| Refused::new(CHECK, format!("reading Info.plist: {e}")))?;
    for key in &changes.info.remove {
        if there.get(key).is_some() {
            plutil(tools, plist, &["-remove", key])?;
        }
    }
    let id = plist_string(tools, plist, "CFBundleIdentifier");
    if id.as_ref() != Some(&changes.to.identifier) {
        return Err(Refused::new(CHECK, "the app's identifier did not change"));
    }
    Ok(())
}

/// Most are text; a helper's is a binary property list, which is made text first. macOS reads either.
fn rename_strings(tools: &dyn Tools, file: &Path, changes: &Changes) -> Result<(), Refused> {
    let read = || fs::read(file).map_err(refuse(CHECK, "reading InfoPlist.strings"));
    let mut bytes = read()?;
    if bytes.starts_with(b"bplist") {
        plutil(tools, file, &["-convert", "xml1"])?;
        bytes = read()?;
    }
    let text = String::from_utf8(bytes)
        .ok()
        .filter(|t| !t.contains('\0'))
        .ok_or_else(|| Refused::new(CHECK, "InfoPlist.strings is not plain text"))?;
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut renamed = String::new();
    for (i, line) in lines.iter().enumerate() {
        // An entry is one line; in a property list its value is the line after its key.
        let before = match line.trim_start().starts_with("<string>") {
            true => lines[..i].last().copied().unwrap_or_default(),
            false => "",
        };
        let of = |key| line.contains(key) || before.contains(key);
        // The copyright names Helium's authors in each language's own words, so it stays, and so does what follows the name
        // and version in the line that repeats it.
        renamed += &match (of("NSHumanReadableCopyright"), of("CFBundleGetInfoString")) {
            (true, _) => line.to_string(),
            (_, true) => line.replacen(&changes.from.name, &changes.to.name, 1),
            _ => changes.renamed(line),
        };
    }
    fs::write(file, renamed).map_err(refuse(CHECK, "writing InfoPlist.strings"))
}

/// The interface's text, in every language, as `rename::rename_paks` makes it.
fn rename_paks(all: &[PathBuf], changes: &Changes) -> Result<(), Refused> {
    let packs: Vec<&PathBuf> = all.iter().filter(|f| f.ends_with("locale.pak")).collect();
    let english = |f: &Path| f.ends_with("en.lproj/locale.pak");
    rename::rename_paks(&packs, &english, &changes.rename())
}

#[cfg(test)]
mod tests {
    use super::super::pak::Pak;
    use super::super::testing::*;
    use super::super::tools::System;
    use super::*;

    fn changed() -> (Fake, PathBuf) {
        let t = Fake::new();
        let app = t.fixture_app();
        let parts = t.parts();
        apply(&System, &app, &parts, &Changes::read(&parts).unwrap()).unwrap();
        (t, app)
    }

    fn value(app: &Path, plist: &str, key: &str) -> Option<String> {
        plist_string(&System, &app.join(plist), key)
    }

    #[test]
    fn the_app_takes_polycarps_name_identifier_and_data_folder() {
        let (_t, app) = changed();
        let info = |key| value(&app, "Contents/Info.plist", key);
        assert_eq!(
            info("CFBundleIdentifier").unwrap(),
            "com.baney.polycarp.browser"
        );
        assert_eq!(info("CFBundleDisplayName").unwrap(), "Polycarp Browser");
        assert_eq!(info("CFBundleName").unwrap(), "Polycarp Browser");
        assert_eq!(info("CrProductDirName").unwrap(), "Polycarp/Browser");
        assert_eq!(info("CFBundleExecutable").unwrap(), "Helium");
        let helper = format!("{FRAMEWORK}/Helpers/Helium Helper (Alerts).app/Contents/Info.plist");
        let helper = |key| value(&app, &helper, key).unwrap();
        let id = helper("CFBundleIdentifier");
        assert_eq!(
            id,
            "com.baney.polycarp.browser.framework.AlertNotificationService"
        );
        assert_eq!(helper("CFBundleName"), "Polycarp Browser Helper (Alerts)");
        assert_eq!(helper("CFBundleExecutable"), "Helium Helper (Alerts)");
        let other =
            format!("{FRAMEWORK}/Frameworks/Sparkle.framework/Versions/B/Resources/Info.plist");
        let other = value(&app, &other, "CFBundleIdentifier").unwrap();
        assert_eq!(other, "org.sparkle-project.Sparkle");
    }

    #[test]
    fn only_heliums_own_identifiers_are_renamed() {
        let t = Fake::new();
        let changes = Changes::read(&t.parts()).unwrap();
        let app = t.fixture_app();
        for (id, then, name) in [
            (
                "net.imput.helium.x",
                "com.baney.polycarp.browser.x",
                "Polycarp Browser X",
            ),
            ("net.imput.heliumx", "net.imput.heliumx", "Helium X"),
        ] {
            let plist = app.join("X-Info.plist");
            let text = format!(
                "<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{id}</string>\
                 <key>CFBundleDisplayName</key><string>Helium X</string></dict></plist>"
            );
            fs::write(&plist, text).unwrap();
            rename_plist(&System, &plist, &changes).unwrap();
            let value = |key| plist_string(&System, &plist, key).unwrap();
            assert_eq!(value("CFBundleIdentifier"), then);
            assert_eq!(value("CFBundleDisplayName"), name);
        }
    }

    /// Sparkle refuses to start exactly when it is told to verify and has no key to verify with.
    #[test]
    fn the_updater_can_not_start_and_its_installers_are_gone() {
        let (_t, app) = changed();
        let plist = app.join("Contents/Info.plist");
        let json = plutil(&System, &plist, &["-convert", "json", "-o", "-"]).unwrap();
        let info: serde_json::Value = serde_json::from_str(&json).unwrap();
        for gone in ["SUPublicEDKey", "SUFeedURL", "SUScheduledCheckInterval"] {
            assert_eq!(info.get(gone), None, "{gone}");
        }
        assert_eq!(info["SUVerifyUpdateBeforeExtraction"], true);
        assert_eq!(info["SUEnableAutomaticChecks"], false);
        assert_eq!(info["SUAutomaticallyUpdate"], false);
        let sparkle = app.join(FRAMEWORK).join("Frameworks/Sparkle.framework");
        for gone in [
            "Autoupdate",
            "Updater.app",
            "Versions/B/Autoupdate",
            "Versions/B/Updater.app",
        ] {
            assert!(fs::symlink_metadata(sparkle.join(gone)).is_err(), "{gone}");
        }
        assert!(sparkle.join("Versions/B/Sparkle").is_file());
    }

    #[test]
    fn upstreams_grant_ticket_and_icon_are_gone() {
        let (t, app) = changed();
        for gone in [
            "embedded.provisionprofile",
            "CodeResources",
            "Resources/Assets.car",
        ] {
            assert!(!app.join("Contents").join(gone).exists(), "{gone}");
        }
        assert_eq!(value(&app, "Contents/Info.plist", "CFBundleIconName"), None);
        let icon = fs::read(t.parts().join("icon.icns")).unwrap();
        assert_eq!(
            fs::read(app.join("Contents/Resources/app.icns")).unwrap(),
            icon
        );
    }

    #[test]
    fn the_themes_icon_goes_in_only_when_it_is_whole() {
        let (t, app) = changed();
        let changes = Changes::read(&t.parts()).unwrap();
        let home = t.work().join("home");
        let shipped = fs::read(t.parts().join("icon.icns")).unwrap();
        let main = app.join("Contents/Resources/app.icns");
        // No theme: the shipped icon.
        assert!(!put_theme_icon(&app, &home, &changes).unwrap());
        assert_eq!(fs::read(&main).unwrap(), shipped);
        let file = theme_icon_path(&home);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        // A header whose length is not the file's, then one cut short: not whole.
        for bad in [&b"icns\0\0\0\x20 too short"[..], &b"icns"[..]] {
            fs::write(&file, bad).unwrap();
            assert!(!put_theme_icon(&app, &home, &changes).unwrap());
            assert_eq!(fs::read(&main).unwrap(), shipped);
        }
        // Whole but over 8 MB.
        let mut big = vec![0u8; (8 << 20) + 16];
        big[..4].copy_from_slice(b"icns");
        let length = (big.len() as u32).to_be_bytes();
        big[4..8].copy_from_slice(&length);
        fs::write(&file, &big).unwrap();
        assert!(!put_theme_icon(&app, &home, &changes).unwrap());
        assert_eq!(fs::read(&main).unwrap(), shipped);
        let mut whole = b"icns\0\0\0\0ic07 a png".to_vec();
        let length = (whole.len() as u32).to_be_bytes();
        whole[4..8].copy_from_slice(&length);
        fs::write(&file, &whole).unwrap();
        assert!(put_theme_icon(&app, &home, &changes).unwrap());
        for listed in &changes.icons.icns {
            let framework = framework(&app, &changes.from.name).unwrap();
            assert_eq!(
                fs::read(changes.path(&app, &framework, listed)).unwrap(),
                whole,
                "{listed}"
            );
        }
    }

    #[test]
    fn what_macos_shows_names_polycarp_and_keeps_the_credits() {
        let (_t, app) = changed();
        let strings = app.join("Contents/Resources/en.lproj/InfoPlist.strings");
        let strings = fs::read_to_string(strings).unwrap();
        assert!(
            strings.contains("Once Polycarp Browser has access"),
            "{strings}"
        );
        assert!(strings.contains("\"Polycarp Browser 158, Copyright The Helium Authors"));
        let german = app.join("Contents/Resources/de.lproj/InfoPlist.strings");
        let german = fs::read_to_string(german).unwrap();
        for line in [
            "CFBundleGetInfoString = \"Polycarp Browser 158, Copyright Die Helium-Autoren.\";",
            "NSHumanReadableCopyright = \"Copyright Die Helium-Autoren.\";",
            "NSCameraUsageDescription = \"Wenn Polycarp Browser Zugriff hat\";",
        ] {
            assert!(german.contains(line), "{german}");
        }
        // The same three entries as a property list, where a value is on the line after its key.
        let french = app.join("Contents/Resources/fr.lproj/InfoPlist.strings");
        let french = fs::read_to_string(french).unwrap();
        for line in [
            "<string>Polycarp Browser 158, Copyright Les auteurs de Helium.</string>",
            "<string>Copyright Les auteurs de Helium.</string>",
            "<string>Si Polycarp Browser a acc\u{e8}s</string>",
        ] {
            assert!(french.contains(line), "{french}");
        }
        let helper = format!("{FRAMEWORK}/Helpers/Helium Helper (Alerts).app/Contents");
        let binary = format!("{helper}/Resources/base.lproj/InfoPlist.strings");
        let name = value(&app, &binary, "CFBundleDisplayName");
        assert_eq!(name.unwrap(), "Polycarp Browser");
    }

    #[test]
    fn the_interface_names_polycarp_in_every_language() {
        let (_t, app) = changed();
        for (lang, about, kept) in [
            ("en", "About Polycarp Browser", "Allow Helium services"),
            // Kept by its id: this language's text does not hold the English phrase.
            (
                "de",
                "Info zu Polycarp Browser",
                "Dienste von Helium erlauben",
            ),
        ] {
            let pak = fs::read(
                app.join(FRAMEWORK)
                    .join(format!("Resources/{lang}.lproj/locale.pak")),
            );
            let pak = Pak::parse(&pak.unwrap()).unwrap();
            let text = |i: usize| String::from_utf8(pak.entries[i].1.clone()).unwrap();
            assert_eq!((text(0).as_str(), text(1).as_str()), (about, kept));
        }
    }

    #[test]
    fn an_app_laid_out_some_other_way_is_refused() {
        type Spoil = fn(&Path);
        let cases: [Spoil; 6] = [
            |app| fs::create_dir(app.join(FRAMEWORK).with_file_name("9.9")).unwrap(),
            |app| fs::remove_dir_all(app.join("Contents/Frameworks")).unwrap(),
            |app| fs::remove_file(app.join("Contents/Resources/app.icns")).unwrap(),
            |app| {
                let info = app.join("Contents/Info.plist");
                let text = fs::read_to_string(&info).unwrap();
                fs::write(info, text.replace("net.imput.helium", "org.example")).unwrap();
            },
            |app| {
                fs::write(
                    app.join(FRAMEWORK).join("Resources/de.lproj/locale.pak"),
                    "x",
                )
                .unwrap()
            },
            |app| fs::remove_dir_all(app.join(FRAMEWORK).join("Resources/en.lproj")).unwrap(),
        ];
        for (i, spoil) in cases.iter().enumerate() {
            let t = Fake::new();
            let app = t.fixture_app();
            spoil(&app);
            let parts = t.parts();
            let changes = Changes::read(&parts).unwrap();
            let e = apply(&System, &app, &parts, &changes).expect_err("spoiled");
            assert_eq!(e.check, "change", "case {i}: {e}");
        }
    }

    #[test]
    fn credits_keep_their_name() {
        let t = Fake::new();
        let changes = Changes::read(&t.parts()).unwrap();
        assert_eq!(
            changes.renamed("&Helium, Helium."),
            "&Polycarp Browser, Polycarp Browser."
        );
        assert_eq!(changes.renamed("The Helium Authors"), "The Helium Authors");
        assert_eq!(changes.renamed("none"), "none");
    }
}
