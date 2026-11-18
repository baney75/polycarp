//! The worker's half of an early ghost (`hook::ghost_early`): how it records, keeps or undoes a window the event
//! thread ghosted before the worker heard of it, against real windows on the runner's desktop.

use super::*;
use crate::testwin::{agents_turn, TestWin};
use std::sync::atomic::AtomicUsize;
use windows_sys::Win32::UI::WindowsAndMessaging::{WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT};

const GHOST_BITS: i64 = (WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE) as i64;

/// A core with nothing tracked over a fresh state directory. The windows under test are this process's own.
fn core() -> Core {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!("baneyspaces-early-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temporary state directory");
    let (tx, rx) = channel();
    std::mem::forget(rx);
    Core {
        model: Model::new(),
        paths: Paths { state: dir },
        hidden: HiddenSet::default(),
        info: HashMap::new(),
        job: None,
        snaps: HashMap::new(),
        overview_shown: false,
        events_seen: 0,
        closed_at: None,
        started: now(),
        trace: false,
        our_pid: std::process::id(), // the test windows are never adopted as yours
        problems: vec![],
        settings: serde_json::Map::new(),
        tx,
        last_prune: std::cell::Cell::new(0),
        feed: None,
        written: std::cell::RefCell::new(String::new()),
        recheck: false,
        keys: KeysState::default(),
        keys_blocked_by: None,
    }
}

fn this_process_is_the_agent() {
    let pid = std::process::id();
    hook::share_agents(vec![(pid, winapi::process_start(pid))], 0, false);
}

#[test]
fn a_look_that_finds_an_early_ghost_first_records_the_windows_own_alpha() {
    // sol-F2 (and second-F5, the worker's half): the event thread ghosts a window at alpha 200, and the worker's full
    // look reaches it before the window's own event does. The record must hold alpha 200, not a guess.
    let _agents = agents_turn();
    let w = TestWin::open("early, then a look", 0);
    winapi::set_ex_style(w.hwnd, winapi::ex_style(w.hwnd) | WS_EX_LAYERED as i64);
    assert!(winapi::set_layered_alpha(w.hwnd, 200));
    let own = winapi::ex_style(w.hwnd);
    this_process_is_the_agent();
    hook::ghost_early(w.hwnd);
    let mut c = core();
    c.keep_agent_window_hidden(w.hwnd, false); // the full look (resync_windows)
    c.on_win_event(hook::EVENT_OBJECT_SHOW, w.id()); // then the window's own event
    hook::share_agents(vec![], 0, true);
    let e = c.hidden.get(w.id()).cloned().expect("the window is recorded");
    assert_eq!((e.how, e.ex_style, e.alpha), (How::Ghost, Some(own), Some(200)), "the record holds what the window was");
    assert!(cloak::show(&e, None));
    assert_eq!(winapi::layered_alpha(w.hwnd), Some(200), "shown, it is back at alpha 200");
    assert_eq!(winapi::ex_style(w.hwnd), own);
}

#[test]
fn an_early_ghost_of_a_handle_another_process_now_owns_changes_nothing() {
    // sol-F3: the agent's window was ghosted, then its process exited and Windows gave the handle to another program
    // before the worker handled the event. That program's window must not be given the agent window's styles.
    let _agents = agents_turn();
    hook::share_agents(vec![], 0, true);
    let w = TestWin::open("a reused handle", 0);
    let own = winapi::ex_style(w.hwnd);
    let theirs = cloak::GhostUndo { ex_style: own | WS_EX_TOOLWINDOW as i64 | WS_EX_LAYERED as i64, alpha: Some(50) };
    hook::plant_early(w.id(), 4_000_000_000, 1, theirs);
    let mut c = core();
    c.on_win_event(hook::EVENT_OBJECT_SHOW, w.id());
    assert_eq!(winapi::ex_style(w.hwnd), own, "the other program's window kept its own style");
    assert_eq!(winapi::layered_alpha(w.hwnd), None, "and is not layered at alpha 50");
}

#[test]
fn a_ghost_cut_off_before_its_alpha_is_recorded_without_the_ghosts_bits() {
    // sol-F4: the daemon died after the ghost's style went on and before its alpha did. The next daemon must not
    // record the click-through and no-activate bits as the window's own.
    let _agents = agents_turn();
    hook::share_agents(vec![], 0, true);
    let w = TestWin::open("half a ghost", 0);
    let own = winapi::ex_style(w.hwnd);
    winapi::set_ex_style(w.hwnd, own | GHOST_BITS);
    let mut c = core();
    c.keep_agent_window_hidden(w.hwnd, false);
    let e = c.hidden.get(w.id()).cloned().expect("the window is recorded");
    let kept = e.ex_style.unwrap_or(0);
    assert_eq!(kept & (WS_EX_TRANSPARENT | WS_EX_NOACTIVATE) as i64, 0, "the record has the ghost's bits as the window's own: {kept:#x}");
    assert!(cloak::show(&e, None));
    assert_eq!(winapi::ex_style(w.hwnd) & (WS_EX_TRANSPARENT | WS_EX_NOACTIVATE) as i64, 0, "shown, it takes clicks and focus again");
}
