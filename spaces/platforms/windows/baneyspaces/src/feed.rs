//! The shell's live feed: a client that sends `{"op":"subscribe"}` keeps its pipe open and gets one `ShellState` line
//! now and another each time it changes (`spec/shell.md`). Lines go out from a thread of their own, so a slow reader
//! never holds up the daemon; a client whose write fails is dropped. Generic over the writer so it is tested anywhere.

use std::io::Write;
use std::sync::mpsc::{channel, Sender};

pub enum FeedMsg<W> {
    /// A new subscriber and the state line it starts from.
    Add(W, String),
    /// The state now; sent only if it differs from the last one.
    Publish(String),
}

#[derive(Default)]
pub struct Feed<W> {
    subs: Vec<W>,
    last: Option<String>,
}

fn send<W: Write>(w: &mut W, line: &str) -> bool {
    writeln!(w, "{line}").and_then(|_| w.flush()).is_ok()
}

impl<W: Write> Feed<W> {
    pub fn new() -> Self {
        Feed {
            subs: Vec::new(),
            last: None,
        }
    }

    pub fn add(&mut self, mut w: W, line: String) {
        if send(&mut w, &line) {
            self.subs.push(w);
        }
        self.last = Some(line);
    }

    /// Writes `line` to every subscriber when it changed. Returns whether it went out.
    pub fn publish(&mut self, line: String) -> bool {
        if self.last.as_deref() == Some(line.as_str()) {
            return false;
        }
        self.subs.retain_mut(|w| send(w, &line));
        self.last = Some(line);
        true
    }

    pub fn subscribers(&self) -> usize {
        self.subs.len()
    }

    pub fn handle(&mut self, msg: FeedMsg<W>) {
        match msg {
            FeedMsg::Add(w, line) => self.add(w, line),
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
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<String>>>, bool);
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.1 {
                return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "gone"));
            }
            self.0
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(buf).into_owned());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn text(s: &Sink) -> String {
        s.0.lock().unwrap().concat()
    }

    #[test]
    fn a_subscriber_gets_the_state_now_then_each_change_once() {
        let mut f = Feed::new();
        let s = Sink::default();
        f.add(s.clone(), "a".into());
        assert!(
            !f.publish("a".into()),
            "an unchanged state is not sent again"
        );
        assert!(f.publish("b".into()));
        assert!(!f.publish("b".into()));
        assert_eq!(text(&s), "a\nb\n");
    }

    #[test]
    fn a_subscriber_that_went_away_is_dropped_and_the_rest_still_hear() {
        let mut f = Feed::new();
        let live = Sink::default();
        let gone = Sink::default();
        f.add(live.clone(), "a".into());
        f.add(gone.clone(), "a".into());
        assert_eq!(f.subscribers(), 2);
        let mut dead = gone.clone();
        dead.1 = true;
        f.subs[1] = dead;
        f.publish("b".into());
        assert_eq!(f.subscribers(), 1);
        assert_eq!(text(&live), "a\nb\n");
    }
}
