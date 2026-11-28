//! Polycarp Browser installed on Windows and Linux: where it goes, the swap that puts a new build in place, the record
//! of what is installed, `status` and the file work of `uninstall`. Pure file work over the folders it is given; the
//! caller checks what runs and makes the menu item.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::download::{refuse, Refused};

/// How a build is made; a change to that changes this.
pub const RECIPE: &str = "1";
pub const NAME: &str = "Polycarp Browser";

/// The system whose rule says where things go. Each system's build names only its own.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug)]
pub enum System {
    Windows,
    Linux,
}

/// Where the browser, its profile and its menu item (a Start Menu `.lnk` or a `.desktop` entry) go.
#[derive(Debug, PartialEq)]
pub struct Places {
    pub program: PathBuf,
    pub profile: PathBuf,
    pub shortcut: PathBuf,
    /// The launcher's name inside `program`.
    pub launcher: &'static str,
}

/// The places by `system`'s rule.
pub fn places(system: System, env: &dyn Fn(&str) -> Option<OsString>) -> Result<Places, Refused> {
    match system {
        System::Windows => windows(env),
        System::Linux => linux(env),
    }
}

/// An environment variable that holds an absolute folder.
fn absolute(env: &dyn Fn(&str) -> Option<OsString>, name: &str) -> Option<PathBuf> {
    let path = env(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    path.filter(|p| p.is_absolute())
}

/// Out of `XDG_DATA_HOME` and `XDG_CONFIG_HOME`, else `HOME`, as the launcher finds the profile.
fn linux(env: &dyn Fn(&str) -> Option<OsString>) -> Result<Places, Refused> {
    let under = |xdg: &str, rest: &str| {
        let home = absolute(env, "HOME").map(|h| rest.split('/').fold(h, |p, f| p.join(f)));
        let why = format!("neither {xdg} nor HOME is set to an absolute folder");
        absolute(env, xdg)
            .or(home)
            .ok_or_else(|| Refused::new("place", why))
    };
    let (data, config) = (
        under("XDG_DATA_HOME", ".local/share")?,
        under("XDG_CONFIG_HOME", ".config")?,
    );
    let program = data.join("polycarp-browser");
    entry(&program)?;
    Ok(Places {
        program,
        profile: config.join("Polycarp").join("Browser"),
        shortcut: data.join("applications").join("polycarp-browser.desktop"),
        launcher: "polycarp-browser",
    })
}

/// The desktop entry for the browser in `program`, its path quoted for `Exec` by the Desktop Entry spec: `"`, `` ` ``,
/// `$` and `\` take a backslash inside the quotes, then every backslash is doubled for the string itself. A path a
/// desktop entry can't hold (not UTF-8, a line break or a `%`) is refused. No icon yet: Helium's logo is not Polycarp's.
pub fn entry(program: &Path) -> Result<String, Refused> {
    let refused = || {
        let why = format!("{} can't be named in a menu entry", program.display());
        Refused::new("place", why)
    };
    let text = program.to_str().ok_or_else(refused)?;
    if text.contains(['\n', '\r', '%']) {
        return Err(refused());
    }
    let mut quoted = String::new();
    for c in text.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    let exec = quoted.replace('\\', "\\\\");
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName={NAME}\nExec=\"{exec}/polycarp-browser\" %U\nTerminal=false\n\
         Categories=Network;WebBrowser;\nStartupWMClass=polycarp-browser\n"
    ))
}

/// Out of `LOCALAPPDATA` and `APPDATA`, each of which must be an absolute folder.
fn windows(env: &dyn Fn(&str) -> Option<OsString>) -> Result<Places, Refused> {
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
        launcher: "Polycarp Browser.exe",
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

/// The Helium version installed, when its record and its launcher are both there.
pub fn installed(places: &Places) -> Option<String> {
    if !places.program.join(places.launcher).is_file() {
        return None;
    }
    let text = fs::read(record(&places.program)).ok()?;
    serde_json::from_slice::<Record>(&text)
        .ok()
        .map(|r| r.version)
}

pub type Move<'a> = &'a dyn Fn(&Path, &Path) -> io::Result<()>;

/// A rename, tried again for a while: a browser that just quit can hold its files a moment longer.
pub fn moved(from: &Path, to: &Path) -> io::Result<()> {
    for _ in 0..10 {
        if fs::rename(from, to).is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    fs::rename(from, to)
}

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
        installed: installed(places),
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
    // A browser that just quit can hold its files a moment longer.
    let mut deleted = gone(&old);
    for _ in 0..10 {
        if deleted.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
        deleted = gone(&old);
    }
    deleted.map_err(refuse(check, "removing the program folder"))?;
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

    const BOTH: [System; 2] = [System::Windows, System::Linux];

    fn at(system: System, dir: &Path) -> Places {
        let env = |k: &str| Some(dir.join(k).into_os_string());
        places(system, &env).unwrap()
    }

    /// A build of `version` holding `file`, laid out for `p`.
    fn built(dir: &Path, p: &Places, version: &str, file: &str) -> PathBuf {
        let build = dir.join(format!("build-{version}"));
        fs::create_dir_all(build.join("polycarp")).unwrap();
        fs::write(build.join(p.launcher), "launcher").unwrap();
        fs::write(build.join(file), version).unwrap();
        write_record(&build, version).unwrap();
        build
    }

    #[test]
    fn places_come_from_absolute_folders_only() {
        let dir = temp("places");
        let p = at(System::Windows, &dir);
        assert_eq!(
            p.program,
            dir.join("LOCALAPPDATA/Programs/Polycarp Browser")
        );
        assert_eq!(p.profile, dir.join("LOCALAPPDATA/Polycarp/Browser"));
        let menu = "APPDATA/Microsoft/Windows/Start Menu/Programs/Polycarp Browser.lnk";
        assert_eq!(p.shortcut, dir.join(menu));
        assert_eq!(p.launcher, "Polycarp Browser.exe");
        for (name, value) in [
            ("LOCALAPPDATA", None),
            ("APPDATA", Some("relative")),
            ("APPDATA", Some("")),
        ] {
            let env = |k: &str| match k == name {
                true => value.map(OsString::from),
                false => Some(dir.clone().into_os_string()),
            };
            let e = places(System::Windows, &env).unwrap_err();
            assert_eq!(
                (e.check, e.why),
                ("place", format!("{name} is not set to an absolute folder"))
            );
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn linux_places_come_from_xdg_or_home() {
        let dir = temp("linux-places");
        let p = at(System::Linux, &dir);
        assert_eq!(p.program, dir.join("XDG_DATA_HOME/polycarp-browser"));
        assert_eq!(p.profile, dir.join("XDG_CONFIG_HOME/Polycarp/Browser"));
        let menu = "XDG_DATA_HOME/applications/polycarp-browser.desktop";
        assert_eq!(p.shortcut, dir.join(menu));
        assert_eq!(p.launcher, "polycarp-browser");
        // Unset, empty or relative XDG folders fall back to HOME, as the launcher's profile does.
        for xdg in [None, Some(""), Some("relative")] {
            let env = |k: &str| match k {
                "HOME" => Some(dir.clone().into_os_string()),
                _ => xdg.map(OsString::from),
            };
            let p = places(System::Linux, &env).unwrap();
            assert_eq!(p.program, dir.join(".local/share/polycarp-browser"));
            assert_eq!(p.profile, dir.join(".config/Polycarp/Browser"));
            let menu = ".local/share/applications/polycarp-browser.desktop";
            assert_eq!(p.shortcut, dir.join(menu));
        }
        for (name, home) in [("XDG_DATA_HOME", None), ("XDG_DATA_HOME", Some("rel"))] {
            let env = |k: &str| (k == "HOME").then(|| home.map(OsString::from)).flatten();
            let e = places(System::Linux, &env).unwrap_err();
            let why = format!("neither {name} nor HOME is set to an absolute folder");
            assert_eq!((e.check, e.why), ("place", why));
        }
        // Only the data folder set: the profile has no folder to go in.
        let env = |k: &str| (k == "XDG_DATA_HOME").then(|| dir.clone().into_os_string());
        let e = places(System::Linux, &env).unwrap_err();
        let why = "neither XDG_CONFIG_HOME nor HOME is set to an absolute folder";
        assert_eq!((e.check, e.why.as_str()), ("place", why));
        for bad in ["a\nb", "a%b", "a\rb"] {
            let env = |k: &str| Some(dir.join(bad).join(k).into_os_string());
            assert_eq!(
                places(System::Linux, &env).unwrap_err().check,
                "place",
                "{bad:?}"
            );
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_desktop_entry_quotes_its_path() {
        let text = |p: &str| entry(Path::new(p));
        let want = "[Desktop Entry]\nType=Application\nName=Polycarp Browser\n\
                    Exec=\"/home/a/.local/share/polycarp-browser/polycarp-browser\" %U\nTerminal=false\n\
                    Categories=Network;WebBrowser;\nStartupWMClass=polycarp-browser\n";
        assert_eq!(text("/home/a/.local/share/polycarp-browser").unwrap(), want);
        let exec = |p: &str| {
            let t = text(p).unwrap();
            let line = t.lines().find(|l| l.starts_with("Exec=")).unwrap();
            line.to_string()
        };
        assert_eq!(exec("/a b"), "Exec=\"/a b/polycarp-browser\" %U");
        // Inside the quotes each takes a backslash; then the string doubles every backslash.
        assert_eq!(exec("/a\"b"), r#"Exec="/a\\"b/polycarp-browser" %U"#);
        assert_eq!(exec("/a`b"), r#"Exec="/a\\`b/polycarp-browser" %U"#);
        assert_eq!(exec("/a$b"), r#"Exec="/a\\$b/polycarp-browser" %U"#);
        assert_eq!(exec("/a\\b"), r#"Exec="/a\\\\b/polycarp-browser" %U"#);
        for bad in ["/a\nb", "/a\rb", "/a%b", "/a%%U"] {
            let e = text(bad).unwrap_err();
            assert_eq!(e.check, "place", "{bad:?}");
            assert!(
                e.why.ends_with("can't be named in a menu entry"),
                "{}",
                e.why
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let odd = Path::new(std::ffi::OsStr::from_bytes(b"/a\xffb"));
            assert_eq!(entry(odd).unwrap_err().check, "place");
        }
    }

    #[test]
    fn a_swap_replaces_the_old_build_and_nothing_beside_it() {
        for system in BOTH {
            swaps(system);
        }
    }

    fn swaps(system: System) {
        let dir = temp(&format!("swap-{system:?}"));
        let p = at(system, &dir);
        fs::create_dir_all(&p.profile).unwrap();
        fs::write(p.profile.join("mine"), "x").unwrap();
        let mv = |a: &Path, b: &Path| fs::rename(a, b);
        fs::create_dir_all(p.program.parent().unwrap()).unwrap();
        swap(&built(&dir, &p, "1.0", "one"), &p.program, &mv).unwrap();
        assert_eq!(installed(&p).as_deref(), Some("1.0"));
        for stale in [".new", ".old"] {
            fs::create_dir_all(beside(&p.program, stale).join("left")).unwrap();
        }
        swap(&built(&dir, &p, "2.0", "two"), &p.program, &mv).unwrap();
        assert_eq!(installed(&p).as_deref(), Some("2.0"));
        assert!(p.program.join("two").is_file() && !p.program.join("one").exists());
        assert!(!beside(&p.program, ".new").exists() && !beside(&p.program, ".old").exists());
        assert!(p.profile.join("mine").is_file(), "the profile was touched");
        let new = beside(&p.program, ".new");
        let last = |a: &Path, b: &Path| match a == new {
            true => Err(io::Error::other("held")),
            false => fs::rename(a, b),
        };
        let e = swap(&built(&dir, &p, "3.0", "three"), &p.program, &last).unwrap_err();
        assert_eq!(e.check, "swap");
        assert_eq!(
            installed(&p).as_deref(),
            Some("2.0"),
            "the old build was not put back"
        );
        assert!(p.program.join("two").is_file());
        // Nothing can be moved to the program folder: the old build is left aside and the refusal says where.
        let held = |a: &Path, b: &Path| match b == p.program {
            true => Err(io::Error::other("held")),
            false => fs::rename(a, b),
        };
        let e = swap(&built(&dir, &p, "3.0", "three"), &p.program, &held).unwrap_err();
        assert_eq!(e.check, "stranded");
        let old = beside(&p.program, ".old").display().to_string();
        assert!(e.why.contains(&old), "{}", e.why);
        assert!(!p.program.exists() && beside(&p.program, ".old").join("two").is_file());
        // The next install puts that old build back before it clears anything, even when it then fails.
        let no_new = |a: &Path, b: &Path| match b == new {
            true => Err(io::Error::other("held")),
            false => fs::rename(a, b),
        };
        let e = swap(&built(&dir, &p, "4.0", "four"), &p.program, &no_new).unwrap_err();
        assert_eq!(e.check, "swap");
        assert_eq!(installed(&p).as_deref(), Some("2.0"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn status_says_what_is_installed() {
        for system in BOTH {
            states(system);
        }
    }

    fn states(system: System) {
        let dir = temp(&format!("status-{system:?}"));
        let p = at(system, &dir);
        let s = status(&p);
        assert_eq!(s.text(), "Polycarp Browser is not installed.");
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"installed": null, "app": p.program})
        );
        fs::create_dir_all(p.program.parent().unwrap()).unwrap();
        fs::rename(built(&dir, &p, "0.22.5.1", "x"), &p.program).unwrap();
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
        fs::remove_file(p.program.join(p.launcher)).unwrap();
        assert_eq!(status(&p).installed, None, "no launcher");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn uninstall_takes_the_browser_and_its_shortcut_and_leaves_the_profile() {
        for system in BOTH {
            uninstalls(system);
        }
    }

    fn uninstalls(system: System) {
        let dir = temp(&format!("uninstall-{system:?}"));
        let p = at(system, &dir);
        let put = |p: &Places| {
            fs::create_dir_all(p.program.parent().unwrap()).unwrap();
            fs::rename(built(&dir, p, "1.0", "x"), &p.program).unwrap();
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
        // A profile that is a link is refused before anything is removed, and what it leads to stays.
        #[cfg(unix)]
        {
            let real = dir.join("elsewhere");
            fs::create_dir_all(&real).unwrap();
            fs::write(real.join("keep"), "x").unwrap();
            fs::create_dir_all(p.profile.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&real, &p.profile).unwrap();
            fs::create_dir_all(&p.program).unwrap();
            assert_eq!(remove(&p, true).unwrap_err().check, "uninstall");
            assert!(p.program.is_dir() && real.join("keep").is_file());
            fs::remove_file(&p.profile).unwrap();
            fs::remove_dir_all(&p.program).unwrap();
        }
        // Only an old build a failed install left aside: it is removed and said to be.
        fs::create_dir_all(beside(&p.program, ".old").join("two")).unwrap();
        assert!(remove(&p, false)
            .unwrap()
            .starts_with("Polycarp Browser was removed."));
        assert!(!beside(&p.program, ".old").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
