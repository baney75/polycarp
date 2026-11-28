//! Polycarp Browser installed on Windows: where it goes, the swap that puts a new build in place, the record of what
//! is installed, `status` and the file work of `uninstall`. Pure file work over the folders it is given; the caller
//! checks what runs and makes the shortcut.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::download::{refuse, Refused};

/// How a build is made; a change to that changes this.
pub const RECIPE: &str = "1";
pub const NAME: &str = "Polycarp Browser";

/// Where the browser, its profile and its shortcut go.
#[derive(Debug, PartialEq)]
pub struct Places {
    pub program: PathBuf,
    pub profile: PathBuf,
    pub shortcut: PathBuf,
}

/// The places, out of `LOCALAPPDATA` and `APPDATA`, each of which must be an absolute folder.
pub fn places(env: &dyn Fn(&str) -> Option<OsString>) -> Result<Places, Refused> {
    let folder = |name: &str| {
        let path = env(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        let why = format!("{name} is not set to an absolute folder");
        path.filter(|p| p.is_absolute())
            .ok_or_else(|| Refused::new("place", why))
    };
    let (local, roaming) = (folder("LOCALAPPDATA")?, folder("APPDATA")?);
    let menu = ["Microsoft", "Windows", "Start Menu", "Programs"];
    let menu = menu.iter().fold(roaming, |p, f| p.join(f));
    Ok(Places {
        program: local.join("Programs").join(NAME),
        profile: local.join("Polycarp").join("Browser"),
        shortcut: menu.join(format!("{NAME}.lnk")),
    })
}

/// `program` with `end` added to its name, beside it.
pub fn beside(program: &Path, end: &str) -> PathBuf {
    let mut name = program.file_name().unwrap_or_default().to_os_string();
    name.push(end);
    program.with_file_name(name)
}

/// Removes whatever is at `path`, if anything is.
fn gone(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(_) => Ok(()),
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
    }
}

#[derive(Serialize, Deserialize)]
struct Record {
    version: String,
    recipe: String,
}

fn record(program: &Path) -> PathBuf {
    program.join("polycarp").join("installed.json")
}

/// Written last inside a new build, before it is swapped in.
pub fn write_record(build: &Path, version: &str) -> Result<(), Refused> {
    let text = serde_json::json!({ "version": version, "recipe": RECIPE }).to_string();
    fs::write(record(build), text).map_err(refuse("record", "writing installed.json"))
}

/// The Helium version installed in `program`, when its record and its launcher are both there.
pub fn installed(program: &Path) -> Option<String> {
    if !program.join(format!("{NAME}.exe")).is_file() {
        return None;
    }
    let text = fs::read(record(program)).ok()?;
    serde_json::from_slice::<Record>(&text)
        .ok()
        .map(|r| r.version)
}

pub type Move<'a> = &'a dyn Fn(&Path, &Path) -> io::Result<()>;

/// Puts `build` in place as `program`: it goes to `program.new` first, an old `program` to `program.old`, then
/// `program.new` to `program`, and `program.old` is deleted. A failed move puts the old one back.
pub fn swap(build: &Path, program: &Path, mv: Move) -> Result<(), Refused> {
    let (new, old) = (beside(program, ".new"), beside(program, ".old"));
    // An old build an earlier run could not put back is the person's browser, not a leftover.
    if fs::symlink_metadata(program).is_err() && fs::symlink_metadata(&old).is_ok() {
        mv(&old, program).map_err(refuse(
            "swap",
            "putting back the old build an earlier run left",
        ))?;
    }
    for stale in [&new, &old] {
        gone(stale).map_err(refuse("swap", "clearing an earlier run's folder"))?;
    }
    mv(build, &new).map_err(refuse("swap", "moving the build beside the program folder"))?;
    let had = fs::symlink_metadata(program).is_ok();
    if had {
        if let Err(e) = mv(program, &old) {
            let _ = gone(&new);
            return Err(refuse("swap", "moving the old build aside")(e));
        }
    }
    if let Err(e) = mv(&new, program) {
        let _ = gone(&new);
        if had && mv(&old, program).is_err() {
            let why = format!(
                "moving the build in place: {e}, and the old build could not be put back; it is in {}, and the \
                 next install puts it back first",
                old.display()
            );
            return Err(Refused::new("stranded", why));
        }
        return Err(refuse("swap", "moving the build in place")(e));
    }
    let _ = gone(&old);
    Ok(())
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Status {
    pub installed: Option<String>,
    pub app: PathBuf,
}

pub fn status(places: &Places) -> Status {
    Status {
        installed: installed(&places.program),
        app: places.program.clone(),
    }
}

impl Status {
    pub fn text(&self) -> String {
        match &self.installed {
            Some(v) => format!(
                "{NAME} (Helium {v}) is installed in {}.",
                self.app.display()
            ),
            None => format!("{NAME} is not installed."),
        }
    }
}

/// Said before anything is removed: what `--profile` without `--yes` would take.
pub fn would_remove(places: &Places) -> String {
    format!(
        "This removes the browser, and the profile with every bookmark, password and tab in it:\n  {}\nIt can't \
         be undone. Add --yes to do it.",
        places.profile.display()
    )
}

/// Removes the browser and its shortcut, and its profile when asked. The program folder moves aside before it is
/// deleted, so a half-deleted one never sits in its place.
pub fn remove(places: &Places, with_profile: bool) -> Result<String, Refused> {
    let check = "uninstall";
    let profile = &places.profile;
    // A link would lead the removal somewhere else.
    if with_profile && fs::symlink_metadata(profile).is_ok_and(|m| !m.is_dir()) {
        return Err(Refused::new(
            check,
            format!("{} is not a folder", profile.display()),
        ));
    }
    let old = beside(&places.program, ".old");
    // An old build a failed install left aside is the browser too.
    let stranded = fs::symlink_metadata(&old).is_ok();
    gone(&old).map_err(refuse(check, "clearing an earlier run's folder"))?;
    let had = fs::symlink_metadata(&places.program).is_ok() || stranded;
    if fs::symlink_metadata(&places.program).is_ok() {
        fs::rename(&places.program, &old)
            .map_err(refuse(check, "moving the program folder aside"))?;
    }
    let link = fs::symlink_metadata(&places.shortcut).is_ok();
    if link {
        fs::remove_file(&places.shortcut).map_err(refuse(check, "removing the shortcut"))?;
    }
    gone(&old).map_err(refuse(check, "removing the program folder"))?;
    let mine = with_profile && profile.exists();
    if mine {
        fs::remove_dir_all(profile).map_err(refuse(check, "removing the profile"))?;
    }
    Ok(match (had || link, mine) {
        (false, false) => format!("{NAME} is not installed."),
        (false, true) => format!("{NAME} is not installed. Its profile was removed."),
        (true, false) => format!(
            "{NAME} was removed. Your profile stays in {}.",
            profile.display()
        ),
        (true, true) => format!("{NAME} and its profile were removed."),
    })
}

/// Prints the line or the refusal, with `after` added to a refusal; the exit code.
pub fn say(done: Result<String, Refused>, after: &str) -> i32 {
    match done {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(r) => {
            eprintln!(
                "polycarp browser: the {} check failed: {}.{after}",
                r.check, r.why
            );
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("polycarp-wi-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn at(dir: &Path) -> Places {
        let env = |k: &str| Some(dir.join(k).into_os_string());
        places(&env).unwrap()
    }

    /// A build of `version` holding `file`.
    fn built(dir: &Path, version: &str, file: &str) -> PathBuf {
        let build = dir.join(format!("build-{version}"));
        fs::create_dir_all(build.join("polycarp")).unwrap();
        fs::write(build.join(format!("{NAME}.exe")), "launcher").unwrap();
        fs::write(build.join(file), version).unwrap();
        write_record(&build, version).unwrap();
        build
    }

    #[test]
    fn places_come_from_absolute_folders_only() {
        let dir = temp("places");
        let p = at(&dir);
        assert_eq!(
            p.program,
            dir.join("LOCALAPPDATA/Programs/Polycarp Browser")
        );
        assert_eq!(p.profile, dir.join("LOCALAPPDATA/Polycarp/Browser"));
        let menu = "APPDATA/Microsoft/Windows/Start Menu/Programs/Polycarp Browser.lnk";
        assert_eq!(p.shortcut, dir.join(menu));
        for (name, value) in [
            ("LOCALAPPDATA", None),
            ("APPDATA", Some("relative")),
            ("APPDATA", Some("")),
        ] {
            let env = |k: &str| match k == name {
                true => value.map(OsString::from),
                false => Some(dir.clone().into_os_string()),
            };
            let e = places(&env).unwrap_err();
            assert_eq!(
                (e.check, e.why),
                ("place", format!("{name} is not set to an absolute folder"))
            );
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_swap_replaces_the_old_build_and_nothing_beside_it() {
        let dir = temp("swap");
        let p = at(&dir);
        fs::create_dir_all(&p.profile).unwrap();
        fs::write(p.profile.join("mine"), "x").unwrap();
        let mv = |a: &Path, b: &Path| fs::rename(a, b);
        fs::create_dir_all(p.program.parent().unwrap()).unwrap();
        swap(&built(&dir, "1.0", "one"), &p.program, &mv).unwrap();
        assert_eq!(installed(&p.program).as_deref(), Some("1.0"));
        for stale in [".new", ".old"] {
            fs::create_dir_all(beside(&p.program, stale).join("left")).unwrap();
        }
        swap(&built(&dir, "2.0", "two"), &p.program, &mv).unwrap();
        assert_eq!(installed(&p.program).as_deref(), Some("2.0"));
        assert!(p.program.join("two").is_file() && !p.program.join("one").exists());
        assert!(!beside(&p.program, ".new").exists() && !beside(&p.program, ".old").exists());
        assert!(p.profile.join("mine").is_file(), "the profile was touched");
        let last = |a: &Path, b: &Path| match a.ends_with("Polycarp Browser.new") {
            true => Err(io::Error::other("held")),
            false => fs::rename(a, b),
        };
        let e = swap(&built(&dir, "3.0", "three"), &p.program, &last).unwrap_err();
        assert_eq!(e.check, "swap");
        assert_eq!(
            installed(&p.program).as_deref(),
            Some("2.0"),
            "the old build was not put back"
        );
        assert!(p.program.join("two").is_file());
        // Nothing can be moved to the program folder: the old build is left aside and the refusal says where.
        let held = |a: &Path, b: &Path| match b == p.program {
            true => Err(io::Error::other("held")),
            false => fs::rename(a, b),
        };
        let e = swap(&built(&dir, "3.0", "three"), &p.program, &held).unwrap_err();
        assert_eq!(e.check, "stranded");
        assert!(e.why.contains("Polycarp Browser.old"), "{}", e.why);
        assert!(!p.program.exists() && beside(&p.program, ".old").join("two").is_file());
        // The next install puts that old build back before it clears anything, even when it then fails.
        let no_new = |a: &Path, b: &Path| match b.ends_with("Polycarp Browser.new") {
            true => Err(io::Error::other("held")),
            false => fs::rename(a, b),
        };
        let e = swap(&built(&dir, "4.0", "four"), &p.program, &no_new).unwrap_err();
        assert_eq!(e.check, "swap");
        assert_eq!(installed(&p.program).as_deref(), Some("2.0"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn status_says_what_is_installed() {
        let dir = temp("status");
        let p = at(&dir);
        let s = status(&p);
        assert_eq!(s.text(), "Polycarp Browser is not installed.");
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"installed": null, "app": p.program})
        );
        fs::create_dir_all(p.program.parent().unwrap()).unwrap();
        fs::rename(built(&dir, "0.22.5.1", "x"), &p.program).unwrap();
        let s = status(&p);
        let want = format!(
            "Polycarp Browser (Helium 0.22.5.1) is installed in {}.",
            p.program.display()
        );
        assert_eq!(s.text(), want);
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"installed": "0.22.5.1", "app": p.program})
        );
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(record(&p.program)).unwrap()).unwrap();
        assert_eq!(
            record,
            serde_json::json!({"version": "0.22.5.1", "recipe": RECIPE})
        );
        fs::remove_file(p.program.join("Polycarp Browser.exe")).unwrap();
        assert_eq!(status(&p).installed, None, "no launcher");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn uninstall_takes_the_browser_and_its_shortcut_and_leaves_the_profile() {
        let dir = temp("uninstall");
        let p = at(&dir);
        let put = |p: &Places| {
            fs::create_dir_all(p.program.parent().unwrap()).unwrap();
            fs::rename(built(&dir, "1.0", "x"), &p.program).unwrap();
            fs::create_dir_all(p.shortcut.parent().unwrap()).unwrap();
            fs::write(&p.shortcut, "lnk").unwrap();
            fs::create_dir_all(&p.profile).unwrap();
            fs::write(p.profile.join("mine"), "x").unwrap();
        };
        put(&p);
        let stays = format!(
            "Polycarp Browser was removed. Your profile stays in {}.",
            p.profile.display()
        );
        assert_eq!(remove(&p, false).unwrap(), stays);
        assert!(
            !p.program.exists() && !p.shortcut.exists() && !beside(&p.program, ".old").exists()
        );
        assert!(p.profile.join("mine").is_file());
        assert_eq!(
            remove(&p, false).unwrap(),
            "Polycarp Browser is not installed."
        );
        put(&p);
        assert_eq!(
            remove(&p, true).unwrap(),
            "Polycarp Browser and its profile were removed."
        );
        assert!(!p.program.exists() && !p.shortcut.exists() && !p.profile.exists());
        assert!(would_remove(&p).contains(&p.profile.display().to_string()));
        // Only an old build a failed install left aside: it is removed and said to be.
        fs::create_dir_all(beside(&p.program, ".old").join("two")).unwrap();
        assert!(remove(&p, false)
            .unwrap()
            .starts_with("Polycarp Browser was removed."));
        assert!(!beside(&p.program, ".old").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
