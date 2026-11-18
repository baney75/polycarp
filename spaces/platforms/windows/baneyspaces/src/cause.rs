//! Who caused a foreground change. Windows says only that the front window changed, so input in the last 300 ms
//! counts as yours (R-F1): a user activation may take you to another workspace, an app's may not (R-F2).
//!
//! A close breaks that guess. When the front window closes, Windows hands the front to the next window in z-order,
//! and that can be a hidden window of another workspace. The click on the close box is still under 300 ms old, so
//! the system's activation would pass for yours and switch you away from the workspace you emptied (R-E1: empty
//! means empty). An activation is the system's when the window that was active is gone, or when a close came after
//! your last input.
//!
//! A front the daemon asked for is never yours either. A switch asks Windows to bring its workspace's window to the
//! front, and Windows can grant that after the next switch: followed, it took you back, and that workspace's own late
//! front took you forward again, back and forth (#545).

use baneyspaces_core::model::Cause;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

/// A window the daemon asked to bring to the front counts as asked for this long. Windows activates another process's
/// window on its own time, so an ask it reports refused can still land well after the next switch (#545).
pub const ASKED_MS: u32 = 1_000;

/// The windows the daemon asked to bring to the front in the last `ASKED_MS`: each window, its root owner
/// (`GetAncestor(GA_ROOTOWNER)`, 0 if unknown) and the tick of the ask.
static ASKS: Mutex<Vec<(i64, i64, u32)>> = Mutex::new(Vec::new());

/// The daemon is asking Windows to bring `hwnd` (root owner `root`) to the front now (`now`: `winapi::tick_ms`).
pub fn note_asked(hwnd: i64, root: i64, now: u32) {
    let mut a = ASKS.lock().unwrap_or_else(|e| e.into_inner());
    a.retain(|&(h, _, t)| h != hwnd && now.wrapping_sub(t) < ASKED_MS);
    a.push((hwnd, root, now));
}

/// Windows put `hwnd` in front at once when asked: no ask of it is left to land late.
pub fn landed(hwnd: i64) {
    ASKS.lock().unwrap_or_else(|e| e.into_inner()).retain(|&(h, _, _)| h != hwnd);
}

/// `hwnd` (root owner `root`) took the front: how long ago the daemon asked for it, within `ASKED_MS`. An ask covers
/// every window under the asked one's root owner, since Windows gives the front to a window's open dialog instead. The
/// ask is used up: a later front of that window is decided by your input alone.
pub fn take_asked(hwnd: i64, root: i64, now: u32) -> Option<u32> {
    let mut a = ASKS.lock().unwrap_or_else(|e| e.into_inner());
    a.retain(|&(_, _, t)| now.wrapping_sub(t) < ASKED_MS);
    let i = a.iter().rposition(|&(h, r, _)| h == hwnd || (root != 0 && r == root))?;
    Some(now.wrapping_sub(a.remove(i).2))
}

/// When a person last typed or pointed, as the input hooks see it.
pub struct InputClock {
    last: AtomicU32,
}

impl InputClock {
    pub const fn new() -> Self {
        Self { last: AtomicU32::new(0) }
    }

    /// A keyboard or mouse event at `tick`. `real` is false for input software injected.
    pub fn note(&self, real: bool, tick: u32) {
        if real {
            self.last.store(tick.max(1), Ordering::Relaxed);
        }
    }

    /// Milliseconds from the last real input to `now`, or None before the hooks have seen any.
    pub fn idle(&self, now: u32) -> Option<u32> {
        match self.last.load(Ordering::Relaxed) {
            0 => None,
            t => Some(now.wrapping_sub(t)),
        }
    }
}

/// `idle_ms`: time since the last keyboard or mouse input. `since_close_ms`: time since a tracked window last
/// closed, if one has. `active_gone`: the window the model holds active no longer exists or is no longer visible.
/// `since_asked_ms`: time since the daemon asked for this window to come to the front, within `ASKED_MS`.
pub fn foreground_by(idle_ms: u32, since_close_ms: Option<u32>, active_gone: bool, since_asked_ms: Option<u32>) -> Cause {
    let closed_after_input = since_close_ms.is_some_and(|s| s <= idle_ms);
    if active_gone || closed_after_input || since_asked_ms.is_some() || idle_ms >= 300 {
        Cause::App
    } else {
        Cause::User
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_the_last_window_does_not_follow_windows_to_another_workspace() {
        // You click the close box (40 ms ago), the window closes (20 ms ago), Windows activates a hidden window.
        assert_eq!(foreground_by(40, Some(20), false, None), Cause::App);
        // The foreground event came before the close was seen: the active window is already gone.
        assert_eq!(foreground_by(40, None, true, None), Cause::App);
        assert_eq!(foreground_by(40, Some(9_000), true, None), Cause::App);
    }

    #[test]
    fn a_click_after_a_close_is_still_yours() {
        // A taskbar click 30 ms ago, after a close five seconds earlier, may take you to that window's workspace.
        assert_eq!(foreground_by(30, Some(5_000), false, None), Cause::User);
        assert_eq!(foreground_by(30, None, false, None), Cause::User);
    }

    #[test]
    fn no_recent_input_is_the_apps() {
        assert_eq!(foreground_by(2_000, None, false, None), Cause::App);
        assert_eq!(foreground_by(300, Some(9_000), false, None), Cause::App);
    }

    #[test]
    fn a_window_the_daemon_asked_for_is_never_yours() {
        // Win+6 typed 40 ms ago, and the front goes to a window the daemon asked for 300 ms ago: the daemon's, not yours.
        assert_eq!(foreground_by(40, None, false, Some(300)), Cause::App);
        assert_eq!(foreground_by(40, None, false, Some(0)), Cause::App);
        // An ask over ASKED_MS old no longer counts, and none at all leaves your input to decide.
        assert_eq!(foreground_by(40, None, false, take_asked(0x7001, 0x7001, 5_000)), Cause::User);
    }

    #[test]
    fn a_late_activation_from_the_switch_before_does_not_follow() {
        // #545, speed run 44275966979: Win+2 asks for a (refused, it lands later); Win+6 asks for b; a takes the front
        // 47 ms after Win+6 went down. Following it showed workspace 2 again, b's late front showed 6, seven times over.
        let (a, b, c) = (0x10216, 0x30264, 0x10218);
        note_asked(c, c, 10_000);
        note_asked(a, a, 10_000);
        note_asked(b, b, 10_150);
        assert_eq!(foreground_by(47, None, false, take_asked(a, a, 10_197)), Cause::App, "a's late front is the daemon's");
        assert_eq!(foreground_by(60, None, false, take_asked(b, b, 10_210)), Cause::App, "and so is b's");
        assert_eq!(take_asked(c, c, 11_000), None, "an ask lasts ASKED_MS");
    }

    #[test]
    fn an_ask_that_landed_never_refuses_your_front_later() {
        // Win+1 asks for x and x takes the front; Win+2 asks for a. Within the second you click x: that's yours.
        let (x, a) = (0x40216, 0x40218);
        note_asked(x, x, 20_000);
        assert_eq!(take_asked(x, x, 20_080), Some(80), "x's front landed late: the daemon's");
        note_asked(a, a, 20_200);
        assert_eq!(take_asked(x, x, 20_500), None, "x's ask was used up when its front landed");
        // An ask Windows granted at once leaves nothing to land late.
        let y = 0x40220;
        note_asked(y, y, 20_000);
        landed(y);
        assert_eq!(take_asked(y, y, 20_100), None);
    }

    #[test]
    fn an_ask_covers_the_dialog_its_window_owns() {
        // Win+2 asks for Notepad's window a, which owns an open Save As dialog d. Windows grants the ask late, and
        // gives the front to d. That's the daemon's front too, or Win+6's 300 ms would call it yours (#545 again).
        let (a, d) = (0x50216, 0x50300);
        note_asked(a, a, 30_000);
        assert_eq!(take_asked(d, a, 30_250), Some(250));
        // A window with another root is no part of the ask.
        note_asked(a, a, 30_400);
        assert_eq!(take_asked(0x50400, 0x50400, 30_450), None);
    }

    #[test]
    fn injected_input_is_never_yours() {
        // The daemon's own masking key (0xE8) and SendInput from any app move GetLastInputInfo; a person didn't type.
        let c = InputClock::new();
        assert_eq!(c.idle(1_000), None);
        c.note(true, 500);
        c.note(false, 1_000);
        assert_eq!(c.idle(1_100), Some(600), "only the real key at 500 counts");
    }

    #[test]
    fn the_daemon_asks_before_it_calls_an_activation_yours() {
        let src = include_str!("daemon.rs").replace("\r\n", "\n");
        let start = src.find("fn on_foreground(").expect("on_foreground");
        let body = &src[start..start + src[start..].find("\n    }\n").expect("end of on_foreground")];
        assert!(body.contains("cause::foreground_by("), "on_foreground must classify the activation with cause::foreground_by");
        assert!(!body.contains("idle_ms() < 300"), "the bare 300 ms guess calls a close's activation yours");
        assert!(body.contains("cause::take_asked("), "on_foreground must know which windows the daemon asked for");
        assert!(body.contains("hook::idle_ms("), "on_foreground must time your input from the hooks, not GetLastInputInfo");
        let start = src.find("fn exec(").expect("exec");
        let body = &src[start..start + src[start..].find("\n    }\n").expect("end of exec")];
        assert!(body.contains("cause::note_asked("), "exec must note each window it asks to bring to the front");
        let start = src.find("fn close_window(").expect("close_window");
        let body = &src[start..start + src[start..].find("\n    }\n").expect("end of close_window")];
        assert!(body.contains("self.closed_at = Some("), "close_window must note when the close happened");
    }
}
