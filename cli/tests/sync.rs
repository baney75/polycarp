//! End to end: two devices, each with its own temporary home, and a relay that is a temporary folder. Keys go in the
//! file store (`POLYCARP_SYNC_KEY_STORE=file`), so nothing reaches a real Keychain, relay or settings.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Device {
    root: PathBuf,
}

fn root(name: &str) -> PathBuf {
    let r =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("sync-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&r);
    r
}

impl Device {
    fn new(world: &Path, name: &str) -> Device {
        let root = world.join(name);
        for d in ["home", "cfg", "support", "tmp"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Device { root }
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_polycarp"))
            .env_clear()
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("APPDATA", self.root.join("home"))
            .env("POLYCARP_CONFIG_DIR", self.root.join("cfg"))
            .env("POLYCARP_SUPPORT_DIR", self.root.join("support"))
            .env("POLYCARP_SYNC_KEY_STORE", "file")
            .env("POLYCARP_NO_SYSTEM_SPOTS", "1")
            .env("TMPDIR", self.root.join("tmp"))
            .env("PATH", self.root.join("tmp"))
            .current_dir(&self.root)
            .args(args)
            .output()
            .unwrap()
    }
    fn ok(&self, args: &[&str]) -> String {
        let o = self.run(args);
        let out = String::from_utf8_lossy(&o.stdout).to_string();
        assert!(
            o.status.success(),
            "{args:?}: {out}{}",
            String::from_utf8_lossy(&o.stderr)
        );
        out
    }
    fn fails(&self, args: &[&str]) -> String {
        let o = self.run(args);
        assert_eq!(o.status.code(), Some(1), "{args:?} should fail");
        String::from_utf8_lossy(&o.stderr).to_string()
    }
    fn surfaces(&self) -> Value {
        fs::read_to_string(self.root.join("support/surfaces.json"))
            .map(|t| serde_json::from_str(&t).unwrap())
            .unwrap_or(json!({}))
    }
    fn set_surfaces(&self, v: Value) {
        fs::write(self.root.join("support/surfaces.json"), v.to_string()).unwrap();
    }
    fn files(&self) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        for d in ["cfg", "support"] {
            walk(&self.root.join(d), &mut out);
        }
        out.retain(|(p, _)| !p.components().any(|c| c.as_os_str() == "sync"));
        out
    }
}

fn walk(d: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
    let Ok(rd) = fs::read_dir(d) else { return };
    let mut es: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    es.sort();
    for p in es {
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push((p.clone(), fs::read(&p).unwrap()));
        }
    }
}

/// The value after `label` on its line of `out`.
fn after(out: &str, label: &str) -> String {
    let line = out
        .lines()
        .find(|l| l.contains(label))
        .unwrap_or_else(|| panic!("{label} in {out}"));
    let rest = &line[line.find(label).unwrap() + label.len()..];
    rest.split_whitespace()
        .next()
        .unwrap()
        .trim_end_matches(',')
        .to_string()
}

#[test]
fn two_devices_sync_settings_through_a_folder_relay() {
    let world = root("two");
    let relay = world.join("relay");
    fs::create_dir_all(&relay).unwrap();
    fs::write(relay.join("polycarp-sync"), b"").unwrap();
    let addr = format!("dir:{}", relay.display());
    let (a, b) = (Device::new(&world, "a"), Device::new(&world, "b"));

    // A is the first device. B asks to join; A checks B's fingerprint and approves; B checks A's.
    a.set_surfaces(json!({"bar": {"height": 30, "displayId": "37D8832A"}, "mac": {"menuBarAutohide": "fullscreen"}}));
    let out = a.ok(&["sync", "init", "--relay", &addr, "--name", "mac"]);
    assert!(out.contains("first device"), "{out}");
    // B comes with settings of its own: a default where A has a value, and one A has never had.
    b.set_surfaces(json!({"bar": {"height": 24}, "dock": {"autohide": true}}));
    let out = b.ok(&["sync", "init", "--relay", &addr, "--name", "win"]);
    let (code, bfp) = (after(&out, "Pairing code: "), after(&out, "fingerprint "));
    assert!(a
        .fails(&[
            "sync",
            "approve",
            &code,
            "--fingerprint",
            "0000-0000-0000-0000-0000-0000"
        ])
        .contains("don't match"));
    // A waiting record whose name holds a terminal escape is refused before it is shown.
    let pending = relay.join(format!(
        "pending-{}.json",
        code.to_ascii_lowercase().replace('-', "")
    ));
    let good = fs::read(&pending).unwrap();
    let mut rec: Value = serde_json::from_slice(&good).unwrap();
    rec["name"] = json!("win\u{1b}[2K");
    fs::write(&pending, rec.to_string()).unwrap();
    assert!(a
        .fails(&["sync", "approve", &code, "--fingerprint", &bfp])
        .contains("plain characters"));
    fs::write(&pending, &good).unwrap();
    let out = a.ok(&["sync", "approve", &code, "--fingerprint", &bfp]);
    let afp = after(&out, "--approver ");
    assert!(
        b.fails(&["sync", "now", "--approver", &bfp])
            .contains("not the"),
        "B refuses a list A did not sign"
    );
    b.ok(&["sync", "now", "--approver", &afp]);
    assert!(b.ok(&["sync", "devices"]).contains("mac"));

    // What A had reached B, without the display id; the Mac-only setting arrived as it was. B's own default did not
    // win over A's value, though it is newer, and what only B had joined in.
    assert_eq!(
        b.surfaces(),
        json!({"bar": {"height": 30}, "dock": {"autohide": true}, "mac": {"menuBarAutohide": "fullscreen"}})
    );
    a.ok(&["sync", "now"]);
    assert_eq!(a.surfaces()["bar"]["height"], json!(30));
    assert_eq!(a.surfaces()["dock"], json!({"autohide": true}));
    for f in fs::read_dir(&relay).unwrap().flatten() {
        let text = fs::read_to_string(f.path()).unwrap();
        assert!(
            !text.contains("37D8832A") && !text.contains("menuBarAutohide"),
            "relay holds only ciphertext"
        );
    }

    // Two devices edit different settings: both edits on both.
    let mut s = a.surfaces();
    s["bar"]["height"] = json!(28);
    a.set_surfaces(s);
    fs::write(b.root.join("cfg/style.css"), ".bar { opacity: 0.9 }\n").unwrap();
    a.ok(&["sync", "now"]);
    b.ok(&["sync", "now"]);
    a.ok(&["sync", "now"]);
    assert_eq!(
        a.surfaces()["bar"],
        json!({"height": 28, "displayId": "37D8832A"})
    );
    assert_eq!(b.surfaces()["bar"], json!({"height": 28}));
    assert_eq!(
        fs::read_to_string(a.root.join("cfg/style.css")).unwrap(),
        ".bar { opacity: 0.9 }\n"
    );
    // B passed the Mac-only setting back unchanged.
    assert_eq!(
        a.surfaces()["mac"],
        json!({"menuBarAutohide": "fullscreen"})
    );

    // A delete on B is gone on A too.
    fs::remove_file(b.root.join("cfg/style.css")).unwrap();
    b.ok(&["sync", "now"]);
    a.ok(&["sync", "now"]);
    assert!(!a.root.join("cfg/style.css").exists());

    // A bundle changed on the relay is refused, names its kind, and nothing here changes.
    let bundle = relay.join("settings.age.json");
    let good = fs::read(&bundle).unwrap();
    let mut sealed: Value = serde_json::from_slice(&good).unwrap();
    let ct = sealed["ct"].as_str().unwrap().to_string();
    let flip = if ct.ends_with('A') { "B" } else { "A" };
    sealed["ct"] = json!(format!("{}{flip}", &ct[..ct.len() - 1]));
    fs::write(&bundle, sealed.to_string()).unwrap();
    let mut s = b.surfaces();
    s["bar"]["height"] = json!(26);
    b.set_surfaces(s);
    let before = b.files();
    let err = b.fails(&["sync", "now"]);
    assert!(
        err.contains("the settings bundle on the relay was refused"),
        "{err}"
    );
    assert_eq!(b.files(), before);
    fs::write(&bundle, &good).unwrap();

    // The relay unreachable: nothing changes here, and the next run catches up.
    let away = world.join("relay-away");
    fs::rename(&relay, &away).unwrap();
    fs::write(&relay, b"not a folder").unwrap();
    let err = b.fails(&["sync", "now"]);
    assert!(err.contains("relay"), "{err}");
    assert_eq!(b.files(), before);
    fs::remove_file(&relay).unwrap();
    fs::rename(&away, &relay).unwrap();
    b.ok(&["sync", "now"]);
    a.ok(&["sync", "now"]);
    assert_eq!(a.surfaces()["bar"]["height"], json!(26));

    // A removed device can't take part, and what is written after can't be opened by it.
    a.ok(&["sync", "remove", "win"]);
    assert!(b.fails(&["sync", "now"]).contains("removed"));
    let list: Value =
        serde_json::from_slice(&fs::read(relay.join("devices.json")).unwrap()).unwrap();
    assert_eq!(list["devices"].as_array().unwrap().len(), 1);
    let _ = fs::remove_dir_all(&world);
}

#[test]
fn usage_and_refusals() {
    let world = root("usage");
    let a = Device::new(&world, "a");
    assert_eq!(a.run(&["sync", "bogus"]).status.code(), Some(2));
    assert_eq!(
        a.run(&["sync", "init", "--colour", "x"]).status.code(),
        Some(2)
    );
    assert!(a.fails(&["sync", "now"]).contains("not set up"));
    assert!(a
        .fails(&["sync", "init", "--relay", "ssh:-oProxyCommand=x"])
        .contains("not a relay address"));
    assert!(a.ok(&["sync", "--help"]).contains("polycarp sync init"));
    let _ = fs::remove_dir_all(&world);
}
