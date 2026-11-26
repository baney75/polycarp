//! `polycarp browser`: makes Polycarp Browser on the person's own Mac from a Helium release they download.
//! Nothing from a release is changed or run before its signature, team and Gatekeeper checks pass, and a check
//! that can't run is a refusal.

mod change;
mod chromium;
mod cookies;
mod gone;
mod import;
mod install;
mod keys;
mod pages;
mod pak;
mod progress;
mod release;
mod running;
mod sign;
mod source;
mod spot;
mod start;
mod status;
#[cfg(test)]
mod testing;
mod tools;

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use progress::{Progress, Step};
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
    /// Where the app goes.
    pub spot: spot::Spot,
    /// The browser's own data folder.
    pub data: PathBuf,
    pub home: PathBuf,
    /// The pages Chromium keeps for that data folder.
    pub page_cache: PathBuf,
    /// What answers the new tab page; None where Polycarp.app isn't installed.
    pub host: Option<PathBuf>,
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

    /// One install or update at a time.
    fn lock(&self) -> Result<fs::File, Refused> {
        self.lock_named("lock")
    }

    /// The lock lasts as long as the file stays open.
    fn lock_named(&self, name: &str) -> Result<fs::File, Refused> {
        let file = fs::File::create(self.cache.join(name)).map_err(refuse("lock", "opening"))?;
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
fn dry_run(
    tools: &dyn Tools,
    place: &Place,
    arch: &str,
    progress: &Progress,
) -> Result<String, Refused> {
    place.prepare()?;
    let _lock = place.lock()?;
    let release = release::newest(tools, arch)?;
    let dmg = source::fetch(tools, &release, &place.cache, progress)?;
    let work = place.work(tools)?;
    let built = build(tools, place, &dmg, &work, &release, progress);
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
    release: &release::Release,
    progress: &Progress,
) -> Result<(PathBuf, Option<&'static str>), Refused> {
    progress.begin(Step::Verify);
    let changes = change::Changes::read(&place.parts)?;
    let (identity, note) = sign::Identity::find(tools, &place.parts)?;
    let certificate = identity.certificate();
    if !certificate && place.spot.installed().is_some_and(|b| b.certificate) {
        // It would lose the browser its saved passwords and permissions until the person allows each again.
        let why = "Polycarp's signing identity was not found, and the installed build was signed with it. Run `polycarp browser uninstall` first to start over without it";
        return Err(Refused::new("signing", why));
    }
    let app = source::unpack(tools, dmg, work, &release.version)?;
    progress.end(None);
    progress.begin(Step::Build);
    change::apply(tools, &app, &place.parts, &changes)?;
    change::put_theme_icon(&app, &place.home, &changes)?;
    pages::put_in(tools, &app, place, &changes)?;
    let built = spot::Built {
        helium: release.version.clone(),
        published: release.published,
        built: now_millis(),
        parts: install::fingerprint(place)?,
        certificate,
    };
    built
        .write(&app)
        .map_err(refuse("built-in pages", "marking the build"))?;
    progress.end(None);
    progress.begin(Step::Sign);
    identity.again(tools, &place.parts)?;
    sign::sign(tools, &app, work, &identity, &changes)?;
    progress.end(None);
    progress.begin(Step::Check);
    start::check(tools, &app, work, &changes)?;
    progress.end(None);
    Ok((app, note))
}

fn now_millis() -> u64 {
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    since.map_or(0, |d| d.as_millis() as u64)
}

/// What was asked, from the arguments.
#[derive(Debug, Default, PartialEq)]
struct Asked {
    verb: String,
    flags: Vec<String>,
    app_dir: Option<PathBuf>,
    /// The address to open, or the browser to import from.
    what: Option<String>,
    profile: Option<String>,
}

/// Err is the line to print.
fn read_args(args: &[OsString]) -> Result<Asked, String> {
    let mut asked = Asked::default();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let Some(word) = arg.to_str() else {
            return Err(format!("{} is not an option", arg.to_string_lossy()));
        };
        if word == "--app-dir" {
            let folder = args.next().ok_or("--app-dir needs a folder")?;
            asked.app_dir = Some(folder.into());
        } else if word == "--profile" && asked.verb == "import" {
            let name = args.next().and_then(|n| n.to_str());
            asked.profile = Some(name.ok_or("--profile needs a name")?.into());
        } else if word.starts_with('-') {
            asked.flags.push(word.into());
        } else if asked.verb.is_empty() {
            asked.verb = word.into();
        } else if ["open", "import"].contains(&asked.verb.as_str()) && asked.what.is_none() {
            asked.what = Some(word.into());
        } else {
            return Err(format!("{word} is not an option"));
        }
    }
    let allowed: &[&str] = match asked.verb.as_str() {
        "install" => &["--dry-run", "--rollback"],
        "update" => &["--when-quit"],
        "status" => &["--json"],
        "uninstall" => &["--profile", "--yes"],
        "import" => &["--yes"],
        _ => &[],
    };
    if let Some(flag) = asked.flags.iter().find(|f| !allowed.contains(&f.as_str())) {
        return Err(format!("{flag} is not an option of {}", asked.verb));
    }
    let mut flags = asked.flags.iter().enumerate();
    if let Some((_, flag)) = flags.find(|(i, f)| asked.flags[..*i].contains(f)) {
        return Err(format!("{flag} is given twice"));
    }
    let has = |f: &str| asked.flags.iter().any(|x| x == f);
    if asked.verb == "uninstall" && has("--yes") && !has("--profile") {
        return Err("--yes goes with --profile".into());
    }
    if has("--dry-run") && has("--rollback") {
        return Err(format!("{} can't go together", asked.flags.join(" and ")));
    }
    Ok(asked)
}

/// Not `browser`: on a Mac that is Chromium's own cache folder for this browser, in other letters.
fn own_cache(cache: &Path) -> PathBuf {
    cache.join("browser-build")
}

/// The line `polycarp doctor` prints; None when the browser is not installed.
pub fn doctor(home: &Path, cache: &Path, app: Option<&Path>) -> Option<String> {
    let spot = install::spot_for(None, home, app).ok()?;
    status::doctor(&own_cache(cache), &spot)
}

/// The first words this command answers. Anything else is the old agent browser's command.
const VERBS: [&str; 7] = [
    "install",
    "update",
    "status",
    "open",
    "import",
    "uninstall",
    "finish",
];

const HELP: &str = "\
polycarp browser: Polycarp Browser, made on this Mac from Helium's own release

Usage:
  polycarp browser install       make it and put it in (--dry-run only checks; --rollback puts back the build before)
  polycarp browser update        put in a newer one (--when-quit waits until you quit the browser)
  polycarp browser status        which one you have, and how far behind it is (--json)
  polycarp browser open [address]
  polycarp browser import        list the browsers on this Mac and their profiles, by name
  polycarp browser import helium [--profile NAME] --yes
                                 copy a Helium profile; Helium's own stays as it is
  polycarp browser import chrome|brave|edge|vivaldi|arc|chromium [--profile NAME] --yes
                                 copy bookmarks, history and sign-ins into a new profile
  polycarp browser uninstall     remove the app; your profile stays unless you add --profile --yes

  --app-dir DIR                  where the app is, instead of beside Polycarp.app or in ~/Applications

Nothing of a release is used before its signature, its maker and Gatekeeper's answer are checked. See docs/browser.md.
";

/// None when these arguments are not a browser command.
pub fn run(
    args: &[OsString],
    home: Option<PathBuf>,
    cache: Option<PathBuf>,
    app: Option<PathBuf>,
) -> Option<i32> {
    let verb = args.first().map_or(Some("--help"), |a| a.to_str())?;
    if ["--help", "-h", "help"].contains(&verb) {
        print!("{HELP}");
        return Some(0);
    }
    if !VERBS.contains(&verb) {
        return None;
    }
    let asked = match read_args(args) {
        Ok(asked) => asked,
        Err(line) => {
            eprintln!("polycarp browser: {line}");
            return Some(2);
        }
    };
    let (Some(home), Some(cache)) = (home, cache) else {
        eprintln!("polycarp browser: no home folder");
        return Some(1);
    };
    // For tests and for building from a checkout: a folder laid out as Polycarp.app's Resources.
    let resources = std::env::var_os("POLYCARP_BROWSER_RESOURCES").map(PathBuf::from);
    let resources = resources.or_else(|| app.as_ref().map(|a| a.join("Contents/Resources")));
    let builds = asked.verb == "install" || asked.verb == "update";
    if builds && resources.is_none() {
        eprintln!("polycarp browser: Polycarp.app was not found, and the browser is built from parts inside it");
        return Some(1);
    }
    let resources = resources.unwrap_or_default();
    let has = |f: &str| asked.flags.iter().any(|x| x == f);
    if asked.verb == "uninstall" && has("--profile") && !has("--yes") {
        println!("{}", gone::would_remove(&home));
        return Some(2);
    }
    let done =
        install::spot_for(asked.app_dir.as_deref(), &home, app.as_deref()).and_then(|spot| {
            let place = Place {
                cache: own_cache(&cache),
                parts: resources.join("make-browser"),
                extension: resources.join("extension"),
                spot,
                data: gone::profile(&home)[0].clone(),
                home: home.clone(),
                page_cache: gone::profile(&home)[1].clone(),
                host: app.map(|a| a.join("Contents/Resources/bin/polycarp-spaces")),
            };
            let progress = match builds {
                true => Progress::terminal(),
                false => Progress::silent(),
            };
            answer(&System, &place, &asked, &progress)
        });
    Some(print(done))
}

/// What a run says, on stdout or stderr, and its exit code.
fn print(done: Result<String, Refused>) -> i32 {
    match done {
        Ok(line) => {
            if !line.is_empty() {
                println!("{line}");
            }
            0
        }
        Err(refused) => {
            eprintln!("polycarp browser: {refused}. The installed browser was not changed.");
            1
        }
    }
}

fn answer(
    tools: &dyn Tools,
    place: &Place,
    asked: &Asked,
    progress: &Progress,
) -> Result<String, Refused> {
    let arch = release::this_arch();
    let flag = |f: &str| asked.flags.iter().any(|x| x == f);
    let ask = install::Ask {
        update: asked.verb == "update",
        when_quit: flag("--when-quit"),
    };
    let outcome = match asked.verb.as_str() {
        "finish" => {
            let wait = || std::thread::sleep(std::time::Duration::from_secs(2));
            return install::finish(place, wait).map(|_| String::new());
        }
        "status" => {
            let status = status::status(tools, place, arch);
            return match flag("--json") {
                true => serde_json::to_string_pretty(&status)
                    .map_err(|e| Refused::new("status", e.to_string())),
                false => Ok(status.text()),
            };
        }
        "open" => return gone::open(tools, &place.spot, asked.what.as_deref()),
        "import" => return import::answer(tools, &keys::Keychain, place, asked),
        "uninstall" => return gone::uninstall(place, flag("--profile")),
        "install" if flag("--dry-run") => return dry_run(tools, place, arch, progress),
        "install" if flag("--rollback") => install::roll_back(tools, place)?,
        _ => install::install(tools, place, arch, ask, progress)?,
    };
    if outcome.waiting {
        let start = std::env::current_exe().and_then(|me| install::start_waiter(&me, &place.spot));
        start.map_err(refuse(
            "swap",
            "starting what waits for the browser to quit",
        ))?;
    }
    Ok(outcome.line)
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    #[test]
    fn a_dry_run_checks_the_release_and_leaves_no_work_behind() {
        let t = Fake::new();
        let line = dry_run(&t, &t.place(), "arm64", &Progress::silent()).unwrap();
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
        let line = dry_run(&System, &place, release::this_arch(), &Progress::silent()).unwrap();
        assert!(line.contains("which starts"), "{line}");
        assert!(!place.cache.join("work").exists());
    }

    #[test]
    fn only_one_run_at_a_time() {
        let t = Fake::new();
        t.place().prepare().unwrap();
        let held = t.place().lock().unwrap();
        let e = dry_run(&t, &t.place(), "arm64", &Progress::silent()).unwrap_err();
        assert_eq!(e.check, "lock");
        drop(held);
        dry_run(&t, &t.place(), "arm64", &Progress::silent()).unwrap();
    }

    #[test]
    fn the_cache_is_private() {
        let t = Fake::new();
        t.place().prepare().unwrap();
        let mode = fs::metadata(t.place().cache).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn anything_else_is_not_a_browser_command() {
        let words = |args: &[&str]| args.iter().map(OsString::from).collect::<Vec<_>>();
        for args in [&["mcp"][..], &["--version"], &["serve", "--port", "1"]] {
            assert_eq!(run(&words(args), None, None, None), None);
        }
        for args in [
            &["install", "x"][..],
            &["install", "--when-quit"],
            &["install", "--dry-run", "--rollback"],
            &["update", "--rollback"],
            &["update", "--app-dir"],
            &["uninstall", "--yes"],
            &["status", "x"],
            &["open", "https://a.example", "https://b.example"],
        ] {
            assert_eq!(run(&words(args), None, None, None), Some(2), "{args:?}");
        }
        let asked = read_args(&words(&["update", "--app-dir", "/x", "--when-quit"])).unwrap();
        assert_eq!(asked.app_dir.unwrap(), Path::new("/x"));
        assert_eq!(asked.flags, ["--when-quit"]);
        let asked = read_args(&words(&["open", "https://a.example"])).unwrap();
        assert_eq!(asked.what.unwrap(), "https://a.example");
    }

    /// Asked for the profile without --yes, it says what would go and removes nothing.
    #[test]
    fn a_profile_goes_only_with_a_yes() {
        let t = Fake::new();
        let home = t.work().join("home");
        let profile = gone::profile(&home);
        fs::create_dir_all(&profile[0]).unwrap();
        for asked in [
            &["uninstall", "--profile"][..],
            &["uninstall", "--profile", "--profile"],
        ] {
            let args: Vec<OsString> = asked.iter().map(Into::into).collect();
            assert_eq!(
                run(&args, Some(home.clone()), Some(t.work()), None),
                Some(2),
                "{asked:?}"
            );
            assert!(profile[0].exists(), "{asked:?}");
        }
        let twice: Vec<OsString> = ["uninstall", "--profile", "--yes", "--yes"]
            .iter()
            .map(Into::into)
            .collect();
        assert_eq!(read_args(&twice).unwrap_err(), "--yes is given twice");
    }

    #[test]
    fn the_build_cache_is_not_the_browsers_own_cache() {
        let home = Path::new("/h");
        let low = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
        let mine = low(&own_cache(&home.join("Library/Caches/polycarp")));
        for theirs in gone::profile(home) {
            let theirs = low(&theirs);
            assert!(!mine.starts_with(&theirs) && !theirs.starts_with(&mine));
        }
    }
}
