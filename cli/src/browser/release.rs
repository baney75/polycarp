//! Which Helium release is newest, read from GitHub's release list.

use std::ffi::OsStr;
use std::time::Duration;

use serde::Deserialize;

use super::tools::{must, Call, Tools};
use super::Refused;

const FEED: &str = "https://api.github.com/repos/imputnet/helium-macos/releases/latest";
const DOWNLOADS: &str = "https://github.com/imputnet/helium-macos/releases/download";
/// Bytes. A release is about 120 MB.
const LARGEST: &str = "734003200";
const CHECK: &str = "release";

#[derive(Debug, PartialEq)]
pub struct Release {
    pub version: String,
    pub name: String,
    pub url: String,
    /// Lowercase hex, from the release itself.
    pub sha256: String,
}

#[derive(Deserialize)]
struct Listed {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    assets: Vec<ListedAsset>,
}

#[derive(Deserialize)]
struct ListedAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}

/// `curl`, https only, without the person's own curl settings.
pub fn curl(limit: u64, more: &[&dyn AsRef<OsStr>]) -> Call {
    let options =
        "-q --fail --silent --show-error --location --proto =https --proto-redir =https --tlsv1.2 \
                   --retry 2 --connect-timeout 20 --user-agent polycarp-browser --max-filesize";
    let mut call = Call::new("/usr/bin/curl", &[]);
    call.args = options.split_whitespace().map(Into::into).collect();
    call.args.extend([LARGEST.into(), "--max-time".into()]);
    call.args.push(limit.to_string().into());
    call.args.extend(more.iter().map(|a| a.as_ref().to_owned()));
    call.limit = Duration::from_secs(limit * 3 + 60);
    call
}

pub fn newest(tools: &dyn Tools, arch: &str) -> Result<Release, Refused> {
    let accept = "Accept: application/vnd.github+json";
    let call = curl(60, &[&"--header", &accept, &"--", &FEED]);
    let ran = must(tools, "release", &call)?;
    parse(&ran.out, arch)
}

/// The release for this processor. The address and file name are spelled out here and must match, so a changed
/// listing can't point the download anywhere else.
pub fn parse(json: &str, arch: &str) -> Result<Release, Refused> {
    let listed: Listed = serde_json::from_str(json)
        .map_err(|e| Refused::new(CHECK, format!("GitHub's answer was not a release: {e}")))?;
    if listed.draft || listed.prerelease {
        return Err(Refused::new(CHECK, "the newest one is not a full release"));
    }
    let version = listed.tag_name;
    if parts(&version).is_none() {
        return Err(Refused::new(CHECK, "its version is not a version number"));
    }
    let name = format!("helium_{version}_{arch}-macos.dmg");
    let Some(asset) = listed.assets.into_iter().find(|a| a.name == name) else {
        return Err(Refused::new(CHECK, format!("{version} has no {name}")));
    };
    let url = format!("{DOWNLOADS}/{version}/{name}");
    if asset.browser_download_url != url {
        return Err(Refused::new(CHECK, "its download is at another address"));
    }
    let sha256 = asset.digest.as_deref().and_then(|d| {
        let hex = d.strip_prefix("sha256:")?;
        let is_hex = hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit());
        is_hex.then(|| hex.to_ascii_lowercase())
    });
    let Some(sha256) = sha256 else {
        return Err(Refused::new(CHECK, "it lists no sha256 digest"));
    };
    Ok(Release {
        version,
        name,
        url,
        sha256,
    })
}

/// `0.22.4.1` as numbers; None for anything else.
pub fn parts(version: &str) -> Option<Vec<u32>> {
    let short = version.len() <= 40 && version.contains('.');
    let digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    if !short || !version.split('.').all(digits) {
        return None;
    }
    version.split('.').map(|p| p.parse().ok()).collect()
}

/// The processor, as Helium's file names spell it. A command running under Rosetta still gets the Mac's own.
pub fn this_arch() -> &'static str {
    let mut arm: libc::c_int = 0;
    let mut size = std::mem::size_of_val(&arm);
    let name = c"hw.optional.arm64".as_ptr();
    let at = (&mut arm as *mut libc::c_int).cast();
    // SAFETY: `at` points at `size` writable bytes, and nothing is being set.
    let rc = unsafe { libc::sysctlbyname(name, at, &mut size, std::ptr::null_mut(), 0) };
    if rc == 0 && arm == 1 {
        "arm64"
    } else {
        "x86_64"
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::{feed, VERSION};
    use super::*;

    #[test]
    fn the_newest_release_for_each_processor() {
        for arch in ["arm64", "x86_64"] {
            let r = parse(&feed(&"ab".repeat(32)), arch).unwrap();
            assert_eq!(r.version, VERSION);
            assert_eq!(r.name, format!("helium_{VERSION}_{arch}-macos.dmg"));
            assert_eq!(r.sha256, "ab".repeat(32));
        }
    }

    #[test]
    fn a_listing_that_is_off_is_refused() {
        for (from, to, why) in [
            ("{\"tag_name\"", "not json", "not a release"),
            ("\"draft\":false", "\"draft\":true", "full release"),
            (
                "\"prerelease\":false",
                "\"prerelease\":true",
                "full release",
            ),
            ("\"0.22.4.1\"", "\"../../x\"", "version number"),
            ("_arm64-macos.dmg", "_arm64-macos.zip", "has no"),
            ("github.com/imputnet", "github.com/other", "another address"),
            ("https://", "http://", "another address"),
            ("sha256:ab", "sha256:zz", "no sha256"),
            ("sha256:ab", "sha256:", "no sha256"),
            ("\"sha256:", "\"md5:", "no sha256"),
            ("\"digest\":", "\"was\":", "no sha256"),
        ] {
            let json = feed(&"ab".repeat(32)).replace(from, to);
            let e = parse(&json, "arm64").unwrap_err();
            assert!(e.why.contains(why), "{e} should say {why}");
        }
    }

    #[test]
    fn version_numbers_only() {
        assert_eq!(parts("0.22.4.1"), Some(vec![0, 22, 4, 1]));
        for bad in [
            "",
            "1",
            "1..2",
            "v1.2",
            "1.2-b",
            "1.2/..",
            "1.99999999999",
            "+1.2",
        ] {
            assert_eq!(parts(bad), None, "{bad}");
        }
    }
}
