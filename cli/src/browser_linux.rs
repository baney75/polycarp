//! Polycarp Browser on Linux, step one: `polycarp browser install --dry-run` downloads Helium's newest Linux
//! release, checks its sha256 and Helium's OpenPGP signature on it, unpacks it into a work folder, checks its
//! layout and throws it away. Nothing is installed and nothing from the release is run. The rules are in
//! `../browser/AGENTS.md`.

use std::fs;
use std::path::{Path, PathBuf};

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
