//! The hooks on the runner's real desktop: a typed chord comes out as `Msg::Chord`, an injected one doesn't, the
//! session window turns sign-out into `EndSession` and a lock or a rebuilt taskbar into `Msg::Resync`, and a window
//! another process opens is reported. `start` can run once per process, so this is one test, in order.

use super::*;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_LWIN};

static ENDS: Mutex<Vec<EndSession>> = Mutex::new(Vec::new());

fn on_end(e: EndSession) {
    ENDS.lock().unwrap().push(e);
}

/// The first message `want` accepts within `wait`, skipping the rest (window events never stop on a desktop).
fn first(rx: &Receiver<Msg>, wait: Duration, want: impl Fn(&Msg) -> bool) -> Option<Msg> {
    let end = Instant::now() + wait;
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(m) if want(&m) => return Some(m),
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    None
}

fn key(vk: u16, up: bool, extra: usize) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                time: 0,
                dwExtraInfo: extra,
            },
        },
    }
}

fn send(keys: &[INPUT]) {
    let n = unsafe {
        SendInput(
            keys.len() as u32,
            keys.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    assert_eq!(n as usize, keys.len(), "SendInput was blocked");
}

/// Win+digit as a person types it: Win down, the digit down and up, Win up.
fn chord(digit: u16, extra: usize) {
    send(&[
        key(VK_LWIN, false, extra),
        key(digit, false, extra),
        key(digit, true, extra),
        key(VK_LWIN, true, extra),
    ]);
}

/// What a hook behind the daemon's sees (it is installed first, so it is called after ours): Win, the digits and the
/// masking key, while `WATCH` is on. That is what the shell gets.
static WATCH: AtomicBool = AtomicBool::new(false);
static SEEN: Mutex<Vec<(u32, bool)>> = Mutex::new(Vec::new());

unsafe extern "system" fn behind(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && WATCH.load(Ordering::Relaxed) {
        let k = &*(lp as *const KBDLLHOOKSTRUCT);
        if matches!(k.vkCode, 0x5B | 0xE8 | 0x30..=0x39) {
            let up = wp as u32 == WM_KEYUP || wp as u32 == WM_SYSKEYUP;
            SEEN.lock().unwrap().push((k.vkCode, up));
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wp, lp)
}

/// Installs `behind` on a thread of its own with a message loop; returns that thread's id, for WM_QUIT.
fn watch_behind() -> u32 {
    let (tx, rx) = channel();
    std::thread::spawn(move || unsafe {
        let h = SetWindowsHookExW(WH_KEYBOARD_LL, Some(behind), std::ptr::null_mut(), 0);
        let _ = tx.send((!h.is_null(), GetCurrentThreadId()));
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
        UnhookWindowsHookEx(h);
    });
    let (ok, id) = rx.recv().expect("the watching thread starts");
    assert!(ok, "the watching hook is installed");
    id
}

fn session_window() -> HWND {
    let class = wide("BaneySpacesSession");
    unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) }
}

#[test]
fn the_hooks_on_a_real_desktop() {
    // The chords below are real Win keys: no daemon test may hide windows meanwhile.
    let _turn = crate::testwin::desktop_turn();
    let watcher = watch_behind();
    let (tx, rx) = channel();
    set_table(crate::keys::defaults(crate::keys::parse_mod("win").expect("win")));
    let problems = start(tx, on_end);
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(
        TEST_INPUT.load(Ordering::Relaxed),
        crate::apps::test_ops_enabled(),
        "test input follows the test-ops switch"
    );
    for on in [false, true] {
        TEST_INPUT.store(on, Ordering::Relaxed);
        assert!(!injected_by_software(false, 0), "hardware input is typed");
        assert!(!injected_by_software(false, TEST_INPUT_MARK));
        assert!(
            injected_by_software(true, 0),
            "SendInput without the mark is software"
        );
        assert_eq!(
            injected_by_software(true, TEST_INPUT_MARK),
            !on,
            "the mark counts only while test input is on"
        );
    }
    // Left on, as `start` leaves it with BANEYSPACES_TEST_OPS in a test-ops build.
    let is_chord = |m: &Msg| matches!(m, Msg::Chord { .. });

    chord(b'5' as u16, TEST_INPUT_MARK);
    match first(&rx, Duration::from_secs(3), is_chord) {
        Some(Msg::Chord { args, .. }) => assert_eq!(args, ["switch", "5"]),
        other => panic!("no chord for a marked Win+5: {other:?}"),
    }
    assert!(
        !SWALLOWED[b'5' as usize].load(Ordering::Relaxed),
        "the key-up of a taken chord is swallowed too"
    );

    // Win+8 typed in one go, as the harness's SendInput batch or a quick person types it: Win is up before the daemon's
    // worker can act on the chord. Behind the hook, Win must never go down and up with nothing between: the shell
    // opens Start (Search) on that, over the user's window. Win+5's own release and mask come first: the hook re-sends
    // them at the end of the input queue, so wait for Win to read up, then let the rest of that queue drain.
    let end = Instant::now() + Duration::from_secs(2);
    while held(VK_LWIN as u32) && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!held(VK_LWIN as u32), "Win+5's release never came back from the hook");
    std::thread::sleep(Duration::from_millis(200));
    SEEN.lock().unwrap().clear();
    WATCH.store(true, Ordering::Relaxed);
    send(&[
        key(VK_LWIN, false, TEST_INPUT_MARK),
        key(b'8' as u16, false, TEST_INPUT_MARK),
        key(b'8' as u16, true, TEST_INPUT_MARK),
        key(VK_LWIN, true, TEST_INPUT_MARK),
    ]);
    match first(&rx, Duration::from_secs(3), is_chord) {
        Some(Msg::Chord { args, .. }) => assert_eq!(args, ["switch", "8"]),
        other => panic!("no chord for a marked Win+8 typed in one go: {other:?}"),
    }
    let end = Instant::now() + Duration::from_secs(2);
    while !SEEN.lock().unwrap().contains(&(0x5B, true)) && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(Duration::from_millis(200));
    WATCH.store(false, Ordering::Relaxed);
    let seen = SEEN.lock().unwrap().clone();
    let win_up = seen.iter().position(|&e| e == (0x5B, true));
    assert!(
        seen.first() == Some(&(0x5B, false))
            && win_up.is_some_and(|i| seen[..i].contains(&(0xE8, false)) && seen[..i].contains(&(0xE8, true)))
            && !seen.iter().any(|&(vk, _)| vk == b'8' as u32),
        "behind the hook, Win+8 typed in one go must read Win down, the masking key, Win up, and no 8: {seen:x?}"
    );

    chord(b'6' as u16, 0);
    assert!(
        first(&rx, Duration::from_millis(800), is_chord).is_none(),
        "an unmarked injected Win+6 must pass through"
    );

    TEST_INPUT.store(false, Ordering::Relaxed);
    chord(b'7' as u16, TEST_INPUT_MARK);
    assert!(
        first(&rx, Duration::from_millis(800), is_chord).is_none(),
        "the mark means nothing with test input off"
    );

    // The session window: sign-out asked, cancelled, happening.
    let w = session_window();
    assert!(!w.is_null(), "the session window exists");
    unsafe {
        assert_eq!(
            SendMessageW(w, WM_QUERYENDSESSION, 0, 0),
            1,
            "sign-out is never refused"
        );
        SendMessageW(w, WM_ENDSESSION, 0, 0);
        SendMessageW(w, WM_ENDSESSION, 1, 0);
    }
    assert_eq!(
        *ENDS.lock().unwrap(),
        [EndSession::Query, EndSession::Cancelled, EndSession::Ending]
    );

    // A lock or unlock, and explorer.exe rebuilding the taskbar, each ask for a fresh look at every window.
    let resync = |m: &Msg| matches!(m, Msg::Resync);
    unsafe { SendMessageW(w, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK, 0) };
    assert!(
        first(&rx, Duration::from_secs(2), resync).is_some(),
        "a lock asks for a resync"
    );
    unsafe { SendMessageW(w, TASKBAR_CREATED.load(Ordering::Relaxed), 0, 0) };
    assert!(
        first(&rx, Duration::from_secs(2), resync).is_some(),
        "TaskbarCreated asks for a resync"
    );
    unsafe { SendMessageW(w, WM_WTSSESSION_CHANGE, 99, 0) };
    assert!(
        first(&rx, Duration::from_millis(300), resync).is_none(),
        "other session changes are not a resync"
    );

    // An agent's new window is a ghost before its event reaches the worker: the event thread ghosted it, and
    // left what it replaced for the worker to record. The worker may be busy for tens of milliseconds (a
    // request holding its lock, a write of state.json), and the live suite caught a dialog drawn in that time.
    let form = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = 'bs early ghost'; [Windows.Forms.Application]::Run($f)";
    // No console window (CREATE_NO_WINDOW): one would report the same pid and is not the window under test.
    use std::os::windows::process::CommandExt;
    let agents = crate::testwin::agents_turn();
    let mut agent = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", form])
        .creation_flags(0x0800_0000)
        .spawn()
        .expect("powershell.exe starts");
    let pid = agent.id();
    share_agents(vec![(pid, crate::winapi::process_start(pid))], 0, false);
    // The form, by its title, when it is shown: that is when it would draw. Its CREATE may come before its caption.
    let form_shown = |m: &Msg| match m {
        Msg::Win { event, hwnd } if *event == EVENT_OBJECT_SHOW => {
            let h = crate::winapi::hwnd(*hwnd);
            crate::winapi::pid_of(h) == pid && crate::winapi::title(h) == "bs early ghost"
        }
        _ => false,
    };
    let seen = first(&rx, Duration::from_secs(30), form_shown);
    let read = seen.as_ref().map(|m| match m {
        Msg::Win { hwnd, .. } => {
            let h = crate::winapi::hwnd(*hwnd);
            let facts = format!(
                "ex_style {:#x}, alpha {:?}, caption {}, top-level {}, visible {}",
                crate::winapi::ex_style(h),
                crate::winapi::layered_alpha(h),
                crate::winapi::has_caption(h),
                crate::winapi::is_top_level(h),
                crate::winapi::is_visible(h)
            );
            (crate::cloak::has_ghost_bits(h) && crate::winapi::layered_alpha(h) == Some(0), take_early(*hwnd), facts)
        }
        _ => unreachable!(),
    });
    share_agents(vec![], 0, true);
    drop(agents);
    let _ = agent.kill();
    let _ = agent.wait();
    let (is_ghost, undo, facts) = read.expect("no SHOW event for the agent's form");
    assert!(is_ghost, "the agent's form was not a ghost when its SHOW reached the worker: {facts}");
    let undo = undo.expect("the event thread left nothing for the worker to record");
    assert_ne!(undo.alpha, Some(0), "the record holds the form's own alpha, not the ghost's");
    assert_eq!(undo.ex_style & (WS_EX_TRANSPARENT as i64), 0, "the record holds the form's own style, not the ghost's");

    // A window another process opens is reported (the hook skips the daemon's own process).
    let mut app = std::process::Command::new("notepad.exe")
        .spawn()
        .expect("notepad.exe starts");
    let shown = first(
        &rx,
        Duration::from_secs(10),
        |m| matches!(m, Msg::Win { event, .. } if *event == EVENT_OBJECT_SHOW || *event == EVENT_OBJECT_CREATE),
    );
    let _ = app.kill();
    let _ = app.wait();
    assert!(shown.is_some(), "no window event for a new Notepad");

    stop();
    unsafe { PostThreadMessageW(watcher, WM_QUIT, 0, 0) };
}

/// The ghost's own bits: layered, click-through, never activated.
const GHOST_BITS: i64 = (WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE) as i64;

#[test]
fn a_window_the_worker_is_showing_is_left_alone() {
    // sol-F1: the worker shows a ghost alpha first, then its style. A window caught between the two has the ghost's
    // bits at alpha 255. The event thread must not ghost it again: what it would keep to put back is the ghost.
    let _agents = crate::testwin::agents_turn();
    let w = crate::testwin::TestWin::open("mid show", 0);
    let own = crate::winapi::ex_style(w.hwnd);
    crate::winapi::set_ex_style(w.hwnd, own | GHOST_BITS);
    assert!(crate::winapi::set_layered_alpha(w.hwnd, 255));
    let pid = std::process::id();
    share_agents(vec![(pid, crate::winapi::process_start(pid))], 0, false);
    ghost_early(w.hwnd);
    let kept = take_early(w.id());
    share_agents(vec![], 0, true);
    assert_eq!(kept, None, "the event thread ghosted a window the worker is showing and kept the ghost as its style");
    assert_eq!(crate::winapi::layered_alpha(w.hwnd), Some(255), "the window was left as the worker had it");
}

/// What the window under test saw while the early ghost changed its style: was the turn free, and did the ghost of
/// another window made from inside that call take.
static PREV_PROC: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
static OTHER: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
static TURN_FREE: Mutex<Option<bool>> = Mutex::new(None);

unsafe extern "system" fn style_watch(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::{CallWindowProcW, WM_STYLECHANGING, WNDPROC};
    let mut seen = TURN_FREE.lock().unwrap();
    if msg == WM_STYLECHANGING && seen.is_none() {
        // As a nested event would: the event thread is re-entered while it waits on this window's thread.
        let free = TURN.try_lock().is_ok();
        *seen = Some(free);
        drop(seen);
        if free {
            ghost_early(OTHER.load(Ordering::SeqCst) as HWND);
        }
    } else {
        drop(seen);
    }
    let prev: WNDPROC = std::mem::transmute(PREV_PROC.load(Ordering::SeqCst));
    CallWindowProcW(prev, h, msg, wp, lp)
}

#[test]
fn the_early_ghost_lets_go_of_the_turn_while_it_waits_on_the_window() {
    // first-F1: the style change sends to the window's thread and waits, and so does the taskbar call. An event
    // that re-enters the event thread in that wait (an agent opening its window and a dialog together) ghosts its
    // own window, and every hide and show the worker makes needs the turn too: neither may find it held.
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_WNDPROC};
    let _agents = crate::testwin::agents_turn();
    let w = crate::testwin::TestWin::open("early, waited on", 0);
    let other = crate::testwin::TestWin::open("early, from inside", 0);
    OTHER.store(other.hwnd as isize, Ordering::SeqCst);
    *TURN_FREE.lock().unwrap() = None;
    let prev = unsafe { SetWindowLongPtrW(w.hwnd, GWLP_WNDPROC, style_watch as *const () as isize) };
    PREV_PROC.store(prev, Ordering::SeqCst);
    let pid = std::process::id();
    share_agents(vec![(pid, crate::winapi::process_start(pid))], 0, false);
    ghost_early(w.hwnd);
    let free = TURN_FREE.lock().unwrap().take();
    let outer = take_early(w.id());
    let inner = take_early(other.id());
    share_agents(vec![], 0, true);
    unsafe { SetWindowLongPtrW(w.hwnd, GWLP_WNDPROC, prev) };
    assert_eq!(free, Some(true), "the early ghost held the turn while the window's thread answered its style change");
    assert!(outer.is_some(), "the window was ghosted and left for the worker to record");
    assert!(inner.is_some(), "a ghost made from inside that wait took");
}
