//! `polycarp browser`: makes Polycarp Browser on the person's own Mac from a Helium release they download.
//! Nothing from a release is changed or run before its signature, team and Gatekeeper checks pass, and a check
//! that can't run is a refusal.

mod release;
#[cfg(test)]
mod testing;
mod tools;

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

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
        file.try_lock().map_err(|_| {
            Refused::new(
                "lock",
                "another polycarp browser command is already running",
            )
        })?;
        Ok(file)
    }
}

/// `polycarp browser install --dry-run`: looks up the release an install would use.
fn dry_run(tools: &dyn Tools, place: &Place, arch: &str) -> Result<String, Refused> {
    place.prepare()?;
    let _lock = place.lock()?;
    let release = release::newest(tools, arch)?;
    let line = format!(
        "Helium {} is the newest release: {} (sha256 {}). Nothing was downloaded.",
        release.version, release.url, release.sha256
    );
    Ok(line)
}

/// None when these arguments are not a browser command yet.
pub fn run(args: &[OsString], cache: Option<PathBuf>) -> Option<i32> {
    let words: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
    if words.len() != args.len() || words != ["install", "--dry-run"] {
        return None;
    }
    let Some(cache) = cache else {
        eprintln!("polycarp browser: no home folder");
        return Some(1);
    };
    let place = Place {
        cache: cache.join("browser"),
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
    fn a_dry_run_names_the_newest_release_and_downloads_nothing() {
        let t = Fake::new();
        let line = dry_run(&t, &t.place(), "arm64").unwrap();
        assert!(line.contains(VERSION), "{line}");
        let calls = t.calls();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(calls[0].starts_with("curl -q "), "{calls:?}");
        assert!(calls[0].contains("--proto =https --proto-redir =https"));
    }

    #[test]
    fn a_lookup_that_says_no_or_cannot_run_is_refused() {
        for failure in [Failure::SaysNo, Failure::CannotRun] {
            let t = Fake::new();
            t.set(|s| s.fail = Some(("curl", "", failure)));
            let e = dry_run(&t, &t.place(), "arm64").unwrap_err();
            assert_eq!(e.check, "release", "{failure:?}");
        }
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
            assert_eq!(run(&args, None), None);
        }
    }
}
