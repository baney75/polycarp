//! A fake release, a made-up app and fake tools, so every test runs offline and touches nothing of the person's.

use std::cell::{Cell, RefCell};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::tools::{Call, Ran, System, Tools};
use super::Place;

pub const VERSION: &str = "0.22.4.1";
const IMAGE: &str = "a made-up disk image";

#[derive(Clone, Copy, Debug)]
pub enum Failure {
    SaysNo,
    CannotRun,
}

pub struct Scene {
    /// The digest the release lists; None is the right one.
    pub digest: Option<String>,
    /// The tool, a part of its arguments, and how it fails.
    pub fail: Option<(&'static str, &'static str, Failure)>,
    pub gatekeeper: &'static str,
    pub version_inside: &'static str,
    pub app_is_a_link: bool,
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
            }),
            calls: RefCell::default(),
            mounted: Cell::default(),
        }
    }

    pub fn set(&self, change: impl FnOnce(&mut Scene)) {
        change(&mut self.scene.borrow_mut());
    }

    pub fn place(&self) -> Place {
        Place {
            cache: self.root.join("cache"),
        }
    }

    /// Every call so far, as `program arguments`.
    pub fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }

    pub fn mounted(&self) -> bool {
        self.mounted.get()
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
        "{{\"tag_name\":\"{VERSION}\",\"draft\":false,\"prerelease\":false,\"assets\":[{},{}]}}",
        asset("arm64"),
        asset("x86_64")
    )
}

fn make_app(app: &Path) {
    for dir in ["MacOS", "Resources"] {
        fs::create_dir_all(app.join("Contents").join(dir)).unwrap();
    }
    fs::copy("/usr/bin/true", app.join("Contents/MacOS/Helium")).unwrap();
    fs::write(app.join("Contents/Resources/page.txt"), "a page").unwrap();
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict>\
         <key>CFBundleExecutable</key><string>Helium</string>\
         <key>CFBundleIdentifier</key><string>net.imput.helium</string>\
         <key>CFBundlePackageType</key><string>APPL</string>\
         <key>CFBundleShortVersionString</key><string>{VERSION}</string></dict></plist>"
    );
    fs::write(app.join("Contents/Info.plist"), plist).unwrap();
}

fn said(out: &str) -> io::Result<Ran> {
    Ok(Ran {
        code: Some(0),
        out: out.into(),
        err: String::new(),
    })
}

impl Tools for Fake {
    fn run(&self, call: &Call) -> io::Result<Ran> {
        let name = call.program.file_name().unwrap().to_str().unwrap();
        let args: Vec<&str> = call.args.iter().map(|a| a.to_str().unwrap()).collect();
        let line = format!("{name} {}", args.join(" "));
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
                };
            }
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
            "spctl" => return said(scene.gatekeeper),
            "plutil" => return said(scene.version_inside),
            "hdiutil" => self.mounted.set(false),
            "codesign" => {}
            other => panic!("no fake for {other}"),
        }
        said("")
    }
}
