//! Which Helium release is newest, read from GitHub's release list.

use std::ffi::OsStr;
use std::time::Duration;

use super::listing;
pub use super::listing::{parts, Release};
use super::tools::{must, Call, Tools};
use super::Refused;

const FEED: &str = "https://api.github.com/repos/imputnet/helium-macos/releases/latest";
const DOWNLOADS: &str = "https://github.com/imputnet/helium-macos/releases/download";
/// Bytes. A release is about 120 MB.
const LARGEST: &str = "734003200";
const CHECK: &str = "release";

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

/// The release for this processor.
pub fn parse(json: &str, arch: &str) -> Result<Release, Refused> {
    let name = |version: &str| format!("helium_{version}_{arch}-macos.dmg");
    listing::parse(json, DOWNLOADS, name).map_err(|why| Refused::new(CHECK, why))
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
}
