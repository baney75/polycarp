//! The top bar's rules, apart from drawing (`spec/bar.md`): which workspace numbers it shows, the clock's words, its
//! height, and the four colors it takes from a Polycarp theme. macOS has the same rules in `BarLayout` and `BarText`;
//! Windows draws from these.

use serde_json::Value;

/// The bar's height at 96 dpi (100%), in pixels. A display at another scale gets it scaled (`height_px`).
pub const HEIGHT: u32 = 26;

/// The bar's height on a display at `dpi`, rounded to the nearest pixel. 0 dpi (unknown) is taken as 96.
pub fn height_px(dpi: u32) -> i32 {
    scale(HEIGHT as i32, dpi)
}

/// `px` at 96 dpi, on a display at `dpi`, rounded to the nearest pixel.
pub fn scale(px: i32, dpi: u32) -> i32 {
    let dpi = if dpi == 0 { 96 } else { dpi as i64 };
    ((px as i64 * dpi + 48) / 96) as i32
}

/// The workspace numbers the bar shows: every workspace with windows, and the one you're on, in number order. 0 (no
/// workspace shown) and anything outside 1 to 9 is left out.
pub fn workspaces(occupied: &[u8], current: u8) -> Vec<u8> {
    let mut v: Vec<u8> = occupied.iter().copied().chain(std::iter::once(current)).filter(|n| (1..=9).contains(n)).collect();
    v.sort_unstable();
    v.dedup();
    v
}

const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// The clock's words: "Saturday 22:04", or "Saturday 10:04" on a 12-hour clock. No AM or PM, as on macOS (`BarText.clock`).
/// `weekday` counts from Sunday, 0, as Windows' `SYSTEMTIME.wDayOfWeek` does.
pub fn clock(weekday: u8, hour: u8, minute: u8, twenty_four: bool) -> String {
    let day = DAYS[(weekday % 7) as usize];
    let h = match (twenty_four, hour % 12) {
        (true, _) => hour,
        (false, 0) => 12,
        (false, h) => h,
    };
    format!("{day} {h}:{minute:02}")
}

/// Whether a time pattern (Windows' `LOCALE_STIMEFORMAT`, as "HH:mm:ss" or "h:mm:ss tt") is a 24-hour clock: it
/// has an `H`. Text in quotes is not a field. An empty or unreadable pattern counts as 24 hours.
pub fn clock_is_24h(pattern: &str) -> bool {
    let mut quoted = false;
    let mut hours = None;
    for c in pattern.chars() {
        match c {
            '\'' => quoted = !quoted,
            'H' if !quoted => return true,
            'h' if !quoted => hours = Some(false),
            _ => {}
        }
    }
    hours.unwrap_or(true)
}

/// Where each number's cell goes: the bar's left padding, then each cell `pad` wider than its text on both sides.
/// Returns `(n, x, width)` per number.
pub fn cells(numbers: &[u8], widths: &[i32], left: i32, pad: i32) -> Vec<(u8, i32, i32)> {
    let mut x = left;
    numbers
        .iter()
        .zip(widths)
        .map(|(n, w)| {
            let at = x;
            x += w + 2 * pad;
            (*n, at, w + 2 * pad)
        })
        .collect()
}

/// The number whose cell holds `x`, if any.
pub fn hit(cells: &[(u8, i32, i32)], x: i32) -> Option<u8> {
    cells.iter().find(|(_, cx, w)| x >= *cx && x < cx + w).map(|(n, _, _)| *n)
}

/// A rectangle in screen pixels: left, top, right, bottom.
pub type Rect = [i32; 4];

/// A top-level window as the full-screen rule sees it: its visible frame, and whether it is always on top
/// (`WS_EX_TOPMOST`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Front {
    pub frame: Rect,
    pub topmost: bool,
}

/// Whether a full-screen app is up on the display whose whole rect (`rcMonitor`) is `display`: the frontmost of
/// `windows` that reaches onto it covers all of it. `windows` are the top-level windows that could be one, front to
/// back; the caller leaves out the bars, the shell's own windows and any hidden, minimized, cloaked, click-through or
/// tool window. A window only touching the display's edge does not reach onto it. An always-on-top window that does
/// not cover the display (a picture-in-picture video, a meeting's mini window, a pinned note) is passed over: it floats
/// in front of a full-screen video without ending it. Any other window in front of the video does end it.
pub fn full_screen_on(display: Rect, windows: &[Front]) -> bool {
    let reaches = |w: &Rect| w[0].max(display[0]) < w[2].min(display[2]) && w[1].max(display[1]) < w[3].min(display[3]);
    let covers = |w: &Rect| w[0] <= display[0] && w[1] <= display[1] && w[2] >= display[2] && w[3] >= display[3];
    windows.iter().filter(|w| reaches(&w.frame)).find(|w| !w.topmost || covers(&w.frame)).is_some_and(|w| covers(&w.frame))
}

/// What a full-screen notice (Windows' `ABN_FULLSCREENAPP`) changes, given each bar's display rect and whether it is
/// hidden now: (bar, hide) for every bar whose display has a full-screen app and is shown, or has none and is hidden.
/// The notice says only that something changed, not which display, so every bar is decided again from the windows
/// (`full_screen_on`) and the notice's own words are not used.
pub fn full_screen_bars(bars: &[(Rect, bool)], windows: &[Front]) -> Vec<(usize, bool)> {
    bars.iter().enumerate().filter_map(|(i, &(display, hidden))| {
        let up = full_screen_on(display, windows);
        (up != hidden).then_some((i, up))
    }).collect()
}

/// An `#rrggbb` color.
pub type Rgb = [u8; 3];

/// The four colors the bar draws with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Colors {
    pub background: Rgb,
    pub foreground: Rgb,
    pub muted: Rgb,
    pub accent: Rgb,
}

impl Colors {
    /// The built-in dark look, used when no valid Polycarp theme is in force: the macOS `auto` palette's near-black
    /// (white 0.07) and white, a gray for the numbers you're not on, and the system's accent when there is one.
    pub fn builtin(accent: Option<Rgb>) -> Self {
        Colors { background: [0x12, 0x12, 0x12], foreground: [0xff, 0xff, 0xff], muted: [0x9a, 0x9a, 0x9a], accent: accent.unwrap_or([0x7a, 0xa2, 0xf7]) }
    }
}

/// `#rrggbb`, and nothing else.
pub fn hex(s: &str) -> Option<Rgb> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

fn luminance(c: Rgb) -> f64 {
    let ch = |v: u8| {
        let s = v as f64 / 255.0;
        if s <= 0.03928 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])
}

/// The WCAG contrast ratio of two colors, 1 to 21.
pub fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// The largest theme file read, as on macOS (`spec/themes.md`).
pub const THEME_MAX_BYTES: u64 = 256 * 1024;

/// The bar's colors from a Polycarp theme (`<config>/current/theme.json`): `surfaces.spaces` in the theme's `mode`,
/// where `auto` follows the system (`system_dark`). The theme's name comes back with them. An error says why the file
/// is not a theme the bar draws: a newer schema, a color that isn't `#rrggbb`, or text the bar draws (foreground and
/// muted on background) under 4.5:1.
pub fn theme_colors(text: &str, system_dark: bool) -> Result<(Colors, String), String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    match v.get("schema").and_then(Value::as_u64) {
        Some(1) => {}
        Some(n) if n > 1 => return Err(format!("schema {n} is newer than this build reads (1): update BaneySpaces")),
        _ => return Err("no schema 1".into()),
    }
    let dark = match v.get("mode").and_then(Value::as_str) {
        Some("dark") => true,
        Some("light") => false,
        Some("auto") | None => system_dark,
        Some(m) => return Err(format!("mode {m:?} is not auto, light or dark")),
    };
    let side = if dark { "dark" } else { "light" };
    let roles = v.get("surfaces").and_then(|s| s.get("spaces")).and_then(|s| s.get(side)).ok_or_else(|| format!("no surfaces.spaces.{side}"))?;
    let role = |name: &str| -> Result<Rgb, String> {
        let s = roles.get(name).and_then(Value::as_str).ok_or_else(|| format!("surfaces.spaces.{side}.{name} is missing"))?;
        hex(s).ok_or_else(|| format!("surfaces.spaces.{side}.{name} is {s:?}, not #rrggbb"))
    };
    let c = Colors { background: role("background")?, foreground: role("foreground")?, muted: role("muted")?, accent: role("accent")? };
    for (name, fg) in [("foreground", c.foreground), ("muted", c.muted)] {
        let r = contrast(fg, c.background);
        if r < 4.5 {
            return Err(format!("{name} on background is {r:.2}:1 in {side} mode, under 4.5:1"));
        }
    }
    let name = v.get("name").and_then(Value::as_str).unwrap_or("unnamed").to_string();
    Ok((c, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: Rect = [0, 0, 1920, 1080];
    const TWO: Rect = [1920, 0, 3840, 1080];

    fn win(frame: Rect) -> Front {
        Front { frame, topmost: false }
    }

    fn on_top(frame: Rect) -> Front {
        Front { frame, topmost: true }
    }

    /// Each bar's hidden state after a full-screen notice, for the windows as they now are.
    fn notice(hidden: &mut [bool], windows: &[Front]) {
        let bars: Vec<(Rect, bool)> = [ONE, TWO].into_iter().zip(hidden.iter().copied()).collect();
        for (i, hide) in full_screen_bars(&bars, windows) {
            hidden[i] = hide;
        }
    }

    #[test]
    fn a_full_screen_app_hides_only_its_own_displays_bar() {
        let editor = win([100, 100, 800, 600]);
        let mut hidden = [false, false];
        notice(&mut hidden, &[win(ONE), editor]);
        assert_eq!(hidden, [true, false], "a video goes full screen on display 1");
        notice(&mut hidden, &[win(TWO), win(ONE), editor]);
        assert_eq!(hidden, [true, true], "and another on display 2");
        notice(&mut hidden, &[win(TWO), editor]);
        assert_eq!(hidden, [false, true], "display 1's quits; display 2's bar stays hidden over its video");
        notice(&mut hidden, &[editor]);
        assert_eq!(hidden, [false, false], "display 2's quits too");
    }

    #[test]
    fn a_second_notice_for_the_same_windows_changes_nothing() {
        let windows = [win(TWO), win([100, 100, 800, 600])];
        let bars = [(ONE, false), (TWO, false)];
        let change = full_screen_bars(&bars, &windows);
        assert_eq!(change, vec![(1, true)]);
        let bars = [(ONE, false), (TWO, true)];
        assert_eq!(full_screen_bars(&bars, &windows), vec![], "the bars already match the windows");
    }

    #[test]
    fn only_the_frontmost_window_on_a_display_counts() {
        let editor = win([100, 100, 800, 600]);
        // A window brought in front of the video, even partly, puts the bar back.
        assert!(!full_screen_on(ONE, &[editor, win(ONE)]));
        // A window on the next display, even one touching this display's edge, is not on this one.
        assert!(full_screen_on(ONE, &[win(TWO), win(ONE)]));
        assert!(full_screen_on(ONE, &[win([1920, 0, 2600, 700]), win(ONE)]));
        // A maximized window stops below the bar: not full screen.
        assert!(!full_screen_on(ONE, &[win([0, 26, 1920, 1040])]));
        // One window across both displays covers both.
        assert!(full_screen_on(ONE, &[win([0, 0, 3840, 1080])]) && full_screen_on(TWO, &[win([0, 0, 3840, 1080])]));
        assert!(!full_screen_on(ONE, &[]));
        assert_eq!(full_screen_bars(&[(ONE, false), (TWO, false)], &[editor]), vec![], "nothing to change");
    }

    #[test]
    fn a_small_always_on_top_window_over_a_full_screen_video_leaves_the_bar_hidden() {
        let pip = [1500, 760, 1900, 1060];
        assert!(full_screen_on(ONE, &[on_top(pip), win(ONE)]), "picture in picture floats over the video");
        assert!(full_screen_on(ONE, &[on_top(pip), on_top([20, 20, 300, 200]), win(ONE)]), "so do two");
        // The same small window, not on top, is a window you brought in front: the bar comes back.
        assert!(!full_screen_on(ONE, &[win(pip), win(ONE)]));
        // On top over an editor is still not full screen, and a full-screen window that is on top is one.
        assert!(!full_screen_on(ONE, &[on_top(pip), win([100, 100, 800, 600])]));
        assert!(full_screen_on(ONE, &[on_top(ONE)]));
        assert!(!full_screen_on(ONE, &[on_top(pip)]), "only the small window: no full-screen app");
    }

    #[test]
    fn the_bar_is_26_pixels_at_100_percent_and_scales_with_the_display() {
        assert_eq!(height_px(96), 26);
        assert_eq!(height_px(0), 26);
        assert_eq!(height_px(120), 33); // 125%: 32.5 rounds up
        assert_eq!(height_px(144), 39); // 150%
        assert_eq!(height_px(192), 52); // 200%
        assert_eq!(scale(2, 144), 3);
    }

    #[test]
    fn it_shows_the_workspaces_in_use_and_the_one_you_are_on_in_order() {
        assert_eq!(workspaces(&[1, 3], 2), vec![1, 2, 3]);
        assert_eq!(workspaces(&[3, 1], 3), vec![1, 3]);
        assert_eq!(workspaces(&[], 5), vec![5]);
        // 0: the display shows none of the nine, so only the ones in use.
        assert_eq!(workspaces(&[2], 0), vec![2]);
        assert_eq!(workspaces(&[2, 12], 10), vec![2]);
    }

    #[test]
    fn the_clock_names_the_day_and_follows_12_or_24_hours() {
        assert_eq!(clock(6, 22, 4, true), "Saturday 22:04");
        assert_eq!(clock(6, 22, 4, false), "Saturday 10:04");
        assert_eq!(clock(0, 0, 0, false), "Sunday 12:00");
        assert_eq!(clock(0, 0, 0, true), "Sunday 0:00");
        assert_eq!(clock(1, 12, 30, false), "Monday 12:30");
        assert_eq!(clock(3, 9, 5, true), "Wednesday 9:05");
    }

    #[test]
    fn a_time_pattern_with_an_upper_case_h_is_24_hours() {
        assert!(clock_is_24h("HH:mm:ss"));
        assert!(clock_is_24h("H:mm"));
        assert!(!clock_is_24h("h:mm:ss tt"));
        assert!(!clock_is_24h("tt hh:mm"));
        assert!(!clock_is_24h("h:mm 'Hrs'"));
        assert!(clock_is_24h(""));
    }

    #[test]
    fn a_click_lands_on_the_cell_under_it() {
        let c = cells(&[1, 2, 5], &[8, 8, 8], 6, 5);
        assert_eq!(c, vec![(1, 6, 18), (2, 24, 18), (5, 42, 18)]);
        assert_eq!(hit(&c, 6), Some(1));
        assert_eq!(hit(&c, 23), Some(1));
        assert_eq!(hit(&c, 24), Some(2));
        assert_eq!(hit(&c, 59), Some(5));
        assert_eq!(hit(&c, 60), None);
        assert_eq!(hit(&c, 2), None);
    }

    fn theme(mode: &str, fg: &str) -> String {
        format!(
            r##"{{"schema":1,"name":"calm","mode":"{mode}","surfaces":{{"spaces":{{
              "dark":{{"background":"#2b2e26","foreground":"{fg}","muted":"#bdbfaf","accent":"#a9bb8a"}},
              "light":{{"background":"#f6f3e8","foreground":"#2b2e26","muted":"#5c6152","accent":"#59693f"}}}}}}}}"##
        )
    }

    #[test]
    fn a_theme_gives_its_colors_by_mode_and_auto_follows_the_system() {
        let (c, name) = theme_colors(&theme("auto", "#f6f3e8"), true).unwrap();
        assert_eq!(name, "calm");
        assert_eq!(c, Colors { background: [0x2b, 0x2e, 0x26], foreground: [0xf6, 0xf3, 0xe8], muted: [0xbd, 0xbf, 0xaf], accent: [0xa9, 0xbb, 0x8a] });
        assert_eq!(theme_colors(&theme("auto", "#f6f3e8"), false).unwrap().0.background, [0xf6, 0xf3, 0xe8]);
        assert_eq!(theme_colors(&theme("light", "#f6f3e8"), true).unwrap().0.background, [0xf6, 0xf3, 0xe8]);
        assert_eq!(theme_colors(&theme("dark", "#f6f3e8"), false).unwrap().0.background, [0x2b, 0x2e, 0x26]);
    }

    #[test]
    fn a_file_that_is_not_a_theme_the_bar_draws_says_why() {
        assert!(theme_colors("nope", true).unwrap_err().contains("not JSON"));
        assert!(theme_colors(&theme("auto", "#f6f3e8").replace("\"schema\":1", "\"schema\":2"), true).unwrap_err().contains("newer"));
        assert!(theme_colors(&theme("auto", "#f6f3e8").replace("\"schema\":1,", ""), true).is_err());
        assert!(theme_colors(&theme("sepia", "#f6f3e8"), true).unwrap_err().contains("mode"));
        assert!(theme_colors(&theme("auto", "white"), true).unwrap_err().contains("#rrggbb"));
        assert!(theme_colors(&theme("auto", "#f6f3"), true).is_err());
        // Foreground too close to the background to read.
        assert!(theme_colors(&theme("auto", "#3a3d34"), true).unwrap_err().contains("4.5:1"));
        assert!(theme_colors(r#"{"schema":1,"mode":"dark","surfaces":{}}"#, true).unwrap_err().contains("surfaces.spaces.dark"));
    }

    #[test]
    fn the_built_in_look_reads_and_takes_the_system_accent() {
        let c = Colors::builtin(None);
        assert!(contrast(c.foreground, c.background) >= 4.5);
        assert!(contrast(c.muted, c.background) >= 4.5);
        assert_eq!(Colors::builtin(Some([1, 2, 3])).accent, [1, 2, 3]);
        assert_eq!(hex("#0a0B0c"), Some([10, 11, 12]));
        assert_eq!(hex("0a0b0c"), None);
        assert!((contrast([0, 0, 0], [255, 255, 255]) - 21.0).abs() < 0.01);
    }
}
