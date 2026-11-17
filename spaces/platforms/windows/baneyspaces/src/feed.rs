//! The shell's live feed: a client that sends `{"op":"subscribe"}` keeps its pipe open and gets one `ShellState` line
//! now and another each time it changes (`spec/shell.md`). Each subscriber has a writer thread of its own, so neither
//! the daemon nor the feed thread ever writes to a pipe, and a shell that stops reading holds up no one. Every line is
//! the whole state, so a writer that falls behind skips to the newest. A subscriber whose write fails, or hangs for
//! `STALL`, is dropped. Generic over the writer so it is tested anywhere.

use std::io::Write;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// How long one write may hang before its subscriber is dropped. The pipe's own 64 KB buffer comes first, so a write
/// hangs only when the shell has stopped reading.
pub const STALL: Duration = Duration::from_secs(5);

pub enum FeedMsg<W> {
    /// A new subscriber, the answer to its request and the state line it starts from. The answer goes out on the
    /// subscriber's own thread, never on the daemon's.
    Greet(W, String, String),
    /// The state now; sent only if it differs from the last one.
    Publish(String),
}

#[derive(Default)]
struct Slot {
    /// The newest state not yet written.
    next: Option<String>,
    /// When the write under way began.
    writing: Option<Instant>,
    /// A write failed, or the feed let it go.
    gone: bool,
}

type Shared = Arc<(Mutex<Slot>, Condvar)>;

fn send<W: Write>(w: &mut W, line: &str) -> bool {
    writeln!(w, "{line}").and_then(|_| w.flush()).is_ok()
}

/// The subscriber's writer: `first` goes out, then the newest state each time there is one, until a write fails or
/// the feed lets it go. A write that hangs holds up only this thread.
fn writer<W: Write + Send + 'static>(mut w: W, first: Vec<String>) -> Shared {
    let slot: Shared = Arc::default();
    let s = slot.clone();
    std::thread::spawn(move || {
        let (m, cv) = &*s;
        let mut queue = first;
        loop {
            m.lock().unwrap().writing = Some(Instant::now());
            let ok = queue.iter().all(|l| send(&mut w, l));
            let mut g = m.lock().unwrap();
            g.writing = None;
            if !ok {
                g.gone = true;
                return;
            }
            while g.next.is_none() && !g.gone {
                g = cv.wait(g).unwrap();
            }
            match g.next.take() {
                Some(line) if !g.gone => queue = vec![line],
                _ => return,
            }
        }
    });
    slot
}

pub struct Feed {
    subs: Vec<Shared>,
    last: Option<String>,
    stall: Duration,
}

impl Feed {
    pub fn new() -> Self {
        Feed::with_stall(STALL)
    }

    fn with_stall(stall: Duration) -> Self {
        Feed {
            subs: Vec::new(),
            last: None,
            stall,
        }
    }

    pub fn add<W: Write + Send + 'static>(&mut self, w: W, lines: Vec<String>) {
        self.last = lines.last().cloned();
        self.subs.push(writer(w, lines));
    }

    /// Hands `line` to every subscriber when it changed, dropping any whose write failed or hung for `stall`.
    /// Returns whether it changed.
    pub fn publish(&mut self, line: String) -> bool {
        if self.last.as_deref() == Some(line.as_str()) {
            return false;
        }
        let stall = self.stall;
        self.subs.retain(|s| {
            let (m, cv) = &**s;
            let mut g = m.lock().unwrap();
            if g.writing.is_some_and(|t| t.elapsed() >= stall) {
                g.gone = true;
            }
            if !g.gone {
                g.next = Some(line.clone());
            }
            cv.notify_one();
            !g.gone
        });
        self.last = Some(line);
        true
    }

    #[cfg(test)]
    pub fn subscribers(&self) -> usize {
        self.subs.len()
    }

    pub fn handle<W: Write + Send + 'static>(&mut self, msg: FeedMsg<W>) {
        match msg {
            FeedMsg::Greet(w, hello, line) => self.add(w, vec![hello, line]),
            FeedMsg::Publish(line) => {
                self.publish(line);
            }
        }
    }
}

/// Starts the feed's thread.
pub fn spawn<W: Write + Send + 'static>() -> Sender<FeedMsg<W>> {
    let (tx, rx) = channel::<FeedMsg<W>>();
    std::thread::spawn(move || {
        let mut feed = Feed::new();
        while let Ok(msg) = rx.recv() {
            feed.handle(msg);
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy, Default, PartialEq)]
    enum Mode {
        #[default]
        Reads,
        Gone,
        Hangs,
    }

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<String>>>, Mode);
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            match self.1 {
                Mode::Gone => Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "gone")),
                // A shell that is alive but stopped reading: the pipe is full and the write never returns.
                Mode::Hangs => loop {
                    std::thread::sleep(Duration::from_secs(3600));
                },
                Mode::Reads => {
                    self.0
                        .lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(buf).into_owned());
                    Ok(buf.len())
                }
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn text(s: &Sink) -> String {
        s.0.lock().unwrap().concat()
    }

    /// Waits up to 2 s for what `s` heard to pass `ok`.
    fn heard(s: &Sink, ok: impl Fn(&str) -> bool) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(2) {
            if ok(&text(s)) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    #[test]
    fn a_subscriber_gets_the_state_now_then_each_change_once() {
        let mut f = Feed::new();
        let s = Sink::default();
        f.add(s.clone(), vec!["a".into()]);
        assert!(
            !f.publish("a".into()),
            "an unchanged state is not sent again"
        );
        assert!(heard(&s, |t| t == "a\n"));
        assert!(f.publish("b".into()));
        assert!(!f.publish("b".into()));
        assert!(heard(&s, |t| t == "a\nb\n"), "heard {:?}", text(&s));
    }

    #[test]
    fn a_greeting_goes_out_before_the_state_on_the_subscribers_own_thread() {
        let tx = spawn::<Sink>();
        let s = Sink::default();
        tx.send(FeedMsg::Greet(s.clone(), "ok".into(), "a".into()))
            .unwrap();
        tx.send(FeedMsg::Publish("b".into())).unwrap();
        assert!(heard(&s, |t| t == "ok\na\nb\n"), "heard {:?}", text(&s));
    }

    #[test]
    fn a_subscriber_that_falls_behind_skips_to_the_newest_state() {
        let mut f = Feed::new();
        let s = Sink::default();
        f.add(s.clone(), vec!["a".into()]);
        for i in 0..50 {
            f.publish(format!("s{i}"));
        }
        assert!(heard(&s, |t| t.ends_with("s49\n")), "heard {:?}", text(&s));
        assert!(text(&s).starts_with("a\n"));
        assert_eq!(f.subscribers(), 1, "falling behind is not stalling");
    }

    #[test]
    fn a_subscriber_that_went_away_is_dropped_and_the_rest_still_hear() {
        let mut f = Feed::new();
        let live = Sink::default();
        f.add(live.clone(), vec!["a".into()]);
        f.add(Sink(Arc::default(), Mode::Gone), vec!["a".into()]);
        assert_eq!(f.subscribers(), 2);
        // The failed first write ends its writer; a later publish finds it gone.
        let t = Instant::now();
        let mut n = 0;
        while f.subscribers() == 2 && t.elapsed() < Duration::from_secs(2) {
            n += 1;
            f.publish(format!("b{n}"));
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(f.subscribers(), 1);
        let end = format!("b{n}\n");
        assert!(
            heard(&live, |t| t.ends_with(&end)),
            "heard {:?}",
            text(&live)
        );
    }

    /// first-F2: a shell that is alive but stopped reading used to block the feed thread in its write, and every
    /// other subscriber stopped hearing.
    #[test]
    fn a_shell_that_stopped_reading_never_holds_up_the_others() {
        let tx = spawn::<Sink>();
        let live = Sink::default();
        tx.send(FeedMsg::Greet(live.clone(), "ok".into(), "a".into()))
            .unwrap();
        tx.send(FeedMsg::Greet(
            Sink(Arc::default(), Mode::Hangs),
            "ok".into(),
            "a".into(),
        ))
        .unwrap();
        for i in 0..24 {
            tx.send(FeedMsg::Publish(format!("s{i}"))).unwrap();
        }
        assert!(
            heard(&live, |t| t.ends_with("s23\n")),
            "the live shell stopped hearing at {:?}",
            text(&live)
        );
    }

    #[test]
    fn a_shell_whose_write_hangs_is_dropped() {
        let mut f = Feed::with_stall(Duration::from_millis(50));
        let live = Sink::default();
        f.add(live.clone(), vec!["a".into()]);
        f.add(Sink(Arc::default(), Mode::Hangs), vec!["a".into()]);
        f.publish("b".into());
        assert_eq!(f.subscribers(), 2, "a write under way is not a stall");
        std::thread::sleep(Duration::from_millis(100));
        f.publish("c".into());
        assert_eq!(f.subscribers(), 1);
        assert!(
            heard(&live, |t| t == "a\nb\nc\n"),
            "heard {:?}",
            text(&live)
        );
    }

    /// first-F3: the daemon wrote the `subscribed` answer to the pipe while it held the core, so a client that
    /// subscribed and never read stalled the whole daemon. Nothing in the subscribe branch writes before the core is
    /// let go.
    #[test]
    fn the_daemon_lets_go_of_the_core_before_a_subscriber_hears_anything() {
        let src = include_str!("daemon.rs");
        let start = src
            .find("v[\"op\"] == \"subscribe\"")
            .expect("the subscribe branch");
        let end = start + src[start..].find("\n    }\n").expect("its end");
        let branch = &src[start..end];
        let held = branch
            .split("drop(c)")
            .next()
            .expect("the part with the core held");
        assert!(
            branch.contains("drop(c)"),
            "the subscribe branch never lets go of the core before it writes:\n{branch}"
        );
        assert!(
            !held.contains("writeln!") && !held.contains(".write"),
            "the subscribe branch writes to the pipe with the core held:\n{held}"
        );
    }
}
