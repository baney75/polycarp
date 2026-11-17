//! The hooks on the runner's real desktop: a typed chord comes out as `Msg::Chord`, an injected one doesn't, the
//! session window turns sign-out into `EndSession` and a lock or a rebuilt taskbar into `Msg::Resync`, and a window
//! another process opens is reported. `start` can run once per process, so this is one test, in order.

use super::*;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_LWIN;

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

/// Win+digit as the daemon sees a person type it: Win down, the digit, the masking key, then Win up.
fn chord(digit: u16, extra: usize) {
    send(&[
        key(VK_LWIN, false, extra),
        key(digit, false, extra),
        key(digit, true, extra),
    ]);
    mask_start_menu();
    send(&[key(VK_LWIN, true, extra)]);
}

fn session_window() -> HWND {
    let class = wide("BaneySpacesSession");
    unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) }
}

#[test]
fn the_hooks_on_a_real_desktop() {
    let (tx, rx) = channel();
    let problems = start(tx, crate::keys::bindings(), on_end);
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(TEST_INPUT.load(Ordering::Relaxed), crate::apps::test_ops_enabled(), "test input follows the test-ops switch");
    for on in [false, true] {
        TEST_INPUT.store(on, Ordering::Relaxed);
        assert!(!injected_by_software(false, 0), "hardware input is typed");
        assert!(!injected_by_software(false, TEST_INPUT_MARK));
        assert!(injected_by_software(true, 0), "SendInput without the mark is software");
        assert_eq!(injected_by_software(true, TEST_INPUT_MARK), !on, "the mark counts only while test input is on");
    }
    // Left on, as `start` leaves it with BANEYSPACES_TEST_OPS in a test-ops build.
    let is_chord = |m: &Msg| matches!(m, Msg::Chord(_));

    chord(b'5' as u16, TEST_INPUT_MARK);
    match first(&rx, Duration::from_secs(3), is_chord) {
        Some(Msg::Chord(args)) => assert_eq!(args, ["switch", "5"]),
        other => panic!("no chord for a marked Win+5: {other:?}"),
    }
    assert!(
        !SWALLOWED[b'5' as usize].load(Ordering::Relaxed),
        "the key-up of a taken chord is swallowed too"
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
    assert!(shown.is_some(), "no window event for a new Notepad");

    stop();
}
