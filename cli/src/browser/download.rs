//! A Helium release's download, kept only while its sha256 matches, and the refusal every check gives. Shared by
//! Windows and Linux; nothing here needs a particular system, and only `run_fed` runs a program, the one it is given.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use sha2::{Digest, Sha256};

use super::listing::Release;

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

/// The variable CI sets to its own GitHub token, so the release listing is not rate limited on a shared runner.
// Each system's module reads its own copy of this file; the other system's copy of this name goes unused.
#[allow(dead_code)]
pub const TOKEN: &str = "POLYCARP_GITHUB_TOKEN";

/// The header curl reads from its input (`--header @-`), so the token is in no argument, file or log. Only a bearer
/// token as RFC 6750 spells one (letters, digits and `-._~+/`, then any `=`), so it can't add a line of its own;
/// anything else sends none. GitHub's tokens have grown past 255 bytes, so up to 4096 are taken.
pub fn token_header(token: Option<std::ffi::OsString>) -> Option<String> {
    let token = token?.into_string().ok()?;
    let body = token.trim_end_matches('=');
    let plain = |b: u8| b.is_ascii_alphanumeric() || b"-._~+/".contains(&b);
    let ok = (1..=4096).contains(&token.len()) && !body.is_empty() && body.bytes().all(plain);
    ok.then(|| format!("Authorization: Bearer {token}\n"))
}

/// The header for the token in `TOKEN`, when it is set. One that is set but not plain is said to be left out, by name
/// only, so a run that goes unauthenticated shows why.
#[allow(dead_code)]
pub fn feed_token() -> Option<String> {
    let set = std::env::var_os(TOKEN)?;
    let header = token_header(Some(set));
    if header.is_none() {
        eprintln!("polycarp browser: {TOKEN} is not a plain token; the release listing is read without it");
    }
    header
}

/// curl's arguments for the release listing at `feed`, reading the token's header from its input when there is one.
pub fn feed_args(feed: &'static str, token: bool) -> Vec<&'static str> {
    let mut args = vec!["--header", "Accept: application/vnd.github+json"];
    if token {
        args.extend(["--header", "@-"]);
    }
    args.extend(["--", feed]);
    args
}

/// Runs `command` with `input` as all it reads, or nothing, and gathers its output. A failed write shows as the
/// program's own error; what was being written is never said.
#[allow(dead_code)]
pub fn run_fed(command: &mut Command, input: Option<String>) -> io::Result<Output> {
    let Some(input) = input else {
        return command.stdin(Stdio::null()).output();
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
    }
    child.wait_with_output()
}

pub fn refuse<'a>(check: &'static str, doing: &'a str) -> impl FnOnce(io::Error) -> Refused + 'a {
    move |e| Refused::new(check, format!("{doing}: {e}"))
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

/// The release's file with its own digest, downloaded by `download` unless the folder already has it. Files that
/// `others` names, other than this one, are other releases' leftovers and are deleted.
pub fn fetch(
    release: &Release,
    dir: &Path,
    download: &dyn Fn(&Path) -> Result<(), Refused>,
    others: &dyn Fn(&str) -> bool,
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
    // Files of other releases, and halves of them.
    for other in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = other.file_name().to_string_lossy().into_owned();
        if others(&name) && name != release.name {
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

#[cfg(test)]
mod token_tests {
    use super::*;

    #[test]
    fn only_a_plain_token_becomes_a_header() {
        let header = |t: &str| token_header(Some(t.into()));
        assert_eq!(
            header("ghs_A1b2"),
            Some("Authorization: Bearer ghs_A1b2\n".into())
        );
        assert_eq!(token_header(None), None);
        for good in ["ghs_a.b-c~d+e/f==", &"a".repeat(4096)] {
            let want = format!("Authorization: Bearer {good}\n");
            assert_eq!(header(good), Some(want), "{good:?}");
        }
        for bad in [
            "",
            "=",
            "a b",
            "a\nX-Evil: 1",
            "a\r",
            "tok:en",
            "a=b",
            "ünï",
        ] {
            assert_eq!(header(bad), None, "{bad:?}");
        }
        assert_eq!(header(&"a".repeat(4097)), None);
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            assert_eq!(
                token_header(Some(std::ffi::OsString::from_vec(vec![0xff]))),
                None
            );
        }
    }

    #[test]
    fn the_token_is_read_from_curl_s_input_never_its_arguments() {
        let feed = "https://api.github.com/repos/x/y/releases/latest";
        let accept = ["--header", "Accept: application/vnd.github+json"];
        assert_eq!(
            feed_args(feed, false),
            [&accept[..], &["--", feed]].concat()
        );
        assert_eq!(
            feed_args(feed, true),
            [&accept[..], &["--header", "@-", "--", feed]].concat()
        );
    }
}
