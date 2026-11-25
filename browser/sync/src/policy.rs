//! What this device agrees to send and take: a switch per type, an exclude list, and the cookies that never move.

use crate::record::{cookie, Cookie, Kind, Record};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    pub on: BTreeSet<Kind>,
    /// Sites whose cookies never leave or enter this device, subdomains included.
    pub exclude: BTreeSet<String>,
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
            let domain = record.key.split(';').next().unwrap_or_default();
            let domain = domain.trim_start_matches('.').to_ascii_lowercase();
            let hit = |site: &String| {
                domain == *site || domain.strip_suffix(site).is_some_and(|d| d.ends_with('.'))
            };
            if self.exclude.iter().any(hit) {
                return Err(Skip::ExcludedSite);
            }
        }
        Ok(())
    }

    /// Adds a site to the exclude list, as a plain lower-case host name.
    pub fn exclude_site(&mut self, site: &str) -> Result<(), Skip> {
        let site = site
            .trim()
            .trim_start_matches('.')
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let host = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '.';
        if site.is_empty() || site.len() > 253 || !site.chars().all(host) {
            return Err(Skip::Invalid);
        }
        self.exclude.insert(site);
        Ok(())
    }
}

/// Whether a cookie can be of use on another device. `now` is in seconds and is given only where the browser hands the
/// cookie over; a device taking one from another checks the rest, so a cookie can't age out between the two.
pub fn movable(c: &Cookie, now: Option<f64>) -> Result<(), Skip> {
    if c.device_bound || BOUND.contains(&c.name.as_str()) {
        return Err(Skip::DeviceBound);
    }
    if c.partitioned {
        return Err(Skip::Partitioned);
    }
    let Some(expires) = c.expires else {
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

/// `movable` for any record: only a live cookie can be refused.
pub fn record_movable(record: &Record, now: Option<f64>) -> Result<(), Skip> {
    match (&record.kind, &record.value) {
        (Kind::Cookie, Some(v)) => movable(&cookie(v.expose()).map_err(|_| Skip::Invalid)?, now),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hlc::Stamp;

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
        s.exclude_site(".Bank.com").unwrap();
        for d in ["bank.com", ".bank.com", "www.bank.com", ".login.BANK.com"] {
            assert_eq!(
                s.allows(&rec(Kind::Cookie, &format!("{d};/;n"))),
                Err(Skip::ExcludedSite),
                "{d}"
            );
        }
        for d in ["notbank.com", "bank.com.evil.net", "ank.com"] {
            assert_eq!(
                s.allows(&rec(Kind::Cookie, &format!("{d};/;n"))),
                Ok(()),
                "{d}"
            );
        }
        assert_eq!(s.exclude_site("a;b"), Err(Skip::Invalid));
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
        // On the way in there is no clock check, so the one that just arrived isn't refused and asked for again.
        assert_eq!(
            movable(&jar(r#","name":"sid","expires":1600,"secure":true"#), None),
            Ok(())
        );
    }
}
