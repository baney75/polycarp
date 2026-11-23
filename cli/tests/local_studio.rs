//! `polycarp install --local-studio`: every run gets its own HOME, PATH and Local Studio data folder, and a stub
//! `local-studio` that records what it was asked. No test reaches the real ~/.local-studio or ~/.eukhe.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new() -> Sandbox {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root =
            Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("ls{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&root);
        for d in ["home", "bin", "cwd", "empty", "data"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Sandbox { root }
    }
    fn dir(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    fn plugin(&self) -> PathBuf {
        self.dir("data").join("plugins/polycarp")
    }
    /// The stub records its arguments and the data folder it was given, then exits with `code`.
    fn local_studio(&self, code: i32) {
        let p = self.dir("bin").join("local-studio");
        let log = self.dir("calls");
        fs::write(
            &p,
            format!(
                "#!/bin/sh\necho \"$* data=$LOCAL_STUDIO_DATA_DIR\" >> '{}'\nexit {code}\n",
                log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fn calls(&self) -> String {
        fs::read_to_string(self.dir("calls")).unwrap_or_default()
    }
    fn cmd(&self, args: &[&str], path: &str) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_polycarp"));
        c.env_clear()
            .env("HOME", self.dir("home"))
            .env("PATH", self.dir(path))
            .env("POLYCARP_NO_SYSTEM_SPOTS", "1")
            .env("LOCAL_STUDIO_DATA_DIR", self.dir("data"))
            .current_dir(self.dir("cwd"))
            .args(args);
        c
    }
    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args, "bin").output().unwrap()
    }
}

fn out(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}
fn err(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}
fn repo(rel: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(rel)).unwrap()
}
fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn install_copies_the_plugin_makes_its_server_runnable_and_grants_it() {
    let s = Sandbox::new();
    s.local_studio(0);
    let o = s.run(&["install", "--local-studio"]);
    assert_eq!(o.status.code(), Some(0), "{}{}", out(&o), err(&o));
    let p = s.plugin();
    for rel in [
        "plugin.toml",
        "bin/polycarp-mcp",
        "skills/polycarp/SKILL.md",
    ] {
        assert_eq!(
            fs::read_to_string(p.join(rel)).unwrap(),
            repo(&format!("plugins/polycarp/{rel}")),
            "{rel}"
        );
    }
    assert_eq!(mode(&p.join("bin/polycarp-mcp")), 0o755);
    assert_eq!(mode(&p.join("plugin.toml")), 0o644);
    assert_eq!(
        s.calls(),
        format!(
            "plugin grant polycarp mcp-server data={}\n",
            s.dir("data").display()
        )
    );
    assert!(out(&o).contains("Granted mcp-server"), "{}", out(&o));
}

#[test]
fn install_twice_leaves_the_same_files_and_drops_stale_ones() {
    let s = Sandbox::new();
    s.local_studio(0);
    assert!(s.run(&["install", "--local-studio"]).status.success());
    fs::write(s.plugin().join("stale.md"), "old").unwrap();
    let o = s.run(&["install", "--local-studio"]);
    assert!(o.status.success(), "{}", err(&o));
    assert!(!s.plugin().join("stale.md").exists());
    assert!(s.plugin().join("plugin.toml").is_file());
    let names: Vec<String> = fs::read_dir(s.dir("data/plugins"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["polycarp"], "no staging folder is left behind");
    assert_eq!(s.calls().lines().count(), 2);
}

#[test]
fn without_local_studio_it_installs_and_prints_the_grant_command() {
    let s = Sandbox::new();
    let o = s
        .cmd(&["install", "--local-studio"], "empty")
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", err(&o));
    assert!(s.plugin().join("plugin.toml").is_file());
    assert!(
        out(&o).contains("local-studio plugin grant polycarp mcp-server"),
        "{}",
        out(&o)
    );
}

#[test]
fn without_a_data_dir_it_uses_the_home_folder() {
    let s = Sandbox::new();
    let o = s
        .cmd(&["install", "--local-studio"], "empty")
        .env_remove("LOCAL_STUDIO_DATA_DIR")
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", err(&o));
    assert!(s
        .dir("home")
        .join(".local-studio/plugins/polycarp/plugin.toml")
        .is_file());
    assert!(!s.plugin().exists());
}

#[test]
fn a_failed_grant_is_an_error_but_the_plugin_stays() {
    let s = Sandbox::new();
    s.local_studio(1);
    let o = s.run(&["install", "--local-studio"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(
        err(&o).contains("plugin grant polycarp mcp-server"),
        "{}",
        err(&o)
    );
    assert!(s.plugin().join("plugin.toml").is_file());
}

#[test]
fn uninstall_revokes_and_removes_and_a_second_one_is_fine() {
    let s = Sandbox::new();
    s.local_studio(0);
    assert!(s.run(&["install", "--local-studio"]).status.success());
    let o = s.run(&["install", "--local-studio", "--uninstall"]);
    assert_eq!(o.status.code(), Some(0), "{}", err(&o));
    assert!(!s.plugin().exists());
    assert!(
        s.dir("data/plugins").is_dir(),
        "only the plugin's own folder goes"
    );
    assert!(
        s.calls()
            .lines()
            .nth(1)
            .unwrap()
            .starts_with("plugin revoke polycarp data="),
        "{}",
        s.calls()
    );
    let again = s.run(&["install", "--uninstall", "--local-studio"]);
    assert_eq!(again.status.code(), Some(0));
    assert!(out(&again).contains("not installed"), "{}", out(&again));
}

#[test]
fn uninstall_of_a_linked_plugin_removes_only_the_link() {
    let s = Sandbox::new();
    let target = s.dir("checkout");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("plugin.toml"), "kept").unwrap();
    fs::create_dir_all(s.dir("data/plugins")).unwrap();
    std::os::unix::fs::symlink(&target, s.plugin()).unwrap();
    let o = s
        .cmd(&["install", "--local-studio", "--uninstall"], "empty")
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", err(&o));
    assert!(fs::symlink_metadata(s.plugin()).is_err());
    assert_eq!(
        fs::read_to_string(target.join("plugin.toml")).unwrap(),
        "kept"
    );
}

#[test]
fn install_needs_the_local_studio_flag() {
    let s = Sandbox::new();
    for args in [
        &["install"][..],
        &["install", "--uninstall"],
        &["install", "--local-studio", "--yes"],
    ] {
        let o = s.run(args);
        assert_eq!(o.status.code(), Some(2), "{args:?}");
        assert!(err(&o).contains("polycarp install --local-studio"));
    }
    assert!(!s.dir("data/plugins").exists());
    assert_eq!(s.calls(), "");
}

#[test]
fn the_installed_server_script_says_when_polycarp_is_missing() {
    let s = Sandbox::new();
    assert!(s
        .cmd(&["install", "--local-studio"], "empty")
        .output()
        .unwrap()
        .status
        .success());
    let o = Command::new("/bin/sh")
        .arg(s.plugin().join("bin/polycarp-mcp"))
        .env_clear()
        .env("HOME", s.dir("home"))
        .env("PATH", s.dir("empty"))
        .output()
        .unwrap();
    // A machine with Polycarp in /Applications would find it there; only check the miss where it can happen.
    if !Path::new("/Applications/Polycarp.app/Contents/Resources/bin/polycarp").exists() {
        assert_eq!(o.status.code(), Some(127));
        assert_eq!(err(&o).lines().count(), 1, "{}", err(&o));
        assert!(err(&o).contains("polycarp command was not found"));
    }
}

#[test]
fn the_installed_server_script_runs_the_agent_gateway() {
    let s = Sandbox::new();
    assert!(s
        .cmd(&["install", "--local-studio"], "empty")
        .output()
        .unwrap()
        .status
        .success());
    let fake = s.dir("bin").join("polycarp");
    fs::write(&fake, "#!/bin/sh\necho \"$*\"\n").unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    let o = Command::new("/bin/sh")
        .arg(s.plugin().join("bin/polycarp-mcp"))
        .env_clear()
        .env("HOME", s.dir("home"))
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(out(&o), "agent serve --stdio\n");
}
