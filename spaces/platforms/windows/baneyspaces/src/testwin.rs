//! Real top-level windows for unit tests, each on its own thread with a message loop, the way an app's
//! window lives. CI runs `cargo test` on a runner with an interactive desktop (explorer.exe and DWM), so the
//! shell cloak, layered alpha and the foreground all behave as they do on a person's machine.

use std::sync::{mpsc, OnceLock};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::COLOR_WINDOW;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

pub const CLASS: &str = "BaneySpacesUnitTest";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn window_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if m == WM_DESTROY {
        PostQuitMessage(0);
        return 0;
    }
    DefWindowProcW(h, m, w, l)
}

fn register() {
    static DONE: OnceLock<()> = OnceLock::new();
    DONE.get_or_init(|| unsafe {
        let name = wide(CLASS);
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: GetModuleHandleW(std::ptr::null()),
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: (COLOR_WINDOW + 1) as usize as _,
            lpszMenuName: std::ptr::null(),
            lpszClassName: name.as_ptr(),
        };
        RegisterClassW(&wc);
    });
}

/// One window, closed when dropped.
pub struct TestWin {
    pub hwnd: HWND,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl TestWin {
    /// A captioned, visible app window at (200, 200), 400 x 300, with these extra extended styles.
    pub fn open(title: &str, ex_style: u32) -> Self {
        register();
        let (tx, rx) = mpsc::channel::<isize>();
        let title = title.to_string();
        let thread = std::thread::spawn(move || unsafe {
            let (class, text) = (wide(CLASS), wide(&title));
            let h = CreateWindowExW(
                ex_style,
                class.as_ptr(),
                text.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                200,
                200,
                400,
                300,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            );
            let _ = tx.send(h as isize);
            if h.is_null() {
                return;
            }
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
        let h = rx.recv().unwrap_or(0) as HWND;
        assert!(!h.is_null(), "CreateWindowExW failed");
        Self {
            hwnd: h,
            thread: Some(thread),
        }
    }

    pub fn id(&self) -> i64 {
        crate::winapi::id_of(self.hwnd)
    }
}

impl Drop for TestWin {
    fn drop(&mut self) {
        unsafe { PostMessageW(self.hwnd, WM_CLOSE, 0, 0) };
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Polls `f` for up to two seconds: DWM and the shell apply some changes a frame or two later.
pub fn eventually(mut f: impl FnMut() -> bool) -> bool {
    for _ in 0..100 {
        if f() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    false
}
