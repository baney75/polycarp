//! Who caused a foreground change. Windows says only that the front window changed, so input in the last 300 ms
//! counts as yours (R-F1): a user activation may take you to another workspace, an app's may not (R-F2).
//!
//! A close breaks that guess. When the front window closes, Windows hands the front to the next window in z-order,
//! and that can be a hidden window of another workspace. The click on the close box is still under 300 ms old, so
//! the system's activation would pass for yours and switch you away from the workspace you emptied (R-E1: empty
//! means empty). An activation is the system's when the window that was active is gone, or when a close came after
//! your last input.

use baneyspaces_core::model::Cause;
use std::sync::Mutex;

/// A window the daemon asked to bring to the front counts as asked for this long. Windows activates another process's
/// window on its own time, so an ask it reports refused can still land well after the next switch (#545).
pub const ASKED_MS: u32 = 1_000;

/// The windows the daemon asked to bring to the front in the last `ASKED_MS`, with the tick of each ask.
static ASKS: Mutex<Vec<(i64, u32)>> = Mutex::new(Vec::new());

/// The daemon is asking Windows to bring `hwnd` to the front now (`now`: `winapi::tick_ms`).
pub fn note_asked(hwnd: i64, now: u32) {
    let mut a = ASKS.lock().unwrap_or_else(|e| e.into_inner());
    a.retain(|&(h, t)| h != hwnd && now.wrapping_sub(t) < ASKED_MS);
    a.push((hwnd, now));
}

/// How long ago the daemon last asked for `hwnd` to come to the front, within `ASKED_MS`.
pub fn since_asked(hwnd: i64, now: u32) -> Option<u32> {
    let a = ASKS.lock().unwrap_or_else(|e| e.into_inner());
    a.iter().rev().find(|&&(h, _)| h == hwnd).map(|&(_, t)| now.wrapping_sub(t)).filter(|&d| d < ASKED_MS)
}

/// `idle_ms`: time since the last keyboard or mouse input. `since_close_ms`: time since a tracked window last
/// closed, if one has. `active_gone`: the window the model holds active no longer exists or is no longer visible.
/// `since_asked_ms`: time since the daemon asked for this window to come to the front, within `ASKED_MS`.
pub fn foreground_by(idle_ms: u32, since_close_ms: Option<u32>, active_gone: bool, _since_asked_ms: Option<u32>) -> Cause {
    let closed_after_input = since_close_ms.is_some_and(|s| s <= idle_ms);
    if active_gone || closed_after_input || idle_ms >= 300 {
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
        assert_eq!(foreground_by(40, None, false, since_asked(0x7001, 5_000)), Cause::User);
    }

    #[test]
    fn a_late_activation_from_the_switch_before_does_not_follow() {
        // #545, speed run 44275966979: Win+2 asks for a (refused, it lands later); Win+6 asks for b; a takes the front
        // 47 ms after Win+6 went down. Following it showed workspace 2 again, b's late front showed 6, seven times over.
        let (a, b) = (0x10216, 0x30264);
        note_asked(a, 10_000);
        note_asked(b, 10_150);
        assert_eq!(since_asked(a, 10_197), Some(197));
        assert_eq!(foreground_by(47, None, false, since_asked(a, 10_197)), Cause::App, "a's late front is the daemon's");
        assert_eq!(foreground_by(60, None, false, since_asked(b, 10_210)), Cause::App, "and so is b's");
        assert_eq!(since_asked(a, 11_000), None, "an ask lasts ASKED_MS");
    }

    #[test]
    fn the_daemon_asks_before_it_calls_an_activation_yours() {
        let src = include_str!("daemon.rs").replace("\r\n", "\n");
        let start = src.find("fn on_foreground(").expect("on_foreground");
        let body = &src[start..start + src[start..].find("\n    }\n").expect("end of on_foreground")];
        assert!(body.contains("cause::foreground_by("), "on_foreground must classify the activation with cause::foreground_by");
        assert!(!body.contains("idle_ms() < 300"), "the bare 300 ms guess calls a close's activation yours");
        assert!(body.contains("cause::since_asked("), "on_foreground must know which windows the daemon asked for");
        let start = src.find("fn exec(").expect("exec");
        let body = &src[start..start + src[start..].find("\n    }\n").expect("end of exec")];
        assert!(body.contains("cause::note_asked("), "exec must note each window it asks to bring to the front");
        let start = src.find("fn close_window(").expect("close_window");
        let body = &src[start..start + src[start..].find("\n    }\n").expect("end of close_window")];
        assert!(body.contains("self.closed_at = Some("), "close_window must note when the close happened");
    }
}
