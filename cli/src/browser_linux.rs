//! Polycarp Browser on Linux, so far: `polycarp browser install --dry-run` downloads Helium's newest Linux
//! release, checks its sha256 and its OpenPGP signature against Helium's pinned key, and only then unpacks it into
//! a private folder, checks the layout, builds Polycarp Browser from it there, starts that once headless with a
//! throwaway home and throws it all away. Nothing is installed. The rules are in `../browser/AGENTS.md`.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

// One copy of the listing and download code serves every platform, so a test build loads each more than once on
// purpose. Linux does not read every listing field.
#[allow(clippy::duplicate_mod)]
#[allow(dead_code)]
#[path = "browser/listing.rs"]
mod listing;

#[allow(clippy::duplicate_mod)]
#[path = "browser/download.rs"]
mod download;

// The text packs and their renaming, the folder build and the headless start, shared with Windows.
#[allow(clippy::duplicate_mod)]
#[path = "browser/pak.rs"]
mod pak;
#[allow(clippy::duplicate_mod)]
#[allow(dead_code)]
#[path = "browser/portable.rs"]
mod portable;
#[allow(clippy::duplicate_mod)]
#[path = "browser/rename.rs"]
mod rename;

use download::{fetch, is_link, print, refuse, Refused};
use listing::Release;

#[cfg(target_os = "linux")]
const FEED: &str = "https://api.github.com/repos/imputnet/helium-linux/releases/latest";
const DOWNLOADS: &str = "https://github.com/imputnet/helium-linux/releases/download";
/// Helium's signing key, `pubkey.asc` from imputnet/helium-linux. Trust comes from `FINGERPRINT`, not from this
/// file: a signature counts only when gpg names this primary key.
const KEY: &str = include_str!("browser/helium-linux.asc");
/// The primary key every release must be signed by, uppercase hex, compared whole.
const FINGERPRINT: &str = "BE677C1989D35EAB2C5F26C9351601AD01D6378E";
/// The browser's first words, the same as the Mac's.
const VERBS: [&str; 7] = [
    "install",
    "update",
    "status",
    "open",
    "import",
    "uninstall",
    "finish",
];
const ONLY: &str = "polycarp browser: only `install --dry-run` works on Linux so far.";

/// None when these arguments are not a browser command.
pub fn run(args: &[OsString], home: Option<PathBuf>, cache: Option<PathBuf>) -> Option<i32> {
    let verb = args.first().map_or(Some("--help"), |a| a.to_str())?;
    if ["--help", "-h", "help"].contains(&verb) {
        println!("{ONLY}");
        return Some(0);
    }
    if !VERBS.contains(&verb) {
        return None;
    }
    if verb != "install" || args.len() != 2 || args[1] != "--dry-run" {
        eprintln!("{ONLY}");
        return Some(2);
    }
    let (Some(_), Some(cache)) = (home, cache) else {
        eprintln!("polycarp browser: no home folder");
        return Some(1);
    };
    let resources = std::env::var_os(portable::RESOURCES);
    #[cfg(target_os = "linux")]
    let done = with_parts(resources, |parts| dry_run(&cache.join("browser"), &parts));
    #[cfg(not(target_os = "linux"))]
    let done = with_parts(resources, |_| {
        let why = format!("{} is not Linux", cache.display());
        Err(Refused::new("system", why))
    });
    Some(print(done))
}

/// Runs `go` only once the parts are all there, so a refusal for them comes before any download.
fn with_parts(
    resources: Option<OsString>,
    go: impl FnOnce(portable::Parts) -> Result<String, Refused>,
) -> Result<String, Refused> {
    go(portable::parts(resources, &portable::LINUX)?)
}

/// What `portable::build` made in `build`: a runnable launcher, the prefs that turn update fetching off, and the
/// built-in extension.
fn made(build: &Path, launcher: &Path) -> Result<(), Refused> {
    let no = |why: &str| Err(Refused::new("build", why));
    let meta = fs::symlink_metadata(launcher);
    if !meta.as_ref().is_ok_and(|m| m.is_file()) {
        return no("the launcher is missing");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.is_ok_and(|m| m.permissions().mode() & 0o111 == 0) {
            return no("the launcher can't run");
        }
    }
    let prefs = fs::read_to_string(build.join("initial_preferences"));
    if !prefs.is_ok_and(|p| p == portable::PREFS) {
        return no("initial_preferences is not Polycarp's");
    }
    let extension = build.join("polycarp").join("extension");
    if !["manifest.json", "builtin.txt"]
        .iter()
        .all(|f| extension.join(f).is_file())
    {
        return no("the built-in extension is missing");
    }
    Ok(())
}

/// Helium's name for this processor.
fn arch_name(arch: &str) -> Result<&'static str, Refused> {
    match arch {
        "x86_64" => Ok("x86_64"),
        "aarch64" => Ok("arm64"),
        _ => Err(Refused::new("processor", "no Helium for this processor")),
    }
}

/// The tarball and its detached signature, each with its own address check and sha256.
fn parse(json: &str, arch: &str) -> Result<(Release, Release), Refused> {
    let tarball = |version: &str| format!("helium-{version}-{arch}_linux.tar.xz");
    let release = |name: &dyn Fn(&str) -> String| {
        listing::parse(json, DOWNLOADS, name).map_err(|why| Refused::new("release", why))
    };
    let signature = |version: &str| format!("{}.asc", tarball(version));
    Ok((release(&tarball)?, release(&signature)?))
}

/// Tarballs and signatures of other Linux releases, and halves of them; never the two this release uses.
fn others(current: [String; 2]) -> impl Fn(&str) -> bool {
    move |name: &str| {
        name.starts_with("helium-")
            && name.contains("_linux.tar.xz")
            && !current.iter().any(|c| c == name)
    }
}

/// The first of `paths` that is a file; a refusal naming every path tried when none is.
fn first(check: &'static str, paths: &[&str]) -> Result<PathBuf, Refused> {
    let found = paths.iter().map(PathBuf::from).find(|p| p.is_file());
    found.ok_or_else(|| Refused::new(check, format!("no program at {}", paths.join(" or "))))
}

/// gpg's `--status-fd` answer for one detached signature: it passes only when gpg exited well, nothing went wrong,
/// there is exactly one good and one valid signature, the signature is on the file itself (class 00) and its
/// primary key is Helium's pinned one.
fn judge_gpg(status: &str, exit_ok: bool) -> Result<(), Refused> {
    let no = |why: &str| Err(Refused::new("signature", why));
    let lines: Vec<Vec<&str>> = status
        .lines()
        .filter_map(|l| l.strip_prefix("[GNUPG:] "))
        .map(|l| l.split_whitespace().collect())
        .collect();
    let count = |word: &str| lines.iter().filter(|f| f.first() == Some(&word)).count();
    for (word, why) in [
        ("BADSIG", "the signature does not verify"),
        ("ERRSIG", "the signature could not be checked"),
        ("NO_PUBKEY", "signed by another key"),
        ("EXPSIG", "the signature has expired"),
        ("EXPKEYSIG", "the key has expired"),
        ("REVKEYSIG", "the key was revoked"),
    ] {
        if count(word) > 0 {
            return no(why);
        }
    }
    if !exit_ok {
        return no("gpg did not accept the signature");
    }
    let (good, valid) = (count("GOODSIG"), count("VALIDSIG"));
    if good == 0 || valid == 0 {
        return no("the signature does not verify");
    }
    if good > 1 || valid > 1 {
        return no("there is more than one signature");
    }
    let Some(validsig) = lines.iter().find(|f| f.first() == Some(&"VALIDSIG")) else {
        return no("the signature does not verify");
    };
    let fields = &validsig[1..];
    if fields.len() < 10 {
        return no("gpg's answer was not understood");
    }
    if fields[8] != "00" {
        return no("it is not a signature on the file itself");
    }
    if fields[9] != FINGERPRINT {
        return no("signed by another key");
    }
    Ok(())
}

/// A fingerprint in groups of four, as people read it.
fn spaced(fingerprint: &str) -> String {
    let groups: Vec<&str> = (0..fingerprint.len())
        .step_by(4)
        .filter_map(|i| fingerprint.get(i..(i + 4).min(fingerprint.len())))
        .collect();
    groups.join(" ")
}

fn done_line(version: &str, n: usize) -> String {
    format!(
        "Helium {version} was downloaded and passed its checks: the sha256 GitHub lists, and Helium's OpenPGP \
         signature from key {}. Polycarp Browser was built from its {n} files, started once without a window, showing its own new \
         tab, and deleted. Nothing was installed.",
        spaced(FINGERPRINT)
    )
}

/// How long the headless start may take.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const LIMIT: std::time::Duration = std::time::Duration::from_secs(180);
/// Ubuntu 23.10 and later set this to 1, which keeps Chromium's sandbox from starting for a browser with no AppArmor
/// profile of its own.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const USERNS: &str = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

fn no_sandbox() -> Refused {
    Refused::new(
        "sandbox",
        "Ubuntu's AppArmor stops unprivileged user namespaces, which Chromium's sandbox needs, so Polycarp Browser \
         can't start here. Polycarp never turns the sandbox off. An AppArmor profile for the browser or `sudo sysctl \
         kernel.apparmor_restrict_unprivileged_userns=0` lets it start.",
    )
}

/// A refusal when `path` (the AppArmor switch in `USERNS`) reads 1. A missing file, 0 or anything else goes ahead.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn sandbox_allowed(path: &Path) -> Result<(), Refused> {
    match fs::read_to_string(path) {
        Ok(text) if text.trim() == "1" => Err(no_sandbox()),
        _ => Ok(()),
    }
}

/// What one headless start wrote, and whether it ran past its limit and was killed.
#[cfg_attr(not(unix), allow(dead_code))]
struct Ran {
    out: String,
    err: String,
    timed_out: bool,
}

/// The start passes only when it finished in time and showed Polycarp's new tab; a sandbox that could not start is
/// said so, with the remedy.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn judge_start(ran: &Ran, limit: std::time::Duration) -> Result<(), Refused> {
    let shown = portable::judge(&ran.out, &ran.err);
    if shown.is_ok() && !ran.timed_out {
        return Ok(());
    }
    if ran.err.contains("No usable sandbox") {
        return Err(no_sandbox());
    }
    if ran.timed_out {
        let last = ran.err.lines().map(str::trim).rfind(|l| !l.is_empty());
        let why = format!(
            "it did not finish within {} s ({})",
            limit.as_secs(),
            last.unwrap_or("no output")
        );
        return Err(Refused::new("start", why));
    }
    shown
}

/// Reads a pipe to its end on a thread of its own and sends what it read.
#[cfg(unix)]
fn drain<R: std::io::Read + Send + 'static>(pipe: Option<R>) -> std::sync::mpsc::Receiver<String> {
    let (send, got) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut text);
        }
        let _ = send.send(String::from_utf8_lossy(&text).into_owned());
    });
    got
}

/// Runs the start in a process group of its own, killed with the whole group when it takes longer than `limit`.
/// Afterwards the group and everything running from the build are stopped, so no helper holds its pipes, and the
/// pipes are read for at most the time left plus 5 s.
#[cfg(unix)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn run_for(start: &portable::Start, limit: std::time::Duration) -> Result<Ran, Refused> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut command = Command::new(&start.program);
    command.args(&start.args).envs(start.env.iter().cloned());
    for name in start.unset {
        command.env_remove(name);
    }
    let mut child = command
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(refuse("start", "running it"))?;
    let group = child.id() as i32;
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let began = std::time::Instant::now();
    let (mut timed_out, mut failed) = (false, None);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if began.elapsed() > limit => {
                timed_out = true;
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(e) => {
                failed = Some(e);
                break;
            }
        }
    }
    // SAFETY: killpg(2) takes plain integers and touches no memory of ours. The group is the start's own.
    unsafe {
        libc::killpg(group, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    stop_inside(start.program.parent().unwrap_or(&start.program));
    if let Some(e) = failed {
        return Err(refuse("start", "waiting for it")(e));
    }
    let wait = limit.saturating_sub(began.elapsed()) + std::time::Duration::from_secs(5);
    let until = std::time::Instant::now() + wait;
    let read = |got: std::sync::mpsc::Receiver<String>| {
        let left = until.saturating_duration_since(std::time::Instant::now());
        got.recv_timeout(left).unwrap_or_default()
    };
    Ok(Ran {
        out: read(out),
        err: read(err),
        timed_out,
    })
}

/// Stops every process whose program is inside `folder` with SIGKILL, best effort.
#[cfg(unix)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn stop_inside(folder: &Path) {
    // `/proc/<pid>/exe` gives the real path, so the folder is compared by its real path too.
    let real = fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    for pid in inside_build(Path::new("/proc"), &real) {
        // SAFETY: kill(2) takes plain integers and touches no memory of ours.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

/// The processes under `proc` (Linux's `/proc`) whose program, `<pid>/exe`, resolves inside `build`. A process
/// whose program was deleted reads as `<path> (deleted)`, still inside. Ones that can't be read are skipped.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn inside_build(proc: &Path, build: &Path) -> Vec<i32> {
    let Ok(entries) = fs::read_dir(proc) else {
        return Vec::new();
    };
    let mut pids: Vec<i32> = entries
        .flatten()
        .filter_map(|e| {
            let pid: i32 = e.file_name().to_str()?.parse().ok()?;
            let exe = fs::read_link(e.path().join("exe")).ok()?;
            (pid > 0 && exe.starts_with(build)).then_some(pid)
        })
        .collect();
    pids.sort_unstable();
    pids
}

/// The unpacked folder and its number of plain files, when the work folder holds exactly Helium's one folder with its
/// program and wrapper, and nothing in it is anything but a folder, a plain file or a link to a plain file beside it.
fn laid_out(work: &Path, version: &str, arch: &str) -> Result<(PathBuf, usize), Refused> {
    let bad = || Refused::new("layout", "the tarball is not laid out as Helium's");
    let entries: Vec<_> = fs::read_dir(work).map_err(|_| bad())?.collect();
    let top = format!("helium-{version}-{arch}_linux");
    let [Ok(entry)] = entries.as_slice() else {
        return Err(bad());
    };
    let plain = |p: &Path, dir: bool| {
        fs::symlink_metadata(p)
            .is_ok_and(|m| !is_link(&m) && if dir { m.is_dir() } else { m.is_file() })
    };
    let root = entry.path();
    let ok = entry.file_name() == top.as_str()
        && plain(&root, true)
        && plain(&root.join("helium"), false)
        && plain(&root.join("helium-wrapper"), false);
    if !ok {
        return Err(bad());
    }
    let mut files = 0;
    let mut folders = vec![root.clone()];
    while let Some(folder) = folders.pop() {
        for entry in fs::read_dir(&folder).map_err(|_| bad())? {
            let path = entry.map_err(|_| bad())?.path();
            let meta = fs::symlink_metadata(&path).map_err(|_| bad())?;
            if is_link(&meta) {
                let target = fs::read_link(&path).map_err(|_| bad())?;
                let text = target.to_str().unwrap_or("/");
                let beside = !text.is_empty() && !text.contains('/') && text != "." && text != "..";
                if !beside || !plain(&folder.join(text), false) {
                    return Err(bad());
                }
            } else if meta.is_dir() {
                folders.push(path);
            } else if meta.is_file() {
                files += 1;
            } else {
                return Err(bad());
            }
        }
    }
    Ok((root, files))
}

/// The binary key inside an armored OpenPGP block, which `gpgv` reads as its keyring. None when it is not one.
fn dearmor(armored: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let mut lines = armored.lines().map(str::trim_end);
    lines.find(|l| *l == "-----BEGIN PGP PUBLIC KEY BLOCK-----")?;
    // Header lines such as `Comment:` end at the first empty line.
    lines.find(|l| l.is_empty())?;
    let mut body = String::new();
    for line in lines {
        if line == "-----END PGP PUBLIC KEY BLOCK-----" {
            return base64::engine::general_purpose::STANDARD.decode(body).ok();
        }
        // The checksum line; the pinned file's sha256 already covers it.
        if !line.starts_with('=') {
            body.push_str(line);
        }
    }
    None
}

/// A program by its absolute path, with none of the person's environment: helpers it runs by name, such as tar's
/// `xz`, come only from `/usr/bin` and `/bin`, never from a folder on the person's `PATH`.
fn pinned(program: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C");
    command
}

/// `gpgv` checks one signature against one keyring file. Unlike `gpg` it never starts an agent or keyboxd and
/// reads no options file; `--homedir` keeps it out of the person's `~/.gnupg`.
fn gpgv(
    program: &Path,
    home: &Path,
    keyring: &Path,
    asc: &Path,
    tarball: &Path,
) -> std::process::Command {
    let mut command = pinned(program);
    command
        .arg("--homedir")
        .arg(home)
        .args(["--status-fd", "1", "--keyring"])
        .arg(keyring)
        .arg("--")
        .arg(asc)
        .arg(tarball);
    command
}

fn tar(program: &Path, tarball: &Path, work: &Path) -> std::process::Command {
    let mut command = pinned(program);
    command
        .arg("-xJf")
        .arg(tarball)
        .arg("-C")
        .arg(work)
        .arg("--no-same-owner");
    command
}

#[cfg(target_os = "linux")]
mod system {
    use super::*;
    use std::ffi::OsStr;
    use std::os::unix::fs::DirBuilderExt;
    use std::process::{Command, Output};

    /// Runs a program by its absolute path, no shell, nothing on stdin; what it did, whatever its exit.
    fn ran(check: &'static str, command: Command) -> Result<Output, Refused> {
        fed(check, command, None)
    }

    /// Runs a program with `input` as all it reads, or nothing.
    fn fed(
        check: &'static str,
        mut command: Command,
        input: Option<String>,
    ) -> Result<Output, Refused> {
        let program = PathBuf::from(command.get_program());
        let cannot = |e: std::io::Error| {
            Refused::new(check, format!("{} could not run: {e}", program.display()))
        };
        download::run_fed(&mut command, input).map_err(cannot)
    }

    /// Runs a program, which must succeed; its output.
    fn must(check: &'static str, command: Command) -> Result<String, Refused> {
        must_fed(check, command, None)
    }

    fn must_fed(
        check: &'static str,
        command: Command,
        input: Option<String>,
    ) -> Result<String, Refused> {
        let out = fed(check, command, input)?;
        if !out.status.success() {
            let said = String::from_utf8_lossy(&out.stderr);
            let last = said.lines().map(str::trim).rfind(|l| !l.is_empty());
            let why = last.map_or(format!("exit {:?}", out.status.code()), str::to_string);
            return Err(Refused::new(check, why));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Removes a folder or file, without following a link, when it is there.
    fn clear(path: &Path) -> std::io::Result<()> {
        match fs::symlink_metadata(path) {
            Ok(m) if m.is_dir() => fs::remove_dir_all(path),
            Ok(_) => fs::remove_file(path),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// A private, empty folder at `path`, whatever was there before.
    fn fresh(check: &'static str, path: &Path) -> Result<(), Refused> {
        clear(path).map_err(refuse(check, "clearing it"))?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(refuse(check, "making it"))
    }

    /// `curl`, https only, without the person's own curl settings, as on the Mac and Windows.
    fn curl(
        check: &'static str,
        seconds: u64,
        bytes: u64,
        more: &[&OsStr],
    ) -> Result<String, Refused> {
        curl_fed(check, seconds, bytes, more, None)
    }

    fn curl_fed(
        check: &'static str,
        seconds: u64,
        bytes: u64,
        more: &[&OsStr],
        input: Option<String>,
    ) -> Result<String, Refused> {
        let mut command = Command::new(first(check, &["/usr/bin/curl", "/bin/curl"])?);
        // The token reaches curl only on its input, never in its environment.
        command.env_remove(download::TOKEN);
        let options =
            "-q --fail --silent --show-error --location --proto =https --proto-redir =https \
                       --tlsv1.2 --retry 2 --connect-timeout 20 --user-agent polycarp-browser";
        command
            .args(options.split_whitespace())
            .arg("--max-filesize")
            .arg(bytes.to_string())
            .arg("--max-time")
            .arg(seconds.to_string())
            .args(more);
        must_fed(check, command, input)
    }

    fn newest(arch: &str) -> Result<(Release, Release), Refused> {
        let header = download::feed_token();
        let args = download::feed_args(FEED, header.is_some());
        let more: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
        let said = curl_fed("release", 60, 734_003_200, &more, header)?;
        parse(&said, arch)
    }

    pub struct Fetched {
        pub release: Release,
        pub arch: &'static str,
        pub tarball: PathBuf,
        pub asc: PathBuf,
    }

    /// Downloads `url` into the file it is given, in at most `seconds` and `bytes`.
    fn get(url: &str, seconds: u64, bytes: u64) -> impl Fn(&Path) -> Result<(), Refused> + '_ {
        move |part: &Path| {
            let more: [&OsStr; 4] = [
                "--output".as_ref(),
                part.as_os_str(),
                "--".as_ref(),
                OsStr::new(url),
            ];
            curl("download", seconds, bytes, &more).map(drop)
        }
    }

    pub fn download(dir: &Path) -> Result<Fetched, Refused> {
        let arch = arch_name(std::env::consts::ARCH)?;
        fs::create_dir_all(dir).map_err(refuse("download", "making the cache folder"))?;
        let (release, signature) = newest(arch)?;
        let old = others([release.name.clone(), signature.name.clone()]);
        let tarball = fetch(&release, dir, &get(&release.url, 1800, 734_003_200), &old)?;
        let asc = fetch(&signature, dir, &get(&signature.url, 60, 65_536), &old)?;
        Ok(Fetched {
            release,
            arch,
            tarball,
            asc,
        })
    }

    /// Checks `asc` on `tarball` against the pinned key with `gpgv`, in a folder under `dir` that holds only that
    /// key and is removed afterwards.
    pub fn signature(dir: &Path, tarball: &Path, asc: &Path) -> Result<(), Refused> {
        let program = first("signature", &["/usr/bin/gpgv", "/bin/gpgv"])?;
        let key = dearmor(KEY)
            .ok_or_else(|| Refused::new("signature", "the pinned key could not be read"))?;
        let keyring = dir.join("gnupg");
        let checked = fresh("signature", &keyring).and_then(|()| {
            let file = keyring.join("helium.gpg");
            fs::write(&file, &key).map_err(refuse("signature", "writing the key"))?;
            let out = ran("signature", gpgv(&program, &keyring, &file, asc, tarball))?;
            judge_gpg(&String::from_utf8_lossy(&out.stdout), out.status.success())
        });
        let _ = clear(&keyring);
        checked
    }

    /// Unpacks the tarball into `work` with the system's tar, which refuses `..` members and strips a leading `/`.
    /// Helium's folder and its number of files.
    pub fn unpack(
        tarball: &Path,
        work: &Path,
        release: &Release,
        arch: &str,
    ) -> Result<(PathBuf, usize), Refused> {
        let program = first("unpack", &["/usr/bin/tar", "/bin/tar"])?;
        must("unpack", tar(&program, tarball, work))?;
        laid_out(work, &release.version, arch)
    }

    /// Builds Polycarp Browser in `work/build` from Helium's checked folder and checks what it made. The launcher.
    pub fn built(folder: &Path, work: &Path, parts: &portable::Parts) -> Result<PathBuf, Refused> {
        let build = work.join("build");
        let launcher = portable::build(folder, &build, parts)?;
        made(&build, &launcher)?;
        Ok(launcher)
    }

    /// Builds in `work/build` and starts that once with its home in `work/home`, under Chromium's own sandbox.
    pub fn started(folder: &Path, work: &Path, parts: &portable::Parts) -> Result<(), Refused> {
        // Local Studio is left out of the build that is started, as on Windows: its extension could reach the
        // person's own helper.
        let parts = portable::Parts {
            local_studio: work.join("no-local-studio"),
            ..parts.clone()
        };
        let launcher = built(folder, work, &parts)?;
        let home = work.join("home");
        let start = portable::start(&launcher, &home, parts.layout);
        portable::make_home(&start, &home)?;
        let ran = run_for(&start, LIMIT)?;
        judge_start(&ran, LIMIT)
    }

    /// Downloads and checks the newest release in `dir`, builds Polycarp Browser from it and starts it once, then
    /// throws it all away.
    pub fn dry_run(dir: &Path, parts: &portable::Parts) -> Result<String, Refused> {
        // Nothing is downloaded or run when the browser's sandbox could not start here.
        sandbox_allowed(Path::new(USERNS))?;
        let got = download(dir)?;
        signature(dir, &got.tarball, &got.asc)?;
        let work = dir.join("work");
        let checked = fresh("work folder", &work).and_then(|()| {
            let (folder, n) = unpack(&got.tarball, &work, &got.release, got.arch)?;
            started(&folder, &work, parts).map(|()| n)
        });
        stop_inside(&work.join("build"));
        // A browser that just quit can hold its files a moment longer.
        for _ in 0..10 {
            if clear(&work).is_ok() && fs::symlink_metadata(&work).is_err() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        let n = checked?;
        if fs::symlink_metadata(&work).is_ok() {
            return Err(Refused::new("work folder", "it could not be deleted"));
        }
        Ok(done_line(&got.release.version, n))
    }
}

#[cfg(target_os = "linux")]
use system::dry_run;

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::ffi::OsStr;

    const VERSION: &str = "0.22.5.1";

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("polycarp-bl-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// A trimmed listing in the real one's shape, with made-up digests.
    fn feed_of(ends: &[&str], digest: &str) -> String {
        let asset = |end: &&str| {
            let name = format!("helium-{VERSION}-{end}");
            let url = format!("{DOWNLOADS}/{VERSION}/{name}");
            format!("{{\"name\":\"{name}\",\"browser_download_url\":\"{url}\",\"digest\":\"sha256:{digest}\"}}")
        };
        let assets: Vec<String> = ends.iter().map(asset).collect();
        format!(
            "{{\"tag_name\":\"{VERSION}\",\"draft\":false,\"prerelease\":false,\"assets\":[{}]}}",
            assets.join(",")
        )
    }

    const ENDS: [&str; 8] = [
        "arm64.AppImage",
        "arm64.AppImage.zsync",
        "arm64_linux.tar.xz",
        "arm64_linux.tar.xz.asc",
        "x86_64.AppImage",
        "x86_64.AppImage.zsync",
        "x86_64_linux.tar.xz",
        "x86_64_linux.tar.xz.asc",
    ];

    fn feed(digest: &str) -> String {
        feed_of(&ENDS, digest)
    }

    #[test]
    fn the_newest_linux_tarball_and_signature_for_each_processor() {
        for arch in ["x86_64", "arm64"] {
            let (tarball, asc) = parse(&feed(&"AB".repeat(32)), arch).unwrap();
            assert_eq!(
                tarball.name,
                format!("helium-{VERSION}-{arch}_linux.tar.xz")
            );
            assert_eq!(asc.name, format!("{}.asc", tarball.name));
            let at = "https://github.com/imputnet/helium-linux/releases/download/0.22.5.1/";
            for r in [&tarball, &asc] {
                assert_eq!(r.url, format!("{at}{}", r.name));
                assert_eq!(r.sha256, "ab".repeat(32));
                assert_eq!(r.version, VERSION);
            }
        }
        assert_eq!(arch_name("x86_64"), Ok("x86_64"));
        assert_eq!(arch_name("aarch64"), Ok("arm64"));
        let e = arch_name("riscv64").unwrap_err();
        assert_eq!(e.check, "processor");
        assert!(e.why.contains("no Helium for this processor"));
    }

    #[test]
    fn a_linux_listing_that_is_off_is_refused() {
        let digest = "ab".repeat(32);
        let refused = |json: &str| parse(json, "x86_64").unwrap_err();
        let only_others = feed_of(
            &["x86_64.AppImage", "x86_64.AppImage.zsync", "amd64.deb"],
            &digest,
        );
        let e = refused(&only_others);
        assert_eq!(e.check, "release");
        assert!(
            e.why.contains("has no helium-0.22.5.1-x86_64_linux.tar.xz"),
            "{}",
            e.why
        );
        let no_asc = feed_of(&["x86_64.AppImage", "x86_64_linux.tar.xz"], &digest);
        let e = refused(&no_asc);
        assert_eq!(e.check, "release");
        assert!(
            e.why
                .contains("has no helium-0.22.5.1-x86_64_linux.tar.xz.asc"),
            "{}",
            e.why
        );
        for (from, to, why) in [
            (
                "github.com/imputnet",
                "example.com/imputnet",
                "another address",
            ),
            ("https://", "http://", "another address"),
            (
                "helium-linux/releases",
                "helium-macos/releases",
                "another address",
            ),
            (
                "\"prerelease\":false",
                "\"prerelease\":true",
                "full release",
            ),
            ("sha256:ab", "sha256:zz", "no sha256"),
        ] {
            let e = refused(&feed(&digest).replace(from, to));
            assert_eq!(e.check, "release");
            assert!(e.why.contains(why), "{from}: {} should say {why}", e.why);
        }
        // Only the signature's address moved.
        let asc_url = format!("download/{VERSION}/helium-{VERSION}-x86_64_linux.tar.xz.asc");
        let moved = feed(&digest).replace(&asc_url, &format!("download/x/{asc_url}"));
        assert!(refused(&moved).why.contains("another address"));
    }

    #[test]
    fn the_pinned_key_file_is_the_one_measured() {
        assert_eq!(
            hex(KEY.as_bytes()),
            "e25c51e39b68d79d89bd26fc1200791f590f2e780efb946d62ca25ff5487d022"
        );
        // The same bytes `gpg --dearmor` gives for it, which gpgv read to pass the real release.
        assert_eq!(
            hex(&dearmor(KEY).expect("the pinned key is armored")),
            "b1d4ab21420c1fd3f4f5e4710b0bf3a47c3e36861a64d1c2486c610914eae413"
        );
        assert_eq!(dearmor("not a key"), None);
        let no_end = KEY.replace("-----END PGP PUBLIC KEY BLOCK-----", "");
        assert_eq!(dearmor(&no_end), None);
        assert_eq!(
            spaced(FINGERPRINT),
            "BE67 7C19 89D3 5EAB 2C5F 26C9 3516 01AD 01D6 378E"
        );
        assert_eq!(
            done_line(VERSION, 292),
            "Helium 0.22.5.1 was downloaded and passed its checks: the sha256 GitHub lists, and Helium's OpenPGP \
             signature from key BE67 7C19 89D3 5EAB 2C5F 26C9 3516 01AD 01D6 378E. Polycarp Browser was built from \
             its 292 files, started once without a window, showing its own new tab, and deleted. Nothing was \
             installed."
        );
    }

    const GOOD: &str = "[GNUPG:] GOODSIG 351601AD01D6378E Helium signing key (https://helium.computer/) <helium@imput.net>";
    const VALID: &str = "[GNUPG:] VALIDSIG BE677C1989D35EAB2C5F26C9351601AD01D6378E 2026-11-25 1795640525 0 4 0 22 10 00 BE677C1989D35EAB2C5F26C9351601AD01D6378E";

    fn real() -> String {
        format!(
            "[GNUPG:] NEWSIG\n[GNUPG:] KEY_CONSIDERED BE677C1989D35EAB2C5F26C9351601AD01D6378E 0\n\
             [GNUPG:] SIG_ID x 2026-11-25 1795640525\n{GOOD}\n{VALID}\n[GNUPG:] TRUST_UNDEFINED 0 pgp\n"
        )
    }

    fn why(status: &str, ok: bool) -> String {
        let e = judge_gpg(status, ok).unwrap_err();
        assert_eq!(e.check, "signature");
        assert!(!e.why.contains('\n'), "{}", e.why);
        e.why
    }

    #[test]
    fn only_a_good_signature_from_helium_s_key_passes() {
        assert_eq!(judge_gpg(&real(), true), Ok(()));
        assert_eq!(why(&real(), false), "gpg did not accept the signature");
        let bad = "[GNUPG:] NEWSIG\n[GNUPG:] BADSIG 351601AD01D6378E Helium signing key\n";
        assert_eq!(why(bad, false), "the signature does not verify");
        assert_eq!(why(bad, true), "the signature does not verify");
        let err = "[GNUPG:] ERRSIG 351601AD01D6378E 22 10 00 1795640525 9 -\n";
        assert_eq!(why(err, false), "the signature could not be checked");
        assert_eq!(
            why("[GNUPG:] NO_PUBKEY 351601AD01D6378E\n", false),
            "signed by another key"
        );
        for (word, said) in [
            ("EXPKEYSIG", "the key has expired"),
            ("REVKEYSIG", "the key was revoked"),
            ("EXPSIG", "the signature has expired"),
        ] {
            let status = format!("{}[GNUPG:] {word} 351601AD01D6378E Helium\n", real());
            assert_eq!(why(&status, true), said, "{word}");
        }
        assert_eq!(why("", true), "the signature does not verify");
        assert_eq!(
            why(&format!("{GOOD}\n"), true),
            "the signature does not verify"
        );
        assert_eq!(
            why(&format!("{VALID}\n"), true),
            "the signature does not verify"
        );
        // GOODSIG or VALIDSIG twice.
        assert_eq!(
            why(&format!("{}{GOOD}\n", real()), true),
            "there is more than one signature"
        );
        assert_eq!(
            why(&format!("{}{VALID}\n", real()), true),
            "there is more than one signature"
        );
        let class = real().replace(" 10 00 BE67", " 10 01 BE67");
        assert_eq!(
            why(&class, true),
            "it is not a signature on the file itself"
        );
        let short = real().replace(" 10 00 BE677C1989D35EAB2C5F26C9351601AD01D6378E", " 10 00");
        assert_eq!(why(&short, true), "gpg's answer was not understood");
        // Another primary key: a whole other one, one hex digit changed, lowercase, or a prefix of Helium's.
        let primary =
            |fpr: &str| real().replace(&format!(" 00 {FINGERPRINT}"), &format!(" 00 {fpr}"));
        for fpr in [
            "0123456789ABCDEF0123456789ABCDEF01234567",
            "BE677C1989D35EAB2C5F26C9351601AD01D6378F",
            FINGERPRINT.to_lowercase().as_str(),
            &FINGERPRINT[..16],
            format!("{FINGERPRINT}00").as_str(),
        ] {
            assert_eq!(why(&primary(fpr), true), "signed by another key", "{fpr}");
        }
        // Only lines that start with gpg's own marker count.
        let quoted = format!("x{GOOD}\nx{VALID}\n");
        assert_eq!(why(&quoted, true), "the signature does not verify");
    }

    #[test]
    fn a_download_and_its_signature_are_kept_only_while_their_digests_match() {
        let dir = temp("fetch");
        for old in [
            "helium-0.1.0.0-x86_64_linux.tar.xz",
            "helium-0.1.0.0-x86_64_linux.tar.xz.asc",
            "helium-0.22.5.1-x86_64_linux.tar.xz.part",
        ] {
            fs::write(dir.join(old), "old").unwrap();
        }
        fs::write(dir.join("notes.txt"), "not Helium's").unwrap();
        let (tar_body, asc_body) = ("a made-up tarball", "a made-up signature");
        let json = feed(&"00".repeat(32));
        let (mut tarball, mut asc) = parse(&json, "x86_64").unwrap();
        tarball.sha256 = hex(tar_body.as_bytes());
        asc.sha256 = hex(asc_body.as_bytes());
        let count = std::cell::Cell::new(0);
        let counted = &count;
        let get = |body: &'static str| {
            move |part: &Path| {
                let count = counted;
                count.set(count.get() + 1);
                fs::write(part, body).map_err(refuse("download", "writing"))
            }
        };
        let (get_tar, get_asc) = (get(tar_body), get(asc_body));
        let old = others([tarball.name.clone(), asc.name.clone()]);
        let file = fetch(&tarball, &dir, &get_tar, &old).unwrap();
        let sig = fetch(&asc, &dir, &get_asc, &old).unwrap();
        fetch(&tarball, &dir, &get_tar, &old).unwrap();
        fetch(&asc, &dir, &get_asc, &old).unwrap();
        assert_eq!(count.get(), 2, "a good cached file was downloaded again");
        let mut left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        left.sort();
        assert_eq!(left, [file.clone(), sig.clone(), dir.join("notes.txt")]);
        fs::write(&file, "changed after it was downloaded").unwrap();
        fetch(&tarball, &dir, &get_tar, &old).unwrap();
        assert_eq!(count.get(), 3);
        assert!(
            sig.exists(),
            "the signature went with the tarball's download"
        );
        tarball.sha256 = "00".repeat(32);
        fs::remove_file(&file).unwrap();
        assert_eq!(
            fetch(&tarball, &dir, &get_tar, &old).unwrap_err().check,
            "digest"
        );
        assert!(!file.exists(), "a refused download was kept");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tar_and_gpgv_run_with_only_the_system_s_path() {
        let path = |c: &std::process::Command| {
            c.get_envs()
                .map(|(k, v)| (k.to_owned(), v.map(OsStr::to_owned)))
                .collect::<Vec<_>>()
        };
        let want = vec![
            ("LC_ALL".into(), Some("C".into())),
            ("PATH".into(), Some("/usr/bin:/bin".into())),
        ];
        let args =
            |c: &std::process::Command| c.get_args().map(OsStr::to_owned).collect::<Vec<_>>();
        let t = tar(
            Path::new("/usr/bin/tar"),
            Path::new("/c/h.tar.xz"),
            Path::new("/c/work"),
        );
        assert_eq!(path(&t), want);
        assert_eq!(
            args(&t),
            ["-xJf", "/c/h.tar.xz", "-C", "/c/work", "--no-same-owner"]
        );
        let g = gpgv(
            Path::new("/usr/bin/gpgv"),
            Path::new("/c/gnupg"),
            Path::new("/c/gnupg/helium.gpg"),
            Path::new("/c/h.tar.xz.asc"),
            Path::new("/c/h.tar.xz"),
        );
        assert_eq!(path(&g), want);
        let expected = [
            "--homedir",
            "/c/gnupg",
            "--status-fd",
            "1",
            "--keyring",
            "/c/gnupg/helium.gpg",
            "--",
            "/c/h.tar.xz.asc",
            "/c/h.tar.xz",
        ];
        assert_eq!(args(&g), expected);
    }

    #[test]
    fn a_program_is_the_first_path_that_is_there() {
        let dir = temp("first");
        let there = dir.join("tool");
        fs::write(&there, "x").unwrap();
        let (none, yes) = (dir.join("none"), there.to_str().unwrap().to_string());
        let none = none.to_str().unwrap();
        assert_eq!(first("download", &[none, yes.as_str()]), Ok(there.clone()));
        let e = first("download", &[none, dir.to_str().unwrap()]).unwrap_err();
        assert_eq!(e.why, format!("no program at {none} or {}", dir.display()));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Helium's layout in small: the program, its wrapper, `chrome -> helium` and a folder.
    fn helium(work: &Path) -> PathBuf {
        let top = work.join(format!("helium-{VERSION}-x86_64_linux"));
        fs::create_dir_all(top.join("locales")).unwrap();
        for f in [
            "helium",
            "helium-wrapper",
            "resources.pak",
            "locales/en-US.pak",
        ] {
            fs::write(top.join(f), "x").unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink("helium", top.join("chrome")).unwrap();
        top
    }

    #[test]
    fn only_helium_s_own_layout_is_unpacked() {
        let work = temp("layout");
        let top = helium(&work);
        let check = |version: &str, arch: &str| laid_out(&work, version, arch).map_err(|e| e.why);
        let bad = Err("the tarball is not laid out as Helium's".to_string());
        assert_eq!(check(VERSION, "x86_64"), Ok((top.clone(), 4)));
        assert_eq!(check("0.22.5.2", "x86_64"), bad, "another version");
        assert_eq!(check(VERSION, "arm64"), bad, "another processor");
        fs::write(work.join("extra"), "x").unwrap();
        assert_eq!(check(VERSION, "x86_64"), bad, "two entries");
        fs::remove_file(work.join("extra")).unwrap();
        for f in ["helium", "helium-wrapper"] {
            fs::rename(top.join(f), work.join(f)).unwrap();
            let e = check(VERSION, "x86_64");
            fs::rename(work.join(f), top.join(f)).unwrap();
            assert_eq!(e, bad, "without {f}");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::rename(top.join("helium"), top.join("helium-real")).unwrap();
            symlink("helium-real", top.join("helium")).unwrap();
            assert_eq!(check(VERSION, "x86_64"), bad, "helium is a link");
            fs::remove_file(top.join("helium")).unwrap();
            fs::rename(top.join("helium-real"), top.join("helium")).unwrap();
            assert_eq!(check(VERSION, "x86_64"), Ok((top.clone(), 4)));
            for target in [
                "../escape",
                "/etc/passwd",
                "locales/en-US.pak",
                "chrome",
                "locales",
                ".",
                "..",
                "missing",
            ] {
                let link = top.join("locales").join("x");
                let at =
                    if target == "locales/en-US.pak" || target == "chrome" || target == "locales" {
                        top.join("x")
                    } else {
                        link.clone()
                    };
                symlink(target, &at).unwrap();
                let e = check(VERSION, "x86_64");
                fs::remove_file(&at).unwrap();
                assert_eq!(e, bad, "x -> {target}");
            }
            fs::write(work.join("escape"), "x").unwrap();
            symlink("../escape", top.join("x")).unwrap();
            assert_eq!(
                check(VERSION, "x86_64"),
                bad,
                "x -> ../escape beside the top folder"
            );
            fs::remove_file(top.join("x")).unwrap();
            fs::remove_file(work.join("escape")).unwrap();
            let fifo = std::ffi::CString::new(top.join("pipe").to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
            assert_eq!(check(VERSION, "x86_64"), bad, "a fifo");
            fs::remove_file(top.join("pipe")).unwrap();
            let real = temp("layout-real");
            fs::rename(&top, real.join("x")).unwrap();
            symlink(real.join("x"), &top).unwrap();
            assert_eq!(
                check(VERSION, "x86_64"),
                bad,
                "a link in the top folder's place"
            );
            fs::remove_dir_all(&real).unwrap();
        }
        fs::remove_dir_all(&work).unwrap();
    }

    #[test]
    fn only_install_dry_run_is_answered() {
        #[cfg(target_os = "macos")]
        assert_eq!(VERBS, crate::browser::VERBS);
        let run_ = |a: &[&str], home: Option<PathBuf>| {
            run(
                &a.iter().map(OsString::from).collect::<Vec<_>>(),
                home.clone(),
                home,
            )
        };
        let home = Some(PathBuf::from("/nowhere"));
        assert_eq!(run_(&[], home.clone()), Some(0));
        assert_eq!(run_(&["--help"], home.clone()), Some(0));
        assert_eq!(run_(&["serve"], home.clone()), None);
        for asked in [
            &["install"][..],
            &["update"],
            &["install", "--dry-run", "--yes"],
            &["status"],
        ] {
            assert_eq!(run_(asked, home.clone()), Some(2), "{asked:?}");
        }
        assert_eq!(run_(&["install", "--dry-run"], None), Some(1));
        assert!(ONLY.ends_with("works on Linux so far."));
    }

    #[test]
    fn parts_are_checked_before_anything_is_downloaded() {
        let dir = temp("seam");
        for resources in [
            None,
            Some("parts".into()),
            Some(dir.clone().into_os_string()),
        ] {
            let e = with_parts(resources, |_| panic!("it went on without its parts")).unwrap_err();
            assert_eq!(e.check, "parts");
            assert!(e.why.contains("build-parts-linux.sh"), "{}", e.why);
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_build_without_its_launcher_prefs_or_extension_is_refused() {
        let build = temp("made");
        let launcher = build.join("polycarp-browser");
        let extension = build.join("polycarp/extension");
        fs::create_dir_all(&extension).unwrap();
        let why = || made(&build, &launcher).map_err(|e| (e.check, e.why));
        let no = |why: &str| Err(("build", why.to_string()));
        assert_eq!(why(), no("the launcher is missing"));
        fs::write(&launcher, "a launcher").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |m| fs::set_permissions(&launcher, fs::Permissions::from_mode(m)).unwrap();
            mode(0o644);
            assert_eq!(why(), no("the launcher can't run"));
            mode(0o755);
        }
        assert_eq!(why(), no("initial_preferences is not Polycarp's"));
        fs::write(build.join("initial_preferences"), "{}").unwrap();
        assert_eq!(why(), no("initial_preferences is not Polycarp's"));
        fs::write(build.join("initial_preferences"), portable::PREFS).unwrap();
        assert_eq!(why(), no("the built-in extension is missing"));
        fs::write(extension.join("manifest.json"), "{}").unwrap();
        assert_eq!(why(), no("the built-in extension is missing"));
        fs::write(extension.join("builtin.txt"), "Polycarp Browser\n").unwrap();
        assert_eq!(why(), Ok(()));
        fs::remove_dir_all(&build).unwrap();
    }

    #[test]
    fn a_sandbox_ubuntu_s_apparmor_stops_is_refused_before_anything_runs() {
        let dir = temp("userns");
        let switch = dir.join("apparmor_restrict_unprivileged_userns");
        assert_eq!(sandbox_allowed(&switch), Ok(()), "no such switch");
        for (text, allowed) in [("0\n", true), ("1\n", false), ("1", false), ("", true)] {
            fs::write(&switch, text).unwrap();
            let got = sandbox_allowed(&switch);
            assert_eq!(got.is_ok(), allowed, "{text:?}");
            if let Err(e) = got {
                assert_eq!(e.check, "sandbox");
                assert!(e
                    .why
                    .starts_with("Ubuntu's AppArmor stops unprivileged user namespaces"));
                assert!(e.why.contains("Polycarp never turns the sandbox off."));
                assert!(e
                    .why
                    .contains("`sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`"));
            }
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_start_must_finish_in_time_and_a_missing_sandbox_is_named() {
        let ran = |out: &str, err: &str, timed_out| Ran {
            out: out.into(),
            err: err.into(),
            timed_out,
        };
        let limit = std::time::Duration::from_secs(180);
        let page = format!("<html>{}</html>", portable::PAGE);
        assert_eq!(judge_start(&ran(&page, "", false), limit), Ok(()));
        let why = |r: Ran| judge_start(&r, limit).map_err(|e| (e.check, e.why));
        let sandbox =
            "[1:1:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! Update your kernel";
        assert_eq!(why(ran("", sandbox, false)).unwrap_err().0, "sandbox");
        assert_eq!(why(ran("", sandbox, true)).unwrap_err().0, "sandbox");
        assert_eq!(
            why(ran(&page, "first\nstill going\n", true)),
            Err((
                "start",
                "it did not finish within 180 s (still going)".into()
            ))
        );
        assert_eq!(
            why(ran("", "", true)),
            Err(("start", "it did not finish within 180 s (no output)".into()))
        );
        assert_eq!(
            why(ran("", "ERROR: no GPU\n", false)),
            Err(("start", "it showed nothing (ERROR: no GPU)".into()))
        );
    }

    /// A fake start, `/bin/sh` reading a script from a temp folder.
    #[cfg(unix)]
    fn fake(name: &str, script: &str) -> (PathBuf, portable::Start) {
        let dir = temp(name);
        fs::write(dir.join("start.sh"), script).unwrap();
        let start = portable::Start {
            program: PathBuf::from("/bin/sh"),
            args: vec![dir.join("start.sh").into()],
            env: Vec::new(),
            unset: &[],
        };
        (dir, start)
    }

    /// A helper left behind holding stdout ends with the start's process group, so the pipes close at once.
    #[cfg(unix)]
    #[test]
    fn a_helper_holding_the_pipes_does_not_hold_the_start() {
        let (dir, start) = fake("hold", "sleep 60 &\necho shown\necho said >&2\nexit 0\n");
        let began = std::time::Instant::now();
        let ran = run_for(&start, std::time::Duration::from_secs(20)).unwrap();
        assert!(
            began.elapsed() < std::time::Duration::from_secs(5),
            "{:?}",
            began.elapsed()
        );
        assert_eq!(
            (ran.out.as_str(), ran.err.as_str(), ran.timed_out),
            ("shown\n", "said\n", false)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// A start that runs past its limit is killed with its group and refused with its last line.
    #[cfg(unix)]
    #[test]
    fn a_start_past_its_limit_is_killed_and_refused() {
        let (dir, start) = fake("slow", "echo waiting >&2\nsleep 60\n");
        let began = std::time::Instant::now();
        let limit = std::time::Duration::from_secs(1);
        let ran = run_for(&start, limit).unwrap();
        assert!(
            began.elapsed() < std::time::Duration::from_secs(8),
            "{:?}",
            began.elapsed()
        );
        assert!(ran.timed_out);
        let e = judge_start(&ran, limit).unwrap_err();
        assert_eq!(
            (e.check, e.why.as_str()),
            ("start", "it did not finish within 1 s (waiting)")
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// A fake `/proc`: only numbered entries whose `exe` resolves inside the build count, a deleted program included.
    #[cfg(unix)]
    #[test]
    fn only_processes_running_from_the_build_are_picked() {
        use std::os::unix::fs::symlink;
        let root = temp("proc");
        let (proc, build) = (root.join("proc"), root.join("work/build"));
        let entry = |name: &str, exe: Option<PathBuf>| {
            let at = proc.join(name);
            fs::create_dir_all(&at).unwrap();
            if let Some(exe) = exe {
                symlink(exe, at.join("exe")).unwrap();
            }
        };
        entry("101", Some(build.join("helium")));
        entry("7", Some(build.join("lib/chrome_crashpad_handler")));
        entry("202", Some(PathBuf::from("/usr/bin/bash")));
        entry("303", Some(root.join("work/build-old/helium")));
        entry("404", Some(root.join("work/home/helium")));
        entry("505", None);
        entry(
            "606",
            Some(PathBuf::from(format!(
                "{} (deleted)",
                build.join("helium").display()
            ))),
        );
        entry("self", Some(build.join("helium")));
        entry("thread-self", Some(build.join("helium")));
        entry("0", Some(build.join("helium")));
        entry("-1", Some(build.join("helium")));
        fs::write(proc.join("42"), "a file, not a process").unwrap();
        symlink(&proc, proc.join("777")).unwrap();
        assert_eq!(inside_build(&proc, &build), [7, 101, 606]);
        assert!(inside_build(&root.join("none"), &build).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    /// The real release, downloaded into a temp cache: it passes, is built from the parts CI made and started once
    /// headless, showing Polycarp's new tab, its text says Polycarp Browser, and a copy of the tarball with one
    /// changed byte is refused at the signature check, before anything is unpacked.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn the_real_release_passes_and_a_changed_tarball_is_refused() {
        let cache = temp("live");
        let dir = cache.join("browser");
        let parts =
            portable::parts(std::env::var_os(portable::RESOURCES), &portable::LINUX).unwrap();
        let line = system::dry_run(&dir, &parts).unwrap();
        let n = line
            .split("from its ")
            .nth(1)
            .and_then(|r| r.split(' ').next())
            .and_then(|n| n.parse::<usize>().ok());
        assert!(n.is_some_and(|n| n >= 200), "{line}");
        assert!(
            line.contains("started once without a window, showing its own new tab"),
            "{line}"
        );
        assert!(!dir.join("work").exists(), "the unpacked copy was kept");
        assert!(!dir.join("gnupg").exists(), "the keyring folder was kept");
        let got = system::download(&dir).unwrap();
        let work = cache.join("work");
        fs::create_dir(&work).unwrap();
        let (folder, _) = system::unpack(&got.tarball, &work, &got.release, got.arch).unwrap();
        system::built(&folder, &work, &parts).unwrap();
        let english = fs::read(work.join("build/locales/en-US.pak")).unwrap();
        assert!(english.windows(16).any(|w| w == b"Polycarp Browser"));
        assert!(work.join("build/helium-wrapper").is_file());
        fs::remove_dir_all(&work).unwrap();
        let changed = cache.join("changed");
        fs::create_dir(&changed).unwrap();
        let mut bytes = fs::read(&got.tarball).unwrap();
        let middle = bytes.len() / 2;
        bytes[middle] ^= 0xff;
        let copy = changed.join(&got.release.name);
        fs::write(&copy, bytes).unwrap();
        let e = system::signature(&changed, &copy, &got.asc).unwrap_err();
        assert_eq!(e.check, "signature", "{}", e.why);
        assert!(
            !changed.join("gnupg").exists(),
            "the keyring folder was kept"
        );
        fs::remove_dir_all(&cache).unwrap();
    }
}
