//! Win+drag organizing (spec/keymap.md, "Dragging"): hold Win, then left drag anywhere in a window to move it or right
//! drag to resize it from the nearest corner. A move let go with the pointer at a display's edge snaps the window
//! (`snap::snap`), shown first by a see-through preview. Escape puts the window back where it began.
//!
//! It runs inside the hooks (hook.rs): the mouse hook calls `on_mouse`, the keyboard hook `on_escape`. Both run on the
//! one hook thread, so the drag is thread-local. Windows drops a low-level hook whose callback is slow, so nothing
//! here waits on another app: moves are `SWP_ASYNCWINDOWPOS`, a filled window is restored with `ShowWindowAsync`, and
//! the rest reads the window manager (rects, styles, DWM) or draws the daemon's own preview window.

use crate::hook::Msg;
use crate::snap::{self, Kind, Rect};
use crate::winapi;
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::Graphics::Gdi::CreateSolidBrush;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

struct Live {
    h: HWND,
    kind: Kind,
    /// The button-up that ends it.
    up: u32,
    from: (i32, i32),
    start: Rect,
    snaps: bool,
    /// It was filled (maximized) and came out at its normal size: every move sets the size too, and Escape fills it again.
    restored: bool,
    target: Option<(&'static str, Rect)>,
    began: u32,
}

enum State {
    Idle,
    Live(Live),
    /// Escape ended it; the button is still down and its release must not reach the app.
    Cancelled {
        up: u32,
    },
}

thread_local! {
    static DRAG: RefCell<State> = const { RefCell::new(State::Idle) };
    static PREVIEW: RefCell<HWND> = const { RefCell::new(std::ptr::null_mut()) };
}

/// Set from another thread (the input desktop changed, the session locked): the button-up may never come.
static ABANDON: AtomicBool = AtomicBool::new(false);
static ELEVATED_SELF: AtomicBool = AtomicBool::new(false);

pub fn init() {
    ELEVATED_SELF.store(
        winapi::is_elevated(std::process::id()) == Some(true),
        Ordering::Relaxed,
    );
}

pub fn abandon() {
    ABANDON.store(true, Ordering::Relaxed);
}

/// The frame you see: DWM's extended frame bounds, or the window rect when DWM has none.
fn frame(h: HWND) -> Option<Rect> {
    let mut r = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let ok = unsafe {
        DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut r as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
    } >= 0;
    if ok && r.right > r.left {
        Some([r.left, r.top, r.right, r.bottom])
    } else {
        winapi::rect(h)
    }
}

/// Shows the frame `seen` without waiting for the app.
fn place(h: HWND, seen: Rect, size: bool) {
    let (Some(w), Some(f)) = (winapi::rect(h), frame(h)) else {
        return;
    };
    let r = snap::to_window(seen, w, f);
    let flags =
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS | if size { 0 } else { SWP_NOSIZE };
    unsafe {
        SetWindowPos(
            h,
            std::ptr::null_mut(),
            r[0],
            r[1],
            r[2] - r[0],
            r[3] - r[1],
            flags,
        )
    };
}

/// The window a Win+press at `pt` would drag: the top-level window under it, if it is an app's window that this
/// process may move. The desktop, the taskbar, this daemon's own windows and an elevated app's (when the daemon is
/// not elevated, Windows ignores its moves) are left alone, and so is a window with neither a title bar nor a
/// sizing border (a full-screen game, a popup).
fn target(pt: POINT) -> Option<HWND> {
    let h = unsafe { GetAncestor(WindowFromPoint(pt), GA_ROOT) };
    if h.is_null() {
        return None;
    }
    let style = unsafe { GetWindowLongPtrW(h, GWL_STYLE) } as u32;
    let pid = winapi::pid_of(h);
    let shell = matches!(
        winapi::class(h).as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    );
    let blocked = !ELEVATED_SELF.load(Ordering::Relaxed) && winapi::is_elevated(pid) == Some(true);
    (!shell && pid != std::process::id() && !blocked && style & (WS_CAPTION | WS_THICKFRAME) != 0)
        .then_some(h)
}

fn begin(h: HWND, pt: POINT, right: bool, now: u32) -> Live {
    let style = unsafe { GetWindowLongPtrW(h, GWL_STYLE) } as u32;
    let sizable = style & WS_THICKFRAME != 0;
    let mut start = frame(h).unwrap_or([pt.x, pt.y, pt.x + 1, pt.y + 1]);
    let mut restored = false;
    if !right && winapi::is_zoomed(h) {
        // A filled window comes out at its normal size, under the pointer at the same share of its width.
        let mut wp: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
        wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        if unsafe { GetWindowPlacement(h, &mut wp) } != 0 {
            let n = wp.rcNormalPosition;
            let (w, ht) = (n.right - n.left, n.bottom - n.top);
            let x = pt.x
                - ((pt.x - start[0]) as i64 * w as i64 / (start[2] - start[0]).max(1) as i64)
                    as i32;
            start = [x, start[1], x + w, start[1] + ht];
            unsafe { ShowWindowAsync(h, SW_SHOWNOACTIVATE) };
            restored = true;
        }
    }
    let kind = if right && sizable {
        snap::corner(start, pt.x, pt.y)
    } else {
        Kind::Move
    };
    Live {
        h,
        kind,
        up: if right { WM_RBUTTONUP } else { WM_LBUTTONUP },
        from: (pt.x, pt.y),
        start,
        snaps: sizable && !right,
        restored,
        target: None,
        began: now,
    }
}

fn work_areas() -> Vec<Rect> {
    winapi::monitors().into_iter().map(|m| m.rect).collect()
}

fn preview(to: Option<Rect>) {
    PREVIEW.with(|p| unsafe {
        let mut h = *p.borrow();
        if h.is_null() && to.is_some() {
            let class: Vec<u16> = "BaneySpacesSnapPreview\0".encode_utf16().collect();
            let hi = GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(DefWindowProcW),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hi,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: CreateSolidBrush(0x00D0_8040),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc);
            let ex = WS_EX_LAYERED
                | WS_EX_TRANSPARENT
                | WS_EX_TOOLWINDOW
                | WS_EX_NOACTIVATE
                | WS_EX_TOPMOST;
            h = CreateWindowExW(
                ex,
                class.as_ptr(),
                class.as_ptr(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                hi,
                std::ptr::null(),
            );
            SetLayeredWindowAttributes(h, 0, 90, LWA_ALPHA);
            *p.borrow_mut() = h;
        }
        match to {
            Some(r) if !h.is_null() => {
                SetWindowPos(
                    h,
                    HWND_TOPMOST,
                    r[0],
                    r[1],
                    r[2] - r[0],
                    r[3] - r[1],
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
            _ if !h.is_null() => {
                ShowWindow(h, SW_HIDE);
            }
            _ => {}
        }
    });
}

/// Called by the mouse hook for every event. True: swallow it.
pub fn on_mouse(
    msg: u32,
    pt: POINT,
    time: u32,
    win_held: bool,
    injected: bool,
    tx: Option<&Sender<Msg>>,
) -> bool {
    DRAG.with(|d| {
        let mut d = d.borrow_mut();
        if ABANDON.swap(false, Ordering::Relaxed) {
            if let State::Live(l) = &*d {
                place(l.h, l.start, true);
            }
            preview(None);
            *d = State::Idle;
        }
        match &mut *d {
            State::Idle => {
                let right = msg == WM_RBUTTONDOWN;
                if injected || !win_held || !(right || msg == WM_LBUTTONDOWN) {
                    return false;
                }
                let Some(h) = target(pt) else { return false };
                *d = State::Live(begin(h, pt, right, time));
                true
            }
            State::Cancelled { up } => {
                if msg == *up {
                    *d = State::Idle;
                }
                msg != WM_MOUSEMOVE
            }
            State::Live(l) => {
                let to = snap::dragged(l.kind, l.start, pt.x - l.from.0, pt.y - l.from.1);
                if msg == WM_MOUSEMOVE {
                    place(l.h, to, l.kind != Kind::Move || l.restored);
                    let t = if l.snaps {
                        snap::snap(pt.x, pt.y, &work_areas())
                    } else {
                        None
                    };
                    if t.map(|t| t.1) != l.target.map(|t| t.1) {
                        preview(t.map(|t| t.1));
                    }
                    l.target = t;
                    return false;
                }
                if msg != l.up {
                    return true; // another button while dragging: nobody else sees it
                }
                let (how, end) = match l.target {
                    Some((name, r)) => (format!("snapped {name}"), r),
                    None => (
                        if l.kind == Kind::Move {
                            "moved".to_string()
                        } else {
                            "resized".to_string()
                        },
                        to,
                    ),
                };
                place(l.h, end, true);
                preview(None);
                // Win is still down: tell Windows it was used, so letting it go does not open Start.
                crate::hook::mask_start_menu();
                if let Some(tx) = tx {
                    let id = winapi::window_name(winapi::id_of(l.h));
                    let _ = tx.send(Msg::Note(format!(
                        "drag: {id} {how} to {},{},{},{} in {} ms",
                        end[0],
                        end[1],
                        end[2],
                        end[3],
                        time.wrapping_sub(l.began)
                    )));
                    let _ = tx.send(Msg::Win {
                        event: crate::hook::EVENT_SYSTEM_MOVESIZEEND,
                        hwnd: winapi::id_of(l.h),
                    });
                }
                *d = State::Idle;
                true
            }
        }
    })
}

/// Called by the keyboard hook for Escape going down. True: a drag was under way and is now undone; swallow the key.
pub fn on_escape(tx: Option<&Sender<Msg>>) -> bool {
    DRAG.with(|d| {
        let mut d = d.borrow_mut();
        let State::Live(l) = &*d else { return false };
        if l.restored {
            unsafe { ShowWindowAsync(l.h, SW_SHOWMAXIMIZED) };
        } else {
            place(l.h, l.start, true);
        }
        preview(None);
        crate::hook::mask_start_menu();
        if let Some(tx) = tx {
            let s = l.start;
            let _ = tx.send(Msg::Note(format!(
                "drag: {} cancelled by Escape, back to {},{},{},{}",
                winapi::window_name(winapi::id_of(l.h)),
                s[0],
                s[1],
                s[2],
                s[3]
            )));
        }
        *d = State::Cancelled { up: l.up };
        true
    })
}
