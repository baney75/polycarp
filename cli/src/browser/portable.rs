//! Polycarp Browser as a folder beside Helium's program, the way Windows (and Linux, later) lay it out: what is built
//! from a checked release. Pure file work; nothing here runs a program.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::pak;
use super::rename::{rename_paks, Rename};
use super::{is_link, refuse, Refused};

pub const RESOURCES: &str = "POLYCARP_BROWSER_RESOURCES";
/// Helium's own updater, beside `chrome.exe` in the zip.
const UPDATER: &str = "helium_update_helper.exe";
/// Read by Chromium on a profile's first run from the folder of `chrome.exe` (`InitialPrefsPath` in
/// chrome/browser/first_run/first_run_internal_win.cc). `helium.services.browser_updates` is Helium's
/// `kHeliumUpdateFetchingEnabled`, a profile pref that defaults to true (imputnet/helium,
/// patches/helium/core/add-updater-preference.patch).
pub const PREFS: &str =
    r#"{"helium":{"completed_onboarding":true,"services":{"browser_updates":false}}}"#;

/// What the build is made from, out of `POLYCARP_BROWSER_RESOURCES`.
#[derive(Debug)]
pub struct Parts {
    pub changes: PathBuf,
    pub launcher: PathBuf,
    pub license: PathBuf,
    pub extension: PathBuf,
    pub local_studio: PathBuf,
}

/// The parts, or a refusal naming what is missing. Nothing is downloaded before this passes.
pub fn parts(root: Option<OsString>) -> Result<Parts, Refused> {
    let make = "browser/scripts/build-parts-windows.sh DEST makes them";
    let root = root.filter(|r| !r.is_empty()).map(PathBuf::from);
    let Some(root) = root.filter(|r| r.is_absolute()) else {
        let why = format!("{RESOURCES} is not set to an absolute folder; {make}");
        return Err(Refused::new("parts", why));
    };
    let found = Parts {
        changes: root.join("make-browser").join("changes.toml"),
        launcher: root.join("make-browser").join("launcher.exe"),
        license: root.join("make-browser").join("LICENSE"),
        extension: root.join("extension"),
        local_studio: root.join("local-studio-extension"),
    };
    let needed = [
        &found.changes,
        &found.launcher,
        &found.license,
        &found.extension.join("manifest.json"),
    ];
    if let Some(missing) = needed.iter().find(|p| !p.is_file()) {
        let why = format!("{} is missing; {make}", missing.display());
        return Err(Refused::new("parts", why));
    }
    Ok(found)
}

/// The part of `changes.toml` a folder build reads; the Mac-only sections are left to the Mac.
#[derive(Deserialize)]
struct Names {
    from: Name,
    to: Name,
    strings: Keep,
}

#[derive(Deserialize)]
struct Name {
    name: String,
}

#[derive(Deserialize)]
struct Keep {
    keep: Vec<String>,
}

/// Makes Polycarp Browser in `build` from Helium's checked folder, which is moved there. Its signatures were checked
/// first; only the updater goes and only the text packs change. The launcher's path.
pub fn build(helium: &Path, build: &Path, parts: &Parts) -> Result<PathBuf, Refused> {
    let text =
        fs::read_to_string(&parts.changes).map_err(refuse("parts", "reading changes.toml"))?;
    let names: Names =
        toml::from_str(&text).map_err(|e| Refused::new("parts", format!("changes.toml: {e}")))?;
    fs::rename(helium, build).map_err(refuse("change", "moving the release"))?;
    let updater = build.join(UPDATER);
    if !fs::symlink_metadata(&updater).is_ok_and(|m| m.is_file()) {
        return Err(Refused::new(
            "updater",
            "Helium's updater was not where expected",
        ));
    }
    fs::remove_file(&updater).map_err(refuse("updater", "removing it"))?;
    fs::write(build.join("initial_preferences"), PREFS)
        .map_err(refuse("updater", "turning it off"))?;
    let locales = fs::read_dir(build.join("locales")).into_iter().flatten();
    let paks: Vec<PathBuf> = locales.flatten().map(|e| e.path()).collect();
    let paks: Vec<&PathBuf> = paks
        .iter()
        .filter(|p| p.extension().is_some_and(|e| e == "pak"))
        .collect();
    let rename = Rename {
        from: &names.from.name,
        to: &names.to.name,
        keep: &names.strings.keep,
    };
    let english = |f: &Path| f.file_name().is_some_and(|n| n == "en-US.pak");
    rename_paks(&paks, &english, &rename)?;
    let launcher = build.join(format!("{}.exe", names.to.name));
    fs::copy(&parts.launcher, &launcher)
        .map_err(refuse("built-in pages", "putting the launcher in"))?;
    let ours = build.join("polycarp");
    let extension = ours.join("extension");
    copy(&parts.extension, &extension)?;
    if !extension.join("manifest.json").is_file() {
        return Err(Refused::new(
            "built-in pages",
            "the extension has no manifest",
        ));
    }
    fs::write(extension.join("builtin.txt"), "Polycarp Browser\n")
        .map_err(refuse("built-in pages", "marking it"))?;
    // The launcher and the extension are GPL: their license goes with them, as in the Mac app.
    fs::copy(&parts.license, ours.join("LICENSE"))
        .map_err(refuse("built-in pages", "putting the license in"))?;
    if parts.local_studio.join("manifest.json").is_file() {
        copy(&parts.local_studio, &ours.join("local-studio"))?;
    }
    Ok(launcher)
}

/// Plain files and folders only: a link would lead out of the build.
fn copy(from: &Path, to: &Path) -> Result<(), Refused> {
    let fail = || refuse("built-in pages", "copying the extension");
    fs::create_dir_all(to).map_err(fail())?;
    for entry in fs::read_dir(from).map_err(fail())? {
        let path = entry.map_err(fail())?.path();
        let meta = fs::symlink_metadata(&path).map_err(fail())?;
        let into = to.join(path.file_name().unwrap_or_default());
        if is_link(&meta) {
            let why = format!("{} is a link", path.display());
            return Err(Refused::new("built-in pages", why));
        } else if meta.is_dir() {
            copy(&path, &into)?;
        } else {
            fs::copy(&path, &into).map_err(fail())?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::super::download::digest;
    use super::*;

    pub fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("polycarp-pt-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Made-up parts: the real `changes.toml`, a launcher and an extension.
    fn made_parts(root: &Path) -> Parts {
        fs::create_dir_all(root.join("make-browser")).unwrap();
        fs::create_dir_all(root.join("extension/newtab")).unwrap();
        let changes = include_str!("../../../browser/changes.toml");
        fs::write(root.join("make-browser/changes.toml"), changes).unwrap();
        fs::write(root.join("make-browser/launcher.exe"), "a launcher").unwrap();
        fs::write(root.join("make-browser/LICENSE"), "GPL").unwrap();
        fs::write(root.join("extension/manifest.json"), "{}").unwrap();
        fs::write(root.join("extension/newtab/newtab.html"), "page").unwrap();
        parts(Some(root.into())).unwrap()
    }

    /// Helium's Windows folder in small, laid out as the 0.22.5.1 zip is.
    fn made_helium(dir: &Path) -> PathBuf {
        let top = dir.join("helium_0.22.5.1_x64-windows");
        fs::create_dir_all(top.join("locales")).unwrap();
        for f in [
            "chrome.exe",
            UPDATER,
            "0.22.5.1.manifest",
            "chrome.dll",
            "resources.pak",
        ] {
            fs::write(top.join(f), format!("bytes of {f}")).unwrap();
        }
        let texts = [(1, "About Helium"), (2, "The Helium Authors")];
        fs::write(top.join("locales/en-US.pak"), pak::made_up(&texts)).unwrap();
        let de = [(1, "Info zu Helium"), (2, "Die Helium-Autoren")];
        fs::write(top.join("locales/de.pak"), pak::made_up(&de)).unwrap();
        top
    }

    fn texts(file: &Path) -> Vec<String> {
        let pak = pak::Pak::parse(&fs::read(file).unwrap()).unwrap();
        pak.entries
            .into_iter()
            .map(|(_, t)| String::from_utf8(t).unwrap())
            .collect()
    }

    #[test]
    fn parts_that_are_not_there_are_refused() {
        let root = temp("parts");
        let good = made_parts(&root);
        let why = |r: Option<OsString>| parts(r).unwrap_err();
        for r in [None, Some("".into()), Some("relative/parts".into())] {
            let e = why(r);
            assert_eq!(e.check, "parts");
            assert!(e.why.contains("build-parts-windows.sh"), "{}", e.why);
        }
        for gone in [
            &good.launcher,
            &good.license,
            &good.changes,
            &good.extension.join("manifest.json"),
        ] {
            let kept = fs::read(gone).unwrap();
            fs::remove_file(gone).unwrap();
            let e = why(Some(root.clone().into()));
            fs::write(gone, kept).unwrap();
            assert_eq!(e.check, "parts");
            assert!(e.why.starts_with(&gone.display().to_string()), "{}", e.why);
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_build_changes_only_the_updater_the_text_and_what_polycarp_adds() {
        let dir = temp("build");
        let parts = made_parts(&dir.join("parts"));
        let helium = made_helium(&dir);
        let untouched = [
            "chrome.exe",
            "0.22.5.1.manifest",
            "chrome.dll",
            "resources.pak",
        ];
        let before: Vec<_> = untouched
            .iter()
            .map(|f| digest(&helium.join(f)).unwrap())
            .collect();
        let out = dir.join("build");
        let launcher = build(&helium, &out, &parts).unwrap();
        let after: Vec<_> = untouched
            .iter()
            .map(|f| digest(&out.join(f)).unwrap())
            .collect();
        assert_eq!(before, after);
        assert!(fs::symlink_metadata(out.join(UPDATER)).is_err());
        assert_eq!(
            fs::read_to_string(out.join("initial_preferences")).unwrap(),
            PREFS
        );
        assert_eq!(
            texts(&out.join("locales/en-US.pak")),
            ["About Polycarp Browser", "The Helium Authors"]
        );
        // Kept by its id: this language's text does not hold the English phrase.
        assert_eq!(
            texts(&out.join("locales/de.pak")),
            ["Info zu Polycarp Browser", "Die Helium-Autoren"]
        );
        assert_eq!(launcher, out.join("Polycarp Browser.exe"));
        assert_eq!(fs::read(&launcher).unwrap(), b"a launcher");
        let ext = out.join("polycarp/extension");
        assert_eq!(
            fs::read_to_string(ext.join("builtin.txt")).unwrap(),
            "Polycarp Browser\n"
        );
        assert!(ext.join("newtab/newtab.html").is_file());
        assert_eq!(fs::read(out.join("polycarp/LICENSE")).unwrap(), b"GPL");
        assert!(
            !out.join("polycarp/local-studio").exists(),
            "no Local Studio part"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_release_or_extension_that_is_off_is_refused() {
        type Spoil = fn(&Path, &Parts);
        let cases: [(Spoil, &str); 3] = [
            (|h, _| fs::remove_file(h.join(UPDATER)).unwrap(), "updater"),
            (
                |h, _| fs::remove_file(h.join("locales/en-US.pak")).unwrap(),
                "change",
            ),
            (
                |h, _| fs::write(h.join("locales/de.pak"), "x").unwrap(),
                "change",
            ),
        ];
        #[cfg(unix)]
        let cases = [
            &cases[..],
            &[(
                (|_, p| std::os::unix::fs::symlink("/etc/hosts", p.extension.join("out")).unwrap())
                    as Spoil,
                "built-in pages",
            )],
        ]
        .concat();
        for (i, (spoil, check)) in cases.iter().enumerate() {
            let dir = temp(&format!("spoil{i}"));
            let parts = made_parts(&dir.join("parts"));
            let helium = made_helium(&dir);
            spoil(&helium, &parts);
            let e = build(&helium, &dir.join("build"), &parts).unwrap_err();
            assert_eq!(e.check, *check, "case {i}: {}", e.why);
            fs::remove_dir_all(&dir).unwrap();
        }
    }
}
