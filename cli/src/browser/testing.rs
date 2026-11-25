//! A fake release, a made-up app and fake tools, so every test runs offline and touches nothing of the person's.

use std::cell::RefCell;
use std::fs;
use std::io;
use std::path::PathBuf;

use super::tools::{Call, Ran, Tools};
use super::Place;

pub const VERSION: &str = "0.22.4.1";

#[derive(Clone, Copy, Debug)]
pub enum Failure {
    SaysNo,
    CannotRun,
}

pub struct Scene {
    /// The tool, a part of its arguments, and how it fails.
    pub fail: Option<(&'static str, &'static str, Failure)>,
}

pub struct Fake {
    root: PathBuf,
    scene: RefCell<Scene>,
    calls: RefCell<Vec<String>>,
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
            scene: RefCell::new(Scene { fail: None }),
            calls: RefCell::default(),
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
        match name {
            "curl" => said(&feed(&"ab".repeat(32))),
            other => panic!("no fake for {other}"),
        }
    }
}
