//! Upgrading from a Polycarp that carried the browser helper. That helper installed launchd jobs (remote access,
//! the hub, the link, the Cloudflare tunnel). The browser extension was removed from Polycarp, and two kinds of job
//! are left behind:
//!
//! - The remote connector's jobs (`com.polycarp.serve`, `.cloudflared`, `.hub`, `.link`) may still be live: their
//!   launcher can exec a working tree outside the app, so they keep serving a claude.ai connector after the update.
//!   Each is left running, and one line says so, unless the Polycarp program it runs (itself, or what its link or
//!   launcher leads to) is no longer on disk, as the helper inside a replaced Polycarp.app is not: launchd could only
//!   restart it forever. It is retired then, and one line says the connector is off.
//! - Any other of the helper's labels (`com.polycarp.browser`, `com.tabkyra.*`) is retired only when its program is
//!   inside Polycarp.app or a folder this move removed, since that program is gone and launchd would restart it forever.
//!
//! Every other label, `com.baney.polycarp` (the app) among them, `~/.config/polycarp/browser/` and `~/.config/tabkyra/`
//! are never touched. `install-app.sh` runs this through `polycarp update --retire-old-browser` on
//! every install: the install script, `make install`, the app's updater and the first launch of a dragged-in copy.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The labels the old helper gave its launchd jobs (`browser/cli/src/service.ts` and `cloudflare.ts` before the
/// move). `com.polycarp.browser` was its native messaging host name; it is listed in case a job ever used it.
pub const LABELS: [&str; 5] = [
    "com.polycarp.serve",
    "com.polycarp.hub",
    "com.polycarp.link",
    "com.polycarp.cloudflared",
    "com.polycarp.browser",
];
/// The helper's labels from before it was renamed: `com.tabkyra.serve`, `.hub`, `.link`.
const LEGACY_PREFIX: &str = "com.tabkyra.";
/// The remote connector's jobs: each stays while the program it runs is still on disk.
const CONNECTOR: [&str; 4] = [
    "com.polycarp.serve",
    "com.polycarp.cloudflared",
    "com.polycarp.hub",
    "com.polycarp.link",
];
/// Printed once when a connector job's program is gone.
pub const CONNECTOR_OFF: &str =
    "Your remote connector ran on the browser helper that left Polycarp, so it is off now.";
/// Printed once when a connector job is left running.
pub const CONNECTOR_STAYS: &str =
    "Your remote connector still runs on the old browser helper, outside Polycarp, so its jobs were left running; to stop one, run `launchctl bootout gui/$(id -u)/<label>` and delete its plist from ~/Library/LaunchAgents.";

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Booted out and its plist removed.
    Retired { program: String },
    /// Not Polycarp's, or not readable: left exactly as it was.
    Kept { why: String },
    /// Polycarp's, but launchd still lists it after the bootout, so its plist stays.
    Failed { why: String },
    /// A remote connector job whose program is still on disk: left running.
    Waiting,
    /// A remote connector job whose program left with the helper: booted out and its plist removed, so launchd stops
    /// restarting a program that is gone.
    Stranded { program: String },
}

#[derive(Debug, PartialEq)]
pub struct Job {
    pub label: String,
    pub plist: PathBuf,
    pub verdict: Verdict,
}

/// Every job in `home`/Library/LaunchAgents under one of the old helper's labels, retired or left alone.
/// `launchctl` is the program run for `bootout` and `print`; `uid` names the `gui/<uid>` domain.
/// Only plists directly in that folder count: one moved to a folder inside it (`retired-tabkyra/`) stays where it is.
/// Nothing under `~/.config/polycarp/browser/` or `~/.config/tabkyra/` is ever deleted.
pub fn retire(home: &Path, uid: &str, launchctl: &Path) -> Vec<Job> {
    let dir = home.join("Library/LaunchAgents");
    let mut plists: Vec<PathBuf> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == "plist"))
        .filter(|p| is_old_helpers(&label_of(p)))
        .collect();
    plists.sort();
    plists
        .into_iter()
        .map(|plist| {
            let label = label_of(&plist);
            let verdict = if is_connector(&label) {
                strand(home, uid, launchctl, &label, &plist)
            } else {
                judge(home, uid, launchctl, &label, &plist)
            };
            Job {
                label,
                plist,
                verdict,
            }
        })
        .collect()
}

/// One of the old helper's labels.
fn is_old_helpers(label: &str) -> bool {
    LABELS.contains(&label) || label.starts_with(LEGACY_PREFIX)
}

/// A remote connector job, which stays while its program does; every other label goes by `judge`.
fn is_connector(label: &str) -> bool {
    CONNECTOR.contains(&label)
}

fn label_of(plist: &Path) -> String {
    plist
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// A connector job: retired when the Polycarp program it runs is gone from disk, else left waiting. A helper still in `~/.local/share/polycarp/browser` serves the connector, so that job waits.
fn strand(home: &Path, uid: &str, launchctl: &Path, label: &str, plist: &Path) -> Verdict {
    match fs::read_to_string(plist).ok().and_then(|t| program_of(&t)) {
        Some(program) if gone(home, &program) => stop(uid, launchctl, label, plist)
            .map_or_else(|f| f, |()| Verdict::Stranded { program }),
        _ => Verdict::Waiting,
    }
}

/// The Polycarp places `program` runs from: itself, the end of its link chain, and the quoted paths on a launcher's
/// exec lines (a launcher reached through links too), kept only where `inside` says Polycarp put them.
fn polycarp_targets(home: &Path, program: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut at = PathBuf::from(program);
    for _ in 0..8 {
        if inside(home, &at.to_string_lossy()) {
            out.push(at.clone());
        }
        match fs::read_link(&at) {
            Ok(next) => at = at.parent().map_or(next.clone(), |d| d.join(&next)),
            Err(_) => break,
        }
    }
    if let Ok(script) = fs::read_to_string(&at) {
        let words = script
            .lines()
            .filter(|l| l.trim_start().starts_with("exec "))
            .flat_map(|l| {
                l.split('"')
                    .skip(1)
                    .step_by(2)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            });
        out.extend(words.filter(|w| inside(home, w)).map(PathBuf::from));
    }
    out
}

/// Polycarp's program behind `program` is no longer on disk, so launchd could only restart it forever.
fn gone(home: &Path, program: &str) -> bool {
    let targets = polycarp_targets(home, program);
    !targets.is_empty() && targets.iter().all(|t| !t.exists())
}

fn judge(home: &Path, uid: &str, launchctl: &Path, label: &str, plist: &Path) -> Verdict {
    let Some(program) = fs::read_to_string(plist).ok().and_then(|t| program_of(&t)) else {
        return Verdict::Kept {
            why: "its program could not be read from the plist".to_string(),
        };
    };
    if !polycarps(home, &program) {
        return Verdict::Kept {
            why: format!("it runs {program}, which Polycarp did not install"),
        };
    }
    if !gone(home, &program) {
        return Verdict::Kept {
            why: format!("it runs {program}, which is still on disk"),
        };
    }
    stop(uid, launchctl, label, plist).map_or_else(|f| f, |()| Verdict::Retired { program })
}

/// Boot the job out and remove its plist. A job launchd no longer has (already booted out) only loses its plist.
/// The error is the `Failed` verdict.
fn stop(uid: &str, launchctl: &Path, label: &str, plist: &Path) -> Result<(), Verdict> {
    let target = format!("gui/{uid}/{label}");
    let booted = run(launchctl, &["bootout", &target]);
    // bootout also fails for a job that was never loaded; that one is already stopped.
    if booted != Some(0) && run(launchctl, &["print", &target]) == Some(0) {
        return Err(Verdict::Failed {
            why: format!("launchctl bootout {target} did not stop it, so its plist stays"),
        });
    }
    fs::remove_file(plist).map_err(|e| Verdict::Failed {
        why: format!(
            "it was stopped, but {} could not be removed: {e}",
            plist.display()
        ),
    })
}

fn run(program: &Path, args: &[&str]) -> Option<i32> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .and_then(|s| s.code())
}

/// The first of `ProgramArguments`, else `Program`, from a plist in XML form (the form the helper wrote).
fn program_of(text: &str) -> Option<String> {
    let after = |key: &str| text.find(key).map(|i| &text[i + key.len()..]);
    let first_string = |rest: &str| -> Option<String> {
        let start = rest.find("<string>")? + "<string>".len();
        let end = rest[start..].find("</string>")?;
        Some(unescape(&rest[start..start + end]))
    };
    if let Some(rest) = after("<key>ProgramArguments</key>") {
        let array = rest.trim_start().strip_prefix("<array>")?;
        return first_string(array).filter(|p| !p.is_empty());
    }
    after("<key>Program</key>")
        .and_then(first_string)
        .filter(|p| !p.is_empty())
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Whether `program` is Polycarp's own: inside a Polycarp.app, in the folder only Polycarp put the helper in, or a
/// launcher or link in the helper's folders that leads to one of those. A launcher that execs anything else (node on a
/// working tree, another app) or is gone is not.
fn polycarps(home: &Path, program: &str) -> bool {
    if inside(home, program) {
        return true;
    }
    let path = Path::new(program);
    if let Ok(target) = fs::read_link(path) {
        return inside(home, &target.to_string_lossy());
    }
    let launchers = [
        home.join(".config/polycarp/browser"),
        home.join(".config/tabkyra"),
    ];
    if !launchers.iter().any(|d| path.starts_with(d)) {
        return false;
    }
    match fs::read_to_string(path) {
        // `exec "<helper>" <args>"$@"`, or `exec "<node>" "<script>" ...`: any quoted path on an exec line.
        Ok(script) => script
            .lines()
            .filter(|l| l.trim_start().starts_with("exec "))
            .flat_map(|l| l.split('"').skip(1).step_by(2))
            .any(|word| inside(home, word)),
        Err(_) => false,
    }
}

fn inside(home: &Path, program: &str) -> bool {
    program.contains("/Polycarp.app/Contents/")
        || Path::new(program).starts_with(home.join(".local/share/polycarp/browser"))
}

/// `polycarp update --retire-old-browser`: one line per job, exit 0 unless a job of Polycarp's could not be stopped.
pub fn command(home: &Path) -> i32 {
    let launchctl = std::env::var_os("POLYCARP_LAUNCHCTL")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/launchctl"));
    let uid = Command::new("/usr/bin/id")
        .arg("-u")
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|u| !u.is_empty() && u.bytes().all(|b| b.is_ascii_digit()));
    let Some(uid) = uid else {
        eprintln!(
            "polycarp update: could not read this user's id, so no old browser job was touched."
        );
        return 1;
    };
    let mut failed = false;
    let mut waiting = false;
    let mut off = false;
    for job in retire(home, &uid, &launchctl) {
        match job.verdict {
            Verdict::Retired { program } => println!(
                "retired {}: it ran {program}, which left Polycarp with the browser extension",
                job.label
            ),
            Verdict::Waiting => waiting = true,
            Verdict::Stranded { program } => {
                off = true;
                println!(
                    "retired {}: it ran {program}, which left Polycarp with the browser extension",
                    job.label
                );
            }
            Verdict::Kept { why } => println!("left {} alone: {why}", job.label),
            Verdict::Failed { why } => {
                failed = true;
                eprintln!("polycarp update: {}: {why}", job.label);
            }
        }
    }
    // A connector with any job retired here is off, even while another of its jobs waits.
    if off {
        println!("{CONNECTOR_OFF}");
    } else if waiting {
        println!("{CONNECTOR_STAYS}");
    }
    i32::from(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/d";

    fn plist(program: &str) -> String {
        format!(
            "<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n<dict>\n\t<key>Label</key>\n\t<string>x</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>{program}</string>\n\t\t<string>serve</string>\n\t</array>\n</dict>\n</plist>\n"
        )
    }

    #[test]
    fn the_program_is_the_first_argument() {
        assert_eq!(
            program_of(&plist("/a &amp; b/polycarp")).as_deref(),
            Some("/a & b/polycarp")
        );
        assert_eq!(
            program_of("<key>Program</key><string>/bin/x</string>").as_deref(),
            Some("/bin/x")
        );
        assert_eq!(program_of("<plist></plist>"), None);
    }

    #[test]
    fn other_labels_are_never_the_old_helpers() {
        assert!(is_old_helpers("com.polycarp.serve"));
        assert!(is_old_helpers("com.tabkyra.hub"));
        assert!(!is_old_helpers("com.example.serve"));
        assert!(!is_old_helpers("com.example.hub"));
        assert!(!is_old_helpers("com.example.thing"));
        assert!(!is_old_helpers("com.baney.polycarp"));
    }

    #[test]
    fn only_the_four_connector_labels_are_connector_jobs() {
        for label in [
            "com.polycarp.serve",
            "com.polycarp.cloudflared",
            "com.polycarp.hub",
            "com.polycarp.link",
        ] {
            assert!(is_connector(label), "{label}");
        }
        assert!(!is_connector("com.polycarp.browser"));
        assert!(!is_connector("com.tabkyra.serve"));
    }

    /// A connector job whose program was inside Polycarp.app is retired, since that program is gone; one whose
    /// program is elsewhere (Homebrew's cloudflared) keeps waiting, plist and all.
    #[cfg(unix)]
    #[test]
    fn a_connector_job_whose_program_left_with_the_app_is_retired() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("retire-strand-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let agents = root.join("home/Library/LaunchAgents");
        fs::create_dir_all(&agents).unwrap();
        let home = root.join("home");
        let log = root.join("launchctl.log");
        let launchctl = root.join("launchctl");
        // Nothing is loaded: `print` exits 113, `bootout` 0.
        fs::write(
            &launchctl,
            format!(
                "#!/bin/sh\necho \"$*\" >> {}\ncase \"$1\" in print) exit 113;; esac\nexit 0\n",
                log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&launchctl, fs::Permissions::from_mode(0o755)).unwrap();
        let serve = agents.join("com.polycarp.serve.plist");
        let tunnel = agents.join("com.polycarp.cloudflared.plist");
        let in_app = "/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser";
        fs::write(&serve, plist(in_app)).unwrap();
        fs::write(&tunnel, plist("/opt/homebrew/bin/cloudflared")).unwrap();

        let jobs = retire(&home, "501", &launchctl);
        let verdict = |label: &str| &jobs.iter().find(|j| j.label == label).unwrap().verdict;
        assert_eq!(
            verdict("com.polycarp.serve"),
            &Verdict::Stranded {
                program: in_app.to_string()
            }
        );
        assert!(!serve.exists(), "the stranded job's plist is removed");
        assert_eq!(verdict("com.polycarp.cloudflared"), &Verdict::Waiting);
        assert!(
            tunnel.exists(),
            "a job whose program is elsewhere keeps its plist"
        );
        let calls = fs::read_to_string(&log).unwrap();
        assert!(
            calls.contains("bootout gui/501/com.polycarp.serve"),
            "{calls}"
        );
        assert!(
            !calls.contains("bootout gui/501/com.polycarp.cloudflared"),
            "{calls}"
        );

        // A helper still in ~/.local/share/polycarp/browser serves the connector: that job waits, plist and all.
        let live = home.join(".local/share/polycarp/browser/source/cli/dist/index.js");
        fs::create_dir_all(live.parent().unwrap()).unwrap();
        fs::write(&live, "").unwrap();
        fs::write(&serve, plist(&live.to_string_lossy())).unwrap();
        // A launcher reached through a link that execs the helper of a replaced app is gone with it.
        let launchers = home.join(".config/tabkyra");
        fs::create_dir_all(&launchers).unwrap();
        fs::write(
            launchers.join("polycarp"),
            format!("#!/bin/sh\nexec \"{in_app}\" serve \"$@\"\n"),
        )
        .unwrap();
        std::os::unix::fs::symlink(launchers.join("polycarp"), launchers.join("tabkyra")).unwrap();
        let hub = agents.join("com.polycarp.hub.plist");
        fs::write(&hub, plist(&launchers.join("tabkyra").to_string_lossy())).unwrap();
        let jobs = retire(&home, "501", &launchctl);
        let verdict = |label: &str| &jobs.iter().find(|j| j.label == label).unwrap().verdict;
        assert_eq!(verdict("com.polycarp.serve"), &Verdict::Waiting);
        assert!(serve.exists(), "a live helper's job keeps its plist");
        assert!(matches!(
            verdict("com.polycarp.hub"),
            Verdict::Stranded { .. }
        ));
        assert!(!hub.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn only_polycarps_own_places_count() {
        let home = Path::new(HOME);
        assert!(polycarps(
            home,
            "/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser"
        ));
        assert!(polycarps(
            home,
            "/Users/d/Applications/Polycarp.app/Contents/Resources/bin/polycarp"
        ));
        assert!(polycarps(
            home,
            "/Users/d/.local/share/polycarp/browser/source/cli/dist/index.js"
        ));
        // Gone from the helper's launcher folder: not shown to point anywhere Polycarp removed.
        assert!(!polycarps(home, "/Users/d/.config/tabkyra/tabkyra"));
        assert!(!polycarps(
            home,
            "/Users/d/.local/share/other/release/other"
        ));
        assert!(!polycarps(
            home,
            "/Applications/Other.app/Contents/MacOS/other"
        ));
        assert!(!polycarps(home, "/opt/homebrew/bin/cloudflared"));
    }
}
