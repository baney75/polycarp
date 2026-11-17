//! The shell's look, read from the theme the `polycarp theme` command writes: `current/theme.json` in the config
//! folder (`themes/README.md`), surface `spaces`. Every color, radius, font and duration the bar and launcher draw
//! comes from here. With no file (the theme is off), the built-in `polycarp` theme as that command writes it.

use serde_json::Value;
use std::path::PathBuf;

const DEFAULT: &str = include_str!("default-theme.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    pub fn parse(s: &str) -> Option<Rgb> {
        let h = s.strip_prefix('#').filter(|h| h.len() == 6 && h.is_ascii())?;
        let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
        Some(Rgb(byte(0)?, byte(2)?, byte(4)?))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Palette {
    pub background: Rgb,
    pub surface: Rgb,
    pub sunken: Rgb,
    pub foreground: Rgb,
    pub strong: Rgb,
    pub muted: Rgb,
    pub border: Rgb,
    pub accent: Rgb,
    pub on_accent: Rgb,
    pub selection: Rgb,
    pub urgent: Rgb,
    pub working: Rgb,
    pub done: Rgb,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Auto,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Indicator {
    Dot,
    Bar,
    NumberBlock,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Density {
    Compact,
    Regular,
    Spacious,
}

impl Density {
    /// Padding scale against regular.
    pub fn scale(self) -> f32 {
        match self {
            Density::Compact => 0.75,
            Density::Regular => 1.0,
            Density::Spacious => 1.25,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Theme {
    pub name: String,
    pub mode: Mode,
    pub light: Palette,
    pub dark: Palette,
    pub radius_small: f32,
    pub radius: f32,
    pub radius_large: f32,
    pub border_width: f32,
    pub blur: f32,
    pub shadow: f32,
    pub density: Density,
    pub indicator: Indicator,
    /// Font families to try in order, already mapped to Windows names.
    pub font_ui: Vec<String>,
    pub font_display: Vec<String>,
    pub font_mono: Vec<String>,
    pub size: f32,
    pub weight: u32,
    pub fast_ms: u32,
    pub normal_ms: u32,
    pub slow_ms: u32,
    /// Cubic bezier control points (x1, y1, x2, y2).
    pub easing: [f32; 4],
    pub scale_from: f32,
}

impl Theme {
    /// The built-in `polycarp` theme, used while no theme file is in force.
    pub fn default_theme() -> Theme {
        Theme::parse(DEFAULT).expect("the built-in theme parses")
    }

    /// Reads `theme.json` for the `spaces` surface. An error names the first missing or bad field.
    pub fn parse(json: &str) -> Result<Theme, String> {
        let v: Value = serde_json::from_str(json).map_err(|e| format!("theme.json: {e}"))?;
        let s = &v["surfaces"]["spaces"];
        if !s.is_object() {
            return Err("theme.json has no surfaces.spaces".into());
        }
        let num = |path: &str| -> Result<f64, String> {
            s.pointer(path).and_then(Value::as_f64).ok_or_else(|| format!("theme.json: spaces{} is missing", path.replace('/', ".")))
        };
        let text = |path: &str| -> Result<&str, String> {
            s.pointer(path).and_then(Value::as_str).ok_or_else(|| format!("theme.json: spaces{} is missing", path.replace('/', ".")))
        };
        let palette = |mode: &str| -> Result<Palette, String> {
            let c = |k: &str| -> Result<Rgb, String> {
                let raw = text(&format!("/{mode}/{k}"))?;
                Rgb::parse(raw).ok_or_else(|| format!("theme.json: spaces.{mode}.{k} is not #rrggbb"))
            };
            Ok(Palette {
                background: c("background")?,
                surface: c("surface")?,
                sunken: c("sunken")?,
                foreground: c("foreground")?,
                strong: c("strong")?,
                muted: c("muted")?,
                border: c("border")?,
                accent: c("accent")?,
                on_accent: c("on_accent")?,
                selection: c("selection")?,
                urgent: c("urgent")?,
                working: c("working")?,
                done: c("done")?,
            })
        };
        let reduced = s.pointer("/motion/reduced").and_then(Value::as_bool).unwrap_or(false);
        let ms = |k: &str| -> Result<u32, String> { Ok(if reduced { 0 } else { num(&format!("/motion/{k}"))?.clamp(0.0, 1000.0) as u32 }) };
        Ok(Theme {
            name: v["name"].as_str().unwrap_or("").to_string(),
            mode: match v["mode"].as_str() {
                Some("light") => Mode::Light,
                Some("dark") => Mode::Dark,
                _ => Mode::Auto,
            },
            light: palette("light")?,
            dark: palette("dark")?,
            radius_small: num("/shape/radius_small")? as f32,
            radius: num("/shape/radius")? as f32,
            radius_large: num("/shape/radius_large")? as f32,
            border_width: num("/shape/border_width")? as f32,
            blur: num("/shape/blur")? as f32,
            shadow: num("/shape/shadow")? as f32,
            density: match text("/shape/density")? {
                "compact" => Density::Compact,
                "spacious" => Density::Spacious,
                _ => Density::Regular,
            },
            indicator: match text("/shape/indicator")? {
                "bar" => Indicator::Bar,
                "number-block" => Indicator::NumberBlock,
                _ => Indicator::Dot,
            },
            font_ui: fonts(text("/type/ui")?, "sans"),
            font_display: fonts(text("/type/display")?, "sans"),
            font_mono: fonts(text("/type/mono")?, "mono"),
            size: num("/type/size")? as f32,
            weight: num("/type/weight")? as u32,
            fast_ms: ms("fast")?,
            normal_ms: ms("normal")?,
            slow_ms: ms("slow")?,
            easing: easing(text("/motion/easing")?).ok_or("theme.json: spaces.motion.easing is not an easing")?,
            scale_from: num("/motion/scale_from")? as f32,
        })
    }

    /// The colors for light or dark. `system_dark` is what Windows apps use now (only read in auto mode).
    pub fn palette(&self, system_dark: bool) -> &Palette {
        let dark = match self.mode {
            Mode::Light => false,
            Mode::Dark => true,
            Mode::Auto => system_dark,
        };
        if dark {
            &self.dark
        } else {
            &self.light
        }
    }
}

/// A CSS font stack as Windows families, in order: quotes dropped, the generic names turned into the fonts Windows
/// ships, names only another system has kept (DirectWrite skips a family that isn't installed). `fallback` is the
/// generic family appended at the end so something always draws.
pub fn fonts(stack: &str, fallback: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |f: &str| {
        if !f.is_empty() && !out.iter().any(|o| o.eq_ignore_ascii_case(f)) {
            out.push(f.to_string());
        }
    };
    for raw in stack.split(',').chain(std::iter::once(fallback)) {
        let name = raw.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        match name.to_ascii_lowercase().as_str() {
            "system-ui" | "-apple-system" | "blinkmacsystemfont" | "ui-sans-serif" | "sans-serif" | "sans" => {
                push("Segoe UI Variable Text");
                push("Segoe UI");
            }
            "ui-serif" | "serif" => push("Georgia"),
            "ui-monospace" | "monospace" | "mono" => {
                push("Cascadia Mono");
                push("Consolas");
            }
            "ui-rounded" | "cursive" | "fantasy" | "emoji" | "math" | "fangsong" => {}
            _ => push(name),
        }
    }
    out
}

/// A CSS easing as cubic bezier control points.
pub fn easing(s: &str) -> Option<[f32; 4]> {
    match s.trim() {
        "linear" => Some([0.0, 0.0, 1.0, 1.0]),
        "ease" => Some([0.25, 0.1, 0.25, 1.0]),
        "ease-in" => Some([0.42, 0.0, 1.0, 1.0]),
        "ease-out" => Some([0.0, 0.0, 0.58, 1.0]),
        "ease-in-out" => Some([0.42, 0.0, 0.58, 1.0]),
        t => {
            let inner = t.strip_prefix("cubic-bezier(")?.strip_suffix(')')?;
            let p: Vec<f32> = inner.split(',').map(|x| x.trim().parse::<f32>()).collect::<Result<_, _>>().ok()?;
            (p.len() == 4).then(|| [p[0], p[1], p[2], p[3]])
        }
    }
}

/// Progress along the easing at time fraction `t` (0 to 1).
pub fn ease(curve: [f32; 4], t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    let [x1, y1, x2, y2] = curve;
    let bez = |a: f32, b: f32, s: f32| 3.0 * a * s * (1.0 - s).powi(2) + 3.0 * b * s * s * (1.0 - s) + s.powi(3);
    // Find s with x(s) = t by bisection: x is monotonic for x1, x2 in 0..1.
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.0;
        if bez(x1, x2, mid) < t {
            lo = mid
        } else {
            hi = mid
        }
    }
    bez(y1, y2, (lo + hi) / 2.0)
}

/// The config folder: `POLYCARP_CONFIG_DIR` (absolute only), else `%APPDATA%\Polycarp`, as the `polycarp` command.
pub fn config_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("POLYCARP_CONFIG_DIR").map(PathBuf::from) {
        return d.is_absolute().then_some(d);
    }
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Polycarp"))
}

/// Loads the theme in force: the file if it is there and reads, else the built-in one. The error says why the file
/// was not used, for the log.
pub fn load(dir: Option<&std::path::Path>) -> (Theme, Option<String>) {
    let Some(path) = dir.map(|d| d.join("current").join("theme.json")) else {
        return (Theme::default_theme(), Some("no config folder".into()));
    };
    match std::fs::read_to_string(&path) {
        Ok(s) => match Theme::parse(&s) {
            Ok(t) => (t, None),
            Err(e) => (Theme::default_theme(), Some(e)),
        },
        Err(_) => (Theme::default_theme(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_built_in_theme_reads_with_every_field() {
        let t = Theme::default_theme();
        assert_eq!(t.name, "polycarp");
        assert_eq!(t.dark.accent, Rgb(0xa9, 0xbb, 0x8a));
        assert_eq!(t.indicator, Indicator::Dot);
        assert_eq!(t.radius_large, 16.0);
        assert_eq!(t.normal_ms, 200);
        assert_eq!(t.easing, [0.2, 0.0, 0.0, 1.0]);
        assert_eq!(t.font_ui[0], "Segoe UI Variable Text");
    }

    #[test]
    fn mode_picks_the_palette_and_auto_follows_windows() {
        let mut t = Theme::default_theme();
        assert_eq!(t.palette(true), &t.dark);
        assert_eq!(t.palette(false), &t.light);
        t.mode = Mode::Light;
        assert_eq!(t.palette(true), &t.light);
    }

    #[test]
    fn reduced_motion_makes_every_duration_zero() {
        let json = DEFAULT.replace("\"reduced\": false", "\"reduced\": true");
        let t = Theme::parse(&json).unwrap();
        assert_eq!((t.fast_ms, t.normal_ms, t.slow_ms), (0, 0, 0));
    }

    #[test]
    fn a_bad_field_is_named_and_the_file_is_not_used() {
        let json = DEFAULT.replace("\"#a9bb8a\"", "\"green\"");
        assert_eq!(Theme::parse(&json).unwrap_err(), "theme.json: spaces.dark.accent is not #rrggbb");
        let dir = std::env::temp_dir().join(format!("pc-theme-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("current")).unwrap();
        std::fs::write(dir.join("current/theme.json"), json).unwrap();
        let (t, why) = load(Some(&dir));
        assert_eq!(t, Theme::default_theme());
        assert!(why.unwrap().contains("dark.accent"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn font_stacks_become_windows_families() {
        assert_eq!(
            fonts(r#"system-ui, -apple-system, "Segoe UI", Roboto, sans-serif"#, "sans")[..3],
            ["Segoe UI Variable Text", "Segoe UI", "Roboto"]
        );
        assert_eq!(
            fonts(r#"ui-monospace, "SF Mono", Menlo, Consolas, monospace"#, "mono"),
            ["Cascadia Mono", "Consolas", "SF Mono", "Menlo"]
        );
        assert_eq!(fonts("'Iowan Old Style', serif", "sans"), ["Iowan Old Style", "Georgia", "Segoe UI Variable Text", "Segoe UI"]);
    }

    #[test]
    fn easing_curves_parse_and_run_from_zero_to_one() {
        let c = easing("cubic-bezier(0.2, 0, 0, 1)").unwrap();
        assert!(ease(c, 0.0).abs() < 1e-3 && (ease(c, 1.0) - 1.0).abs() < 1e-3);
        assert!(ease(c, 0.5) > 0.5, "a decelerating curve is past halfway at half time");
        assert!((ease(easing("linear").unwrap(), 0.3) - 0.3).abs() < 1e-3);
        assert_eq!(easing("bounce"), None);
    }
}
