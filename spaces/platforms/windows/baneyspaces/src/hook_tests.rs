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
/// masking key (and Alt), while `WATCH` is on. That is what the shell gets.
static WATCH: AtomicBool = AtomicBool::new(false);
static SEEN: Mutex<Vec<(u32, bool)>> = Mutex::new(Vec::new());

unsafe extern "system" fn behind(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && WATCH.load(Ordering::Relaxed) {
        let k = &*(lp as *const KBDLLHOOKSTRUCT);
        if matches!(k.vkCode, 0x5B | 0xE8 | 0x30..=0x39 | 0x12 | 0xA4 | 0xA5) {
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

    // A person's Win+9: the release comes after the mask has gone through, so the hook lets that very release pass and
    // re-sends nothing (one 0xE8, then Win up).
    let seen_now = |e: (u32, bool)| SEEN.lock().unwrap().contains(&e);
    let wait_for = |e: (u32, bool)| {
        let end = Instant::now() + Duration::from_secs(2);
        while !seen_now(e) && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        seen_now(e)
    };
    std::thread::sleep(Duration::from_millis(200));
    SEEN.lock().unwrap().clear();
    WATCH.store(true, Ordering::Relaxed);
    send(&[
        key(VK_LWIN, false, TEST_INPUT_MARK),
        key(b'9' as u16, false, TEST_INPUT_MARK),
        key(b'9' as u16, true, TEST_INPUT_MARK),
    ]);
    assert!(wait_for((0xE8, true)), "the hook sends the mask while Win is down: {:x?}", SEEN.lock().unwrap());
    send(&[key(VK_LWIN, true, TEST_INPUT_MARK)]);
    assert!(wait_for((0x5B, true)), "Win's release reaches the shell");
    std::thread::sleep(Duration::from_millis(200));
    WATCH.store(false, Ordering::Relaxed);
    let seen = SEEN.lock().unwrap().clone();
    assert!(
        seen == [(0x5B, false), (0xE8, false), (0xE8, true), (0x5B, true)],
        "a slow Win+9 reads Win down, one mask, Win up, nothing re-sent: {seen:x?}"
    );
    assert!(matches!(first(&rx, Duration::from_secs(3), is_chord), Some(Msg::Chord { .. })));

    // `[keys] mod = "alt"`: Alt+8 must not reach the app as a bare Alt tap, or it opens its menu bar on every switch.
    set_table(crate::keys::defaults(crate::keys::parse_mod("alt").expect("alt")));
    const VK_LMENU: u16 = 0xA4;
    std::thread::sleep(Duration::from_millis(200));
    SEEN.lock().unwrap().clear();
    WATCH.store(true, Ordering::Relaxed);
    send(&[
        key(VK_LMENU, false, TEST_INPUT_MARK),
        key(b'8' as u16, false, TEST_INPUT_MARK),
        key(b'8' as u16, true, TEST_INPUT_MARK),
    ]);
    let masked = wait_for((0xE8, true));
    send(&[key(VK_LMENU, true, TEST_INPUT_MARK)]);
    let _ = wait_for((0xA4, true));
    std::thread::sleep(Duration::from_millis(200));
    WATCH.store(false, Ordering::Relaxed);
    let seen = SEEN.lock().unwrap().clone();
    let alt_up = seen.iter().position(|&e| e == (0xA4, true));
    assert!(
        masked && alt_up.is_some_and(|i| seen[..i].contains(&(0xE8, false)) && seen[..i].contains(&(0xE8, true))),
        "behind the hook, Alt+8 must read Alt down, the masking key, Alt up: {seen:x?}"
    );
    assert!(matches!(first(&rx, Duration::from_secs(3), is_chord), Some(Msg::Chord { .. })), "Alt+8 is a chord with mod = alt");
    set_table(crate::keys::defaults(crate::keys::parse_mod("win").expect("win")));

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
    let _ = app.wait();
    assert!(shown.is_some(), "no window event for a new Notepad");

    stop();
    unsafe { PostThreadMessageW(watcher, WM_QUIT, 0, 0) };
}

#[test]
fn the_chord_is_recorded_before_its_mask_goes_out() {
    // #564 second-F4: sent first, the mask's 0xE8 key-up could be seen before the chord is recorded, and a release
    // within PENDING_MS would then be held back and re-sent behind later keys (Win+1, then a quick E, runs Win+E).
    let src = include_str!("hook.rs").replace("\r\n", "\n");
    let at = src.find("if crate::keys::chord_masks(mods) {").expect("the chord's mask");
    let block = &src[at..at + src[at..].find("Msg::Chord").expect("the chord message")];
    let chord = block.find("WIN.chord(true, k.time)").expect("the chord recorded as masked");
    let nudge = block.find("nudge_input()").expect("the mask sent");
    assert!(chord < nudge, "the chord is recorded before the mask goes out");
    assert!(block[nudge..].contains("WIN.reset()"), "a mask SendInput refused clears the chord again");
    // And the cleared chord holds no release back.
    let m = WinMask::new();
    let resent = std::cell::Cell::new(0);
    m.win_down(false);
    m.chord(true, 100);
    m.reset();
    assert!(!m.win_up(110, || {
        resent.set(resent.get() + 1);
        3
    }));
    assert_eq!(resent.get(), 0);
}
