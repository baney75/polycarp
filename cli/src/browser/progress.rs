//! What `install` and `update` show while they work. In a terminal, one line redraws: a bar, the percent, bytes over
//! the total and the speed while the release downloads, then each step by name with a spinner and its time. A finished
//! step leaves one line with the time it took. Anywhere else (a pipe, a log, the app's daily run) each step is a plain
//! line and no escape code is written.

use std::io::{self, IsTerminal, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Download,
    Verify,
    Build,
    Sign,
    Check,
    SwapIn,
}

impl Step {
    pub const ALL: [Step; 6] = [
        Step::Download,
        Step::Verify,
        Step::Build,
        Step::Sign,
        Step::Check,
        Step::SwapIn,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Step::Download => "Download",
            Step::Verify => "Verify",
            Step::Build => "Build",
            Step::Sign => "Sign",
            Step::Check => "Check",
            Step::SwapIn => "Swap in",
        }
    }

    pub fn number(self) -> usize {
        Step::ALL
            .iter()
            .position(|s| *s == self)
            .map_or(0, |i| i + 1)
    }

    fn of(self) -> String {
        format!("step {} of {}", self.number(), Step::ALL.len())
    }
}

/// How far a download is: bytes so far, the whole when it is known, and bytes a second.
#[derive(Clone, Copy, Debug)]
pub struct Bytes {
    pub got: u64,
    pub total: Option<u64>,
    pub speed: u64,
}

const SPIN: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR: usize = 24;
/// Clears the line the cursor is on and goes back to its start.
const CLEAR: &str = "\r\x1b[2K";

/// The line that redraws. A total of zero is an unknown one: a spinner and bytes, no percent.
pub fn live(step: Step, bytes: Option<Bytes>, frame: usize, elapsed: Duration) -> String {
    let head = format!(
        "{} {:<8} {}",
        SPIN[frame % SPIN.len()],
        step.name(),
        step.of()
    );
    let Some(b) = bytes else {
        return format!("{head}  {}", time(elapsed));
    };
    let speed = format!("{}/s", size(b.speed));
    match b.total.filter(|t| *t > 0) {
        Some(total) => {
            let got = b.got.min(total);
            let filled = (u128::from(got) * BAR as u128 / u128::from(total)) as usize;
            let bar = format!("{}{}", "█".repeat(filled), "░".repeat(BAR - filled));
            let percent = u128::from(got) * 100 / u128::from(total);
            let (got, total) = (size(got), size(total));
            format!("{head}  {bar} {percent:>3}%  {got} of {total}  {speed}")
        }
        None => format!("{head}  {}  {speed}", size(b.got)),
    }
}

/// The line a finished step leaves in a terminal.
pub fn finished(step: Step, took: Duration, note: Option<&str>) -> String {
    let note = note.map(|n| format!(", {n}")).unwrap_or_default();
    format!("✓ {:<8} {}  {}{note}", step.name(), step.of(), time(took))
}

/// The line a step that did not finish leaves in a terminal.
pub fn failed(step: Step) -> String {
    format!("✗ {:<8} {}", step.name(), step.of())
}

/// The plain lines, for anything that is not a terminal.
pub fn plain_begin(step: Step) -> String {
    format!("{}: {}", capital(&step.of()), step.name())
}

pub fn plain_done(step: Step, took: Duration, note: Option<&str>) -> String {
    let note = note.map(|n| format!(", {n}")).unwrap_or_default();
    format!(
        "{}: {} done in {}{note}",
        capital(&step.of()),
        step.name(),
        time(took)
    )
}

fn capital(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map_or(String::new(), |c| c.to_uppercase().chain(chars).collect())
}

/// Bytes the way Finder counts them, in thousands.
pub fn size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1000 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1000.0;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

pub fn time(took: Duration) -> String {
    let seconds = took.as_secs_f64();
    if seconds < 60.0 {
        return format!("{seconds:.1}s");
    }
    let whole = took.as_secs();
    format!("{}m {:02}s", whole / 60, whole % 60)
}

struct Shared {
    out: Box<dyn Write + Send>,
    step: Option<Step>,
    began: Instant,
    bytes: Option<Bytes>,
    frame: usize,
    /// Raised on every new step, so a ticker of an older one stops.
    generation: u64,
    /// A live line is on screen.
    drawn: bool,
}

impl Shared {
    fn draw(&mut self) {
        let Some(step) = self.step else { return };
        let line = live(step, self.bytes, self.frame, self.began.elapsed());
        let _ = write!(self.out, "{CLEAR}{line}");
        let _ = self.out.flush();
        self.drawn = true;
    }

    fn say(&mut self, line: &str) {
        let clear = if self.drawn { CLEAR } else { "" };
        let _ = writeln!(self.out, "{clear}{line}");
        let _ = self.out.flush();
        self.drawn = false;
    }
}

pub struct Progress {
    shared: Arc<Mutex<Shared>>,
    tty: bool,
}

impl Progress {
    /// On stderr, so what the command prints on stdout stays one answer.
    pub fn terminal() -> Progress {
        let err = io::stderr();
        let dumb = std::env::var_os("TERM").is_some_and(|t| t == "dumb");
        let tty = err.is_terminal() && !dumb;
        Progress::to(Box::new(err), tty)
    }

    pub fn to(out: Box<dyn Write + Send>, tty: bool) -> Progress {
        let shared = Shared {
            out,
            step: None,
            began: Instant::now(),
            bytes: None,
            frame: 0,
            generation: 0,
            drawn: false,
        };
        Progress {
            shared: Arc::new(Mutex::new(shared)),
            tty,
        }
    }

    /// Says nothing: for tests and for the commands that build nothing.
    pub fn silent() -> Progress {
        Progress::to(Box::new(io::sink()), false)
    }

    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn begin(&self, step: Step) {
        let generation = {
            let mut shared = self.lock();
            shared.step = Some(step);
            shared.began = Instant::now();
            shared.bytes = None;
            shared.generation += 1;
            if !self.tty {
                shared.say(&plain_begin(step));
                return;
            }
            shared.draw();
            shared.generation
        };
        let shared = Arc::clone(&self.shared);
        // Keeps the spinner and the clock moving while a tool runs; it ends with the step.
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(100));
            let mut shared = shared.lock().unwrap_or_else(|e| e.into_inner());
            if shared.generation != generation || shared.step.is_none() {
                return;
            }
            shared.frame += 1;
            shared.draw();
        });
    }

    /// How far the download is.
    pub fn bytes(&self, got: u64, total: Option<u64>) {
        let mut shared = self.lock();
        let seconds = shared.began.elapsed().as_secs_f64();
        let speed = if seconds > 0.0 {
            (got as f64 / seconds) as u64
        } else {
            0
        };
        shared.bytes = Some(Bytes { got, total, speed });
        if self.tty && shared.step.is_some() {
            shared.draw();
        }
    }

    /// Ends the step that runs, with the time it took and a note when there is one.
    pub fn end(&self, note: Option<&str>) {
        let mut shared = self.lock();
        let Some(step) = shared.step.take() else {
            return;
        };
        shared.generation += 1;
        let took = shared.began.elapsed();
        let line = match self.tty {
            true => finished(step, took, note),
            false => plain_done(step, took, note),
        };
        shared.say(&line);
    }
}

impl Drop for Progress {
    /// A step that did not finish is marked, in a terminal, before the command says why.
    fn drop(&mut self) {
        let mut shared = self.lock();
        shared.generation += 1;
        if let Some(step) = shared.step.take() {
            if self.tty {
                shared.say(&failed(step));
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A writer the test reads back.
    #[derive(Clone, Default)]
    pub struct Screen(Arc<Mutex<Vec<u8>>>);

    /// Progress that writes to a screen a test reads.
    pub fn screen(tty: bool) -> (Screen, Progress) {
        let screen = Screen::default();
        let progress = Progress::to(Box::new(screen.clone()), tty);
        (screen, progress)
    }

    impl Write for Screen {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Screen {
        pub fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    fn mb(n: u64) -> u64 {
        n * 1_000_000
    }

    #[test]
    fn a_download_with_a_total_shows_a_bar_the_percent_bytes_over_total_and_speed() {
        let b = Bytes {
            got: mb(60),
            total: Some(mb(150)),
            speed: 12_300_000,
        };
        let line = live(Step::Download, Some(b), 0, Duration::ZERO);
        assert_eq!(
            line,
            "⠋ Download step 1 of 6  █████████░░░░░░░░░░░░░░░  40%  60.0 MB of 150.0 MB  12.3 MB/s"
        );
        let full = Bytes { got: mb(151), ..b };
        let line = live(Step::Download, Some(full), 3, Duration::ZERO);
        assert!(line.contains(&"█".repeat(BAR)), "{line}");
        assert!(line.contains("100%  150.0 MB of 150.0 MB"), "{line}");
    }

    #[test]
    fn a_zero_or_unknown_total_shows_a_spinner_and_bytes_and_no_percent() {
        for total in [None, Some(0)] {
            let b = Bytes {
                got: 4_200,
                total,
                speed: 900,
            };
            let line = live(Step::Download, Some(b), 2, Duration::ZERO);
            assert_eq!(line, "⠹ Download step 1 of 6  4.2 KB  900 B/s");
            assert!(!line.contains('%') && !line.contains('█'));
        }
    }

    #[test]
    fn every_step_is_named_and_numbered_of_six() {
        let names: Vec<String> = Step::ALL.iter().map(|s| plain_begin(*s)).collect();
        assert_eq!(
            names,
            [
                "Step 1 of 6: Download",
                "Step 2 of 6: Verify",
                "Step 3 of 6: Build",
                "Step 4 of 6: Sign",
                "Step 5 of 6: Check",
                "Step 6 of 6: Swap in",
            ]
        );
        let line = live(Step::Sign, None, 1, Duration::from_millis(3_250));
        assert_eq!(line, "⠙ Sign     step 4 of 6  3.2s");
        let took = Duration::from_secs(65);
        assert_eq!(
            finished(Step::Check, took, None),
            "✓ Check    step 5 of 6  1m 05s"
        );
        assert_eq!(
            plain_done(Step::Download, Duration::from_millis(500), Some("150.0 MB")),
            "Step 1 of 6: Download done in 0.5s, 150.0 MB"
        );
    }

    #[test]
    fn sizes_and_times_read_the_way_a_person_says_them() {
        assert_eq!(size(0), "0 B");
        assert_eq!(size(999), "999 B");
        assert_eq!(size(1_000), "1.0 KB");
        assert_eq!(size(mb(133)), "133.0 MB");
        assert_eq!(size(2_500_000_000), "2.5 GB");
        assert_eq!(time(Duration::from_millis(4_210)), "4.2s");
        assert_eq!(time(Duration::from_secs(600)), "10m 00s");
    }

    fn run_all(progress: &Progress) {
        for step in Step::ALL {
            progress.begin(step);
            if step == Step::Download {
                progress.bytes(mb(10), Some(mb(20)));
                progress.bytes(mb(20), Some(mb(20)));
            }
            progress.end(None);
        }
    }

    #[test]
    fn a_terminal_gets_one_line_that_redraws_and_a_line_per_finished_step() {
        let screen = Screen::default();
        let progress = Progress::to(Box::new(screen.clone()), true);
        run_all(&progress);
        drop(progress);
        let text = screen.text();
        assert!(text.contains(CLEAR), "{text:?}");
        assert!(text.contains(" 50%  10.0 MB of 20.0 MB"), "{text:?}");
        assert!(text.contains("100%  20.0 MB of 20.0 MB"), "{text:?}");
        // What stays on screen once each redraw is cleared: one line a step.
        let kept: Vec<&str> = text
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(|l| l.rsplit(CLEAR).next().unwrap())
            .collect();
        assert_eq!(kept.len(), 6, "{kept:?}");
        for (line, step) in kept.iter().zip(Step::ALL) {
            assert!(line.starts_with(&format!("✓ {:<8} {}", step.name(), step.of())));
        }
    }

    #[test]
    fn anything_else_gets_plain_lines_and_no_escape_codes() {
        let screen = Screen::default();
        let progress = Progress::to(Box::new(screen.clone()), false);
        run_all(&progress);
        drop(progress);
        let text = screen.text();
        assert!(!text.contains('\x1b') && !text.contains('\r'), "{text:?}");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 12, "{lines:?}");
        assert_eq!(lines[0], "Step 1 of 6: Download");
        assert!(lines[1].starts_with("Step 1 of 6: Download done in "));
        assert_eq!(lines[10], "Step 6 of 6: Swap in");
    }

    #[test]
    fn a_step_that_did_not_finish_is_marked_in_a_terminal() {
        let screen = Screen::default();
        let progress = Progress::to(Box::new(screen.clone()), true);
        progress.begin(Step::Download);
        progress.end(None);
        progress.begin(Step::Verify);
        drop(progress);
        let text = screen.text();
        assert!(
            text.ends_with(&format!("{CLEAR}✗ Verify   step 2 of 6\n")),
            "{text:?}"
        );
    }
}
