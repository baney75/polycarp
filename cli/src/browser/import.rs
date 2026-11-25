//! `polycarp browser import`: lists the browsers on this Mac by name, and copies a Helium profile. The browser it comes from is
//! only read, and only while it is closed.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::{clear, pages, refuse, running, Asked, Place, Refused};

const CHECK: &str = "import";
/// Both browsers name the item the same; the name is compiled in.
const KEYCHAIN: &str = "When it first opens, macOS asks whether Polycarp Browser may use \"Helium Storage Key\" in your keychain: allow it, or its passwords and sign-ins can't be read.";
/// What a profile can do without: pages and code kept to be faster, and locks.
const LEFT_OUT: [&str; 8] = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GrShaderCache",
    "ShaderCache",
];

pub struct Browser {
    /// What the person types.
    pub word: &'static str,
    pub name: &'static str,
    /// Its data folder, under Application Support.
    folder: &'static str,
}

pub const BROWSERS: [Browser; 7] = [
    Browser {
        word: "helium",
        name: "Helium",
        folder: "net.imput.helium",
    },
    Browser {
        word: "chrome",
        name: "Google Chrome",
        folder: "Google/Chrome",
    },
    Browser {
        word: "brave",
        name: "Brave",
        folder: "BraveSoftware/Brave-Browser",
    },
    Browser {
        word: "edge",
        name: "Microsoft Edge",
        folder: "Microsoft Edge",
    },
    Browser {
        word: "vivaldi",
        name: "Vivaldi",
        folder: "Vivaldi",
    },
    Browser {
        word: "arc",
        name: "Arc",
        folder: "Arc/User Data",
    },
    Browser {
        word: "chromium",
        name: "Chromium",
        folder: "Chromium",
    },
];

#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub name: String,
    /// Its folder, inside the browser's data folder.
    pub folder: PathBuf,
}

impl Browser {
    pub fn data(&self, home: &Path) -> PathBuf {
        home.join("Library/Application Support").join(self.folder)
    }

    /// Its profiles, by the name the person gave them. Nothing else in the list is read: it also holds accounts.
    pub fn profiles(&self, home: &Path) -> Vec<Profile> {
        let data = self.data(home);
        let state = fs::read(data.join("Local State")).unwrap_or_default();
        let state: Value = serde_json::from_slice(&state).unwrap_or_default();
        let known = state["profile"]["info_cache"].as_object();
        let mut all: Vec<Profile> = known
            .into_iter()
            .flatten()
            .filter_map(|(dir, about)| {
                let folder = data.join(dir);
                let plain = Path::new(dir).components().count() == 1 && !dir.starts_with('.');
                let meta = fs::symlink_metadata(&folder).ok()?;
                let name = about["name"].as_str().unwrap_or(dir);
                let name: String = name.chars().filter(|c| !c.is_control()).collect();
                (plain && meta.is_dir()).then_some(Profile { name, folder })
            })
            .collect();
        all.sort_by(|a, b| a.folder.cmp(&b.folder));
        all
    }

    pub fn open(&self, home: &Path) -> bool {
        locked(&self.data(home))
    }
}

/// In use: Chromium's own lock on the data folder names a process that is there.
fn locked(data: &Path) -> bool {
    let Ok(lock) = fs::read_link(data.join("SingletonLock")) else {
        return false;
    };
    // `host-pid`. One that can't be read is taken as in use.
    let pid = lock.to_string_lossy();
    let pid = pid.rsplit('-').next().and_then(|p| p.parse::<i32>().ok());
    pid.is_none_or(running::is_there)
}

/// The browsers here, and their profiles.
pub fn list(home: &Path) -> String {
    let mut lines = Vec::new();
    for browser in &BROWSERS {
        for profile in browser.profiles(home) {
            lines.push(format!("{:10} {}", browser.word, profile.name));
        }
    }
    if lines.is_empty() {
        lines.push("No Chromium browser with a profile was found.".into());
    }
    lines
        .push("Firefox and Safari: in Polycarp Browser, open chrome://settings/importData.".into());
    lines.join("\n")
}

/// The profile asked for, or the only one.
pub fn pick<'a>(profiles: &'a [Profile], asked: Option<&str>) -> Result<&'a Profile, Refused> {
    let folder = |p: &Profile| {
        p.folder
            .file_name()
            .is_some_and(|f| Some(f.to_string_lossy().as_ref()) == asked)
    };
    let named: Vec<&Profile> = match asked {
        Some(asked) => {
            let exact = profiles.iter().filter(|p| folder(p) || p.name == asked);
            exact.collect()
        }
        None => profiles.iter().collect(),
    };
    match named[..] {
        [one] => Ok(one),
        [] => Err(Refused::new(CHECK, "there is no such profile")),
        _ => Err(Refused::new(
            CHECK,
            "there is more than one such profile; name one with --profile",
        )),
    }
}

/// `polycarp browser import [browser [--profile NAME] --yes]`.
pub fn answer(place: &Place, asked: &Asked) -> Result<String, Refused> {
    let Some(word) = &asked.what else {
        return Ok(list(&place.home));
    };
    let Some(from) = BROWSERS.iter().find(|b| b.word == word) else {
        let words = BROWSERS.map(|b| b.word).join(", ");
        return Err(Refused::new(CHECK, format!("{word} is not one of {words}")));
    };
    if from.word != "helium" {
        let name = from.name;
        let why = format!("{name} can't be copied yet. In Polycarp Browser, chrome://settings/importData takes its bookmarks and history");
        return Err(Refused::new(CHECK, why));
    }
    let profiles = from.profiles(&place.home);
    let profile = pick(&profiles, asked.profile.as_deref())?;
    if asked.flags.is_empty() {
        return Ok(format!(
            "This copies {}'s profile {} into Polycarp Browser; {}'s own stays as it is. {}\nAdd --yes to do it. Without it nothing is copied, and Polycarp Browser starts with an empty profile.",
            from.name, profile.name, from.name, KEYCHAIN
        ));
    }
    let dir = clone(&place.home, place, from, profile)?;
    let app = place.spot.installed().is_some();
    let next = if app {
        "open Polycarp Browser and it is there"
    } else {
        "`polycarp browser install` makes the browser that opens it"
    };
    Ok(format!(
        "{}'s profile {} is copied ({dir}): {next}. {KEYCHAIN}",
        from.name, profile.name
    ))
}

/// Where the next imported profile goes: the first one takes the place of a profile that was never used.
pub fn target(data: &Path) -> String {
    if pages::untouched(data) {
        return "Default".into();
    }
    let free = |n: &u32| !data.join(format!("Profile {n}")).exists();
    let n = (1..).find(free).unwrap_or(1);
    format!("Profile {n}")
}

/// Copies the profile whole. macOS's copy-on-write keeps it quick and small.
pub fn clone(
    home: &Path,
    place: &Place,
    from: &Browser,
    profile: &Profile,
) -> Result<String, Refused> {
    place.prepare()?;
    let _lock = place.lock()?;
    let closed = |check: &'static str| match (
        from.open(home),
        place.spot.running() || locked(&place.data),
    ) {
        (true, _) => Err(Refused::new(
            check,
            format!("{} is open. Quit it first", from.name),
        )),
        (_, true) => Err(Refused::new(
            check,
            "Polycarp Browser is open. Quit it first",
        )),
        _ => Ok(()),
    };
    closed("running")?;
    pages::first_run(&place.data).map_err(refuse(CHECK, "making the data folder"))?;
    let part = place.data.join(".import");
    let copied = clear(&part)
        .and_then(|_| copy(&profile.folder, &part))
        .map_err(refuse(CHECK, "copying the profile"));
    // Opened while it was copied, the copy may be half of two states.
    let done = copied
        .and_then(|_| closed("running"))
        .and_then(|_| place_profile(place, &part, &profile.name));
    if done.is_err() {
        clear(&part).map_err(refuse(CHECK, "clearing the copy"))?;
    }
    done
}

pub fn place_profile(place: &Place, part: &Path, name: &str) -> Result<String, Refused> {
    let dir = target(&place.data);
    let to = place.data.join(&dir);
    let put = || -> io::Result<()> {
        add_to_list(&place.data, &dir, name)?;
        if dir == "Default" {
            clear(&to)?;
        }
        fs::rename(part, &to)
    };
    put().map_err(refuse(CHECK, "placing the copy"))?;
    Ok(dir)
}

/// Names the profile in the list the browser reads its profiles from.
fn add_to_list(data: &Path, dir: &str, name: &str) -> io::Result<()> {
    let file = data.join("Local State");
    let mut state: Value = serde_json::from_slice(&fs::read(&file)?)?;
    let Some(state_map) = state.as_object_mut() else {
        return Err(io::Error::other("the list of profiles can't be read"));
    };
    let profile = state_map.entry("profile").or_insert_with(|| json!({}));
    let cache = profile.as_object_mut().and_then(|p| {
        let cache = p
            .entry("info_cache")
            .or_insert_with(|| Value::Object(Map::new()));
        cache.as_object_mut()
    });
    let Some(cache) = cache else {
        return Err(io::Error::other("the list of profiles can't be read"));
    };
    cache.insert(
        dir.into(),
        json!({ "name": name, "is_using_default_name": false }),
    );
    let part = data.join("Local State.part");
    fs::write(&part, serde_json::to_vec(&state)?)?;
    fs::rename(part, file)
}

/// Plain files and folders only.
fn copy(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if LEFT_OUT.iter().any(|l| *l == name) || name.to_string_lossy().starts_with("Singleton") {
            continue;
        }
        let kind = entry.file_type()?;
        let to = to.join(&name);
        if kind.is_dir() {
            copy(&entry.path(), &to)?;
        } else if kind.is_file() {
            // A clone, where the disk can make one.
            fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::testing::*;
    use super::*;
    use std::os::unix::fs::symlink;

    fn helium() -> &'static Browser {
        &BROWSERS[0]
    }

    /// A made-up Helium with two profiles.
    fn made_up(t: &Fake) -> PathBuf {
        let home = t.work().join("home");
        let data = helium().data(&home);
        for dir in ["Default", "Profile 1"] {
            fs::create_dir_all(data.join(dir).join("Cache")).unwrap();
            fs::create_dir_all(data.join(dir).join("Extensions/abc")).unwrap();
            fs::write(data.join(dir).join("Cache/page"), "x").unwrap();
            fs::write(data.join(dir).join("Extensions/abc/manifest.json"), "{}").unwrap();
            fs::write(data.join(dir).join("Cookies"), format!("cookies of {dir}")).unwrap();
        }
        symlink("/etc/hosts", data.join("Default/out")).unwrap();
        let linked = home.join("linked");
        fs::create_dir_all(&linked).unwrap();
        symlink(&linked, data.join("Profile 2")).unwrap();
        let state = json!({ "profile": { "info_cache": {
            "Default": { "name": "Home", "user_name": "someone@example.com" },
            "Profile 1": { "name": "Work\u{1b}[31m" },
            "Profile 2": { "name": "a link" },
            "Profile 9": { "name": "gone" },
            "../elsewhere": { "name": "outside" },
        } } });
        fs::write(data.join("Local State"), state.to_string()).unwrap();
        home
    }

    fn all(t: &Fake, home: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        t.listing(home)
    }

    #[test]
    fn the_list_holds_names_and_nothing_else_of_a_profile() {
        let t = Fake::new();
        let home = made_up(&t);
        fs::create_dir_all(helium().data(&home).join("../elsewhere")).unwrap();
        let list = list(&home);
        assert!(
            list.contains("helium     Home\nhelium     Work[31m\n"),
            "{list}"
        );
        for private in ["example.com", "gone", "outside", "a link", "\u{1b}"] {
            assert!(!list.contains(private), "{list}");
        }
        assert!(list.contains("importData"));
        assert!(super::list(&t.work().join("none")).starts_with("No Chromium browser"));
    }

    #[test]
    fn one_profile_is_picked_by_name_or_folder() {
        let t = Fake::new();
        let profiles = helium().profiles(&made_up(&t));
        assert_eq!(pick(&profiles, Some("Home")).unwrap().name, "Home");
        let by_folder = pick(&profiles, Some("Profile 1")).unwrap();
        assert!(by_folder.name.starts_with("Work"));
        for asked in [None, Some("nobody")] {
            assert_eq!(pick(&profiles, asked).unwrap_err().check, "import");
        }
        assert_eq!(pick(&profiles[..1], None).unwrap().name, "Home");
    }

    #[test]
    fn a_helium_profile_is_copied_and_the_original_is_left_as_it_was() {
        let t = Fake::new();
        let home = made_up(&t);
        let place = t.place();
        let before = all(&t, &home);
        let profiles = helium().profiles(&home);
        // A profile nobody used yet gives up its place; the next import goes beside it.
        assert_eq!(
            clone(&home, &place, helium(), &profiles[0]).unwrap(),
            "Default"
        );
        assert_eq!(
            clone(&home, &place, helium(), &profiles[1]).unwrap(),
            "Profile 1"
        );
        assert_eq!(all(&t, &home), before, "the original was changed");
        let read = |p: &str| fs::read_to_string(place.data.join(p)).unwrap();
        assert_eq!(read("Default/Cookies"), "cookies of Default");
        assert_eq!(read("Profile 1/Cookies"), "cookies of Profile 1");
        assert!(place
            .data
            .join("Default/Extensions/abc/manifest.json")
            .exists());
        assert!(!place.data.join("Default/Cache").exists());
        assert!(fs::symlink_metadata(place.data.join("Default/out")).is_err());
        assert!(!place.data.join(".import").exists());
        let state: Value = serde_json::from_str(&read("Local State")).unwrap();
        assert_eq!(state["profile"]["info_cache"]["Default"]["name"], "Home");
        assert!(state["profile"]["info_cache"]["Profile 1"]["name"].is_string());
        assert_eq!(
            state["helium"]["browser"]["default_browser_infobar_rejected"],
            true
        );
        assert!(!read("Local State").contains("example.com"));
    }

    #[test]
    fn nothing_is_copied_without_yes_or_from_another_browser() {
        let t = Fake::new();
        let home = made_up(&t);
        let place = Place { home, ..t.place() };
        let ask = |what: &str, yes: bool| {
            let asked = Asked {
                verb: "import".into(),
                what: Some(what.into()),
                profile: Some("Home".into()),
                flags: yes.then(|| "--yes".to_string()).into_iter().collect(),
                ..Asked::default()
            };
            answer(&place, &asked).map_err(|e| e.why)
        };
        assert!(ask("helium", false).unwrap().contains("Add --yes"));
        assert!(ask("chrome", true).unwrap_err().contains("yet"));
        assert!(ask("netscape", true).unwrap_err().contains("not one of"));
        assert!(!place.data.exists());
        let done = ask("helium", true).unwrap();
        assert!(done.contains("Helium Storage Key"), "{done}");
        assert!(place.data.join("Default/Cookies").exists());
    }

    #[test]
    fn neither_browser_may_be_open() {
        let t = Fake::new();
        let home = made_up(&t);
        let place = t.place();
        let profiles = helium().profiles(&home);
        let lock = helium().data(&home).join("SingletonLock");
        let me = std::process::id();
        for held in [format!("mac-{me}"), "mac".into()] {
            symlink(held, &lock).unwrap();
            let e = clone(&home, &place, helium(), &profiles[0]).unwrap_err();
            assert_eq!(e.check, "running");
            fs::remove_file(&lock).unwrap();
        }
        assert!(!place.data.exists());
        // Left by a crash: nothing has that number.
        symlink("mac-99999999", &lock).unwrap();
        assert!(!helium().open(&home));
        // Open from some other folder, it still has this data folder.
        fs::create_dir_all(&place.data).unwrap();
        let ours = place.data.join("SingletonLock");
        symlink(format!("mac-{me}"), &ours).unwrap();
        let e = clone(&home, &place, helium(), &profiles[0]).unwrap_err();
        assert_eq!(e.check, "running");
        fs::remove_file(&ours).unwrap();
        t.built_app(&place.spot.app(), "1.0", 1);
        let mut open = t.start_inside(&place.spot.app());
        let e = clone(&home, &place, helium(), &profiles[0]).unwrap_err();
        assert_eq!(e.check, "running");
        open.kill().unwrap();
        open.wait().unwrap();
    }

    #[test]
    fn a_profile_in_use_is_never_replaced() {
        let t = Fake::new();
        let home = made_up(&t);
        let place = t.place();
        pages::first_run(&place.data).unwrap();
        fs::write(place.data.join("Default/History"), "mine").unwrap();
        let profiles = helium().profiles(&home);
        assert_eq!(
            clone(&home, &place, helium(), &profiles[0]).unwrap(),
            "Profile 1"
        );
        let mine = fs::read_to_string(place.data.join("Default/History")).unwrap();
        assert_eq!(mine, "mine");
    }

    #[test]
    fn a_copy_that_fails_leaves_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let t = Fake::new();
        let home = made_up(&t);
        let place = t.place();
        let profiles = helium().profiles(&home);
        let cookies = profiles[0].folder.join("Cookies");
        fs::set_permissions(&cookies, fs::Permissions::from_mode(0o000)).unwrap();
        let e = clone(&home, &place, helium(), &profiles[0]).unwrap_err();
        assert_eq!(e.check, "import");
        assert!(!place.data.join(".import").exists());
        assert!(pages::untouched(&place.data));
    }
}
