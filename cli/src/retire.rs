//! Upgrading from a Polycarp that carried the browser helper. That helper installed launchd jobs (remote access,
//! the hub, the link, the Cloudflare tunnel). The browser moved to Tychicus, and two kinds of job are left behind:
//!
//! - The remote connector's jobs (`com.polycarp.serve`, `.cloudflared`, `.hub`, `.link`) may still be live: their
//!   launcher can exec a working tree outside the app, so they keep serving a claude.ai connector after the update.
//!   Each is retired only once Tychicus runs its counterpart (`com.tychicus.serve` for serve and cloudflared,
//!   `com.tychicus.hub`, `com.tychicus.link`) and `~/.config/tychicus/remote.json` exists. Until then it is left running
//!   and one line says how to move it.
//! - Any other of the helper's labels (`com.polycarp.browser`, `com.tabkyra.*`) is retired only when its program is
//!   inside Polycarp.app or a folder this move removed, since that program is gone and launchd would restart it forever.
//!
//! `com.tychicus.*` jobs (only asked whether they are loaded), `com.baney.polycarp` (the app), `~/.config/polycarp/browser/`
//! and `~/.config/tabkyra/` are never touched. `install-app.sh` runs this through `polycarp update --retire-old-browser` on
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
/// Tychicus's own labels. Never booted out or removed, whatever their program is; only asked whether they are loaded.
const TYCHICUS_PREFIX: &str = "com.tychicus.";
/// The remote connector's jobs, and the Tychicus job that must be running before each one goes.
const GATED: [(&str, &str); 4] = [
    ("com.polycarp.serve", "com.tychicus.serve"),
    ("com.polycarp.cloudflared", "com.tychicus.serve"),
    ("com.polycarp.hub", "com.tychicus.hub"),
    ("com.polycarp.link", "com.tychicus.link"),
];
/// Tychicus writes this once it has taken the remote connector over.
const TYCHICUS_REMOTE: &str = ".config/tychicus/remote.json";
/// Printed once when a connector job waits for Tychicus.
pub const CONNECTOR_STAYS: &str = "Your remote connector still runs on Polycarp's helper; run `tychicus remote import-polycarp` to move it to Tychicus.";

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Booted out and its plist removed.
    Retired { program: String },
    /// Not Polycarp's, or not readable: left exactly as it was.
    Kept { why: String },
    /// Polycarp's, but launchd still lists it after the bootout, so its plist stays.
    Failed { why: String },
    /// A remote connector job Tychicus runs now: booted out and its plist removed.
    HandedOver,
    /// A remote connector job left running until Tychicus runs its counterpart.
    Waiting,
}

#[derive(Debug, PartialEq)]
pub struct Job {
    pub label: String,
    pub plist: PathBuf,
    pub verdict: Verdict,
}

/// Every job in `home`/Library/LaunchAgents under one of the old helper's labels, retired or left alone.
/// `launchctl` is the program run for `bootout` and `print`; `uid` names the `gui/<uid>` domain.
/// Only plists directly in that folder count: one Tychicus moved to a folder inside it (`retired-tabkyra/`) stays where it
/// is. Nothing under `~/.config/polycarp/browser/` or `~/.config/tabkyra/` is ever deleted, since Tychicus migrates its
/// settings from there.
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
            let verdict = match gate_of(&label) {
                Some(tychicus) if tychicus_runs(home, uid, launchctl, tychicus) => {
                    stop(uid, launchctl, &label, &plist)
                        .map_or_else(|f| f, |()| Verdict::HandedOver)
                }
                Some(_) => Verdict::Waiting,
                None => judge(home, uid, launchctl, &label, &plist),
            };
            Job {
                label,
                plist,
                verdict,
            }
        })
        .collect()
}

/// One of the old helper's labels, and never one of Tychicus's.
fn is_old_helpers(label: &str) -> bool {
    !label.starts_with(TYCHICUS_PREFIX)
        && (LABELS.contains(&label) || label.starts_with(LEGACY_PREFIX))
}

/// The Tychicus job a remote connector job waits for, or None for a label that goes by its program.
fn gate_of(label: &str) -> Option<&'static str> {
    GATED.iter().find(|(l, _)| *l == label).map(|(_, t)| *t)
}

/// Tychicus has taken the connector over: its job is loaded and its remote settings exist.
fn tychicus_runs(home: &Path, uid: &str, launchctl: &Path, tychicus: &str) -> bool {
    home.join(TYCHICUS_REMOTE).is_file()
        && run(launchctl, &["print", &format!("gui/{uid}/{tychicus}")]) == Some(0)
}

fn label_of(plist: &Path) -> String {
    plist
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
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
/// working tree, Tychicus) or is gone is not.
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
    for job in retire(home, &uid, &launchctl) {
        match job.verdict {
            Verdict::Retired { program } => println!(
                "retired {}: it ran {program}, which left Polycarp with the browser (now Tychicus)",
                job.label
            ),
            Verdict::HandedOver => println!(
                "retired {}: Tychicus runs the remote connector now",
                job.label
            ),
            Verdict::Waiting => waiting = true,
            Verdict::Kept { why } => println!("left {} alone: {why}", job.label),
            Verdict::Failed { why } => {
                failed = true;
                eprintln!("polycarp update: {}: {why}", job.label);
            }
        }
    }
    if waiting {
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
    fn tychicus_labels_are_never_the_old_helpers() {
        assert!(is_old_helpers("com.polycarp.serve"));
        assert!(is_old_helpers("com.tabkyra.hub"));
        assert!(!is_old_helpers("com.tychicus.serve"));
        assert!(!is_old_helpers("com.tychicus.hub"));
        assert!(!is_old_helpers("com.example.thing"));
        assert!(!is_old_helpers("com.baney.polycarp"));
    }

    #[test]
    fn the_connector_jobs_wait_for_their_tychicus_job() {
        assert_eq!(gate_of("com.polycarp.serve"), Some("com.tychicus.serve"));
        assert_eq!(
            gate_of("com.polycarp.cloudflared"),
            Some("com.tychicus.serve")
        );
        assert_eq!(gate_of("com.polycarp.hub"), Some("com.tychicus.hub"));
        assert_eq!(gate_of("com.polycarp.link"), Some("com.tychicus.link"));
        assert_eq!(gate_of("com.polycarp.browser"), None);
        assert_eq!(gate_of("com.tabkyra.serve"), None);
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
            "/Users/d/.local/share/tychicus/release/tychicus"
        ));
        assert!(!polycarps(
            home,
            "/Applications/Tychicus.app/Contents/MacOS/tychicus"
        ));
        assert!(!polycarps(home, "/opt/homebrew/bin/cloudflared"));
    }
}
