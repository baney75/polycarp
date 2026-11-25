//! What is synced: typed records, each with a stable key and a stamp, and how two sets of them become one.

use crate::hlc::{Ahead, Clock, Stamp};
use crate::secret::Secret;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// The largest value one record may hold. A browser-bound native message is at most 1 MB.
pub const MAX_VALUE: usize = 256 * 1024;
pub const MAX_KEY: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Cookie,
    Bookmark,
    Extension,
    Setting,
    Tab,
    History,
}

impl Kind {
    pub const ALL: [Kind; 6] = [
        Kind::Cookie,
        Kind::Bookmark,
        Kind::Extension,
        Kind::Setting,
        Kind::Tab,
        Kind::History,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Kind::Cookie => "cookie",
            Kind::Bookmark => "bookmark",
            Kind::Extension => "extension",
            Kind::Setting => "setting",
            Kind::Tab => "tab",
            Kind::History => "history",
        }
    }

    pub fn from_name(name: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.name() == name)
    }
}

/// One value, or its absence: `value` is `None` once the thing was deleted (a tombstone).
/// The value is the item's JSON as the browser gave it, kept whole and private. The key is private too: it holds a
/// cookie's site or a page's address, so `Debug` shows neither.
#[derive(Clone, PartialEq, Eq)]
pub struct Record {
    pub kind: Kind,
    pub key: String,
    pub stamp: Stamp,
    pub value: Option<Secret>,
}

impl fmt::Debug for Record {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Record({})", self.kind.name())
    }
}

impl Record {
    /// Total order of two versions of one record: the later stamp wins; equal stamps (a device that broke the rules)
    /// fall to the tombstone, then to the bytes, so every device picks the same one.
    fn wins_over(&self, other: &Record) -> bool {
        let rank = |r: &Record| (r.stamp, r.value.is_none());
        (rank(self), &self.value) > (rank(other), &other.value)
    }
}

/// The records a device holds. `merge` is commutative, associative and idempotent.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Records(BTreeMap<(Kind, String), Record>);

impl fmt::Debug for Records {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Records({})", self.0.len())
    }
}

impl Records {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes a record in. True when it changed what is held.
    pub fn merge(&mut self, record: Record) -> bool {
        let at = (record.kind, record.key.clone());
        match self.0.get(&at) {
            Some(held) if !record.wins_over(held) => false,
            _ => {
                self.0.insert(at, record);
                true
            }
        }
    }

    pub fn get(&self, kind: Kind, key: &str) -> Option<&Record> {
        self.0.get(&(kind, key.to_string()))
    }

    pub fn iter(&self) -> impl Iterator<Item = &Record> {
        self.0.values()
    }

    /// For a wall clock that was ahead and is right again: gives each record this device stamped too far ahead a stamp
    /// from now, so it can be written over and others take it. Those records, or nothing changed: a stamp from another
    /// device was in bounds when it came, so one that isn't any more says the wall clock may be behind instead.
    pub fn restamp(&mut self, clock: &mut Clock, wall_ms: u64) -> Result<Vec<Record>, Ahead> {
        let mut right = Clock::new(clock.device);
        for r in self.0.values() {
            let seen = right.see(&r.stamp, wall_ms);
            if r.stamp.device != clock.device {
                seen?;
            }
        }
        let mut again = Vec::new();
        for r in self.iter().filter(|r| r.stamp.too_far_ahead(wall_ms)) {
            let mut r = r.clone();
            r.stamp = right.tick(wall_ms)?;
            again.push(r);
        }
        *clock = right;
        let at = again.iter().map(|r| ((r.kind, r.key.clone()), r.clone()));
        self.0.extend(at);
        Ok(again)
    }

    /// Drops every record the test keeps none of: a local clean-up, never synced as a deletion.
    pub fn retain(&mut self, keep: impl Fn(&Record) -> bool) {
        self.0.retain(|_, r| keep(r));
    }
}

/// Why a value was not accepted as an item. It never repeats any of the value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Invalid {
    Shape,
    Key,
    TooBig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub domain: String,
    pub path: String,
    pub name: String,
    pub value: Secret,
    #[serde(default)]
    pub secure: bool,
    /// Seconds since 1970; absent for a session cookie, which ends with the browser.
    pub expires: Option<f64>,
    #[serde(default)]
    pub partitioned: bool,
    /// How browsers say it: any value here means the cookie is partitioned.
    #[serde(default)]
    pub partition_key: Option<serde::de::IgnoredAny>,
    /// The browser side saw this site bind its session to a key on the device.
    #[serde(default)]
    pub device_bound: bool,
}

impl fmt::Debug for Cookie {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Cookie(..)")
    }
}

#[derive(Deserialize)]
struct Named {
    id: String,
}
#[derive(Deserialize)]
struct Setting {
    name: String,
    #[serde(rename = "value")]
    _value: serde::de::IgnoredAny,
}
#[derive(Deserialize)]
struct Page {
    url: String,
}
#[derive(Deserialize)]
struct Tab {
    id: String,
    #[serde(rename = "url")]
    _url: Secret,
}

/// The stable key of an item, from its JSON. It must mean the same thing on every device and in every profile: a
/// cookie's `domain;path;name`, an extension's store id, a setting's name, a page's URL. A bookmark or tab is known by a
/// number only inside one profile, so its `id` is a lower-case UUID the browser side mints once and keeps with it.
pub fn key_of(kind: Kind, json: &[u8]) -> Result<String, Invalid> {
    if json.len() > MAX_VALUE {
        return Err(Invalid::TooBig);
    }
    let key = match kind {
        Kind::Cookie => {
            let c = cookie(json)?;
            format!("{};{};{}", c.domain, c.path, c.name)
        }
        Kind::Bookmark | Kind::Extension => parse::<Named>(json)?.id,
        Kind::Setting => parse::<Setting>(json)?.name,
        Kind::Tab => parse::<Tab>(json)?.id,
        Kind::History => parse::<Page>(json)?.url,
    };
    check_key(kind, &key)?;
    Ok(key)
}

/// A key on its own, as a deletion carries it: the same rules a live item's key meets.
pub fn check_key(kind: Kind, key: &str) -> Result<(), Invalid> {
    let shape = match kind {
        // Exactly three parts, so no part holds ';'. A cookie with no name is legal.
        Kind::Cookie => {
            let part: Vec<&str> = key.split(';').collect();
            part.len() == 3 && !part[0].is_empty() && !part[1].is_empty()
        }
        Kind::Bookmark | Kind::Tab => is_uuid(key),
        Kind::Extension => key.len() == 32 && key.bytes().all(|b| (b'a'..=b'p').contains(&b)),
        Kind::Setting | Kind::History => !key.is_empty(),
    };
    if !shape || key.len() > MAX_KEY || key.chars().any(char::is_control) {
        return Err(Invalid::Key);
    }
    Ok(())
}

fn is_uuid(key: &str) -> bool {
    key.len() == 36
        && key.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

pub fn cookie(json: &[u8]) -> Result<Cookie, Invalid> {
    parse(json)
}

/// serde_json's own error quotes the value it choked on, so it is dropped here and never returned.
fn parse<'a, T: Deserialize<'a>>(json: &'a [u8]) -> Result<T, Invalid> {
    // Read as text: the JSON reader skips over bad bytes in parts it has no use for.
    let text = std::str::from_utf8(json).map_err(|_| Invalid::Shape)?;
    serde_json::from_str(text).map_err(|_| Invalid::Shape)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_stable_and_checked() {
        let c = br#"{"domain":".example.com","path":"/","name":"sid","value":"v","expires":2e9}"#;
        assert_eq!(key_of(Kind::Cookie, c).unwrap(), ".example.com;/;sid");
        let other = br#"{"value":"other","name":"sid","path":"/","domain":".example.com"}"#;
        assert_eq!(key_of(Kind::Cookie, other).unwrap(), ".example.com;/;sid");
        let sly = br#"{"domain":"a.com;/","path":"/","name":"x","value":"v"}"#;
        assert_eq!(key_of(Kind::Cookie, sly), Err(Invalid::Key));
        assert_eq!(
            key_of(Kind::Extension, br#"{"id":"../../etc"}"#),
            Err(Invalid::Key)
        );
        assert_eq!(key_of(Kind::Bookmark, br#"{"id":""}"#), Err(Invalid::Key));
        assert_eq!(
            key_of(Kind::Bookmark, b"{\"id\":\"1\",\"title\":\"\xff\"}"),
            Err(Invalid::Shape)
        );
        assert_eq!(
            key_of(Kind::Setting, br#"{"name":"a"}"#),
            Err(Invalid::Shape)
        );
        assert_eq!(
            key_of(Kind::Bookmark, &vec![b' '; MAX_VALUE + 1]),
            Err(Invalid::TooBig)
        );
    }

    /// Two profiles number their bookmarks and tabs alike, so a number would make two things one.
    #[test]
    fn a_profiles_own_number_is_no_key() {
        let id = "0f8b3c5e-6a1d-4b2f-9c3a-1d2e3f4a5b6c";
        for kind in [Kind::Bookmark, Kind::Tab] {
            let of = |id: &str| key_of(kind, format!(r#"{{"id":"{id}","url":"u"}}"#).as_bytes());
            assert_eq!(of(id).unwrap(), id);
            for bad in ["5", &id[1..], &id.to_uppercase(), &id.replace('-', "0")] {
                assert_eq!(of(bad), Err(Invalid::Key), "{bad}");
            }
        }
    }

    #[test]
    fn a_deletions_key_meets_the_same_rules() {
        let ext = "abcdefghijklmnopabcdefghijklmnop";
        assert_eq!(check_key(Kind::Extension, ext), Ok(()));
        assert_eq!(check_key(Kind::Cookie, ".a.com;/x;"), Ok(()));
        for (kind, bad) in [
            (Kind::Extension, "../../etc"),
            (Kind::Extension, &ext[1..]),
            (Kind::Cookie, "nonsense"),
            (Kind::Cookie, ";/;n"),
            (Kind::Cookie, "a.com;;n"),
            (Kind::Cookie, "a.com;/;n;x"),
            (Kind::Bookmark, "5"),
            (Kind::Setting, ""),
            (Kind::History, "a\nb"),
        ] {
            assert_eq!(check_key(kind, bad), Err(Invalid::Key), "{bad:?}");
        }
    }

    #[test]
    fn a_bad_value_is_never_repeated() {
        let bad =
            br#"{"domain":"a.com","path":"/","name":"sid","value":"v","secure":"planted-value"}"#;
        let e = cookie(bad).unwrap_err();
        assert!(!format!("{e:?}").contains("planted"));
        let ok = cookie(
            br#"{"domain":"planted.com","path":"/","name":"planted","value":"planted-value"}"#,
        );
        assert!(!format!("{ok:?}").contains("planted"));
        let stamp = Stamp {
            ms: 1,
            count: 0,
            device: [0; 32],
        };
        let (key, value) = (
            "https://planted.example/".into(),
            Some(Secret::new(b"planted".to_vec())),
        );
        let page = Record {
            kind: Kind::History,
            key,
            stamp,
            value,
        };
        assert!(!format!("{page:?}").contains("planted"));
        let mut all = Records::new();
        all.merge(page);
        assert!(!format!("{all:?}").contains("planted"));
    }
}
