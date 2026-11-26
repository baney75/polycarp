//! `polycarp browser`: makes Polycarp Browser on the person's own Mac from a Helium release they download.
//! Nothing from a release is changed or run before its signature, team and Gatekeeper checks pass, and a check
//! that can't run is a refusal.

mod change;
mod pages;
mod pak;
mod release;
mod running;
mod sign;
mod source;
// The install step that uses it comes next.
#[cfg_attr(not(test), allow(dead_code))]
mod spot;
mod start;
#[cfg(test)]
mod testing;
mod tools;

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use tools::{System, Tools};

/// Why nothing was installed: the check that failed, and what it found.
#[derive(Debug, PartialEq)]
pub struct Refused {
    pub check: &'static str,
    pub why: String,
}

impl Refused {
    pub fn new(check: &'static str, why: impl Into<String>) -> Refused {
        Refused {
            check,
            why: why.into(),
        }
    }
}

impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "the {} check failed: {}", self.check, self.why)
    }
}

/// Maps an I/O error to a refusal at `check`, saying what was being done.
pub fn refuse<'a>(check: &'static str, doing: &'a str) -> impl FnOnce(io::Error) -> Refused + 'a {
    move |e| Refused::new(check, format!("{doing}: {e}"))
}

/// The folders one run uses.
pub struct Place {
    /// Downloads and half-made builds: this person's only, mode 700.
    pub cache: PathBuf,
    /// What ships beside this command in Polycarp.app: the list of changes, icons, the launcher.
    pub parts: PathBuf,
    /// Polycarp's extension, as staged into Polycarp.app.
    pub extension: PathBuf,
}

impl Place {
    fn prepare(&self) -> Result<(), Refused> {
        let check = "cache folder";
        fs::create_dir_all(&self.cache).map_err(refuse(check, "making it"))?;
        let meta = fs::symlink_metadata(&self.cache).map_err(refuse(check, "reading it"))?;
        if !meta.is_dir() {
            return Err(Refused::new(check, "it is not a folder"));
        }
        fs::set_permissions(&self.cache, fs::Permissions::from_mode(0o700))
            .map_err(refuse(check, "making it private"))
    }

    /// One install or update at a time. The lock lasts as long as the file stays open.
    fn lock(&self) -> Result<fs::File, Refused> {
        let file = fs::File::create(self.cache.join("lock")).map_err(refuse("lock", "opening"))?;
        // A tool being started elsewhere holds a copy of the file for a moment, so one no is not yet an answer.
        for _ in 0..20 {
            match file.try_lock() {
                Ok(()) => return Ok(file),
                Err(fs::TryLockError::Error(e)) => return Err(refuse("lock", "taking it")(e)),
                Err(fs::TryLockError::WouldBlock) => {}
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let why = "another polycarp browser command is already running";
        Err(Refused::new("lock", why))
    }

    /// An empty folder for one build, replacing what an interrupted one left.
    fn work(&self, tools: &dyn Tools) -> Result<PathBuf, Refused> {
        let work = self.cache.join("work");
        // A run that was killed may have left its disk image attached, and no folder in one can be removed.
        source::let_go(tools, &work);
        clear(&work).map_err(refuse("work folder", "clearing it"))?;
        fs::create_dir(&work).map_err(refuse("work folder", "making it"))?;
        Ok(work)
    }
}

/// Removes a folder of this command's own; one that isn't there is fine.
fn clear(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// `polycarp browser install --dry-run`: everything up to the install, then the work is thrown away.
fn dry_run(tools: &dyn Tools, place: &Place, arch: &str) -> Result<String, Refused> {
    place.prepare()?;
    let _lock = place.lock()?;
    let release = release::newest(tools, arch)?;
    let dmg = source::fetch(tools, &release, &place.cache)?;
    let work = place.work(tools)?;
    let built = build(tools, place, &dmg, &work, &release.version);
    let cleared = clear(&work).map_err(refuse("work folder", "clearing it"));
    let (_, note) = built?;
    cleared?;
    let note = note.map(|n| format!("{n}\n")).unwrap_or_default();
    Ok(format!(
        "{note}Helium {} was downloaded, passed its checks and was made into Polycarp Browser, which starts. Nothing was installed.",
        release.version
    ))
}

/// The finished app, in `work`: checked first, then changed and signed. With it, a line to print about the signature.
fn build(
    tools: &dyn Tools,
    place: &Place,
    dmg: &Path,
    work: &Path,
    version: &str,
) -> Result<(PathBuf, Option<&'static str>), Refused> {
    let changes = change::Changes::read(&place.parts)?;
    let (identity, note) = sign::Identity::find(tools, &place.parts)?;
    let app = source::unpack(tools, dmg, work, version)?;
    change::apply(tools, &app, &place.parts, &changes)?;
    pages::put_in(tools, &app, place, &changes)?;
    identity.again(tools, &place.parts)?;
    sign::sign(tools, &app, work, &identity, &changes)?;
    start::check(tools, &app, work, &changes)?;
    Ok((app, note))
}

/// None when these arguments are not a browser command yet.
pub fn run(args: &[OsString], cache: Option<PathBuf>, app: Option<PathBuf>) -> Option<i32> {
    let words: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
    if words.len() != args.len() || words != ["install", "--dry-run"] {
        return None;
    }
    let Some(cache) = cache else {
        eprintln!("polycarp browser: no home folder");
        return Some(1);
    };
    // For tests and for building from a checkout: a folder laid out as Polycarp.app's Resources.
    let resources = std::env::var_os("POLYCARP_BROWSER_RESOURCES").map(PathBuf::from);
    let Some(resources) = resources.or_else(|| app.map(|a| a.join("Contents/Resources"))) else {
        eprintln!("polycarp browser: Polycarp.app was not found, and the browser is built from parts inside it");
        return Some(1);
    };
    let place = Place {
        cache: cache.join("browser"),
        parts: resources.join("make-browser"),
        extension: resources.join("extension"),
    };
    Some(match dry_run(&System, &place, release::this_arch()) {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(refused) => {
            eprintln!("polycarp browser: {refused}. Nothing was changed.");
            1
        }
    })
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    #[test]
    fn a_dry_run_checks_the_release_and_leaves_no_work_behind() {
        let t = Fake::new();
        let line = dry_run(&t, &t.place(), "arm64").unwrap();
        assert!(line.contains(VERSION), "{line}");
        assert!(!t.place().cache.join("work").exists());
        assert!(!t.mounted(), "the disk image stayed mounted");
        // Once to refuse before anything is unpacked, and again to unlock the key just before signing.
        let asked = t
            .calls()
            .iter()
            .filter(|c| c.contains("signing-identity.sh"))
            .count();
        assert_eq!(asked, 2);
    }

    /// The whole of it on the newest real release: fetched, checked, changed, signed ad hoc, and started with no window.
    /// `POLYCARP_BROWSER_RESOURCES` is what `browser/scripts/build-parts.sh` and the extension's `stage.sh` made.
    #[test]
    #[ignore = "downloads a browser and starts it without a window"]
    fn a_real_release_is_made_into_a_browser_that_starts() {
        let t = Fake::new();
        let made = std::env::var_os("POLYCARP_BROWSER_RESOURCES");
        let made = PathBuf::from(made.expect("POLYCARP_BROWSER_RESOURCES"));
        let mut place = t.place();
        // The real signing script is left out: `parts()` put a stand-in that says there is no key, so no keychain is asked.
        for part in ["changes.toml", "icon.icns", "icon-32.png", "launcher"] {
            fs::copy(made.join("make-browser").join(part), place.parts.join(part)).unwrap();
        }
        place.extension = made.join("extension");
        if let Some(kept) = std::env::var_os("POLYCARP_CACHE_DIR") {
            place.cache = kept.into();
        }
        let line = dry_run(&System, &place, release::this_arch()).unwrap();
        assert!(line.contains("which starts"), "{line}");
        assert!(!place.cache.join("work").exists());
    }

    #[test]
    fn only_one_run_at_a_time() {
        let t = Fake::new();
        t.place().prepare().unwrap();
        let held = t.place().lock().unwrap();
        let e = dry_run(&t, &t.place(), "arm64").unwrap_err();
        assert_eq!(e.check, "lock");
        drop(held);
        dry_run(&t, &t.place(), "arm64").unwrap();
    }

    #[test]
    fn the_cache_is_private() {
        let t = Fake::new();
        t.place().prepare().unwrap();
        let mode = fs::metadata(t.place().cache).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn anything_else_is_not_a_browser_command_yet() {
        for args in [&["install"][..], &[], &["install", "--dry-run", "x"]] {
            let args: Vec<OsString> = args.iter().map(OsString::from).collect();
            assert_eq!(run(&args, None, None), None);
        }
    }
}
