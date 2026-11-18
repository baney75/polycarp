//! The Windows chords from `spec/keys.json`, and the match the keyboard hook runs on every key.
//!
//! Explorer owns Win+1 to Win+9, so `RegisterHotKey` fails for them. The daemon instead sees every
//! key in a `WH_KEYBOARD_LL` hook and swallows only the chords listed here. The hook callback has to
//! be fast, so the match is a small pure function over a pre-built table.

use baneyspaces_core::keymap;
use std::sync::atomic::{AtomicU32, Ordering};

pub const VK_LWIN: u32 = 0x5B;
pub const VK_RWIN: u32 = 0x5C;
pub const VK_OEM_3: u32 = 0xC0; // the grave / backtick key

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Mods {
    pub win: bool,
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub mods: Mods,
    pub vk: u32,
    /// The `baneyspaces` arguments this chord runs, e.g. `["switch", "3"]`.
    pub args: Vec<String>,
}

/// A key name from spec/keymap.md as a virtual-key code: `0`-`9`, `a`-`z`, `f1`-`f24`, the arrows and named keys.
pub fn key_vk(name: &str) -> Option<u32> {
    let b = name.as_bytes();
    if b.len() == 1 && b[0].is_ascii_digit() {
        return Some(0x30 + u32::from(b[0] - b'0'));
    }
    if b.len() == 1 && b[0].is_ascii_lowercase() {
        return Some(0x41 + u32::from(b[0] - b'a'));
    }
    if let Some(n) = name.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
        return (1..=24).contains(&n).then_some(0x6F + n);
    }
    Some(match name {
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "grave" => VK_OEM_3,
        "escape" => 0x1B,
        "return" => 0x0D,
        "space" => 0x20,
        "tab" => 0x09,
        "backspace" => 0x08,
        "insert" => 0x2D,
        "delete" => 0x2E,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "minus" => 0xBD,
        "equal" => 0xBB,
        "comma" => 0xBC,
        "period" => 0xBE,
        "slash" => 0xBF,
        "semicolon" => 0xBA,
        "quote" => 0xDE,
        "bracketleft" => 0xDB,
        "bracketright" => 0xDD,
        "backslash" => 0xDC,
        _ => return None,
    })
}

/// `keys.mod`: the modifier `mod` stands for (`win`, `ctrl` or `alt`).
pub fn parse_mod(name: &str) -> Option<Mods> {
    match name {
        "win" => Some(Mods { win: true, ..Mods::default() }),
        "ctrl" => Some(Mods { ctrl: true, ..Mods::default() }),
        "alt" => Some(Mods { alt: true, ..Mods::default() }),
        _ => None,
    }
}

/// A chord such as `"mod+shift+left"` or `"win+grave"`: modifiers, then one key, `mod` standing for `m`. Every chord
/// holds Win, Ctrl or Alt: the hook never takes a bare key or Shift+key from what you type.
pub fn parse_chord(chord: &str, m: Mods) -> Result<(Mods, u32), String> {
    let mut mods = Mods::default();
    let mut vk = None;
    for part in chord.split('+').map(str::trim) {
        let add = match part {
            "mod" => m,
            "win" | "super" => Mods { win: true, ..Mods::default() },
            "ctrl" => Mods { ctrl: true, ..Mods::default() },
            "alt" => Mods { alt: true, ..Mods::default() },
            "shift" => Mods { shift: true, ..Mods::default() },
            k if vk.is_none() => {
                vk = Some(key_vk(k).ok_or_else(|| format!("{k:?} is not a key name (spec/keymap.md lists them)"))?);
                continue;
            }
            k => return Err(format!("{k:?} after the key: a chord is modifiers, then one key")),
        };
        if vk.is_some() {
            return Err("the key goes last".into());
        }
        if (add.win && mods.win) || (add.shift && mods.shift) || (add.alt && mods.alt) || (add.ctrl && mods.ctrl) {
            return Err(format!("{part:?} names a modifier twice (mod is {})", mod_name(m)));
        }
        mods = Mods { win: mods.win || add.win, shift: mods.shift || add.shift, alt: mods.alt || add.alt, ctrl: mods.ctrl || add.ctrl };
    }
    let vk = vk.ok_or("no key, only modifiers")?;
    if !(mods.win || mods.ctrl || mods.alt) {
        return Err("needs win, ctrl or alt (or mod): a bare key or shift+key is yours to type".into());
    }
    if mods.win && mods.shift && !mods.ctrl && !mods.alt && vk == 0x1B {
        return Err("win+shift+escape is the recovery chord (spec/config.md); config can't rebind it".into());
    }
    Ok((mods, vk))
}

/// The name `parse_mod` takes for `m`.
fn mod_name(m: Mods) -> &'static str {
    if m.ctrl {
        "ctrl"
    } else if m.alt {
        "alt"
    } else {
        "win"
    }
}

/// A default chord from `spec/keys.json` with `mod` standing for `m`. The column is written for `mod = win`; when mod
/// is ctrl or alt, that modifier and win trade places, so `mod+alt+left` with mod = alt is Win+Alt+Left. Each default
/// keeps its own chord and the window keys keep two of Win, Ctrl and Alt, never an app's own Alt+arrow.
fn default_chord(template: &str, m: Mods) -> Result<(Mods, u32), String> {
    let name = mod_name(m);
    let swapped: Vec<&str> = template.split('+').map(|p| if p.trim() == name { "win" } else { p }).collect();
    parse_chord(&swapped.join("+"), m)
}

const DIRS: [(&str, &str, &str); 4] = [("left", "-40", "0"), ("right", "40", "0"), ("up", "0", "-40"), ("down", "0", "40")];

/// The default keys, from the Windows column of `spec/keys.json`, with `mod` standing for `m`: switch 1-9, move 1-9,
/// move-and-stay 1-9 (none by default), the agent workspace toggle, focus and swap by direction, resize (left and up
/// shrink, right and down grow, 40 px) and send to the next display. Overview has no key in part 1.
pub fn defaults(m: Mods) -> Vec<Binding> {
    let k = keymap::keys();
    let w = &k["platforms"]["windows"];
    let mut out = vec![];
    let mut add = |action: &str, fill: (&str, &str), args: Vec<&str>| {
        let t = w[action].as_str().unwrap_or("");
        if let (false, Ok((mods, vk))) = (t.is_empty(), default_chord(&t.replace(fill.0, fill.1), m)) {
            out.push(Binding { mods, vk, args: args.into_iter().map(String::from).collect() });
        }
    };
    for n in 1..=9u8 {
        let d = n.to_string();
        add("switch", ("{n}", &d), vec!["switch", &d]);
        add("move", ("{n}", &d), vec!["move", &d]);
        add("move_stay", ("{n}", &d), vec!["move", &d, "--stay"]);
    }
    add("agent_toggle", ("", ""), vec!["agent-workspace", "toggle"]);
    for (dir, dx, dy) in DIRS {
        add("focus", ("{dir}", dir), vec!["window", "focus", dir]);
        add("swap", ("{dir}", dir), vec!["window", "swap", dir]);
        add("resize", ("{dir}", dir), vec!["window", "resize", dx, dy]);
    }
    add("display", ("", ""), vec!["window", "display", "next"]);
    out
}

/// The keys `config.toml` asks for: `[keys] mod` and `[keys.bindings]` over the defaults (spec/keymap.md). `check`
/// says whether an action is a command the CLI takes. Err is the exact path and reason; then nothing changes.
/// Also returns what was read but is not on Windows yet (`[keys.modes]`), to be logged.
pub fn from_config(text: &str, check: impl Fn(&[String]) -> Result<(), String>) -> Result<(Vec<Binding>, Vec<String>), String> {
    let doc: toml::Table = text.parse().map_err(|e: toml::de::Error| format!("config.toml: {}", e.message()))?;
    let empty = toml::Table::new();
    let keys = match doc.get("keys") {
        None => &empty,
        Some(toml::Value::Table(t)) => t,
        Some(_) => return Err("keys: must be a table".into()),
    };
    let mut skipped = vec![];
    for k in keys.keys().filter(|k| !matches!(k.as_str(), "mod" | "bindings")) {
        skipped.push(format!("keys.{k}: not on Windows yet, ignored"));
    }
    let m = match keys.get("mod") {
        None => parse_mod("win").unwrap_or_default(),
        Some(toml::Value::String(s)) => parse_mod(s).ok_or_else(|| format!("keys.mod: {s:?} is not win, ctrl or alt"))?,
        Some(_) => return Err("keys.mod: must be a string".into()),
    };
    let mut table = defaults(m);
    let mut seen: Vec<(Mods, u32, &String)> = vec![];
    let binds = match keys.get("bindings") {
        None => &empty,
        Some(toml::Value::Table(t)) => t,
        Some(_) => return Err("keys.bindings: must be a table".into()),
    };
    for (chord, action) in binds {
        let at = format!("keys.bindings.{chord:?}");
        let (mods, vk) = parse_chord(chord, m).map_err(|e| format!("{at}: {e}"))?;
        if let Some((_, _, other)) = seen.iter().find(|(m2, v2, _)| *m2 == mods && *v2 == vk) {
            return Err(format!("{at}: the same chord as keys.bindings.{other:?}"));
        }
        seen.push((mods, vk, chord));
        let action = action.as_str().ok_or_else(|| format!("{at}: the action must be a string"))?.trim();
        table.retain(|b| !(b.mods == mods && b.vk == vk));
        if action == "none" {
            continue;
        }
        if action.starts_with("exec ") || action.starts_with("mode ") {
            return Err(format!("{at}: {:?} is not on Windows yet", action.split(' ').next().unwrap_or("")));
        }
        let args: Vec<String> = action.split_whitespace().map(String::from).collect();
        check(&args).map_err(|e| format!("{at}: {action:?}: {e}"))?;
        table.push(Binding { mods, vk, args });
    }
    if !table.iter().any(|b| b.args.first().map(String::as_str) == Some("switch")) {
        return Err("keys.bindings: no key is left to switch workspaces".into());
    }
    Ok((table, skipped))
}

/// After a change in the config folder, waits until it has been quiet for `quiet_ms` (an editor saves in steps:
/// truncate, write, rename), at most about `cap_ms`. `rearm_wait(ms)` re-arms the watch, then waits up to `ms` and
/// says whether another change came. The watch is re-armed before every wait, so a step that lands after the read is
/// seen by the next round, never lost. Returns how many waits saw a change.
pub fn settle(quiet_ms: u32, cap_ms: u32, mut rearm_wait: impl FnMut(u32) -> bool) -> u32 {
    let mut changes = 0;
    while rearm_wait(quiet_ms) {
        changes += 1;
        if changes * quiet_ms >= cap_ms {
            break;
        }
    }
    changes
}

/// `config.toml` as text for `from_config`. No file is the defaults (an empty text). A file that is there but can't be
/// read (held open by an editor, not UTF-8) is an error, never the defaults: the keys in force stay.
pub fn read_config(path: &std::path::Path) -> Result<String, String> {
    match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("config.toml: cannot read: {e}")),
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => Ok(text.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(text)),
            Err(_) => Err("config.toml: cannot read: not UTF-8 (save it as UTF-8; Windows PowerShell's > and Out-File write UTF-16)".into()),
        },
    }
}

/// For `window focus` and `window swap`: the nearest of `others` (id, frame as left, top, right, bottom) in direction
/// `dir` from the middle of `from`. Only windows whose middle lies that way count; distance along `dir` plus twice the
/// distance across it, so a window straight across wins over a nearer one far off to the side.
pub fn neighbor<'a>(from: [i32; 4], dir: &str, others: &'a [(String, [i32; 4])]) -> Option<&'a (String, [i32; 4])> {
    let mid = |r: [i32; 4]| (i64::from(r[0] + r[2]) / 2, i64::from(r[1] + r[3]) / 2);
    let (x, y) = mid(from);
    let cost = |r: [i32; 4]| {
        let (ox, oy) = mid(r);
        let (along, across) = match dir {
            "left" => (x - ox, oy - y),
            "right" => (ox - x, oy - y),
            "up" => (y - oy, ox - x),
            "down" => (oy - y, ox - x),
            _ => return None,
        };
        (along > 0).then_some(along + 2 * across.abs())
    };
    others.iter().filter_map(|o| cost(o.1).map(|c| (c, o))).min_by_key(|(c, _)| *c).map(|(_, o)| o)
}

/// The binding for this key with exactly these modifiers held, if any.
pub fn lookup(table: &[Binding], vk: u32, mods: Mods) -> Option<&Binding> {
    table.iter().find(|b| b.vk == vk && b.mods == mods)
}

/// The virtual keys of the modifiers the chords use, grouped.
pub const WIN_KEYS: &[u32] = &[VK_LWIN, VK_RWIN];
pub const SHIFT_KEYS: &[u32] = &[0xA0, 0xA1, 0x10];
pub const ALT_KEYS: &[u32] = &[0xA4, 0xA5, 0x12];
pub const CTRL_KEYS: &[u32] = &[0xA2, 0xA3, 0x11];
pub const MOD_KEYS: [u32; 11] = [0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x10, 0x11, 0x12];

/// A key-down this recent is believed even when `GetAsyncKeyState` has not caught up yet (a chord sent
/// by a VM or a remote session puts two keys in the same millisecond).
pub const RECENT_MS: u32 = 40;

/// Which modifier keys the hook believes are down, and since when (the event's tick, 0 = up).
///
/// The hook only sees key events on the user's desktop. A key-up that happens elsewhere (Win+L and the
/// secure desktop, Ctrl+Alt+Del, a UAC prompt, a key released while an elevated window has focus)
/// never arrives, and a counter that trusted itself would call that modifier down forever. So the count
/// is only a hint: on every candidate chord each modifier it believes down is confirmed against the
/// real key state, or by a key-down so recent the real state may not show it yet. One that fails is
/// cleared. All atomics: the hook callback takes no lock.
pub struct ModState {
    down_at: [AtomicU32; 256],
}

impl Default for ModState {
    fn default() -> Self {
        Self::new()
    }
}

impl ModState {
    pub const fn new() -> Self {
        #[allow(clippy::declare_interior_mutable_const)]
        const Z: AtomicU32 = AtomicU32::new(0);
        Self { down_at: [Z; 256] }
    }

    /// A modifier key event. `tick` is the event's time in milliseconds.
    pub fn event(&self, vk: u32, down: bool, tick: u32) {
        if MOD_KEYS.contains(&vk) {
            // 0 means up, so a down at tick 0 is stored as 1.
            self.down_at[vk as usize].store(if down { tick.max(1) } else { 0 }, Ordering::Relaxed);
        }
    }

    /// Believe `vk` is down from `tick` (the hook just started and the key already was).
    pub fn assume_down(&self, vk: u32, tick: u32) {
        self.event(vk, true, tick);
    }

    /// Forget everything: the session locked or unlocked, or the input desktop changed.
    pub fn reset(&self) {
        for k in MOD_KEYS {
            self.down_at[k as usize].store(0, Ordering::Relaxed);
        }
    }

    fn group_held(&self, keys: &[u32], now: u32, real: &impl Fn(u32) -> bool) -> bool {
        let mut held = false;
        for k in keys {
            let at = self.down_at[*k as usize].load(Ordering::Relaxed);
            if at == 0 {
                continue;
            }
            if real(*k) || now.wrapping_sub(at) < RECENT_MS {
                held = true;
            } else {
                // Believed down, not down: its key-up was missed.
                self.down_at[*k as usize].store(0, Ordering::Relaxed);
            }
        }
        held
    }

    /// The modifiers really held at `now`. `real(vk)` is the system's own answer for a key.
    pub fn mods(&self, now: u32, real: impl Fn(u32) -> bool) -> Mods {
        Mods {
            win: self.group_held(WIN_KEYS, now, &real),
            shift: self.group_held(SHIFT_KEYS, now, &real),
            alt: self.group_held(ALT_KEYS, now, &real),
            ctrl: self.group_held(CTRL_KEYS, now, &real),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIN: Mods = Mods { win: true, shift: false, alt: false, ctrl: false };
    const WIN_SHIFT: Mods = Mods { win: true, shift: true, alt: false, ctrl: false };

    fn bindings() -> Vec<Binding> {
        defaults(WIN)
    }

    fn args(t: &[Binding], vk: u32, m: Mods) -> Option<Vec<String>> {
        lookup(t, vk, m).map(|b| b.args.clone())
    }

    fn any_command(_: &[String]) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn windows_has_switch_move_and_the_agent_toggle() {
        let t = bindings();
        assert_eq!(t.len(), 9 + 9 + 1 + 4 + 4 + 4 + 1, "move_stay has no default key on Windows");
        assert_eq!(lookup(&t, 0x32, WIN).unwrap().args, ["switch", "2"]);
        assert_eq!(lookup(&t, 0x39, WIN_SHIFT).unwrap().args, ["move", "9"]);
        assert_eq!(lookup(&t, VK_OEM_3, WIN).unwrap().args, ["agent-workspace", "toggle"]);
        let alt = Mods { alt: true, ..WIN };
        assert_eq!(args(&t, 0x25, alt).unwrap(), ["window", "focus", "left"]);
        assert_eq!(args(&t, 0x27, Mods { shift: true, ..alt }).unwrap(), ["window", "swap", "right"]);
        assert_eq!(args(&t, 0x28, Mods { ctrl: true, ..alt }).unwrap(), ["window", "resize", "0", "40"]);
        assert_eq!(args(&t, 0xBE, alt).unwrap(), ["window", "display", "next"]);
    }

    #[test]
    fn only_exact_chords_match() {
        let t = bindings();
        assert!(lookup(&t, 0x31, Mods::default()).is_none(), "a bare 1 is the app's");
        assert!(lookup(&t, 0x31, Mods { ctrl: true, ..WIN }).is_none(), "Win+Ctrl+1 is not ours");
        assert!(lookup(&t, 0x30, WIN).is_none(), "workspace 0 does not exist");
        assert!(lookup(&t, 0x41, WIN).is_none(), "Win+A is the shell's");
    }

    #[test]
    fn chords_are_unique() {
        let t = bindings();
        for (i, a) in t.iter().enumerate() {
            for b in &t[i + 1..] {
                assert!(!(a.vk == b.vk && a.mods == b.mods), "{:?} twice", a.args);
            }
        }
    }

    #[test]
    fn a_chord_the_file_binds_twice_is_an_error() {
        let e = from_config("[keys.bindings]\n\"win+1\" = \"switch 3\"\n\"mod+1\" = \"switch 5\"\n", any_command).unwrap_err();
        assert!(e.contains("the same chord as"), "{e}");
    }

    #[test]
    fn the_watch_waits_for_quiet_and_is_re_armed_before_every_wait() {
        let mut waits = vec![true, true, false].into_iter();
        assert_eq!(settle(30, 500, |ms| { assert_eq!(ms, 30); waits.next().unwrap() }), 2, "two more steps, then 30 ms of quiet");
        let mut calls = 0;
        assert_eq!(settle(30, 500, |_| { calls += 1; true }), 17, "a folder that never goes quiet is read after about 500 ms");
        assert_eq!(calls, 17);
        let src = &include_str!("daemon.rs").replace("\r\n", "\n");
        let body = &src[src.find("fn watch_config(").expect("watch_config")..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(!body.contains("thread::sleep"), "a fixed sleep from the first change misses a save that comes later");
        let s = body.find("keys::settle(").expect("watch_config settles");
        let (re, wait) = (body[s..].find("FindNextChangeNotification").expect("re-arms"), body[s..].find("WaitForSingleObject").expect("waits"));
        assert!(re < wait, "re-armed before it waits, so no change is lost");
    }

    #[test]
    fn a_swap_mirrors_the_moves_like_a_display_send() {
        // SetWindowPos raises no EVENT_SYSTEM_MOVESIZEEND, so a swap across displays must update the model itself.
        let src = &include_str!("daemon.rs").replace("\r\n", "\n");
        let at = src.find("winapi::set_frame(oh, r);").expect("the swap");
        let rest = &src[at..];
        assert!(rest[..rest.find("Envelope::ok").unwrap()].contains("self.mirror_moves();"), "the swap branch mirrors moves");
    }

    #[test]
    fn an_action_keeps_a_quoted_app_name_whole() {
        let (t, _) = from_config("[keys.bindings]\n\"mod+alt+k\" = 'move 2 --app \"Windows Terminal\"'\n", any_command).unwrap();
        assert_eq!(args(&t, 0x4B, Mods { win: true, alt: true, ..Mods::default() }).unwrap(), ["move", "2", "--app", "Windows Terminal"]);
        let e = from_config("[keys.bindings]\n\"mod+alt+k\" = 'move 2 --app \"Windows'\n", any_command).unwrap_err();
        assert!(e.contains("quote"), "an open quote is an error: {e}");
    }

    const EVERY_MOD: [&str; 3] = ["win", "ctrl", "alt"];

    #[test]
    fn the_defaults_never_collide_for_any_mod() {
        for name in EVERY_MOD {
            let t = defaults(parse_mod(name).unwrap());
            assert_eq!(t.len(), 9 + 9 + 1 + 4 + 4 + 4 + 1, "mod = {name}: every default is kept");
            for (i, a) in t.iter().enumerate() {
                for b in &t[i + 1..] {
                    assert!(!(a.vk == b.vk && a.mods == b.mods), "mod = {name}: {:?} and {:?} are one chord", a.args, b.args);
                }
            }
        }
    }

    #[test]
    fn no_window_default_is_an_apps_own_alt_or_ctrl_key() {
        // Alt+arrow is Back, Forward and Up in every browser and in Explorer, and Ctrl+arrow moves by word: the window
        // keys hold two of Win, Ctrl and Alt whatever mod is.
        for name in EVERY_MOD {
            for b in defaults(parse_mod(name).unwrap()).iter().filter(|b| b.args[0] == "window") {
                let held = [b.mods.win, b.mods.ctrl, b.mods.alt].iter().filter(|h| **h).count();
                assert!(held >= 2, "mod = {name}: {:?} is {:?} on vk {:#x}", b.args, b.mods, b.vk);
            }
        }
    }

    #[test]
    fn a_modifier_named_twice_is_refused() {
        let alt = parse_mod("alt").unwrap();
        assert!(parse_chord("mod+alt+j", alt).unwrap_err().contains("twice"), "with mod = alt, mod+alt is alt twice");
        assert!(parse_chord("win+win+j", WIN).unwrap_err().contains("twice"));
        assert_eq!(parse_chord("mod+alt+j", WIN), Ok((Mods { alt: true, ..WIN }, 0x4A)));
    }

    #[test]
    fn only_a_missing_config_reads_as_the_defaults() {
        let dir = std::env::temp_dir().join(format!("baneyspaces-config-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_config(&dir.join("absent.toml")), Ok(String::new()), "no file: the defaults");
        let good = dir.join("good.toml");
        std::fs::write(&good, "[keys]\nmod = \"alt\"\n").unwrap();
        assert_eq!(read_config(&good).unwrap(), "[keys]\nmod = \"alt\"\n");
        // What Windows PowerShell's > and Out-File write: UTF-16LE with a byte order mark.
        let utf16 = dir.join("utf16.toml");
        let bytes: Vec<u8> = [0xFEFFu16].into_iter().chain("[keys]\nmod = \"alt\"\n".encode_utf16()).flat_map(u16::to_le_bytes).collect();
        std::fs::write(&utf16, bytes).unwrap();
        let e = read_config(&utf16).unwrap_err();
        assert!(e.starts_with("config.toml: cannot read") && e.contains("UTF-8"), "{e}");
        // A file that is there and can't be read (a folder stands in for one an editor holds open).
        let held = dir.join("held.toml");
        std::fs::create_dir_all(&held).unwrap();
        assert!(read_config(&held).unwrap_err().starts_with("config.toml: cannot read"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_spec_column_is_what_the_daemon_reads() {
        assert_eq!(parse_chord("win+shift+4", WIN), Ok((WIN_SHIFT, 0x34)));
        assert_eq!(parse_chord("mod+shift+4", WIN), Ok((WIN_SHIFT, 0x34)));
        assert_eq!(parse_chord("mod+f12", parse_mod("ctrl").unwrap()), Ok((Mods { ctrl: true, ..Mods::default() }, 0x7B)));
        assert!(parse_chord("win+nonsense", WIN).is_err());
        assert!(parse_chord("", WIN).is_err());
        assert!(parse_chord("win+{n}", WIN).is_err(), "a template is not a chord");
        assert!(parse_chord("shift+a", WIN).is_err(), "shift+a is typing");
        assert!(parse_chord("win+a+shift", WIN).is_err(), "the key goes last");
        assert!(parse_chord("mod+shift+escape", WIN).unwrap_err().contains("recovery chord"));
    }

    #[test]
    fn neighbor_is_the_nearest_window_that_way() {
        let w = |id: &str, l, t| (id.to_string(), [l, t, l + 100, t + 100]);
        let others = vec![w("left", 0, 200), w("far-left", -400, 200), w("up-left", 50, 0), w("right", 400, 210), w("below", 200, 500)];
        let from = [200, 200, 300, 300];
        let pick = |d: &str| neighbor(from, d, &others).map(|o| o.0.as_str());
        assert_eq!(pick("left"), Some("left"), "straight across beats the one far off and the one up and to the side");
        assert_eq!(pick("right"), Some("right"));
        assert_eq!(pick("down"), Some("below"));
        assert_eq!(pick("up"), Some("up-left"));
        assert_eq!(neighbor(from, "right", &others[..3]), None, "nothing that way");
        assert_eq!(neighbor(from, "sideways", &others), None);
    }

    #[test]
    fn config_rebinds_unbinds_and_changes_the_modifier() {
        let text = "[keys]\nmod = \"ctrl\"\n[keys.bindings]\n\"mod+alt+j\" = \"switch 2\"\n\"mod+1\" = \"switch 3\"\n\"mod+2\" = \"none\"\n[keys.modes.resize]\nh = \"window resize -40 0\"\n";
        let (t, skipped) = from_config(text, any_command).unwrap();
        let ctrl = Mods { ctrl: true, ..Mods::default() };
        assert_eq!(args(&t, 0x4A, Mods { alt: true, ..ctrl }).unwrap(), ["switch", "2"]);
        assert_eq!(args(&t, 0x31, ctrl).unwrap(), ["switch", "3"], "a binding replaces the default on its chord");
        assert!(lookup(&t, 0x32, ctrl).is_none(), "none unbinds");
        assert!(lookup(&t, 0x33, WIN).is_none(), "mod is ctrl now, not win");
        assert_eq!(args(&t, 0x33, ctrl).unwrap(), ["switch", "3"], "the other defaults follow mod");
        assert_eq!(skipped, ["keys.modes: not on Windows yet, ignored"]);
        assert_eq!(from_config("", any_command).unwrap().0, bindings(), "no file, no keys section: the defaults");
    }

    #[test]
    fn a_bad_config_names_the_path_and_the_reason() {
        let bad = |t: &str| from_config(t, |a: &[String]| if a[0] == "warp" { Err("unknown command".into()) } else { Ok(()) }).unwrap_err();
        assert_eq!(bad("[keys]\nmod = \"hyper\""), "keys.mod: \"hyper\" is not win, ctrl or alt");
        assert!(bad("[keys.bindings]\n\"mod+alt+j\" = \"warp 9\"").starts_with("keys.bindings.\"mod+alt+j\": \"warp 9\": unknown command"));
        assert!(bad("[keys.bindings]\n\"mod+hyper\" = \"switch 1\"").starts_with("keys.bindings.\"mod+hyper\": "));
        assert!(bad("[keys.bindings]\n\"mod+t\" = \"exec wt\"").contains("not on Windows yet"));
        assert!(bad("keys = [").starts_with("config.toml: "));
        let all_off: String = (1..=9).map(|n| format!("\"mod+{n}\" = \"none\"\n")).collect();
        assert_eq!(bad(&format!("[keys.bindings]\n{all_off}")), "keys.bindings: no key is left to switch workspaces");
    }

    #[test]
    fn a_missed_key_up_does_not_leave_win_stuck() {
        // Win goes down at t=1000 and its key-up never arrives (Win+L, then unlock). Much later a plain "2"
        // is typed, and the system says Win is up: it must not count as Win+2, and the stale state is cleared.
        let m = ModState::new();
        m.event(VK_LWIN, true, 1000);
        let mods = m.mods(900_000, |_| false);
        assert!(!mods.win);
        assert!(lookup(&bindings(), 0x32, mods).is_none());
        // And it stays cleared: a second look, with the system still saying up, agrees.
        assert!(!m.mods(900_050, |_| false).win);
    }

    #[test]
    fn a_held_win_key_is_believed_while_the_system_agrees() {
        let m = ModState::new();
        m.event(VK_LWIN, true, 1000);
        assert!(m.mods(60_000, |k| k == VK_LWIN).win, "held for a minute, system says down");
        let mods = m.mods(60_001, |k| k == VK_LWIN);
        assert_eq!(lookup(&bindings(), 0x32, mods).unwrap().args, ["switch", "2"]);
    }

    #[test]
    fn a_chord_in_the_same_millisecond_is_believed_before_the_system_catches_up() {
        let m = ModState::new();
        m.event(VK_LWIN, true, 5000);
        assert!(m.mods(5002, |_| false).win, "down 2 ms ago, system not updated yet");
        assert!(!m.mods(5000 + RECENT_MS + 1, |_| false).win, "but not forever");
    }

    #[test]
    fn a_stuck_shift_or_ctrl_is_cleared_too_and_a_real_key_up_clears_it() {
        let m = ModState::new();
        m.event(0xA0, true, 10);
        m.event(0xA2, true, 10);
        let mods = m.mods(100_000, |_| false);
        assert!(!mods.shift && !mods.ctrl);
        m.event(VK_RWIN, true, 100_000);
        m.event(VK_RWIN, false, 100_200);
        assert!(!m.mods(100_300, |_| true).win, "a delivered key-up wins over a real state read");
    }

    #[test]
    fn the_spec_says_the_agent_workspace_is_a_ghost_not_a_cloak() {
        // The hands engine skips cloaked windows, so the agent workspace is made transparent instead (README).
        let v: serde_json::Value = serde_json::from_str(baneyspaces_core::keymap::KEYS_JSON).unwrap();
        let s = v["platforms"]["windows"]["agent_workspace"].as_str().expect("windows agent_workspace");
        assert!(s.starts_with("a ghost"), "keys.json says {s:?}");
    }

    #[test]
    fn reset_forgets_everything() {
        let m = ModState::new();
        m.event(VK_LWIN, true, 1000);
        m.reset();
        assert_eq!(m.mods(1001, |_| true), Mods::default());
    }
}
