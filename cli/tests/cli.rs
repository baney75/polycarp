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
    let o = s.run(&["spaces", "x"]);
    assert_eq!(code(&o), 127);
    assert!(err(&o).contains("polycarp-spaces"), "{}", err(&o));
    assert!(err(&o).contains("POLYCARP_SPACES_BIN"), "{}", err(&o));
    assert!(err(&o).contains("Install"), "{}", err(&o));
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

/// Dictation is its own app now. `polycarp voice`, with or without arguments, only says where it went.
#[test]
fn voice_points_to_the_silas_app_and_exits_1() {
    let s = Sandbox::new();
    for args in [&["voice"][..], &["voice", "dictate"][..]] {
        let o = s.run(args);
        assert_eq!(code(&o), 1, "{args:?}");
        assert_eq!(
            err(&o),
            "polycarp: Silas is its own app now. Open Silas, or get it at https://github.com/baney75/silas.\n"
        );
        assert_eq!(out(&o), "", "{args:?}");
    }
}

#[test]
fn the_usage_text_has_no_voice_command() {
    let s = Sandbox::new();
    let o = s.run(&["--help"]);
    let t = format!("{}{}", out(&o), err(&o));
    assert!(t.contains("polycarp spaces"), "{t}");
    assert!(!t.contains("polycarp voice"), "{t}");
    assert!(!t.contains("POLYCARP_VOICE_BIN"), "{t}");
    assert!(!t.contains("polycarp browser"), "{t}");
}

#[test]
fn doctor_not_found_exits_1() {
    let s = Sandbox::new();
    let o = s.run(&["doctor"]);
    assert_eq!(code(&o), 1);
    let t = out(&o);
    assert!(t.contains("spaces: not found"), "{t}");
    assert!(!t.contains("voice"), "{t}");
    assert!(
        !t.contains("browser"),
        "the browser extension was removed: {t}"
    );
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
    stub(&s.dir("bin"), "baneyspaces", &echo_body(37));
    let o = s
        .cmd(&["spaces", "--version"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 37);
    assert_eq!(out(&o), "[--version]\n");
}

#[cfg(unix)]
const BROWSER_LINE: &str = "The browser extension was removed from Polycarp.\n";

/// The browser extension was removed. `polycarp browser`, with any arguments, says so on stderr and exits 2, and never runs an
/// old helper still on the machine, nor `features on|off browser`, which writes nothing.
#[cfg(unix)]
#[test]
fn browser_says_it_was_removed_runs_nothing_and_exits_2() {
    let s = Sandbox::new();
    let marker = s.dir("ran");
    let ran = format!("echo x > '{}'", marker.display());
    for name in ["polycarp-browser", "tabkyra"] {
        stub(&s.dir("bin"), name, &ran);
    }
    let local = s.dir("home").join(".local/bin");
    fs::create_dir_all(&local).unwrap();
    stub(&local, "polycarp-browser", &ran);
    for args in [
        &["browser"][..],
        &["browser", "mcp"],
        &["browser", "--version"],
        &["features", "on", "browser"],
        &["features", "off", "browser"],
    ] {
        let o = s
            .cmd(args)
            .env("PATH", s.dir("bin"))
            .env(
                "POLYCARP_BROWSER_BIN",
                s.dir("bin").join("polycarp-browser"),
            )
            .output()
            .unwrap();
        assert_eq!(code(&o), 2, "{args:?}: {}", err(&o));
        assert_eq!(err(&o), BROWSER_LINE, "{args:?}");
        assert_eq!(out(&o), "", "{args:?}");
    }
    assert!(!marker.exists(), "an old browser helper ran");
    assert!(!s
        .dir("home")
        .join(".config/polycarp/features.toml")
        .exists());
    let list = s.run(&["features"]);
    assert!(!out(&list).contains("browser"), "{}", out(&list));
    let help = s.run(&["--help"]);
    assert!(out(&help).contains(BROWSER_LINE), "{}", out(&help));
    assert!(!out(&help).contains("polycarp browser ["), "{}", out(&help));
}

/// Polycarp has no parts to choose now: `polycarp features` says so in one line and never writes `features.toml`, and
/// it is gone from `--help`.
#[cfg(unix)]
#[test]
fn features_only_says_workspaces_always_run() {
    let s = Sandbox::new();
    const LINE: &str = "Polycarp has no parts to turn on or off: workspaces always run.\n";
    for args in [
        &["features"][..],
        &["features", "list"],
        &["features", "--help"],
    ] {
        let o = s.cmd(args).output().unwrap();
        assert_eq!(code(&o), 0, "{args:?}: {}", err(&o));
        assert_eq!(out(&o), LINE, "{args:?}");
    }
    for args in [
        &["features", "off", "workspaces"][..],
        &["features", "on", "voice"],
    ] {
        let o = s.cmd(args).output().unwrap();
        assert_eq!(code(&o), 2, "{args:?}");
        assert_eq!(err(&o), format!("polycarp: {LINE}"), "{args:?}");
        assert_eq!(out(&o), "", "{args:?}");
    }
    assert!(!s
        .dir("home")
        .join(".config/polycarp/features.toml")
        .exists());
    assert!(!out(&s.run(&["--help"])).contains("polycarp features"));
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
    stub(&a, "baneyspaces", "echo A");
    stub(&b, "baneyspaces", "echo B");
    let path = std::env::join_paths([&b, &a]).unwrap();
    let o = s.cmd(&["spaces"]).env("PATH", path).output().unwrap();
    assert_eq!(out(&o), "B\n");
    let path = std::env::join_paths([&a, &b]).unwrap();
    let o = s.cmd(&["spaces"]).env("PATH", path).output().unwrap();
    assert_eq!(out(&o), "A\n");
}

#[cfg(unix)]
#[test]
fn path_skips_non_executable_files_and_directories() {
    let s = Sandbox::new();
    let a = s.dir("a");
    fs::create_dir_all(a.join("baneyspaces")).unwrap(); // a directory with the tool's name
    let b = s.dir("b");
    fs::create_dir_all(&b).unwrap();
    fs::write(b.join("baneyspaces"), "#!/bin/sh\necho plain\n").unwrap(); // mode 644
    let c = s.dir("c");
    fs::create_dir_all(&c).unwrap();
    stub(&c, "baneyspaces", "echo good");
    let path = std::env::join_paths([&a, &b, &c]).unwrap();
    let o = s.cmd(&["spaces"]).env("PATH", path).output().unwrap();
    assert_eq!(out(&o), "good\n");
}

#[cfg(unix)]
#[test]
fn current_folder_is_never_run() {
    let s = Sandbox::new();
    let marker = s.dir("ran");
    // Planted in the current folder, under both names.
    for name in ["baneyspaces", "polycarp-spaces"] {
        stub(
            &s.dir("cwd"),
            name,
            &format!("echo x > '{}'; echo planted", marker.display()),
        );
    }
    // PATH has ".", an empty entry, a relative entry and then an empty folder.
    let path = format!(".::cwd:{}", s.dir("empty").display());
    let o = s.cmd(&["spaces"]).env("PATH", &path).output().unwrap();
    assert_eq!(code(&o), 127);
    assert!(!out(&o).contains("planted"));
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
fn doctor_found_exits_0_and_runs_no_tool() {
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
    assert!(!t.contains("SPACES-VERSION"));
    assert!(!t.contains("voice"), "{t}");
    assert!(!log.exists(), "doctor ran spaces");
}

#[cfg(unix)]
#[test]
fn doctor_exits_1_when_one_required_tool_is_missing() {
    let s = Sandbox::new();
    // An old browser helper is no tool of Polycarp's now: the spaces command is still missing.
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

/// A copy of cmd.exe under a tool's name: Windows has no `sh`, and `cmd /c` runs what follows.
#[cfg(windows)]
fn cmd_stub(dir: &Path, name: &str) -> PathBuf {
    let sys = std::env::var_os("SystemRoot").expect("SystemRoot is set on Windows");
    let p = dir.join(format!("{name}.exe"));
    fs::copy(Path::new(&sys).join("System32").join("cmd.exe"), &p).unwrap();
    p
}

/// #379 item 3: on Windows the tool is `<name>.exe` on PATH, its arguments reach it and its exit code comes back.
#[cfg(windows)]
#[test]
fn windows_finds_the_exe_on_path_passes_args_and_returns_its_exit_code() {
    let s = Sandbox::new();
    cmd_stub(&s.dir("bin"), "polycarp-spaces");
    let run = |args: &[&str]| s.cmd(args).env("PATH", s.dir("bin")).output().unwrap();
    let o = run(&["spaces", "/c", "echo", "hello"]);
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert_eq!(out(&o).trim_end(), "hello");
    assert_eq!(code(&run(&["spaces", "/c", "exit", "7"])), 7);
    // The browser extension was removed: one line on stderr, exit 2, on Windows too.
    let o = run(&["browser", "--version"]);
    assert_eq!(code(&o), 2, "{}", err(&o));
    assert!(
        err(&o).contains("The browser extension was removed from Polycarp."),
        "{}",
        err(&o)
    );
}

/// #379 item 3: the old names still work alone on Windows, and the new name wins when both are on PATH.
#[cfg(windows)]
#[test]
fn windows_prefers_the_new_exe_name_and_falls_back_to_the_old() {
    let s = Sandbox::new();
    let (old, new) = (s.dir("old"), s.dir("new"));
    fs::create_dir_all(&old).unwrap();
    fs::create_dir_all(&new).unwrap();
    // %CMDCMDLINE% is the command line cmd was started with: it names the file that ran.
    let ran = |path: &std::ffi::OsStr| {
        let o = s
            .cmd(&["spaces", "/c", "echo", "%CMDCMDLINE%"])
            .env("PATH", path)
            .output()
            .unwrap();
        assert_eq!(code(&o), 0, "{}", err(&o));
        out(&o).to_lowercase()
    };
    cmd_stub(&old, "baneyspaces");
    assert!(
        ran(old.as_os_str()).contains("baneyspaces.exe"),
        "the old name alone"
    );
    cmd_stub(&new, "polycarp-spaces");
    let both = std::env::join_paths([&old, &new]).unwrap();
    assert!(
        ran(&both).contains("polycarp-spaces.exe"),
        "the new name wins"
    );
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
fn doctor_piped_to_a_closed_reader_ends_quietly() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "baneyspaces", "exit 0");
    let mut child = s
        .cmd(&["doctor"])
        .env("PATH", s.dir("bin"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Close the reading end at once, as `| head -1` does.
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
    // Only an old browser helper: the spaces command is missing.
    stub(&s.dir("bin"), "tabkyra", "exit 0");
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
    for name in ["baneyspaces.cmd", "baneyspaces.BAT"] {
        let p = stub(&s.dir("bin"), name, "echo ran");
        let o = s
            .cmd(&["spaces"])
            .env("POLYCARP_SHIM_CHECK", "1")
            .env("POLYCARP_SPACES_BIN", &p)
            .output()
            .unwrap();
        assert_eq!(code(&o), 127, "{name}");
        assert!(!out(&o).contains("ran"));
        let e = err(&o);
        assert!(
            e.contains("shell") && e.contains("POLYCARP_SPACES_BIN"),
            "{e}"
        );
    }
}

#[cfg(unix)]
#[test]
fn doctor_reports_a_cmd_shim_as_present_but_not_runnable_with_advice() {
    let s = Sandbox::new();
    stub(&s.dir("bin"), "polycarp-spaces.cmd", "echo ran");
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
        t.contains("real executable") && t.contains("POLYCARP_SPACES_BIN"),
        "{t}"
    );
    assert!(!t.contains("spaces: not found"), "{t}");
    let o = s
        .cmd(&["spaces"])
        .env("POLYCARP_SHIM_CHECK", "1")
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    assert_eq!(code(&o), 127);
    assert!(err(&o).contains("real executable"), "{}", err(&o));
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

/// #19: pnpm, and pipx and uv tools linked from ~/.local/bin, run from `~`; a clone in mise's
/// plugins/ folder does not.
#[cfg(unix)]
#[test]
fn from_home_pnpm_pipx_and_uv_run_but_mise_plugins_do_not() {
    let s = Sandbox::new();
    let home = s.dir("home");
    let bin = home.join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    for (rel, linked) in [
        (".local/share/pnpm", false),
        (".local/share/pipx/venvs/polycarp/bin", true),
        (".local/share/uv/tools/polycarp/bin", true),
        (".local/share/mise/plugins/evil/bin", false),
    ] {
        let d = home.join(rel);
        fs::create_dir_all(&d).unwrap();
        stub(&d, "baneyspaces", &format!("echo from {rel}"));
        let on_path = if linked {
            std::os::unix::fs::symlink(d.join("baneyspaces"), bin.join("baneyspaces")).unwrap();
            bin.clone()
        } else {
            d.clone()
        };
        let o = s
            .cmd(&["spaces"])
            .env("PATH", &on_path)
            .current_dir(&home)
            .output()
            .unwrap();
        if rel.contains("mise") {
            assert_eq!(code(&o), 127, "{rel}: {}", out(&o));
        } else {
            assert_eq!(out(&o), format!("from {rel}\n"), "{rel}: {}", err(&o));
        }
        let _ = fs::remove_file(bin.join("baneyspaces"));
        fs::remove_file(d.join("baneyspaces")).unwrap();
    }
}

/// An npm prefix of ~/.local: the entry in bin is a link into lib/node_modules.
#[cfg(unix)]
#[test]
fn from_home_an_npm_prefix_link_inside_local_runs() {
    let s = Sandbox::new();
    let home = s.dir("home");
    let real = home.join(".local/lib/node_modules/polycarp/bin");
    let bin = home.join(".local/bin");
    fs::create_dir_all(&real).unwrap();
    fs::create_dir_all(&bin).unwrap();
    stub(&real, "baneyspaces", "echo npm-prefix");
    std::os::unix::fs::symlink(real.join("baneyspaces"), bin.join("baneyspaces")).unwrap();
    let o = s
        .cmd(&["spaces"])
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
    fs::remove_file(bin.join("baneyspaces")).unwrap();
    // Project folder, allowed target.
    let cargo = home.join(".cargo/bin");
    let tools = home.join("proj/bin");
    fs::create_dir_all(&cargo).unwrap();
    fs::create_dir_all(&tools).unwrap();
    stub(&cargo, "baneyspaces", &body);
    std::os::unix::fs::symlink(cargo.join("baneyspaces"), tools.join("baneyspaces")).unwrap();
    let o = s
        .cmd(&["spaces"])
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
    let real = home.join(".bun/install/global/node_modules/polycarp/bin");
    let bin = home.join(".bun/bin");
    fs::create_dir_all(&real).unwrap();
    fs::create_dir_all(&bin).unwrap();
    stub(&real, "baneyspaces", "echo bun");
    std::os::unix::fs::symlink(real.join("baneyspaces"), bin.join("baneyspaces")).unwrap();
    let o = s
        .cmd(&["spaces"])
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

#[cfg(unix)]
#[test]
fn spaces_finds_the_copy_inside_the_app_before_path() {
    let s = Sandbox::new();
    let app = s
        .dir("home")
        .join("Applications/Polycarp.app/Contents/Resources/bin");
    fs::create_dir_all(&app).unwrap();
    stub(&app, "polycarp-spaces", "echo bundled \"$@\"");
    let on_path = s.dir("a");
    fs::create_dir_all(&on_path).unwrap();
    stub(&on_path, "baneyspaces", "echo from-path");
    let o = s
        .cmd(&["spaces", "agent"])
        .env("PATH", &on_path)
        .output()
        .unwrap();
    assert_eq!(out(&o), "bundled agent\n");
    // The override still wins over the app's copy.
    let mine = stub(&on_path, "mine", "echo override");
    let o = s
        .cmd(&["spaces"])
        .env("POLYCARP_SPACES_BIN", &mine)
        .output()
        .unwrap();
    assert_eq!(out(&o), "override\n");
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
    for name in ["spaces command", "agent skill"] {
        let p = part(&v, name);
        assert_eq!(p["installed"], false, "{name}");
        assert!(p["state"].as_str().is_some_and(|t| !t.is_empty()), "{name}");
    }
    // Dictation is not a part of Polycarp, so `version` has no row for it.
    assert!(!v.to_string().contains("voice"), "{v}");
    assert!(v["verdict"].as_str().unwrap().starts_with("versions: "));
    // The table says the same, and a missing part is not an error.
    let o = s.run(&["version"]);
    assert_eq!(code(&o), 0);
    let t = out(&o);
    assert!(
        t.contains("spaces command") && t.contains("not installed"),
        "{t}"
    );
    // Part names begin each row; a path in the table may say anything.
    assert!(
        !t.lines()
            .any(|l| l.starts_with("browser") || l.starts_with("extension")),
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
    let o = s
        .cmd(&["version", "--json", "--check"])
        .env("PATH", s.dir("bin"))
        .output()
        .unwrap();
    let v = json(&o);
    assert_eq!(code(&o), 1, "{v}");
    assert_eq!(v["match"], false);
    assert_eq!(part(&v, "spaces command")["commit"], OTHER_COMMIT);
    assert!(!v["odd"].as_array().unwrap().is_empty(), "{v}");
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

/// The Linux desktop is retired: `update` on a real Polycarp checkout says so,
/// exits 0 and runs nothing, not even git, with or without --yes.
#[cfg(target_os = "linux")]
#[test]
fn on_linux_update_says_the_desktop_is_retired_and_runs_nothing() {
    let s = Sandbox::new();
    let Some(path) = git_only_path(&s) else {
        return;
    };
    let repo = checkout(&s, "src", "https://github.com/baney75/polycarp.git", &path);
    let cache = s.dir("cache");
    for args in [
        vec!["update", "--dry-run", "--source"],
        vec!["update", "--yes", "--source"],
    ] {
        let mut args = args.clone();
        args.push(repo.to_str().unwrap());
        let o = s
            .cmd(&args)
            .env("PATH", &path)
            .env("POLYCARP_CACHE_DIR", &cache)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert_eq!(code(&o), 0, "{args:?}: {}", err(&o));
        assert_eq!(
            out(&o),
            "Polycarp runs on macOS and Windows. The Linux desktop is retired.\n"
        );
        assert!(!repo.join(".git/FETCH_HEAD").exists() && !cache.exists());
        assert!(!s.dir("home").join(".config/polycarp/source.toml").exists());
    }
}

/// On a machine an earlier install set up, the Omarchy install stub only reads hyprland.lua and says how to
/// take the block out; the uninstaller kept beside it takes out the block and its folder and leaves the rest.
#[cfg(target_os = "linux")]
#[test]
fn the_linux_install_stub_points_to_the_uninstaller_that_takes_the_old_block_out() {
    let s = Sandbox::new();
    let omarchy = Path::new(env!("CARGO_MANIFEST_DIR")).join("../spaces/platforms/linux/omarchy");
    let hypr = s.dir("home").join(".config/hypr");
    fs::create_dir_all(hypr.join("baneyspaces")).unwrap();
    let main = hypr.join("hyprland.lua");
    let before = "-- mine\n\n-- >>> baneyspaces (managed by baneyspaces install.sh) >>>\nrequire(\"baneyspaces\")\n-- <<< baneyspaces <<<\n-- also mine\n";
    fs::write(&main, before).unwrap();
    // Only system tools: no `baneyspaces` on PATH, so nothing real is stopped.
    let run = |script: &str| {
        Command::new(omarchy.join(script))
            .env_clear()
            .env("HOME", s.dir("home"))
            .env("PATH", "/usr/bin:/bin")
            .output()
            .unwrap()
    };
    let o = run("install.sh");
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert!(
        out(&o).contains("The Linux desktop is retired"),
        "{}",
        out(&o)
    );
    assert!(out(&o).contains("omarchy/uninstall.sh"), "{}", out(&o));
    assert_eq!(fs::read_to_string(&main).unwrap(), before);
    let o = run("uninstall.sh");
    assert_eq!(code(&o), 0, "{}{}", out(&o), err(&o));
    assert_eq!(
        fs::read_to_string(&main).unwrap(),
        "-- mine\n-- also mine\n"
    );
    assert!(!hypr.join("baneyspaces").exists());
    // With the block gone, the stub has nothing to point to.
    let o = run("install.sh");
    assert!(!out(&o).contains("uninstall.sh"), "{}", out(&o));
}

/// No two binaries in the spaces workspace share a name: `cargo build --workspace` would write both to one
/// file, and whichever built last would win (the Linux update stub once took the Windows daemon's name).
#[test]
fn the_spaces_workspace_has_no_two_binaries_with_one_name() {
    let spaces = Path::new(env!("CARGO_MANIFEST_DIR")).join("../spaces");
    let o = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--offline",
        ])
        .current_dir(&spaces)
        .output()
        .unwrap();
    assert_eq!(code(&o), 0, "{}", err(&o));
    let meta: serde_json::Value = serde_json::from_str(&out(&o)).unwrap();
    let mut seen = std::collections::BTreeMap::new();
    for pkg in meta["packages"].as_array().unwrap() {
        for t in pkg["targets"].as_array().unwrap() {
            if t["kind"].as_array().unwrap().iter().any(|k| k == "bin") {
                let name = t["name"].as_str().unwrap().to_string();
                let package = pkg["name"].as_str().unwrap().to_string();
                if let Some(first) = seen.insert(name.clone(), package.clone()) {
                    panic!("binary {name} is in both {first} and {package}");
                }
            }
        }
    }
    assert!(seen.contains_key("baneyspaces"), "{seen:?}");
}

/// On Linux the line comes first: a --source that is not a folder, an unknown flag, no home
/// folder, or a plan's own --is-current and --reload-wait get it too, exit 0, and nothing is run
/// or written.
#[cfg(target_os = "linux")]
#[test]
fn on_linux_update_says_the_desktop_is_retired_before_it_reads_anything() {
    let s = Sandbox::new();
    let missing = s.dir("no-such-checkout");
    let ran = s.dir("home").join("ran");
    let cases: [(&[&str], bool); 6] = [
        (
            &[
                "update",
                "--is-current",
                missing.to_str().unwrap(),
                "HEAD",
                "--needs",
                "polycarp command",
            ],
            true,
        ),
        (
            &[
                "update",
                "--reload-wait",
                missing.to_str().unwrap(),
                "HEAD",
                "--wait",
                "1",
                "--",
                "touch",
                ran.to_str().unwrap(),
            ],
            true,
        ),
        (&["update", "--source", missing.to_str().unwrap()], true),
        (
            &["update", "--check", "--source", missing.to_str().unwrap()],
            true,
        ),
        (&["update", "--no-such-flag"], true),
        (&["update", "--yes"], false),
    ];
    for (args, with_home) in cases {
        let mut c = s.cmd(args);
        if !with_home {
            c.env_remove("HOME").env_remove("USERPROFILE");
        }
        let o = c.stdin(Stdio::null()).output().unwrap();
        assert_eq!(code(&o), 0, "{args:?}: {}", err(&o));
        assert_eq!(
            out(&o),
            "Polycarp runs on macOS and Windows. The Linux desktop is retired.\n",
            "{args:?}"
        );
        assert_eq!(err(&o), "", "{args:?}");
    }
    assert_eq!(fs::read_dir(s.dir("home")).unwrap().count(), 0);
}

/// A `polycarp` from before the retirement, run as `polycarp update` on an Omarchy machine, builds
/// its own plan (`linux_steps` at 4fa0e4df) and runs it in a clean copy of this tree: it builds the
/// `baneyspaces-linux` package, runs the engine and Omarchy install scripts, installs the new
/// command and hands off to it with `update --finish`. Each of those steps must pass on this tree,
/// or that machine never gets the command that says the desktop is retired. The two cli builds are
/// left out: they build this crate, which this test already is.
#[cfg(target_os = "linux")]
#[test]
fn an_older_linux_update_plan_lands_on_this_tree() {
    let s = Sandbox::new();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let spaces = repo.join("spaces");
    // The old plan's steps that run something from the tree, with their argv and folder, in order.
    let build = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .args(["build", "--release", "--locked", "-p", "baneyspaces-linux"])
        .current_dir(&spaces)
        .env("CARGO_TARGET_DIR", s.dir("target"))
        .output()
        .unwrap();
    assert_eq!(code(&build), 0, "build the spaces daemon: {}", err(&build));
    let home = s.dir("home");
    for script in [
        "platforms/linux/scripts/build-engine.sh",
        "platforms/linux/omarchy/install.sh",
    ] {
        let o = Command::new(spaces.join(script))
            .current_dir(&spaces)
            .env("HOME", &home)
            .output()
            .unwrap();
        assert_eq!(code(&o), 0, "{script}: {}", err(&o));
        assert!(out(&o).contains("The Linux desktop is retired"), "{script}");
    }
    assert_eq!(
        fs::read_dir(&home).unwrap().count(),
        0,
        "a stub wrote to HOME"
    );
    // The handoff: the command it just installed finishes, says the desktop is retired and exits 0.
    let o = s
        .cmd(&["update", "--finish", "--source", repo.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(code(&o), 0, "{}", err(&o));
    assert_eq!(
        out(&o),
        "Polycarp runs on macOS and Windows. The Linux desktop is retired.\n"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn update_dry_run_prints_the_plan_and_changes_nothing() {
    let s = Sandbox::new();
    let Some(path) = git_only_path(&s) else {
        return;
    };
    let repo = checkout(&s, "src", "https://github.com/baney75/polycarp.git", &path);
    let cache = s.dir("cache");
    // A `git` in the project's node_modules/.bin, first on PATH, is never run: not even to look.
    let planted = s.dir("cwd").join("node_modules/.bin");
    fs::create_dir_all(&planted).unwrap();
    stub(
        &planted,
        "git",
        &format!("touch {}", s.dir("ran").display()),
    );
    // Nor a node beside it, not even to ask its version (second-F5 of the review of PR 359).
    stub(
        &planted,
        "node",
        &format!("touch {}; echo v22.0.0", s.dir("ran-node").display()),
    );
    stub(&planted, "npm", "true");
    let first = std::env::join_paths([&planted, &path]).unwrap();
    let run = |args: &[&str]| {
        s.cmd(args)
            .env("PATH", &first)
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
            "{} -C {} fetch origin +refs/heads/main:refs/remotes/origin/main",
            path.join("git").display(),
            repo.display()
        )),
        "the plan names the git that runs: {t}"
    );
    assert!(!s.dir("ran").exists(), "the planted git was run");
    assert!(!s.dir("ran-node").exists(), "the planted node was run");
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
        if cfg!(target_os = "linux") {
            // The Linux desktop is retired: one line says so, nothing runs, and it is not a failure.
            assert_eq!(code(&o), 0, "{args:?}: {}", err(&o));
            assert_eq!(
                out(&o),
                "Polycarp runs on macOS and Windows. The Linux desktop is retired.\n"
            );
            continue;
        }
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
    // On Linux every form gets the line first (on_linux_update_says_the_desktop_is_retired_before_it_reads_anything).
    let wrong = if cfg!(target_os = "linux") { 0 } else { 2 };
    assert_eq!(code(&s.run(&["update", "--bogus"])), wrong);
    assert_eq!(code(&s.run(&["update", "--source"])), wrong);
    let o = s.run(&["update", "--help"]);
    assert_eq!(code(&o), 0);
    let help = if cfg!(target_os = "linux") {
        "The Linux desktop is retired"
    } else {
        "--dry-run"
    };
    assert!(out(&o).contains(help), "{}", out(&o));
}

/// A repo with one empty commit, and that commit.
#[cfg(target_os = "macos")]
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
#[cfg(target_os = "macos")]
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
/// macOS only: on Linux `update` answers only that the desktop is retired.
#[cfg(target_os = "macos")]
#[test]
fn a_build_in_a_checkout_judges_the_installed_command_not_itself() {
    let s = Sandbox::new();
    let Some(path) = git_only_path(&s) else {
        return;
    };
    let (repo, head) = repo_with_a_commit(&s, "target-repo", &path);
    // The first run: nothing is installed yet, and the build that is running is not taken for it.
    let first = ["--is-current", repo.to_str().unwrap(), "HEAD", "--needs"];
    let first = [&["update"], &first[..], &["polycarp command"]].concat();
    let o = s.cmd(&first).env("PATH", &path).output().unwrap();
    let said = out(&o).contains("not installed yet: polycarp command");
    assert!(code(&o) == 100 && said, "{}", out(&o));
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
    let o = run(&[&gate[..], &["polycarp command,spaces command"]].concat());
    assert_eq!(code(&o), 100, "{}", out(&o));
    assert!(
        out(&o).contains("update available")
            && out(&o).contains("not installed yet: spaces command"),
        "{}",
        out(&o)
    );
    // The gate an older polycarp's plan runs still names the browser helper, which was removed and
    // nothing here installs: it is skipped, so the update is not held back for it, before or after the install.
    for extra in [&[][..], &["--after-install"]] {
        let old = [&gate[..], &["polycarp command,browser helper"], extra].concat();
        let o = run(&old);
        assert_eq!(code(&o), 0, "{extra:?}: {}{}", out(&o), err(&o));
        assert!(!out(&o).contains("browser"), "{}", out(&o));
    }

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

/// What `polycarp update --retire-old-browser` prints, once, while a remote connector job is left running.
#[cfg(target_os = "macos")]
const CONNECTOR_STAYS: &str = "Your remote connector still runs on the old browser helper, outside Polycarp, so its jobs were left running.\n";

/// A LaunchAgents plist in the form the old helper wrote.
#[cfg(target_os = "macos")]
fn launch_agent(dir: &Path, label: &str, program: &str) -> PathBuf {
    let path = dir.join(format!("{label}.plist"));
    fs::create_dir_all(dir).unwrap();
    fs::write(
        &path,
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n\t<key>Label</key>\n\t<string>{label}</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>{program}</string>\n\t\t<string>serve</string>\n\t</array>\n\t<key>KeepAlive</key>\n\t<true/>\n</dict>\n</plist>\n"
        ),
    )
    .unwrap();
    path
}

#[cfg(target_os = "macos")]
fn this_uid() -> String {
    let o = Command::new("/usr/bin/id").arg("-u").output().unwrap();
    String::from_utf8(o.stdout).unwrap().trim().to_string()
}

/// A stub `launchctl` that logs each call. `print` of a label in `loaded` exits 0, of anything else 113 (not loaded);
/// `bootout` exits `bootout`.
#[cfg(target_os = "macos")]
fn launchctl(s: &Sandbox, loaded: &[&str], bootout: i32) -> (PathBuf, PathBuf) {
    let log = s.dir("launchctl.log");
    let mut body = format!("echo \"$*\" >> {}\ncase \"$*\" in\n", log.display());
    for label in loaded {
        body += &format!("  \"print gui/\"*\"/{label}\") exit 0 ;;\n");
    }
    body += &format!("  print*) exit 113 ;;\n  bootout*) exit {bootout} ;;\nesac\nexit 1");
    (stub(&s.dir("bin"), "launchctl", &body), log)
}

/// The remote connector as it runs on Donovan's Mac (2026-11-17): `com.polycarp.serve` runs the helper's launcher and
/// `com.polycarp.cloudflared` runs `~/.config/tabkyra/tabkyra`, a link to `~/.config/tabkyra/polycarp`. Both are sh
/// shims that exec node on a working tree outside the app, so neither points into Polycarp.app. Next to them are the
/// app's own job and another app's serve job.
#[cfg(target_os = "macos")]
struct Connector {
    home: PathBuf,
    agents: PathBuf,
    serve: (PathBuf, String),
    cloudflared: (PathBuf, String),
    /// Plists that must never change: `com.example.serve` and `com.baney.polycarp`.
    untouched: Vec<(PathBuf, String)>,
}

#[cfg(target_os = "macos")]
impl Connector {
    fn new(s: &Sandbox) -> Connector {
        let home = s.dir("home");
        let agents = home.join("Library/LaunchAgents");
        let shim = "#!/bin/sh\nexec \"/opt/homebrew/bin/node\" \"/Users/d/Projects/polycarp/browser/cli/dist/index.js\" \"$@\"\n";
        let launcher = home.join(".config/polycarp/browser/polycarp");
        let tabkyra = home.join(".config/tabkyra");
        for (path, text) in [
            (&launcher, shim),
            (&tabkyra.join("polycarp"), shim),
            (&home.join(".config/polycarp/browser/settings.json"), "{}"),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        std::os::unix::fs::symlink(tabkyra.join("polycarp"), tabkyra.join("tabkyra")).unwrap();
        let keep = |p: PathBuf| {
            let t = fs::read_to_string(&p).unwrap();
            (p, t)
        };
        let serve = keep(launch_agent(
            &agents,
            "com.polycarp.serve",
            &launcher.to_string_lossy(),
        ));
        let cloudflared = keep(launch_agent(
            &agents,
            "com.polycarp.cloudflared",
            &tabkyra.join("tabkyra").to_string_lossy(),
        ));
        let untouched = vec![
            keep(launch_agent(
                &agents,
                "com.example.serve",
                &home
                    .join(".local/share/other/release/other")
                    .to_string_lossy(),
            )),
            keep(launch_agent(
                &agents,
                "com.baney.polycarp",
                "/Applications/Polycarp.app/Contents/MacOS/Polycarp",
            )),
        ];
        Connector {
            home,
            agents,
            serve,
            cloudflared,
            untouched,
        }
    }

    /// The things no run may touch.
    fn assert_kept(&self, calls: &str) {
        for (p, text) in &self.untouched {
            assert_eq!(&fs::read_to_string(p).unwrap(), text, "{}", p.display());
        }
        assert!(self.home.join(".config/polycarp/browser/polycarp").exists());
        assert!(self
            .home
            .join(".config/polycarp/browser/settings.json")
            .exists());
        assert!(self.home.join(".config/tabkyra/polycarp").exists());
        assert!(self.home.join(".config/tabkyra/tabkyra").is_symlink());
        for line in calls.lines() {
            assert!(
                !line.contains("com.example."),
                "another app's job was touched: {calls}"
            );
            assert!(!line.contains("com.baney.polycarp"), "{calls}");
        }
    }
}

#[cfg(target_os = "macos")]
fn retire_old_browser(s: &Sandbox, launchctl: &Path) -> Output {
    s.cmd(&["update", "--retire-old-browser"])
        .env("POLYCARP_LAUNCHCTL", launchctl)
        .output()
        .unwrap()
}

/// The remote connector's jobs (serve, cloudflared, hub, link) run shims that exec node on a working tree outside the
/// app, so their program is still on disk: all four keep running, nothing is booted out, and the step prints exactly
/// one line.
/// macOS only: on Linux `update` answers only that the desktop is retired.
#[cfg(target_os = "macos")]
#[test]
fn the_connector_jobs_keep_running_while_their_program_does() {
    let s = Sandbox::new();
    let c = Connector::new(&s);
    let launcher = c.home.join(".config/polycarp/browser/polycarp");
    let hub = launch_agent(&c.agents, "com.polycarp.hub", &launcher.to_string_lossy());
    let link = launch_agent(&c.agents, "com.polycarp.link", &launcher.to_string_lossy());
    let (launchctl, log) = launchctl(&s, &[], 0);

    let o = retire_old_browser(&s, &launchctl);
    assert_eq!(code(&o), 0, "{}{}", out(&o), err(&o));
    assert_eq!(out(&o), CONNECTOR_STAYS);
    assert_eq!(err(&o), "");
    for (p, text) in [&c.serve, &c.cloudflared] {
        assert_eq!(&fs::read_to_string(p).unwrap(), text);
    }
    assert!(hub.exists() && link.exists());
    let calls = fs::read_to_string(&log).unwrap_or_default();
    assert!(!calls.contains("bootout"), "{calls}");
    c.assert_kept(&calls);
}

/// The step passes when a job is already gone or its plist was moved: a job launchd no longer has (bootout fails,
/// `print` finds nothing) loses only its plist; a plist moved to `LaunchAgents/retired-tabkyra/` stays there untouched.
/// macOS only: on Linux `update` answers only that the desktop is retired.
#[cfg(target_os = "macos")]
#[test]
fn the_retire_step_passes_when_a_job_is_already_gone_or_moved() {
    let s = Sandbox::new();
    let c = Connector::new(&s);
    let retired = c.agents.join("retired-tabkyra");
    let moved: Vec<(PathBuf, String)> = ["com.polycarp.cloudflared", "com.tabkyra.serve"]
        .iter()
        .map(|label| {
            let to = retired.join(format!("{label}.plist"));
            fs::create_dir_all(&retired).unwrap();
            if *label == "com.polycarp.cloudflared" {
                fs::rename(&c.cloudflared.0, &to).unwrap();
            } else {
                launch_agent(
                    &retired,
                    label,
                    "/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser",
                );
            }
            let text = fs::read_to_string(&to).unwrap();
            (to, text)
        })
        .collect();
    let browser = launch_agent(
        &c.agents,
        "com.polycarp.browser",
        "/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser",
    );
    // Every Polycarp job is already booted out: bootout fails and print finds nothing.
    let (launchctl, log) = launchctl(&s, &[], 3);

    let o = retire_old_browser(&s, &launchctl);
    assert_eq!(code(&o), 0, "{}{}", out(&o), err(&o));
    assert!(
        c.serve.0.exists(),
        "its program is still on disk: {}",
        out(&o)
    );
    assert!(!browser.exists(), "{}", out(&o));
    for (p, text) in &moved {
        assert_eq!(&fs::read_to_string(p).unwrap(), text, "{}", p.display());
    }
    let calls = fs::read_to_string(&log).unwrap();
    assert!(
        !calls.contains("cloudflared") && !calls.contains("com.tabkyra.serve"),
        "{calls}"
    );
    c.assert_kept(&calls);
}

/// Every other label of the helper's (`com.polycarp.browser`, `com.tabkyra.*`) goes only when its program is inside
/// Polycarp.app or a folder this move removed, directly or through a launcher that execs it. A launcher that execs
/// anything else, or is gone, keeps its job, and so does a job under any other label.
/// macOS only: on Linux `update` answers only that the desktop is retired.
#[cfg(target_os = "macos")]
#[test]
fn an_update_retires_the_old_browser_jobs_and_leaves_everyone_elses() {
    let s = Sandbox::new();
    let home = s.dir("home");
    let agents = home.join("Library/LaunchAgents");
    let app = "/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser";
    let into_app = home.join(".config/tabkyra/old");
    let into_node = home.join(".config/tabkyra/polycarp");
    fs::create_dir_all(into_app.parent().unwrap()).unwrap();
    fs::write(&into_app, format!("#!/bin/sh\nexec \"{app}\" \"$@\"\n")).unwrap();
    fs::write(
        &into_node,
        "#!/bin/sh\nexec \"/opt/homebrew/bin/node\" \"/Users/d/tree/index.js\" \"$@\"\n",
    )
    .unwrap();
    let browser = launch_agent(&agents, "com.polycarp.browser", app);
    let link = launch_agent(&agents, "com.tabkyra.link", &into_app.to_string_lossy());
    let kept: Vec<(PathBuf, String)> = [
        launch_agent(&agents, "com.tabkyra.hub", &into_node.to_string_lossy()),
        launch_agent(
            &agents,
            "com.tabkyra.serve",
            &home.join(".config/tabkyra/gone").to_string_lossy(),
        ),
        launch_agent(&agents, "com.example.thing", app),
    ]
    .into_iter()
    .map(|p| {
        let t = fs::read_to_string(&p).unwrap();
        (p, t)
    })
    .collect();
    let (launchctl, log) = launchctl(&s, &[], 0);

    let o = retire_old_browser(&s, &launchctl);
    assert_eq!(code(&o), 0, "{}{}", out(&o), err(&o));
    assert!(!browser.exists() && !link.exists(), "{}", out(&o));
    for (p, text) in &kept {
        assert_eq!(&fs::read_to_string(p).unwrap(), text, "{}", p.display());
    }
    assert!(into_app.exists() && into_node.exists());
    let uid = this_uid();
    let mut calls: Vec<String> = fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
    calls.sort();
    assert_eq!(
        calls,
        [
            format!("bootout gui/{uid}/com.polycarp.browser"),
            format!("bootout gui/{uid}/com.tabkyra.link"),
        ],
        "only the dead jobs are booted out"
    );
    let said = out(&o);
    assert!(said.contains("retired com.polycarp.browser"), "{said}");
    assert!(said.contains("left com.tabkyra.hub alone"), "{said}");
    assert!(!said.contains("remote connector"), "{said}");
    // The installer runs it on every install, after the commands are linked.
    let installer = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../spaces/scripts/install-app.sh"),
    )
    .unwrap();
    assert!(
        installer.contains("bin/polycarp\" update --retire-old-browser"),
        "install-app.sh does not retire the old jobs"
    );
}

/// A job of Polycarp's that launchd still lists after the bootout keeps its plist, and the step says so.
/// macOS only: on Linux `update` answers only that the desktop is retired.
#[cfg(target_os = "macos")]
#[test]
fn a_job_launchd_will_not_let_go_keeps_its_plist() {
    let s = Sandbox::new();
    let agents = s.dir("home").join("Library/LaunchAgents");
    let p = launch_agent(
        &agents,
        "com.polycarp.browser",
        "/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser",
    );
    let launchctl = stub(
        &s.dir("bin"),
        "launchctl",
        "[ \"$1\" = print ] && exit 0; exit 5",
    );
    let o = retire_old_browser(&s, &launchctl);
    assert_eq!(code(&o), 1);
    assert!(p.exists());
    assert!(err(&o).contains("did not stop it"), "{}", err(&o));
}

/// Review of #529 r2, first-F1: `update --channel stable` on a source install whose origin/stable predates release
/// channels stops right after the fetch, before anything is built. A binary built from that stable would not read the
/// saved channel, so the next plain update would build origin/main and the one after stable again.
// macOS only: on Linux `polycarp update` stops first with the Linux-retired note.
#[cfg(target_os = "macos")]
#[test]
fn a_channel_whose_ref_predates_channels_is_refused_before_any_build() {
    let sb = Sandbox::new();
    let git = |dir: &Path, args: &[&str]| {
        let o = Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.invalid",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            o.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
    };
    let origin = sb.dir("origin");
    fs::create_dir_all(origin.join("cli/src")).unwrap();
    git(&origin, &["init", "-q"]);
    fs::write(origin.join("cli/src/update.rs"), "fn plan() {}\n").unwrap();
    git(&origin, &["add", "-A"]);
    git(&origin, &["commit", "-q", "-m", "before channels"]);
    git(&origin, &["branch", "stable"]);
    let checkout = sb.dir("checkout");
    git(
        &sb.root,
        &[
            "clone",
            "-q",
            origin.to_str().unwrap(),
            checkout.to_str().unwrap(),
        ],
    );
    // The update takes only a checkout of the Polycarp repo: this git answers its origin as that and runs the real
    // git for everything else, so the fetch reads the local origin above.
    stub(
        &sb.dir("bin"),
        "git",
        "if [ \"$3\" = remote ] && [ \"$4\" = get-url ]; then echo https://github.com/baney75/polycarp; exit 0; fi\nexec /usr/bin/git \"$@\"\n",
    );
    let run = |extra: &[&str]| {
        let mut args = vec![
            "update",
            "--source",
            checkout.to_str().unwrap(),
            "--channel",
            "stable",
        ];
        args.extend_from_slice(extra);
        let path = format!("{}:/usr/bin:/bin", sb.dir("bin").display());
        sb.cmd(&args).env("PATH", path).output().unwrap()
    };
    let plan = out(&run(&["--dry-run"]));
    assert!(
        plan.contains("Stop unless origin/stable has release channels"),
        "{plan}"
    );
    let o = run(&["--yes"]);
    let text = out(&o);
    assert_eq!(code(&o), 1, "{text}\n{}", err(&o));
    assert!(text.contains("step 2 of"), "{text}");
    assert!(
        text.contains("failed (exit 1): Stop unless origin/stable has release channels"),
        "{text}"
    );
    assert!(!text.contains("step 3 of"), "nothing after it ran: {text}");
}
