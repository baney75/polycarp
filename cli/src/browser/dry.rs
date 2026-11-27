//! What the dry run on Windows and on Linux share: the words `polycarp browser` answers there, how a refusal is told,
//! and a download kept only while its sha256 matches the listing. Each OS loads this file by `#[path]`, beside
//! `listing.rs`.

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::listing::Release;

/// The browser's first words, the same as the Mac's.
pub const VERBS: [&str; 7] = [
    "install",
    "update",
    "status",
    "open",
    "import",
    "uninstall",
    "finish",
];

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

pub fn refuse<'a>(check: &'static str, doing: &'a str) -> impl FnOnce(io::Error) -> Refused + 'a {
    move |e| Refused::new(check, format!("{doing}: {e}"))
}

/// None when these arguments are not a browser command. `only` is the OS's one line for everything but
/// `install --dry-run`, and `dry_run` checks the newest release in the cache's `browser` folder.
pub fn run(
    args: &[OsString],
    home: Option<PathBuf>,
    cache: Option<PathBuf>,
    only: &str,
    dry_run: impl FnOnce(&Path) -> Result<String, Refused>,
) -> Option<i32> {
    let verb = args.first().map_or(Some("--help"), |a| a.to_str())?;
    if ["--help", "-h", "help"].contains(&verb) {
        println!("{only}");
        return Some(0);
    }
    if !VERBS.contains(&verb) {
        return None;
    }
    if verb != "install" || args.len() != 2 || args[1] != "--dry-run" {
        eprintln!("{only}");
        return Some(2);
    }
    let (Some(_), Some(cache)) = (home, cache) else {
        eprintln!("polycarp browser: no home folder");
        return Some(1);
    };
    Some(print(dry_run(&cache.join("browser"))))
}

pub fn print(done: Result<String, Refused>) -> i32 {
    match done {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(r) => {
            eprintln!(
                "polycarp browser: the {} check failed: {}. Nothing was installed.",
                r.check, r.why
            );
            1
        }
    }
}

/// The release's file with its own digest, downloaded by `download` unless the folder already has it. Afterwards
/// every other file `old` calls the caller's own (older releases, halves of downloads) is removed; nothing else in the
/// folder is touched.
pub fn fetch(
    release: &Release,
    dir: &Path,
    download: &dyn Fn(&Path) -> Result<(), Refused>,
    old: &dyn Fn(&str) -> bool,
) -> Result<PathBuf, Refused> {
    let file = dir.join(&release.name);
    if !digest(&file).is_ok_and(|d| d == release.sha256) {
        let part = dir.join(format!("{}.part", release.name));
        let _ = fs::remove_file(&part);
        download(&part)?;
        let got = digest(&part).map_err(refuse("digest", "reading the download"))?;
        if got != release.sha256 {
            let _ = fs::remove_file(&part);
            let why = format!("{} does not match the release's sha256", release.name);
            return Err(Refused::new("digest", why));
        }
        fs::rename(&part, &file).map_err(refuse("download", "keeping it"))?;
    }
    for other in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = other.file_name().to_string_lossy().into_owned();
        if old(&name) && name != release.name {
            let _ = fs::remove_file(other.path());
        }
    }
    Ok(file)
}

pub fn digest(path: &Path) -> io::Result<String> {
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

/// A link, or on Windows any reparse point such as a junction.
pub fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

pub fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string()
}
