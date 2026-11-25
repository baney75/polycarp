//! What this device agrees to send and take: a switch per type, an exclude list, and the cookies that never move.

use crate::record::{check_key, cookie, key_of, Cookie, Invalid, Kind, Record};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeSet;
use std::fmt;

/// A `Secure` cookie with less life than this is a device-bound session's: the site renews it every few minutes with
/// a key that stays on the device (Device Bound Session Credentials), so a copy is dead on arrival.
const SHORT_LIFE_SECS: f64 = 15.0 * 60.0;

/// Cookies bound to one device or one network address, known by name. A copy does not sign anyone in, and some sites
/// end the session they came from when they see it twice.
const BOUND: [&str; 6] = [
    "__Secure-1PSIDTS",
    "__Secure-3PSIDTS",
    "__Secure-1PSIDRTS",
    "__Secure-3PSIDRTS",
    "cf_clearance",
    "__cf_bm",
];

/// Why a record stays on the device it came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Skip {
    TypeOff,
    ExcludedSite,
    /// A session cookie: it ends with the browser. Banks sign people in with these, so none of them move.
    Session,
    Partitioned,
    DeviceBound,
    ShortLived,
    Expired,
    Invalid,
    TooBig,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    pub on: BTreeSet<Kind>,
    #[serde(deserialize_with = "sites")]
    exclude: BTreeSet<String>,
}

/// The sites a person excluded are private: only their number shows.
impl fmt::Debug for Settings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Settings({:?}, {})", self.on, self.exclude.len())
    }
}

/// Stored or sent by another device, so each is read as if it were typed in here.
fn sites<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeSet<String>, D::Error> {
    let said = BTreeSet::<String>::deserialize(d)?;
    let read: Result<_, Skip> = said.iter().map(|s| site_of(s)).collect();
    read.map_err(|_| serde::de::Error::custom("not a site"))
}

/// A host as it is compared: no dots around it, lower case.
fn host(name: &str) -> String {
    name.trim().trim_matches('.').to_ascii_lowercase()
}

/// The site a host belongs to: the name that was registered (`bank.com` for `www.bank.com`, `bank.co.uk` for
/// `login.bank.co.uk`), by the Public Suffix List browsers use. An address, a one-word name and a suffix such as
/// `co.uk` are sites of their own.
fn site_of(name: &str) -> Result<String, Skip> {
    let host = host(name);
    let legal = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '.';
    if host.is_empty() || host.len() > 253 || !host.chars().all(legal) {
        return Err(Skip::Invalid);
    }
    let address = host.ends_with(|c: char| c.is_ascii_digit());
    let name = psl::domain_str(&host).filter(|_| !address);
    Ok(name.unwrap_or(&host).to_string())
}

impl Default for Settings {
    /// Everything but cookies: those wait until the person turns them on.
    fn default() -> Self {
        let on = Kind::ALL
            .into_iter()
            .filter(|k| *k != Kind::Cookie)
            .collect();
        Settings {
            on,
            exclude: BTreeSet::new(),
        }
    }
}

impl Settings {
    /// Whether this device sends and takes the record, by type and site alone.
    pub fn allows(&self, record: &Record) -> Result<(), Skip> {
        if !self.on.contains(&record.kind) {
            return Err(Skip::TypeOff);
        }
        if record.kind == Kind::Cookie {
            let domain = host(record.key.split(';').next().unwrap_or_default());
            let hit = |site: &String| {
                domain == *site || domain.strip_suffix(site).is_some_and(|d| d.ends_with('.'))
            };
            if self.exclude.iter().any(hit) {
                return Err(Skip::ExcludedSite);
            }
        }
        Ok(())
    }

    /// The sites whose cookies never leave or enter this device.
    pub fn excluded(&self) -> &BTreeSet<String> {
        &self.exclude
    }

    /// Excludes the whole site a host belongs to: every cookie of the registered name and of every host under it,
    /// whichever of those hosts was named. Excluding `www.bank.com` is excluding `bank.com`.
    pub fn exclude_site(&mut self, site: &str) -> Result<(), Skip> {
        self.exclude.insert(site_of(site)?);
        Ok(())
    }

    pub fn include_site(&mut self, site: &str) -> Result<(), Skip> {
        self.exclude.remove(&site_of(site)?);
        Ok(())
    }
}

/// Whether a cookie can be of use on another device. `now` is in seconds and is given only where the browser hands the
/// cookie over; a device taking one from another checks the rest, so a cookie can't age out between the two.
pub fn movable(c: &Cookie, now: Option<f64>) -> Result<(), Skip> {
    if c.device_bound || BOUND.contains(&c.name.as_str()) {
        return Err(Skip::DeviceBound);
    }
    if c.partitioned || c.partition_key.is_some() {
        return Err(Skip::Partitioned);
    }
    // DevTools says -1 for a session cookie.
    let Some(expires) = c.expires.filter(|e| *e > 0.0) else {
        return Err(Skip::Session);
    };
    if let Some(now) = now {
        if expires <= now {
            return Err(Skip::Expired);
        }
        if c.secure && expires - now < SHORT_LIFE_SECS {
            return Err(Skip::ShortLived);
        }
    }
    Ok(())
}

/// `movable` for any record. Its key must be the one its value makes, or the site `allows` read from the key would not
/// be the cookie's. A bound cookie's deletion stays too: it would delete another device's own. The key doesn't show the
/// other cookies that don't move (a partitioned one shares it with one that does), so a deletion may be made only for a
/// cookie that moved.
pub fn record_movable(record: &Record, now: Option<f64>) -> Result<(), Skip> {
    let key = match &record.value {
        Some(v) => key_of(record.kind, v.expose()),
        None => check_key(record.kind, &record.key).map(|()| record.key.clone()),
    };
    match key {
        Ok(key) if key == record.key => {}
        Err(Invalid::TooBig) => return Err(Skip::TooBig),
        _ => return Err(Skip::Invalid),
    }
    let name = record.key.rsplit(';').next().unwrap_or_default();
    match (&record.kind, &record.value) {
        (Kind::Cookie, Some(v)) => movable(&cookie(v.expose()).map_err(|_| Skip::Invalid)?, now),
        (Kind::Cookie, None) if BOUND.contains(&name) => Err(Skip::DeviceBound),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hlc::Stamp;
    use crate::secret::Secret;

    fn rec(kind: Kind, key: &str) -> Record {
        Record {
            kind,
            key: key.into(),
            stamp: Stamp {
                ms: 1,
                count: 0,
                device: [0; 32],
            },
            value: None,
        }
    }

    fn held(kind: Kind, key: &str, json: &str) -> Result<(), Skip> {
        let mut r = rec(kind, key);
        r.value = Some(Secret::new(json.as_bytes().to_vec()));
        record_movable(&r, Some(1000.0))
    }

    fn jar(extra: &str) -> Cookie {
        cookie(format!(r#"{{"domain":"a.com","path":"/","value":"v"{extra}}}"#).as_bytes()).unwrap()
    }

    #[test]
    fn cookies_are_off_until_turned_on() {
        let mut s = Settings::default();
        for k in Kind::ALL {
            assert_eq!(s.allows(&rec(k, "a.com;/;n")).is_ok(), k != Kind::Cookie);
        }
        s.on.insert(Kind::Cookie);
        assert_eq!(s.allows(&rec(Kind::Cookie, "a.com;/;n")), Ok(()));
    }

    #[test]
    fn an_excluded_site_covers_its_subdomains_and_nothing_else() {
        let mut s = Settings::default();
        s.on.insert(Kind::Cookie);
        for named in [".Bank.com", "www.bank.com", "login.bank.com."] {
            s.exclude_site(named).unwrap();
            for d in ["bank.com", ".bank.com", "www.bank.com", ".login.BANK.com."] {
                let got = s.allows(&rec(Kind::Cookie, &format!("{d};/;n")));
                assert_eq!(got, Err(Skip::ExcludedSite), "{named} {d}");
            }
            for d in ["notbank.com", "bank.com.evil.net", "com"] {
                let got = s.allows(&rec(Kind::Cookie, &format!("{d};/;n")));
                assert_eq!(got, Ok(()), "{named} {d}");
            }
            s.include_site("mail.bank.com").unwrap();
            assert!(s.excluded().is_empty(), "any of its hosts takes it back");
        }
        assert_eq!(s.exclude_site("a;b"), Err(Skip::Invalid));
        assert_eq!(site_of("login.bank.co.uk").unwrap(), "bank.co.uk");
        for own in ["co.uk", "localhost", "192.168.1.5"] {
            assert_eq!(site_of(own).unwrap(), own);
        }
        // Read back, they are cleaned the same way, and never shown.
        let s = r#"{"on":["cookie"],"exclude":[".Planted.com","www.planted.com"]}"#;
        let s: Settings = serde_json::from_str(s).unwrap();
        assert!(s.excluded().iter().eq(["planted.com"]));
        assert!(!format!("{s:?}").contains("planted"));
    }

    #[test]
    fn cookies_that_would_be_no_use_elsewhere_never_move() {
        let now = Some(1000.0);
        let t = |extra: &str| movable(&jar(extra), now);
        assert_eq!(t(r#","name":"keep","expires":99999,"secure":true"#), Ok(()));
        assert_eq!(t(r#","name":"sid","secure":true"#), Err(Skip::Session));
        assert_eq!(
            t(r#","name":"sid","expires":99999,"partitioned":true"#),
            Err(Skip::Partitioned)
        );
        assert_eq!(
            t(r#","name":"sid","expires":99999,"deviceBound":true"#),
            Err(Skip::DeviceBound)
        );
        assert_eq!(
            t(r#","name":"__Secure-1PSIDTS","expires":99999"#),
            Err(Skip::DeviceBound)
        );
        assert_eq!(
            t(r#","name":"sid","expires":1600,"secure":true"#),
            Err(Skip::ShortLived)
        );
        assert_eq!(t(r#","name":"sid","expires":1600"#), Ok(()));
        assert_eq!(t(r#","name":"sid","expires":1000"#), Err(Skip::Expired));
        assert_eq!(t(r#","name":"sid","expires":-1"#), Err(Skip::Session));
        assert_eq!(
            t(r#","name":"sid","expires":99999,"partitionKey":{}"#),
            Err(Skip::Partitioned)
        );
        // On the way in there is no clock check, so the one that just arrived isn't refused and asked for again.
        assert_eq!(
            movable(&jar(r#","name":"sid","expires":1600,"secure":true"#), None),
            Ok(())
        );
    }

    #[test]
    fn a_record_is_what_its_key_says() {
        let bank = r#"{"domain":".bank.com","path":"/","name":"sid","value":"v","expires":2e9}"#;
        let at = |key: &str, json: &str| held(Kind::Cookie, key, json);
        assert_eq!(at(".bank.com;/;sid", bank), Ok(()));
        assert_eq!(at("a.com;/;sid", bank), Err(Skip::Invalid));
        assert_eq!(at(".bank.com;/;sid", "{}"), Err(Skip::Invalid));
        let session = bank.replace(r#","expires":2e9"#, "");
        assert_eq!(at(".bank.com;/;sid", &session), Err(Skip::Session));
        let page = r#"{"url":"https://a.com/"}"#;
        assert_eq!(held(Kind::History, "https://a.com/", page), Ok(()));
        assert_eq!(held(Kind::History, "b", page), Err(Skip::Invalid));
    }

    #[test]
    fn a_bound_cookies_deletion_stays_and_a_bad_key_goes_nowhere() {
        let gone = |kind, key: &str| record_movable(&rec(kind, key), None);
        assert_eq!(gone(Kind::Cookie, "a.com;/;sid"), Ok(()));
        for name in BOUND {
            let key = format!(".google.com;/;{name}");
            assert_eq!(gone(Kind::Cookie, &key), Err(Skip::DeviceBound));
        }
        assert_eq!(gone(Kind::Extension, "../../etc"), Err(Skip::Invalid));
    }
}
