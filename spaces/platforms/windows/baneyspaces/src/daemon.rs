//! `baneyspaces daemon`: the model driven by what Windows reports (WinEvents, and a slow safety reconcile), the
//! chords the keyboard hook swallows, the control pipe the CLI talks to, `state.json`, the agent
//! workspace and the agent action log.
//!
//! The model decides; this file only carries it out. Where a window should be is derived, not
//! replayed: after every event each tracked window is compared with what the model says (shown on
//! some display, or not) and hidden or shown to match, and what is hidden is read back from Windows,
//! never taken from memory. The worker waits on events (`hook.rs`); a full look at every window runs every
//! `RECONCILE` as a safety net, and a cheap read-back of what is hidden every `RECHECK` only while something
//! no event reports could go wrong (a parked or ghosted window, a show still to retry). Every step is
//! idempotent, so a missed event costs one reconcile, not a lost window.
//!
//! Three rules keep a window from being lost:
//! 1. **Record first.** A window is written to `state.json` (and flushed) before it is hidden. If that
//!    write fails, nothing is hidden and the request that wanted it is refused.
//! 2. **Forget last.** An entry is removed only after the window reads back as shown. A show that fails
//!    keeps its entry and is retried on every poll.
//! 3. **Tracked while it exists.** A hidden window stays in the set as long as `IsWindow` is true,
//!    whatever its title or styles become. Only a destroyed window leaves.

use crate::agent;
use crate::apps;
use crate::cause;
use crate::cloak::{self, Cloaker};
use crate::cmdline;
use crate::displays;
use crate::focus;
use crate::hidden::{self, Hidden, HiddenSet, How, Recovery};
use crate::hook::{self, EndSession, Msg};
use crate::keys;
use crate::paths::Paths;
use crate::settings;
use crate::winapi::{self, hwnd as to_hwnd, id_of, window_name};
use baneyspaces_core::agent::ActionRecord;
use baneyspaces_core::envelope::{Envelope, Retry};
use baneyspaces_core::model::{Cause, Effect, Event, Home, Model, ModelError};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::ops::{Deref, DerefMut};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const AGENT_WORKSPACE: &str = "off-your-screen (ghost: transparent, click-through, unfocusable)";

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Clone, Debug)]
pub struct WinInfo {
    pub hwnd: i64,
    pub pid: u32,
    pub start: u64,
    pub title: String,
    pub app: String,
}

pub struct Core {
    pub model: Model,
    pub paths: Paths,
    pub hidden: HiddenSet,
    pub info: HashMap<String, WinInfo>,
    /// The user's agent job (named, so a restarted daemon opens the same one).
    pub job: Option<agent::Job>,
    pub overview_shown: bool,
    pub events_seen: u64,
    /// When a tracked window last closed (GetTickCount): the next activation may be Windows handing on the front.
    closed_at: Option<u32>,
    pub started: u64,
    pub trace: bool,
    pub our_pid: u32,
    pub problems: Vec<String>,
    pub settings: serde_json::Map<String, Value>,
    pub tx: Sender<Msg>,
    /// When the action log was last pruned (`Paths::append_action`).
    pub last_prune: std::cell::Cell<u64>,
    /// Where the shell's feed is sent (`feed.rs`); `None` sends it nowhere. A test's own, never shared.
    pub feed: Option<FeedTx>,
    /// What `state.json` holds now, as last written: an unchanged state is not written again.
    pub written: std::cell::RefCell<String>,
    /// Something only a read-back can catch is pending: a window parked or ghosted (no event says an app moved it
    /// back or reset its alpha) or a show to retry. The worker then reads what is hidden back every `RECHECK`.
    pub recheck: bool,
    /// The keys in force (spec/keymap.md): the config text they came from, how many bindings, how many loads, and why
    /// the last read of config.toml was not applied, if it was not.
    pub keys: KeysState,
    /// The program in front runs as administrator and this daemon does not: Windows keeps every key typed into it
    /// from the hook (UIPI), so the chords do nothing until another window is in front.
    pub keys_blocked_by: Option<String>,
}

#[derive(Default)]
pub struct KeysState {
    pub text: Option<String>,
    pub bindings: usize,
    pub loads: u64,
    pub error: Option<String>,
    pub elevated_self: bool,
}

/// A subscriber's pipe, as the feed holds it.
pub type Pipe = Box<dyn Write + Send>;
/// Hands a message to the shell's feed. The daemon's never blocks (an unbounded channel).
pub type FeedTx = Arc<dyn Fn(crate::feed::FeedMsg<Pipe>) + Send + Sync>;

/// The full look at every window (EnumWindows, titles, displays): a safety net behind the WinEvents.
pub const RECONCILE: Duration = Duration::from_secs(3);
/// The read-back of what is hidden while `Core::recheck` is set, and the full look when the WinEvent hooks are not in.
pub const RECHECK: Duration = Duration::from_millis(400);

pub type Shared = Arc<Mutex<Core>>;

/// The core, locked. When a lock that could change it is let go, the state goes to the shell's feed: every change
/// reaches the shell (a title re-read by the poll as much as a switch), and only state that held, since a refused
/// request has put the model back by then.
pub struct Locked<'a> {
    core: MutexGuard<'a, Core>,
    changed: bool,
}

impl Deref for Locked<'_> {
    type Target = Core;
    fn deref(&self) -> &Core {
        &self.core
    }
}

impl DerefMut for Locked<'_> {
    fn deref_mut(&mut self) -> &mut Core {
        self.changed = true;
        &mut self.core
    }
}

impl Drop for Locked<'_> {
    fn drop(&mut self) {
        if self.changed {
            self.core.publish();
        }
    }
}

pub fn lock(s: &Shared) -> Locked<'_> {
    Locked { core: s.lock().unwrap_or_else(|p| p.into_inner()), changed: false }
}

static LOG: OnceLock<Mutex<std::fs::File>> = OnceLock::new();

/// A line of daemon output: to the log file when there is one (the daemon has no console then),
/// else to stderr. Never panics: a closed console must not take the daemon down.
pub fn say(msg: &str) {
    if let Some(f) = LOG.get() {
        if let Ok(mut f) = f.lock() {
            let _ = writeln!(f, "{msg}");
        }
    } else {
        let _ = writeln!(std::io::stderr(), "{msg}");
    }
}

/// Sign-out or shutdown is under way: windows are shown and nothing is hidden until it is cancelled.
static STOPPING: AtomicBool = AtomicBool::new(false);
static FINISHED: AtomicBool = AtomicBool::new(false);
static CTRL_TX: OnceLock<Sender<Msg>> = OnceLock::new();
static SHARED: OnceLock<Shared> = OnceLock::new();
static PATHS: OnceLock<Paths> = OnceLock::new();

/// What a request that wanted to hide windows says when it could not save where they were.
fn save_error(why: &str) -> Envelope {
    Envelope::err(
        "internal",
        format!("nothing was hidden: BaneySpaces could not save where your windows are, so it will not hide one ({why})"),
        Retry::Safe,
        "Nothing changed; the same call can be sent again. Check that %LOCALAPPDATA%\\BaneySpaces is writable and the disk is not full.",
    )
}

impl Core {
    fn log(&self, msg: &str) {
        if self.trace {
            say(&format!("[baneyspaces] {msg}"));
        }
    }

    fn problem(&mut self, msg: String) {
        if self.problems.last() == Some(&msg) {
            return;
        }
        say(&format!("[baneyspaces] {msg}"));
        self.problems.push(msg);
        if self.problems.len() > 20 {
            self.problems.remove(0);
        }
    }

    // ---- monitors ------------------------------------------------------------------------

    pub fn sync_monitors(&mut self) {
        let now: Vec<String> = winapi::monitors().into_iter().map(|m| m.name).collect();
        if now.is_empty() {
            return;
        }
        let known: Vec<String> = self.model.monitors().map(String::from).collect();
        for ev in displays::monitor_events(&known, &now) {
            let _ = self.apply(ev);
        }
        if self.model.focused_monitor().is_none() {
            if let Some(m) = now.first() {
                let _ = self.apply(Event::ObserveFocusMonitor { monitor: m.clone() });
            }
        }
    }

    // ---- the model's effects -------------------------------------------------------------

    /// An event that mirrors what Windows did (a window opened, closed, took the front). Hiding
    /// that cannot be recorded is skipped and reported, never forced.
    pub fn apply(&mut self, ev: Event) -> Result<Vec<Effect>, ModelError> {
        self.events_seen += 1;
        let effects = self.model.apply(ev)?;
        if let Err(e) = self.exec(&effects) {
            self.problem(format!("could not save the hidden-window record, so no window was hidden: {e}"));
        }
        Ok(effects)
    }

    /// A request that changes what is hidden (switch, move, agent workspace). If the record cannot be
    /// saved, the model is put back and the caller gets an error; no window was touched.
    pub fn apply_checked(&mut self, ev: Event) -> Result<Vec<Effect>, Envelope> {
        if STOPPING.load(Ordering::SeqCst) {
            return Err(Envelope::err("internal", "the daemon is shutting down (sign-out or stop): no window is being hidden", Retry::Safe, "Try again when it is back."));
        }
        self.events_seen += 1;
        let backup = self.model.clone();
        let effects = self.model.apply(ev).map_err(model_err)?;
        match self.exec(&effects) {
            Ok(()) => Ok(effects),
            Err(e) => {
                self.model = backup;
                self.problem(format!("refused: could not save the hidden-window record: {e}"));
                Err(save_error(&e))
            }
        }
    }

    /// Carries out effects. Where windows are is derived by `sync_visibility`; only focus is
    /// an action. Every effect is idempotent.
    fn exec(&mut self, effects: &[Effect]) -> Result<(), String> {
        for e in effects {
            self.log(&format!("effect {e:?}"));
        }
        self.sync_visibility()?;
        match focus::front_after(effects) {
            Some(focus::Front::Window(w)) => {
                if let Some(i) = self.info.get(&w) {
                    if !self.hidden.contains(i.hwnd) {
                        // Noted first: Windows may grant it late, even after reporting it refused (cause::ASKED_MS).
                        cause::note_asked(i.hwnd, winapi::tick_ms());
                        if !winapi::set_foreground(to_hwnd(i.hwnd)) {
                            self.log(&format!("{w} could not be put in front (Windows refused the foreground)"));
                        }
                    }
                }
            }
            Some(focus::Front::Desktop) => {
                let taken = winapi::set_foreground(winapi::shell_window());
                if !taken {
                    self.log("the desktop could not be put in front (Windows refused the foreground)");
                }
            }
            None => {}
        }
        self.keep_focus_off_hidden_windows();
        let _ = self.persist();
        Ok(())
    }

    /// Focus never rests on a window that is out of sight (R-E1): typing would go to it.
    fn keep_focus_off_hidden_windows(&mut self) {
        let fg = id_of(winapi::foreground());
        let Some(h) = self.hidden.get(fg).cloned() else { return };
        if h.how == How::Ghost && self.model.agent_shown() {
            return;
        }
        let target = self.model.active().and_then(|w| self.info.get(w)).filter(|i| !self.hidden.contains(i.hwnd)).map(|i| to_hwnd(i.hwnd));
        if let Some(t) = target {
            cause::note_asked(t as isize as i64, winapi::tick_ms());
        }
        if !winapi::set_foreground(target.unwrap_or_else(winapi::shell_window)) {
            self.log("focus is on a hidden window and Windows refused to move it");
        }
    }

    fn visible_workspaces(&self) -> BTreeSet<u8> {
        self.model.monitors().filter_map(|m| self.model.current(m)).filter(|n| *n != 0).collect()
    }

    /// Is `pid` a process BaneySpaces started for an agent, or one of its children? A registration holds only for
    /// the process it was made for: the live process must still have the start time that was registered, so a
    /// pid Windows has handed to a new program is not an agent's. (Job membership is by process, so it is safe.)
    fn is_agent_pid(&self, pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        if let Some(registered) = self.model.agent_proc(pid) {
            let live = winapi::process_start(pid);
            if registered != 0 && live == registered {
                return true;
            }
        }
        self.job.as_ref().is_some_and(|j| agent::in_job(j, pid))
    }

    /// An entry as it is written before a window is hidden: how, where it was, the styles to put back and who
    /// it belongs to. `agent` follows the window's *process*, not where the model put it.
    fn entry_for(&self, hwnd: i64, pid: u32, start: u64, how: How) -> Hidden {
        let h = to_hwnd(hwnd);
        let owner_pid = winapi::pid_of(h);
        let agent = self.is_agent_pid(pid) || self.is_agent_pid(owner_pid);
        Hidden {
            hwnd,
            pid,
            start,
            how,
            rect: winapi::rect(h),
            agent,
            ex_style: (how == How::Ghost).then(|| winapi::ex_style(h)),
            alpha: if how == How::Ghost { winapi::layered_alpha(h) } else { None },
            class: winapi::class(h),
            owner_pid,
            owner_start: winapi::process_start(owner_pid),
        }
    }

    /// Hides and shows windows so what you see is what the model says. Shows first, so a switch
    /// never flashes the desktop between two workspaces. What is hidden is checked against Windows
    /// every time: an entry in the set is a promise, not a fact.
    ///
    /// Returns an error, with no window touched, when the record of what is about to be hidden cannot
    /// be saved.
    pub fn sync_visibility(&mut self) -> Result<(), String> {
        let stopping = STOPPING.load(Ordering::SeqCst);
        let shown = self.visible_workspaces();
        let agent_shown = self.model.agent_shown();
        #[derive(Clone, Copy, PartialEq)]
        enum Want {
            Visible,
            /// Out of sight the way your windows are (cloak, parked if refused).
            HideUser,
            /// Out of sight as an agent's window is (a ghost, parked if refused).
            HideAgent,
        }
        // (hwnd, pid, start, what is wanted)
        let mut wants: Vec<(i64, u32, u64, Want)> = vec![];
        let mut tracked: BTreeSet<i64> = BTreeSet::new();
        let infos: Vec<(String, WinInfo)> = self.info.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (id, i) in &infos {
            let w = match self.model.home(id) {
                Some(Home::Workspace { n }) => {
                    if shown.contains(n) {
                        Want::Visible
                    } else {
                        Want::HideUser
                    }
                }
                Some(Home::Agent) => {
                    if agent_shown {
                        Want::Visible
                    } else if self.is_agent_pid(i.pid) {
                        Want::HideAgent
                    } else {
                        // A window of yours that `agent move` sent to the agent workspace: it is yours, so it is
                        // hidden the way yours are, recorded first, and shown again by `agent bring`.
                        Want::HideUser
                    }
                }
                None => continue,
            };
            tracked.insert(i.hwnd);
            wants.push((i.hwnd, i.pid, i.start, w));
        }
        // An agent's other windows (a dialog its app opened, one not shown yet) follow the agent workspace too.
        for e in self.hidden.entries().filter(|e| e.agent && !tracked.contains(&e.hwnd)) {
            wants.push((e.hwnd, e.pid, e.start, if agent_shown { Want::Visible } else { Want::HideAgent }));
        }
        if stopping {
            // Sign-out in progress: everything is shown by the restore; hide nothing.
            wants.retain(|w| w.3 == Want::Visible);
        }
        let started = Instant::now();
        let mut desktops: Option<Option<cloak::Desktops>> = None;
        let mut elsewhere = |h: windows_sys::Win32::Foundation::HWND| desktops.get_or_insert_with(cloak::Desktops::new).as_ref().and_then(|d| d.on_current(h)) == Some(false);
        let mut cloaker: Option<Option<Cloaker>> = None;
        let get = |c: &mut Option<Option<Cloaker>>| -> Option<*const Cloaker> {
            if c.is_none() {
                *c = Some(Cloaker::new().ok());
            }
            c.as_ref().and_then(|o| o.as_ref()).map(|x| x as *const Cloaker)
        };
        // 0. A window recorded the wrong way for what it is wanted as (an agent's ghost that is now yours, a
        //    cloak where a ghost is wanted) is put right first. A parked agent window is right: it is what a
        //    window that refuses ghosting gets, and it stays parked rather than being tried again every poll.
        for (hwnd, _, _, w) in &wants {
            if let Some(e) = self.hidden.get(*hwnd).cloned() {
                let wrong = (*w == Want::HideUser && e.how == How::Ghost) || (*w == Want::HideAgent && e.how == How::Cloak);
                if wrong {
                    let c = get(&mut cloaker);
                    if cloak::show(&e, c.map(|p| unsafe { &*p })) {
                        self.hidden.remove(*hwnd);
                    }
                }
            }
        }
        // 1. Record first: every window about to be hidden is on disk before any is touched.
        let mut add: Vec<Hidden> = vec![];
        for (hwnd, pid, start, w) in &wants {
            let h = to_hwnd(*hwnd);
            if self.hidden.contains(*hwnd) || !winapi::exists(h) {
                continue;
            }
            match w {
                Want::HideUser => add.push(self.entry_for(*hwnd, *pid, *start, How::Cloak)),
                Want::HideAgent => add.push(self.entry_for(*hwnd, *pid, *start, How::Ghost)),
                Want::Visible => {}
            }
        }
        if !add.is_empty() {
            let before = self.hidden.clone();
            for e in &add {
                self.hidden.insert(e.clone());
            }
            if let Err(e) = self.persist() {
                self.hidden = before;
                // A window of an agent's process is the agent's, not yours: it is kept off your screen even with
                // the record unsaved. Yours (whatever workspace the model put them on) are never hidden unrecorded:
                // the request is refused, with nothing touched.
                let agents: Vec<Hidden> = add.iter().filter(|x| x.agent).cloned().collect();
                for a in &agents {
                    self.hidden.insert(a.clone());
                    if cloak::ghost(to_hwnd(a.hwnd)).is_none() {
                        winapi::set_pos(to_hwnd(a.hwnd), cloak::PARK, cloak::PARK);
                    }
                }
                if add.iter().any(|x| !x.agent) {
                    return Err(e);
                }
                self.problem(format!("could not save the record of an agent window ({e}); it is hidden anyway"));
            }
        }
        let recorded = started.elapsed();
        // 2. Show. An entry goes only after the window reads back as shown; a failure keeps it and the
        //    worker tries again every RECHECK (explorer.exe restarting is the usual reason). A window on another
        //    virtual desktop is cloaked by Windows itself and cannot be shown from here: it waits for its desktop
        //    (whose windows' uncloak events bring the worker back here). The record is written once, below: an
        //    entry still on disk for a window already shown only means a restart shows it again, which is safe.
        let mut changed = !add.is_empty();
        let (mut shown_n, mut waiting) = (0, false);
        for (hwnd, _, _, w) in &wants {
            if *w != Want::Visible {
                continue;
            }
            if let Some(mut e) = self.hidden.get(*hwnd).cloned() {
                if elsewhere(to_hwnd(*hwnd)) {
                    waiting = true;
                    continue;
                }
                self.carry_before_show(&mut e);
                let c = get(&mut cloaker);
                if cloak::show(&e, c.map(|p| unsafe { &*p })) {
                    self.hidden.remove(*hwnd);
                    changed = true;
                    shown_n += 1;
                } else {
                    waiting = true;
                    self.log(&format!("{} did not read back as shown; will retry", window_name(*hwnd)));
                }
            }
        }
        let showed = started.elapsed();
        // 3. Hide, and read it back: re-apply whatever Windows no longer agrees with. The method recorded is
        //    always the one actually applied.
        let mut hid_n = 0;
        for (hwnd, _, _, w) in &wants {
            let h = to_hwnd(*hwnd);
            if *w == Want::Visible || !winapi::exists(h) {
                continue;
            }
            let Some(mut e) = self.hidden.get(*hwnd).cloned() else { continue };
            // An agent's window starts minimized (so it never draws) and is ghosted that way. Once it is
            // tracked and invisible it is restored, so showing the agent workspace has a window to show.
            if *w == Want::HideAgent && e.how == How::Ghost && tracked.contains(hwnd) && winapi::is_iconic(h) && cloak::still_hidden(&e) {
                winapi::restore_minimized_no_activate(h);
            }
            if cloak::still_hidden(&e) {
                continue;
            }
            if elsewhere(h) {
                continue; // another virtual desktop: Windows has it cloaked, and it is not ours to hide from here
            }
            hid_n += 1;
            self.log(&format!("{} is not hidden any more ({:?}); hiding it again", window_name(*hwnd), e.how));
            let was = e.how;
            match *w {
                Want::HideUser => {
                    if e.how == How::Park && !winapi::is_iconic(h) {
                        // The app moved itself out of the parking spot: where it went is where it goes back to.
                        e.rect = winapi::rect(h);
                    }
                    let c = get(&mut cloaker);
                    e.how = cloak::hide_user(h, c.map(|p| unsafe { &*p }));
                    if e.how != How::Cloak {
                        self.problem(format!("cloak refused for {}: parked it instead", window_name(*hwnd)));
                    }
                }
                Want::HideAgent => match cloak::ghost(h) {
                    Some(undo) => {
                        // It took the ghost this time (it was parked because it refused before): back to the
                        // place it had, and recorded as a ghost with the styles to put back.
                        if was == How::Park {
                            if let Some(r) = e.rect {
                                if winapi::is_parked(h) {
                                    winapi::set_pos(h, r[0], r[1]);
                                }
                            }
                        }
                        e.how = How::Ghost;
                        if e.ex_style.is_none() {
                            e.ex_style = Some(undo.ex_style);
                            e.alpha = undo.alpha;
                        }
                    }
                    None => {
                        // Refused again: parked, recorded as parked, and left alone until it moves itself.
                        if was != How::Park {
                            self.problem(format!("{} would not ghost: parked it instead", window_name(*hwnd)));
                        }
                        e.how = How::Park;
                        winapi::set_pos(h, cloak::PARK, cloak::PARK);
                    }
                },
                Want::Visible => {}
            }
            if e.how != was {
                changed = true;
            }
            self.hidden.insert(e);
        }
        let hid = started.elapsed();
        if changed {
            let _ = self.persist();
        }
        self.recheck = waiting || self.hidden.entries().any(|e| e.how != How::Cloak);
        if shown_n + hid_n > 0 {
            let ms = |d: Duration| d.as_secs_f64() * 1000.0;
            self.log(&format!(
                "sync: recorded {} in {:.1} ms, showed {shown_n} by {:.1} ms, hid {hid_n} by {:.1} ms, written by {:.1} ms",
                add.len(),
                ms(recorded),
                ms(showed),
                ms(hid),
                ms(started.elapsed())
            ));
        }
        Ok(())
    }

    /// The record of what is hidden and everything else `state.json` holds. Returns why it could not be saved.
    pub fn persist(&self) -> Result<(), String> {
        let mut v = self.model.view();
        v["version"] = json!(1);
        v["platform"] = json!("windows");
        v["agent_workspace"] = json!(AGENT_WORKSPACE);
        v["hiding"] = json!({ "your_workspaces": "shell cloak (IApplicationView::SetCloak), parked off-screen if refused", "agent_workspace": "ghost (transparent, click-through, no focus)" });
        v["hidden"] = self.hidden.to_json();
        let procs: Vec<Value> = self.model.agent_pids().into_iter().map(|(p, s)| json!({ "pid": p, "start": s })).collect();
        v["agents"] = json!(procs);
        v["settings"] = Value::Object(self.settings.clone());
        v["overview"] = json!({ "shown": self.overview_shown });
        v["daemon"] = json!({ "pid": self.our_pid, "started": self.started, "events": self.events_seen, "problems": self.problems });
        v["keys"] = self.keys_json();
        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
        if *self.written.borrow() == text {
            return Ok(()); // already on disk: idle reconciles write nothing
        }
        self.paths.write_atomic("state.json", &text)?;
        *self.written.borrow_mut() = text;
        Ok(())
    }

    /// What the shell shows, as the feed's line: your windows with their app and title, never an agent's.
    pub fn shell_line(&self) -> String {
        baneyspaces_core::shell::ShellState::from_model(&self.model, |w| self.info.get(w).map(|i| (i.app.clone(), i.title.clone())).unwrap_or_default()).line()
    }

    /// Sends the state to the shell's feed; the feed drops it when nothing it shows changed. `Locked` calls it.
    fn publish(&self) {
        if let Some(feed) = &self.feed {
            feed(crate::feed::FeedMsg::Publish(self.shell_line()));
        }
    }

    // ---- windows -------------------------------------------------------------------------

    fn facts_of(&self, hwnd: i64) -> WinInfo {
        let h = to_hwnd(hwnd);
        let pid = winapi::real_pid(h);
        WinInfo { hwnd, pid, start: winapi::process_start(pid), title: winapi::title(h), app: winapi::process_name(pid) }
    }

    /// Registers `pid` as an agent process if it is one BaneySpaces started (or a descendant).
    fn adopt_agent_pid(&mut self, pid: u32) -> bool {
        if self.is_agent_pid(pid) && self.model.agent_proc(pid).is_some() {
            return true;
        }
        if !self.job.as_ref().is_some_and(|j| agent::in_job(j, pid)) {
            return false;
        }
        let start = winapi::process_start(pid);
        if start == 0 {
            return false; // never register a process whose identity cannot be read
        }
        self.log(&format!("pid {pid} is in the agent job"));
        let _ = self.apply(Event::AgentRegister { pid, start });
        true
    }

    /// R-M1: a hidden window whose workspace now shows on another display goes to that display before it is shown,
    /// so it never appears over the other display's workspace. A cloaked window is moved while still cloaked; a parked
    /// one gets a new place to come back to, recorded first. A minimized window, a ghost and one on no display stay put.
    fn carry_before_show(&mut self, e: &mut Hidden) {
        if e.how == How::Ghost {
            return;
        }
        let Some(Home::Workspace { n }) = self.model.home(&window_name(e.hwnd)).cloned() else { return };
        let Some(to) = self.model.shown_on(n).map(String::from) else { return };
        let h = to_hwnd(e.hwnd);
        let at = if e.how == How::Park { e.rect } else { winapi::rect(h) };
        let Some(at) = at.filter(|_| !winapi::is_iconic(h)) else { return };
        let all: Vec<(String, displays::Rect)> = winapi::monitors().into_iter().map(|m| (m.name, m.rect)).collect();
        let Some(r) = displays::carried(at, &all, &to, winapi::is_zoomed(h)) else { return };
        self.log(&format!("{} carried to {to}, where workspace {n} shows: {r:?}", window_name(e.hwnd)));
        if e.how == How::Park {
            e.rect = Some(r);
            self.hidden.insert(e.clone());
            let _ = self.persist();
        } else {
            winapi::set_frame(h, r);
        }
    }

    /// One window appeared. `existing` windows (found at start) are mirrored where they are; a
    /// new one follows the placement rules.
    fn open_window(&mut self, hwnd: i64, existing: bool) {
        let id = window_name(hwnd);
        if self.model.is_tracked(&id) {
            return;
        }
        let info = self.facts_of(hwnd);
        if info.pid == 0 || info.pid == self.our_pid {
            return;
        }
        self.adopt_agent_pid(info.pid);
        let monitor = winapi::monitor_name_of(to_hwnd(hwnd)).filter(|m| self.model.monitors().any(|x| x == m));
        self.info.insert(id.clone(), info.clone());
        if existing {
            // Already open: exactly where it is. Agent windows (parked from a previous run) stay parked.
            let on_agent = self.is_agent_pid(info.pid) || self.hidden.get(hwnd).is_some_and(|h| h.agent);
            let workspace = if on_agent { None } else { monitor.as_deref().and_then(|m| self.model.current(m)).filter(|n| *n != 0).or(Some(1)) };
            let _ = self.apply(Event::ObserveWindow { window: id, pid: info.pid, start: info.start, app: info.app, workspace });
            return;
        }
        let _ = self.apply(Event::Open { window: id.clone(), pid: info.pid, start: info.start, app: info.app, monitor, workspace: None });
        if self.is_agent_pid(info.pid) && !matches!(self.model.home(&id), Some(Home::Agent)) {
            let _ = self.apply(Event::AgentSend { window: id });
        }
    }

    /// A tracked window is gone from the model. If it is still a window and we hid it, it is shown
    /// first and its entry kept until that reads back: dropping the entry of a window that still exists
    /// would leave it cloaked with no record.
    fn close_window(&mut self, id: &str) {
        self.closed_at = Some(winapi::tick_ms());
        if let Some(i) = self.info.remove(id) {
            if let Some(e) = self.hidden.get(i.hwnd).cloned() {
                if winapi::exists(to_hwnd(i.hwnd)) {
                    let cl = Cloaker::new().ok();
                    if cloak::show(&e, cl.as_ref()) {
                        self.hidden.remove(i.hwnd);
                    }
                } else {
                    self.hidden.remove(i.hwnd);
                }
            }
        }
        let _ = self.apply(Event::Close { window: id.to_string() });
    }

    /// Compares the windows that exist with the ones tracked; the source of truth for open and close.
    pub fn resync_windows(&mut self, existing: bool) {
        let mut agent_pids: HashMap<u32, bool> = HashMap::new();
        let mut live: Vec<i64> = vec![];
        for h in winapi::list_top_level() {
            let id = id_of(h);
            let pid = winapi::pid_of(h);
            let agent = *agent_pids.entry(pid).or_insert_with(|| self.is_agent_pid(pid));
            if agent {
                // An agent's window, whatever it looks like: ghost it before anything else.
                self.keep_agent_window_hidden(h, false);
            }
            if winapi::is_manageable(h, self.hidden.contains(id), self.our_pid, agent) {
                live.push(id);
            }
        }
        let live_set: BTreeSet<i64> = live.iter().copied().collect();
        // Gone: destroyed, or no longer a window we would manage and not one we hid. A window we hid stays
        // tracked for as long as it exists, whatever its title or styles turn into.
        // A window cloaked by someone else (Windows does this to every window of another virtual desktop) has not
        // gone: it keeps its workspace and comes back when its desktop does.
        let gone: Vec<String> = self.info.iter().filter(|(_, i)| !winapi::exists(to_hwnd(i.hwnd)) || (!live_set.contains(&i.hwnd) && !self.hidden.contains(i.hwnd) && winapi::cloaked(to_hwnd(i.hwnd)) == 0)).map(|(id, _)| id.clone()).collect();
        for id in gone {
            self.close_window(&id);
        }
        for hwnd in live {
            self.open_window(hwnd, existing);
        }
        // Entries for windows that were destroyed are done with.
        // A handle that is no longer that window (destroyed, or reused by another) is done with, and never touched.
        let dead: Vec<i64> = self.hidden.entries().filter(|e| !cloak::identity_ok(e)).map(|e| e.hwnd).collect();
        if !dead.is_empty() {
            for d in dead {
                self.log(&format!("{} is not the window that was hidden any more; dropped from the record", window_name(d)));
                self.hidden.remove(d);
            }
            let _ = self.persist();
        }
        // Titles change; keep `ls` honest.
        let ids: Vec<(String, i64)> = self.info.iter().map(|(k, v)| (k.clone(), v.hwnd)).collect();
        for (id, hwnd) in ids {
            let t = winapi::title(to_hwnd(hwnd));
            if let Some(i) = self.info.get_mut(&id) {
                i.title = t;
            }
        }
    }

    /// A window of an agent's process that is not recorded yet (a dialog, a popup, a second window) is
    /// ghosted now, before the model hears of it. Recorded first, like any hidden window.
    fn keep_agent_window_hidden(&mut self, h: windows_sys::Win32::Foundation::HWND, created: bool) {
        if self.model.agent_shown() || STOPPING.load(Ordering::SeqCst) {
            return;
        }
        let id = id_of(h);
        if self.hidden.contains(id) || !winapi::exists(h) || !winapi::is_top_level(h) {
            return;
        }
        // Created: only a window that will draw as a frame or a dialog (a caption) is worth ghosting before it is
        // shown; the process's invisible helper windows (IME, GDI+) are not. Otherwise it has to be visible.
        if created && !winapi::has_caption(h) {
            return;
        }
        if !created && !winapi::is_visible(h) {
            return;
        }
        let pid = winapi::real_pid(h);
        let e = self.entry_for(id, pid, winapi::process_start(pid), How::Ghost);
        self.hidden.insert(e.clone());
        if let Err(why) = self.persist() {
            self.problem(format!("could not save the record of an agent window ({why}); it is hidden anyway"));
        }
        if cloak::ghost(h).is_none() {
            // It refused: parked, and recorded as parked (the method actually applied), and left alone.
            self.problem(format!("{} would not ghost: parked it instead", window_name(id)));
            winapi::set_pos(h, cloak::PARK, cloak::PARK);
            if let Some(mut e) = self.hidden.remove(id) {
                e.how = How::Park;
                self.hidden.insert(e);
            }
        }
        let _ = self.persist();
    }

    /// The foreground changed. Only an activation you caused may take you to another workspace (R-F1,
    /// R-F2). `cause::foreground_by` decides whose it was, and a close is never yours (R-E1).
    fn on_foreground(&mut self, hwnd: i64) {
        let id = window_name(hwnd);
        if !self.model.is_tracked(&id) || self.model.active() == Some(id.as_str()) {
            return;
        }
        let active_gone = self.model.active().and_then(|w| self.info.get(w)).is_some_and(|i| {
            let h = to_hwnd(i.hwnd);
            !winapi::exists(h) || !winapi::is_visible(h)
        });
        let since_close = self.closed_at.map(|t| winapi::tick_ms().wrapping_sub(t));
        let cause = cause::foreground_by(winapi::idle_ms(), since_close, active_gone, cause::since_asked(hwnd, winapi::tick_ms()));
        self.log(&format!("foreground {id} cause {cause:?}"));
        let _ = self.apply(Event::Activate { window: Some(id), cause });
    }

    /// R-S2: a press on another display puts you on it, even on its bare desktop or taskbar, where no window of yours
    /// takes the front. A press on a window there also activates it, and that follows as before (R-F1).
    fn on_press(&mut self, x: i32, y: i32) {
        let at = winapi::monitor_name_at(x, y);
        let known: Vec<&str> = self.model.monitors().collect();
        let Some(m) = focus::after_press(self.model.focused_monitor(), at.as_deref(), &known).map(String::from) else { return };
        self.log(&format!("a press on {m}: you are on it now"));
        let _ = self.apply(Event::ObserveFocusMonitor { monitor: m });
    }

    fn on_win_event(&mut self, event: u32, hwnd: i64) {
        let h = to_hwnd(hwnd);
        // A window of an agent's process is ghosted the moment it is created or shown, before it paints
        // if the event arrives in time: this is what catches a dialog its app opens.
        if matches!(event, hook::EVENT_OBJECT_CREATE | hook::EVENT_OBJECT_SHOW) && winapi::exists(h) && winapi::is_top_level(h) {
            let pid = winapi::pid_of(h);
            if self.is_agent_pid(pid) {
                self.keep_agent_window_hidden(h, true);
            }
        }
        match event {
            hook::EVENT_SYSTEM_FOREGROUND => {
                if !self.model.is_tracked(&window_name(hwnd)) && winapi::is_manageable(h, false, self.our_pid, self.is_agent_pid(winapi::pid_of(h))) {
                    self.open_window(hwnd, false);
                }
                self.note_elevation(h);
                self.on_foreground(hwnd)
            }
            // A window can become one of ours by being created, shown, restored, uncloaked (a UWP or WinUI window
            // starts cloaked until it has drawn) or titled (one shown untitled first). With no poll to catch it,
            // each of these is a look.
            hook::EVENT_OBJECT_CREATE | hook::EVENT_OBJECT_SHOW | hook::EVENT_SYSTEM_MINIMIZEEND | hook::EVENT_OBJECT_UNCLOAKED | hook::EVENT_OBJECT_NAMECHANGE => {
                let id = window_name(hwnd);
                if self.model.is_tracked(&id) {
                    if event == hook::EVENT_OBJECT_NAMECHANGE {
                        if let Some(i) = self.info.get_mut(&id) {
                            i.title = winapi::title(h);
                        }
                    }
                } else {
                    let agent = self.is_agent_pid(winapi::pid_of(h));
                    if winapi::is_manageable(h, self.hidden.contains(hwnd), self.our_pid, agent) {
                        self.open_window(hwnd, false);
                    }
                }
                // Someone took the cloak off a window we hid (another tool, a virtual desktop switch): read back now.
                if event == hook::EVENT_OBJECT_UNCLOAKED && (self.hidden.contains(hwnd) || self.recheck) {
                    self.recheck_hidden();
                }
            }
            hook::EVENT_OBJECT_DESTROY | hook::EVENT_OBJECT_HIDE => {
                let id = window_name(hwnd);
                // Gone as `resync_windows` would see it: destroyed, or no longer a window we would manage, not one we
                // hid and not one cloaked by someone else (a window on another virtual desktop has not gone).
                let gone = || {
                    !winapi::exists(h)
                        || (!self.hidden.contains(hwnd) && winapi::cloaked(h) == 0 && !winapi::is_manageable(h, false, self.our_pid, self.is_agent_pid(winapi::pid_of(h))))
                };
                if self.model.is_tracked(&id) && gone() {
                    self.close_window(&id);
                }
            }
            // Windows hands the front to the next window in z-order, which may be one we hid (R-E1).
            hook::EVENT_SYSTEM_MINIMIZESTART => self.keep_focus_off_hidden_windows(),
            // A drag or Win+Shift+Arrow may have taken a window to another display (R-V4).
            hook::EVENT_SYSTEM_MOVESIZEEND => self.mirror_moves(),
            _ => {}
        }
    }

    /// The read-back of what is hidden, without looking for new windows: `sync_visibility` alone.
    fn recheck_hidden(&mut self) {
        if let Err(e) = self.sync_visibility() {
            self.problem(format!("could not save the hidden-window record; nothing new was hidden: {e}"));
        }
        self.keep_focus_off_hidden_windows();
    }

    /// Reads `config.toml` and puts its keys in force (spec/keymap.md). A file that does not validate changes nothing:
    /// the keys in force stay (the defaults, at start), and the path and reason go to the log and `state.json`.
    /// `changed_at`: when the folder watcher saw the change, for the log line that times a reload.
    pub fn load_keys(&mut self, changed_at: Option<Instant>) {
        let file = crate::paths::config_file();
        // A file that can't be read is an error like a bad one, never the defaults; its text isn't kept, so the next
        // change in the folder reads it again (an editor that held it open has let go by then).
        let read = keys::read_config(&file);
        if let (Some(_), Ok(text)) = (changed_at, &read) {
            if self.keys.text.as_deref() == Some(text.as_str()) {
                return; // another file in the folder, or a save with nothing new
            }
        }
        let text = read.as_ref().ok().cloned();
        let check = |a: &[String]| crate::request(a.to_vec()).map(|_| ()).map_err(|e| e.error.map(|b| b.message).unwrap_or_default());
        match read.and_then(|text| keys::from_config(&text, check)) {
            Ok((table, skipped)) => {
                self.keys.bindings = table.len();
                hook::set_table(table);
                self.keys.loads += 1;
                self.keys.error = None;
                for s in &skipped {
                    self.log(&format!("keys: {s}"));
                }
                let after = changed_at.map(|t| format!(", {:.0} ms after the change", t.elapsed().as_secs_f64() * 1000.0)).unwrap_or_default();
                say(&format!("baneyspaces daemon: keys: {} bindings from {}{after}", self.keys.bindings, if text.as_deref().unwrap_or("").is_empty() { "the defaults" } else { "config.toml" }));
            }
            Err(e) => {
                if self.keys.loads == 0 {
                    // At start nothing is in force yet: the defaults, so a broken file never leaves you without keys.
                    let table = keys::defaults(keys::parse_mod("win").unwrap_or_default());
                    self.keys.bindings = table.len();
                    hook::set_table(table);
                    self.keys.loads = 1;
                }
                say(&format!("baneyspaces daemon: keys: {} not applied, the keys in force stay: {e}", file.display()));
                self.keys.error = Some(e);
            }
        }
        self.keys.text = text;
        let _ = self.persist();
    }

    fn keys_json(&self) -> Value {
        json!({ "config": crate::paths::config_file(), "bindings": self.keys.bindings, "loads": self.keys.loads, "error": self.keys.error, "blocked_by": self.keys_blocked_by })
    }

    /// The window in front is an elevated program's and this daemon is not elevated: say so once, plainly, instead of
    /// letting every chord vanish without a trace (spec/keymap.md, "Elevated windows").
    fn note_elevation(&mut self, h: windows_sys::Win32::Foundation::HWND) {
        let pid = winapi::pid_of(h);
        let blocked = (!self.keys.elevated_self && pid != 0 && winapi::is_elevated(pid) == Some(true)).then(|| winapi::process_name(pid));
        if blocked == self.keys_blocked_by {
            return;
        }
        match &blocked {
            Some(p) => say(&format!(
                "baneyspaces daemon: keys: {p} runs as administrator (or as another account) and is in front; Windows keeps keys typed into it from BaneySpaces (UIPI), so your BaneySpaces keys do nothing until another window is in front"
            )),
            None => say("baneyspaces daemon: keys: the window in front takes your BaneySpaces keys again"),
        }
        self.keys_blocked_by = blocked;
        let _ = self.persist();
    }

    /// `window focus|swap|resize|display` on the front window. Only windows you can see take part.
    fn window_op(&mut self, op: &str, args: &Value) -> Envelope {
        let Some(id) = self.front_window() else {
            return Envelope::err("not_found", "no window of yours is in front", Retry::Never, "Click the window first.");
        };
        let h = to_hwnd(self.info.get(&id).map(|i| i.hwnd).unwrap_or(0));
        let Some(r) = winapi::rect(h) else {
            return Envelope::err("not_found", format!("{id} has no frame"), Retry::Safe, "");
        };
        match op {
            "window_resize" => {
                let d = |k: &str| args[k].as_i64().unwrap_or(0) as i32;
                // Never smaller than 100 x 100: a key held down must not shrink a window to nothing.
                let to = [r[0], r[1], r[0] + (r[2] - r[0] + d("dx")).max(100), r[1] + (r[3] - r[1] + d("dy")).max(100)];
                winapi::set_frame(h, to);
                Envelope::ok(json!({ "window": id, "frame": winapi::rect(h) }))
            }
            "window_focus" | "window_swap" => {
                let dir = args["dir"].as_str().unwrap_or("");
                let others: Vec<(String, [i32; 4])> = self
                    .info
                    .iter()
                    .filter(|(o, i)| **o != id && !self.hidden.contains(i.hwnd))
                    .filter(|(_, i)| {
                        let w = to_hwnd(i.hwnd);
                        winapi::is_visible(w) && !winapi::is_iconic(w) && winapi::cloaked(w) == 0
                    })
                    .filter_map(|(o, i)| winapi::rect(to_hwnd(i.hwnd)).map(|f| (o.clone(), f)))
                    .collect();
                let Some((other, of)) = keys::neighbor(r, dir, &others).cloned() else {
                    return Envelope::ok(json!({ "window": id, "changed": false, "note": format!("no window you can see to the {dir}") }));
                };
                let oh = to_hwnd(self.info.get(&other).map(|i| i.hwnd).unwrap_or(0));
                if op == "window_focus" {
                    winapi::set_foreground(oh);
                } else {
                    winapi::set_frame(h, of);
                    winapi::set_frame(oh, r);
                    // A swap can cross displays, and SetWindowPos raises no move event: the model follows here (R-V4).
                    self.mirror_moves();
                }
                Envelope::ok(json!({ "window": id, "other": other, "changed": true }))
            }
            _ => {
                let all: Vec<(String, displays::Rect)> = winapi::monitors().into_iter().map(|m| (m.name, m.rect)).collect();
                let here = displays::display_of(r, &all).and_then(|d| all.iter().position(|(n, _)| n == d)).unwrap_or(0);
                if all.len() < 2 {
                    return Envelope::ok(json!({ "window": id, "changed": false, "note": "one display: nowhere to send it" }));
                }
                let step = if args["to"] == "prev" { all.len() - 1 } else { 1 };
                let to = all[(here + step) % all.len()].0.clone();
                if let Some(f) = displays::carried(r, &all, &to, winapi::is_zoomed(h)) {
                    winapi::set_frame(h, f);
                }
                // R-V4: it now belongs to the workspace that display shows.
                self.mirror_moves();
                Envelope::ok(json!({ "window": id, "display": to, "changed": true }))
            }
        }
    }

    /// The window you mean when you did not name one: the front window, if it is one of ours.
    fn front_window(&self) -> Option<String> {
        let id = window_name(id_of(winapi::foreground()));
        self.model.is_tracked(&id).then_some(id)
    }
}

// ---- requests -----------------------------------------------------------------------------

fn arg_str<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(Value::as_str)
}

fn arg_n(a: &Value) -> Result<u8, Envelope> {
    a.get("n")
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .and_then(|n| u8::try_from(n).ok())
        .ok_or_else(|| Envelope::err("invalid_args", "a workspace number 1 to 9 is required", Retry::Never, "Example: baneyspaces switch 3"))
}

fn effects_json(fx: &[Effect]) -> Value {
    serde_json::to_value(fx).unwrap_or(Value::Null)
}

fn model_err(e: ModelError) -> Envelope {
    Envelope::from_model(&e)
}

/// Operations only you may ask for. An agent's process (one BaneySpaces started, or anything it
/// started) is refused: agents never change your workspaces, your windows or the daemon. The three
/// appearance settings are the exception (Donovan, 2026-11-01): an agent may customize them, and
/// every `set` is logged with who asked.
const USER_OPS: &[&str] = &["switch", "move", "focus_monitor", "window_focus", "window_swap", "window_resize", "window_display", "overview", "agent_show", "agent_hide", "agent_toggle", "agent_move", "agent_bring", "quit"];

/// Is the process on the other end of the pipe an agent's? By pid, against the model and the jobs.
fn peer_is_agent(c: &Core, pid: u32) -> bool {
    c.is_agent_pid(pid)
}

/// Watches the folder `config.toml` lives in and sends `Msg::Reload` on every change, so a saved file is in force
/// within a few milliseconds (spec/keymap.md: under 1 s). The folder is made if it is missing.
fn watch_config(file: PathBuf, tx: Sender<Msg>) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{FindFirstChangeNotificationW, FindNextChangeNotification, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE};
    use windows_sys::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    let Some(dir) = file.parent().map(PathBuf::from) else { return };
    let _ = std::fs::create_dir_all(&dir);
    std::thread::spawn(move || unsafe {
        let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let h = FindFirstChangeNotificationW(wide.as_ptr(), 0, FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_SIZE);
        if h == INVALID_HANDLE_VALUE {
            say(&format!("baneyspaces daemon: keys: cannot watch {}; config.toml is read at start only", dir.display()));
            return;
        }
        while WaitForSingleObject(h, INFINITE) == 0 {
            let at = Instant::now();
            // An editor saves in steps (truncate, write, rename): read once the folder has been quiet for 30 ms. The
            // watch is re-armed before each wait, so a step that lands after the read wakes the next round.
            let mut armed = true;
            keys::settle(30, 500, |ms| {
                armed = FindNextChangeNotification(h) != 0;
                armed && WaitForSingleObject(h, ms) == 0
            });
            if tx.send(Msg::Reload { at }).is_err() || !armed {
                break;
            }
        }
    });
}

pub fn handle(shared: &Shared, req: &Value) -> Envelope {
    let op = req["op"].as_str().unwrap_or("");
    if USER_OPS.contains(&op) {
        let peer = req["_peer_pid"].as_u64().unwrap_or(0) as u32;
        if peer_is_agent(&lock(shared), peer) {
            return Envelope::err("not_in_scope", format!("{op} is for you, not an agent: it was refused"), Retry::Never, "Agents work inside the agent workspace; only the person using this PC changes workspaces and settings.");
        }
    }
    let args = req.get("args").cloned().unwrap_or_else(|| json!({}));
    let agent = req["agent"].as_str().unwrap_or("agent").to_string();
    match op {
        "ping" => Envelope::ok(json!({ "pong": true, "pid": std::process::id() })),
        "quit" => {
            let c = lock(shared);
            let _ = c.tx.send(Msg::Quit);
            Envelope::ok(json!({ "stopping": true, "note": "your windows are being put back; agent windows stay hidden" }))
        }
        "switch" => {
            let n = match arg_n(&args) {
                Ok(n) => n,
                Err(e) => return e,
            };
            let monitor = arg_str(&args, "monitor").map(String::from);
            let mut c = lock(shared);
            c.sync_monitors();
            match c.apply_checked(Event::Switch { n, monitor }) {
                Ok(fx) => Envelope::ok(json!({ "workspace": n, "effects": effects_json(&fx) })),
                Err(e) => e,
            }
        }
        "move" => {
            let n = match arg_n(&args) {
                Ok(n) => n,
                Err(e) => return e,
            };
            let mut c = lock(shared);
            let follow = !args.get("stay").and_then(Value::as_bool).unwrap_or(false);
            let window = match resolve_window(&c, &args) {
                Ok(w) => w,
                Err(e) => return e,
            };
            match c.apply_checked(Event::Move { n, window, follow }) {
                Ok(fx) => Envelope::ok(json!({ "workspace": n, "follow": follow, "effects": effects_json(&fx) })),
                Err(e) => e,
            }
        }
        "window_focus" | "window_swap" | "window_resize" | "window_display" => lock(shared).window_op(op, &args),
        "focus_monitor" => {
            let mut c = lock(shared);
            match c.apply_checked(Event::FocusMonitor { monitor: arg_str(&args, "monitor").unwrap_or("").into() }) {
                Ok(fx) => Envelope::ok(json!({ "effects": effects_json(&fx) })),
                Err(e) => e,
            }
        }
        "get" => {
            let c = lock(shared);
            match arg_str(&args, "key") {
                None => Envelope::ok(Value::Object(c.settings.clone())),
                Some(k) => match c.settings.get(k) {
                    Some(v) => Envelope::ok(json!({ k: v })),
                    None => Envelope::err("invalid_args", format!("unknown setting {k:?}"), Retry::Never, format!("The settings are {}.", settings::KEYS.join(", "))),
                },
            }
        }
        "set" => {
            let (Some(k), Some(v)) = (arg_str(&args, "key"), arg_str(&args, "value")) else {
                return Envelope::err("invalid_args", "usage: set <key> <value>", Retry::Never, "Example: baneyspaces set dock.enabled false");
            };
            match settings::validate(k, v) {
                Err(m) => Envelope::err("invalid_args", m, Retry::Never, format!("The settings are {}.", settings::KEYS.join(", "))),
                Ok(val) => {
                    let mut c = lock(shared);
                    let mut next = c.settings.clone();
                    next.insert(k.to_string(), val.clone());
                    let text = serde_json::to_string_pretty(&Value::Object(next.clone())).unwrap_or_default();
                    if let Err(e) = c.paths.write_atomic("settings.json", &text) {
                        return Envelope::err("internal", format!("the setting was not saved: {e}"), Retry::Safe, "Nothing changed; try again.");
                    }
                    c.settings = next;
                    let _ = c.persist();
                    // Who asked: the agent id and the pipe peer's pid, never the value.
                    let peer = req["_peer_pid"].as_u64().map(|p| p as u32).filter(|p| *p != 0);
                    let env = Envelope::ok(json!({}));
                    c.paths.append_action(&ActionRecord::from_result(now(), &agent, "set", peer, None, None, &format!("settings:{k}"), &env).to_line(), now(), &c.last_prune);
                    if k == "bar.enabled" {
                        let on = val == json!(true);
                        crate::bar::set_enabled(on);
                        return Envelope::ok(json!({ k: val, "note": if on { "the top bar is coming up on every display" } else { "the top bar is going; the work area comes back" } }));
                    }
                    Envelope::ok(json!({ k: val, "note": "stored; the themed UI and the dock arrive in Windows part 2" }))
                }
            }
        }
        "state" => {
            let c = lock(shared);
            let mut v = c.model.view();
            v["version"] = json!(1);
            v["platform"] = json!("windows");
            v["hidden"] = c.hidden.to_json();
            v["keys"] = c.keys_json();
            v["bar"] = crate::bar::status();
            Envelope::ok(v)
        }
        "ls" => Envelope::ok(ls(&lock(shared))),
        "overview" => {
            let mut c = lock(shared);
            c.overview_shown = !c.overview_shown;
            let _ = c.persist();
            Envelope::ok(json!({ "shown": c.overview_shown, "note": "recorded in state.json; the overview itself arrives in part 2" }))
        }
        "agent_show" | "agent_hide" | "agent_toggle" => {
            let ev = match op {
                "agent_show" => Event::AgentShow,
                "agent_hide" => Event::AgentHide,
                _ => Event::AgentToggle,
            };
            let mut c = lock(shared);
            match c.apply_checked(ev) {
                Ok(fx) => Envelope::ok(json!({ "shown": c.model.agent_shown(), "effects": effects_json(&fx) })),
                Err(e) => e,
            }
        }
        "agent_move" | "agent_bring" => {
            let Some(w) = arg_str(&args, "window").map(String::from) else {
                return Envelope::err("invalid_args", "a window id is required", Retry::Never, "Run `baneyspaces ls` for window ids.");
            };
            let mut c = lock(shared);
            let ev = if op == "agent_move" { Event::AgentSend { window: w } } else { Event::AgentBring { window: w } };
            match c.apply_checked(ev) {
                Ok(fx) => Envelope::ok(json!({ "effects": effects_json(&fx) })),
                Err(e) => e,
            }
        }
        "agent_status" | "agent_windows" => Envelope::ok(agent_status(&lock(shared))),
        "agent_open" => agent_open(shared, &agent, &args),
        "agent_run" => agent_run(shared, &agent, &args),
        "agent_log" => agent_log(&lock(shared), &args),
        _ => Envelope::err("invalid_args", format!("unknown operation {op:?}"), Retry::Never, "Run `baneyspaces help`."),
    }
}

/// `--window w-123` (or a bare hwnd), `--app notepad`, else the front window.
fn resolve_window(c: &Core, args: &Value) -> Result<Option<String>, Envelope> {
    if let Some(w) = arg_str(args, "window") {
        return match winapi::parse_window_name(w) {
            Some(n) => Ok(Some(window_name(n))),
            None => Err(Envelope::err("invalid_args", format!("{w:?} is not a window id"), Retry::Never, "Window ids look like w-197330; `baneyspaces ls` lists them.")),
        };
    }
    if let Some(app) = arg_str(args, "app") {
        let want = app.to_lowercase();
        let want = want.strip_suffix(".exe").unwrap_or(&want).to_string();
        let mut hits: Vec<&String> = c.info.iter().filter(|(id, i)| i.app == want && !c.model.is_agent_window(id)).map(|(id, _)| id).collect();
        hits.sort();
        return match hits.as_slice() {
            [] => Err(Envelope::err("not_found", format!("no open window of {app}"), Retry::Safe, "Run `baneyspaces ls`.")),
            [one] => Ok(Some((*one).clone())),
            many => Err(Envelope::err("ambiguous", format!("{} windows of {app}: {}", many.len(), many.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")), Retry::Never, "Name one with --window.")),
        };
    }
    Ok(c.front_window())
}

fn ls(c: &Core) -> Value {
    let view = c.model.view();
    let mut spaces = serde_json::Map::new();
    if let Some(ws) = view["workspaces"].as_object() {
        for (k, list) in ws {
            let rows: Vec<Value> = list
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|w| {
                    let i = c.info.get(w);
                    let h = i.and_then(|i| c.hidden.get(i.hwnd));
                    json!({ "window": w, "app": i.map(|i| i.app.clone()).unwrap_or_default(), "title": i.map(|i| i.title.clone()).unwrap_or_default(), "pid": i.map(|i| i.pid), "hidden": h.map(|h| h.how) })
                })
                .collect();
            spaces.insert(k.clone(), json!(rows));
        }
    }
    json!({ "focused_monitor": view["focused_monitor"], "active": view["active"], "monitors": view["monitors"], "workspaces": spaces, "agent": agent_status(c) })
}

fn agent_status(c: &Core) -> Value {
    let windows: Vec<Value> = c
        .model
        .agent_windows()
        .into_iter()
        .map(|w| {
            let i = c.info.get(w);
            let pid = c.model.pid_of(w);
            // Whether an agent started it, or it is one of yours parked here.
            let owned = pid.is_some_and(|p| c.model.agent_proc(p).is_some());
            json!({ "window": w, "app": i.map(|i| i.app.clone()).unwrap_or_default(), "title": i.map(|i| i.title.clone()).unwrap_or_default(), "pid": pid, "agent_owned": owned })
        })
        .collect();
    json!({ "workspace": AGENT_WORKSPACE, "shown": c.model.agent_shown(), "windows": windows, "processes": c.model.agent_pids().len(), "refused": c.model.refused() })
}

// Every field of one action-log row; a struct for them would be built at each call and used once.
#[allow(clippy::too_many_arguments)]
fn record(c: &Core, agent: &str, verb: &str, pid: Option<u32>, window: Option<&str>, reference: Option<&str>, route: &str, env: &Envelope) {
    c.paths.append_action(&ActionRecord::from_result(now(), agent, verb, pid, window, reference, route, env).to_line(), now(), &c.last_prune);
}

fn agent_log(c: &Core, args: &Value) -> Envelope {
    let since = args.get("since").and_then(Value::as_u64).map(|s| now().saturating_sub(s)).unwrap_or(0);
    let log = baneyspaces_core::ActionLog::parse(&c.paths.read("actions.jsonl").unwrap_or_default());
    let rows: Vec<&ActionRecord> = log.records.iter().filter(|r| r.at >= since).collect();
    Envelope::ok(json!({ "records": rows, "retention_days": baneyspaces_core::agent::RETENTION_DAYS }))
}

fn path_dirs() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Ok(w) = std::env::var("SystemRoot") {
        v.push(PathBuf::from(&w).join("System32"));
        v.push(PathBuf::from(w));
    }
    v
}

/// Starts `exe args` as a new process in its own job on the agent workspace, then waits for a window of its own.
fn launch_on_agent(shared: &Shared, agent: &str, label: &str, exe: PathBuf, args: Vec<String>, cwd: Option<String>, console: bool) -> Envelope {
    let (spawned, known): (agent::Spawned, BTreeSet<String>) = {
        // The lock is held across the spawn: the process is registered before its first window can be seen.
        let mut c = lock(shared);
        let known: BTreeSet<String> = c.model.window_ids().into_iter().map(String::from).collect();
        let Some(job) = c.job.as_ref() else {
            return Envelope::err("internal", "the agent job object is not available", Retry::Safe, "Restart the daemon.");
        };
        match agent::spawn(&exe, &args, cwd.as_deref(), job, console) {
            Ok(s) => {
                let _ = c.apply(Event::AgentRegister { pid: s.pid, start: s.start });
                (s, known)
            }
            Err(e) => {
                let env = Envelope::err("internal", e, Retry::Safe, "Check the path and try again.");
                record(&c, agent, "open", None, None, None, "createprocess", &env);
                return env;
            }
        }
    };
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(40));
        let mut c = lock(shared);
        c.resync_windows(false);
        let found = c.model.agent_windows().into_iter().find(|w| !known.contains(*w) && c.model.pid_of(w).is_some_and(|p| p == spawned.pid || c.job.as_ref().is_some_and(|j| agent::in_job(j, p)))).map(String::from);
        if let Some(w) = found {
            let i = c.info.get(&w).cloned();
            let env = Envelope::ok(json!({ "window": w, "pid": c.model.pid_of(&w), "app": label, "title": i.as_ref().map(|i| i.title.clone()), "workspace": "agent", "start": spawned.start }));
            record(&c, agent, "open", Some(spawned.pid), Some(&w), None, "createprocess", &env);
            return env;
        }
    }
    let c = lock(shared);
    let alive = winapi::alive(spawned.pid, spawned.start);
    let appeared: Vec<String> = c.model.window_ids().into_iter().filter(|w| !known.contains(*w) && !c.model.is_agent_window(w)).map(String::from).collect();
    let env = if !appeared.is_empty() {
        Envelope::err("single_instance", format!("{label} opened its window in a copy that was already running, not in a process of its own"), Retry::Never, "Nothing was driven. The window that opened is left where it is, on your workspace.").with_data(json!({ "windows_that_appeared": appeared }))
    } else if !alive {
        Envelope::err("single_instance", format!("{label} exited without a window of its own: it most likely handed the request to an instance that was already running"), Retry::Never, "Agents only drive a process BaneySpaces started. Use the app's files or command line instead, or ask the user to lend it.")
    } else {
        Envelope::err("timeout", format!("{label} is running (pid {}) but opened no window within 8 s", spawned.pid), Retry::Never, "Check `baneyspaces agent status`; the app may be slow to start.")
    };
    record(&c, agent, "open", Some(spawned.pid), None, None, "createprocess", &env);
    env
}

fn agent_open(shared: &Shared, agent: &str, args: &Value) -> Envelope {
    let Some(app) = arg_str(args, "app") else {
        return Envelope::err("invalid_args", "an app is required", Retry::Never, "Example: baneyspaces agent open notepad");
    };
    if !apps::may_start(app) {
        let env = Envelope::err(
            "needs_sandbox",
            format!("{app} was not started: on Windows an agent may not start any app until there is a sandbox"),
            Retry::Never,
            "No Windows app is safe to hand an agent yet: Notepad would show it your unsaved tabs, and most apps forward a launch into the copy you already run. A Windows sandbox (Windows Sandbox or a Hyper-V VM) is a later part. Use files or the command line instead.",
        )
        .with_data(json!({ "allowed": apps::allowed() }));
        record(&lock(shared), agent, "open", None, None, None, "preflight", &env);
        return env;
    }
    let Some(exe) = cmdline::find_program(app, &path_dirs(), |p| p.is_file()) else {
        return Envelope::err("not_found", format!("no program {app:?} on PATH"), Retry::Never, "Give an executable name or a full path.");
    };
    let extra: Vec<String> = args.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
    launch_on_agent(shared, agent, app, exe, extra, None, false)
}

fn agent_run(shared: &Shared, agent: &str, _args: &Value) -> Envelope {
    // A console window on Windows is owned by Windows Terminal or conhost, a process BaneySpaces did not
    // start, so the window cannot be tied to the agent's process. Refused rather than guessed at.
    let env = Envelope::err(
        "needs_sandbox",
        "agent run is not available on Windows in part 1: a console window belongs to Windows Terminal, not to the process BaneySpaces would start",
        Retry::Never,
        "Use `agent open` for an app on the list, or run the command yourself. Terminals arrive with the sandbox in a later part.",
    )
    .with_data(json!({ "allowed": apps::allowed() }));
    record(&lock(shared), agent, "run", None, None, None, "preflight", &env);
    env
}

// ---- putting windows back ------------------------------------------------------------------

/// A window put back with no workspace to show it on lands on a display: a parked one at its recorded frame, a
/// cloaked one where it is. Either could be on a display unplugged since it was hidden (R-M3).
fn onto_a_display(h: &mut Hidden) {
    let all: Vec<(String, displays::Rect)> = winapi::monitors().into_iter().map(|m| (m.name, m.rect)).collect();
    let w = to_hwnd(h.hwnd);
    match h.how {
        How::Park | How::Ghost => {
            if let Some(r) = h.rect.and_then(|r| displays::onto_a_display(r, &all)) {
                h.rect = Some(r);
            }
        }
        How::Cloak => {
            if let Some(r) = winapi::rect(w).filter(|_| !winapi::is_iconic(w)).and_then(|r| displays::onto_a_display(r, &all)) {
                winapi::set_frame(w, r);
            }
        }
    }
}

/// Reads `state.json` and shows every window a run left hidden, except agent windows whose process
/// still runs (they belong on the agent workspace). Works from the file alone, so it serves a
/// start after a crash, a clean exit and a panic alike. A window that does not read back as shown
/// keeps its entry, for the next try. Returns (shown and verified, kept on the agent workspace, still hidden).
pub fn restore_from_file(paths: &Paths, keep_agents: bool) -> (usize, usize, usize) {
    let left = hidden::parse_state(&paths.read("state.json").unwrap_or_default());
    // Only the window the entry was written for is touched: the class and the owning process (pid and start
    // time) must still match. After a reboot, or once the window was destroyed and its handle reused, they do not,
    // and the entry is dropped and logged without touching anything.
    let exists = |h: &Hidden| {
        let ok = cloak::identity_ok(h);
        if !ok && winapi::exists(to_hwnd(h.hwnd)) {
            say(&format!("baneyspaces daemon: {} is not the window that was hidden (a different class or process); left alone", window_name(h.hwnd)));
        }
        ok && (h.how != How::Ghost || ((h.pid == 0 || winapi::real_pid(to_hwnd(h.hwnd)) == h.pid) && (h.start == 0 || winapi::process_start(h.pid) == h.start)))
    };
    let alive = |pid, start| keep_agents && winapi::alive(pid, start);
    let plan = hidden::recovery_plan(&left, exists, alive);
    let cloaker = Cloaker::new().ok();
    let (mut shown, mut kept, mut failed) = (0, 0, 0);
    let mut still: Vec<Hidden> = vec![];
    for p in plan {
        match p {
            Recovery::Show(mut h) => {
                onto_a_display(&mut h);
                if cloak::show(&h, cloaker.as_ref()) {
                    shown += 1;
                } else {
                    failed += 1;
                    still.push(h);
                }
            }
            Recovery::KeepOnAgent(h) => {
                kept += 1;
                still.push(h);
            }
            Recovery::Gone(_) => {}
        }
    }
    // Rewrite the file with only what is still hidden. Everything else in it is the old view.
    let text = paths.read("state.json").unwrap_or_default();
    let mut v: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    v["hidden"] = serde_json::to_value(&still).unwrap_or_default();
    let _ = paths.write_atomic("state.json", &serde_json::to_string_pretty(&v).unwrap_or_default());
    (shown, kept, failed)
}

// ---- the control pipe -----------------------------------------------------------------------

mod pipe {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
    use windows_sys::Win32::System::Pipes::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Makes instances of the control pipe: this user and SYSTEM only, no remote clients.
    #[derive(Clone)]
    pub struct Server {
        name: Vec<u16>,
        sddl: Vec<u16>,
    }

    impl Server {
        pub fn new(name: &str) -> Option<Self> {
            let sid = crate::winapi::user_sid_string()?;
            Some(Self { name: wide(name), sddl: wide(&format!("D:P(A;;GA;;;{sid})(A;;GA;;;SY)")) })
        }

        /// One more instance of the pipe, waiting for a client. The very first one (`first`) fails if the
        /// name is already in use, which is how a second daemon (or a squatter) is told apart.
        pub fn create(&self, first: bool) -> Result<HANDLE, String> {
            unsafe {
                let mut sd = std::ptr::null_mut();
                if ConvertStringSecurityDescriptorToSecurityDescriptorW(self.sddl.as_ptr(), 1, &mut sd, std::ptr::null_mut()) == 0 {
                    return Err(format!("security descriptor (error {})", GetLastError()));
                }
                let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
                let mut open = PIPE_ACCESS_DUPLEX;
                if first {
                    open |= FILE_FLAG_FIRST_PIPE_INSTANCE;
                }
                let h = CreateNamedPipeW(self.name.as_ptr(), open, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, 1 << 16, 1 << 16, 0, &sa);
                LocalFree(sd);
                if h == INVALID_HANDLE_VALUE {
                    return Err(format!("cannot create the pipe (error {})", GetLastError()));
                }
                Ok(h)
            }
        }
    }

    /// Waits for a client on `h` and returns the connected pipe as a `File`.
    pub fn connect(h: HANDLE) -> Result<std::fs::File, String> {
        unsafe {
            if ConnectNamedPipe(h, std::ptr::null_mut()) == 0 && GetLastError() != 535 {
                // 535 = ERROR_PIPE_CONNECTED: the client got in first, which is fine.
                windows_sys::Win32::Foundation::CloseHandle(h);
                return Err("connect failed".into());
            }
            Ok(std::fs::File::from_raw_handle(h as *mut _))
        }
    }
}

/// `subscribe`: hands the pipe to the shell's feed, which writes to it from now on. Nothing is written to the pipe
/// with the core held: a client that subscribes and never reads must not stall the daemon.
fn subscribe(shared: &Shared, peer: u32, mut pipe: Pipe) {
    let c = lock(shared);
    if !peer_is_agent(&c, peer) {
        // Handed over with the core held, so no change can publish between the state read here and the feed taking
        // it: the new shell never starts on a state older than the feed's last. The feed's channel never blocks.
        if let Some(feed) = &c.feed {
            feed(crate::feed::FeedMsg::Greet(pipe, Envelope::ok(json!({ "subscribed": true })).to_json(), c.shell_line()));
        }
        return;
    }
    drop(c);
    let env = Envelope::err("not_in_scope", "subscribe is for your shell, not an agent: it was refused", Retry::Never, "Agents read `state` instead.");
    let _ = writeln!(pipe, "{}", env.to_json());
}

/// One request, one answer. Anything that is not a JSON object is refused; the peer is what the pipe says.
fn serve_conn(shared: Shared, f: std::fs::File) {
    let mut line = String::new();
    {
        let mut r = BufReader::new(&f).take(1 << 20);
        if r.read_line(&mut line).is_err() {
            return;
        }
    }
    let peer = {
        let mut pid = 0u32;
        unsafe { windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId(std::os::windows::io::AsRawHandle::as_raw_handle(&f) as _, &mut pid) };
        pid
    };
    // `subscribe`: the shell's feed. This connection stays open and the feed thread writes to it from now on.
    if serde_json::from_str::<Value>(&line).is_ok_and(|v| v["op"] == "subscribe") {
        return subscribe(&shared, peer, Box::new(f));
    }
    let env = match serde_json::from_str::<Value>(&line) {
        Ok(Value::Object(mut req)) => {
            req.insert("_peer_pid".into(), json!(peer));
            handle(&shared, &Value::Object(req))
        }
        Ok(_) => Envelope::err("invalid_args", "a request is one JSON object", Retry::Never, "Example: {\"op\":\"ping\"}"),
        Err(e) => Envelope::err("invalid_args", format!("bad request: {e}"), Retry::Never, ""),
    };
    let mut f = f;
    let _ = writeln!(f, "{}", env.to_json());
    let _ = f.flush();
    // Wait for the client to read before the handle closes.
    unsafe { windows_sys::Win32::Storage::FileSystem::FlushFileBuffers(std::os::windows::io::AsRawHandle::as_raw_handle(&f) as _) };
}

/// Always listening: each listener makes the next instance of the pipe the moment a client connects,
/// and there are two of them, so there is no moment with no free instance.
fn listen(shared: Shared, server: pipe::Server, first: Option<usize>) {
    let mut ready = first;
    loop {
        let h = match ready.take() {
            Some(h) => h as windows_sys::Win32::Foundation::HANDLE,
            None => match server.create(false) {
                Ok(h) => h,
                Err(e) => {
                    say(&format!("baneyspaces daemon: {e}"));
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }
            },
        };
        match pipe::connect(h) {
            Ok(conn) => {
                let shared = shared.clone();
                std::thread::spawn(move || serve_conn(shared, conn));
            }
            Err(e) => {
                say(&format!("baneyspaces daemon: {e}"));
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

unsafe extern "system" fn ctrl_handler(kind: u32) -> i32 {
    // Ctrl+C, Ctrl+Break, console close (a foreground daemon): put the windows back, then exit.
    let _ = kind;
    if let Some(tx) = CTRL_TX.get() {
        STOPPING.store(true, Ordering::SeqCst);
        let _ = tx.send(Msg::Quit);
        let t = Instant::now();
        while !FINISHED.load(Ordering::SeqCst) && t.elapsed() < Duration::from_secs(8) {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    1
}

/// Sign-out and shutdown, heard by the daemon's hidden window (a background daemon has no console, so no
/// console event ever reaches it). Windows are put back before apps are asked to save, so a "save changes?"
/// prompt is not raised on a window nobody can see.
fn on_end_session(e: EndSession) {
    let (Some(paths), Some(shared)) = (PATHS.get(), SHARED.get()) else { return };
    match e {
        EndSession::Query | EndSession::Ending => {
            // One critical section: STOPPING is set *under the lock* (so a poll or request in flight finishes
            // first, and every later one sees it), the windows are restored from the record, and the in-memory
            // set is reloaded from what the restore left, all before anyone else can write. Nothing re-hides
            // a window while this runs, and nothing else writes state.json.
            let mut c = lock(shared);
            STOPPING.store(true, Ordering::SeqCst);
            let r = restore_from_file(paths, true);
            c.reload_hidden_from_file();
            drop(c);
            say(&format!("baneyspaces daemon: {e:?}: {} window(s) put back, {} agent window(s) stay, {} not restored", r.0, r.1, r.2));
            if e == EndSession::Ending {
                crate::bar::remove_all();
                std::process::exit(0);
            }
        }
        EndSession::Cancelled => {
            // Cancelled: carry on, and look at everything at once, which hides again what belongs on a hidden workspace.
            let _c = lock(shared);
            STOPPING.store(false, Ordering::SeqCst);
            if let Some(tx) = CTRL_TX.get() {
                let _ = tx.send(Msg::Resync);
            }
        }
    }
}

/// One daemon per user: a named mutex, taken before anything is touched. None means another is running.
pub fn single_instance(paths: &Paths) -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let name: Vec<u16> = paths.mutex_name().encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if h.is_null() || GetLastError() == ERROR_ALREADY_EXISTS {
            return None;
        }
        Some(h)
    }
}

impl Core {
    /// Replaces the in-memory hidden set with what `state.json` says is still hidden (after a restore).
    pub fn reload_hidden_from_file(&mut self) {
        let left = hidden::parse_state(&self.paths.read("state.json").unwrap_or_default());
        // The restore wrote state.json itself: the next persist must write, whatever it last wrote.
        self.written.borrow_mut().clear();
        self.hidden = HiddenSet::default();
        for h in left.hidden {
            self.hidden.insert(h);
        }
    }

    /// R-V4: a window you moved to another display (a drag, Win+Shift+Arrow) joins the workspace that display shows,
    /// so the next switch on the display it left does not hide it. Only windows on screen count: a hidden one stays
    /// where it was hidden, and is carried when it is shown. The front window takes you with it, as a click would.
    fn mirror_moves(&mut self) {
        let all: Vec<(String, displays::Rect)> = winapi::monitors().into_iter().map(|m| (m.name, m.rect)).collect();
        let on_screen: Vec<(String, u8, displays::Rect)> = self
            .info
            .iter()
            .filter(|(_, i)| !self.hidden.contains(i.hwnd) && !winapi::is_iconic(to_hwnd(i.hwnd)))
            .filter_map(|(id, i)| match self.model.home(id) {
                Some(Home::Workspace { n }) => winapi::rect(to_hwnd(i.hwnd)).map(|r| (id.clone(), *n, r)),
                _ => None,
            })
            .collect();
        let moved = displays::moved_across(&on_screen, &all, |d| self.model.current(d));
        for (id, display, m) in moved {
            self.log(&format!("{id} was moved to {display}: now on workspace {m}"));
            let front = self.model.active() == Some(id.as_str());
            let _ = self.apply(Event::ObserveMove { window: id.clone(), n: Some(m) });
            if front {
                let _ = self.apply(Event::Activate { window: Some(id), cause: Cause::User });
            }
        }
    }

    /// One poll: monitors, windows, what is hidden checked against Windows, focus.
    fn poll(&mut self) {
        // An agent process that exited, or whose pid Windows gave to another program, is forgotten.
        for (pid, start) in self.model.agent_pids() {
            if !winapi::alive(pid, start) || start == 0 {
                let _ = self.apply(Event::AgentExit { pid });
            }
        }
        self.sync_monitors();
        self.resync_windows(false);
        self.mirror_moves();
        if let Err(e) = self.sync_visibility() {
            self.problem(format!("could not save the hidden-window record; nothing new was hidden: {e}"));
        }
        self.keep_focus_off_hidden_windows();
        let _ = self.persist();
    }
}

pub fn run(trace: bool, log: Option<PathBuf>) -> i32 {
    if let Some(p) = log {
        if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            let _ = LOG.set(Mutex::new(f));
        }
    }
    let paths = Paths::from_env();
    if let Err(e) = paths.ensure() {
        say(&format!("baneyspaces daemon: {e}"));
        return 1;
    }
    let _ = PATHS.set(paths.clone());
    // 1. One daemon only, decided before anything is touched: a named mutex, then the first instance of
    //    the pipe (which fails if anything else already made it). A second daemon must never get as far as
    //    putting the first one's windows back.
    let Some(_mutex) = single_instance(&paths) else {
        say("baneyspaces daemon: already running");
        return 1;
    };
    let Some(server) = pipe::Server::new(&paths.pipe_name()) else {
        say("baneyspaces daemon: cannot read your account to protect the control pipe");
        return 1;
    };
    let first = match server.create(true) {
        Ok(h) => h as usize,
        Err(e) => {
            say(&format!("baneyspaces daemon: {e}: is another daemon, or something else, using the pipe?"));
            return 1;
        }
    };
    // 2. Whatever a previous run left hidden comes back first, before anything else is done.
    let (shown, kept, failed) = restore_from_file(&paths, true);
    if shown + kept + failed > 0 {
        say(&format!("baneyspaces daemon: put back {shown} window(s) a previous run left hidden; {kept} agent window(s) stay on the agent workspace; {failed} could not be shown yet (will retry)"));
    }
    let (tx, rx): (Sender<Msg>, Receiver<Msg>) = channel();
    let core = Core {
        model: Model::new(),
        paths: paths.clone(),
        hidden: HiddenSet::default(),
        info: HashMap::new(),
        job: agent::open_job(&format!("Local\\BaneySpaces-Agents-{}", crate::paths::user_key())),
        overview_shown: false,
        events_seen: 0,
        closed_at: None,
        started: now(),
        trace,
        our_pid: std::process::id(),
        problems: vec![],
        settings: settings::parse(&paths.read("settings.json").unwrap_or_default()),
        tx: tx.clone(),
        last_prune: std::cell::Cell::new(0),
        feed: Some({
            let tx = crate::feed::spawn::<Pipe>();
            Arc::new(move |m| {
                // The top bar draws the same state the shell hears; handing it over never blocks.
                if let crate::feed::FeedMsg::Publish(line) = &m {
                    crate::bar::publish(line);
                }
                let _ = tx.send(m);
            })
        }),
        written: std::cell::RefCell::new(String::new()),
        recheck: true,
        keys: KeysState { elevated_self: winapi::is_elevated(std::process::id()) == Some(true), ..KeysState::default() },
        keys_blocked_by: None,
    };
    let shared: Shared = Arc::new(Mutex::new(core));
    let _ = SHARED.set(shared.clone());
    // A panic anywhere puts the windows back and ends the process: running on after that would be running on a
    // set of hidden windows that no longer matches the screen.
    {
        let paths = paths.clone();
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            prev(info);
            STOPPING.store(true, Ordering::SeqCst);
            // Take the lock if it can be had (the panicking thread may hold it): then no other writer is in the
            // middle of recording a window. If not, restore anyway; the temporary file of every write is its own.
            let guard = SHARED.get().and_then(|s| {
                let t = Instant::now();
                loop {
                    match s.try_lock() {
                        Ok(g) => return Some(g),
                        Err(std::sync::TryLockError::Poisoned(p)) => return Some(p.into_inner()),
                        Err(std::sync::TryLockError::WouldBlock) if t.elapsed() < Duration::from_millis(300) => std::thread::sleep(Duration::from_millis(5)),
                        Err(_) => return None,
                    }
                }
            });
            let _ = restore_from_file(&paths, true);
            drop(guard);
            crate::bar::remove_all();
            std::process::exit(101);
        }));
    }
    let _ = CTRL_TX.set(tx.clone());
    unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(ctrl_handler), 1) };
    {
        let mut c = lock(&shared);
        let mut log = baneyspaces_core::ActionLog::parse(&c.paths.read("actions.jsonl").unwrap_or_default());
        if log.prune(now()) > 0 {
            let _ = c.paths.write_atomic("actions.jsonl", &log.render());
        }
        // Agent processes from a previous run that are still the same process.
        let left = hidden::parse_state(&c.paths.read("state.json").unwrap_or_default());
        for a in &left.agents {
            if winapi::alive(a.pid, a.start) {
                let _ = c.model.apply(Event::AgentRegister { pid: a.pid, start: a.start });
            }
        }
        // What is still hidden: agent windows that stayed on the agent workspace, and any window that did not
        // read back as shown (its entry stays until it does).
        for h in left.hidden {
            c.hidden.insert(h);
        }
        c.sync_monitors();
        c.resync_windows(true);
        let _ = c.persist();
        c.load_keys(None);
        watch_config(crate::paths::config_file(), tx.clone());
        let problems = hook::start(tx.clone(), on_end_session);
        for p in &problems {
            say(&format!("baneyspaces daemon: {p}"));
        }
        c.problems.extend(problems);
        let _ = c.persist();
        crate::bar::start(tx.clone(), c.settings.get("bar.enabled") == Some(&json!(true)));
    }
    // The control pipe: two listeners, so there is always a free instance.
    {
        let (s1, sv1) = (shared.clone(), server.clone());
        std::thread::spawn(move || listen(s1, sv1, Some(first)));
        let (s2, sv2) = (shared.clone(), server);
        std::thread::spawn(move || listen(s2, sv2, None));
    }
    say(&format!("baneyspaces daemon: ready ({})", paths.pipe_name()));
    // The worker: it waits for what the hooks report and acts on each as it comes. The full look at every window
    // is a safety net every RECONCILE (every RECHECK if the WinEvent hooks are not in), and the read-back of what
    // is hidden runs every RECHECK only while `recheck` says something no event reports could go wrong.
    let mut last_full = Instant::now();
    let mut last_check = Instant::now();
    loop {
        let full_every = if hook::events_live() { RECONCILE } else { RECHECK };
        let recheck = lock(&shared).recheck;
        let mut due = last_full + full_every;
        if recheck {
            due = due.min(last_check + RECHECK);
        }
        match rx.recv_timeout(due.saturating_duration_since(Instant::now())) {
            Ok(Msg::Quit) => break,
            Ok(Msg::Resync) => {
                // explorer.exe restarted, the session unlocked, or the input desktop changed: look at everything now.
                last_full = Instant::now();
                lock(&shared).poll();
            }
            Ok(Msg::Chord { args, at }) => {
                // A binding is a CLI command line (spec/keymap.md), checked when the keys were loaded.
                let env = match crate::request(args.clone()) {
                    Ok(req) => handle(&shared, &req),
                    Err(e) => e,
                };
                if trace {
                    say(&format!("[baneyspaces] chord {args:?}: done {} ms after the key went down", winapi::tick_ms().wrapping_sub(at)));
                }
                if !env.ok {
                    say(&format!("baneyspaces daemon: chord {args:?}: {}", env.to_json()));
                }
            }
            Ok(Msg::Win { event, hwnd }) => {
                lock(&shared).on_win_event(event, hwnd);
            }
            Ok(Msg::Press { x, y }) => {
                lock(&shared).on_press(x, y);
            }
            Ok(Msg::Note(line)) => {
                say(&format!("baneyspaces daemon: {line}"));
            }
            Ok(Msg::Reload { at }) => {
                lock(&shared).load_keys(Some(at));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => break,
        }
        let now = Instant::now();
        if now >= last_full + full_every {
            last_full = now;
            last_check = now;
            lock(&shared).poll();
        } else if recheck && now >= last_check + RECHECK {
            last_check = now;
            lock(&shared).recheck_hidden();
        }
    }
    // Shutting down: stop the hooks, then, under the lock with STOPPING set (requests that arrive meanwhile are
    // refused, and a poll in flight has finished), write the record and put your windows back. The bar goes first, so
    // the work area is whole again before any window is shown.
    crate::bar::stop();
    hook::stop();
    let (shown, kept, failed) = {
        let c = lock(&shared);
        STOPPING.store(true, Ordering::SeqCst);
        let _ = c.persist();
        restore_from_file(&paths, true)
    };
    say(&format!("baneyspaces daemon: stopped; {shown} window(s) put back, {kept} agent window(s) still on the agent workspace, {failed} not restored (kept in state.json)"));
    FINISHED.store(true, Ordering::SeqCst);
    0
}

#[cfg(test)]
mod feed_tests {
    use super::*;
    use crate::feed::{Feed, FeedMsg};
    use baneyspaces_core::shell::ShellState;
    use std::sync::Weak;
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow};

    type Rx = Receiver<FeedMsg<Pipe>>;

    /// The next state the feed is sent, within 2 s.
    fn next(rx: &Rx) -> Option<ShellState> {
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(FeedMsg::Publish(l)) => ShellState::parse_line(&l),
            _ => None,
        }
    }

    /// The last state the feed was sent so far.
    fn last(rx: &Rx) -> Option<ShellState> {
        let mut state = None;
        while let Ok(m) = rx.try_recv() {
            if let FeedMsg::Publish(l) = m {
                state = ShellState::parse_line(&l);
            }
        }
        state
    }

    /// A core with one window of yours, `w-1` titled "one" on workspace 1, sending its feed to `feed`.
    fn core_with(dir: &std::path::Path, hwnd: i64, feed: Option<FeedTx>) -> Shared {
        let (tx, rx) = channel();
        std::mem::forget(rx);
        let core = Core {
            model: Model::new(),
            paths: Paths { state: dir.to_path_buf() },
            hidden: HiddenSet::default(),
            info: HashMap::new(),
            job: None,
            overview_shown: false,
            events_seen: 0,
            closed_at: None,
            started: now(),
            trace: false,
            our_pid: 0,
            problems: vec![],
            settings: serde_json::Map::new(),
            tx,
            last_prune: std::cell::Cell::new(0),
            feed,
            written: std::cell::RefCell::new(String::new()),
            recheck: false,
            keys: KeysState::default(),
            keys_blocked_by: None,
        };
        let shared: Shared = Arc::new(Mutex::new(core));
        {
            let mut c = lock(&shared);
            c.model.apply(Event::MonitorAdded { monitor: "m".into() }).unwrap();
            c.model.apply(Event::Open { window: "w-1".into(), pid: 4242, start: 0, app: "Test".into(), monitor: Some("m".into()), workspace: Some(1) }).unwrap();
            c.info.insert("w-1".into(), WinInfo { hwnd, pid: 4242, start: 0, title: "one".into(), app: "Test".into() });
        }
        shared
    }

    fn retitle(c: &mut Core) {
        c.info.get_mut("w-1").unwrap().title = "two".into();
    }

    /// A test shell's pipe: what it heard.
    #[derive(Clone, Default)]
    struct Heard(Arc<Mutex<String>>);
    impl Write for Heard {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().push_str(&String::from_utf8_lossy(buf));
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Heard {
        /// The title the shell shows within 2 s, once it shows `want`.
        fn shows(&self, want: &str) -> String {
            let t = Instant::now();
            loop {
                let text = self.0.lock().unwrap().clone();
                let title = text.lines().rev().find_map(ShellState::parse_line).and_then(|s| s.windows.first().map(|w| w.title.clone())).unwrap_or_default();
                if title == want || t.elapsed() > Duration::from_secs(2) {
                    return title;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }

    /// A shell that subscribes and never reads: every write hangs.
    struct Hangs;
    impl Write for Hangs {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A feed run in the test, on the caller's thread.
    fn feed_into(feed: &Arc<Mutex<Feed>>) -> FeedTx {
        let feed = feed.clone();
        Arc::new(move |m| feed.lock().unwrap().handle(m))
    }

    /// first-F1 (review of #481): the greeting was handed to the feed after the core was let go. A change landing in
    /// between published the new state, then the greeting set the feed back to the old one, and the new shell showed
    /// it until something else changed.
    #[test]
    fn a_change_between_subscribe_and_greeting_never_leaves_the_new_shell_on_the_old_state() {
        let feed = Arc::new(Mutex::new(Feed::new()));
        let me: Arc<OnceLock<Weak<Mutex<Core>>>> = Arc::default();
        let changed = Arc::new(AtomicBool::new(false));
        let tx: FeedTx = {
            let (into, me, changed) = (feed_into(&feed), me.clone(), changed.clone());
            Arc::new(move |m| {
                // The change lands as the greeting is handed over, if the core is free then.
                if matches!(m, FeedMsg::Greet(..)) {
                    if let Some(core) = me.get().and_then(Weak::upgrade) {
                        if let Ok(mut c) = core.try_lock() {
                            retitle(&mut c);
                            c.publish();
                            changed.store(true, Ordering::SeqCst);
                        }
                    }
                }
                into(m)
            })
        };
        let shared = core_with(&std::env::temp_dir(), 1, Some(tx));
        let _ = me.set(Arc::downgrade(&shared));
        let shell = Heard::default();
        subscribe(&shared, 0, Box::new(shell.clone()));
        if !changed.load(Ordering::SeqCst) {
            retitle(&mut lock(&shared));
        }
        assert_eq!(shell.shows("two"), "two", "the new shell is left on the state from before the change");
    }

    /// first-F3 of #431 as behavior (review of #481): a shell that subscribes and never reads holds up neither the
    /// subscribe nor another thread that wants the core.
    #[test]
    fn a_shell_that_never_reads_holds_up_nothing() {
        let shared = core_with(&std::env::temp_dir(), 1, Some(feed_into(&Arc::new(Mutex::new(Feed::new())))));
        let (done_tx, done) = channel();
        let s = shared.clone();
        std::thread::spawn(move || {
            subscribe(&s, 0, Box::new(Hangs));
            retitle(&mut lock(&s));
            let _ = done_tx.send(());
        });
        assert!(done.recv_timeout(Duration::from_secs(2)).is_ok(), "subscribe, or the core after it, was held up by a shell that never reads");
    }

    /// The previous round's first-F1 and second-S1: a change made without a publish (the poll re-reading a title)
    /// never reached the feed, and a switch refused because `state.json` could not be saved still sent the feed the
    /// workspace it never reached.
    #[test]
    fn every_change_reaches_the_feed_and_a_refused_switch_shows_where_you_are() {
        let (feed_tx, rx) = channel();
        let dir = std::env::temp_dir().join(format!("baneyspaces-feed-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A real window, never shown, so the switch has a window of yours to record before hiding it.
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let h = unsafe { CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 100, 100, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null()) };
        assert!(!h.is_null(), "a test window");
        let shared = core_with(&dir, id_of(h), Some(Arc::new(move |m| drop(feed_tx.send(m)))));
        let s = next(&rx).expect("the feed heard the window open");
        assert_eq!(s.windows.first().map(|w| w.title.as_str()), Some("one"));
        lock(&shared).info.get_mut("w-1").unwrap().title = "two".into();
        let s = next(&rx).expect("the feed heard the new title");
        assert_eq!(s.windows.first().map(|w| w.title.as_str()), Some("two"));

        // A file where the state folder should be: nothing can be saved under it.
        let blocker = dir.join("not-a-folder");
        std::fs::write(&blocker, "").unwrap();
        let refused = {
            let mut c = lock(&shared);
            c.paths.state = blocker.join("BaneySpaces");
            c.apply_checked(Event::Switch { n: 2, monitor: None }).is_err()
        };
        assert!(refused, "a switch that cannot save the record is refused");
        let s = last(&rx).expect("the feed was sent the state after the refusal");
        assert_eq!(s.monitors.first().map(|m| m.current), Some(1), "the feed shows the workspace you are still on");

        unsafe { DestroyWindow(h) };
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
#[path = "daemon_tests.rs"]
mod tests;
