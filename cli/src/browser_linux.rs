//! Polycarp Browser on Linux, step one: `polycarp browser install --dry-run` downloads Helium's newest Linux
//! release, checks its sha256 and Helium's OpenPGP signature on it, unpacks it into a work folder, checks its
//! layout and throws it away. Nothing is installed and nothing from the release is run. The rules are in
//! `../browser/AGENTS.md`.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;

// What Windows and Linux share, loaded the way browser_windows.rs loads it.
#[allow(clippy::duplicate_mod)]
#[path = "browser/dry.rs"]
mod dry;
// The Mac, Windows and Linux share one copy of the listing code, so a test build loads it more than once on
// purpose. Linux does not read every field.
#[allow(clippy::duplicate_mod)]
#[allow(dead_code)]
#[path = "browser/listing.rs"]
mod listing;

use dry::{is_link, refuse, relative, Refused};
use listing::Release;

const DOWNLOADS: &str = "https://github.com/imputnet/helium-linux/releases/download";
/// Helium's public signing key, byte for byte as `pubkey.asc` in imputnet/helium-linux publishes it.
const KEY: &str = include_str!("browser/helium-linux.asc");
/// The primary key every release must be signed under. The test `the_committed_key_is_the_pinned_one` proves
/// `KEY` is this key.
const FINGERPRINT: &str = "BE677C1989D35EAB2C5F26C9351601AD01D6378E";

/// Helium's name for this processor.
fn arch_name(arch: &str) -> Result<&'static str, Refused> {
    match arch {
        "x86_64" => Ok("x86_64"),
        "aarch64" => Ok("arm64"),
        _ => Err(Refused::new("processor", "no Helium for this processor")),
    }
}

/// The newest release's tarball and the signature on it, each at its own address with the sha256 GitHub lists.
fn parse(json: &str, arch: &str) -> Result<(Release, Release), Refused> {
    let tarball = |version: &str| format!("helium-{version}-{arch}_linux.tar.xz");
    let listed = |name: &dyn Fn(&str) -> String| {
        listing::parse(json, DOWNLOADS, name).map_err(|why| Refused::new("release", why))
    };
    Ok((
        listed(&tarball)?,
        listed(&|version| format!("{}.asc", tarball(version)))?,
    ))
}

/// One of the release's two files with its own digest. Tarballs and signatures of other versions or processors,
/// and halves of downloads, are removed; `other`, the second file of this release, stays.
fn fetch(
    release: &Release,
    other: &Release,
    dir: &Path,
    download: &dyn Fn(&Path) -> Result<(), Refused>,
) -> Result<PathBuf, Refused> {
    let old = |name: &str| {
        name.starts_with("helium-") && name.contains("_linux.tar.xz") && name != other.name
    };
    dry::fetch(release, dir, download, &old)
}

/// The binary key inside an armored OpenPGP key block, when its CRC24 checksum matches.
fn dearmor(armored: &str) -> Result<Vec<u8>, Refused> {
    let bad = |why: &str| Refused::new("signature", format!("Helium's key {why}"));
    let mut lines = armored.lines().map(|l| l.trim_end_matches('\r'));
    if lines.next() != Some("-----BEGIN PGP PUBLIC KEY BLOCK-----") {
        return Err(bad("does not begin as a public key block"));
    }
    // Header lines such as `Comment: ...`, up to the blank line.
    for line in lines.by_ref() {
        if line.trim().is_empty() {
            break;
        }
        if !line.contains(": ") {
            return Err(bad("has a header line that is not one"));
        }
    }
    let (mut body, mut sum, mut ended) = (String::new(), None, false);
    for line in lines.by_ref() {
        if line == "-----END PGP PUBLIC KEY BLOCK-----" {
            ended = true;
            break;
        }
        match (line.strip_prefix('='), sum) {
            (Some(crc), None) => sum = Some(crc),
            (None, None) => body.push_str(line.trim()),
            _ => return Err(bad("has text after its checksum")),
        }
    }
    let (true, Some(sum)) = (ended, sum) else {
        return Err(bad("has no checksum or no END line"));
    };
    if lines.any(|l| !l.trim().is_empty()) {
        return Err(bad("has text after its END line"));
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    let key = b64.decode(&body).map_err(|_| bad("is not base64"))?;
    let sum = b64.decode(sum).map_err(|_| bad("checksum is not base64"))?;
    let [a, b, c] = sum[..] else {
        return Err(bad("checksum is not three bytes"));
    };
    if crc24(&key) != u32::from_be_bytes([0, a, b, c]) {
        return Err(bad("does not match its checksum"));
    }
    Ok(key)
}

/// The armor's checksum, as RFC 4880 section 6.1 spells it.
fn crc24(bytes: &[u8]) -> u32 {
    let mut crc: u32 = 0xB7_04CE;
    for &byte in bytes {
        crc ^= u32::from(byte) << 16;
        for _ in 0..8 {
            crc <<= 1;
            if crc & 0x100_0000 != 0 {
                crc ^= 0x186_4CFB;
            }
        }
    }
    crc & 0xFF_FFFF
}

/// What `gpgv --status-fd 1` printed, with its exit code, judged. It passes only for one good signature whose
/// primary key is `FINGERPRINT`. gpgv checks the signature against the one key it is given and nothing more: it does
/// not check whether that key expired or was revoked since, as Windows checks no revocation either.
fn judge(status: &str, exit: Option<i32>) -> Result<(), Refused> {
    let bad = |why: String| Refused::new("signature", why);
    let lines: Vec<Vec<&str>> = status
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>())
        .filter(|t| t.first() == Some(&"[GNUPG:]") && t.len() > 1)
        .collect();
    let said = |word: &str| lines.iter().filter(|t| t[1] == word).collect::<Vec<_>>();
    for word in [
        "BADSIG",
        "ERRSIG",
        "EXPSIG",
        "EXPKEYSIG",
        "REVKEYSIG",
        "NO_PUBKEY",
    ] {
        if !said(word).is_empty() {
            return Err(bad(format!("gpgv said {word}")));
        }
    }
    if exit != Some(0) {
        return Err(bad(format!("gpgv refused it (exit {exit:?})")));
    }
    let signatures = said("NEWSIG").len();
    if signatures != 1 {
        return Err(bad(format!(
            "the release has {signatures} signatures, not one"
        )));
    }
    if said("GOODSIG").len() != 1 {
        return Err(bad("gpgv did not call the signature good".into()));
    }
    let primary = match said("VALIDSIG")[..] {
        [tokens] if tokens.len() == 12 => tokens[11].to_ascii_uppercase(),
        _ => return Err(bad("gpgv's VALIDSIG line was not understood".into())),
    };
    if primary != FINGERPRINT {
        return Err(bad(format!("it is signed by another key, {primary}")));
    }
    Ok(())
}

/// The number of plain files in the unpacked release, when `unpacked` holds exactly Helium's one folder with its
/// program and desktop file, walked without following links. A link may only name a plain file beside it; any
/// other link, and any fifo, socket or device, is a refusal.
fn laid_out(unpacked: &Path, version: &str, arch: &str) -> Result<usize, Refused> {
    let bad = |why: String| Refused::new("layout", why);
    let reading = || refuse("layout", "reading the release");
    let top = format!("helium-{version}-{arch}_linux");
    let entries = fs::read_dir(unpacked).map_err(reading())?;
    let entries = entries.collect::<Result<Vec<_>, _>>().map_err(reading())?;
    let folder = unpacked.join(&top);
    let plain = |p: &Path, dir: bool| {
        fs::symlink_metadata(p)
            .is_ok_and(|m| !is_link(&m) && if dir { m.is_dir() } else { m.is_file() })
    };
    if entries.len() != 1 || entries[0].file_name() != top.as_str() || !plain(&folder, true) {
        return Err(bad(format!(
            "the tarball does not hold exactly one folder, {top}"
        )));
    }
    if !fs::symlink_metadata(folder.join("helium")).is_ok_and(|m| !is_link(&m) && runnable(&m)) {
        return Err(bad("helium is not a program in it".into()));
    }
    if !plain(&folder.join("helium.desktop"), false) {
        return Err(bad("it has no helium.desktop".into()));
    }
    let (mut files, mut folders) = (0, vec![folder.clone()]);
    while let Some(dir) = folders.pop() {
        for entry in fs::read_dir(&dir).map_err(reading())? {
            let path = entry.map_err(reading())?.path();
            let meta = fs::symlink_metadata(&path).map_err(reading())?;
            let rel = relative(&folder, &path);
            if is_link(&meta) {
                let to = fs::read_link(&path).map_err(reading())?;
                let name = to.to_str().unwrap_or("");
                let beside = !name.is_empty() && !name.contains('/') && name != "." && name != "..";
                if !beside || !plain(&dir.join(name), false) {
                    let why = format!("{rel} links to {}, not to a file beside it", to.display());
                    return Err(bad(why));
                }
            } else if meta.is_dir() {
                folders.push(path);
            } else if meta.is_file() {
                files += 1;
            } else {
                return Err(bad(format!("{rel} is not a file, folder or link")));
            }
        }
    }
    Ok(files)
}

/// A plain file with an execute bit.
fn runnable(meta: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    const VERSION: &str = "0.22.5.1";

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("polycarp-bl-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A trimmed copy of the real listing, with made-up digests.
    fn feed(digest: &str) -> String {
        let asset = |end: &str| {
            let name = format!("helium-{VERSION}-{end}");
            let url = format!("{DOWNLOADS}/{VERSION}/{name}");
            format!("{{\"name\":\"{name}\",\"browser_download_url\":\"{url}\",\"digest\":\"sha256:{digest}\"}}")
        };
        let ends = [
            "arm64.AppImage",
            "arm64_linux.tar.xz",
            "arm64_linux.tar.xz.asc",
            "x86_64.AppImage",
            "x86_64_linux.tar.xz",
            "x86_64_linux.tar.xz.asc",
        ];
        let assets = ends.map(asset).join(",");
        format!("{{\"tag_name\":\"{VERSION}\",\"draft\":false,\"prerelease\":false,\"assets\":[{assets}]}}")
    }

    #[test]
    fn the_newest_linux_tarball_and_its_signature_for_each_processor() {
        for arch in ["x86_64", "arm64"] {
            let (tarball, signature) = parse(&feed(&"AB".repeat(32)), arch).unwrap();
            assert_eq!(
                tarball.name,
                format!("helium-{VERSION}-{arch}_linux.tar.xz")
            );
            assert_eq!(signature.name, format!("{}.asc", tarball.name));
            let at = "https://github.com/imputnet/helium-linux/releases/download/0.22.5.1/";
            for r in [&tarball, &signature] {
                assert_eq!(r.url, format!("{at}{}", r.name));
                assert_eq!(r.sha256, "ab".repeat(32));
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
        let no_tarball = "has no helium-0.22.5.1-x86_64_linux.tar.xz";
        let no_asc = "has no helium-0.22.5.1-x86_64_linux.tar.xz.asc";
        for (from, to, why) in [
            ("{\"tag_name\"", "not json", "not a release"),
            ("\"draft\":false", "\"draft\":true", "full release"),
            (
                "\"prerelease\":false",
                "\"prerelease\":true",
                "full release",
            ),
            ("\"0.22.5.1\"", "\"../../x\"", "version number"),
            ("_linux.tar.xz\"", "_linux.tar.gz\"", no_tarball),
            (".tar.xz.asc\"", ".tar.xz.sig\"", no_asc),
            (
                "github.com/imputnet",
                "example.com/imputnet",
                "another address",
            ),
            (
                "helium-linux/releases",
                "helium-macos/releases",
                "another address",
            ),
            ("https://", "http://", "another address"),
            ("sha256:ab", "sha256:zz", "no sha256"),
            ("\"sha256:", "\"md5:", "no sha256"),
            ("\"digest\":", "\"was\":", "no sha256"),
        ] {
            let json = feed(&"ab".repeat(32)).replace(from, to);
            let e = parse(&json, "x86_64").unwrap_err();
            assert_eq!(e.check, "release");
            assert!(e.why.contains(why), "{from}: {} should say {why}", e.why);
        }
    }

    #[test]
    fn each_download_is_kept_only_while_its_digest_matches() {
        let dir = temp("fetch");
        let mine = [
            "helium-0.1.0.0-x86_64_linux.tar.xz",
            "helium-0.1.0.0-x86_64_linux.tar.xz.asc",
            "helium-0.22.5.1-arm64_linux.tar.xz",
            "helium-0.22.5.1-x86_64_linux.tar.xz.part",
        ];
        for f in mine.iter().chain(&["notes.txt"]) {
            fs::write(dir.join(f), "old").unwrap();
        }
        let sha = |body: &str| {
            Sha256::digest(body)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        let (mut tarball, mut signature) = parse(&feed(&"00".repeat(32)), "x86_64").unwrap();
        (tarball.sha256, signature.sha256) = (sha("a tarball"), sha("a signature"));
        let count = std::cell::Cell::new(0);
        let get = |body: &'static str| {
            let count = &count;
            move |part: &Path| {
                count.set(count.get() + 1);
                fs::write(part, body).map_err(refuse("download", "writing"))
            }
        };
        let both = || {
            let t = fetch(&tarball, &signature, &dir, &get("a tarball")).unwrap();
            let s = fetch(&signature, &tarball, &dir, &get("a signature")).unwrap();
            (t, s)
        };
        let (t, s) = both();
        both();
        assert_eq!(count.get(), 2, "a good cached file was downloaded again");
        let mut left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [t.clone(), s, dir.join("notes.txt")],
            "older files are not kept"
        );
        fs::write(&t, "changed after it was downloaded").unwrap();
        both();
        assert_eq!(count.get(), 3);
        fs::remove_dir_all(&dir).unwrap();
        fs::create_dir(&dir).unwrap();
        tarball.sha256 = "00".repeat(32);
        let e = fetch(&tarball, &signature, &dir, &get("a tarball")).unwrap_err();
        assert_eq!(e.check, "digest");
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            0,
            "a refused download was kept"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// What gpgv 2.4.9 printed for the real 0.22.5.1 tarball and Helium's key.
    const GOOD: &str = "[GNUPG:] NEWSIG
[GNUPG:] KEY_CONSIDERED BE677C1989D35EAB2C5F26C9351601AD01D6378E 0
[GNUPG:] SIG_ID +N4wQuCxxSBzYu1VLs0+OlIoEB0 2026-11-25 1795640525
[GNUPG:] GOODSIG 351601AD01D6378E Helium signing key (https://helium.computer/) <helium@imput.net>
[GNUPG:] VALIDSIG BE677C1989D35EAB2C5F26C9351601AD01D6378E 2026-11-25 1795640525 0 4 0 22 10 00 BE677C1989D35EAB2C5F26C9351601AD01D6378E
";

    #[test]
    fn only_one_good_signature_from_helium_s_key_passes() {
        assert_eq!(judge(GOOD, Some(0)), Ok(()));
        let refused = |status: &str, exit: Option<i32>| {
            let e = judge(status, exit).unwrap_err();
            assert_eq!(e.check, "signature");
            e.why
        };
        assert!(refused(GOOD, Some(2)).contains("exit"));
        assert!(refused(GOOD, None).contains("exit"));
        let other = "0123456789ABCDEF0123456789ABCDEF01234567";
        let at_end = format!("00 {FINGERPRINT}\n");
        let lower = GOOD.replace(&at_end, &format!("00 {}\n", FINGERPRINT.to_lowercase()));
        assert_eq!(judge(&lower, Some(0)), Ok(()), "hex in lowercase");
        let moved = GOOD.replace(&at_end, &format!("00 {other}\n"));
        assert!(refused(&moved, Some(0)).contains("another key"));
        let short = GOOD.replace(&at_end, "00\n");
        assert!(refused(&short, Some(0)).contains("VALIDSIG"), "11 tokens");
        let long = GOOD.replace(&at_end, &format!("00 {FINGERPRINT} x\n"));
        assert!(refused(&long, Some(0)).contains("VALIDSIG"), "13 tokens");
        let twice = format!("{GOOD}{GOOD}");
        assert!(refused(&twice, Some(0)).contains("2 signatures"));
        let unsaid = GOOD.replace("GOODSIG", "SAIDSIG");
        assert!(refused(&unsaid, Some(0)).contains("good"));
        assert!(refused("", Some(0)).contains("0 signatures"));
        for word in [
            "BADSIG",
            "ERRSIG",
            "EXPSIG",
            "EXPKEYSIG",
            "REVKEYSIG",
            "NO_PUBKEY",
        ] {
            let added = format!("{GOOD}[GNUPG:] {word} 351601AD01D6378E\n");
            assert_eq!(refused(&added, Some(0)), format!("gpgv said {word}"));
        }
        // gpgv 2.4.9 given the armored key instead of the binary one.
        let armored = "[GNUPG:] NEWSIG
[GNUPG:] ERRSIG 351601AD01D6378E 22 10 00 1795640525 9 BE677C1989D35EAB2C5F26C9351601AD01D6378E
[GNUPG:] NO_PUBKEY 351601AD01D6378E
";
        assert!(refused(armored, Some(2)).contains("ERRSIG"));
    }

    #[test]
    fn the_committed_key_is_the_pinned_one() {
        use sha1::Sha1;
        let key = dearmor(KEY).unwrap();
        // The first packet is the primary public key: new format, tag 6, with a one-byte length.
        let (tag, len) = (key[0], usize::from(key[1]));
        assert_eq!(tag, 0xC6, "a public key packet in the new format");
        assert!(len < 192);
        let body = &key[2..2 + len];
        assert_eq!(body[0], 4, "a version 4 key");
        let mut sha = Sha1::new();
        sha.update([0x99]);
        sha.update(u16::try_from(len).unwrap().to_be_bytes());
        sha.update(body);
        let fingerprint: String = sha.finalize().iter().map(|b| format!("{b:02X}")).collect();
        assert_eq!(fingerprint, FINGERPRINT);
    }

    #[test]
    fn an_armored_key_must_match_its_checksum() {
        assert_eq!(crc24(b""), 0xB7_04CE);
        let changed = KEY.replacen("xjMEaOqh", "xjMEaOqi", 1);
        assert_ne!(changed, KEY);
        assert_eq!(
            dearmor(&changed).unwrap_err().why,
            "Helium's key does not match its checksum"
        );
        let no_crc: String = KEY
            .lines()
            .filter(|l| !l.starts_with('='))
            .map(|l| format!("{l}\n"))
            .collect();
        assert!(dearmor(&no_crc).is_err());
        assert!(dearmor("not a key").is_err());
        let after = format!("{KEY}more\n");
        assert!(dearmor(&after).unwrap_err().why.contains("after its END"));
    }

    /// Helium's layout in small: the program, its desktop file, a link beside it and a folder of data.
    #[cfg(unix)]
    fn helium(work: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let top = work.join(format!("helium-{VERSION}-x86_64_linux"));
        fs::create_dir_all(top.join("locales")).unwrap();
        for f in ["helium", "helium.desktop", "locales/en-US.pak"] {
            fs::write(top.join(f), "x").unwrap();
        }
        fs::set_permissions(top.join("helium"), fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("helium", top.join("chrome")).unwrap();
        top
    }

    #[cfg(unix)]
    #[test]
    fn only_helium_s_own_layout_is_unpacked() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let work = temp("layout");
        let top = helium(&work);
        let check = |version: &str, arch: &str| {
            laid_out(&work, version, arch).map_err(|e| {
                assert_eq!(e.check, "layout");
                e.why
            })
        };
        assert_eq!(check(VERSION, "x86_64"), Ok(3));
        let one = "the tarball does not hold exactly one folder";
        assert!(
            check("0.22.5.2", "x86_64").unwrap_err().starts_with(one),
            "another version"
        );
        assert!(
            check(VERSION, "arm64").unwrap_err().starts_with(one),
            "another processor"
        );
        fs::write(work.join("extra"), "x").unwrap();
        assert!(
            check(VERSION, "x86_64").unwrap_err().starts_with(one),
            "two entries"
        );
        fs::remove_file(work.join("extra")).unwrap();
        let mode = |m: u32| {
            fs::set_permissions(top.join("helium"), fs::Permissions::from_mode(m)).unwrap()
        };
        mode(0o644);
        assert!(check(VERSION, "x86_64")
            .unwrap_err()
            .contains("not a program"));
        mode(0o755);
        for f in ["helium", "helium.desktop"] {
            fs::rename(top.join(f), work.join("aside")).unwrap();
            let e = check(VERSION, "x86_64");
            fs::rename(work.join("aside"), top.join(f)).unwrap();
            assert!(e.is_err(), "without {f}");
        }
        symlink("helium.desktop", top.join("desktop")).unwrap();
        assert_eq!(
            check(VERSION, "x86_64"),
            Ok(3),
            "a link to a file beside it"
        );
        fs::remove_file(top.join("desktop")).unwrap();
        for to in [
            "../x",
            "/etc/passwd",
            "locales/en-US.pak",
            "missing",
            "locales",
            ".",
            "..",
        ] {
            symlink(to, top.join("bad")).unwrap();
            let e = check(VERSION, "x86_64").unwrap_err();
            fs::remove_file(top.join("bad")).unwrap();
            assert!(e.contains("not to a file beside it"), "{to}: {e}");
        }
        let fifo = std::ffi::CString::new(
            top.join("locales/pipe")
                .into_os_string()
                .into_encoded_bytes(),
        )
        .unwrap();
        // SAFETY: a valid, NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(check(VERSION, "x86_64")
            .unwrap_err()
            .contains("is not a file, folder or link"));
        fs::remove_file(top.join("locales/pipe")).unwrap();
        let real = temp("layout-real");
        fs::rename(&top, real.join("x")).unwrap();
        symlink(real.join("x"), &top).unwrap();
        assert!(
            check(VERSION, "x86_64").unwrap_err().starts_with(one),
            "a link in its place"
        );
        fs::remove_dir_all(&real).unwrap();
        fs::remove_dir_all(&work).unwrap();
    }
}
