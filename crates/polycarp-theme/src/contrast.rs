//! WCAG contrast, and the pairs every theme must keep readable.

use std::collections::{BTreeMap, BTreeSet};

fn channel(c: u8) -> f64 {
    let c = f64::from(c) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

pub(crate) fn luminance(hex: &str) -> f64 {
    let b = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
    0.2126 * channel(b(1)) + 0.7152 * channel(b(3)) + 0.0722 * channel(b(5))
}

/// WCAG contrast ratio of two `#rrggbb` colors, 1 to 21.
pub fn contrast(a: &str, b: &str) -> f64 {
    let (x, y) = (luminance(a), luminance(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

pub type Colors = BTreeMap<String, String>;

/// Contrast for text, and for marks that are not text (the status indicators on `sunken`).
pub const TEXT_MIN: f64 = 4.5;
pub const MARK_MIN: f64 = 3.0;

/// The pairs that must stay readable: (text, on, minimum). They are the pairs the UI draws.
/// Contrast is the same both ways round, so the danger button's `background` on `urgent` is the
/// `urgent` on `background` pair below.
pub fn pairs() -> Vec<(&'static str, &'static str, f64)> {
    let mut v = Vec::new();
    for fg in ["foreground", "strong", "muted"] {
        for bg in ["background", "surface", "sunken"] {
            v.push((fg, bg, TEXT_MIN));
        }
    }
    for fg in ["foreground", "strong"] {
        v.push((fg, "selection", TEXT_MIN));
    }
    for fg in ["urgent", "working", "done", "accent"] {
        for bg in ["background", "surface"] {
            v.push((fg, bg, TEXT_MIN));
        }
    }
    v.push(("on_accent", "accent", TEXT_MIN));
    for fg in ["urgent", "working", "done", "accent"] {
        v.push((fg, "sunken", MARK_MIN));
    }
    v
}

/// How a pair that does not read is reported, such as `dark.muted on dark.sunken is 3.10, needs 4.5`.
pub(crate) fn problem(mode: &str, fg: &str, bg: &str, ratio: f64, min: f64) -> String {
    let shown = ((ratio * 100.0 + 1e-9).floor()) / 100.0;
    format!("{mode}.{fg} on {mode}.{bg} is {shown:.2}, needs {min:?}")
}

pub fn contrast_on(light: &Colors, dark: &Colors) -> Vec<String> {
    let mut out = Vec::new();
    for (mode, colors) in [("light", light), ("dark", dark)] {
        for (fg, bg, min) in pairs() {
            if let (Some(f), Some(b)) = (colors.get(fg), colors.get(bg)) {
                let ratio = contrast(f, b);
                if ratio < min {
                    out.push(problem(mode, fg, bg, ratio, min));
                }
            }
        }
    }
    out
}

/// Problems of the theme itself, then the ones a surface adds on top.
pub fn combine(base: Vec<String>, per_surface: Vec<(String, Vec<String>)>) -> Vec<String> {
    let seen: BTreeSet<String> = base.iter().cloned().collect();
    let mut out = base;
    for (s, probs) in per_surface {
        for p in probs {
            if !seen.contains(&p) {
                out.push(format!("surface.{s}: {p}"));
            }
        }
    }
    out
}
