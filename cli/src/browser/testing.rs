//! A fake release, a made-up app and fake tools, so every test runs offline and touches nothing of the person's.

use std::cell::{Cell, RefCell};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::pak;
use super::spot::{Built, Spot};
use super::tools::{Call, Ran, System, Tools};
use super::Place;

pub const VERSION: &str = "0.22.4.1";
pub const FRAMEWORK: &str = "Contents/Frameworks/Helium Framework.framework/Versions/158.0";
/// `{ CFBundleDisplayName = "Helium"; }` as a binary property list.
const BINARY_STRINGS: &[u8] = b"bplist00\xd1\x01\x02_\x10\x13CFBundleDisplayNameVHelium\x08\x0b!\x00\x00\x00\x00\x00\x00\x01\x01\x00\x00\x00\x00\x00\x00\x00\x03\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00(";
const IMAGE: &str = "a made-up disk image";

#[derive(Clone, Copy, Debug)]
pub enum Failure {
    SaysNo,
    CannotRun,
    /// Ctrl-C came while it ran.
    Stopped,
}

pub struct Scene {
    /// The digest the release lists; None is the right one.
    pub digest: Option<String>,
    /// The tool, a part of its arguments, and how it fails.
    pub fail: Option<(&'static str, &'static str, Failure)>,
    pub gatekeeper: &'static str,
    pub version_inside: &'static str,
    pub app_is_a_link: bool,
    /// What signing-identity.sh prints; empty when there is no key.
    pub identity: &'static str,
    /// What the headless start shows.
    pub page: &'static str,
    /// Run the real tool for anything that isn't made to fail.
    pub real: bool,
}

pub struct Fake {
    root: PathBuf,
    scene: RefCell<Scene>,
    calls: RefCell<Vec<String>>,
    mounted: Cell<bool>,
}

impl Fake {
    pub fn new() -> Fake {
        let mut random = [0u8; 8];
        getrandom::getrandom(&mut random).unwrap();
        let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let root = std::env::temp_dir().join(format!("polycarp-browser-{name}"));
        fs::create_dir_all(&root).unwrap();
        Fake {
            root,
            scene: RefCell::new(Scene {
                digest: None,
                fail: None,
                gatekeeper: "x: accepted\nsource=Notarized Developer ID",
                version_inside: VERSION,
                app_is_a_link: false,
                identity: "",
                page: "<input placeholder=\"Search or type an address\">",
                real: false,
            }),
            calls: RefCell::default(),
            mounted: Cell::default(),
        }
    }

    pub fn set(&self, change: impl FnOnce(&mut Scene)) {
        change(&mut self.scene.borrow_mut());
    }

    pub fn spot(&self) -> Spot {
        Spot {
            folder: self.root.join("Applications"),
        }
    }

    pub fn place(&self) -> Place {
        Place {
            cache: self.root.join("cache"),
            parts: self.parts(),
            extension: self.extension(),
            spot: self.spot(),
            data: self.root.join("Support/Polycarp/Browser"),
            home: self.root.join("home"),
            page_cache: self.root.join("Caches/Polycarp/Browser"),
            host: Some("/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces".into()),
        }
    }

    /// Every file under `dir`, with what is in it.
    pub fn listing(&self, dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let files = super::change::files(dir).unwrap();
        let mut all: Vec<_> = files
            .into_iter()
            .map(|f| (f.clone(), fs::read(f).unwrap()))
            .collect();
        all.sort();
        all
    }

    /// A folder that says it is a build, and no more.
    pub fn built_app(&self, at: &Path, version: &str, built: u64) {
        fs::create_dir_all(at.join("Contents/Resources/polycarp")).unwrap();
        fs::create_dir_all(at.join("Contents/MacOS")).unwrap();
        let built = Built {
            helium: version.into(),
            published: Some(20_000),
            built,
            parts: String::new(),
            certificate: false,
        };
        built.write(at).unwrap();
    }

    /// A program that stays running from inside `app`.
    pub fn start_inside(&self, app: &Path) -> std::process::Child {
        // This test program itself, plain arm64: a copy of a system tool is arm64e, which macOS 15 stops soon after
        // it starts when someone other than Apple signed it.
        let copy = app.join("Contents/MacOS/sleeper");
        fs::copy(std::env::current_exe().unwrap(), &copy).unwrap();
        let mut sleeper = std::process::Command::new(&copy);
        sleeper.args([
            "--exact",
            "browser::testing::sleeps_when_asked",
            "--test-threads=1",
        ]);
        sleeper.env(SLEEP, "60").stdout(std::process::Stdio::null());
        sleeper.spawn().unwrap()
    }

    /// Every call so far, as `program arguments`.
    pub fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }

    pub fn mounted(&self) -> bool {
        self.mounted.get()
    }

    /// What ships beside the command: the repo's own changes.toml, made-up icons and a stand-in signing script.
    pub fn parts(&self) -> PathBuf {
        let parts = self.root.join("parts");
        fs::create_dir_all(&parts).unwrap();
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../browser/changes.toml");
        fs::copy(repo, parts.join("changes.toml")).unwrap();
        for icon in ["icon.icns", "icon-32.png"] {
            fs::write(parts.join(icon), icon).unwrap();
        }
        fs::write(parts.join("signing-identity.sh"), "exit 3\n").unwrap();
        fs::copy("/usr/bin/true", parts.join("launcher")).unwrap();
        parts
    }

    pub fn extension(&self) -> PathBuf {
        let extension = self.root.join("extension");
        fs::create_dir_all(extension.join("newtab")).unwrap();
        for file in ["manifest.json", "newtab/newtab.html"] {
            fs::write(extension.join(file), "{}").unwrap();
        }
        extension
    }

    pub fn work(&self) -> PathBuf {
        let work = self.root.join("work");
        fs::create_dir_all(&work).unwrap();
        work
    }

    pub fn file(&self, name: &str, text: &str) -> PathBuf {
        let path = self.root.join(name);
        fs::write(&path, text).unwrap();
        path
    }

    /// A self-signed code signing certificate in a keychain of its own, put on the user's keychain list. Only for CI.
    pub fn throwaway_identity(&self) -> (String, PathBuf) {
        assert_eq!(
            std::env::var("CI").as_deref(),
            Ok("true"),
            "only CI makes a keychain"
        );
        let name = "Polycarp Browser Test";
        let keychain = self.root.join("test.keychain-db");
        let config = format!(
            "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN={name}\n[ext]\n\
             basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\n\
             extendedKeyUsage=critical,codeSigning\n"
        );
        let config = self.file("req.cfg", &config);
        let (key, cert) = (self.root.join("key.pem"), self.root.join("cert.pem"));
        let p12 = self.root.join("id.p12");
        let (openssl, security) = ("/usr/bin/openssl", "/usr/bin/security");
        let run = |program: &str, words: &str, paths: &[&Path]| {
            let mut paths = paths.iter();
            let mut call = Call::new(program, &[]);
            for word in words.split(' ') {
                call.args.push(match word {
                    "@" => paths.next().unwrap().as_os_str().to_owned(),
                    word => word.into(),
                });
            }
            let ran = System.run(&call).unwrap();
            assert!(ran.ok(), "{program} {words}: {}", ran.last_line());
        };
        let request = "req -x509 -newkey rsa:2048 -nodes -days 2 -keyout @ -out @ -config @";
        run(openssl, request, &[&key, &cert, &config]);
        let export = "pkcs12 -export -inkey @ -in @ -out @ -passout pass:test";
        run(openssl, export, &[&key, &cert, &p12]);
        run(security, "create-keychain -p test @", &[&keychain]);
        run(security, "unlock-keychain -p test @", &[&keychain]);
        let import = "import @ -k @ -P test -T /usr/bin/codesign";
        run(security, import, &[&p12, &keychain]);
        let partitions = "set-key-partition-list -S apple-tool:,apple: -s -k test @";
        run(security, partitions, &[&keychain]);
        // codesign finds the key only on the search list, even when it is told the keychain, as in ci-signing.sh.
        let listed = System
            .run(&Call::new(security, &[&"list-keychains", &"-d", &"user"]))
            .unwrap()
            .out;
        let mut call = Call::new(
            security,
            &[&"list-keychains", &"-d", &"user", &"-s", &keychain],
        );
        call.args
            .extend(listed.lines().map(|l| l.trim().trim_matches('"').into()));
        assert!(System.run(&call).unwrap().ok(), "list-keychains");
        let find = Call::new(
            security,
            &[&"find-identity", &"-p", &"codesigning", &keychain],
        );
        let found = System.run(&find).unwrap();
        assert!(found.out.contains(name), "{}{}", found.out, found.err);
        (name.into(), keychain)
    }

    /// A small real app bundle, signed by nobody.
    pub fn fixture_app(&self) -> PathBuf {
        let app = self.root.join("fixture/Helium.app");
        make_app(&app);
        app
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn feed(digest: &str) -> String {
    let asset = |arch: &str| {
        let name = format!("helium_{VERSION}_{arch}-macos.dmg");
        let at = "https://github.com/imputnet/helium-macos/releases/download";
        let url = format!("{at}/{VERSION}/{name}");
        format!(
            "{{\"name\":\"{name}\",\"browser_download_url\":\"{url}\",\"digest\":\"sha256:{digest}\"}}"
        )
    };
    format!(
        "{{\"tag_name\":\"{VERSION}\",\"draft\":false,\"prerelease\":false,\"published_at\":\"2026-11-20T10:00:00Z\",\"assets\":[{},{}]}}",
        asset("arm64"),
        asset("x86_64")
    )
}

/// Upstream's layout in small: a helper, a framework with a library of its own, icons and two languages.
fn make_app(app: &Path) {
    let put = |path: &str, bytes: &[u8]| {
        let path = app.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    };
    let program = fs::read("/usr/bin/true").unwrap();
    let plist = |id: &str, name: &str, kind: &str, more: &str| {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict>\
             <key>CFBundleExecutable</key><string>{name}</string>\
             <key>CFBundleName</key><string>{name}</string>\
             <key>CFBundleIdentifier</key><string>{id}</string>\
             <key>CFBundlePackageType</key><string>{kind}</string>\
             <key>CFBundleShortVersionString</key><string>{VERSION}</string>{more}</dict></plist>"
        )
    };
    let sparkle_keys = "<key>CFBundleIconName</key><string>AppIcon</string>\
         <key>SUPublicEDKey</key><string>key</string>\
         <key>SUFeedURL</key><string>https://example.invalid</string>\
         <key>SUScheduledCheckInterval</key><integer>3600</integer>\
         <key>SUEnableAutomaticChecks</key><true/><key>SUAutomaticallyUpdate</key><true/>\
         <key>SUVerifyUpdateBeforeExtraction</key><true/>";
    let info = plist("net.imput.helium", "Helium", "APPL", sparkle_keys);
    put("Contents/Info.plist", info.as_bytes());
    put("Contents/MacOS/Helium", &program);
    put("Contents/embedded.provisionprofile", b"a grant");
    put("Contents/CodeResources", b"a ticket");
    put("Contents/Resources/page.txt", b"a page");
    put("Contents/Resources/app.icns", b"an icon");
    put("Contents/Resources/Assets.car", b"an icon");
    let manifest = "Contents/Resources/net.imput.helium.manifest/Contents/list";
    put(manifest, b"policies");
    let strings = "CFBundleGetInfoString = \"Helium 158, Copyright The Helium Authors.\";\n\
         NSCameraUsageDescription = \"Once Helium has access, websites will be able to ask.\";\n";
    put(
        "Contents/Resources/en.lproj/InfoPlist.strings",
        strings.as_bytes(),
    );
    let strings = "CFBundleGetInfoString = \"Helium 158, Copyright Die Helium-Autoren.\";\n\
         NSHumanReadableCopyright = \"Copyright Die Helium-Autoren.\";\n\
         NSCameraUsageDescription = \"Wenn Helium Zugriff hat\";\n";
    put(
        "Contents/Resources/de.lproj/InfoPlist.strings",
        strings.as_bytes(),
    );
    let strings = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n\
         \t<key>CFBundleGetInfoString</key>\n\t<string>Helium 158, Copyright Les auteurs de Helium.</string>\n\
         \t<key>NSHumanReadableCopyright</key>\n\t<string>Copyright Les auteurs de Helium.</string>\n\
         \t<key>NSCameraUsageDescription</key>\n\t<string>Si Helium a acc\u{e8}s</string>\n</dict>\n</plist>\n";
    put(
        "Contents/Resources/fr.lproj/InfoPlist.strings",
        strings.as_bytes(),
    );

    for name in ["Helium Helper (Alerts)", "Helium Helper (Aperitif Alerts)"] {
        let at = format!("{FRAMEWORK}/Helpers/{name}.app/Contents");
        let id = "net.imput.helium.framework.AlertNotificationService";
        put(
            &format!("{at}/Info.plist"),
            plist(id, name, "APPL", "").as_bytes(),
        );
        put(&format!("{at}/MacOS/{name}"), &program);
        put(&format!("{at}/Resources/app.icns"), b"an icon");
        put(&format!("{at}/Resources/Assets.car"), b"an icon");
        let strings = format!("{at}/Resources/base.lproj/InfoPlist.strings");
        put(&strings, BINARY_STRINGS);
    }
    put(
        &format!("{FRAMEWORK}/Helpers/chrome_crashpad_handler"),
        &program,
    );
    put(&format!("{FRAMEWORK}/Helium Framework"), &program);
    let info = plist("net.imput.helium.framework", "Helium Framework", "FMWK", "");
    put(
        &format!("{FRAMEWORK}/Resources/Info.plist"),
        info.as_bytes(),
    );
    put(
        &format!("{FRAMEWORK}/Resources/product_logo_32.png"),
        b"an icon",
    );
    for (lang, about, services) in [
        ("en", "About Helium", "Allow Helium services"),
        ("de", "Info zu Helium", "Dienste von Helium erlauben"),
    ] {
        let pak = pak::made_up(&[(1, about), (2, services)]);
        put(
            &format!("{FRAMEWORK}/Resources/{lang}.lproj/locale.pak"),
            &pak,
        );
    }

    let sparkle = format!("{FRAMEWORK}/Frameworks/Sparkle.framework");
    let info = plist("org.sparkle-project.Sparkle", "Sparkle", "FMWK", "");
    put(
        &format!("{sparkle}/Versions/B/Resources/Info.plist"),
        info.as_bytes(),
    );
    put(&format!("{sparkle}/Versions/B/Sparkle"), &program);
    put(&format!("{sparkle}/Versions/B/Autoupdate"), &program);
    let info = plist("org.sparkle-project.Updater", "Updater", "APPL", "");
    let updater = format!("{sparkle}/Versions/B/Updater.app/Contents");
    put(&format!("{updater}/Info.plist"), info.as_bytes());
    put(&format!("{updater}/MacOS/Updater"), &program);

    let link = |to: &str, at: &str| std::os::unix::fs::symlink(to, app.join(at)).unwrap();
    let framework = "Contents/Frameworks/Helium Framework.framework";
    link("158.0", &format!("{framework}/Versions/Current"));
    for name in ["Helium Framework", "Resources", "Helpers"] {
        link(
            &format!("Versions/Current/{name}"),
            &format!("{framework}/{name}"),
        );
    }
    link("B", &format!("{sparkle}/Versions/Current"));
    for name in ["Sparkle", "Resources", "Autoupdate", "Updater.app"] {
        link(
            &format!("Versions/Current/{name}"),
            &format!("{sparkle}/{name}"),
        );
    }
}

fn said(out: &str) -> io::Result<Ran> {
    Ok(Ran {
        code: Some(0),
        out: out.into(),
        err: String::new(),
    })
}

type Broken = fn(&mut Scene);

/// Each check a build must pass, with what makes it fail.
pub fn failing_scenes() -> [(&'static str, Broken); 11] {
    [
        ("release", |s| {
            s.fail = Some(("curl", "releases/latest", Failure::SaysNo))
        }),
        ("download", |s| {
            s.fail = Some(("curl", "--output", Failure::SaysNo))
        }),
        ("digest", |s| s.digest = Some("00".repeat(32))),
        ("disk image", |s| {
            s.fail = Some(("hdiutil", "attach", Failure::SaysNo))
        }),
        ("code signature", |s| {
            s.fail = Some(("codesign", "--deep", Failure::SaysNo))
        }),
        ("Team ID", |s| {
            s.fail = Some(("codesign", "-R", Failure::SaysNo))
        }),
        ("Gatekeeper", |s| s.gatekeeper = "x: rejected"),
        ("version", |s| s.version_inside = "0.0.1"),
        ("signing", |s| {
            s.fail = Some(("codesign", "--sign", Failure::SaysNo))
        }),
        ("headless start", |s| s.page = ""),
        ("headless start", |s| s.page = "<title>New Tab</title>"),
    ]
}

impl Tools for Fake {
    fn run(&self, call: &Call) -> io::Result<Ran> {
        let name = call.program.file_name().unwrap().to_str().unwrap();
        let args: Vec<&str> = call.args.iter().map(|a| a.to_str().unwrap()).collect();
        let home = call.home.iter().map(|h| format!(" home={}", h.display()));
        let line = format!("{name} {}{}", args.join(" "), home.collect::<String>());
        self.calls.borrow_mut().push(line.clone());
        let scene = self.scene.borrow();
        if let Some((tool, part, failure)) = scene.fail {
            if tool == name && line.contains(part) {
                return match failure {
                    Failure::SaysNo => Ok(Ran {
                        code: Some(1),
                        ..Ran::default()
                    }),
                    Failure::CannotRun => Err(io::ErrorKind::NotFound.into()),
                    Failure::Stopped => Err(io::ErrorKind::Interrupted.into()),
                };
            }
        }
        if scene.real {
            return System.run(call);
        }
        let after = |word: &str| args.iter().position(|a| *a == word).map(|i| args[i + 1]);
        match name {
            "curl" => match after("--output") {
                Some(part) => fs::write(part, IMAGE)?,
                None => {
                    let right = Sha256::digest(IMAGE);
                    let right: String = right.iter().map(|b| format!("{b:02x}")).collect();
                    return said(&feed(scene.digest.as_deref().unwrap_or(&right)));
                }
            },
            "hdiutil" if args[0] == "attach" => {
                self.mounted.set(true);
                let app = Path::new(after("-mountpoint").unwrap()).join("Helium.app");
                if scene.app_is_a_link {
                    std::os::unix::fs::symlink("/Applications", &app)?;
                } else {
                    make_app(&app);
                }
            }
            // The real copy of a made-up app.
            "ditto" => return System.run(call),
            "bash" if scene.identity.is_empty() => {
                return Ok(Ran {
                    code: Some(3),
                    ..Ran::default()
                })
            }
            "bash" => return said(scene.identity),
            "spctl" => return said(scene.gatekeeper),
            "plutil" if line.contains("CFBundleShortVersionString") => {
                return said(scene.version_inside);
            }
            "Polycarp Browser" => return said(scene.page),
            "hdiutil" => self.mounted.set(false),
            "open" => {}
            // No one but the made-up app's maker could sign it, so the checks of their signature are answered here.
            "codesign" if line.contains("--verify") => {}
            "codesign" | "plutil" => return System.run(call),
            other => panic!("no fake for {other}"),
        }
        said("")
    }
}

const SLEEP: &str = "POLYCARP_TEST_SLEEP_SECONDS";

/// The program `Fake::start_inside` runs: it waits when asked to and does nothing otherwise.
#[test]
fn sleeps_when_asked() {
    if let Some(seconds) = std::env::var(SLEEP).ok().and_then(|s| s.parse().ok()) {
        std::thread::sleep(std::time::Duration::from_secs(seconds));
    }
}
