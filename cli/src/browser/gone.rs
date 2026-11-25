//! `polycarp browser uninstall` and `open`.

use std::fs;
use std::path::{Path, PathBuf};

use super::spot::Spot;
use super::tools::{must, Call, Tools};
use super::{clear, refuse, Place, Refused};

const CHECK: &str = "uninstall";

/// What a profile is made of: the data folder, and the pages Chromium keeps for it, the same path under Caches.
pub fn profile(home: &Path) -> [PathBuf; 2] {
    ["Application Support", "Caches"].map(|f| home.join("Library").join(f).join("Polycarp/Browser"))
}

/// Said before anything is removed: what `--profile` without `--yes` would take.
pub fn would_remove(home: &Path) -> String {
    let mut lines = vec![String::from(
        "This removes the app, and the profile with every bookmark, password and tab in it:",
    )];
    lines.extend(profile(home).iter().map(|p| format!("  {}", p.display())));
    lines.push("It can't be undone. Add --yes to do it.".into());
    lines.join("\n")
}

/// Removes the app. The profile stays unless it is asked for.
pub fn uninstall(place: &Place, with_profile: bool) -> Result<String, Refused> {
    place.prepare()?;
    let _lock = place.lock()?;
    if with_profile {
        for path in [&place.data, &place.page_cache] {
            // A link would lead the removal somewhere else.
            if fs::symlink_metadata(path).is_ok_and(|m| !m.is_dir()) {
                let why = format!("{} is not a folder", path.display());
                return Err(Refused::new(CHECK, why));
            }
        }
    }
    let mut gone = place.spot.remove()?;
    if with_profile {
        for path in [&place.data, &place.page_cache] {
            if path.exists() {
                clear(path).map_err(refuse(CHECK, "removing the profile"))?;
                gone.push(path.clone());
            }
        }
    }
    if gone.is_empty() {
        return Ok("Polycarp Browser is not installed.".into());
    }
    let mut lines: Vec<String> = gone
        .iter()
        .map(|p| format!("Removed {}", p.display()))
        .collect();
    if !with_profile && place.data.exists() {
        lines.push(format!("Your profile stays in {}", place.data.display()));
    }
    Ok(lines.join("\n"))
}

/// Opens the browser, at an address if one is given.
pub fn open(tools: &dyn Tools, spot: &Spot, url: Option<&str>) -> Result<String, Refused> {
    let check = "open";
    if spot.installed().is_none() {
        let why = "Polycarp Browser is not installed. `polycarp browser install` makes it";
        return Err(Refused::new(check, why));
    }
    let mut call = Call::new("/usr/bin/open", &[&"-a", &spot.app()]);
    if let Some(url) = url {
        let known = ["http://", "https://", "file://"];
        let lower = url.to_ascii_lowercase();
        if !known.iter().any(|k| lower.starts_with(k)) || url.chars().any(char::is_control) {
            let why = "an address starts with http://, https:// or file://";
            return Err(Refused::new(check, why));
        }
        call.args.push(url.into());
    }
    must(tools, check, &call)?;
    Ok(String::new())
}

#[cfg(test)]
mod tests {
    use super::super::testing::*;
    use super::*;

    fn profile(place: &Place) -> [&PathBuf; 2] {
        [&place.data, &place.page_cache]
    }

    fn installed(t: &Fake) -> Place {
        let place = t.place();
        t.built_app(&place.spot.app(), "1.0", 1);
        t.built_app(&place.spot.previous(), "0.9", 0);
        for path in profile(&place) {
            fs::create_dir_all(path).unwrap();
            fs::write(path.join("mine"), "x").unwrap();
        }
        place
    }

    #[test]
    fn uninstall_takes_the_app_and_leaves_the_profile() {
        let t = Fake::new();
        let place = installed(&t);
        let line = uninstall(&place, false).unwrap();
        assert!(line.contains("Your profile stays"), "{line}");
        assert!(!place.spot.app().exists() && !place.spot.previous().exists());
        assert!(profile(&place).iter().all(|p| p.join("mine").exists()));
        let line = uninstall(&place, true).unwrap();
        assert!(profile(&place).iter().all(|p| !p.exists()), "{line}");
        assert_eq!(
            uninstall(&place, false).unwrap(),
            "Polycarp Browser is not installed."
        );
        let would = would_remove(Path::new("/h"));
        for part in [
            "/h/Library/Application Support/Polycarp/Browser",
            "/h/Library/Caches/Polycarp/Browser",
        ] {
            assert!(would.contains(part), "{would}");
        }
    }

    #[test]
    fn a_profile_that_is_a_link_stops_the_removal_before_anything_goes() {
        let t = Fake::new();
        let place = installed(&t);
        let elsewhere = t.work().join("elsewhere");
        fs::rename(&place.data, &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &place.data).unwrap();
        assert_eq!(uninstall(&place, true).unwrap_err().check, "uninstall");
        assert!(elsewhere.join("mine").exists());
        assert!(place.spot.app().exists());
    }

    #[test]
    fn nothing_is_removed_while_it_runs() {
        let t = Fake::new();
        let place = installed(&t);
        let mut open = t.start_inside(&place.spot.app());
        assert_eq!(uninstall(&place, true).unwrap_err().check, "running");
        assert!(place.data.join("mine").exists() && place.spot.app().exists());
        open.kill().unwrap();
        open.wait().unwrap();
    }

    #[test]
    fn open_takes_a_web_or_file_address_and_nothing_else() {
        let t = Fake::new();
        let spot = t.spot();
        assert_eq!(open(&t, &spot, None).unwrap_err().check, "open");
        t.built_app(&spot.app(), "1.0", 1);
        for bad in [
            "--args",
            "javascript:1",
            "chrome://settings",
            "example.com",
            "https://a\nb",
        ] {
            assert_eq!(
                open(&t, &spot, Some(bad)).unwrap_err().check,
                "open",
                "{bad}"
            );
        }
        assert!(t.calls().is_empty());
        open(&t, &spot, Some("https://example.com")).unwrap();
        let app = spot.app();
        let call = format!("open -a {} https://example.com", app.display());
        assert_eq!(t.calls(), [call]);
    }
}
