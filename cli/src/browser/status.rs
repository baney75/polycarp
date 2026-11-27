//! `polycarp browser status`, and the line `polycarp doctor` prints.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::local_studio;
use super::release::{self, Release};
use super::spot::Spot;
use super::tools::Tools;
use super::{now_millis, Place};

/// The newest release, as last looked up.
#[derive(Serialize, Deserialize)]
struct Seen {
    version: String,
    published: Option<i64>,
    /// Days since 1970, as all days here.
    checked: i64,
}

const SEEN: &str = "newest.json";
/// Days a look-up stays worth repeating.
const FRESH: i64 = 3;

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Status {
    pub installed: Option<String>,
    pub app: PathBuf,
    pub running: bool,
    pub newest: Option<String>,
    /// Days since the installed release came out.
    pub age_days: Option<i64>,
    /// Days since the newest one came out, when it is not the one installed.
    pub behind_days: Option<i64>,
    pub up_to_date: Option<bool>,
    /// The release that goes in when the browser quits.
    pub pending: Option<String>,
    /// The release the person went back from.
    pub held: Option<String>,
    /// Days since the newest release was looked up.
    pub checked_days_ago: Option<i64>,
    /// Why it could not be looked up now.
    pub problem: Option<String>,
    /// The extensions inside the installed app (spec/browser.md R-B20).
    pub built_in: Vec<BuiltIn>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct BuiltIn {
    pub name: &'static str,
    pub version: String,
    /// The Local Studio commit it was built from.
    pub commit: Option<String>,
}

/// What the app holds of Polycarp's extension and Local Studio's, as each manifest says.
fn built_in(app: &Path) -> Vec<BuiltIn> {
    let polycarp = fs::read(app.join("Contents/Resources/polycarp/extension/manifest.json")).ok();
    let polycarp = polycarp.and_then(|m| serde_json::from_slice::<serde_json::Value>(&m).ok());
    let version = polycarp.and_then(|m| {
        let version = m["version_name"].as_str().or(m["version"].as_str());
        version.map(String::from)
    });
    let polycarp = version.map(|version| BuiltIn {
        name: "Polycarp",
        version,
        commit: None,
    });
    let local = local_studio::read(&app.join(local_studio::IN_APP)).ok();
    let local = local.map(|a| BuiltIn {
        name: "Local Studio",
        version: a.version,
        commit: a.commit,
    });
    polycarp.into_iter().chain(local).collect()
}

fn today() -> i64 {
    (now_millis() / 86_400_000) as i64
}

/// Kept for `doctor`, which asks nothing of the network. Losing it costs one look-up.
pub fn remember(cache: &Path, newest: &Release) {
    let seen = Seen {
        version: newest.version.clone(),
        published: newest.published,
        checked: today(),
    };
    if let Ok(text) = serde_json::to_vec(&seen) {
        let _ = fs::write(cache.join(SEEN), text);
    }
}

/// What is known without the network.
fn known(cache: &Path, spot: &Spot, today: i64) -> Status {
    let installed = spot.installed();
    let seen = fs::read(cache.join(SEEN)).ok();
    let seen: Option<Seen> = seen.and_then(|s| serde_json::from_slice(&s).ok());
    let ago = |day: i64| (today - day).max(0);
    let mut status = Status {
        app: spot.app(),
        running: spot.running(),
        age_days: installed.as_ref().and_then(|b| b.published).map(ago),
        pending: spot.waiting().map(|b| b.helium),
        held: spot.held().map(|b| b.helium),
        built_in: installed
            .as_ref()
            .map(|_| built_in(&spot.app()))
            .unwrap_or_default(),
        ..Status::default()
    };
    if let Some(seen) = seen {
        if let Some(installed) = &installed {
            let behind = release::parts(&installed.helium) < release::parts(&seen.version);
            status.up_to_date = Some(!behind);
            status.behind_days = seen.published.map(ago).filter(|_| behind);
        }
        status.checked_days_ago = Some(ago(seen.checked));
        status.newest = Some(seen.version);
    }
    status.installed = installed.map(|b| b.helium);
    status
}

pub fn status(tools: &dyn Tools, place: &Place, arch: &str) -> Status {
    let looked = place
        .prepare()
        .and_then(|_| release::newest(tools, arch))
        .map(|newest| remember(&place.cache, &newest));
    let mut status = known(&place.cache, &place.spot, today());
    status.problem = looked.err().map(|e| e.to_string());
    status
}

/// None when the browser is not installed.
pub fn doctor(cache: &Path, spot: &Spot) -> Option<String> {
    let status = known(cache, spot, today());
    status.installed.as_ref()?;
    Some(format!("browser: {}", status.verdict()))
}

fn days(n: i64) -> String {
    match n {
        0 => "today".into(),
        1 => "1 day ago".into(),
        n => format!("{n} days ago"),
    }
}

impl Status {
    fn verdict(&self) -> String {
        let Some(installed) = &self.installed else {
            return "Polycarp Browser is not installed. `polycarp browser install` makes it."
                .into();
        };
        let name = format!("Polycarp Browser on Helium {installed}");
        let Some((newest, checked)) = self.newest.as_ref().zip(self.checked_days_ago) else {
            return format!("{name}; never checked for updates. Run `polycarp browser update`.");
        };
        if self.up_to_date == Some(false) {
            let out = match self.behind_days {
                Some(n) => format!(" came out {}", days(n)),
                None => " is out".into(),
            };
            return format!(
                "{name} is out of date: Helium {newest}{out}. Browser releases fix security holes; {}",
                match &self.pending {
                    Some(v) if v == newest => "quit the browser and it goes in.",
                    _ if self.held.as_ref() == Some(newest) =>
                        "you went back from that one, and `polycarp browser install` puts it in.",
                    _ => "run `polycarp browser update`.",
                }
            );
        }
        if checked > FRESH {
            return format!(
                "{name}; last checked for updates {}. Run `polycarp browser update`.",
                days(checked)
            );
        }
        format!("{name} is up to date (checked {}).", days(checked))
    }

    pub fn text(&self) -> String {
        let mut lines = vec![self.verdict()];
        if self.installed.is_some() {
            lines.push(format!(
                "{} ({})",
                self.app.display(),
                if self.running { "open" } else { "not open" }
            ));
            if let Some(n) = self.age_days {
                lines.push(format!("The installed release came out {}.", days(n)));
            }
            let named = self.built_in.iter().map(|b| match &b.commit {
                Some(c) => format!("{} {} (commit {})", b.name, b.version, &c[..7]),
                None => format!("{} {}", b.name, b.version),
            });
            let named: Vec<String> = named.collect();
            if !named.is_empty() {
                lines.push(format!("Built in: {}.", named.join(", ")));
            }
        }
        if self.pending.is_some() {
            lines.push("A new build goes in when you quit the browser.".into());
        }
        if let Some(problem) = &self.problem {
            lines.push(format!("Could not look for a newer one: {problem}."));
        }
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::*;
    use super::*;

    fn seen(t: &Fake, version: &str, published: i64, checked: i64) {
        t.place().prepare().unwrap();
        let seen = Seen {
            version: version.into(),
            published: Some(published),
            checked,
        };
        fs::write(
            t.place().cache.join(SEEN),
            serde_json::to_vec(&seen).unwrap(),
        )
        .unwrap();
    }

    fn at(t: &Fake, today: i64) -> Status {
        known(&t.place().cache, &t.spot(), today)
    }

    #[test]
    fn status_counts_days_and_says_plainly_when_it_is_behind() {
        let t = Fake::new();
        assert_eq!(doctor(&t.place().cache, &t.spot()), None);
        assert!(at(&t, 0).text().contains("not installed"));
        // Published on day 20,000.
        t.built_app(&t.spot().app(), "1.2", 1);
        assert!(at(&t, 20_010).text().contains("never checked"));
        seen(&t, "1.10", 20_004, 20_010);
        let s = at(&t, 20_011);
        assert_eq!(s.age_days, Some(11));
        assert_eq!(s.behind_days, Some(7));
        assert_eq!(s.up_to_date, Some(false));
        assert_eq!(s.checked_days_ago, Some(1));
        let text = s.text();
        for part in [
            "Helium 1.2 is out of date: Helium 1.10 came out 7 days ago",
            "security",
            "run `polycarp browser update`",
            "not open",
        ] {
            assert!(text.contains(part), "{part}: {text}");
        }
        t.built_app(&t.spot().next(), "1.10", 2);
        let text = at(&t, 20_011).text();
        assert!(text.contains("A new build goes in"), "{text}");
        seen(&t, "1.2", 20_000, 20_010);
        assert!(at(&t, 20_011).text().contains("up to date"));
        assert!(at(&t, 20_020)
            .text()
            .contains("last checked for updates 10 days ago"));
    }

    #[test]
    fn status_lists_both_built_in_extensions_with_versions() {
        let t = Fake::new();
        let app = t.spot().app();
        t.built_app(&app, "1.2", 1);
        assert!(at(&t, 0).built_in.is_empty());
        let polycarp = app.join("Contents/Resources/polycarp/extension");
        fs::create_dir_all(&polycarp).unwrap();
        fs::write(
            polycarp.join("manifest.json"),
            "{\"version\":\"2.0.0\",\"version_name\":\"2.0.0 (abc)\"}",
        )
        .unwrap();
        local_studio::put_in(&t.local_studio_extension(), &app);
        let s = at(&t, 0);
        let names: Vec<_> = s
            .built_in
            .iter()
            .map(|b| (b.name, b.version.as_str()))
            .collect();
        assert_eq!(
            names,
            [("Polycarp", "2.0.0 (abc)"), ("Local Studio", "1.4.1")]
        );
        assert_eq!(s.built_in[1].commit.as_deref(), Some(PINNED));
        let text = s.text();
        assert!(
            text.contains("Built in: Polycarp 2.0.0 (abc), Local Studio 1.4.1 (commit 347571d)."),
            "{text}"
        );
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["built_in"][1]["name"], "Local Studio");
    }

    #[test]
    fn a_release_gone_back_from_is_named() {
        let t = Fake::new();
        t.built_app(&t.spot().app(), "1.2", 1);
        t.built_app(&t.spot().previous(), "1.3", 2);
        seen(&t, "1.3", 20_000, 20_000);
        let s = at(&t, 20_000);
        assert_eq!(s.held.as_deref(), Some("1.3"));
        assert!(s.text().contains("you went back from that one"));
    }

    #[test]
    fn status_looks_up_the_newest_and_says_when_it_could_not() {
        let t = Fake::new();
        t.built_app(&t.spot().app(), "0.1.0", 1);
        let mut open = t.start_inside(&t.spot().app());
        let s = status(&t, &t.place(), "arm64");
        assert!(s.running);
        assert_eq!(s.newest.as_deref(), Some(VERSION));
        assert_eq!((s.up_to_date, s.problem.as_deref()), (Some(false), None));
        open.kill().unwrap();
        open.wait().unwrap();
        // What was found is remembered, and an unanswered question is said.
        t.set(|s| s.fail = Some(("curl", "releases", Failure::SaysNo)));
        let s = status(&t, &t.place(), "arm64");
        assert!(!s.running);
        assert_eq!(s.newest.as_deref(), Some(VERSION));
        assert!(s.text().contains("Could not look"), "{}", s.text());
        let line = doctor(&t.place().cache, &t.spot()).unwrap();
        assert!(
            line.starts_with("browser: Polycarp Browser on Helium 0.1.0 is out of date"),
            "{line}"
        );
        assert_eq!(line.lines().count(), 1);
        let json: serde_json::Value = serde_json::to_value(&s).unwrap();
        for key in [
            "installed",
            "newest",
            "age_days",
            "running",
            "up_to_date",
            "behind_days",
        ] {
            assert!(!json[key].is_null(), "{key}");
        }
    }
}
