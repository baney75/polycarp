//! A Helium release as GitHub lists it, for the Mac and for Windows alike. Pure: no tools, no files.

use serde::Deserialize;

#[derive(Debug, PartialEq)]
pub struct Release {
    pub version: String,
    pub name: String,
    pub url: String,
    /// Lowercase hex, from the release itself.
    pub sha256: String,
    /// The day it came out, counted from 1970.
    pub published: Option<i64>,
    /// The download's size in bytes, when GitHub lists it.
    pub size: Option<u64>,
}

#[derive(Deserialize)]
struct Listed {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<ListedAsset>,
}

#[derive(Deserialize)]
struct ListedAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

/// The release whose file is `name(version)`, under `downloads`. The address and file name are spelled out here and
/// must match, so a changed listing can't point the download anywhere else.
pub fn parse(
    json: &str,
    downloads: &str,
    name: impl Fn(&str) -> String,
) -> Result<Release, String> {
    let listed: Listed = serde_json::from_str(json)
        .map_err(|e| format!("GitHub's answer was not a release: {e}"))?;
    if listed.draft || listed.prerelease {
        return Err("the newest one is not a full release".into());
    }
    let version = listed.tag_name;
    if parts(&version).is_none() {
        return Err("its version is not a version number".into());
    }
    let name = name(&version);
    let Some(asset) = listed.assets.into_iter().find(|a| a.name == name) else {
        return Err(format!("{version} has no {name}"));
    };
    let url = format!("{downloads}/{version}/{name}");
    if asset.browser_download_url != url {
        return Err("its download is at another address".into());
    }
    let sha256 = asset.digest.as_deref().and_then(|d| {
        let hex = d.strip_prefix("sha256:")?;
        let is_hex = hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit());
        is_hex.then(|| hex.to_ascii_lowercase())
    });
    let Some(sha256) = sha256 else {
        return Err("it lists no sha256 digest".into());
    };
    Ok(Release {
        version,
        name,
        url,
        sha256,
        published: listed.published_at.as_deref().and_then(day),
        size: asset.size,
    })
}

/// `2026-11-20T17:03:00Z` as days since 1970.
fn day(stamp: &str) -> Option<i64> {
    let mut parts = stamp.get(..10)?.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    if !(1970..3000).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // March first: leap days fall at the end of a year counted this way.
    let (y, m) = if m > 2 { (y, m - 3) } else { (y - 1, m + 9) };
    Some(365 * y + y / 4 - y / 100 + y / 400 + (153 * m + 2) / 5 + d - 719_469)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_day_a_release_came_out() {
        for (stamp, n) in [
            ("1970-01-01T00:00:00Z", Some(0)),
            ("2024-02-29T10:00:00Z", Some(19_782)),
            ("2026-11-25", Some(20_782)),
            ("2026-13-25", None),
            ("soon", None),
            ("\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}", None),
        ] {
            assert_eq!(day(stamp), n, "{stamp}");
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
