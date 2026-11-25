//! What is synced: typed records, each with a stable key and a stamp, and how two sets of them become one.

use crate::hlc::Stamp;
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

#[derive(Serialize, Deserialize)]
struct Plain<'a> {
    kind: Kind,
    key: &'a str,
    stamp: Stamp,
    value: Option<&'a [u8]>,
}

impl Record {
    /// For sealing: it goes to disk and to other devices in no other form.
    pub fn to_bytes(&self) -> Secret {
        let value = self.value.as_ref().map(Secret::expose);
        let plain = Plain {
            kind: self.kind,
            key: &self.key,
            stamp: self.stamp,
            value,
        };
        Secret::new(postcard::to_stdvec(&plain).expect("a record is plain data"))
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Record, Invalid> {
        let (p, rest) = postcard::take_from_bytes::<Plain>(bytes).map_err(|_| Invalid::Shape)?;
        if !rest.is_empty() {
            return Err(Invalid::Shape);
        }
        let value = p.value.map(|v| Secret::new(v.to_vec()));
        Ok(Record {
            kind: p.kind,
            key: p.key.to_string(),
            stamp: p.stamp,
            value,
        })
    }

    /// A record from another device: its key must be the one its value gives, or an item could stand under the name of
    /// another.
    pub fn check(&self) -> Result<(), Invalid> {
        match &self.value {
            Some(v) if key_of(self.kind, v.expose())? != self.key => Err(Invalid::Key),
            _ => check_key(&self.key),
        }
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

/// The stable key of an item, from its JSON.
pub fn key_of(kind: Kind, json: &[u8]) -> Result<String, Invalid> {
    if json.len() > MAX_VALUE {
        return Err(Invalid::TooBig);
    }
    let key = match kind {
        Kind::Cookie => {
            let c = cookie(json)?;
            let part = |s: &str| s.is_empty() || s.contains(';');
            // A cookie with no name is legal and can't hold ';' either.
            if part(&c.domain) || part(&c.path) || c.name.contains(';') {
                return Err(Invalid::Key);
            }
            format!("{};{};{}", c.domain, c.path, c.name)
        }
        Kind::Bookmark => parse::<Named>(json)?.id,
        Kind::Extension => {
            let id = parse::<Named>(json)?.id;
            if id.len() != 32 || !id.bytes().all(|b| (b'a'..=b'p').contains(&b)) {
                return Err(Invalid::Key);
            }
            id
        }
        Kind::Setting => parse::<Setting>(json)?.name,
        Kind::Tab => parse::<Tab>(json)?.id,
        Kind::History => parse::<Page>(json)?.url,
    };
    check_key(&key)?;
    Ok(key)
}

/// A key on its own, as a deletion carries it.
pub fn check_key(key: &str) -> Result<(), Invalid> {
    if key.is_empty() || key.len() > MAX_KEY || key.chars().any(char::is_control) {
        return Err(Invalid::Key);
    }
    Ok(())
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
