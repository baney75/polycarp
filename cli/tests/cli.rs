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
        ("spaces", "polycarp-spaces", "POLYCARP_SPACES_BIN"),
        ("browser", "polycarp-browser", "POLYCARP_BROWSER_BIN"),
    ] {
        let o = s.run(&[sub, "x"]);
        assert_eq!(code(&o), 127, "{sub}");
        assert!(err(&o).contains(name), "{sub}: {}", err(&o));
        assert!(err(&o).contains(var), "{sub}: {}", err(&o));
        assert!(err(&o).contains("Install"), "{sub}: {}", err(&o));
    }
    // The browser helper is named as Polycarp's, never by its old name.
    let o = s.run(&["browser", "x"]);
    assert!(
        err(&o).contains("Install the Polycarp browser helper from"),
        "{}",
        err(&o)
    );
    assert!(!err(&o).contains("Tabkyra"), "{}", err(&o));
    let help = s.run(&["--help"]);
    assert!(!out(&help).contains("Tabkyra") && !err(&help).contains("Tabkyra"));
    // The hint for Spaces points at the Polycarp repo, not at the old BaneySpaces one.
    let o = s.run(&["spaces", "x"]);
    assert!(
        err(&o).contains("https://github.com/baney75/polycarp"),
        "{}",
        err(&o)
    );
    assert!(!err(&o).contains("baneyspaces"), "{}", err(&o));
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
    assert!(err(&o).contains("has no commands yet"));
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
fn the_browser_helper_runs_as_polycarp_browser_and_an_old_tabkyra_is_still_found() {
    let s = Sandbox::new();
    let (old, new) = (s.dir("old"), s.dir("new"));
    fs::create_dir_all(&old).unwrap();
    fs::create_dir_all(&new).unwrap();
    // A script never sees its arg0 (the kernel puts the script path there), so the stub is bash itself: `bash -c` prints the
    // name it was run under, which is what `ps` shows. It must be polycarp-browser, never tabkyra.
    std::os::unix::fs::symlink("/bin/bash", old.join("tabkyra")).unwrap();
    let o = s
        .cmd(&["browser", "-c", "echo \"$0\""])
        .env("PATH", &old)
        .output()
        .unwrap();
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert_eq!(out(&o), "polycarp-browser\n");
    // With both on PATH, the new name wins.
    stub(&new, "polycarp-browser", "echo new");
    let both = std::env::join_paths([old, new]).unwrap();
    let o = s.cmd(&["browser"]).env("PATH", both).output().unwrap();
    assert_eq!(out(&o), "new\n");
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

/// A real compiled stub, so handoff is proven on every system, Windows included.
fn compiled_stub() -> PathBuf {
    static STUB: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    STUB.get_or_init(|| {
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("stub");
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join(format!("stub{}", std::env::consts::EXE_SUFFIX));
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/stub.rs");
        let done = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .arg(&src)
            .arg("-o")
            .arg(&exe)
            .status()
            .unwrap();
        assert!(done.success(), "the stub must compile");
        exe
    })
    .clone()
}

#[test]
fn compiled_stub_gets_exact_args_stdin_and_exit_code() {
    use std::io::Write as _;
    let s = Sandbox::new();
    let mut child = s
        .cmd(&["spaces", "a b", "say \"hi\"", "", "--flag=1"])
        .env("POLYCARP_SPACES_BIN", compiled_stub())
        .env("STUB_EXIT", "37")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"from stdin")
        .unwrap();
    let o = child.wait_with_output().unwrap();
    assert_eq!(code(&o), 37);
    let text = out(&o);
    assert!(text.contains("[a b]"), "{text}");
    assert!(text.contains("[say \"hi\"]"), "{text}");
    assert!(text.contains("[]"), "{text}");
    assert!(text.contains("[--flag=1]"), "{text}");
    assert!(text.contains("stdin:from stdin"), "{text}");
}

#[test]
fn relative_override_is_never_run() {
    let s = Sandbox::new();
    let name = format!("planted{}", std::env::consts::EXE_SUFFIX);
    fs::copy(compiled_stub(), s.dir("cwd").join(&name)).unwrap();
    for value in [format!("./{name}"), name.clone()] {
        let o = s
            .cmd(&["spaces", "x"])
            .env("POLYCARP_SPACES_BIN", &value)
            .output()
            .unwrap();
        assert_eq!(code(&o), 127, "{value}: {}", out(&o));
        assert!(!out(&o).contains("[x]"), "{value} ran");
    }
}

#[test]
fn absolute_path_to_the_current_folder_is_never_run() {
    let s = Sandbox::new();
    let name = format!("baneyspaces{}", std::env::consts::EXE_SUFFIX);
    fs::copy(compiled_stub(), s.dir("cwd").join(&name)).unwrap();
    let path = std::env::join_paths([s.dir("cwd")]).unwrap();
    let o = s.cmd(&["spaces", "x"]).env("PATH", path).output().unwrap();
    assert_eq!(code(&o), 127, "{}", out(&o));
    let o = s
        .cmd(&["spaces", "x"])
        .env("POLYCARP_SPACES_BIN", s.dir("cwd").join(&name))
        .output()
        .unwrap();
    assert_eq!(code(&o), 127, "{}", out(&o));
}

#[cfg(unix)]
#[test]
fn symlink_to_the_current_folder_is_never_run() {
    let s = Sandbox::new();
    fs::copy(compiled_stub(), s.dir("cwd").join("baneyspaces")).unwrap();
    let link = s.dir("bin").join("here");
    std::os::unix::fs::symlink(s.dir("cwd"), &link).unwrap();
    let o = s.cmd(&["spaces", "x"]).env("PATH", &link).output().unwrap();
    assert_eq!(code(&o), 127, "{}", out(&o));
}

#[cfg(unix)]
#[test]
fn the_child_sees_its_own_name_as_argv0() {
    let s = Sandbox::new();
    let o = s
        .cmd(&["spaces"])
        .env("POLYCARP_SPACES_BIN", compiled_stub())
        .output()
        .unwrap();
    assert!(out(&o).contains("argv0:polycarp-spaces"), "{}", out(&o));
}

#[cfg(unix)]
#[test]
fn doctor_says_when_the_browser_tool_is_broken() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", "exit 0");
    stub(&s.dir("bin"), "tabkyra", "echo oops; exit 3");
    let o = s
        .cmd(&["doctor"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 1, "{}", out(&o));
    assert!(out(&o).contains("did not work"), "{}", out(&o));
    assert!(!out(&o).contains("oops"), "{}", out(&o));
}

#[cfg(unix)]
#[test]
fn spaces_prefers_the_new_command_name_and_falls_back_to_the_old() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", "echo old");
    let o = s
        .cmd(&["spaces"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(out(&o), "old\n", "the old name still works alone");
    stub(&s.dir("bin"), "polycarp-spaces", "echo new");
    let o = s
        .cmd(&["spaces"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(out(&o), "new\n", "the new name wins when both are there");
}

// ---- Issue #5 follow-ups ----

/// A tool below the current folder, such as node_modules/.bin on PATH, is never run.
#[cfg(unix)]
#[test]
fn a_path_entry_below_the_current_folder_is_refused_and_named() {
    let s = Sandbox::new();
    let marker = s.dir("ran");
    let below = s.dir("cwd").join("node_modules/.bin");
    fs::create_dir_all(&below).unwrap();
    stub(
        &below,
        "baneyspaces",
        &format!("echo x > '{}'", marker.display()),
    );
    let o = s.cmd(&["spaces"]).env("PATH", &below).output().unwrap();
    assert_eq!(code(&o), 127);
    assert!(!marker.exists());
    let e = err(&o);
    assert!(e.contains("current folder"), "{e}");
    assert!(
        e.contains(below.join("baneyspaces").to_str().unwrap()),
        "{e}"
    );
    assert!(!e.contains("Install"), "{e}");
}

/// From the home folder, an ancestor of it, or `/`, a tool in `~/.local/bin` is fine.
#[cfg(unix)]
#[test]
fn from_home_or_an_ancestor_of_home_a_tool_under_home_still_runs() {
    let s = Sandbox::new();
    let d = s.dir("home").join(".local/bin");
    fs::create_dir_all(&d).unwrap();
    stub(&d, "baneyspaces", "echo from-home");
    for cwd in [s.dir("home"), PathBuf::from("/"), s.root.clone()] {
        let o = s
            .cmd(&["spaces"])
            .env("PATH", &d)
            .current_dir(&cwd)
            .output()
            .unwrap();
        assert_eq!(
            out(&o),
            "from-home\n",
            "from {}: {}",
            cwd.display(),
            err(&o)
        );
    }
    // `.local/bin` is neither home nor an ancestor of it, so as the current folder it is refused.
    let o = s
        .cmd(&["spaces"])
        .env("PATH", &d)
        .current_dir(&d)
        .output()
        .unwrap();
    assert_eq!(code(&o), 127);
}

/// The exception is narrow: from `~`, a file in `~` and `~/node_modules/.bin` are still refused.
#[cfg(unix)]
#[test]
fn from_home_only_the_allowed_places_under_home_run() {
    let s = Sandbox::new();
    let home = s.dir("home");
    let nm = home.join("node_modules/.bin");
    fs::create_dir_all(&nm).unwrap();
    let marker = s.dir("ran");
    let body = format!("echo x > '{}'", marker.display());
    stub(&nm, "baneyspaces", &body);
    stub(&home, "baneyspaces", &body);
    for dir in [&nm, &home] {
        let o = s
            .cmd(&["spaces"])
            .env("PATH", dir)
            .current_dir(&home)
            .output()
            .unwrap();
        assert_eq!(code(&o), 127, "{}", dir.display());
        assert!(err(&o).contains("current folder"), "{}", err(&o));
    }
    assert!(!marker.exists());
}

/// HOME inside a checkout, with the checkout as the current folder: a tool outside HOME but
/// inside the checkout is refused, and the one under HOME's .local/bin is not.
#[cfg(unix)]
#[test]
fn home_inside_the_current_folder_does_not_open_the_whole_folder() {
    let s = Sandbox::new();
    let marker = s.dir("ran");
    stub(
        &s.dir("bin"),
        "baneyspaces",
        &format!("echo x > '{}'", marker.display()),
    );
    let o = s
        .cmd(&["spaces"])
        .env("PATH", s.dir("bin"))
        .current_dir(&s.root)
        .output()
        .unwrap();
    assert_eq!(code(&o), 127, "{}", err(&o));
    assert!(!marker.exists());
    let local = s.dir("home").join(".local/bin");
    fs::create_dir_all(&local).unwrap();
    stub(&local, "baneyspaces", "echo ok");
    let o = s
        .cmd(&["spaces"])
        .env("PATH", &local)
        .current_dir(&s.root)
        .output()
        .unwrap();
    assert_eq!(out(&o), "ok\n");
}

/// With no current folder to compare against, nothing runs.
#[cfg(unix)]
#[test]
fn an_unresolvable_current_folder_fails_closed() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", "echo ran");
    let mut c = Command::new("/bin/sh");
    c.env_clear()
        .env("HOME", s.dir("home"))
        .env("PATH", s.dir("bin"))
        .env("POLYCARP_NO_SYSTEM_SPOTS", "1")
        .current_dir(s.dir("cwd"))
        .arg("-c")
        .arg("/bin/rmdir \"$1\" && exec \"$2\" spaces")
        .arg("sh")
        .arg(s.dir("cwd"))
        .arg(env!("CARGO_BIN_EXE_polycarp"));
    let o = c.output().unwrap();
    assert_eq!(code(&o), 127, "{}{}", out(&o), err(&o));
    assert!(!out(&o).contains("ran"));
    assert!(err(&o).contains("current folder"), "{}", err(&o));
}

/// `sleep 60 &` leaves a process holding stdout; doctor must still end within its limit.
#[cfg(unix)]
#[test]
fn doctor_time_limit_covers_reading() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", "exit 0");
    stub(&s.dir("bin"), "tabkyra", "/bin/sleep 60 &\necho tabkyra 1");
    let started = std::time::Instant::now();
    let o = s
        .cmd(&["doctor"])
        .env("PATH", s.dir("bin"))
        .env("POLYCARP_DOCTOR_LIMIT_MS", "500")
        .stdin(Stdio::null())
        .output();
    // output() waits on the stub's background process only if doctor leaks it; doctor itself
    // must be back long before the 60 seconds are up.
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
    let o = o.unwrap();
    assert_eq!(code(&o), 1);
    assert!(out(&o).contains("did not work"), "{}", out(&o));
}

#[cfg(unix)]
#[test]
fn doctor_piped_to_a_closed_reader_ends_quietly() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", "exit 0");
    stub(&s.dir("bin"), "tabkyra", "/bin/sleep 1\necho tabkyra 1");
    let mut child = s
        .cmd(&["doctor"])
        .env("PATH", s.dir("bin"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Close the reading end at once, as `| head -1` does. Doctor writes after the 1 s wait.
    drop(child.stdout.take());
    let o = child.wait_with_output().unwrap();
    assert!(!err(&o).contains("panicked"), "{}", err(&o));
    assert_ne!(code(&o), 101);
}

/// A closed reader must not make a failing check look healthy.
#[cfg(unix)]
#[test]
fn doctor_with_a_closed_reader_still_reports_a_missing_tool_in_its_exit_code() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", "exit 0");
    let mut child = s
        .cmd(&["doctor"])
        .env("PATH", s.dir("bin"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    let o = child.wait_with_output().unwrap();
    assert_eq!(code(&o), 1, "{}", err(&o));
    assert!(!err(&o).contains("panicked"));
}

#[cfg(unix)]
#[test]
fn an_override_to_a_cmd_or_bat_file_is_refused_with_the_reason() {
    let s = Sandbox::new();
    for name in ["tabkyra.cmd", "tabkyra.BAT"] {
        let p = stub(&s.dir("bin"), name, "echo ran");
        let o = s
            .cmd(&["browser"])
            .env("POLYCARP_SHIM_CHECK", "1")
            .env("POLYCARP_BROWSER_BIN", &p)
            .output()
            .unwrap();
        assert_eq!(code(&o), 127, "{name}");
        assert!(!out(&o).contains("ran"));
        let e = err(&o);
        assert!(
            e.contains("shell") && e.contains("POLYCARP_BROWSER_BIN"),
            "{e}"
        );
    }
}

#[cfg(unix)]
#[test]
fn doctor_reports_a_cmd_shim_as_present_but_not_runnable_with_advice() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", "exit 0");
    stub(&s.dir("bin"), "tabkyra.cmd", "echo ran");
    let o = s
        .cmd(&["doctor"])
        .env("POLYCARP_SHIM_CHECK", "1")
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 1);
    let t = out(&o);
    assert!(t.contains("present but not runnable"), "{t}");
    assert!(
        t.contains("Node") && t.contains("POLYCARP_BROWSER_BIN"),
        "{t}"
    );
    assert!(!t.contains("browser: not found"), "{t}");
    let o = s
        .cmd(&["browser"])
        .env("POLYCARP_SHIM_CHECK", "1")
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 127);
    assert!(err(&o).contains("Node"), "{}", err(&o));
}

/// On a Mac, `doctor` and `voice` look at the same fixed app path.
#[cfg(target_os = "macos")]
#[test]
fn voice_and_doctor_use_the_same_app_path_on_a_mac() {
    let s = Sandbox::new();
    let o = s.run(&["voice"]);
    assert_eq!(code(&o), 127, "{}", err(&o));
    assert!(err(&o).contains("not found"), "{}", err(&o));
    let app = s.dir("home").join("Applications/Silas.app");
    fs::create_dir_all(app.join("Contents")).unwrap();
    let o = s.run(&["doctor"]);
    assert!(
        out(&o).contains(&format!("voice: {}", app.display())),
        "{}",
        out(&o)
    );
}

// ---- Issue #17: the lookup from the home folder ----

/// From `~`, normal per-user installs run: nvm, cargo, bun, volta, asdf, mise, ~/.local, and the
/// Polycarp app's command.
#[cfg(unix)]
#[test]
fn from_home_per_user_installs_run() {
    let s = Sandbox::new();
    let home = s.dir("home");
    for rel in [
        ".nvm/versions/node/v20/bin",
        ".cargo/bin",
        ".bun/bin",
        ".volta/bin",
        ".asdf/shims",
        ".local/share/mise/shims",
        ".local/bin",
        "Applications/Polycarp.app/Contents/Resources/bin",
    ] {
        let d = home.join(rel);
        fs::create_dir_all(&d).unwrap();
        stub(&d, "baneyspaces", &format!("echo from {rel}"));
        let o = s
            .cmd(&["spaces"])
            .env("PATH", &d)
            .current_dir(&home)
            .output()
            .unwrap();
        assert_eq!(out(&o), format!("from {rel}\n"), "{rel}: {}", err(&o));
        fs::remove_file(d.join("baneyspaces")).unwrap();
    }
}

/// An npm prefix of ~/.local: the entry in bin is a link into lib/node_modules.
#[cfg(unix)]
#[test]
fn from_home_an_npm_prefix_link_inside_local_runs() {
    let s = Sandbox::new();
    let home = s.dir("home");
    let real = home.join(".local/lib/node_modules/tabkyra/bin");
    let bin = home.join(".local/bin");
    fs::create_dir_all(&real).unwrap();
    fs::create_dir_all(&bin).unwrap();
    stub(&real, "tabkyra", "echo npm-prefix");
    std::os::unix::fs::symlink(real.join("tabkyra"), bin.join("tabkyra")).unwrap();
    let o = s
        .cmd(&["browser"])
        .env("PATH", &bin)
        .current_dir(&home)
        .output()
        .unwrap();
    assert_eq!(out(&o), "npm-prefix\n", "{}", err(&o));
}

/// A link is judged by where it sits and by where it leads.
#[cfg(unix)]
#[test]
fn from_home_a_link_cannot_carry_a_project_tool_in_or_an_allowed_one_out() {
    let s = Sandbox::new();
    let home = s.dir("home");
    let marker = s.dir("ran");
    let body = format!("echo x > '{}'", marker.display());
    // Allowed folder, project target.
    let proj = home.join("proj/node_modules/.bin");
    let bin = home.join(".local/bin");
    fs::create_dir_all(&proj).unwrap();
    fs::create_dir_all(&bin).unwrap();
    stub(&proj, "baneyspaces", &body);
    std::os::unix::fs::symlink(proj.join("baneyspaces"), bin.join("baneyspaces")).unwrap();
    let o = s
        .cmd(&["spaces"])
        .env("PATH", &bin)
        .current_dir(&home)
        .output()
        .unwrap();
    assert_eq!(code(&o), 127);
    // Project folder, allowed target.
    let cargo = home.join(".cargo/bin");
    let tools = home.join("proj/bin");
    fs::create_dir_all(&cargo).unwrap();
    fs::create_dir_all(&tools).unwrap();
    stub(&cargo, "tabkyra", &body);
    std::os::unix::fs::symlink(cargo.join("tabkyra"), tools.join("tabkyra")).unwrap();
    let o = s
        .cmd(&["browser"])
        .env("PATH", &tools)
        .current_dir(&home)
        .output()
        .unwrap();
    assert_eq!(code(&o), 127);
    assert!(!marker.exists());
}

/// Still refused from `~`: a project folder, `node_modules/.bin` and a file in `~`.
#[cfg(unix)]
#[test]
fn from_home_project_folders_are_still_refused() {
    let s = Sandbox::new();
    let home = s.dir("home");
    // "." is the home folder itself: a file directly in `~`.
    for rel in [
        ".",
        "proj/bin",
        "proj/.cargo/bin",
        "node_modules/.bin",
        "Applications/tools",
        // A repo cloned into a tree that is not itself an install place.
        ".local/share/nvim/lazy/repo/node_modules/.bin",
        ".local/src/proj/bin",
        ".asdf/plugins/node/bin",
        ".nvm/repo/bin",
        // A folder named like an app, without Contents/, and one that is not under Contents/.
        "Applications/proj.app/node_modules/.bin",
        "Applications/real.app/node_modules/.bin",
    ] {
        if rel.starts_with("Applications/real.app") {
            fs::create_dir_all(home.join("Applications/real.app/Contents")).unwrap();
        }
        let d = home.join(rel);
        fs::create_dir_all(&d).unwrap();
        stub(&d, "baneyspaces", "echo ran");
        let o = s
            .cmd(&["spaces"])
            .env("PATH", &d)
            .current_dir(&home)
            .output()
            .unwrap();
        assert_eq!(code(&o), 127, "{rel}");
        assert!(!out(&o).contains("ran"), "{rel}");
    }
}

/// bun's global install: the entry in bin is a link into install/global/node_modules.
#[cfg(unix)]
#[test]
fn from_home_a_bun_global_link_runs_and_so_do_npm_global_and_pnpm() {
    let s = Sandbox::new();
    let home = s.dir("home");
    let real = home.join(".bun/install/global/node_modules/tabkyra/bin");
    let bin = home.join(".bun/bin");
    fs::create_dir_all(&real).unwrap();
    fs::create_dir_all(&bin).unwrap();
    stub(&real, "tabkyra", "echo bun");
    std::os::unix::fs::symlink(real.join("tabkyra"), bin.join("tabkyra")).unwrap();
    let o = s
        .cmd(&["browser"])
        .env("PATH", &bin)
        .current_dir(&home)
        .output()
        .unwrap();
    assert_eq!(out(&o), "bun\n", "{}", err(&o));
    for rel in [
        ".npm-global/bin",
        "Library/pnpm",
        "scoop/shims",
        "AppData/Local/Programs",
    ] {
        let d = home.join(rel);
        fs::create_dir_all(&d).unwrap();
        stub(&d, "baneyspaces", &format!("echo {rel}"));
        let o = s
            .cmd(&["spaces"])
            .env("PATH", &d)
            .current_dir(&home)
            .output()
            .unwrap();
        assert_eq!(out(&o), format!("{rel}\n"), "{rel}: {}", err(&o));
    }
}

/// A home under an allowed system folder does not open the home's project folders. The list of
/// system folders is replaced by the sandbox root for this test.
#[cfg(unix)]
#[test]
fn a_home_under_a_system_folder_still_refuses_its_project_folders() {
    let s = Sandbox::new();
    let home = s.dir("home");
    let proj = home.join("proj/node_modules/.bin");
    fs::create_dir_all(&proj).unwrap();
    stub(&proj, "baneyspaces", "echo ran");
    stub(&s.dir("bin"), "baneyspaces", "echo system");
    for cwd in [&home, &s.root] {
        let o = s
            .cmd(&["spaces"])
            .env("PATH", &proj)
            .env("POLYCARP_TEST_SYSTEM_ALLOWED", &s.root)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert_eq!(code(&o), 127, "from {}", cwd.display());
        assert!(!out(&o).contains("ran"));
    }
    // Outside the home folder, the system folder is allowed.
    let o = s
        .cmd(&["spaces"])
        .env("PATH", s.dir("bin"))
        .env("POLYCARP_TEST_SYSTEM_ALLOWED", &s.root)
        .current_dir(&s.root)
        .output()
        .unwrap();
    assert_eq!(out(&o), "system\n", "{}", err(&o));
}

/// POLYCARP_OPEN_BIN passes the same gate as every other program.
#[cfg(target_os = "macos")]
#[test]
fn the_open_override_cannot_be_a_file_in_the_project_or_a_bare_name() {
    let s = Sandbox::new();
    let home = s.dir("home");
    fs::create_dir_all(home.join("Applications/Silas.app/Contents")).unwrap();
    let marker = s.dir("ran");
    let proj = home.join("proj");
    fs::create_dir_all(&proj).unwrap();
    let evil = stub(&proj, "evil", &format!("echo x > '{}'", marker.display()));
    for open in [evil.as_os_str().to_owned(), "evil".into(), "./evil".into()] {
        let o = s
            .cmd(&["voice"])
            .env("POLYCARP_OPEN_BIN", &open)
            .current_dir(&home)
            .output()
            .unwrap();
        assert_eq!(code(&o), 127, "{open:?}: {}", err(&o));
        assert!(err(&o).contains("POLYCARP_OPEN_BIN"), "{}", err(&o));
    }
    assert!(!marker.exists());
}

/// A link named like an app, leading to a folder elsewhere, is not an app bundle.
#[cfg(target_os = "macos")]
#[test]
fn a_linked_app_bundle_is_refused() {
    let s = Sandbox::new();
    let home = s.dir("home");
    fs::create_dir_all(home.join("Applications")).unwrap();
    let elsewhere = s.dir("elsewhere/Silas.app");
    fs::create_dir_all(elsewhere.join("Contents")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, home.join("Applications/Silas.app")).unwrap();
    let log = s.dir("open-args");
    let open = stub(
        &s.dir("bin"),
        "fake-open",
        &format!("echo \"$@\" > '{}'", log.display()),
    );
    let o = s
        .cmd(&["voice"])
        .env("POLYCARP_OPEN_BIN", &open)
        .current_dir(&home)
        .output()
        .unwrap();
    assert_eq!(code(&o), 127, "{}", err(&o));
    assert!(!log.exists(), "open was called");
}

/// `voice` and `doctor` from `~`, with the app only in `~/Applications`. `open` is a stub, so
/// no app is launched.
#[cfg(target_os = "macos")]
#[test]
fn from_home_voice_and_doctor_find_an_app_only_in_home_applications() {
    let s = Sandbox::new();
    let home = s.dir("home");
    let app = home.join("Applications/Silas.app");
    fs::create_dir_all(app.join("Contents")).unwrap();
    let log = s.dir("open-args");
    let open = stub(
        &s.dir("bin"),
        "fake-open",
        &format!("echo \"$@\" > '{}'", log.display()),
    );
    let o = s.cmd(&["doctor"]).current_dir(&home).output().unwrap();
    assert!(
        out(&o).contains(&format!("voice: {}", app.display())),
        "{}",
        out(&o)
    );
    let o = s
        .cmd(&["voice"])
        .env("POLYCARP_OPEN_BIN", &open)
        .current_dir(&home)
        .output()
        .unwrap();
    assert_eq!(code(&o), 0, "{}", err(&o));
    let args = fs::read_to_string(&log).unwrap();
    assert!(args.contains(app.to_str().unwrap()), "{args}");
}

/// An optional tool (Silas) with only a script found must not fail `doctor`.
#[cfg(unix)]
#[test]
fn a_voice_script_alone_does_not_fail_doctor() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", "exit 0");
    stub(&s.dir("bin"), "tabkyra", "echo tabkyra 1");
    let shim = stub(&s.dir("bin"), "silas.cmd", "exit 0");
    let o = s
        .cmd(&["doctor"])
        .env("PATH", s.dir("bin"))
        .env("POLYCARP_SHIM_CHECK", "1")
        .env("POLYCARP_VOICE_BIN", &shim)
        .output()
        .unwrap();
    assert_eq!(code(&o), 0, "{}", out(&o));
    assert!(
        out(&o).contains("voice: present but not runnable"),
        "{}",
        out(&o)
    );
}

#[cfg(unix)]
#[test]
fn browser_finds_the_copy_inside_the_app_before_path() {
    let s = Sandbox::new();
    let app = s
        .dir("home")
        .join("Applications/Polycarp.app/Contents/Resources/browser");
    fs::create_dir_all(&app).unwrap();
    stub(&app, "polycarp-browser", "echo bundled \"$@\"");
    let on_path = s.dir("a");
    fs::create_dir_all(&on_path).unwrap();
    stub(&on_path, "tabkyra", "echo from-path");
    let o = s
        .cmd(&["browser", "mcp"])
        .env("PATH", &on_path)
        .output()
        .unwrap();
    assert_eq!(out(&o), "bundled mcp\n");
    // The override still wins over the app's copy.
    let mine = stub(&on_path, "mine", "echo override");
    let o = s
        .cmd(&["browser"])
        .env("POLYCARP_BROWSER_BIN", &mine)
        .output()
        .unwrap();
    assert_eq!(out(&o), "override\n");
}

#[cfg(unix)]
#[test]
fn browser_falls_back_to_path_without_the_app() {
    let s = Sandbox::new();
    let on_path = s.dir("a");
    fs::create_dir_all(&on_path).unwrap();
    stub(&on_path, "tabkyra", "echo from-path");
    let o = s.cmd(&["browser"]).env("PATH", &on_path).output().unwrap();
    assert_eq!(out(&o), "from-path\n");
}

#[cfg(unix)]
#[test]
fn doctor_shows_the_bundled_browser_helper_and_its_version() {
    let s = Sandbox::new();
    let app = s
        .dir("home")
        .join("Applications/Polycarp.app/Contents/Resources/browser");
    fs::create_dir_all(&app).unwrap();
    stub(&app, "polycarp-browser", "echo 1.2.3");
    let o = s.run(&["doctor"]);
    let t = out(&o);
    assert!(t.contains("polycarp-browser (1.2.3)"), "{t}");
}

/// With Polycarp installed, voice is inside it: `polycarp voice` opens its Voice settings through `polycarp://voice`,
/// even when a Silas is also there, and `doctor` says so. `open` is a stub, so nothing is launched.
#[cfg(target_os = "macos")]
#[test]
fn voice_opens_polycarps_voice_settings_when_it_is_installed() {
    let s = Sandbox::new();
    let home = s.dir("home");
    let polycarp = home.join("Applications/Polycarp.app");
    let silas = home.join("Applications/Silas.app");
    fs::create_dir_all(polycarp.join("Contents")).unwrap();
    fs::create_dir_all(silas.join("Contents")).unwrap();
    let log = s.dir("open-args");
    let open = stub(
        &s.dir("bin"),
        "fake-open",
        &format!("echo \"$@\" > '{}'", log.display()),
    );
    let o = s
        .cmd(&["voice"])
        .env("POLYCARP_OPEN_BIN", &open)
        .current_dir(&home)
        .output()
        .unwrap();
    assert_eq!(code(&o), 0, "{}", err(&o));
    let args = fs::read_to_string(&log).unwrap();
    assert!(args.contains("polycarp://voice"), "{args}");
    assert!(args.contains(polycarp.to_str().unwrap()), "{args}");
    assert!(!args.contains("Silas.app"), "Silas is not opened: {args}");
    let o = s.cmd(&["doctor"]).current_dir(&home).output().unwrap();
    assert!(out(&o).contains("voice: inside Polycarp"), "{}", out(&o));
}

/// Silas is only the fallback: no Polycarp, the old behavior.
#[cfg(target_os = "macos")]
#[test]
fn voice_falls_back_to_silas_only_when_polycarp_is_not_installed() {
    let s = Sandbox::new();
    let home = s.dir("home");
    let silas = home.join("Applications/Silas.app");
    fs::create_dir_all(silas.join("Contents")).unwrap();
    let log = s.dir("open-args");
    let open = stub(
        &s.dir("bin"),
        "fake-open",
        &format!("echo \"$@\" > '{}'", log.display()),
    );
    let o = s
        .cmd(&["voice"])
        .env("POLYCARP_OPEN_BIN", &open)
        .current_dir(&home)
        .output()
        .unwrap();
    assert_eq!(code(&o), 0, "{}", err(&o));
    let args = fs::read_to_string(&log).unwrap();
    assert!(
        args.contains("Silas.app") && !args.contains("polycarp://"),
        "{args}"
    );
}

// ---- polycarp version and polycarp update ----

#[cfg(unix)]
const OTHER_COMMIT: &str = "bbbbbbb2222222222222222222222222222222bb";

fn json(o: &Output) -> serde_json::Value {
    serde_json::from_str(&out(o)).unwrap_or_else(|e| panic!("not JSON ({e}): {}", out(o)))
}

fn part<'a>(v: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    v["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == name)
        .unwrap_or_else(|| panic!("no part named {name} in {v}"))
}

#[test]
fn version_lists_the_command_and_says_what_is_not_installed() {
    let s = Sandbox::new();
    let o = s.run(&["version", "--json"]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    let v = json(&o);
    let me = part(&v, "polycarp command");
    assert_eq!(me["installed"], true);
    assert_eq!(me["version"], env!("CARGO_PKG_VERSION"));
    // The commit in the list is the one `--version` prints.
    let line = out(&s.run(&["--version"]));
    if let Some(commit) = me["commit"].as_str() {
        assert_eq!(commit.len(), 40, "{commit}");
        assert!(line.contains(&commit[..7]), "{line}");
    }
    for name in [
        "spaces command",
        "browser helper",
        "extension",
        "voice core",
        "agent skill",
    ] {
        let p = part(&v, name);
        assert_eq!(p["installed"], false, "{name}");
        assert!(p["state"].as_str().is_some_and(|t| !t.is_empty()), "{name}");
    }
    assert!(v["verdict"].as_str().unwrap().starts_with("versions: "));
    // The table says the same, and a missing part is not an error.
    let o = s.run(&["version"]);
    assert_eq!(code(&o), 0);
    let t = out(&o);
    assert!(
        t.contains("browser helper") && t.contains("not installed"),
        "{t}"
    );
    assert!(t.lines().last().unwrap().starts_with("versions: "), "{t}");
    assert_eq!(code(&s.run(&["version", "--bogus"])), 2);
}

#[cfg(unix)]
#[test]
fn version_check_names_the_part_from_another_commit_and_never_runs_spaces() {
    let s = Sandbox::new();
    let log = s.dir("calls");
    // The stamp a real Linux build carries, here inside a script: it is read from the file, not by running it.
    stub(
        &s.dir("bin"),
        "polycarp-spaces",
        &format!(
            "# polycarp-build|v1|{OTHER_COMMIT}|2026-11-01T00:00:00Z|0|0.1.0|end|\necho called >> '{}'",
            log.display()
        ),
    );
    stub(
        &s.dir("bin"),
        "polycarp-browser",
        &format!(
            "case \"$1\" in\n\
             version) echo '{{\"version\":\"1.2.3\",\"commit\":\"{OTHER_COMMIT}\",\"commitDate\":\"2026-11-01T00:00:00Z\",\"dirty\":false}}';;\n\
             status) echo '{{\"connected\":true,\"extensions\":[{{\"browser\":\"Helium\",\"version\":\"1.2.3\",\"commit\":\"{OTHER_COMMIT}\",\"commitDate\":\"\",\"dirty\":false}},{{\"browser\":\"Chrome\",\"version\":\"1.2.2\",\"commit\":\"\",\"dirty\":false}}]}}';;\n\
             esac"
        ),
    );
    let o = s
        .cmd(&["version", "--json", "--check"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    let v = json(&o);
    assert_eq!(code(&o), 1, "{v}");
    assert_eq!(v["match"], false);
    assert_eq!(part(&v, "spaces command")["commit"], OTHER_COMMIT);
    assert_eq!(part(&v, "browser helper")["version"], "1.2.3");
    assert_eq!(part(&v, "extension (Helium)")["commit"], OTHER_COMMIT);
    assert_eq!(part(&v, "extension (Chrome)")["installed"], true);
    // Chrome's extension reports no commit at all: it is always named.
    let odd: Vec<&str> = v["odd"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["name"].as_str().unwrap())
        .collect();
    assert!(odd.contains(&"extension (Chrome)"), "{odd:?}");
    let verdict = v["verdict"].as_str().unwrap();
    assert!(
        verdict.contains("do not all match") && verdict.contains("polycarp update"),
        "{verdict}"
    );
    assert!(!log.exists(), "version ran the spaces command");
    // Without --check the same list exits 0.
    let o = s
        .cmd(&["version"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 0);
    // doctor ends with the same one line, and its exit code is still about the tools only.
    let o = s
        .cmd(&["doctor"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    let t = out(&o);
    assert!(t.lines().any(|l| l == verdict), "{t}");
    assert!(!log.exists(), "doctor ran the spaces command");
}

#[cfg(target_os = "macos")]
#[test]
fn version_reads_the_app_from_its_info_plist() {
    let s = Sandbox::new();
    let app = s.dir("home").join("Applications/Polycarp.app/Contents");
    fs::create_dir_all(&app).unwrap();
    fs::write(
        app.join("Info.plist"),
        format!(
            "<plist><dict>\n<key>CFBundleShortVersionString</key><string>0.9.1</string>\n\
             <key>PolycarpCommit</key><string>{OTHER_COMMIT}</string>\n\
             <key>PolycarpCommitDate</key><string>2026-11-01T00:00:00Z</string>\n\
             <key>PolycarpCommitDirty</key><string>1</string>\n</dict></plist>"
        ),
    )
    .unwrap();
    let v = json(&s.run(&["version", "--json"]));
    let p = part(&v, "app");
    assert_eq!(p["version"], "0.9.1");
    assert_eq!(p["commit"], OTHER_COMMIT);
    assert_eq!(p["dirty"], true);
    // The voice core is linked into the app, so it is the app's build.
    assert_eq!(part(&v, "voice core")["commit"], OTHER_COMMIT);
}

/// A folder with git in it and nothing else, so `update` can ask git about a checkout.
#[cfg(unix)]
fn git_only_path(s: &Sandbox) -> Option<PathBuf> {
    use std::os::unix::fs::symlink;
    let git = std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join("git"))
        .find(|p| p.is_file())?;
    let dir = s.dir("gitbin");
    fs::create_dir_all(&dir).unwrap();
    let _ = symlink(git, dir.join("git"));
    Some(dir)
}

/// An empty git repo whose origin is `origin`. Nothing is ever fetched from it.
#[cfg(unix)]
fn checkout(s: &Sandbox, name: &str, origin: &str, path: &Path) -> PathBuf {
    let dir = s.dir(name);
    fs::create_dir_all(&dir).unwrap();
    for args in [vec!["init", "-q"], vec!["remote", "add", "origin", origin]] {
        let ok = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(&args)
            .env("PATH", path)
            .env("HOME", s.dir("home"))
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }
    dir.canonicalize().unwrap()
}

#[cfg(unix)]
#[test]
fn update_dry_run_prints_the_plan_and_changes_nothing() {
    let s = Sandbox::new();
    let Some(path) = git_only_path(&s) else {
        return;
    };
    let repo = checkout(&s, "src", "https://github.com/baney75/polycarp.git", &path);
    let cache = s.dir("cache");
    let run = |args: &[&str]| {
        s.cmd(args)
            .env("PATH", &path)
            .env("POLYCARP_CACHE_DIR", &cache)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    };
    let o = run(&["update", "--dry-run", "--source", repo.to_str().unwrap()]);
    let t = out(&o);
    assert_eq!(code(&o), 0, "{t}{}", err(&o));
    assert!(
        t.starts_with("polycarp update, source install: origin/main of "),
        "{t}"
    );
    assert!(
        t.contains(&format!(
            "git -C {} fetch origin +refs/heads/main:refs/remotes/origin/main",
            repo.display()
        )),
        "{t}"
    );
    assert!(
        t.contains("worktree add --detach --force") && t.contains(&cache.display().to_string()),
        "{t}"
    );
    // The plan ends by handing over to the installed command, and says so.
    let installed = s.dir("home").join(".local/bin/polycarp");
    assert!(
        t.contains(&format!(
            "{} update --finish --source {}",
            installed.display(),
            repo.display()
        )),
        "{t}"
    );
    assert!(t.contains("run by the newly installed command"), "{t}");
    assert!(t.contains("is not the installed command"), "{t}");
    // What the installed command would then run is a plan too, and it runs nothing either.
    let o = run(&[
        "update",
        "--finish",
        "--dry-run",
        "--source",
        repo.to_str().unwrap(),
    ]);
    assert_eq!(code(&o), 0, "{}{}", out(&o), err(&o));
    assert!(
        out(&o).contains("--after-install --wait 30") && !out(&o).contains("fetch origin"),
        "{}",
        out(&o)
    );
    assert!(t.trim_end().ends_with("dry run: nothing was run."), "{t}");
    // Nothing was fetched, built, remembered or created.
    assert!(
        !repo.join(".git/FETCH_HEAD").exists(),
        "the dry run fetched"
    );
    assert!(!cache.exists(), "the dry run made the clean copy");
    assert!(
        !s.dir("home").join(".config/polycarp/source.toml").exists(),
        "the dry run recorded the source"
    );

    // No --yes and no terminal: refused, and still nothing ran.
    let o = run(&["update", "--source", repo.to_str().unwrap()]);
    assert_eq!(code(&o), 2, "{}", out(&o));
    assert!(
        err(&o).contains("no terminal") && err(&o).contains("--yes"),
        "{}",
        err(&o)
    );
    assert!(!repo.join(".git/FETCH_HEAD").exists() && !cache.exists());
    assert!(!s.dir("home").join(".config/polycarp/source.toml").exists());

    // A checkout of something else is refused before anything runs, even with --yes.
    let other = checkout(&s, "other", "https://github.com/someone/else.git", &path);
    let o = run(&["update", "--yes", "--source", other.to_str().unwrap()]);
    assert_eq!(code(&o), 1, "{}", out(&o));
    assert!(
        err(&o).contains("not the Polycarp repo") && err(&o).contains("Nothing was run"),
        "{}",
        err(&o)
    );
    assert!(!other.join(".git/FETCH_HEAD").exists() && !cache.exists());
    assert!(
        !s.dir("home").join(".config/polycarp/source.toml").exists(),
        "a refused source was recorded"
    );
}

#[test]
fn update_without_a_known_install_says_how_to_point_it_at_a_checkout() {
    let s = Sandbox::new();
    for args in [
        &["update"][..],
        &["update", "--dry-run"],
        &["update", "--check"],
        &["update", "--yes"],
    ] {
        let o = s.run(args);
        assert_eq!(code(&o), 2, "{args:?}: {}", out(&o));
        let e = err(&o);
        if cfg!(windows) {
            assert!(
                e.contains("not supported on Windows yet") && e.contains("baneyspaces-windows"),
                "{e}"
            );
        } else {
            assert!(e.contains("polycarp update --source"), "{e}");
        }
    }
    assert_eq!(code(&s.run(&["update", "--bogus"])), 2);
    assert_eq!(code(&s.run(&["update", "--source"])), 2);
    let o = s.run(&["update", "--help"]);
    assert_eq!(code(&o), 0);
    assert!(out(&o).contains("--dry-run"));
}

/// A repo with one empty commit, and that commit.
#[cfg(unix)]
fn repo_with_a_commit(s: &Sandbox, name: &str, path: &Path) -> (PathBuf, String) {
    let dir = s.dir(name);
    fs::create_dir_all(&dir).unwrap();
    let git = |args: &[&str]| {
        let o = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .env("PATH", path)
            .env("HOME", s.dir("home"))
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?}: {}", err(&o));
        out(&o).trim().to_string()
    };
    git(&["init", "-q"]);
    git(&["commit", "-q", "--allow-empty", "-m", "one"]);
    let head = git(&["rev-parse", "HEAD"]);
    (dir.canonicalize().unwrap(), head)
}

/// A stand-in for an installed `polycarp`: a file that carries the build stamp a real one does.
#[cfg(unix)]
fn install_stamped(s: &Sandbox, commit: &str) -> PathBuf {
    let dir = s.dir("home").join(".local/bin");
    fs::create_dir_all(&dir).unwrap();
    stub(
        &dir,
        "polycarp",
        &format!("# polycarp-build|v1|{commit}|2026-11-01T00:00:00Z|0|0.0.9|end|\nexit 0"),
    )
}

/// The documented first run: `cargo build --release` in `cli/`, then run that binary. It is not the
/// installed command, and it may be older or newer than it. What is compared with origin/main, by
/// `version` and by the update's own gate, is the installed command.
#[cfg(unix)]
#[test]
fn a_build_in_a_checkout_judges_the_installed_command_not_itself() {
    let s = Sandbox::new();
    let Some(path) = git_only_path(&s) else {
        return;
    };
    let (repo, head) = repo_with_a_commit(&s, "target-repo", &path);
    let installed = install_stamped(&s, &head);
    let run = |args: &[&str]| s.cmd(args).env("PATH", &path).output().unwrap();

    let v = json(&run(&["version", "--json"]));
    let me = part(&v, "polycarp command");
    assert_eq!(me["commit"], head.as_str(), "{v}");
    assert_eq!(me["version"], "0.0.9");
    assert_eq!(me["path"], installed.to_str().unwrap());
    assert!(me["note"].as_str().unwrap().contains("this run is"), "{me}");

    // The gate, exactly as the plan runs it: the installed command is at the target, so there is
    // nothing to do, whatever commit this test binary was built from.
    let dir = repo.to_str().unwrap();
    let gate = ["update", "--is-current", dir, "HEAD", "--needs"];
    let o = run(&[&gate[..], &["polycarp command"]].concat());
    assert_eq!(code(&o), 0, "{}{}", out(&o), err(&o));
    assert!(out(&o).starts_with("up to date: "), "{}", out(&o));
    // A part this update installs is not there yet: the update runs.
    let o = run(&[&gate[..], &["polycarp command,browser helper"]].concat());
    assert_eq!(code(&o), 100, "{}", out(&o));
    assert!(
        out(&o).contains("update available")
            && out(&o).contains("not installed yet: browser helper"),
        "{}",
        out(&o)
    );

    // The installed command is from another commit: an update is waiting, and after an install
    // that same state is a failure with the list.
    install_stamped(&s, OTHER_COMMIT);
    let o = run(&[&gate[..], &["polycarp command"]].concat());
    assert_eq!(code(&o), 100, "{}", out(&o));
    let o = run(&[&gate[..], &["polycarp command", "--after-install"]].concat());
    assert_eq!(code(&o), 1, "{}", out(&o));
    assert!(
        out(&o).contains("polycarp command")
            && out(&o).contains("not every part is at origin/main"),
        "{}",
        out(&o)
    );
    assert_eq!(code(&run(&[&gate[..], &["x", "--bogus"]].concat())), 2);
}

/// A browser that is connected but slow. The helper is stopped at its limit, the extension is
/// reported as "no answer in time", `version --check` says so with its own exit code, and the
/// update's final check does not fail on it.
#[cfg(unix)]
#[test]
fn a_slow_browser_is_no_answer_in_time_and_never_fails_the_update() {
    let s = Sandbox::new();
    let Some(path) = git_only_path(&s) else {
        return;
    };
    let (repo, head) = repo_with_a_commit(&s, "target-repo", &path);
    install_stamped(&s, &head);
    let log = s.dir("budget");
    let helper = |status: &str| {
        stub(
            &s.dir("bin"),
            "polycarp-browser",
            &format!(
                "case \"$1\" in\n\
                 version) echo '{{\"version\":\"1.2.3\",\"commit\":\"{head}\",\"dirty\":false}}';;\n\
                 status) printf '%s' \"$POLYCARP_BROWSER_QUERY_MS\" > '{}'; {status};;\n\
                 esac",
                log.display()
            ),
        )
    };
    let bin = helper("exec /bin/sleep 20");
    let run = |args: &[&str]| {
        s.cmd(args)
            .env("PATH", &path)
            .env("POLYCARP_BROWSER_BIN", &bin)
            .env("POLYCARP_DOCTOR_LIMIT_MS", "400")
            .output()
            .unwrap()
    };
    let started = std::time::Instant::now();
    let o = run(&["version", "--json", "--check"]);
    assert!(
        started.elapsed().as_secs() < 10,
        "the slow helper was waited for"
    );
    let v = json(&o);
    assert_eq!(code(&o), 75, "{v}");
    assert_eq!(v["match"], true, "{v}");
    assert_eq!(part(&v, "browser helper")["commit"], head.as_str());
    let ext = part(&v, "extension");
    assert_eq!(ext["installed"], serde_json::Value::Null, "{ext}");
    assert_eq!(ext["answered"], false);
    assert_eq!(ext["state"], "no answer in time");
    assert_eq!(v["unanswered"], serde_json::json!(["extension"]));
    assert!(v["odd"].as_array().unwrap().is_empty(), "{v}");
    // Each browser was given most of the limit, and the helper half a limit more.
    assert_eq!(fs::read_to_string(&log).unwrap(), "320");
    let o = run(&["version"]);
    assert_eq!(code(&o), 0);
    assert!(
        out(&o).contains("no answer in time") && out(&o).contains("Not compared"),
        "{}",
        out(&o)
    );

    // The final check of an update, and the gate before one: a quiet browser is named, not failed.
    let dir = repo.to_str().unwrap();
    for extra in [&["--after-install"][..], &[]] {
        let mut args = vec![
            "update",
            "--is-current",
            dir,
            "HEAD",
            "--needs",
            "polycarp command,browser helper",
        ];
        args.extend_from_slice(extra);
        let o = run(&args);
        assert_eq!(code(&o), 0, "{extra:?}: {}{}", out(&o), err(&o));
        assert!(
            out(&o).contains("note: extension gave no answer in time")
                && out(&o).contains("up to date"),
            "{}",
            out(&o)
        );
    }

    // The helper answers in time but one browser did not: the same state, for that browser only.
    helper(&format!(
        "echo '{{\"connected\":true,\"extensions\":[{{\"browser\":\"Helium\",\"answered\":true,\"version\":\"1.2.3\",\"commit\":\"{head}\"}},{{\"browser\":\"Chrome\",\"answered\":false}}]}}'"
    ));
    let o = run(&["version", "--json", "--check"]);
    let v = json(&o);
    assert_eq!(code(&o), 75, "{v}");
    assert_eq!(part(&v, "extension (Helium)")["commit"], head.as_str());
    assert_eq!(part(&v, "extension (Chrome)")["state"], "no answer in time");
    // A browser that answers with an older build is still a difference.
    helper(&format!(
        "echo '{{\"connected\":true,\"extensions\":[{{\"browser\":\"Helium\",\"answered\":true,\"version\":\"1.2.2\",\"commit\":\"{OTHER_COMMIT}\"}}]}}'"
    ));
    assert_eq!(code(&run(&["version", "--check"])), 1);
}

/// Linux: the helper is copied out of the clean copy, and `polycarp browser` runs it from there
/// after the clean copy is gone.
#[cfg(unix)]
#[test]
fn the_placed_browser_helper_runs_after_the_clean_copy_is_deleted() {
    let s = Sandbox::new();
    let from = s.dir("cache").join("source-1/browser");
    for (rel, text) in [
        ("package.json", "{}"),
        ("static/manifest.chrome.json", "{}"),
        ("cli/package.json", "{}"),
        ("cli/dist/index.js", "#!/bin/sh\necho \"helper ran: $*\"\n"),
        ("dist-chrome/manifest.json", "{}"),
    ] {
        let p = from.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    let home = s.dir("home").canonicalize().unwrap();
    let to = home.join(".local/share/polycarp/browser/source");
    let link = home.join(".local/bin/polycarp-browser");
    let o = s.run(&[
        "update",
        "--place-browser",
        from.to_str().unwrap(),
        to.to_str().unwrap(),
        link.to_str().unwrap(),
    ]);
    assert_eq!(code(&o), 0, "{}{}", out(&o), err(&o));
    fs::remove_dir_all(s.dir("cache")).unwrap();
    assert!(to.join("dist-chrome/manifest.json").is_file());
    // Nothing is on PATH: the command is found where the update put it.
    let o = s.run(&["browser", "hello", "there"]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert_eq!(out(&o), "helper ran: hello there\n");
    // Nothing to place is an error with a reason, and the installed copy is untouched.
    let o = s.run(&[
        "update",
        "--place-browser",
        from.to_str().unwrap(),
        to.to_str().unwrap(),
        link.to_str().unwrap(),
    ]);
    assert_eq!(code(&o), 1, "{}", out(&o));
    assert!(err(&o).contains("no build to install"), "{}", err(&o));
    assert_eq!(out(&s.run(&["browser", "x"])), "helper ran: x\n");
}
