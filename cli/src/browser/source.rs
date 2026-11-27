//! Fetch a Helium release, copy its app out of the disk image into this command's private folder, and check it.

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::progress::{self, Progress, Step};
use super::release::{curl, Release};
use super::tools::{must, Call, Tools};
use super::{refuse, Refused};

/// The only maker whose app is used. Kept here, in the signed command, and not in a file that ships beside it.
const TEAM: &str = "S4Q33XPHB4";
const IDENTIFIER: &str = "net.imput.helium";
const APP: &str = "Helium.app";
/// Where the image is attached, in the work folder.
const MOUNT: &str = "mount";
/// Apple-anchored, Developer ID (both Apple extensions), from the pinned team, with Helium's own identifier.
fn requirement() -> String {
    format!(
        "=anchor apple generic and identifier \"{IDENTIFIER}\" \
         and certificate 1[field.1.2.840.113635.100.6.2.6] exists \
         and certificate leaf[field.1.2.840.113635.100.6.1.13] exists \
         and certificate leaf[subject.OU] = \"{TEAM}\""
    )
}

/// The disk image with the release's own digest, downloaded unless the cache already has it.
pub fn fetch(
    tools: &dyn Tools,
    release: &Release,
    cache: &Path,
    progress: &Progress,
) -> Result<PathBuf, Refused> {
    progress.begin(Step::Download)?;
    let dmg = cache.join(&release.name);
    if digest(&dmg).is_ok_and(|d| d == release.sha256) {
        progress.end(Some("kept from before"));
        return Ok(dmg);
    }
    let part = cache.join(format!("{}.part", release.name));
    let _ = fs::remove_file(&part);
    let call = curl(1800, &[&"--output", &part, &"--", &release.url]);
    progress.flowing();
    let done = AtomicBool::new(false);
    let ran = thread::scope(|scope| {
        // Reads how much of the file is there while curl writes it.
        scope.spawn(|| {
            while !done.load(Ordering::SeqCst) {
                let got = fs::metadata(&part).map_or(0, |m| m.len());
                progress.bytes(got, release.size);
                thread::sleep(Duration::from_millis(100));
            }
        });
        let ran = must(tools, "download", &call);
        done.store(true, Ordering::SeqCst);
        ran
    });
    ran?;
    let got = fs::metadata(&part).map_or(0, |m| m.len());
    progress.bytes(got, release.size);
    let got_digest = digest(&part).map_err(refuse("digest", "reading the download"))?;
    if got_digest != release.sha256 {
        let _ = fs::remove_file(&part);
        let why = format!("{} does not match the release's sha256", release.name);
        return Err(Refused::new("digest", why));
    }
    fs::rename(&part, &dmg).map_err(refuse("download", "keeping it"))?;
    progress.end(Some(&progress::size(got)));
    // Images of older releases, and halves of them.
    for other in fs::read_dir(cache).into_iter().flatten().flatten() {
        let name = other.file_name().to_string_lossy().into_owned();
        let image = name.starts_with("helium_") && name.contains(".dmg");
        if image && name != release.name {
            let _ = fs::remove_file(other.path());
        }
    }
    Ok(dmg)
}

fn digest(path: &Path) -> io::Result<String> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(io::Error::other("not a plain file"));
    }
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            return Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect());
        }
        hash.update(&buffer[..n]);
    }
}

/// A mounted disk image, unmounted when it goes out of scope.
struct Mounted<'a> {
    tools: &'a dyn Tools,
    at: PathBuf,
}

impl Drop for Mounted<'_> {
    fn drop(&mut self) {
        let detach = Call::new("/usr/bin/hdiutil", &[&"detach", &self.at]).cleanup();
        if !self.tools.run(&detach).is_ok_and(|r| r.ok()) {
            let force = Call::new("/usr/bin/hdiutil", &[&"detach", &"-force", &self.at]).cleanup();
            let _ = self.tools.run(&force);
        }
    }
}

/// Lets go of an image that an interrupted run left attached.
pub fn let_go(tools: &dyn Tools, work: &Path) {
    let at = work.join(MOUNT);
    if fs::symlink_metadata(&at).is_ok() {
        // Where it isn't attached this fails, and the folder is an ordinary one.
        let force = Call::new("/usr/bin/hdiutil", &[&"detach", &"-force", &at]).cleanup();
        let _ = tools.run(&force);
    }
}

/// Copies the app out of the image, mounted read-only and out of sight, and checks the copy. The copy is what gets
/// used, so it is what gets checked.
pub fn unpack(
    tools: &dyn Tools,
    dmg: &Path,
    work: &Path,
    version: &str,
) -> Result<PathBuf, Refused> {
    let app = work.join(APP);
    {
        let at = work.join(MOUNT);
        fs::create_dir(&at).map_err(refuse("disk image", "making a mount point"))?;
        // Made first, so an image attached by a call that then failed is let go as well.
        let mounted = Mounted { tools, at };
        let mut attach = Call::new("/usr/bin/hdiutil", &[]);
        let options = "attach -readonly -nobrowse -noautoopen -mountpoint";
        attach.args = options.split(' ').map(Into::into).collect();
        attach.args.extend([mounted.at.as_os_str().to_owned()]);
        attach.args.push(dmg.into());
        must(tools, "disk image", &attach)?;
        let inside = mounted.at.join(APP);
        if !fs::symlink_metadata(&inside).is_ok_and(|m| m.is_dir()) {
            return Err(Refused::new("disk image", format!("it holds no {APP}")));
        }
        // Without Finder's attributes: on some macOS versions the image shows one on every file, and a strict
        // signature check refuses those.
        let mut ditto = Call::new("/usr/bin/ditto", &[]);
        let options = "--norsrc --noextattr --noacl --noqtn";
        ditto.args = options.split(' ').map(Into::into).collect();
        ditto.args.extend([inside.into(), app.clone().into()]);
        must(tools, "copy", &ditto)?;
    }
    verify(tools, &app, version)?;
    Ok(app)
}

/// The checks nothing is changed or run before. Each must say yes; one that can't run says no.
pub fn verify(tools: &dyn Tools, app: &Path, version: &str) -> Result<(), Refused> {
    let codesign = "/usr/bin/codesign";
    let signature = Call::new(codesign, &[&"--verify", &"--deep", &"--strict", &app]);
    must(tools, "code signature", &signature)?;
    let team = Call::new(codesign, &[&"--verify", &"-R", &requirement(), &app]);
    must(tools, "Team ID", &team).map_err(|e| {
        let why = format!("not signed by team {TEAM} as {IDENTIFIER} ({})", e.why);
        Refused::new("Team ID", why)
    })?;
    let assess = Call::new("/usr/sbin/spctl", &[&"-a", &"-t", &"exec", &"-vv", &app]);
    let said = must(tools, "Gatekeeper", &assess)?;
    let said = format!("{}\n{}", said.out, said.err);
    // Gatekeeper turned off accepts anything, and says so with an override line.
    if !said.contains("source=Notarized Developer ID") || said.contains("override=") {
        let why = "it did not say the app is notarized";
        return Err(Refused::new("Gatekeeper", why));
    }
    let found = plist_string(tools, app, "CFBundleShortVersionString")?;
    if found != version {
        let why = format!("the release says {version} and the app says {found}");
        return Err(Refused::new("version", why));
    }
    Ok(())
}

fn plist_string(tools: &dyn Tools, app: &Path, key: &str) -> Result<String, Refused> {
    let info = app.join("Contents/Info.plist");
    let args: [&dyn AsRef<OsStr>; 6] = [&"-extract", &key, &"raw", &"-o", &"-", &info];
    let ran = must(tools, "version", &Call::new("/usr/bin/plutil", &args))?;
    Ok(ran.out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::super::release::newest;
    use super::super::testing::*;
    use super::super::tools::System;
    use super::*;

    fn fetched(t: &Fake) -> Result<(Release, PathBuf), Refused> {
        t.place().prepare().unwrap();
        let release = newest(t, "arm64")?;
        let dmg = fetch(t, &release, &t.place().cache, &Progress::silent())?;
        Ok((release, dmg))
    }

    fn unpacked(t: &Fake) -> Result<PathBuf, Refused> {
        let (release, dmg) = fetched(t)?;
        let work = t.place().work(t).unwrap();
        unpack(t, &dmg, &work, &release.version)
    }

    #[test]
    fn a_good_release_is_fetched_copied_out_and_checked() {
        let t = Fake::new();
        let app = unpacked(&t).unwrap();
        assert!(app.join("Contents/MacOS/Helium").is_file());
        assert!(!t.mounted());
        let calls = t.calls();
        let at = |part: &str| calls.iter().position(|c| c.contains(part)).expect(part);
        assert!(at("attach -readonly -nobrowse -noautoopen") < at("ditto"));
        assert!(at("ditto") < at("codesign --verify --deep --strict"));
        at("subject.OU] = \"S4Q33XPHB4\"");
        let mut curls = calls.iter().filter(|c| c.starts_with("curl"));
        let https = "--proto =https --proto-redir =https";
        assert!(curls.all(|c| c.starts_with("curl -q ") && c.contains(https)));
        // The copy is what is checked, not the image it came from.
        let checks = ["codesign", "spctl", "plutil"];
        for call in calls
            .iter()
            .filter(|c| checks.iter().any(|k| c.starts_with(k)))
        {
            assert!(call.contains("work/Helium.app"), "{call}");
            assert!(!call.contains("work/mount"), "{call}");
        }
    }

    #[test]
    fn a_download_whose_digest_is_wrong_is_refused_and_deleted() {
        let t = Fake::new();
        t.set(|s| s.digest = Some("00".repeat(32)));
        assert_eq!(fetched(&t).unwrap_err().check, "digest");
        let left = fs::read_dir(t.place().cache).unwrap().count();
        assert_eq!(left, 0, "a refused download was kept");
        assert!(t.calls().iter().all(|c| !c.contains("hdiutil")));
    }

    #[test]
    fn a_cached_image_is_used_only_while_its_digest_matches() {
        let t = Fake::new();
        let (release, dmg) = fetched(&t).unwrap();
        let downloads = || t.calls().iter().filter(|c| c.contains("--output")).count();
        fetch(&t, &release, &t.place().cache, &Progress::silent()).unwrap();
        assert_eq!(downloads(), 1);
        fs::write(&dmg, "changed after it was downloaded").unwrap();
        fetch(&t, &release, &t.place().cache, &Progress::silent()).unwrap();
        assert_eq!(downloads(), 2);
    }

    /// Each check alone stops it, whether it says no or can't run, and says which check it was.
    #[test]
    fn each_check_refuses_by_itself() {
        for (tool, part, check) in [
            ("curl", "api.github.com", "release"),
            ("curl", "--output", "download"),
            ("hdiutil", "attach", "disk image"),
            ("ditto", "", "copy"),
            ("codesign", "--deep", "code signature"),
            ("codesign", "-R", "Team ID"),
            ("spctl", "", "Gatekeeper"),
            ("plutil", "", "version"),
        ] {
            for failure in [Failure::SaysNo, Failure::CannotRun] {
                let t = Fake::new();
                t.set(|s| s.fail = Some((tool, part, failure)));
                let e = unpacked(&t).expect_err(check);
                assert_eq!(e.check, check, "{tool} {part} {failure:?}");
                assert!(!t.mounted(), "{check} left the image mounted");
            }
        }
    }

    #[test]
    fn a_busy_image_is_let_go_by_force() {
        for failure in [Failure::SaysNo, Failure::CannotRun] {
            let t = Fake::new();
            t.set(|s| s.fail = Some(("hdiutil", "detach /", failure)));
            unpacked(&t).unwrap();
            assert!(!t.mounted());
            assert!(t.calls().iter().any(|c| c.contains("detach -force")));
        }
    }

    /// Killed, a run leaves the image attached, and nothing in it can be removed.
    #[test]
    fn an_image_an_interrupted_run_left_is_let_go_before_its_folder_is_cleared() {
        let t = Fake::new();
        t.place().prepare().unwrap();
        let work = t.place().work(&t).unwrap();
        assert!(t.calls().is_empty(), "nothing was left to let go of");
        fs::create_dir(work.join("mount")).unwrap();
        t.place().work(&t).unwrap();
        let mount = work.join("mount");
        assert_eq!(
            t.calls(),
            [format!("hdiutil detach -force {}", mount.display())]
        );
        assert!(!mount.exists());
    }

    #[test]
    fn images_of_older_releases_are_not_kept() {
        let t = Fake::new();
        let cache = t.place().cache;
        fs::create_dir_all(&cache).unwrap();
        for old in [
            "helium_0.1.0.0_arm64-macos.dmg",
            "helium_0.1.0.0_arm64-macos.dmg.part",
            "lock",
        ] {
            fs::write(cache.join(old), "x").unwrap();
        }
        let (_, dmg) = fetched(&t).unwrap();
        let mut left: Vec<_> = fs::read_dir(&cache)
            .unwrap()
            .map(|f| f.unwrap().path())
            .collect();
        left.sort();
        assert_eq!(left, [dmg, cache.join("lock")]);
    }

    #[test]
    fn gatekeeper_turned_off_is_not_a_yes() {
        for said in [
            "x: accepted\nsource=Notarized Developer ID\noverride=security disabled",
            "x: accepted",
        ] {
            let t = Fake::new();
            t.set(|s| s.gatekeeper = said);
            assert_eq!(unpacked(&t).unwrap_err().check, "Gatekeeper");
        }
    }

    #[test]
    fn an_app_of_another_version_or_a_link_in_its_place_is_refused() {
        let t = Fake::new();
        t.set(|s| s.version_inside = "0.1.0.0");
        assert_eq!(unpacked(&t).unwrap_err().check, "version");
        let t = Fake::new();
        t.set(|s| s.app_is_a_link = true);
        assert_eq!(unpacked(&t).unwrap_err().check, "disk image");
    }

    /// The real `codesign`, offline: an app this Mac signed itself passes the signature check and fails the team's,
    /// and one changed after signing fails the signature check.
    #[test]
    fn the_real_codesign_refuses_another_signer_and_a_tampered_app() {
        let t = Fake::new();
        let app = t.fixture_app();
        let sign = Call::new(
            "/usr/bin/codesign",
            &[&"--force", &"--deep", &"--sign", &"-", &app],
        );
        must(&System, "sign", &sign).unwrap();
        let check = |app: &Path| verify(&System, app, VERSION).unwrap_err().check;
        assert_eq!(check(&app), "Team ID");
        fs::write(app.join("Contents/Resources/page.txt"), "tampered").unwrap();
        assert_eq!(check(&app), "code signature");
    }
}
