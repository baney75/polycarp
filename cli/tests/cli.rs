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
    fs::create_dir_all(&app).unwrap();
    let o = s.run(&["doctor"]);
    assert!(
        out(&o).contains(&format!("voice: {}", app.display())),
        "{}",
        out(&o)
    );
}
