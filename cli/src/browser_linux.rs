//! Polycarp Browser on Linux, step one: `polycarp browser install --dry-run` downloads Helium's newest Linux
//! release, checks its sha256 and its OpenPGP signature against Helium's pinned key, and only then unpacks it into
//! a private folder, checks the layout and throws the unpacked copy away. Nothing is installed and nothing from the
//! release is run. The rules are in `../browser/AGENTS.md`.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

// One copy of the listing and download code serves every platform, so a test build loads each more than once on
// purpose. Linux does not read every listing field.
#[allow(clippy::duplicate_mod)]
#[allow(dead_code)]
#[path = "browser/listing.rs"]
mod listing;

#[allow(clippy::duplicate_mod)]
#[path = "browser/download.rs"]
mod download;

use download::{fetch, is_link, print, refuse, Refused};
use listing::Release;

#[cfg(target_os = "linux")]
const FEED: &str = "https://api.github.com/repos/imputnet/helium-linux/releases/latest";
const DOWNLOADS: &str = "https://github.com/imputnet/helium-linux/releases/download";
/// Helium's signing key, `pubkey.asc` from imputnet/helium-linux. Trust comes from `FINGERPRINT`, not from this
/// file: a signature counts only when gpg names this primary key.
const KEY: &str = include_str!("browser/helium-linux.asc");
/// The primary key every release must be signed by, uppercase hex, compared whole.
const FINGERPRINT: &str = "BE677C1989D35EAB2C5F26C9351601AD01D6378E";
/// The browser's first words, the same as the Mac's.
const VERBS: [&str; 7] = [
    "install",
    "update",
    "status",
    "open",
    "import",
    "uninstall",
    "finish",
];
const ONLY: &str = "polycarp browser: only `install --dry-run` works on Linux so far.";

/// None when these arguments are not a browser command.
pub fn run(args: &[OsString], home: Option<PathBuf>, cache: Option<PathBuf>) -> Option<i32> {
    let verb = args.first().map_or(Some("--help"), |a| a.to_str())?;
    if ["--help", "-h", "help"].contains(&verb) {
        println!("{ONLY}");
        return Some(0);
    }
    if !VERBS.contains(&verb) {
        return None;
    }
    if verb != "install" || args.len() != 2 || args[1] != "--dry-run" {
        eprintln!("{ONLY}");
        return Some(2);
    }
    let (Some(_), Some(cache)) = (home, cache) else {
        eprintln!("polycarp browser: no home folder");
        return Some(1);
    };
    #[cfg(target_os = "linux")]
    let done = dry_run(&cache.join("browser"));
    #[cfg(not(target_os = "linux"))]
    let done = Err(Refused::new(
        "system",
        format!("{} is not Linux", cache.display()),
    ));
    Some(print(done))
}

/// Helium's name for this processor.
fn arch_name(arch: &str) -> Result<&'static str, Refused> {
    match arch {
        "x86_64" => Ok("x86_64"),
        "aarch64" => Ok("arm64"),
        _ => Err(Refused::new("processor", "no Helium for this processor")),
    }
}

/// The tarball and its detached signature, each with its own address check and sha256.
fn parse(json: &str, arch: &str) -> Result<(Release, Release), Refused> {
    let tarball = |version: &str| format!("helium-{version}-{arch}_linux.tar.xz");
    let release = |name: &dyn Fn(&str) -> String| {
        listing::parse(json, DOWNLOADS, name).map_err(|why| Refused::new("release", why))
    };
    let signature = |version: &str| format!("{}.asc", tarball(version));
    Ok((release(&tarball)?, release(&signature)?))
}

/// Tarballs and signatures of other Linux releases, and halves of them; never the two this release uses.
fn others(current: [String; 2]) -> impl Fn(&str) -> bool {
    move |name: &str| {
        name.starts_with("helium-")
            && name.contains("_linux.tar.xz")
            && !current.iter().any(|c| c == name)
    }
}

/// The first of `paths` that is a file; a refusal naming every path tried when none is.
fn first(check: &'static str, paths: &[&str]) -> Result<PathBuf, Refused> {
    let found = paths.iter().map(PathBuf::from).find(|p| p.is_file());
    found.ok_or_else(|| Refused::new(check, format!("no program at {}", paths.join(" or "))))
}

/// gpg's `--status-fd` answer for one detached signature: it passes only when gpg exited well, nothing went wrong,
/// there is exactly one good and one valid signature, the signature is on the file itself (class 00) and its
/// primary key is Helium's pinned one.
fn judge_gpg(status: &str, exit_ok: bool) -> Result<(), Refused> {
    let no = |why: &str| Err(Refused::new("signature", why));
    let lines: Vec<Vec<&str>> = status
        .lines()
        .filter_map(|l| l.strip_prefix("[GNUPG:] "))
        .map(|l| l.split_whitespace().collect())
        .collect();
    let count = |word: &str| lines.iter().filter(|f| f.first() == Some(&word)).count();
    for (word, why) in [
        ("BADSIG", "the signature does not verify"),
        ("ERRSIG", "the signature could not be checked"),
        ("NO_PUBKEY", "signed by another key"),
        ("EXPSIG", "the signature has expired"),
        ("EXPKEYSIG", "the key has expired"),
        ("REVKEYSIG", "the key was revoked"),
    ] {
        if count(word) > 0 {
            return no(why);
        }
    }
    if !exit_ok {
        return no("gpg did not accept the signature");
    }
    let (good, valid) = (count("GOODSIG"), count("VALIDSIG"));
    if good == 0 || valid == 0 {
        return no("the signature does not verify");
    }
    if good > 1 || valid > 1 {
        return no("there is more than one signature");
    }
    let Some(validsig) = lines.iter().find(|f| f.first() == Some(&"VALIDSIG")) else {
        return no("the signature does not verify");
    };
    let fields = &validsig[1..];
    if fields.len() < 10 {
        return no("gpg's answer was not understood");
    }
    if fields[8] != "00" {
        return no("it is not a signature on the file itself");
    }
    if fields[9] != FINGERPRINT {
        return no("signed by another key");
    }
    Ok(())
}

/// A fingerprint in groups of four, as people read it.
fn spaced(fingerprint: &str) -> String {
    let groups: Vec<&str> = (0..fingerprint.len())
        .step_by(4)
        .filter_map(|i| fingerprint.get(i..(i + 4).min(fingerprint.len())))
        .collect();
    groups.join(" ")
}

fn done_line(version: &str, n: usize) -> String {
    format!(
        "Helium {version} was downloaded and passed its checks: the sha256 GitHub lists, and Helium's OpenPGP \
         signature from key {}. Its {n} files were unpacked and deleted. Nothing was installed.",
        spaced(FINGERPRINT)
    )
}

/// The unpacked folder and its number of plain files, when the work folder holds exactly Helium's one folder with its
/// program and wrapper, and nothing in it is anything but a folder, a plain file or a link to a plain file beside it.
fn laid_out(work: &Path, version: &str, arch: &str) -> Result<(PathBuf, usize), Refused> {
    let bad = || Refused::new("layout", "the tarball is not laid out as Helium's");
    let entries: Vec<_> = fs::read_dir(work).map_err(|_| bad())?.collect();
    let top = format!("helium-{version}-{arch}_linux");
    let [Ok(entry)] = entries.as_slice() else {
        return Err(bad());
    };
    let plain = |p: &Path, dir: bool| {
        fs::symlink_metadata(p)
            .is_ok_and(|m| !is_link(&m) && if dir { m.is_dir() } else { m.is_file() })
    };
    let root = entry.path();
    let ok = entry.file_name() == top.as_str()
        && plain(&root, true)
        && plain(&root.join("helium"), false)
        && plain(&root.join("helium-wrapper"), false);
    if !ok {
        return Err(bad());
    }
    let mut files = 0;
    let mut folders = vec![root.clone()];
    while let Some(folder) = folders.pop() {
        for entry in fs::read_dir(&folder).map_err(|_| bad())? {
            let path = entry.map_err(|_| bad())?.path();
            let meta = fs::symlink_metadata(&path).map_err(|_| bad())?;
            if is_link(&meta) {
                let target = fs::read_link(&path).map_err(|_| bad())?;
                let text = target.to_str().unwrap_or("/");
                let beside = !text.is_empty() && !text.contains('/') && text != "." && text != "..";
                if !beside || !plain(&folder.join(text), false) {
                    return Err(bad());
                }
            } else if meta.is_dir() {
                folders.push(path);
            } else if meta.is_file() {
                files += 1;
            } else {
                return Err(bad());
            }
        }
    }
    Ok((root, files))
}

/// The binary key inside an armored OpenPGP block, which `gpgv` reads as its keyring. None when it is not one.
fn dearmor(armored: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let mut lines = armored.lines().map(str::trim_end);
    lines.find(|l| *l == "-----BEGIN PGP PUBLIC KEY BLOCK-----")?;
    // Header lines such as `Comment:` end at the first empty line.
    lines.find(|l| l.is_empty())?;
    let mut body = String::new();
    for line in lines {
        if line == "-----END PGP PUBLIC KEY BLOCK-----" {
            return base64::engine::general_purpose::STANDARD.decode(body).ok();
        }
        // The checksum line; the pinned file's sha256 already covers it.
        if !line.starts_with('=') {
            body.push_str(line);
        }
    }
    None
}

/// A program by its absolute path, with none of the person's environment: helpers it runs by name, such as tar's
/// `xz`, come only from `/usr/bin` and `/bin`, never from a folder on the person's `PATH`.
fn pinned(program: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C");
    command
}

/// `gpgv` checks one signature against one keyring file. Unlike `gpg` it never starts an agent or keyboxd and
/// reads no options file; `--homedir` keeps it out of the person's `~/.gnupg`.
fn gpgv(
    program: &Path,
    home: &Path,
    keyring: &Path,
    asc: &Path,
    tarball: &Path,
) -> std::process::Command {
    let mut command = pinned(program);
    command
        .arg("--homedir")
        .arg(home)
        .args(["--status-fd", "1", "--keyring"])
        .arg(keyring)
        .arg("--")
        .arg(asc)
        .arg(tarball);
    command
}

fn tar(program: &Path, tarball: &Path, work: &Path) -> std::process::Command {
    let mut command = pinned(program);
    command
        .arg("-xJf")
        .arg(tarball)
        .arg("-C")
        .arg(work)
        .arg("--no-same-owner");
    command
}

#[cfg(target_os = "linux")]
mod system {
    use super::*;
    use std::ffi::OsStr;
    use std::os::unix::fs::DirBuilderExt;
    use std::process::{Command, Output, Stdio};

    /// Runs a program by its absolute path, no shell, nothing on stdin; what it did, whatever its exit.
    fn ran(check: &'static str, command: Command) -> Result<Output, Refused> {
        fed(check, command, None)
    }

    /// Runs a program with `input` as all it reads, or nothing.
    fn fed(
        check: &'static str,
        mut command: Command,
        input: Option<String>,
    ) -> Result<Output, Refused> {
        let program = PathBuf::from(command.get_program());
        let cannot = |e: std::io::Error| {
            Refused::new(check, format!("{} could not run: {e}", program.display()))
        };
        let Some(input) = input else {
            return command.stdin(Stdio::null()).output().map_err(cannot);
        };
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(cannot)?;
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            // A failed write shows as curl's own error; what was being written is never said.
            let _ = stdin.write_all(input.as_bytes());
        }
        child.wait_with_output().map_err(cannot)
    }

    /// Runs a program, which must succeed; its output.
    fn must(check: &'static str, command: Command) -> Result<String, Refused> {
        must_fed(check, command, None)
    }

    fn must_fed(
        check: &'static str,
        command: Command,
        input: Option<String>,
    ) -> Result<String, Refused> {
        let out = fed(check, command, input)?;
        if !out.status.success() {
            let said = String::from_utf8_lossy(&out.stderr);
            let last = said.lines().map(str::trim).rfind(|l| !l.is_empty());
            let why = last.map_or(format!("exit {:?}", out.status.code()), str::to_string);
            return Err(Refused::new(check, why));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Removes a folder or file, without following a link, when it is there.
    fn clear(path: &Path) -> std::io::Result<()> {
        match fs::symlink_metadata(path) {
            Ok(m) if m.is_dir() => fs::remove_dir_all(path),
            Ok(_) => fs::remove_file(path),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// A private, empty folder at `path`, whatever was there before.
    fn fresh(check: &'static str, path: &Path) -> Result<(), Refused> {
        clear(path).map_err(refuse(check, "clearing it"))?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(refuse(check, "making it"))
    }

    /// `curl`, https only, without the person's own curl settings, as on the Mac and Windows.
    fn curl(
        check: &'static str,
        seconds: u64,
        bytes: u64,
        more: &[&OsStr],
    ) -> Result<String, Refused> {
        curl_fed(check, seconds, bytes, more, None)
    }

    fn curl_fed(
        check: &'static str,
        seconds: u64,
        bytes: u64,
        more: &[&OsStr],
        input: Option<String>,
    ) -> Result<String, Refused> {
        let mut command = Command::new(first(check, &["/usr/bin/curl", "/bin/curl"])?);
        // The token reaches curl only on its input, never in its environment.
        command.env_remove(download::TOKEN);
        let options =
            "-q --fail --silent --show-error --location --proto =https --proto-redir =https \
                       --tlsv1.2 --retry 2 --connect-timeout 20 --user-agent polycarp-browser";
        command
            .args(options.split_whitespace())
            .arg("--max-filesize")
            .arg(bytes.to_string())
            .arg("--max-time")
            .arg(seconds.to_string())
            .args(more);
        must_fed(check, command, input)
    }

    fn newest(arch: &str) -> Result<(Release, Release), Refused> {
        let header = download::token_header(std::env::var_os(download::TOKEN));
        let args = download::feed_args(FEED, header.is_some());
        let more: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
        let said = curl_fed("release", 60, 734_003_200, &more, header)?;
        parse(&said, arch)
    }

    pub struct Fetched {
        pub release: Release,
        pub arch: &'static str,
        pub tarball: PathBuf,
        pub asc: PathBuf,
    }

    /// Downloads `url` into the file it is given, in at most `seconds` and `bytes`.
    fn get(url: &str, seconds: u64, bytes: u64) -> impl Fn(&Path) -> Result<(), Refused> + '_ {
        move |part: &Path| {
            let more: [&OsStr; 4] = [
                "--output".as_ref(),
                part.as_os_str(),
                "--".as_ref(),
                OsStr::new(url),
            ];
            curl("download", seconds, bytes, &more).map(drop)
        }
    }

    pub fn download(dir: &Path) -> Result<Fetched, Refused> {
        let arch = arch_name(std::env::consts::ARCH)?;
        fs::create_dir_all(dir).map_err(refuse("download", "making the cache folder"))?;
        let (release, signature) = newest(arch)?;
        let old = others([release.name.clone(), signature.name.clone()]);
        let tarball = fetch(&release, dir, &get(&release.url, 1800, 734_003_200), &old)?;
        let asc = fetch(&signature, dir, &get(&signature.url, 60, 65_536), &old)?;
        Ok(Fetched {
            release,
            arch,
            tarball,
            asc,
        })
    }

    /// Checks `asc` on `tarball` against the pinned key with `gpgv`, in a folder under `dir` that holds only that
    /// key and is removed afterwards.
    pub fn signature(dir: &Path, tarball: &Path, asc: &Path) -> Result<(), Refused> {
        let program = first("signature", &["/usr/bin/gpgv", "/bin/gpgv"])?;
        let key = dearmor(KEY)
            .ok_or_else(|| Refused::new("signature", "the pinned key could not be read"))?;
        let keyring = dir.join("gnupg");
        let checked = fresh("signature", &keyring).and_then(|()| {
            let file = keyring.join("helium.gpg");
            fs::write(&file, &key).map_err(refuse("signature", "writing the key"))?;
            let out = ran("signature", gpgv(&program, &keyring, &file, asc, tarball))?;
            judge_gpg(&String::from_utf8_lossy(&out.stdout), out.status.success())
        });
        let _ = clear(&keyring);
        checked
    }

    /// Unpacks the tarball into `work` with the system's tar, which refuses `..` members and strips a leading `/`.
    fn unpack(
        tarball: &Path,
        work: &Path,
        release: &Release,
        arch: &str,
    ) -> Result<usize, Refused> {
        let program = first("unpack", &["/usr/bin/tar", "/bin/tar"])?;
        must("unpack", tar(&program, tarball, work))?;
        laid_out(work, &release.version, arch).map(|(_, n)| n)
    }

    /// Downloads and checks the newest release in `dir`, then throws the unpacked copy away.
    pub fn dry_run(dir: &Path) -> Result<String, Refused> {
        let got = download(dir)?;
        signature(dir, &got.tarball, &got.asc)?;
        let work = dir.join("work");
        let checked = fresh("work folder", &work)
            .and_then(|()| unpack(&got.tarball, &work, &got.release, got.arch));
        let _ = clear(&work);
        Ok(done_line(&got.release.version, checked?))
    }
}

#[cfg(target_os = "linux")]
use system::dry_run;

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::ffi::OsStr;

    const VERSION: &str = "0.22.5.1";

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("polycarp-bl-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// A trimmed listing in the real one's shape, with made-up digests.
    fn feed_of(ends: &[&str], digest: &str) -> String {
        let asset = |end: &&str| {
            let name = format!("helium-{VERSION}-{end}");
            let url = format!("{DOWNLOADS}/{VERSION}/{name}");
            format!("{{\"name\":\"{name}\",\"browser_download_url\":\"{url}\",\"digest\":\"sha256:{digest}\"}}")
        };
        let assets: Vec<String> = ends.iter().map(asset).collect();
        format!(
            "{{\"tag_name\":\"{VERSION}\",\"draft\":false,\"prerelease\":false,\"assets\":[{}]}}",
            assets.join(",")
        )
    }

    const ENDS: [&str; 8] = [
        "arm64.AppImage",
        "arm64.AppImage.zsync",
        "arm64_linux.tar.xz",
        "arm64_linux.tar.xz.asc",
        "x86_64.AppImage",
        "x86_64.AppImage.zsync",
        "x86_64_linux.tar.xz",
        "x86_64_linux.tar.xz.asc",
    ];

    fn feed(digest: &str) -> String {
        feed_of(&ENDS, digest)
    }

    #[test]
    fn the_newest_linux_tarball_and_signature_for_each_processor() {
        for arch in ["x86_64", "arm64"] {
            let (tarball, asc) = parse(&feed(&"AB".repeat(32)), arch).unwrap();
            assert_eq!(
                tarball.name,
                format!("helium-{VERSION}-{arch}_linux.tar.xz")
            );
            assert_eq!(asc.name, format!("{}.asc", tarball.name));
            let at = "https://github.com/imputnet/helium-linux/releases/download/0.22.5.1/";
            for r in [&tarball, &asc] {
                assert_eq!(r.url, format!("{at}{}", r.name));
                assert_eq!(r.sha256, "ab".repeat(32));
                assert_eq!(r.version, VERSION);
            }
        }
        assert_eq!(arch_name("x86_64"), Ok("x86_64"));
        assert_eq!(arch_name("aarch64"), Ok("arm64"));
        let e = arch_name("riscv64").unwrap_err();
        assert_eq!(e.check, "processor");
        assert!(e.why.contains("no Helium for this processor"));
    }

    #[test]
    fn a_linux_listing_that_is_off_is_refused() {
        let digest = "ab".repeat(32);
        let refused = |json: &str| parse(json, "x86_64").unwrap_err();
        let only_others = feed_of(
            &["x86_64.AppImage", "x86_64.AppImage.zsync", "amd64.deb"],
            &digest,
        );
        let e = refused(&only_others);
        assert_eq!(e.check, "release");
        assert!(
            e.why.contains("has no helium-0.22.5.1-x86_64_linux.tar.xz"),
            "{}",
            e.why
        );
        let no_asc = feed_of(&["x86_64.AppImage", "x86_64_linux.tar.xz"], &digest);
        let e = refused(&no_asc);
        assert_eq!(e.check, "release");
        assert!(
            e.why
                .contains("has no helium-0.22.5.1-x86_64_linux.tar.xz.asc"),
            "{}",
            e.why
        );
        for (from, to, why) in [
            (
                "github.com/imputnet",
                "example.com/imputnet",
                "another address",
            ),
            ("https://", "http://", "another address"),
            (
                "helium-linux/releases",
                "helium-macos/releases",
                "another address",
            ),
            (
                "\"prerelease\":false",
                "\"prerelease\":true",
                "full release",
            ),
            ("sha256:ab", "sha256:zz", "no sha256"),
        ] {
            let e = refused(&feed(&digest).replace(from, to));
            assert_eq!(e.check, "release");
            assert!(e.why.contains(why), "{from}: {} should say {why}", e.why);
        }
        // Only the signature's address moved.
        let asc_url = format!("download/{VERSION}/helium-{VERSION}-x86_64_linux.tar.xz.asc");
        let moved = feed(&digest).replace(&asc_url, &format!("download/x/{asc_url}"));
        assert!(refused(&moved).why.contains("another address"));
    }

    #[test]
    fn the_pinned_key_file_is_the_one_measured() {
        assert_eq!(
            hex(KEY.as_bytes()),
            "e25c51e39b68d79d89bd26fc1200791f590f2e780efb946d62ca25ff5487d022"
        );
        // The same bytes `gpg --dearmor` gives for it, which gpgv read to pass the real release.
        assert_eq!(
            hex(&dearmor(KEY).expect("the pinned key is armored")),
            "b1d4ab21420c1fd3f4f5e4710b0bf3a47c3e36861a64d1c2486c610914eae413"
        );
        assert_eq!(dearmor("not a key"), None);
        let no_end = KEY.replace("-----END PGP PUBLIC KEY BLOCK-----", "");
        assert_eq!(dearmor(&no_end), None);
        assert_eq!(
            spaced(FINGERPRINT),
            "BE67 7C19 89D3 5EAB 2C5F 26C9 3516 01AD 01D6 378E"
        );
        assert_eq!(
            done_line(VERSION, 292),
            "Helium 0.22.5.1 was downloaded and passed its checks: the sha256 GitHub lists, and Helium's OpenPGP \
             signature from key BE67 7C19 89D3 5EAB 2C5F 26C9 3516 01AD 01D6 378E. Its 292 files were unpacked and \
             deleted. Nothing was installed."
        );
    }

    const GOOD: &str = "[GNUPG:] GOODSIG 351601AD01D6378E Helium signing key (https://helium.computer/) <helium@imput.net>";
    const VALID: &str = "[GNUPG:] VALIDSIG BE677C1989D35EAB2C5F26C9351601AD01D6378E 2026-11-25 1795640525 0 4 0 22 10 00 BE677C1989D35EAB2C5F26C9351601AD01D6378E";

    fn real() -> String {
        format!(
            "[GNUPG:] NEWSIG\n[GNUPG:] KEY_CONSIDERED BE677C1989D35EAB2C5F26C9351601AD01D6378E 0\n\
             [GNUPG:] SIG_ID x 2026-11-25 1795640525\n{GOOD}\n{VALID}\n[GNUPG:] TRUST_UNDEFINED 0 pgp\n"
        )
    }

    fn why(status: &str, ok: bool) -> String {
        let e = judge_gpg(status, ok).unwrap_err();
        assert_eq!(e.check, "signature");
        assert!(!e.why.contains('\n'), "{}", e.why);
        e.why
    }

    #[test]
    fn only_a_good_signature_from_helium_s_key_passes() {
        assert_eq!(judge_gpg(&real(), true), Ok(()));
        assert_eq!(why(&real(), false), "gpg did not accept the signature");
        let bad = "[GNUPG:] NEWSIG\n[GNUPG:] BADSIG 351601AD01D6378E Helium signing key\n";
        assert_eq!(why(bad, false), "the signature does not verify");
        assert_eq!(why(bad, true), "the signature does not verify");
        let err = "[GNUPG:] ERRSIG 351601AD01D6378E 22 10 00 1795640525 9 -\n";
        assert_eq!(why(err, false), "the signature could not be checked");
        assert_eq!(
            why("[GNUPG:] NO_PUBKEY 351601AD01D6378E\n", false),
            "signed by another key"
        );
        for (word, said) in [
            ("EXPKEYSIG", "the key has expired"),
            ("REVKEYSIG", "the key was revoked"),
            ("EXPSIG", "the signature has expired"),
        ] {
            let status = format!("{}[GNUPG:] {word} 351601AD01D6378E Helium\n", real());
            assert_eq!(why(&status, true), said, "{word}");
        }
        assert_eq!(why("", true), "the signature does not verify");
        assert_eq!(
            why(&format!("{GOOD}\n"), true),
            "the signature does not verify"
        );
        assert_eq!(
            why(&format!("{VALID}\n"), true),
            "the signature does not verify"
        );
        // GOODSIG or VALIDSIG twice.
        assert_eq!(
            why(&format!("{}{GOOD}\n", real()), true),
            "there is more than one signature"
        );
        assert_eq!(
            why(&format!("{}{VALID}\n", real()), true),
            "there is more than one signature"
        );
        let class = real().replace(" 10 00 BE67", " 10 01 BE67");
        assert_eq!(
            why(&class, true),
            "it is not a signature on the file itself"
        );
        let short = real().replace(" 10 00 BE677C1989D35EAB2C5F26C9351601AD01D6378E", " 10 00");
        assert_eq!(why(&short, true), "gpg's answer was not understood");
        // Another primary key: a whole other one, one hex digit changed, lowercase, or a prefix of Helium's.
        let primary =
            |fpr: &str| real().replace(&format!(" 00 {FINGERPRINT}"), &format!(" 00 {fpr}"));
        for fpr in [
            "0123456789ABCDEF0123456789ABCDEF01234567",
            "BE677C1989D35EAB2C5F26C9351601AD01D6378F",
            FINGERPRINT.to_lowercase().as_str(),
            &FINGERPRINT[..16],
            format!("{FINGERPRINT}00").as_str(),
        ] {
            assert_eq!(why(&primary(fpr), true), "signed by another key", "{fpr}");
        }
        // Only lines that start with gpg's own marker count.
        let quoted = format!("x{GOOD}\nx{VALID}\n");
        assert_eq!(why(&quoted, true), "the signature does not verify");
    }

    #[test]
    fn a_download_and_its_signature_are_kept_only_while_their_digests_match() {
        let dir = temp("fetch");
        for old in [
            "helium-0.1.0.0-x86_64_linux.tar.xz",
            "helium-0.1.0.0-x86_64_linux.tar.xz.asc",
            "helium-0.22.5.1-x86_64_linux.tar.xz.part",
        ] {
            fs::write(dir.join(old), "old").unwrap();
        }
        fs::write(dir.join("notes.txt"), "not Helium's").unwrap();
        let (tar_body, asc_body) = ("a made-up tarball", "a made-up signature");
        let json = feed(&"00".repeat(32));
        let (mut tarball, mut asc) = parse(&json, "x86_64").unwrap();
        tarball.sha256 = hex(tar_body.as_bytes());
        asc.sha256 = hex(asc_body.as_bytes());
        let count = std::cell::Cell::new(0);
        let counted = &count;
        let get = |body: &'static str| {
            move |part: &Path| {
                let count = counted;
                count.set(count.get() + 1);
                fs::write(part, body).map_err(refuse("download", "writing"))
            }
        };
        let (get_tar, get_asc) = (get(tar_body), get(asc_body));
        let old = others([tarball.name.clone(), asc.name.clone()]);
        let file = fetch(&tarball, &dir, &get_tar, &old).unwrap();
        let sig = fetch(&asc, &dir, &get_asc, &old).unwrap();
        fetch(&tarball, &dir, &get_tar, &old).unwrap();
        fetch(&asc, &dir, &get_asc, &old).unwrap();
        assert_eq!(count.get(), 2, "a good cached file was downloaded again");
        let mut left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        left.sort();
        assert_eq!(left, [file.clone(), sig.clone(), dir.join("notes.txt")]);
        fs::write(&file, "changed after it was downloaded").unwrap();
        fetch(&tarball, &dir, &get_tar, &old).unwrap();
        assert_eq!(count.get(), 3);
        assert!(
            sig.exists(),
            "the signature went with the tarball's download"
        );
        tarball.sha256 = "00".repeat(32);
        fs::remove_file(&file).unwrap();
        assert_eq!(
            fetch(&tarball, &dir, &get_tar, &old).unwrap_err().check,
            "digest"
        );
        assert!(!file.exists(), "a refused download was kept");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tar_and_gpgv_run_with_only_the_system_s_path() {
        let path = |c: &std::process::Command| {
            c.get_envs()
                .map(|(k, v)| (k.to_owned(), v.map(OsStr::to_owned)))
                .collect::<Vec<_>>()
        };
        let want = vec![
            ("LC_ALL".into(), Some("C".into())),
            ("PATH".into(), Some("/usr/bin:/bin".into())),
        ];
        let args =
            |c: &std::process::Command| c.get_args().map(OsStr::to_owned).collect::<Vec<_>>();
        let t = tar(
            Path::new("/usr/bin/tar"),
            Path::new("/c/h.tar.xz"),
            Path::new("/c/work"),
        );
        assert_eq!(path(&t), want);
        assert_eq!(
            args(&t),
            ["-xJf", "/c/h.tar.xz", "-C", "/c/work", "--no-same-owner"]
        );
        let g = gpgv(
            Path::new("/usr/bin/gpgv"),
            Path::new("/c/gnupg"),
            Path::new("/c/gnupg/helium.gpg"),
            Path::new("/c/h.tar.xz.asc"),
            Path::new("/c/h.tar.xz"),
        );
        assert_eq!(path(&g), want);
        let expected = [
            "--homedir",
            "/c/gnupg",
            "--status-fd",
            "1",
            "--keyring",
            "/c/gnupg/helium.gpg",
            "--",
            "/c/h.tar.xz.asc",
            "/c/h.tar.xz",
        ];
        assert_eq!(args(&g), expected);
    }

    #[test]
    fn a_program_is_the_first_path_that_is_there() {
        let dir = temp("first");
        let there = dir.join("tool");
        fs::write(&there, "x").unwrap();
        let (none, yes) = (dir.join("none"), there.to_str().unwrap().to_string());
        let none = none.to_str().unwrap();
        assert_eq!(first("download", &[none, yes.as_str()]), Ok(there.clone()));
        let e = first("download", &[none, dir.to_str().unwrap()]).unwrap_err();
        assert_eq!(e.why, format!("no program at {none} or {}", dir.display()));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Helium's layout in small: the program, its wrapper, `chrome -> helium` and a folder.
    fn helium(work: &Path) -> PathBuf {
        let top = work.join(format!("helium-{VERSION}-x86_64_linux"));
        fs::create_dir_all(top.join("locales")).unwrap();
        for f in [
            "helium",
            "helium-wrapper",
            "resources.pak",
            "locales/en-US.pak",
        ] {
            fs::write(top.join(f), "x").unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink("helium", top.join("chrome")).unwrap();
        top
    }

    #[test]
    fn only_helium_s_own_layout_is_unpacked() {
        let work = temp("layout");
        let top = helium(&work);
        let check = |version: &str, arch: &str| laid_out(&work, version, arch).map_err(|e| e.why);
        let bad = Err("the tarball is not laid out as Helium's".to_string());
        assert_eq!(check(VERSION, "x86_64"), Ok((top.clone(), 4)));
        assert_eq!(check("0.22.5.2", "x86_64"), bad, "another version");
        assert_eq!(check(VERSION, "arm64"), bad, "another processor");
        fs::write(work.join("extra"), "x").unwrap();
        assert_eq!(check(VERSION, "x86_64"), bad, "two entries");
        fs::remove_file(work.join("extra")).unwrap();
        for f in ["helium", "helium-wrapper"] {
            fs::rename(top.join(f), work.join(f)).unwrap();
            let e = check(VERSION, "x86_64");
            fs::rename(work.join(f), top.join(f)).unwrap();
            assert_eq!(e, bad, "without {f}");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::rename(top.join("helium"), top.join("helium-real")).unwrap();
            symlink("helium-real", top.join("helium")).unwrap();
            assert_eq!(check(VERSION, "x86_64"), bad, "helium is a link");
            fs::remove_file(top.join("helium")).unwrap();
            fs::rename(top.join("helium-real"), top.join("helium")).unwrap();
            assert_eq!(check(VERSION, "x86_64"), Ok((top.clone(), 4)));
            for target in [
                "../escape",
                "/etc/passwd",
                "locales/en-US.pak",
                "chrome",
                "locales",
                ".",
                "..",
                "missing",
            ] {
                let link = top.join("locales").join("x");
                let at =
                    if target == "locales/en-US.pak" || target == "chrome" || target == "locales" {
                        top.join("x")
                    } else {
                        link.clone()
                    };
                symlink(target, &at).unwrap();
                let e = check(VERSION, "x86_64");
                fs::remove_file(&at).unwrap();
                assert_eq!(e, bad, "x -> {target}");
            }
            fs::write(work.join("escape"), "x").unwrap();
            symlink("../escape", top.join("x")).unwrap();
            assert_eq!(
                check(VERSION, "x86_64"),
                bad,
                "x -> ../escape beside the top folder"
            );
            fs::remove_file(top.join("x")).unwrap();
            fs::remove_file(work.join("escape")).unwrap();
            let fifo = std::ffi::CString::new(top.join("pipe").to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
            assert_eq!(check(VERSION, "x86_64"), bad, "a fifo");
            fs::remove_file(top.join("pipe")).unwrap();
            let real = temp("layout-real");
            fs::rename(&top, real.join("x")).unwrap();
            symlink(real.join("x"), &top).unwrap();
            assert_eq!(
                check(VERSION, "x86_64"),
                bad,
                "a link in the top folder's place"
            );
            fs::remove_dir_all(&real).unwrap();
        }
        fs::remove_dir_all(&work).unwrap();
    }

    #[test]
    fn only_install_dry_run_is_answered() {
        #[cfg(target_os = "macos")]
        assert_eq!(VERBS, crate::browser::VERBS);
        let run_ = |a: &[&str], home: Option<PathBuf>| {
            run(
                &a.iter().map(OsString::from).collect::<Vec<_>>(),
                home.clone(),
                home,
            )
        };
        let home = Some(PathBuf::from("/nowhere"));
        assert_eq!(run_(&[], home.clone()), Some(0));
        assert_eq!(run_(&["--help"], home.clone()), Some(0));
        assert_eq!(run_(&["serve"], home.clone()), None);
        for asked in [
            &["install"][..],
            &["update"],
            &["install", "--dry-run", "--yes"],
            &["status"],
        ] {
            assert_eq!(run_(asked, home.clone()), Some(2), "{asked:?}");
        }
        assert_eq!(run_(&["install", "--dry-run"], None), Some(1));
        assert!(ONLY.ends_with("works on Linux so far."));
    }

    /// The real release, downloaded into a temp cache: it passes, and a copy of the tarball with one changed byte is
    /// refused at the signature check, before anything is unpacked.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn the_real_release_passes_and_a_changed_tarball_is_refused() {
        let cache = temp("live");
        let dir = cache.join("browser");
        let line = system::dry_run(&dir).unwrap();
        let n = line
            .split("Its ")
            .nth(1)
            .and_then(|r| r.split(' ').next())
            .and_then(|n| n.parse::<usize>().ok());
        assert!(n.is_some_and(|n| n >= 200), "{line}");
        assert!(!dir.join("work").exists(), "the unpacked copy was kept");
        assert!(!dir.join("gnupg").exists(), "the keyring folder was kept");
        let got = system::download(&dir).unwrap();
        let changed = cache.join("changed");
        fs::create_dir(&changed).unwrap();
        let mut bytes = fs::read(&got.tarball).unwrap();
        let middle = bytes.len() / 2;
        bytes[middle] ^= 0xff;
        let copy = changed.join(&got.release.name);
        fs::write(&copy, bytes).unwrap();
        let e = system::signature(&changed, &copy, &got.asc).unwrap_err();
        assert_eq!(e.check, "signature", "{}", e.why);
        assert!(
            !changed.join("gnupg").exists(),
            "the keyring folder was kept"
        );
        fs::remove_dir_all(&cache).unwrap();
    }
}
