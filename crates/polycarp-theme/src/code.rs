//! Colors for code: the terminal palette, syntax highlighting and diffs. A theme may set any of
//! them in `[light.terminal]`, `[light.syntax]` and `[light.diff]` (and the same under dark). What
//! it leaves out is derived from its 13 colors and moved toward the text color until it reads, so
//! a theme that passes the base rules always passes these.

use super::contrast::{luminance, problem};
use super::{contrast, is_hex, Colors, MARK_MIN, ROLES, TEXT_MIN};
use std::collections::BTreeMap;

pub const CODE: [&str; 3] = ["terminal", "syntax", "diff"];
const HUES: [&str; 6] = ["red", "green", "yellow", "blue", "magenta", "cyan"];
pub const TERMINAL: [&str; 20] = [
    "background",
    "foreground",
    "cursor",
    "selection",
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "bright_black",
    "bright_red",
    "bright_green",
    "bright_yellow",
    "bright_blue",
    "bright_magenta",
    "bright_cyan",
    "bright_white",
];
pub const SYNTAX: [&str; 13] = [
    "keyword",
    "string",
    "number",
    "comment",
    "function",
    "type",
    "variable",
    "constant",
    "operator",
    "punctuation",
    "tag",
    "attribute",
    "property",
];
pub const DIFF: [&str; 7] = [
    "added",
    "removed",
    "modified",
    "added_surface",
    "removed_surface",
    "gutter_added",
    "gutter_removed",
];

/// The code colors of one mode, by group (`terminal`, `syntax`, `diff`).
pub type Code = BTreeMap<String, Colors>;

pub fn code_keys(group: &str) -> &'static [&'static str] {
    match group {
        "terminal" => &TERMINAL,
        "syntax" => &SYNTAX,
        "diff" => &DIFF,
        _ => &[],
    }
}

fn rgb(hex: &str) -> [f64; 3] {
    let b = |i: usize| f64::from(u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0));
    [b(1), b(3), b(5)]
}

fn to_hex(c: [f64; 3]) -> String {
    let b = |x: f64| x.round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", b(c[0]), b(c[1]), b(c[2]))
}

/// `a` moved toward `b` by `t` (0 is `a`, 1 is `b`).
pub fn mix(a: &str, b: &str, t: f64) -> String {
    let (x, y) = (rgb(a), rgb(b));
    to_hex([0, 1, 2].map(|i| x[i] + (y[i] - x[i]) * t))
}

/// Saturation and lightness of a color, 0 to 1.
fn sat_light(hex: &str) -> (f64, f64) {
    let [r, g, b] = rgb(hex).map(|x| x / 255.0);
    let (hi, lo) = (r.max(g).max(b), r.min(g).min(b));
    let l = (hi + lo) / 2.0;
    let d = hi - lo;
    let s = if d == 0.0 {
        0.0
    } else {
        d / (1.0 - (2.0 * l - 1.0).abs())
    };
    (s, l)
}

fn from_hsl(h: f64, s: f64, l: f64) -> String {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let (r, g, b) = match (h / 60.0) as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    to_hex([r, g, b].map(|v| (v + m) * 255.0))
}

/// `color`, moved toward `toward` in steps of 5% until it reads on `bg` at `min`.
fn fit(color: &str, bg: &str, toward: &str, min: f64) -> String {
    (0..=20)
        .map(|i| mix(color, toward, f64::from(i) * 0.05))
        .find(|c| contrast(c, bg) >= min)
        .unwrap_or_else(|| toward.to_string())
}

fn or(m: &mut Colors, k: &str, v: impl FnOnce(&Colors) -> String) {
    if !m.contains_key(k) {
        let x = v(m);
        m.insert(k.to_string(), x);
    }
}

/// Every code color of one mode: what the theme sets, and the rest derived from `c`.
pub fn derive(c: &Colors, given: &Code) -> Code {
    let role = |k: &str| c.get(k).cloned().unwrap_or_else(|| "#000000".into());
    let own = |g: &str| given.get(g).cloned().unwrap_or_default();

    let mut t = own("terminal");
    or(&mut t, "background", |_| role("background"));
    or(&mut t, "foreground", |_| role("foreground"));
    let (bg, fg) = (t["background"].clone(), t["foreground"].clone());
    let ink = |color: &str| fit(color, &bg, &fg, MARK_MIN);
    or(&mut t, "cursor", |_| ink(&role("accent")));
    or(&mut t, "selection", |_| role("selection"));
    let (dark, light) = if luminance(&bg) < luminance(&fg) {
        (bg.clone(), fg.clone())
    } else {
        (fg.clone(), bg.clone())
    };
    // Blue, magenta and cyan take urgent's lightness, and no more color than the theme's quiet
    // roles can sit beside.
    let (s, l) = sat_light(&role("urgent"));
    let s = s.min(0.55);
    for (k, v) in [
        ("red", role("urgent")),
        ("green", role("done")),
        ("yellow", role("working")),
        ("blue", from_hsl(215.0, s, l)),
        ("magenta", from_hsl(300.0, s, l)),
        ("cyan", from_hsl(185.0, s, l)),
    ] {
        or(&mut t, k, |_| ink(&v));
    }
    // Bright is lighter in both modes, as far as it still reads.
    for k in HUES {
        or(&mut t, &format!("bright_{k}"), |m| {
            ink(&mix(&m[k], &light, 0.3))
        });
    }
    // Black and white sit just inside the ends, so neither vanishes into the background.
    or(&mut t, "black", |_| mix(&dark, &light, 0.15));
    or(&mut t, "white", |_| mix(&light, &dark, 0.15));
    or(&mut t, "bright_black", |_| ink(&role("muted")));
    or(&mut t, "bright_white", |_| light.clone());

    let (back, fore) = (role("background"), role("foreground"));
    let text = |color: &str| fit(color, &back, &fore, TEXT_MIN);
    let mut sy = own("syntax");
    for (k, v) in [
        ("keyword", role("accent")),
        ("string", role("done")),
        ("number", role("working")),
        ("comment", role("muted")),
        ("function", t["blue"].clone()),
        ("type", t["cyan"].clone()),
        ("variable", fore.clone()),
        ("constant", t["magenta"].clone()),
        ("operator", fore.clone()),
        ("punctuation", role("muted")),
        ("tag", role("urgent")),
        ("attribute", role("working")),
        ("property", mix(&t["blue"], &fore, 0.4)),
    ] {
        or(&mut sy, k, |_| text(&v));
    }

    let mut d = own("diff");
    or(&mut d, "added", |_| text(&role("done")));
    or(&mut d, "removed", |_| text(&role("urgent")));
    or(&mut d, "modified", |_| {
        fit(&role("working"), &back, &fore, MARK_MIN)
    });
    // A tint of the background toward the line's color, as strong as still reads.
    let tint = |color: &str| {
        [0.16, 0.12, 0.08, 0.04, 0.0]
            .iter()
            .map(|a| mix(&back, color, *a))
            .find(|s| contrast(&fore, s) >= TEXT_MIN && contrast(color, s) >= TEXT_MIN)
            .unwrap_or_else(|| back.clone())
    };
    or(&mut d, "added_surface", |m| tint(&m["added"]));
    or(&mut d, "removed_surface", |m| tint(&m["removed"]));
    or(&mut d, "gutter_added", |m| m["added"].clone());
    or(&mut d, "gutter_removed", |m| m["removed"].clone());

    Code::from([
        ("terminal".to_string(), t),
        ("syntax".to_string(), sy),
        ("diff".to_string(), d),
    ])
}

/// The code pairs that must read, as (text, on, minimum). A name without a group is one of the
/// 13 colors. Black, white, bright black and bright white are not checked: terminals draw them as
/// backgrounds as often as text.
pub fn code_pairs() -> Vec<(String, String, f64)> {
    let p = |a: &str, b: &str, m: f64| (a.to_string(), b.to_string(), m);
    let mut v = vec![
        p("terminal.foreground", "terminal.background", TEXT_MIN),
        p("terminal.foreground", "terminal.selection", TEXT_MIN),
        p("terminal.cursor", "terminal.background", MARK_MIN),
    ];
    for k in HUES {
        for name in [k.to_string(), format!("bright_{k}")] {
            v.push(p(
                &format!("terminal.{name}"),
                "terminal.background",
                MARK_MIN,
            ));
        }
    }
    for k in SYNTAX {
        v.push(p(&format!("syntax.{k}"), "background", TEXT_MIN));
    }
    for (line, surface) in [("added", "added_surface"), ("removed", "removed_surface")] {
        v.push(p(
            &format!("diff.{line}"),
            &format!("diff.{surface}"),
            TEXT_MIN,
        ));
        v.push(p("foreground", &format!("diff.{surface}"), TEXT_MIN));
    }
    for k in ["modified", "gutter_added", "gutter_removed"] {
        v.push(p(&format!("diff.{k}"), "background", MARK_MIN));
    }
    v
}

/// Code pairs of one mode that do not read. Empty until all 13 colors are valid, since the base
/// rules report those first.
pub fn code_problems(mode: &str, c: &Colors, given: &Code) -> Vec<String> {
    if !ROLES.iter().all(|r| c.get(*r).is_some_and(|v| is_hex(v))) {
        return Vec::new();
    }
    let all = derive(c, given);
    let get = |path: &str| match path.split_once('.') {
        Some((g, k)) => all.get(g).and_then(|m| m.get(k)),
        None => c.get(path),
    };
    let mut out = Vec::new();
    for (fg, bg, min) in code_pairs() {
        if let (Some(f), Some(b)) = (get(&fg), get(&bg)) {
            let ratio = contrast(f, b);
            if ratio < min {
                out.push(problem(mode, &fg, &bg, ratio, min));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::{colors_of, parse_toml, resolve_name, Themes, BUILTINS, MODES, SURFACES};
    use super::*;

    struct NoUserThemes;
    impl Themes for NoUserThemes {
        fn user_theme(&self, name: &str) -> Result<toml::Table, String> {
            Err(format!("no theme named {name:?}"))
        }
    }

    #[test]
    fn color_math() {
        assert_eq!(mix("#000000", "#ffffff", 0.5), "#808080");
        assert_eq!(from_hsl(0.0, 1.0, 0.5), "#ff0000");
        assert_eq!(from_hsl(240.0, 1.0, 0.5), "#0000ff");
        assert_eq!(from_hsl(120.0, 1.0, 0.25), "#008000");
        let (s, l) = sat_light("#ff0000");
        assert!((s - 1.0).abs() < 1e-9 && (l - 0.5).abs() < 1e-9);
    }

    #[test]
    fn every_builtin_has_every_code_color_and_they_read() {
        for (name, _) in BUILTINS {
            let full =
                resolve_name(&NoUserThemes, name).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            for s in SURFACES {
                let r = full.surface(s);
                for m in MODES {
                    let code = r.code(m);
                    for g in CODE {
                        let mut want = code_keys(g).to_vec();
                        want.sort_unstable();
                        let got: Vec<&str> = code[g].keys().map(String::as_str).collect();
                        assert_eq!(got, want, "{name} {s} {m} {g}");
                        assert!(code[g].values().all(|v| is_hex(v)), "{name} {s} {m} {g}");
                    }
                }
                assert_eq!(r.contrast_problems(), Vec::<String>::new(), "{name} {s}");
            }
        }
    }

    #[test]
    fn a_set_color_wins_and_an_unreadable_one_is_reported() {
        let t = parse_toml(BUILTINS[0].1).unwrap();
        let c = colors_of(&t, "light");
        let back = c["background"].clone();
        let given = Code::from([(
            "syntax".to_string(),
            Colors::from([
                ("keyword".to_string(), "#123456".to_string()),
                ("comment".to_string(), back.clone()),
            ]),
        )]);
        let all = derive(&c, &given);
        assert_eq!(all["syntax"]["keyword"], "#123456");
        assert_eq!(
            code_problems("light", &c, &given),
            vec!["light.syntax.comment on light.background is 1.00, needs 4.5".to_string()]
        );
        assert!(code_problems("light", &c, &Code::new()).is_empty());
    }
}
