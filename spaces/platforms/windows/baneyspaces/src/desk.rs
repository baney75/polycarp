//! The Win32 calls the hiding logic in `cloak.rs` makes, behind one trait, so the decisions (cloak or park,
//! ghost or refuse, shown or not) run in `cargo test` against a fake desk with failures Windows can't be made
//! to produce on demand: a shell that refuses the cloak, a cloak that doesn't take, an alpha Windows refuses.
//! `Real` is the only implementation outside tests and calls `winapi` and the shell, nothing else.

use crate::cloak::{self, Cloaker};
use crate::winapi;
use windows_sys::Win32::Foundation::HWND;

pub trait Desk {
    fn exists(&self, h: HWND) -> bool;
    /// The shell cloak on or off; an error when there is no shell to ask or it refused.
    fn set_cloak(&self, h: HWND, on: bool) -> Result<(), i32>;
    /// DWM's cloaked attribute (2: cloaked by the shell).
    fn cloaked(&self, h: HWND) -> u32;
    fn rect(&self, h: HWND) -> Option<[i32; 4]>;
    fn set_pos(&self, h: HWND, x: i32, y: i32);
    fn is_iconic(&self, h: HWND) -> bool;
    fn ex_style(&self, h: HWND) -> i64;
    fn set_ex_style(&self, h: HWND, v: i64);
    fn layered_alpha(&self, h: HWND) -> Option<u8>;
    fn set_layered_alpha(&self, h: HWND, alpha: u8) -> bool;
    fn taskbar_button(&self, h: HWND, visible: bool);
    fn title(&self, h: HWND) -> String;
    fn class(&self, h: HWND) -> String;
    fn pid_of(&self, h: HWND) -> u32;
    fn process_start(&self, pid: u32) -> u64;
    /// Parked where `hide_user` parks, as `winapi::is_parked` tells it.
    fn is_parked(&self, h: HWND) -> bool {
        !self.is_iconic(h) && self.rect(h).is_some_and(|r| r[0] <= -30000)
    }
}

/// The real desk, with the shell's view collection when there is one.
pub struct Real<'a>(pub Option<&'a Cloaker>);

impl Desk for Real<'_> {
    fn exists(&self, h: HWND) -> bool {
        winapi::exists(h)
    }
    fn set_cloak(&self, h: HWND, on: bool) -> Result<(), i32> {
        self.0.map_or(Err(-1), |c| c.set(h, on))
    }
    fn cloaked(&self, h: HWND) -> u32 {
        winapi::cloaked(h)
    }
    fn rect(&self, h: HWND) -> Option<[i32; 4]> {
        winapi::rect(h)
    }
    fn set_pos(&self, h: HWND, x: i32, y: i32) {
        winapi::set_pos(h, x, y)
    }
    fn is_iconic(&self, h: HWND) -> bool {
        winapi::is_iconic(h)
    }
    fn ex_style(&self, h: HWND) -> i64 {
        winapi::ex_style(h)
    }
    fn set_ex_style(&self, h: HWND, v: i64) {
        winapi::set_ex_style(h, v)
    }
    fn layered_alpha(&self, h: HWND) -> Option<u8> {
        winapi::layered_alpha(h)
    }
    fn set_layered_alpha(&self, h: HWND, alpha: u8) -> bool {
        winapi::set_layered_alpha(h, alpha)
    }
    fn taskbar_button(&self, h: HWND, visible: bool) {
        cloak::taskbar_button(h, visible)
    }
    fn title(&self, h: HWND) -> String {
        winapi::title(h)
    }
    fn class(&self, h: HWND) -> String {
        winapi::class(h)
    }
    fn pid_of(&self, h: HWND) -> u32 {
        winapi::pid_of(h)
    }
    fn process_start(&self, pid: u32) -> u64 {
        winapi::process_start(pid)
    }
    fn is_parked(&self, h: HWND) -> bool {
        winapi::is_parked(h)
    }
}

/// A desk in memory: one window per handle, and switches for the failures the real one can't be made to show.
#[cfg(test)]
pub mod fake {
    use super::Desk;
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::WS_EX_LAYERED;

    #[derive(Clone, Debug, Default, PartialEq)]
    pub struct Win {
        pub rect: [i32; 4],
        pub cloaked: u32,
        pub iconic: bool,
        pub ex_style: i64,
        pub alpha: Option<u8>,
        pub on_taskbar: bool,
        pub title: String,
        pub class: String,
        pub pid: u32,
    }

    #[derive(Default)]
    pub struct Fake {
        pub wins: RefCell<BTreeMap<isize, Win>>,
        pub starts: BTreeMap<u32, u64>,
        /// The shell refuses the cloak (no ImmersiveShell, or an elevated window).
        pub cloak_refused: bool,
        /// The shell says yes but DWM never shows the window as cloaked.
        pub cloak_ignored: bool,
        /// SetLayeredWindowAttributes fails (a window drawing with per-pixel alpha).
        pub alpha_refused: bool,
        pub calls: RefCell<Vec<String>>,
    }

    pub fn h(id: isize) -> HWND {
        id as HWND
    }

    impl Fake {
        pub fn with(wins: &[(isize, Win)]) -> Self {
            let f = Fake::default();
            f.wins.borrow_mut().extend(wins.iter().cloned());
            f
        }
        pub fn win(&self, id: isize) -> Win {
            self.wins.borrow()[&id].clone()
        }
        fn edit(&self, h: HWND, f: impl FnOnce(&mut Win)) {
            if let Some(w) = self.wins.borrow_mut().get_mut(&(h as isize)) {
                f(w)
            }
        }
        fn read<T: Default>(&self, h: HWND, f: impl FnOnce(&Win) -> T) -> T {
            self.wins
                .borrow()
                .get(&(h as isize))
                .map(f)
                .unwrap_or_default()
        }
        fn log(&self, s: String) {
            self.calls.borrow_mut().push(s)
        }
    }

    impl Desk for Fake {
        fn exists(&self, h: HWND) -> bool {
            self.wins.borrow().contains_key(&(h as isize))
        }
        fn set_cloak(&self, h: HWND, on: bool) -> Result<(), i32> {
            self.log(format!("cloak {on}"));
            if self.cloak_refused {
                return Err(-2147467259);
            }
            if !self.cloak_ignored {
                self.edit(h, |w| w.cloaked = if on { 2 } else { 0 });
            }
            Ok(())
        }
        fn cloaked(&self, h: HWND) -> u32 {
            self.read(h, |w| w.cloaked)
        }
        fn rect(&self, h: HWND) -> Option<[i32; 4]> {
            self.wins.borrow().get(&(h as isize)).map(|w| w.rect)
        }
        fn set_pos(&self, h: HWND, x: i32, y: i32) {
            self.log(format!("pos {x},{y}"));
            self.edit(h, |w| {
                w.rect = [x, y, x + w.rect[2] - w.rect[0], y + w.rect[3] - w.rect[1]]
            });
        }
        fn is_iconic(&self, h: HWND) -> bool {
            self.read(h, |w| w.iconic)
        }
        fn ex_style(&self, h: HWND) -> i64 {
            self.read(h, |w| w.ex_style)
        }
        fn set_ex_style(&self, h: HWND, v: i64) {
            // Windows drops a window's layered attributes when it stops being layered.
            self.edit(h, |w| {
                if v & WS_EX_LAYERED as i64 == 0 {
                    w.alpha = None;
                }
                w.ex_style = v
            });
        }
        fn layered_alpha(&self, h: HWND) -> Option<u8> {
            self.read(h, |w| {
                if w.ex_style & WS_EX_LAYERED as i64 != 0 {
                    w.alpha
                } else {
                    None
                }
            })
        }
        fn set_layered_alpha(&self, h: HWND, alpha: u8) -> bool {
            if self.alpha_refused || self.read(h, |w| w.ex_style & WS_EX_LAYERED as i64 == 0) {
                return false;
            }
            self.edit(h, |w| w.alpha = Some(alpha));
            true
        }
        fn taskbar_button(&self, h: HWND, visible: bool) {
            self.edit(h, |w| w.on_taskbar = visible);
        }
        fn title(&self, h: HWND) -> String {
            self.read(h, |w| w.title.clone())
        }
        fn class(&self, h: HWND) -> String {
            self.read(h, |w| w.class.clone())
        }
        fn pid_of(&self, h: HWND) -> u32 {
            self.read(h, |w| w.pid)
        }
        fn process_start(&self, pid: u32) -> u64 {
            self.starts.get(&pid).copied().unwrap_or(0)
        }
    }
}
