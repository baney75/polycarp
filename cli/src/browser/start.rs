//! The last check before a build is used: it starts, with no window and a throwaway home and profile, and its new tab
//! is Polycarp's. One thing reaches the person's own home all the same: Chromium notes the app's path in its preferences
//! file, which macOS writes for it and no home or profile setting moves. The browser's first real start writes it again.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::change::Changes;
use super::running;
use super::tools::{Call, Ran, Tools};
use super::{clear, pages, refuse, Refused};

const CHECK: &str = "headless start";
/// Something only Polycarp's new tab page says.
const PAGE: &str = "Search or type an address";

/// A new profile as this browser lays it out, with the databases it makes when it first asks for a page. It is in `work`.
pub fn empty_profile(tools: &dyn Tools, app: &Path, work: &Path) -> Result<PathBuf, Refused> {
    let name = app.file_stem().unwrap_or_default().to_string_lossy();
    // A name that never resolves: the cookie store opens, and nothing is fetched.
    let started = start(tools, app, &name, work, "http://a.invalid/");
    // A helper of its can outlive it, and would then count as the person's browser being open. The caller checked it was
    // closed, so whatever runs from inside it now is this start's.
    running::stop_inside(app);
    let (ran, home) = started?;
    let first = home.join("profile/Default");
    if first.join("History").is_file() && first.join("Cookies").is_file() {
        return Ok(first);
    }
    let why = format!("it made no new profile ({})", ran.last_line());
    Err(Refused::new(CHECK, why))
}

pub fn check(tools: &dyn Tools, app: &Path, work: &Path, changes: &Changes) -> Result<(), Refused> {
    let name = &changes.to.name;
    let ran = start(tools, app, name, work, "chrome://newtab");
    // It is this build, run only here, so whatever is left of it is ours to stop.
    running::stop_inside(app);
    let cleared = clear(&work.join("home")).map_err(refuse(CHECK, "clearing its home"));
    judge(&ran?.0)?;
    cleared
}

/// Runs it with no window, on a new profile in a home of its own.
fn start(
    tools: &dyn Tools,
    app: &Path,
    name: &str,
    work: &Path,
    address: &str,
) -> Result<(Ran, std::path::PathBuf), Refused> {
    let home = work.join("home");
    clear(&home).map_err(refuse(CHECK, "clearing its home"))?;
    let data = home.join("profile");
    fs::create_dir(&home).map_err(refuse(CHECK, "making its home"))?;
    pages::first_run(&data).map_err(refuse(CHECK, "making its profile"))?;
    let program = app.join("Contents/MacOS").join(name);
    let mut call = Call::new("", &[]);
    call.program = program;
    call.home = Some(home.clone());
    call.limit = Duration::from_secs(180);
    // A mock keychain: the real one is never asked. Nothing is fetched: no host name resolves ('@' is a space here).
    let args = "--headless --use-mock-keychain --no-first-run --disable-background-networking \
                --host-resolver-rules=MAP@*@~NOTFOUND --allow-chrome-scheme-url --timeout=20000 \
                --virtual-time-budget=4000 --dump-dom";
    for arg in args.split_whitespace() {
        call.args.push(arg.replace('@', " ").into());
    }
    let mut profile = std::ffi::OsString::from("--user-data-dir=");
    profile.push(&data);
    call.args.extend([profile, address.into()]);
    let ran = tools.run(&call).map_err(refuse(CHECK, "running it"))?;
    Ok((ran, home))
}

/// By the page it shows, not its exit code: on a busy Mac Chromium ends a good run with its own shutdown alarm.
fn judge(ran: &Ran) -> Result<(), Refused> {
    if ran.out.contains(PAGE) {
        return Ok(());
    }
    let why = if ran.out.trim().is_empty() {
        format!("it showed nothing ({})", ran.last_line())
    } else {
        "its new tab is not Polycarp's".into()
    };
    Err(Refused::new(CHECK, why))
}

#[cfg(test)]
mod tests {
    use super::super::testing::*;
    use super::*;

    fn checked(t: &Fake) -> Result<(), Refused> {
        let changes = Changes::read(&t.parts()).unwrap();
        check(t, &t.work().join("Built.app"), &t.work(), &changes)
    }

    #[test]
    fn it_must_show_polycarps_new_tab() {
        let t = Fake::new();
        checked(&t).unwrap();
        assert!(!t.work().join("home").exists());
        t.set(|s| s.page = "<title>New Tab</title>");
        let e = checked(&t).unwrap_err();
        assert_eq!(
            (e.check, e.why.as_str()),
            (CHECK, "its new tab is not Polycarp's")
        );
        t.set(|s| s.page = "");
        assert_eq!(checked(&t).unwrap_err().check, CHECK);
        for failure in [Failure::SaysNo, Failure::CannotRun] {
            t.set(|s| s.fail = Some(("Polycarp Browser", "--headless", failure)));
            assert_eq!(checked(&t).unwrap_err().check, CHECK);
            assert!(!t.work().join("home").exists());
        }
    }

    /// Nothing of the person's: no window, no keychain, no network, and a home and profile in the work folder.
    #[test]
    fn it_runs_away_from_everything_of_the_persons() {
        let t = Fake::new();
        checked(&t).unwrap();
        let line = t.calls().pop().unwrap();
        let work = t.work();
        let profile = format!("--user-data-dir={}/home/profile", work.display());
        let home = format!("home={}/home", work.display());
        for part in [
            "--headless ",
            "--use-mock-keychain ",
            "--host-resolver-rules=MAP * ~NOTFOUND ",
            &profile,
            &home,
        ] {
            assert!(line.contains(part), "{part}: {line}");
        }
        assert!(!line.contains("remote-debugging"));
    }
}
