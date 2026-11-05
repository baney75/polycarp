//! Integration tests: run the built binary against stub tools in a temp folder.
//! Every run gets its own HOME and PATH, so no real installed tool is reached.

use std::fs;
#[cfg(unix)]
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Stdio;
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
            Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("t{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&root);
        for d in ["home", "bin", "cwd", "empty"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Sandbox { root }
    }
    fn dir(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    /// A command with a clean environment: own HOME, PATH is only the empty folder.
    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_polycarp"));
        c.env_clear()
            .env("HOME", self.dir("home"))
            .env("USERPROFILE", self.dir("home"))
            .env("PATH", self.dir("empty"))
            .env("POLYCARP_NO_SYSTEM_SPOTS", "1")
            .current_dir(self.dir("cwd"))
            .args(args);
        if let Some(r) = std::env::var_os("SystemRoot") {
            c.env("SystemRoot", r);
        }
        c
    }
    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().unwrap()
    }
}

fn code(o: &Output) -> i32 {
    o.status.code().unwrap()
}
fn out(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}
fn err(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

#[cfg(unix)]
fn stub(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join(name);
    fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    p
}

/// Prints each argument as `[arg]`, then each stdin line as `in:line`, then exits with `exit_code`.
#[cfg(unix)]
fn echo_body(exit_code: i32) -> String {
    format!(
        "for a in \"$@\"; do printf '[%s]\\n' \"$a\"; done\n\
         while IFS= read -r l; do printf 'in:%s\\n' \"$l\"; done\n\
         exit {exit_code}"
    )
}

// ---- Tests that run on every system ----

#[test]
fn usage_and_version() {
    let s = Sandbox::new();
    let o = s.run(&["--help"]);
    assert_eq!(code(&o), 0);
    assert!(out(&o).contains("polycarp spaces"));
    let o = s.run(&["--version"]);
    assert_eq!(code(&o), 0);
    assert!(out(&o).starts_with("polycarp "));
}

#[test]
fn no_args_gives_2() {
    let s = Sandbox::new();
    let o = s.run(&[]);
    assert_eq!(code(&o), 2);
    assert!(err(&o).contains("Usage"));
}

#[test]
fn unknown_subcommand_gives_2() {
    let s = Sandbox::new();
    let o = s.run(&["frobnicate"]);
    assert_eq!(code(&o), 2);
    assert!(err(&o).contains("frobnicate"));
}

#[test]
fn not_found_gives_127_and_names_the_tool() {
    let s = Sandbox::new();
    for (sub, name, var) in [
        ("spaces", "baneyspaces", "POLYCARP_SPACES_BIN"),
        ("browser", "tabkyra", "POLYCARP_BROWSER_BIN"),
    ] {
        let o = s.run(&[sub, "x"]);
        assert_eq!(code(&o), 127, "{sub}");
        assert!(err(&o).contains(name), "{sub}: {}", err(&o));
        assert!(err(&o).contains(var), "{sub}: {}", err(&o));
        assert!(err(&o).contains("Install"), "{sub}: {}", err(&o));
    }
}

#[test]
fn override_pointing_nowhere_is_not_found() {
    let s = Sandbox::new();
    let o = s
        .cmd(&["spaces"])
        .env("POLYCARP_SPACES_BIN", s.dir("empty").join("nope"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 127);
}

#[test]
fn voice_with_args_gives_2() {
    let s = Sandbox::new();
    let o = s.run(&["voice", "dictate"]);
    assert_eq!(code(&o), 2);
    assert!(err(&o).contains("silas#6"));
}

#[test]
fn doctor_not_found_exits_1() {
    let s = Sandbox::new();
    let o = s.run(&["doctor"]);
    assert_eq!(code(&o), 1);
    let t = out(&o);
    assert!(t.contains("spaces: not found"), "{t}");
    assert!(t.contains("browser: not found"), "{t}");
    assert!(t.contains("voice: not found"), "{t}");
}

// ---- Unix tests with stub executables ----

#[cfg(unix)]
#[test]
fn args_pass_byte_for_byte() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", &echo_body(0));
    let o = s
        .cmd(&["spaces", "a b", "it's \"q\"", "", "--text", "$HOME", "*"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 0);
    assert_eq!(out(&o), "[a b]\n[it's \"q\"]\n[]\n[--text]\n[$HOME]\n[*]\n");
}

#[cfg(unix)]
#[test]
fn child_exit_code_comes_back() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "tabkyra", &echo_body(37));
    let o = s
        .cmd(&["browser", "--version"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 37);
    assert_eq!(out(&o), "[--version]\n");
}

#[cfg(unix)]
#[test]
fn stdin_reaches_the_stub_and_stdout_returns() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", &echo_body(0));
    let mut child = s
        .cmd(&["spaces"])
        .env("PATH", s.dir("bin"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"one\ntwo words\n")
        .unwrap();
    let o = child.wait_with_output().unwrap();
    assert_eq!(code(&o), 0);
    assert_eq!(out(&o), "in:one\nin:two words\n");
}

#[cfg(unix)]
#[test]
fn stderr_is_inherited() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", "echo oops >&2; exit 4");
    let o = s
        .cmd(&["spaces"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 4);
    assert_eq!(err(&o), "oops\n");
}

#[cfg(unix)]
#[test]
fn env_override_beats_path() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", "echo from-path");
    let other = s.dir("other");
    fs::create_dir_all(&other).unwrap();
    let chosen = stub(&other, "custom-name", "echo from-env");
    let o = s
        .cmd(&["spaces"])
        .env("PATH", s.dir("bin"))
        .env("POLYCARP_SPACES_BIN", &chosen)
        .output()
        .unwrap();
    assert_eq!(out(&o), "from-env\n");
    // An empty override is ignored.
    let o = s
        .cmd(&["spaces"])
        .env("PATH", s.dir("bin"))
        .env("POLYCARP_SPACES_BIN", "")
        .output()
        .unwrap();
    assert_eq!(out(&o), "from-path\n");
}

#[cfg(unix)]
#[test]
fn path_order_first_wins() {
    let s = Sandbox::new();
    let a = s.dir("a");
    let b = s.dir("b");
    fs::create_dir_all(&a).unwrap();
    fs::create_dir_all(&b).unwrap();
    stub(&a, "tabkyra", "echo A");
    stub(&b, "tabkyra", "echo B");
    let path = std::env::join_paths([&b, &a]).unwrap();
    let o = s.cmd(&["browser"]).env("PATH", path).output().unwrap();
    assert_eq!(out(&o), "B\n");
    let path = std::env::join_paths([&a, &b]).unwrap();
    let o = s.cmd(&["browser"]).env("PATH", path).output().unwrap();
    assert_eq!(out(&o), "A\n");
}

#[cfg(unix)]
#[test]
fn path_skips_non_executable_files_and_directories() {
    let s = Sandbox::new();
    let a = s.dir("a");
    fs::create_dir_all(a.join("tabkyra")).unwrap(); // a directory with the tool's name
    let b = s.dir("b");
    fs::create_dir_all(&b).unwrap();
    fs::write(b.join("tabkyra"), "#!/bin/sh\necho plain\n").unwrap(); // mode 644
    let c = s.dir("c");
    fs::create_dir_all(&c).unwrap();
    stub(&c, "tabkyra", "echo good");
    let path = std::env::join_paths([&a, &b, &c]).unwrap();
    let o = s.cmd(&["browser"]).env("PATH", path).output().unwrap();
    assert_eq!(out(&o), "good\n");
}

#[cfg(unix)]
#[test]
fn current_folder_is_never_run() {
    let s = Sandbox::new();
    let marker = s.dir("ran");
    // Planted in the current folder, for both tools.
    for name in ["baneyspaces", "tabkyra"] {
        stub(
            &s.dir("cwd"),
            name,
            &format!("echo x > '{}'; echo planted", marker.display()),
        );
    }
    // PATH has ".", an empty entry, a relative entry and then an empty folder.
    let path = format!(".::cwd:{}", s.dir("empty").display());
    for sub in ["spaces", "browser"] {
        let o = s.cmd(&[sub]).env("PATH", &path).output().unwrap();
        assert_eq!(code(&o), 127, "{sub}");
        assert!(!out(&o).contains("planted"));
    }
    assert!(!marker.exists());
    // A leading empty entry too.
    let path = format!(":{}", s.dir("empty").display());
    let o = s.cmd(&["spaces"]).env("PATH", path).output().unwrap();
    assert_eq!(code(&o), 127);
}

#[cfg(unix)]
#[test]
fn fixed_spot_under_home_is_used() {
    let s = Sandbox::new();
    let d = s.dir("home").join(".local/bin");
    fs::create_dir_all(&d).unwrap();
    stub(&d, "baneyspaces", "echo from-home");
    let o = s.run(&["spaces"]);
    assert_eq!(out(&o), "from-home\n");
}

#[cfg(unix)]
#[test]
fn voice_with_args_launches_nothing() {
    let s = Sandbox::new();
    let marker = s.dir("launched");
    let p = stub(
        &s.dir("bin"),
        "silas",
        &format!("echo x > '{}'", marker.display()),
    );
    let o = s
        .cmd(&["voice", "--flag"])
        .env("PATH", s.dir("bin"))
        .env("POLYCARP_VOICE_BIN", &p)
        .output()
        .unwrap();
    assert_eq!(code(&o), 2);
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(!marker.exists());
}

#[cfg(unix)]
#[test]
fn voice_without_args_launches_the_stub() {
    let s = Sandbox::new();
    let marker = s.dir("launched");
    let p = stub(
        &s.dir("bin"),
        "silas",
        &format!("echo x > '{}'", marker.display()),
    );
    let o = s
        .cmd(&["voice"])
        .env("POLYCARP_VOICE_BIN", &p)
        .output()
        .unwrap();
    assert_eq!(code(&o), 0);
    for _ in 0..50 {
        if marker.exists() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    panic!("the stub was not launched");
}

#[cfg(unix)]
#[test]
fn doctor_found_exits_0_and_shows_browser_version_only() {
    let s = Sandbox::new();
    let log = s.dir("calls");
    stub(
        &s.dir("bin"),
        "baneyspaces",
        &format!("echo called >> '{}'; echo SPACES-VERSION", log.display()),
    );
    stub(
        &s.dir("bin"),
        "tabkyra",
        "echo 'tabkyra 9.9.9'; echo second-line",
    );
    stub(
        &s.dir("bin"),
        "silas",
        &format!("echo called >> '{}'", log.display()),
    );
    let o = s
        .cmd(&["doctor"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 0);
    let t = out(&o);
    assert!(t.contains(&format!(
        "spaces: {}",
        s.dir("bin").join("baneyspaces").display()
    )));
    assert!(t.contains("(tabkyra 9.9.9)"), "{t}");
    assert!(!t.contains("second-line"));
    assert!(!t.contains("SPACES-VERSION"));
    assert!(t.contains("voice: "));
    assert!(!log.exists(), "doctor ran spaces or voice");
}

#[cfg(unix)]
#[test]
fn doctor_exits_1_when_one_required_tool_is_missing() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "tabkyra", "echo v1");
    let o = s
        .cmd(&["doctor"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 1);
    assert!(out(&o).contains("spaces: not found"));
}
