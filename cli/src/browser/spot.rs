//! Where the browser is installed, the one build kept behind it, and the one waiting for it to quit.
//!
//! A build is put in by exchanging two folders in one step, so at every moment the app is whole: the old one or the new
//! one. The kept and waiting builds have no `.app` ending, so macOS never offers them as apps.

use std::ffi::CString;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::tools::{must, Call, Tools};
use super::{clear, refuse, running, Refused};

pub const APP: &str = "Polycarp Browser.app";
const CHECK: &str = "swap";

/// What a build was made from, kept inside it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Built {
    pub helium: String,
    /// The day Helium published it, counted from 1970.
    pub published: Option<i64>,
    /// Milliseconds since 1970: which of two builds is newer.
    pub built: u64,
    /// A digest of Polycarp's own parts in it.
    pub parts: String,
    /// It carries Polycarp's certificate, so macOS knows it across updates.
    pub certificate: bool,
}

impl Built {
    const FILE: &str = "Contents/Resources/polycarp/built.json";

    /// None when there is no app, or it is not one this command built.
    pub fn read(app: &Path) -> Option<Built> {
        serde_json::from_slice(&fs::read(app.join(Built::FILE)).ok()?).ok()
    }

    pub fn write(&self, app: &Path) -> io::Result<()> {
        fs::write(app.join(Built::FILE), serde_json::to_vec(self)?)
    }
}

#[derive(Clone)]
pub struct Spot {
    /// The folder the app is in.
    pub folder: PathBuf,
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn rename(from: &Path, to: &Path, flags: libc::c_uint) -> io::Result<()> {
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // SAFETY: both are C strings that outlive the call.
    match unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), flags) } {
        0 => Ok(()),
        _ => Err(io::Error::last_os_error()),
    }
}

impl Spot {
    pub fn app(&self) -> PathBuf {
        self.folder.join(APP)
    }

    pub fn previous(&self) -> PathBuf {
        self.folder.join(".Polycarp Browser.previous")
    }

    pub fn next(&self) -> PathBuf {
        self.folder.join(".Polycarp Browser.next")
    }

    fn part(&self) -> PathBuf {
        self.folder.join(".Polycarp Browser.part")
    }

    pub fn installed(&self) -> Option<Built> {
        Built::read(&self.app())
    }

    /// Running, or it can't be told.
    pub fn running(&self) -> bool {
        running::inside(&self.app()).map_or(true, |pids| !pids.is_empty())
    }

    /// An app of that name that this command did not build is never replaced or removed.
    pub fn ours(&self) -> Result<(), Refused> {
        if exists(&self.app()) && self.installed().is_none() {
            let why = format!("{} was not built by this command", self.app().display());
            return Err(Refused::new("app folder", why));
        }
        Ok(())
    }

    /// A build waiting to be put in: newer than the one installed.
    pub fn waiting(&self) -> Option<Built> {
        let next = Built::read(&self.next())?;
        let installed = self.installed().map_or(0, |b| b.built);
        (next.built > installed).then_some(next)
    }

    /// The build the person went back from: the kept one is newer than the one in use.
    pub fn held(&self) -> Option<Built> {
        let previous = Built::read(&self.previous())?;
        let installed = self.installed()?;
        (previous.built > installed.built).then_some(previous)
    }

    /// Puts right what an interrupted run left: half a copy, or an old build that was not yet moved aside.
    pub fn tidy(&self) -> Result<(), Refused> {
        let left = || -> io::Result<()> {
            clear(&self.part())?;
            if exists(&self.next()) && self.waiting().is_none() {
                match Built::read(&self.next()) {
                    Some(_) if self.installed().is_some() => self.keep_previous()?,
                    _ => clear(&self.next())?,
                }
            }
            Ok(())
        };
        left().map_err(refuse(CHECK, "clearing what an interrupted run left"))
    }

    fn keep_previous(&self) -> io::Result<()> {
        clear(&self.previous())?;
        rename(&self.next(), &self.previous(), libc::RENAME_EXCL)
    }

    /// Moves a finished build beside the app, to wait there.
    pub fn stage(&self, tools: &dyn Tools, built: &Path) -> Result<(), Refused> {
        // An old build an interrupted swap left waiting is kept, not deleted.
        self.tidy()?;
        let part = self.part();
        fs::create_dir_all(&self.folder).map_err(refuse(CHECK, "making the app folder"))?;
        clear(&part).map_err(refuse(CHECK, "clearing half a copy"))?;
        if fs::rename(built, &part).is_err() {
            // Another disk: copied, and the copy's signature checked.
            must(tools, CHECK, &Call::new("/usr/bin/ditto", &[&built, &part]))?;
            let whole: [&dyn AsRef<std::ffi::OsStr>; 4] =
                [&"--verify", &"--deep", &"--strict", &part];
            must(tools, CHECK, &Call::new("/usr/bin/codesign", &whole))?;
        }
        let place = || -> io::Result<()> {
            clear(&self.next())?;
            rename(&part, &self.next(), libc::RENAME_EXCL)
        };
        place().map_err(refuse(CHECK, "placing the new build"))
    }

    /// Puts the waiting build in and keeps the one it replaces. The browser must not be running, before and after.
    pub fn swap(&self) -> Result<(), Refused> {
        let (app, next) = (self.app(), self.next());
        self.ours()?;
        if self.waiting().is_none() {
            return Err(Refused::new(CHECK, "no newer build is waiting"));
        }
        self.not_running()?;
        if !exists(&app) {
            return rename(&next, &app, libc::RENAME_EXCL)
                .map_err(refuse(CHECK, "putting the new build in"));
        }
        self.exchange(&next)?;
        // The new one is in; failing to move the old one aside is put right by the next run.
        let _ = self.keep_previous();
        Ok(())
    }

    /// Puts the kept build back in, and keeps the one it replaces.
    pub fn roll_back(&self, tools: &dyn Tools) -> Result<Built, Refused> {
        let check = "rollback";
        let previous = self.previous();
        let Some(built) = Built::read(&previous) else {
            return Err(Refused::new(check, "no earlier build is kept"));
        };
        if self.installed().is_none() {
            return Err(Refused::new(check, "Polycarp Browser is not installed"));
        }
        self.not_running()?;
        let whole: [&dyn AsRef<std::ffi::OsStr>; 4] =
            [&"--verify", &"--deep", &"--strict", &previous];
        must(tools, check, &Call::new("/usr/bin/codesign", &whole))?;
        // Going back is also away from whatever was waiting.
        clear(&self.next()).map_err(refuse(check, "dropping the waiting build"))?;
        self.exchange(&previous)?;
        Ok(built)
    }

    fn exchange(&self, with: &Path) -> Result<(), Refused> {
        let swap = || rename(with, &self.app(), libc::RENAME_SWAP);
        swap().map_err(refuse(CHECK, "putting the build in"))?;
        // It started in the moment between the check and the swap: it goes back, whole, where it was.
        // Can't be told is taken as started. Always an error after: what was done is undone.
        if running::inside(with).map_or(true, |pids| !pids.is_empty()) {
            swap().map_err(refuse(CHECK, "putting the running build back"))?;
            let why =
                "Polycarp Browser started during the swap; the build it runs is back in place";
            return Err(Refused::new("running", why));
        }
        Ok(())
    }

    pub fn not_running(&self) -> Result<(), Refused> {
        self.quit_first(
            "Polycarp Browser is open. Quit it first, or use `polycarp browser update --when-quit`",
        )
    }

    fn quit_first(&self, why: &str) -> Result<(), Refused> {
        match running::inside(&self.app()) {
            Ok(pids) if pids.is_empty() => Ok(()),
            Ok(_) => Err(Refused::new("running", why)),
            Err(e) => Err(Refused::new(
                "running",
                format!("the list of running programs could not be read: {e}"),
            )),
        }
    }

    /// Removes the app and the builds beside it, and says what went.
    // `uninstall`, which uses it, comes next.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn remove(&self) -> Result<Vec<PathBuf>, Refused> {
        self.ours()?;
        self.quit_first("Polycarp Browser is open. Quit it first")?;
        let mut gone = Vec::new();
        for path in [self.next(), self.part(), self.previous(), self.app()] {
            if exists(&path) {
                clear(&path).map_err(refuse("uninstall", "removing it"))?;
                gone.push(path);
            }
        }
        Ok(gone)
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::*;
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn build(t: &Fake, at: &Path, version: &str, built: u64) {
        t.built_app(at, version, built);
    }

    fn version(app: &Path) -> Option<String> {
        Built::read(app).map(|b| b.helium)
    }

    #[test]
    fn a_first_build_goes_in_and_the_next_keeps_one_behind_it() {
        let t = Fake::new();
        let s = t.spot();
        for (n, v) in ["1.0", "2.0", "3.0"].iter().enumerate() {
            let made = t.work().join("made");
            build(&t, &made, v, n as u64 + 1);
            s.stage(&t, &made).unwrap();
            assert_eq!(s.waiting().unwrap().helium, *v);
            s.swap().unwrap();
            assert_eq!(s.installed().unwrap().helium, *v);
            assert_eq!(s.waiting(), None);
        }
        assert_eq!(version(&s.previous()).unwrap(), "2.0");
        assert_eq!(s.held(), None);
        assert_eq!(s.swap().unwrap_err().why, "no newer build is waiting");
        build(&t, &s.next(), "4.0", 4);
        assert_eq!(s.roll_back(&t).unwrap().helium, "2.0");
        assert_eq!(version(&s.app()).unwrap(), "2.0");
        assert_eq!(version(&s.previous()).unwrap(), "3.0");
        assert_eq!(s.held().unwrap().helium, "3.0");
        assert_eq!(
            s.waiting(),
            None,
            "going back must not leave a build waiting"
        );
    }

    /// Whatever step a run dies at, the app that is there is whole, and the next run goes on from it.
    #[test]
    fn an_interrupted_swap_leaves_a_whole_app() {
        // Half a copy.
        let t = Fake::new();
        let s = t.spot();
        build(&t, &s.app(), "1.0", 1);
        fs::create_dir_all(s.part().join("Contents")).unwrap();
        s.tidy().unwrap();
        assert_eq!(version(&s.app()).unwrap(), "1.0");
        assert!(!s.part().exists());
        // Staged, not swapped: the old one runs on, and the new one still waits.
        build(&t, &s.next(), "2.0", 2);
        s.tidy().unwrap();
        assert_eq!(version(&s.app()).unwrap(), "1.0");
        assert_eq!(s.waiting().unwrap().helium, "2.0");
        // Swapped, the old one not yet moved aside.
        rename(&s.next(), &s.app(), libc::RENAME_SWAP).unwrap();
        assert_eq!(s.waiting(), None, "an old build must not wait to go in");
        s.tidy().unwrap();
        assert_eq!(version(&s.app()).unwrap(), "2.0");
        assert_eq!(version(&s.previous()).unwrap(), "1.0");
        assert!(!s.next().exists());
        // Swapped again with the old build still beside it: a new build keeps it, and the old one never goes back in.
        build(&t, &s.next(), "3.0", 3);
        rename(&s.next(), &s.app(), libc::RENAME_SWAP).unwrap();
        assert_eq!(s.swap().unwrap_err().why, "no newer build is waiting");
        assert_eq!(version(&s.app()).unwrap(), "3.0");
        let made = t.work().join("made");
        build(&t, &made, "4.0", 4);
        s.stage(&t, &made).unwrap();
        assert_eq!(version(&s.previous()).unwrap(), "2.0");
        assert_eq!(s.waiting().unwrap().helium, "4.0");
    }

    #[test]
    fn a_build_from_another_disk_is_copied_and_its_signature_checked() {
        let t = Fake::new();
        let s = t.spot();
        let away = t.work().join("away");
        let made = away.join("made");
        build(&t, &made, "1.0", 1);
        // A folder the build can't be moved out of takes the copy's way, as another disk does.
        let mode = |m| fs::set_permissions(&away, fs::Permissions::from_mode(m)).unwrap();
        mode(0o555);
        t.set(|s| s.fail = Some(("codesign", "--verify", Failure::SaysNo)));
        let refused = s.stage(&t, &made);
        assert_eq!(refused.unwrap_err().check, "swap");
        assert!(
            !s.next().exists(),
            "a copy that failed its check was placed"
        );
        t.set(|s| s.fail = None);
        s.stage(&t, &made).unwrap();
        mode(0o755);
        assert_eq!(s.waiting().unwrap().helium, "1.0");
        let calls = t.calls();
        let verified = calls
            .iter()
            .filter(|c| c.starts_with("codesign --verify --deep --strict"));
        assert_eq!(verified.count(), 2, "{calls:?}");
        assert!(calls.iter().any(|c| c.starts_with("ditto ")), "{calls:?}");
    }

    #[test]
    fn a_swap_that_fails_leaves_the_old_build_in() {
        let t = Fake::new();
        let s = t.spot();
        build(&t, &s.app(), "1.0", 1);
        build(&t, &s.next(), "2.0", 2);
        let mode = |m| fs::set_permissions(&s.folder, fs::Permissions::from_mode(m)).unwrap();
        mode(0o555);
        let e = s.swap().unwrap_err();
        mode(0o755);
        assert_eq!(e.check, "swap");
        assert_eq!(version(&s.app()).unwrap(), "1.0");
        assert_eq!(s.waiting().unwrap().helium, "2.0");
    }

    #[test]
    fn the_running_browser_is_never_replaced_or_removed() {
        let t = Fake::new();
        let s = t.spot();
        build(&t, &s.app(), "1.0", 1);
        build(&t, &s.next(), "2.0", 2);
        build(&t, &s.previous(), "0.9", 0);
        let mut open = t.start_inside(&s.app());
        assert_eq!(s.swap().unwrap_err().check, "running");
        assert_eq!(s.roll_back(&t).unwrap_err().check, "running");
        assert_eq!(s.remove().unwrap_err().check, "running");
        assert_eq!(version(&s.app()).unwrap(), "1.0");
        // One that started between the check and the swap goes back where it was, and that is an error.
        assert_eq!(s.exchange(&s.next()).unwrap_err().check, "running");
        assert_eq!(version(&s.app()).unwrap(), "1.0");
        assert_eq!(s.waiting().unwrap().helium, "2.0");
        open.kill().unwrap();
        open.wait().unwrap();
        s.swap().unwrap();
        assert_eq!(version(&s.app()).unwrap(), "2.0");
    }

    #[test]
    fn an_app_of_that_name_from_somewhere_else_is_left_alone() {
        let t = Fake::new();
        let s = t.spot();
        fs::create_dir_all(s.app().join("Contents")).unwrap();
        build(&t, &s.next(), "2.0", 2);
        assert_eq!(s.swap().unwrap_err().check, "app folder");
        assert_eq!(s.remove().unwrap_err().check, "app folder");
        assert!(s.app().join("Contents").exists());
    }

    #[test]
    fn rolling_back_needs_a_whole_earlier_build() {
        let t = Fake::new();
        let s = t.spot();
        build(&t, &s.app(), "2.0", 2);
        assert_eq!(s.roll_back(&t).unwrap_err().check, "rollback");
        build(&t, &s.previous(), "1.0", 1);
        t.set(|s| s.fail = Some(("codesign", "--verify", Failure::SaysNo)));
        assert_eq!(s.roll_back(&t).unwrap_err().check, "rollback");
        assert_eq!(version(&s.app()).unwrap(), "2.0");
    }

    #[test]
    fn removing_takes_the_app_and_the_builds_beside_it() {
        let t = Fake::new();
        let s = t.spot();
        for at in [s.app(), s.next(), s.previous()] {
            build(&t, &at, "1.0", 1);
        }
        fs::write(s.folder.join("other"), "mine").unwrap();
        assert_eq!(s.remove().unwrap().len(), 3);
        let left: Vec<_> = fs::read_dir(&s.folder).unwrap().collect();
        assert_eq!(left.len(), 1);
    }
}
