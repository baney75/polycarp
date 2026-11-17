//! `agent press` on Windows: keys posted as window messages to one control of an agent's window.
//!
//! Never `SendInput`: that goes to whatever window is in front, which is the user's. A posted key reaches only the
//! window it is posted to, so the daemon's scope guard (the agent workspace, the agent's own process) decides where
//! keys can go, the same as for `type`. A named key is posted as `WM_KEYDOWN` and `WM_KEYUP`, and the app's own
//! `TranslateMessage` makes its character (Return, Tab, Backspace); a character is posted as `WM_CHAR` alone, so the
//! keyboard layout plays no part. Modifier chords are refused: an app reads Ctrl, Alt and Shift from the keyboard
//! state, which a posted message doesn't change and BaneySpaces never touches.

use baneyspaces_core::envelope::{Envelope, Retry};
use serde_json::Value;

pub const WM_KEYDOWN: u32 = 0x0100;
pub const WM_KEYUP: u32 = 0x0101;
pub const WM_CHAR: u32 = 0x0102;
/// More strokes than this in one call is a script, not a key press: use `type`.
pub const MAX_STROKES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stroke {
    /// A virtual-key code, and whether it is an extended key (the arrows and the block above them).
    Key(u16, bool),
    Char(char),
}

/// The Mac's key names (`KeyParse`), with the Mac's meaning: `delete` is Backspace, `forwarddelete` is Delete.
const NAMED: &[(&str, u16, bool)] = &[
    ("return", 0x0D, false),
    ("enter", 0x0D, false),
    ("tab", 0x09, false),
    ("delete", 0x08, false),
    ("backspace", 0x08, false),
    ("escape", 0x1B, false),
    ("esc", 0x1B, false),
    ("forwarddelete", 0x2E, true),
    ("del", 0x2E, true),
    ("home", 0x24, true),
    ("end", 0x23, true),
    ("pageup", 0x21, true),
    ("pagedown", 0x22, true),
    ("left", 0x25, true),
    ("up", 0x26, true),
    ("right", 0x27, true),
    ("down", 0x28, true),
];

const SYMBOLS: &[(&str, char)] = &[
    ("space", ' '),
    ("minus", '-'),
    ("equals", '='),
    ("comma", ','),
    ("period", '.'),
    ("slash", '/'),
    ("backslash", '\\'),
    ("semicolon", ';'),
    ("quote", '\''),
    ("grave", '`'),
    ("leftbracket", '['),
    ("rightbracket", ']'),
    ("asterisk", '*'),
    ("plus", '+'),
    ("underscore", '_'),
    ("colon", ':'),
    ("question", '?'),
    ("pipe", '|'),
];

const MODIFIERS: &[&str] = &[
    "cmd", "command", "super", "meta", "win", "shift", "alt", "option", "opt", "ctrl", "control",
    "fn",
];

fn bad(spec: &str, why: &str) -> Envelope {
    Envelope::err(
        "invalid_args",
        format!("{why}: {spec}"),
        Retry::Never,
        "Write a key like Return, Tab, Escape, Left, F5, a or 9; a symbol as itself (* or ?) or by its name (asterisk); several keys are separated by spaces (\"h i Return\").",
    )
}

/// One key: a name, a function key, or a single character.
fn stroke(tok: &str) -> Result<Stroke, Envelope> {
    let lower = tok.to_ascii_lowercase();
    let mut chars = tok.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return Ok(Stroke::Char(c));
    }
    if let Some(&(_, vk, ext)) = NAMED.iter().find(|(n, _, _)| *n == lower) {
        return Ok(Stroke::Key(vk, ext));
    }
    if let Some(&(_, c)) = SYMBOLS.iter().find(|(n, _)| *n == lower) {
        return Ok(Stroke::Char(c));
    }
    if let Some(n) = lower
        .strip_prefix('f')
        .and_then(|d| d.parse::<u16>().ok())
        .filter(|n| (1..=12).contains(n))
    {
        return Ok(Stroke::Key(0x70 + n - 1, false));
    }
    if lower.contains('+') && MODIFIERS.contains(&lower.split('+').next().unwrap_or("")) {
        return Err(Envelope::err(
            "not_supported",
            format!("{tok} holds a modifier, and modifier keys can't be sent on Windows"),
            Retry::Never,
            "An app reads Ctrl, Alt and Shift from the keyboard, which BaneySpaces never touches. Press keys without modifiers, or use type, set-value or click on a ref.",
        ));
    }
    Err(bad(tok, "not a key"))
}

/// `"h i Return"`: the keys, in order.
pub fn parse(spec: &str) -> Result<Vec<Stroke>, Envelope> {
    let strokes = spec
        .split_whitespace()
        .map(stroke)
        .collect::<Result<Vec<_>, _>>()?;
    if strokes.is_empty() {
        return Err(bad(spec, "no key given"));
    }
    if strokes.len() > MAX_STROKES {
        return Err(bad(
            &format!("{} keys", strokes.len()),
            &format!("at most {MAX_STROKES} keys in one press; use type for text"),
        ));
    }
    Ok(strokes)
}

/// The messages to post for the strokes: (message, wParam, lParam). `scan` gives a key's scan code.
pub fn messages(strokes: &[Stroke], scan: &dyn Fn(u16) -> u32) -> Vec<(u32, usize, isize)> {
    let mut out = vec![];
    for s in strokes {
        match *s {
            Stroke::Key(vk, ext) => {
                let base = 1 | (scan(vk) & 0xFF) << 16 | u32::from(ext) << 24;
                out.push((WM_KEYDOWN, vk as usize, base as i32 as isize));
                out.push((
                    WM_KEYUP,
                    vk as usize,
                    (base | 1 << 30 | 1 << 31) as i32 as isize,
                ));
            }
            Stroke::Char(c) => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push((WM_CHAR, *unit as usize, 1));
                }
            }
        }
    }
    out
}

/// The middle of an element's bounds, as the engine reads them back (`x`, `y`, `width`, `height`, at any depth of
/// `data`). None when they can't be read: the keys then go to the window's own focus.
pub fn center(data: &Value) -> Option<(i32, i32)> {
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64);
    let mut stack = vec![data];
    while let Some(v) = stack.pop() {
        if let (Some(x), Some(y), Some(w), Some(h)) =
            (n(v, "x"), n(v, "y"), n(v, "width"), n(v, "height"))
        {
            return (w > 0.0 && h > 0.0).then(|| ((x + w / 2.0) as i32, (y + h / 2.0) as i32));
        }
        if let Some(o) = v.as_object() {
            stack.extend(o.values());
        }
    }
    None
}

/// Where the keys went: the control under the ref, the control the window's thread has focused, or the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Control,
    Focus,
    Window,
}

impl Target {
    pub fn name(self) -> &'static str {
        match self {
            Target::Control => "control",
            Target::Focus => "focus",
            Target::Window => "window",
        }
    }
}

#[cfg(windows)]
mod win {
    use super::{messages, Stroke, Target};
    use windows_sys::Win32::Foundation::{HWND, POINT};
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MapVirtualKeyW, MAPVK_VK_TO_VSC};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        ChildWindowFromPointEx, GetAncestor, GetGUIThreadInfo, GetWindowThreadProcessId,
        PostMessageW, CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, GA_ROOT, GUITHREADINFO,
    };

    /// The deepest child of `top` at the screen point, if it is not `top` itself.
    fn control_at(top: HWND, at: (i32, i32)) -> Option<HWND> {
        let mut cur = top;
        for _ in 0..16 {
            let mut p = POINT { x: at.0, y: at.1 };
            // SAFETY: plain Win32 calls on a window handle and a stack point.
            let child = unsafe {
                ScreenToClient(cur, &mut p);
                ChildWindowFromPointEx(cur, p, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED)
            };
            if child.is_null() || child == cur {
                break;
            }
            cur = child;
        }
        (cur != top).then_some(cur)
    }

    /// The window `top`'s thread has focused, when it is `top` or one of its children.
    fn thread_focus(top: HWND) -> Option<HWND> {
        // SAFETY: GUITHREADINFO is plain data with its size set; the calls only read.
        unsafe {
            let tid = GetWindowThreadProcessId(top, std::ptr::null_mut());
            let mut gi: GUITHREADINFO = std::mem::zeroed();
            gi.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
            if tid == 0 || GetGUIThreadInfo(tid, &mut gi) == 0 || gi.hwndFocus.is_null() {
                return None;
            }
            (GetAncestor(gi.hwndFocus, GA_ROOT) == top).then_some(gi.hwndFocus)
        }
    }

    /// Where keys for `top` go: the control under `at`, else the thread's focus inside `top`, else `top`. Always
    /// `top` or a window under it, never another top-level window.
    pub fn target(top: HWND, at: Option<(i32, i32)>) -> (HWND, Target) {
        if let Some(c) = at.and_then(|p| control_at(top, p)) {
            return (c, Target::Control);
        }
        match thread_focus(top) {
            Some(f) if f != top => (f, Target::Focus),
            _ => (top, Target::Window),
        }
    }

    /// Posts the strokes to `to`. Err with how many messages went before one failed.
    pub fn post(to: HWND, strokes: &[Stroke]) -> Result<usize, usize> {
        // SAFETY: MapVirtualKeyW reads a table; PostMessageW queues to a window handle and copies its arguments.
        let scan = |vk: u16| unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) };
        for (i, (m, w, l)) in messages(strokes, &scan).into_iter().enumerate() {
            if unsafe { PostMessageW(to, m, w, l) } == 0 {
                return Err(i);
            }
        }
        Ok(strokes.len())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetDlgItem, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
            SendMessageW, WM_CLOSE,
        };

        fn testapp() -> std::path::PathBuf {
            // bs-testapp.exe sits in target/<profile>, an ancestor of this test's exe (deps/ or build/<pkg>/<hash>/).
            let exe = std::env::current_exe().unwrap();
            exe.ancestors().map(|a| a.join("bs-testapp.exe")).find(|p| p.is_file()).unwrap_or_else(|| exe.with_file_name("bs-testapp.exe"))
        }

        fn window_of(pid: u32) -> Option<HWND> {
            struct Find(u32, HWND);
            unsafe extern "system" fn each(h: HWND, lp: isize) -> i32 {
                let f = &mut *(lp as *mut Find);
                let mut p = 0;
                GetWindowThreadProcessId(h, &mut p);
                if p == f.0 && !GetDlgItem(h, 1).is_null() {
                    f.1 = h;
                    return 0;
                }
                1
            }
            let mut f = Find(pid, std::ptr::null_mut());
            unsafe { EnumWindows(Some(each), &mut f as *mut Find as isize) };
            (!f.1.is_null()).then_some(f.1)
        }

        fn text(h: HWND) -> String {
            unsafe {
                let mut buf = vec![0u16; GetWindowTextLengthW(h) as usize + 1];
                let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
                String::from_utf16_lossy(&buf[..n.max(0) as usize])
            }
        }

        /// Keys posted to the test app's text box land in it, with no window brought forward: Return makes a new
        /// line through the app's own TranslateMessage, Backspace takes a character off, and characters arrive as
        /// typed whatever the layout. The control is found from a point inside it, as a ref's bounds give it.
        #[test]
        fn posted_keys_reach_the_control_under_the_ref() {
            let path = testapp();
            assert!(
                path.is_file(),
                "build bs-testapp first (cargo build -p baneyspaces-testapp): {}",
                path.display()
            );
            let mut child = std::process::Command::new(&path).spawn().unwrap();
            let mut top = None;
            for _ in 0..100 {
                top = window_of(child.id());
                if top.is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let top = top.expect("the test app's window");
            let edit = unsafe { GetDlgItem(top, 1) };
            let mut r: RECT = unsafe { std::mem::zeroed() };
            unsafe { GetWindowRect(edit, &mut r) };
            let at = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
            let (to, how) = target(top, Some(at));
            assert_eq!((to, how), (edit, Target::Control));
            let strokes = super::super::parse("h i x Backspace Return O K asterisk").unwrap();
            assert_eq!(post(to, &strokes), Ok(strokes.len()));
            let mut got = String::new();
            for _ in 0..40 {
                got = text(edit);
                if got == "hi\r\nOK*" {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let bare = target(top, None).1;
            unsafe { SendMessageW(top, WM_CLOSE, 0, 0) };
            let _ = child.wait();
            assert_eq!(got, "hi\r\nOK*");
            assert_ne!(bare, Target::Control, "with no point, never a guessed control");
        }
    }
}

#[cfg(windows)]
pub use win::{post, target};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_parse_the_macs_way() {
        assert_eq!(
            parse("h i Return").unwrap(),
            vec![
                Stroke::Char('h'),
                Stroke::Char('i'),
                Stroke::Key(0x0D, false)
            ]
        );
        assert_eq!(
            parse("Tab delete forwarddelete").unwrap(),
            vec![
                Stroke::Key(0x09, false),
                Stroke::Key(0x08, false),
                Stroke::Key(0x2E, true)
            ]
        );
        assert_eq!(
            parse("F5 f12 Left").unwrap(),
            vec![
                Stroke::Key(0x74, false),
                Stroke::Key(0x7B, false),
                Stroke::Key(0x25, true)
            ]
        );
        assert_eq!(
            parse("* asterisk space é +").unwrap(),
            vec![
                Stroke::Char('*'),
                Stroke::Char('*'),
                Stroke::Char(' '),
                Stroke::Char('é'),
                Stroke::Char('+')
            ]
        );
    }

    #[test]
    fn modifier_chords_and_junk_are_refused_before_anything_is_sent() {
        for chord in ["ctrl+c", "cmd+v", "Ctrl+X", "alt+f4", "shift+tab", "win+r"] {
            assert_eq!(
                parse(chord).unwrap_err().error.unwrap().code,
                "not_supported",
                "{chord}"
            );
        }
        for junk in ["", "   ", "hello", "f13", "a+b"] {
            assert_eq!(
                parse(junk).unwrap_err().error.unwrap().code,
                "invalid_args",
                "{junk:?}"
            );
        }
        assert!(parse(&vec!["a"; MAX_STROKES + 1].join(" ")).is_err());
    }

    #[test]
    fn a_key_is_down_then_up_and_a_character_is_one_char_message() {
        let m = messages(
            &[
                Stroke::Key(0x0D, false),
                Stroke::Char('a'),
                Stroke::Key(0x25, true),
                Stroke::Char('😀'),
            ],
            &|_| 0x1C,
        );
        assert_eq!(m[0], (WM_KEYDOWN, 0x0D, 0x001C_0001));
        assert_eq!(m[1], (WM_KEYUP, 0x0D, 0xC01C_0001u32 as i32 as isize));
        assert_eq!(m[2], (WM_CHAR, 'a' as usize, 1));
        assert_eq!(m[3].2, 0x011C_0001, "an arrow is an extended key");
        assert_eq!(
            m.len(),
            7,
            "a character outside the BMP is two UTF-16 units"
        );
    }

    #[test]
    fn bounds_are_read_from_the_engines_answer() {
        assert_eq!(
            center(&json!({"value": {"x": 10, "y": 20, "width": 100, "height": 40}})),
            Some((60, 40))
        );
        assert_eq!(
            center(&json!({"bounds": {"x": 0, "y": 0, "width": 0, "height": 0}})),
            None
        );
        assert_eq!(center(&json!({"value": "hello"})), None);
    }
}
