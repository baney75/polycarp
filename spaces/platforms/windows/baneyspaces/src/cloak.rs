//! Taking a window out of sight, and putting it back.
//!
//! Three ways, each used for one job (the reasons are in platforms/windows/README.md):
//!
//! - **Cloak** (your workspaces): the shell's own `IApplicationView::SetCloak`, reached through
//!   ImmersiveShell COM, the same call komorebi and GlazeWM make. The window stays exactly where it
//!   is, un-drawn, with no animation. The state lives in the shell, so it survives explorer.exe
//!   restarting, and the taskbar button stays put (no churn). The interfaces are undocumented, so
//!   if the call fails the window is **parked** instead.
//! - **Park** (the fallback): moved to (-32000, -32000), where Windows itself puts minimized windows.
//! - **Ghost** (the agent workspace only): fully transparent, click-through, unable to take focus,
//!   still on screen and *not* cloaked. UI Automation skips cloaked windows, so an agent's window
//!   must not be one: a ghost is invisible to you and its agent's own tools can still read it.
//!
//! Callers write the window to `state.json` before calling anything here, and take it out after.

use crate::desk::{Desk, Real};
use crate::hidden::{Hidden, How};
use crate::winapi;
use std::ffi::c_void;
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows_sys::Win32::UI::WindowsAndMessaging::{WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT};

const CLSID_IMMERSIVE_SHELL: GUID = GUID::from_u128(0xC2F03A33_21F5_47FA_B4BB_156362A2F239);
const IID_ISERVICE_PROVIDER: GUID = GUID::from_u128(0x6D5140C1_7436_11CE_8034_00AA006009FA);
const IID_IAPPLICATION_VIEW_COLLECTION: GUID = GUID::from_u128(0x1841c6d7_4f9d_42c0_af41_8747538f10e5);
const CLSID_VIRTUAL_DESKTOP_MANAGER: GUID = GUID::from_u128(0xAA509086_5CA9_4C25_8F95_589D3C07B48A);
const IID_IVIRTUAL_DESKTOP_MANAGER: GUID = GUID::from_u128(0xa5cd92ff_29be_454c_8d04_d82879fb3f1b);
const CLSID_TASKBAR_LIST: GUID = GUID::from_u128(0x56FDF344_FD6D_11D0_958A_006097C9A090);
const IID_ITASKBAR_LIST: GUID = GUID::from_u128(0x56FDF342_FD6D_11D0_958A_006097C9A090);

/// A parked window sits here, as minimized windows do.
pub const PARK: i32 = -32000;

thread_local! {
    static COM: () = unsafe { CoInitializeEx(std::ptr::null(), COINIT_MULTITHREADED as u32); };
}

unsafe fn slot(obj: *mut c_void, index: usize) -> *const c_void {
    let table = *(obj as *const *const *const c_void);
    *table.add(index)
}

unsafe fn release(obj: *mut c_void) {
    if !obj.is_null() {
        let f: unsafe extern "system" fn(*mut c_void) -> u32 = std::mem::transmute(slot(obj, 2));
        f(obj);
    }
}

/// A live handle on the shell's view collection. Made fresh for each batch of work, never kept:
/// explorer.exe may restart between two of them.
pub struct Cloaker {
    provider: *mut c_void,
    collection: *mut c_void,
}

impl Cloaker {
    pub fn new() -> Result<Self, i32> {
        COM.with(|_| ());
        unsafe {
            let mut provider: *mut c_void = std::ptr::null_mut();
            let hr = CoCreateInstance(&CLSID_IMMERSIVE_SHELL, std::ptr::null_mut(), CLSCTX_ALL, &IID_ISERVICE_PROVIDER, &mut provider);
            if hr < 0 || provider.is_null() {
                return Err(hr);
            }
            let mut collection: *mut c_void = std::ptr::null_mut();
            let query: unsafe extern "system" fn(*mut c_void, *const GUID, *const GUID, *mut *mut c_void) -> i32 = std::mem::transmute(slot(provider, 3));
            let hr = query(provider, &IID_IAPPLICATION_VIEW_COLLECTION, &IID_IAPPLICATION_VIEW_COLLECTION, &mut collection);
            if hr < 0 || collection.is_null() {
                release(provider);
                return Err(hr);
            }
            Ok(Self { provider, collection })
        }
    }

    /// `IApplicationView::SetCloak(1, 2)` hides; `(1, 0)` shows.
    pub fn set(&self, h: HWND, on: bool) -> Result<(), i32> {
        unsafe {
            let mut view: *mut c_void = std::ptr::null_mut();
            let get: unsafe extern "system" fn(*mut c_void, HWND, *mut *mut c_void) -> i32 = std::mem::transmute(slot(self.collection, 6));
            let hr = get(self.collection, h, &mut view);
            if hr < 0 || view.is_null() {
                return Err(if hr < 0 { hr } else { -1 });
            }
            let set_cloak: unsafe extern "system" fn(*mut c_void, u32, i32) -> i32 = std::mem::transmute(slot(view, 12));
            let hr = set_cloak(view, 1, if on { 2 } else { 0 });
            release(view);
            if hr < 0 {
                Err(hr)
            } else {
                Ok(())
            }
        }
    }
}

impl Drop for Cloaker {
    fn drop(&mut self) {
        unsafe {
            release(self.collection);
            release(self.provider);
        }
    }
}

/// Best effort: take the window's button off the taskbar (agent windows only), or put it back.
pub fn taskbar_button(h: HWND, visible: bool) {
    COM.with(|_| ());
    unsafe {
        let mut list: *mut c_void = std::ptr::null_mut();
        if CoCreateInstance(&CLSID_TASKBAR_LIST, std::ptr::null_mut(), CLSCTX_ALL, &IID_ITASKBAR_LIST, &mut list) < 0 || list.is_null() {
            return;
        }
        let init: unsafe extern "system" fn(*mut c_void) -> i32 = std::mem::transmute(slot(list, 3));
        if init(list) >= 0 {
            let f: unsafe extern "system" fn(*mut c_void, HWND) -> i32 = std::mem::transmute(slot(list, if visible { 4 } else { 5 }));
            f(list, h);
        }
        release(list);
    }
}

/// Hides one of your windows. Returns how it was hidden: cloaked, or parked if the cloak was
/// refused or did not take. The caller has already recorded the window.
pub fn hide_user(h: HWND, cloaker: Option<&Cloaker>) -> How {
    hide_user_on(&Real(cloaker), h)
}

pub fn hide_user_on(d: &impl Desk, h: HWND) -> How {
    if d.set_cloak(h, true).is_ok() && d.cloaked(h) & 2 != 0 {
        return How::Cloak;
    }
    d.set_pos(h, PARK, PARK);
    How::Park
}

/// What a ghost needs to put a window back exactly: its extended style and constant alpha before.
#[derive(Debug, PartialEq)]
pub struct GhostUndo {
    pub ex_style: i64,
    pub alpha: Option<u8>,
}

/// Hides an agent's window as a ghost. Returns what to put back, or None when the window refused (one
/// that already draws with per-pixel alpha cannot take a constant alpha): the style is put back and the
/// caller parks the window instead.
pub fn ghost(h: HWND) -> Option<GhostUndo> {
    ghost_on(&Real(None), h)
}

const GHOST: i64 = (WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE) as i64;

pub fn ghost_on(d: &impl Desk, h: HWND) -> Option<GhostUndo> {
    // Test builds only (the `test-ops` feature, and the variable set): a window titled "(refuses ghost)" refuses.
    if crate::apps::test_ops_enabled() && d.title(h).contains("(refuses ghost)") {
        return None;
    }
    let ex = d.ex_style(h);
    let alpha = d.layered_alpha(h);
    d.set_ex_style(h, ex | GHOST);
    if !d.set_layered_alpha(h, 0) || d.layered_alpha(h) != Some(0) {
        d.set_ex_style(h, ex);
        return None;
    }
    d.taskbar_button(h, false);
    Some(GhostUndo { ex_style: ex, alpha })
}

/// Does the window still look hidden the way the entry says? Reality, not the daemon's memory:
/// the shell can drop a cloak (a virtual desktop switch re-evaluates them), an app can move itself
/// back from the parking spot or reset its alpha.
pub fn still_hidden(entry: &Hidden) -> bool {
    still_hidden_on(&Real(None), entry)
}

pub fn still_hidden_on(d: &impl Desk, entry: &Hidden) -> bool {
    let h = winapi::hwnd(entry.hwnd);
    match entry.how {
        How::Cloak => d.cloaked(h) & 2 != 0,
        How::Park => d.is_parked(h) || d.is_iconic(h),
        How::Ghost => d.ex_style(h) & GHOST == GHOST && d.layered_alpha(h) == Some(0),
    }
}

/// Is this still the window the entry was written for? A handle can be reused by another window (after a
/// reboot, or once the first was destroyed while the daemon was dead); that one is never touched. The class
/// and the owning thread's process (pid and start time) recorded at hide time must still match. An entry
/// from an older build without them is trusted as before.
pub fn identity_ok(entry: &Hidden) -> bool {
    identity_ok_on(&Real(None), entry)
}

pub fn identity_ok_on(d: &impl Desk, entry: &Hidden) -> bool {
    let h = winapi::hwnd(entry.hwnd);
    if !d.exists(h) {
        return false;
    }
    if !entry.class.is_empty() && d.class(h) != entry.class {
        return false;
    }
    if entry.owner_pid != 0 {
        if d.pid_of(h) != entry.owner_pid {
            return false;
        }
        if entry.owner_start != 0 && d.process_start(entry.owner_pid) != entry.owner_start {
            return false;
        }
    }
    true
}

/// Is a window on the virtual desktop you are looking at? (The documented IVirtualDesktopManager.)
/// A window on another desktop is cloaked by Windows itself: it is not a window that vanished, and it is
/// neither shown nor hidden from here. One manager serves a batch of checks (a switch asks once per window
/// it shows) and is dropped after: explorer.exe may restart between two batches.
pub struct Desktops(*mut c_void);

impl Desktops {
    pub fn new() -> Option<Self> {
        COM.with(|_| ());
        let mut m: *mut c_void = std::ptr::null_mut();
        let hr = unsafe { CoCreateInstance(&CLSID_VIRTUAL_DESKTOP_MANAGER, std::ptr::null_mut(), CLSCTX_ALL, &IID_IVIRTUAL_DESKTOP_MANAGER, &mut m) };
        (hr >= 0 && !m.is_null()).then_some(Self(m))
    }

    /// None when it cannot be told: treated as here.
    pub fn on_current(&self, h: HWND) -> Option<bool> {
        unsafe {
            let f: unsafe extern "system" fn(*mut c_void, HWND, *mut i32) -> i32 = std::mem::transmute(slot(self.0, 3));
            let mut on = 0;
            let hr = f(self.0, h, &mut on);
            (hr >= 0).then_some(on != 0)
        }
    }
}

impl Drop for Desktops {
    fn drop(&mut self) {
        unsafe { release(self.0) };
    }
}

/// Puts a window back as it was, whichever way it was hidden, and says whether it read back as shown:
/// not cloaked, not parked, and for a ghost every property that decides what you see (the layered bit, the
/// alpha, click-through, no-activate) as before. The entry is only forgotten after a true. Cloak and park
/// are both undone whichever of them had happened, so an entry written just before a crash is fine. Safe to
/// call on a window that is not hidden.
pub fn show(entry: &Hidden, cloaker: Option<&Cloaker>) -> bool {
    show_on(&Real(cloaker), entry)
}

pub fn show_on(d: &impl Desk, entry: &Hidden) -> bool {
    let h = winapi::hwnd(entry.hwnd);
    if !d.exists(h) {
        return true;
    }
    let unpark = |h: HWND| {
        if let (Some(r), Some(now)) = (entry.rect, d.rect(h)) {
            if now[0] <= PARK + 2000 && !d.is_iconic(h) {
                d.set_pos(h, r[0], r[1]);
            }
        }
    };
    match entry.how {
        How::Ghost => {
            let was = entry.ex_style.unwrap_or(0);
            // Alpha first, while the window is still layered: back to what it was, or opaque.
            d.set_layered_alpha(h, entry.alpha.unwrap_or(255));
            d.set_ex_style(h, was);
            d.taskbar_button(h, true);
            // A ghost whose first try was refused may have been parked as well.
            unpark(h);
            let styles_back = d.ex_style(h) & GHOST == was & GHOST;
            // Layered as before: still layered with its old alpha. Not layered before: no alpha left at all.
            let alpha_back = if was & WS_EX_LAYERED as i64 != 0 { d.layered_alpha(h) == entry.alpha.or(Some(255)) || entry.alpha.is_none() && d.layered_alpha(h).is_none_or(|a| a == 255) } else { d.layered_alpha(h).is_none() };
            styles_back && alpha_back && !d.is_parked(h)
        }
        How::Cloak | How::Park => {
            let _ = d.set_cloak(h, false);
            unpark(h);
            d.cloaked(h) & 2 == 0 && !d.is_parked(h)
        }
    }
}

#[cfg(test)]
#[path = "cloak_tests.rs"]
mod tests;
