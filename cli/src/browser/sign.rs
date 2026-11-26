//! Signs the changed app, inside out, with the same local identity Polycarp itself is signed with.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use super::change::{plist_string, plutil, Changes};
use super::tools::{must, Call, Tools};
use super::{refuse, Refused};

const CHECK: &str = "signing";
const CODESIGN: &str = "/usr/bin/codesign";

/// What upstream's code may keep. Any other entitlement, Apple's restricted ones first, is dropped: they are granted
/// to Helium's own team, and macOS refuses to start an app that claims one it was not granted.
const KEPT: [&str; 9] = [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.device.audio-input",
    "com.apple.security.device.bluetooth",
    "com.apple.security.device.camera",
    "com.apple.security.device.print",
    "com.apple.security.device.usb",
    "com.apple.security.personal-information.location",
    "com.apple.security.personal-information.photos-library",
];
/// A local identity has no Team ID, so the hardened runtime would refuse to load the app's own framework without it.
const OWN_LIBRARIES: &str = "com.apple.security.cs.disable-library-validation";

#[derive(Debug, PartialEq)]
pub struct Identity {
    name: String,
    keychain: Option<PathBuf>,
}

impl Identity {
    pub fn ad_hoc() -> Identity {
        Identity {
            name: "-".into(),
            keychain: None,
        }
    }

    /// The identity Polycarp is signed with. Without one, ad hoc and the line to print. One that exists but can't be
    /// used now stops the build, so a passing keychain fault never changes the app's signature.
    pub fn find(
        tools: &dyn Tools,
        parts: &Path,
    ) -> Result<(Identity, Option<&'static str>), Refused> {
        let none = Ok((Identity::ad_hoc(), Some(AD_HOC)));
        let script = parts.join("signing-identity.sh");
        if !script.is_file() {
            return none;
        }
        let ran = tools
            .run(&Call::new("/bin/bash", &[&script, &"--keep"]))
            .map_err(refuse(CHECK, "running signing-identity.sh"))?;
        match ran.code {
            Some(0) => {
                let found = ran.out.trim_end().split_once('\t').and_then(|(name, keychain)| {
                    let keychain = PathBuf::from(keychain);
                    let usable = !name.is_empty() && name != "-" && keychain.is_absolute();
                    usable.then(|| Identity {
                        name: name.into(),
                        keychain: Some(keychain),
                    })
                });
                let why = || Refused::new(CHECK, "signing-identity.sh named no usable identity");
                Ok((found.ok_or_else(why)?, None))
            }
            Some(3) => none,
            _ => Err(Refused::new(
                CHECK,
                format!(
                    "Polycarp's signing key can't be used now, so nothing was built and the browser was left alone: {}",
                    ran.err.trim().lines().last().unwrap_or("signing-identity.sh failed")
                ),
            )),
        }
    }

    /// Asks for the identity again just before signing. Unpacking and changing the app can outlast the 5 minutes the
    /// key stays unlocked, or the Mac can sleep, and the script unlocks it. A different answer stops the build.
    pub fn again(&self, tools: &dyn Tools, parts: &Path) -> Result<(), Refused> {
        if Identity::find(tools, parts)?.0 == *self {
            return Ok(());
        }
        let why = "Polycarp's signing key changed while the browser was being built, so nothing was built and the browser was left alone";
        Err(Refused::new(CHECK, why))
    }
}

const AD_HOC: &str = "Polycarp's signing identity was not found, so this build is signed ad hoc: macOS will ask for its permissions and saved passwords again after each update.";

/// One piece of code to sign.
#[derive(Debug)]
struct Code {
    path: PathBuf,
    identifier: String,
    /// It can be run, so it needs its own entitlements.
    runs: bool,
}

/// Mach-O's file type, in the first of its processors: 2 is a program.
fn mach_type(path: &Path) -> Option<u32> {
    let mut head = [0u8; 4096];
    let n = File::open(path).ok()?.read(&mut head).ok()?;
    let head = &head[..n];
    let big = |at: usize| Some(u32::from_be_bytes(head.get(at..at + 4)?.try_into().ok()?));
    let little = |at: usize| Some(u32::from_le_bytes(head.get(at..at + 4)?.try_into().ok()?));
    match big(0)? {
        0xcffa_edfe => little(12),
        0xcafe_babe => {
            let mut inner = File::open(path).ok()?;
            let at = u64::from(big(16)?);
            std::io::Seek::seek(&mut inner, std::io::SeekFrom::Start(at)).ok()?;
            let mut head = [0u8; 16];
            inner.read_exact(&mut head).ok()?;
            let is_mach = head[..4] == [0xcf, 0xfa, 0xed, 0xfe];
            is_mach.then(|| u32::from_le_bytes([head[12], head[13], head[14], head[15]]))
        }
        _ => None,
    }
}

/// Everything in the app that carries a signature, what is inside first. `code` gets what was found.
fn gather(
    tools: &dyn Tools,
    dir: &Path,
    changes: &Changes,
    code: &mut Vec<Code>,
) -> Result<(), Refused> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(refuse(CHECK, "listing its code"))? {
        entries.push(entry.map_err(refuse(CHECK, "listing its code"))?);
    }
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(refuse(CHECK, "listing its code"))?;
        if kind.is_file() {
            if let Some(mach) = mach_type(&path) {
                let stem = path.file_stem().unwrap_or_default().to_string_lossy();
                let identifier = format!("{}.{stem}", changes.to.identifier);
                let runs = mach == 2;
                code.push(Code {
                    path,
                    identifier,
                    runs,
                });
            }
            continue;
        }
        if !kind.is_dir() || entry.file_name() == "_CodeSignature" {
            continue;
        }
        gather(tools, &path, changes, code)?;
        let extension = path.extension().and_then(|e| e.to_str());
        let plist = match extension {
            Some("app" | "xpc" | "bundle" | "appex") => path.join("Contents/Info.plist"),
            Some("framework") => path.join("Resources/Info.plist"),
            _ => continue,
        };
        bundle(tools, path, &plist, code)?;
    }
    Ok(())
}

/// A bundle is signed as a whole, so its own main program is not signed by itself.
fn bundle(
    tools: &dyn Tools,
    path: PathBuf,
    plist: &Path,
    code: &mut Vec<Code>,
) -> Result<(), Refused> {
    let read = |key| {
        let why = || Refused::new(CHECK, format!("{} has no {key}", plist.display()));
        plist_string(tools, plist, key).ok_or_else(why)
    };
    let identifier = read("CFBundleIdentifier")?;
    // A bundle of resources alone has no program of its own, so it is signed as a whole with nothing taken out.
    let program = plist_string(tools, plist, "CFBundleExecutable").unwrap_or_default();
    let mut runs = false;
    code.retain(|c| {
        let of_this = c.path.starts_with(&path) && c.path.file_name() == Some(program.as_ref());
        let inner = c.path.strip_prefix(&path).unwrap_or(&c.path);
        let main = of_this
            && (inner.starts_with("Contents/MacOS") && inner.components().count() == 3
                || inner.starts_with("Versions") && inner.components().count() == 3);
        runs |= main && c.runs;
        !main
    });
    code.push(Code {
        path,
        identifier,
        runs,
    });
    Ok(())
}

/// The entitlements a program keeps, as a property list.
fn entitlements(tools: &dyn Tools, path: &Path, work: &Path) -> Result<PathBuf, Refused> {
    let args: [&dyn AsRef<std::ffi::OsStr>; 5] = [&"-d", &"--entitlements", &"-", &"--xml", &path];
    let has = must(tools, CHECK, &Call::new(CODESIGN, &args))?.out;
    let mut keep = vec![OWN_LIBRARIES];
    if !has.trim().is_empty() {
        let from = work.join("entitlements.in");
        fs::write(&from, has).map_err(refuse(CHECK, "reading its entitlements"))?;
        let json = plutil(tools, &from, &["-convert", "json", "-o", "-"])?;
        let json: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| Refused::new(CHECK, format!("reading its entitlements: {e}")))?;
        keep.extend(KEPT.into_iter().filter(|k| json[*k] == true));
    }
    let mut text =
        String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n");
    for key in keep {
        text += &format!("<key>{key}</key><true/>\n");
    }
    let to = work.join("entitlements.plist");
    fs::write(&to, text + "</dict></plist>\n").map_err(refuse(CHECK, "writing entitlements"))?;
    Ok(to)
}

/// Signs every piece of the app and checks the whole.
pub fn sign(
    tools: &dyn Tools,
    app: &Path,
    work: &Path,
    identity: &Identity,
    changes: &Changes,
) -> Result<(), Refused> {
    let mut code = Vec::new();
    gather(tools, &app.join("Contents"), changes, &mut code)?;
    bundle(
        tools,
        app.into(),
        &app.join("Contents/Info.plist"),
        &mut code,
    )?;
    // Helium's own program, when the app starts through another one: macOS judges the running program by it.
    let helium = app.join("Contents/MacOS").join(&changes.from.name);
    for piece in &mut code {
        if piece.path == helium {
            piece.identifier.clone_from(&changes.to.identifier);
        }
    }
    for piece in &code {
        let mut call = Call::new(CODESIGN, &[&"--force", &"--sign", &identity.name]);
        if let Some(keychain) = &identity.keychain {
            call.args.extend(["--keychain".into(), keychain.into()]);
        }
        let options = "--options runtime --timestamp=none --identifier";
        call.args.extend(options.split(' ').map(Into::into));
        call.args.push(piece.identifier.clone().into());
        if piece.runs {
            let of = if piece.path == app {
                &helium
            } else {
                &piece.path
            };
            let file = entitlements(tools, of, work)?;
            call.args.extend(["--entitlements".into(), file.into()]);
        }
        call.args.push(piece.path.clone().into());
        must(tools, CHECK, &call)?;
    }
    let whole = Call::new(CODESIGN, &[&"--verify", &"--deep", &"--strict", &app]);
    must(tools, CHECK, &whole)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::change;
    use super::super::testing::*;
    use super::super::tools::System;
    use super::*;

    struct Built {
        t: Fake,
        app: PathBuf,
    }

    /// A made-up app, changed, with entitlements signed in as upstream's are, then signed again ad hoc.
    fn built() -> Built {
        let t = Fake::new();
        let app = t.fixture_app();
        let parts = t.parts();
        let changes = Changes::read(&parts).unwrap();
        let claims = t.file(
            "claims.plist",
            "<plist version=\"1.0\"><dict>\
             <key>com.apple.security.device.camera</key><true/>\
             <key>com.apple.security.get-task-allow</key><true/>\
             <key>com.apple.security.cs.allow-jit</key><false/>\
             <key>keychain-access-groups</key><array><string>S4Q33XPHB4.*</string></array>\
             <key>com.apple.developer.web-browser.public-key-credential</key><true/></dict></plist>",
        );
        let program = app.join("Contents/MacOS/Helium");
        let args: [&dyn AsRef<std::ffi::OsStr>; 6] = [
            &"--force",
            &"--sign",
            &"-",
            &"--entitlements",
            &claims,
            &program,
        ];
        must(&System, CHECK, &Call::new(CODESIGN, &args)).unwrap();
        change::apply(&System, &app, &parts, &changes).unwrap();
        // As in the finished app, another program starts Helium's, which is beside it.
        fs::copy("/usr/bin/true", app.join("Contents/MacOS/Polycarp Browser")).unwrap();
        let set = [
            "-replace",
            "CFBundleExecutable",
            "-string",
            "Polycarp Browser",
        ];
        plutil(&System, &app.join("Contents/Info.plist"), &set).unwrap();
        sign(&System, &app, &t.work(), &Identity::ad_hoc(), &changes).unwrap();
        Built { t, app }
    }

    fn shown(path: &Path, what: &[&str]) -> String {
        let mut call = Call::new(CODESIGN, &[]);
        call.args = what.iter().map(Into::into).collect();
        call.args.push(path.into());
        let ran = must(&System, CHECK, &call).unwrap();
        ran.out + &ran.err
    }

    #[test]
    fn every_piece_is_signed_with_its_own_identifier_and_the_hardened_runtime() {
        let b = built();
        let framework = b.app.join(FRAMEWORK);
        for (path, identifier) in [
            (b.app.clone(), "com.baney.polycarp.browser"),
            (
                b.app.join("Contents/MacOS/Helium"),
                "com.baney.polycarp.browser",
            ),
            (
                framework.join("Helpers/Helium Helper (Alerts).app"),
                "com.baney.polycarp.browser.framework.AlertNotificationService",
            ),
            (
                framework.join("Helpers/chrome_crashpad_handler"),
                "com.baney.polycarp.browser.chrome_crashpad_handler",
            ),
            (
                framework.join("Frameworks/Sparkle.framework"),
                "org.sparkle-project.Sparkle",
            ),
        ] {
            let said = shown(&path, &["-d", "-vv"]);
            assert!(
                said.contains(&format!("Identifier={identifier}\n")),
                "{said}"
            );
            assert!(said.contains("runtime"), "{said}");
        }
    }

    #[test]
    fn only_listed_entitlements_are_kept() {
        let b = built();
        for program in ["Polycarp Browser", "Helium"] {
            let program = b.app.join("Contents/MacOS").join(program);
            let said = shown(&program, &["-d", "--entitlements", "-", "--xml"]);
            assert!(said.contains("com.apple.security.device.camera"), "{said}");
            assert!(said.contains(OWN_LIBRARIES), "{said}");
            for gone in [
                "get-task-allow",
                "keychain-access-groups",
                "developer",
                "allow-jit",
            ] {
                assert!(!said.contains(gone), "{gone}: {said}");
            }
        }
    }

    #[test]
    fn a_bundle_of_resources_alone_is_signed_as_a_whole() {
        let b = built();
        let inner = b.app.join("Contents/Resources/words.bundle/Contents");
        fs::create_dir_all(inner.join("Resources")).unwrap();
        fs::write(inner.join("Resources/words.txt"), "made up").unwrap();
        fs::write(
            inner.join("Info.plist"),
            "<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>test.words</string></dict></plist>",
        )
        .unwrap();
        let changes = Changes::read(&b.t.parts()).unwrap();
        sign(&System, &b.app, &b.t.work(), &Identity::ad_hoc(), &changes).unwrap();
        let said = shown(
            &b.app.join("Contents/Resources/words.bundle"),
            &["-d", "-vv"],
        );
        assert!(said.contains("Identifier=test.words\n"), "{said}");
    }

    #[test]
    fn a_tool_that_fails_stops_the_signing() {
        let b = built();
        let changes = Changes::read(&b.t.parts()).unwrap();
        for part in ["--sign", "--verify", "--entitlements - --xml"] {
            for failure in [Failure::SaysNo, Failure::CannotRun] {
                b.t.set(|s| {
                    s.fail = Some(("codesign", part, failure));
                    s.real = true;
                });
                let e = sign(&b.t, &b.app, &b.t.work(), &Identity::ad_hoc(), &changes);
                assert_eq!(e.expect_err(part).check, "signing");
            }
        }
    }

    #[test]
    fn the_identity_is_polycarps_or_ad_hoc_with_a_note_or_the_build_stops() {
        let t = Fake::new();
        t.set(|s| s.identity = "Polycarp Local Signing\t/keys/polycarp.keychain-db\n");
        let (found, note) = Identity::find(&t, &t.parts()).unwrap();
        assert_eq!(found.name, "Polycarp Local Signing");
        assert_eq!(found.keychain, Some("/keys/polycarp.keychain-db".into()));
        assert_eq!(note, None);
        t.set(|s| s.identity = "");
        let (found, note) = Identity::find(&t, &t.parts()).unwrap();
        assert_eq!(found, Identity::ad_hoc());
        assert!(note.unwrap().contains("ad hoc"));
        let parts = t.parts();
        fs::remove_file(parts.join("signing-identity.sh")).unwrap();
        assert_eq!(Identity::find(&t, &parts).unwrap().0, Identity::ad_hoc());
        for bad in ["no tab", "-\t/keys/k", "name\trelative"] {
            t.set(|s| s.identity = bad);
            assert_eq!(
                Identity::find(&t, &t.parts()).unwrap_err().check,
                CHECK,
                "{bad:?}"
            );
        }
        // A key that exists but can't be used now never falls back to ad hoc.
        t.set(|s| s.fail = Some(("bash", "", Failure::SaysNo)));
        let refused = Identity::find(&t, &t.parts()).unwrap_err();
        assert!(refused.to_string().contains("left alone"), "{refused}");
        t.set(|s| s.fail = Some(("bash", "", Failure::CannotRun)));
        assert!(Identity::find(&t, &t.parts()).is_err());
    }

    #[test]
    fn the_identity_is_asked_for_again_before_signing_and_must_not_change() {
        let t = Fake::new();
        t.set(|s| s.identity = "Polycarp Local Signing\t/keys/polycarp.keychain-db\n");
        let (found, _) = Identity::find(&t, &t.parts()).unwrap();
        found.again(&t, &t.parts()).unwrap();
        t.set(|s| s.identity = "");
        assert!(found
            .again(&t, &t.parts())
            .unwrap_err()
            .to_string()
            .contains("changed"));
        t.set(|s| s.fail = Some(("bash", "", Failure::SaysNo)));
        assert!(Identity::ad_hoc().again(&t, &t.parts()).is_err());
    }

    /// Two builds that differ have one designated requirement, so macOS and the Keychain see one app. It needs a
    /// certificate, so it makes a throwaway keychain, which only CI does.
    #[test]
    #[ignore = "makes a throwaway keychain; CI runs it"]
    fn two_builds_have_the_same_designated_requirement() {
        let t = Fake::new();
        let identity = t.throwaway_identity();
        let mut seen = Vec::new();
        for page in ["one", "two"] {
            let b = built();
            fs::write(b.app.join("Contents/Resources/page.txt"), page).unwrap();
            let changes = Changes::read(&b.t.parts()).unwrap();
            let identity = Identity {
                name: identity.0.clone(),
                keychain: Some(identity.1.clone()),
            };
            sign(&System, &b.app, &b.t.work(), &identity, &changes).unwrap();
            seen.push((
                shown(&b.app, &["-d", "-r-"]),
                shown(&b.app, &["-d", "-vvv"]),
            ));
        }
        let rule = |s: &str| {
            s.lines()
                .find(|l| l.contains("designated"))
                .unwrap()
                .to_string()
        };
        assert_eq!(rule(&seen[0].0), rule(&seen[1].0));
        assert!(rule(&seen[0].0).contains("certificate"), "{}", seen[0].0);
        assert!(rule(&seen[0].0).contains("identifier \"com.baney.polycarp.browser\""));
        let hash = |s: &str| {
            s.lines()
                .find(|l| l.starts_with("CDHash="))
                .unwrap()
                .to_string()
        };
        assert_ne!(
            hash(&seen[0].1),
            hash(&seen[1].1),
            "the two builds are the same"
        );
    }
}
