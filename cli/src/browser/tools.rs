//! The macOS tools the browser command runs. Nothing runs through a shell: each call is an absolute path and a list
//! of arguments, with a small fixed environment and a time limit.

use std::ffi::{OsStr, OsString};
use std::io::{self, Read};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::Refused;

pub struct Call {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub limit: Duration,
    /// A throwaway home for what is run, instead of the person's.
    pub home: Option<PathBuf>,
    /// Tidying up after a step, such as letting go of a disk image: it runs even after Ctrl-C.
    pub cleanup: bool,
}

impl Call {
    pub fn new(program: &str, args: &[&dyn AsRef<OsStr>]) -> Call {
        Call {
            program: program.into(),
            args: args.iter().map(|a| a.as_ref().to_owned()).collect(),
            limit: Duration::from_secs(600),
            home: None,
            cleanup: false,
        }
    }

    pub fn cleanup(mut self) -> Call {
        self.cleanup = true;
        self
    }
}

#[derive(Debug, Default)]
pub struct Ran {
    pub code: Option<i32>,
    pub out: String,
    pub err: String,
}

impl Ran {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// The last thing it said, for a message.
    pub fn last_line(&self) -> String {
        let mut lines = self.out.lines().chain(self.err.lines()).map(str::trim);
        let last = lines.rfind(|l| !l.is_empty());
        last.map_or(format!("exit {:?}", self.code), str::to_string)
    }
}

pub trait Tools {
    fn run(&self, call: &Call) -> io::Result<Ran>;
}

/// Runs a tool, which must succeed. One that can't start, or takes too long, is a refusal at `check`.
pub fn must(tools: &dyn Tools, check: &'static str, call: &Call) -> Result<Ran, Refused> {
    let ran = tools.run(call).map_err(|e| {
        if e.kind() == io::ErrorKind::Interrupted {
            return Refused::new(super::progress::STOPPED, check);
        }
        let name = call.program.display();
        Refused::new(check, format!("{name} could not run: {e}"))
    })?;
    if !ran.ok() {
        return Err(Refused::new(check, ran.last_line()));
    }
    Ok(ran)
}

/// The real ones.
pub struct System;

impl Tools for System {
    fn run(&self, call: &Call) -> io::Result<Ran> {
        let mut command = Command::new(&call.program);
        command.args(&call.args).env_clear();
        command.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        for key in ["HOME", "TMPDIR", "USER"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        if let Some(home) = &call.home {
            // macOS's own calls for the home folder read CFFIXED_USER_HOME and ignore HOME.
            for key in ["HOME", "CFFIXED_USER_HOME", "TMPDIR"] {
                command.env(key, home);
            }
        }
        command.stdin(Stdio::null()).stdout(Stdio::piped());
        command.stderr(Stdio::piped()).process_group(0);
        let mut child = command.spawn()?;
        let group = child.id() as i32;
        let out = drain(child.stdout.take());
        let err = drain(child.stderr.take());
        let end = Instant::now() + call.limit;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if stops(
                call,
                super::progress::STOP.load(std::sync::atomic::Ordering::SeqCst),
            ) {
                // Ctrl-C: what it was doing is left half done in the work folder, never in the app's place.
                unsafe { libc::kill(-group, libc::SIGKILL) };
                child.wait()?;
                return Err(io::ErrorKind::Interrupted.into());
            }
            if Instant::now() > end {
                // Its own group, so nothing it started outlives it.
                unsafe { libc::kill(-group, libc::SIGKILL) };
                child.wait()?;
                let name = call.program.display();
                let message = format!("{name} took longer than {}s", call.limit.as_secs());
                return Err(io::Error::new(io::ErrorKind::TimedOut, message));
            }
            thread::sleep(Duration::from_millis(20));
        };
        Ok(Ran {
            code: status.code(),
            out: out.join().unwrap_or_default(),
            err: err.join().unwrap_or_default(),
        })
    }
}

/// After Ctrl-C every call stops but one that tidies up.
fn stops(call: &Call, pressed: bool) -> bool {
    pressed && !call.cleanup
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn after_ctrl_c_only_tidying_up_still_runs() {
        let detach = Call::new("/usr/bin/hdiutil", &[&"detach"]).cleanup();
        let attach = Call::new("/usr/bin/hdiutil", &[&"attach"]);
        assert!(!stops(&detach, true) && stops(&attach, true));
        assert!(!stops(&attach, false));
    }

    #[test]
    fn a_tool_that_hangs_is_stopped_and_is_an_error() {
        let mut call = Call::new("/bin/sleep", &[&"30"]);
        call.limit = Duration::from_millis(100);
        let began = Instant::now();
        let e = System.run(&call).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::TimedOut);
        assert!(began.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn a_throwaway_home_replaces_every_way_to_the_real_one() {
        let mut call = Call::new("/usr/bin/env", &[]);
        call.home = Some("/throwaway".into());
        let out = System.run(&call).unwrap().out;
        for key in ["HOME", "CFFIXED_USER_HOME", "TMPDIR"] {
            let line = format!("{key}=/throwaway\n");
            assert!(out.contains(&line), "{out}");
        }
    }

    #[test]
    fn output_and_the_exit_code_come_back() {
        let ran = System.run(&Call::new("/bin/echo", &[&"a b"])).unwrap();
        assert_eq!((ran.ok(), ran.out.as_str()), (true, "a b\n"));
        assert!(!System.run(&Call::new("/usr/bin/false", &[])).unwrap().ok());
        assert!(System.run(&Call::new("/nowhere/tool", &[])).is_err());
    }
}
