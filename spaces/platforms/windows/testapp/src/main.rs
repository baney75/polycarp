#![cfg_attr(windows, windows_subsystem = "windows")]
//! `bs-testapp`: one plain window, for the BaneySpaces live tests. It exists because the apps Windows ships
//! either forward a second launch into a running copy (Notepad) or restore the user's unsaved text
//! (Notepad), so none is safe to hand an agent. This one is its own process every time and keeps nothing
//! between runs.
//!
//! `WM_APP` opens a MessageBox owned by the window: the live test posts it to check that a dialog an agent's
//! app opens is hidden too.
//!
//! `--refuse-ghost` titles the window so that a `test-ops` daemon refuses to ghost it (Windows has no easy way to
//! make a window refuse), to check what happens to an agent's window that cannot be ghosted.
//!
//! It is only ever started by the live tests (`BANEYSPACES_TEST_OPS`); the daemon refuses to start
//! it otherwise. The first `ShowWindow` honors the launcher's show command, so a launch with
//! `SW_SHOWMINNOACTIVE` starts minimized and never draws.

#[cfg(windows)]
fn main() {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            WM_APP => {
                let text = wide("A dialog opened by the test app.");
                let caption = wide("Test dialog");
                MessageBoxW(hwnd, text.as_ptr(), caption.as_ptr(), MB_OK);
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }

    unsafe {
        let hi = GetModuleHandleW(std::ptr::null());
        let class = wide("BaneySpacesTestApp");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hi,
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: 6 as _, // COLOR_WINDOW + 1
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&wc);
        // `--refuse-ghost` only changes the title: a build with the `test-ops` feature makes the daemon's ghost step
        // refuse a window with this title, so the live test can drive the "window that refuses the ghost" path.
        let title = wide(if std::env::args().any(|a| a == "--refuse-ghost") { "BaneySpaces test app (refuses ghost)" } else { "BaneySpaces test app" });
        let hwnd = CreateWindowExW(0, class.as_ptr(), title.as_ptr(), WS_OVERLAPPEDWINDOW, 140, 140, 420, 280, std::ptr::null_mut(), std::ptr::null_mut(), hi, std::ptr::null());
        ShowWindow(hwnd, SW_SHOWDEFAULT);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("bs-testapp is a Windows test window");
}
