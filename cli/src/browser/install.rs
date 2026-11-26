//! `polycarp browser install` and `update`: a new build is made whole beside the old one and put in when nothing runs.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::change::files;
use super::progress::{Progress, Step};
use super::release::{self, Release};
use super::spot::Spot;
use super::tools::Tools;
use super::{build, clear, pages, refuse, source, status, Place, Refused};

/// Part of every build's fingerprint: raised when the way a build is made changes, so installed ones are made again.
const RECIPE: &str = "1";

#[derive(Clone, Copy, Default)]
pub struct Ask {
    /// Only when there is something newer to put in.
    pub update: bool,
    /// When the browser is open, put the new build in once it quits.
    pub when_quit: bool,
}

#[derive(Debug)]
pub struct Outcome {
    pub line: String,
    /// A build waits for the browser to quit.
    pub waiting: bool,
}

fn done(line: impl Into<String>) -> Outcome {
    Outcome {
        line: line.into(),
        waiting: false,
    }
}

fn waits(version: &str) -> Outcome {
    Outcome {
        line: format!(
            "Polycarp Browser on Helium {version} is ready and goes in when you quit the browser."
        ),
        waiting: true,
    }
}

/// The folder the app goes in: the one asked for, the one it is in, or Polycarp's own when it can be written to.
pub fn spot_for(
    asked: Option<&Path>,
    home: &Path,
    polycarp: Option<&Path>,
) -> Result<Spot, Refused> {
    let check = "app folder";
    let folder = match asked {
        Some(folder) if !folder.is_absolute() => {
            return Err(Refused::new(check, "--app-dir needs a full path"));
        }
        Some(folder) => folder.to_path_buf(),
        None => {
            let mine = home.join("Applications");
            let beside = polycarp.and_then(Path::parent).map(Path::to_path_buf);
            let spots = [beside.unwrap_or(mine.clone()), mine];
            let has = |folder: &&PathBuf| {
                let spot = Spot {
                    folder: (*folder).clone(),
                };
                spot.installed().is_some()
            };
            let found = spots.iter().find(has);
            let found = found.or_else(|| spots.iter().find(|f| writable(f)));
            found.unwrap_or(&spots[1]).clone()
        }
    };
    // The launcher hands Chromium a list of folders, which commas divide.
    if folder.as_os_str().to_string_lossy().contains(',') {
        return Err(Refused::new(check, "its path has a comma in it"));
    }
    Ok(Spot { folder })
}

fn writable(folder: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(folder.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: a C string that outlives the call.
    folder.is_dir() && unsafe { libc::access(path.as_ptr(), libc::W_OK) } == 0
}

/// A digest of what Polycarp puts into a build. The extension's `version_name` changes with every Polycarp build and is
/// left out, so a new Polycarp alone doesn't make the browser again.
pub fn fingerprint(place: &Place) -> Result<String, Refused> {
    let read = |root: &Path| -> std::io::Result<BTreeMap<PathBuf, Vec<u8>>> {
        let mut all = BTreeMap::new();
        for file in files(root)? {
            let name = file.strip_prefix(root).map_err(std::io::Error::other)?;
            let mut bytes = fs::read(&file)?;
            if name == Path::new("manifest.json") {
                if let Ok(Value::Object(mut manifest)) = serde_json::from_slice(&bytes) {
                    manifest.remove("version_name");
                    bytes = serde_json::to_vec(&manifest)?;
                }
            }
            all.insert(name.to_path_buf(), bytes);
        }
        Ok(all)
    };
    let mut digest = Sha256::new();
    digest.update(RECIPE);
    for root in [&place.parts, &place.extension] {
        for (name, bytes) in read(root).map_err(refuse("parts", "reading them"))? {
            let name = name.as_os_str().to_string_lossy();
            digest.update(format!("\0{name}\0{}\0", bytes.len()));
            digest.update(bytes);
        }
    }
    let digest = digest.finalize();
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn install(
    tools: &dyn Tools,
    place: &Place,
    arch: &str,
    ask: Ask,
    progress: &Progress,
) -> Result<Outcome, Refused> {
    let spot = &place.spot;
    spot.ours()?;
    if ask.update && spot.installed().is_none() {
        return Err(Refused::new("install", "Polycarp Browser is not installed"));
    }
    place.prepare()?;
    let _lock = place.lock()?;
    spot.tidy()?;
    // One that waited for the browser to quit, and whose waiter is gone.
    if spot.waiting().is_some() && !spot.running() {
        spot.swap()?;
    }
    let newest = release::newest(tools, arch)?;
    status::remember(&place.cache, &newest);
    if let Some(told) = nothing_to_do(place, &newest, ask)? {
        return Ok(told);
    }
    if !ask.when_quit {
        spot.not_running()?;
    }
    let dmg = source::fetch(tools, &newest, &place.cache, progress)?;
    let work = place.work(tools)?;
    let built = build(tools, place, &dmg, &work, &newest, progress).and_then(|(app, note)| {
        progress.begin(Step::SwapIn);
        spot.stage(tools, &app).map(|_| note)
    });
    let cleared = clear(&work).map_err(refuse("work folder", "clearing it"));
    let note = built?;
    cleared?;
    let later = "goes in when you quit the browser";
    if spot.running() && ask.when_quit {
        progress.end(Some(later));
        return Ok(waits(&newest.version));
    }
    match spot.swap() {
        Err(e) if e.check == "running" && ask.when_quit => {
            progress.end(Some(later));
            return Ok(waits(&newest.version));
        }
        put_in => put_in?,
    }
    progress.end(None);
    let app = spot.app();
    let mut lines = vec![format!(
        "Polycarp Browser on Helium {} is in {}.",
        newest.version,
        app.display()
    )];
    lines.extend(note.map(String::from));
    lines.extend(pages::set_up(&place.data, place.host.as_deref()));
    Ok(done(lines.join("\n")))
}

fn nothing_to_do(place: &Place, newest: &Release, ask: Ask) -> Result<Option<Outcome>, Refused> {
    let spot = &place.spot;
    let waiting = spot.waiting();
    let is_waiting = waiting.is_some();
    let Some(have) = waiting.or_else(|| spot.installed()) else {
        return Ok(None);
    };
    let older = release::parts(&newest.version) < release::parts(&have.helium);
    if older && !ask.update {
        let why = format!(
            "{} is the newest, and {} is installed",
            newest.version, have.helium
        );
        return Err(Refused::new("release", why));
    }
    if !ask.update {
        return Ok(None);
    }
    if spot
        .held()
        .is_some_and(|held| held.helium == newest.version)
    {
        return Ok(Some(done(format!(
            "You went back from Helium {} to {}, so this update is left out. `polycarp browser install` puts it in.",
            newest.version, have.helium
        ))));
    }
    if older || (have.helium == newest.version && have.parts == fingerprint(place)?) {
        return Ok(Some(match is_waiting {
            true => waits(&have.helium),
            false => done(format!(
                "Polycarp Browser is up to date: Helium {}.",
                have.helium
            )),
        }));
    }
    Ok(None)
}

pub fn roll_back(tools: &dyn Tools, place: &Place) -> Result<Outcome, Refused> {
    place.prepare()?;
    let _lock = place.lock()?;
    place.spot.ours()?;
    place.spot.tidy()?;
    let built = place.spot.roll_back(tools)?;
    Ok(done(format!(
        "Polycarp Browser is back on Helium {}. Updates leave out the build you went back from.",
        built.helium
    )))
}

/// Waits for the browser to quit and puts in the build that waits. One waiter at a time.
pub fn finish(place: &Place, mut pause: impl FnMut()) -> Result<(), Refused> {
    place.prepare()?;
    let Ok(_only) = place.lock_named("waiter") else {
        return Ok(());
    };
    while place.spot.waiting().is_some() {
        if !place.spot.running() {
            if let Ok(_lock) = place.lock() {
                match place.spot.swap() {
                    Err(e) if e.check != "running" => return Err(e),
                    Err(_) => {}
                    Ok(()) => {
                        pages::set_up(&place.data, place.host.as_deref());
                    }
                }
            }
        }
        if place.spot.waiting().is_some() {
            pause();
        }
    }
    Ok(())
}

/// Starts `finish` as a process of its own, which outlives this one and the app that started it.
pub fn start_waiter(program: &Path, spot: &Spot) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let args: [&OsStr; 4] = [
        "browser".as_ref(),
        "finish".as_ref(),
        "--app-dir".as_ref(),
        spot.folder.as_ref(),
    ];
    let mut command = Command::new(program);
    command.args(args).current_dir("/");
    command.stdin(Stdio::null());
    command.stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: setsid is safe to call between fork and exec.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    command.spawn().map(drop)
}

#[cfg(test)]
mod tests {
    use super::super::testing::*;
    use super::*;

    const INSTALL: Ask = Ask {
        update: false,
        when_quit: false,
    };
    const UPDATE: Ask = Ask {
        update: true,
        when_quit: false,
    };
    const WHEN_QUIT: Ask = Ask {
        update: true,
        when_quit: true,
    };

    fn go(t: &Fake, ask: Ask) -> Result<Outcome, Refused> {
        install(t, &t.place(), "arm64", ask, &Progress::silent())
    }

    fn helium(t: &Fake) -> Option<String> {
        t.spot().installed().map(|b| b.helium)
    }

    #[test]
    fn a_first_install_puts_the_app_in_with_a_profile_and_the_new_tab_host() {
        let t = Fake::new();
        assert_eq!(go(&t, UPDATE).unwrap_err().check, "install");
        assert!(!t.place().cache.exists(), "an update of nothing did work");
        let done = go(&t, INSTALL).unwrap();
        assert!(!done.waiting);
        assert!(done.line.contains(VERSION), "{}", done.line);
        let place = t.place();
        let built = place.spot.installed().unwrap();
        assert_eq!(built.helium, VERSION);
        assert_eq!(built.parts, fingerprint(&place).unwrap());
        assert!(!built.certificate);
        assert!(place.data.join("Local State").exists());
        let hosts = place.data.join("NativeMessagingHosts");
        let host = fs::read_to_string(hosts.join("com.polycarp.newtab.json")).unwrap();
        assert!(host.contains("polycarp-spaces"), "{host}");
        assert!(!place.cache.join("work").exists());
        let up_to_date = go(&t, UPDATE).unwrap();
        assert!(up_to_date.line.contains("up to date"));
        // Asked for, it is made again.
        go(&t, INSTALL).unwrap();
        assert!(place.spot.previous().exists());
    }

    /// Whichever check fails, what was installed is what is still there.
    #[test]
    fn every_failed_check_leaves_what_was_installed() {
        for (check, broken) in failing_scenes() {
            let t = Fake::new();
            let spot = t.spot();
            t.built_app(&spot.app(), "0.1.0", 1);
            let before = t.listing(&spot.app());
            t.set(broken);
            for ask in [INSTALL, UPDATE, WHEN_QUIT] {
                let e = go(&t, ask).unwrap_err();
                assert_eq!(e.check, check);
                assert_eq!(t.listing(&spot.app()), before, "{check}");
                assert_eq!(spot.waiting(), None, "{check}");
                assert!(!spot.previous().exists(), "{check}");
                assert!(!t.place().cache.join("work").exists(), "{check}");
                assert!(!t.place().data.exists(), "{check}");
            }
        }
    }

    #[test]
    fn every_step_is_shown_in_order_and_the_last_line_names_the_version() {
        let t = Fake::new();
        let (screen, progress) = super::super::progress::tests::screen(false);
        let done = install(&t, &t.place(), "arm64", INSTALL, &progress).unwrap();
        drop(progress);
        let text = screen.text();
        let begun: Vec<&str> = text.lines().filter(|l| !l.contains(" done in ")).collect();
        let want = ["Download", "Verify", "Build", "Sign", "Check", "Swap in"];
        let want: Vec<String> = (1..=6)
            .zip(want)
            .map(|(n, name)| format!("Step {n} of 6: {name}"))
            .collect();
        assert_eq!(begun, want, "{text}");
        assert_eq!(text.lines().filter(|l| l.contains(" done in ")).count(), 6);
        assert!(
            done.line
                .starts_with(&format!("Polycarp Browser on Helium {VERSION} is in ")),
            "{}",
            done.line
        );
    }

    #[test]
    fn a_newer_release_or_newer_parts_are_an_update_and_an_older_release_is_not() {
        let t = Fake::new();
        let spot = t.spot();
        t.built_app(&spot.app(), "0.1.0", 1);
        go(&t, UPDATE).unwrap();
        assert_eq!(helium(&t).unwrap(), VERSION);
        let place = t.place();
        let before = fingerprint(&place).unwrap();
        let manifest = place.extension.join("manifest.json");
        fs::write(&manifest, "{\"version_name\":\"another Polycarp\"}").unwrap();
        assert_eq!(fingerprint(&place).unwrap(), before);
        fs::write(&manifest, "{\"name\":\"changed\"}").unwrap();
        assert_ne!(fingerprint(&place).unwrap(), before);

        let t = Fake::new();
        let spot = t.spot();
        t.built_app(&spot.app(), VERSION, 1);
        assert!(go(&t, UPDATE)
            .unwrap()
            .line
            .starts_with("Polycarp Browser on"));
        t.built_app(&spot.app(), "99.0", 9);
        assert!(go(&t, UPDATE).unwrap().line.contains("up to date"));
        assert_eq!(go(&t, INSTALL).unwrap_err().check, "release");
        assert_eq!(helium(&t).unwrap(), "99.0");
    }

    #[test]
    fn an_app_of_that_name_from_somewhere_else_is_found_before_any_work() {
        let t = Fake::new();
        fs::create_dir_all(t.spot().app()).unwrap();
        for ask in [INSTALL, UPDATE] {
            assert_eq!(go(&t, ask).unwrap_err().check, "app folder");
        }
        assert!(t.calls().is_empty());
    }

    #[test]
    fn while_it_runs_an_update_waits_for_it_to_quit() {
        let t = Fake::new();
        let spot = t.spot();
        t.built_app(&spot.app(), "0.1.0", 1);
        let mut open = t.start_inside(&spot.app());
        for ask in [INSTALL, UPDATE] {
            assert_eq!(go(&t, ask).unwrap_err().check, "running");
        }
        let downloads = |t: &Fake| t.calls().iter().filter(|c| c.contains("--output")).count();
        assert_eq!(downloads(&t), 0, "it was refused only after the download");
        assert!(go(&t, WHEN_QUIT).unwrap().waiting);
        assert_eq!(helium(&t).unwrap(), "0.1.0");
        // Asked again, it is not made again.
        assert!(go(&t, WHEN_QUIT).unwrap().waiting);
        assert_eq!(downloads(&t), 1);
        let mut pauses = 0;
        finish(&t.place(), || {
            pauses += 1;
            assert_eq!(helium(&t).unwrap(), "0.1.0");
            // A second waiter leaves at once.
            finish(&t.place(), || panic!("two waiters")).unwrap();
            open.kill().unwrap();
            open.wait().unwrap();
        })
        .unwrap();
        assert!(pauses > 0);
        assert_eq!(helium(&t).unwrap(), VERSION);
        assert!(spot.previous().exists());
        assert!(t.place().data.join("Local State").exists());
    }

    #[test]
    fn a_build_whose_waiter_is_gone_goes_in_with_the_next_update() {
        let t = Fake::new();
        let spot = t.spot();
        t.built_app(&spot.app(), "0.1.0", 1);
        t.built_app(&spot.next(), "99.0", 2);
        assert!(go(&t, WHEN_QUIT).unwrap().line.contains("up to date"));
        assert_eq!(helium(&t).unwrap(), "99.0");
    }

    #[test]
    fn an_update_leaves_out_the_build_you_went_back_from() {
        let t = Fake::new();
        let spot = t.spot();
        t.built_app(&spot.app(), "0.1.0", 1);
        go(&t, UPDATE).unwrap();
        roll_back(&t, &t.place()).unwrap();
        assert_eq!(helium(&t).unwrap(), "0.1.0");
        assert!(go(&t, WHEN_QUIT).unwrap().line.contains("left out"));
        assert_eq!(helium(&t).unwrap(), "0.1.0");
        go(&t, INSTALL).unwrap();
        assert_eq!(helium(&t).unwrap(), VERSION);
    }

    #[test]
    fn a_build_without_the_certificate_never_replaces_one_with_it() {
        let t = Fake::new();
        let spot = t.spot();
        t.built_app(&spot.app(), "0.1.0", 1);
        let mut built = spot.installed().unwrap();
        built.certificate = true;
        built.write(&spot.app()).unwrap();
        assert_eq!(go(&t, UPDATE).unwrap_err().check, "signing");
        assert_eq!(helium(&t).unwrap(), "0.1.0");
    }

    #[test]
    fn the_app_goes_where_it_is_or_beside_polycarp_when_that_can_be_written() {
        let t = Fake::new();
        let (home, apps) = (t.work().join("home"), t.work().join("Apps"));
        let polycarp = apps.join("Polycarp.app");
        fs::create_dir_all(&apps).unwrap();
        let folder =
            |asked: Option<&Path>| spot_for(asked, &home, Some(&polycarp)).map(|s| s.folder);
        assert_eq!(folder(None).unwrap(), apps);
        use std::os::unix::fs::PermissionsExt;
        let mode = |m| fs::set_permissions(&apps, fs::Permissions::from_mode(m)).unwrap();
        mode(0o555);
        assert_eq!(folder(None).unwrap(), home.join("Applications"));
        mode(0o755);
        t.built_app(
            &home.join("Applications").join(super::super::spot::APP),
            "1.0",
            1,
        );
        assert_eq!(folder(None).unwrap(), home.join("Applications"));
        assert_eq!(folder(Some(&t.work())).unwrap(), t.work());
        assert_eq!(
            folder(Some(Path::new("x"))).unwrap_err().check,
            "app folder"
        );
        assert_eq!(
            folder(Some(Path::new("/a,b"))).unwrap_err().check,
            "app folder"
        );
        assert_eq!(
            spot_for(None, &home, None).unwrap().folder,
            home.join("Applications")
        );
    }
}
