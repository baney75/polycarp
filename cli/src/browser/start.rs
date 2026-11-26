//! The last check before a build is used: it starts, with no window and a throwaway home and profile, and its new tab
//! is Polycarp's. One thing reaches the person's own home all the same: Chromium notes the app's path in its preferences
//! file, which macOS writes for it and no home or profile setting moves. The browser's first real start writes it again.

use std::fs;
use std::path::Path;
use std::time::Duration;

use super::change::Changes;
use super::running;
use super::tools::{Call, Ran, Tools};
use super::{clear, pages, refuse, Refused};

const CHECK: &str = "headless start";
/// Something only Polycarp's new tab page says.
const PAGE: &str = "Search or type an address";

pub fn check(tools: &dyn Tools, app: &Path, work: &Path, changes: &Changes) -> Result<(), Refused> {
    let home = work.join("home");
    clear(&home).map_err(refuse(CHECK, "clearing its home"))?;
    let data = home.join("profile");
    fs::create_dir(&home).map_err(refuse(CHECK, "making its home"))?;
    pages::first_run(&data).map_err(refuse(CHECK, "making its profile"))?;
    let program = app.join("Contents/MacOS").join(&changes.to.name);
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
    call.args.extend([profile, "chrome://newtab".into()]);
    let ran = tools.run(&call);
    // It is this build, run only here, so whatever is left of it is ours to stop.
    running::stop_inside(app);
    let cleared = clear(&home).map_err(refuse(CHECK, "clearing its home"));
    judge(&ran.map_err(refuse(CHECK, "running it"))?)?;
    cleared
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
