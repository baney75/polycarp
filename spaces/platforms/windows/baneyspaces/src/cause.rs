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
#[path = "cause_tests.rs"]
mod tests;
