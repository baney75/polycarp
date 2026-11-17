//! `theme import`: a base16 or base24 scheme in the tinted-theming format, as a Polycarp theme.
//!
//! A scheme has one set of colors, light or dark, so both of the theme's modes use it. Colors
//! that would not read under Polycarp's contrast rules are moved until they do, and each move is
//! reported.

use polycarp_theme::{code_pairs, contrast, fit, is_hex, mix, pairs, Colors};
use std::collections::BTreeMap;
use toml::Value;

/// A scheme as read: its name, author, system (base16 or base24) and the slots `base00` and up,
/// each a lowercase `#rrggbb`.
pub(super) struct Scheme {
    pub name: String,
    pub author: String,
    pub system: String,
    pub slug: Option<String>,
    pub slots: BTreeMap<String, String>,
}

const BASE16: [&str; 16] = [
    "base00", "base01", "base02", "base03", "base04", "base05", "base06", "base07", "base08",
    "base09", "base0A", "base0B", "base0C", "base0D", "base0E", "base0F",
];

/// A YAML string value without its quotes, or a bare value without a trailing comment.
fn scalar(v: &str) -> String {
    let v = v.trim();
    for q in ['"', '\''] {
        if let Some(rest) = v.strip_prefix(q) {
            if let Some(end) = rest.find(q) {
                return rest[..end].to_string();
            }
        }
    }
    v.split(" #").next().unwrap_or("").trim().to_string()
}

/// Reads the tinted-theming scheme format (`palette:` with `base00` and up), or the older flat
/// one (`scheme:` and the slots at the top level, without `#`). Only that much YAML is read.
pub(super) fn parse(text: &str) -> Result<Scheme, String> {
    let mut top = BTreeMap::new();
    let mut slots = BTreeMap::new();
    for (n, line) in text.lines().enumerate() {
        let body = line.trim_start();
        if body.is_empty() || body.starts_with('#') || body == "---" {
            continue;
        }
        let Some((k, v)) = body.split_once(':') else {
            return Err(format!("line {}: expected `key: value`", n + 1));
        };
        let (k, v) = (k.trim(), scalar(v));
        if k.len() == 6 && k.starts_with("base") {
            let hex = format!("#{}", v.trim_start_matches('#')).to_lowercase();
            if !is_hex(&hex) {
                return Err(format!(
                    "line {}: {k} is {v:?}, not a color like \"#rrggbb\"",
                    n + 1
                ));
            }
            // Slot names are matched without case: `base0a` is `base0A`.
            slots.insert(format!("base{}", k[4..].to_uppercase()), hex);
        } else if !line.starts_with([' ', '\t']) {
            top.insert(k.to_string(), v);
        }
    }
    let missing: Vec<&str> = BASE16
        .iter()
        .filter(|s| !slots.contains_key(**s))
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "not a base16 or base24 scheme: no {}",
            missing.join(", ")
        ));
    }
    let base24 = (0x10..=0x17).all(|i| slots.contains_key(&format!("base{i:02X}")));
    let get = |k: &str| top.get(k).filter(|v| !v.is_empty()).cloned();
    Ok(Scheme {
        name: get("name")
            .or_else(|| get("scheme"))
            .unwrap_or_else(|| "Imported".into()),
        author: get("author").unwrap_or_default(),
        system: if base24 { "base24" } else { "base16" }.into(),
        slug: get("slug"),
        slots,
    })
}

/// A theme name from the scheme's name: `Rosé Pine Dawn` is `ros-pine-dawn`.
pub(super) fn slug(s: &Scheme) -> String {
    let src = s.slug.clone().unwrap_or_else(|| s.name.clone());
    let mut out = String::new();
    for ch in src.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// The pure color farthest from `bg`, which every fit moves toward.
fn away(bg: &str) -> &'static str {
    if contrast(bg, "#000000") > contrast(bg, "#ffffff") {
        "#000000"
    } else {
        "#ffffff"
    }
}

/// The 13 colors, the terminal palette and the syntax colors of a scheme, each fitted to its
/// contrast rules. Returns them with one line per color that moved.
pub(super) fn colors(s: &Scheme) -> (Colors, Colors, Colors, Vec<String>) {
    let b = |k: &str| s.slots[k].clone();
    // A base24 bright color, or the base16 color it brightens.
    let br = |k24: &str, k16: &str| s.slots.get(k24).cloned().unwrap_or_else(|| b(k16));
    let bg = b("base00");
    let dark = contrast(&bg, "#000000") < contrast(&bg, "#ffffff");
    let strongest = ["base05", "base06", "base07"]
        .into_iter()
        .map(b)
        .max_by(|x, y| contrast(x, &bg).total_cmp(&contrast(y, &bg)))
        .unwrap_or_else(|| b("base05"));
    let set = |pairs: &[(&str, String)]| -> Colors {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    };
    let mut c = set(&[
        ("background", bg.clone()),
        // Schemes disagree on which side of the background base01 falls, so these are mixed.
        (
            "surface",
            mix(&bg, "#ffffff", if dark { 0.06 } else { 0.6 }),
        ),
        (
            "sunken",
            mix(&bg, "#000000", if dark { 0.25 } else { 0.05 }),
        ),
        ("foreground", b("base05")),
        ("strong", strongest),
        ("muted", b("base04")),
        ("border", b("base02")),
        ("accent", b("base0D")),
        ("on_accent", bg.clone()),
        ("selection", b("base02")),
        ("urgent", b("base08")),
        ("working", b("base0A")),
        ("done", b("base0B")),
    ]);
    let mut t = set(&[
        ("background", bg.clone()),
        ("foreground", b("base05")),
        ("cursor", b("base05")),
        ("selection", b("base02")),
        ("black", b("base00")),
        ("red", b("base08")),
        ("green", b("base0B")),
        ("yellow", b("base0A")),
        ("blue", b("base0D")),
        ("magenta", b("base0E")),
        ("cyan", b("base0C")),
        ("white", b("base05")),
        ("bright_black", b("base03")),
        ("bright_red", br("base12", "base08")),
        ("bright_green", br("base14", "base0B")),
        ("bright_yellow", br("base13", "base0A")),
        ("bright_blue", br("base16", "base0D")),
        ("bright_magenta", br("base17", "base0E")),
        ("bright_cyan", br("base15", "base0C")),
        ("bright_white", b("base07")),
    ]);
    // The base16 styling guide's syntax slots.
    let mut x = set(&[
        ("keyword", b("base0E")),
        ("string", b("base0B")),
        ("number", b("base09")),
        ("comment", b("base03")),
        ("function", b("base0D")),
        ("type", b("base0A")),
        ("variable", b("base08")),
        ("constant", b("base09")),
        ("operator", b("base05")),
        ("punctuation", b("base05")),
        ("tag", b("base08")),
        ("attribute", b("base09")),
        ("property", b("base08")),
    ]);
    let mut moved = Vec::new();
    // Twice, since a color that moves can be another rule's background (accent under on_accent).
    for _ in 0..2 {
        for (fg, on, min) in pairs() {
            let under = c[on].clone();
            fit_one(&mut c, fg, &under, min, fg, on, &mut moved);
        }
    }
    for (fg, on, min) in code_pairs() {
        let Some((group, key)) = fg.split_once('.') else {
            continue;
        };
        let under = match on.split_once('.') {
            Some(("terminal", k)) => t[k].clone(),
            Some(_) => continue,
            None => c[&on].clone(),
        };
        let map = match group {
            "terminal" => &mut t,
            "syntax" => &mut x,
            _ => continue,
        };
        fit_one(map, key, &under, min, &fg, &on, &mut moved);
    }
    (c, t, x, moved)
}

fn fit_one(
    map: &mut Colors,
    key: &str,
    bg: &str,
    min: f64,
    label: &str,
    on: &str,
    moved: &mut Vec<String>,
) {
    let was = map[key].clone();
    let ratio = contrast(&was, bg);
    if ratio < min {
        let now = fit(&was, bg, away(bg), min);
        moved.push(format!(
            "{label} {was} is {ratio:.2} on {on}, needs {min:?}: it is {now} instead"
        ));
        map.insert(key.to_string(), now);
    }
}

/// The theme file for a scheme, named `name`, and the colors that moved to read.
pub(super) fn theme_toml(s: &Scheme, name: &str, source: &str) -> (String, Vec<String>) {
    let (c, t, x, moved) = colors(s);
    let q = |v: &str| Value::String(v.to_string()).to_string();
    let by = if s.author.is_empty() {
        String::new()
    } else {
        format!(" by {}", s.author)
    };
    let mut out = format!(
        "# Imported by `polycarp theme import` from {source}.\n\
         # A {} scheme has one set of colors, so light and dark are the same.\n\
         name = {}\ntitle = {}\ndescription = {}\nextends = \"polycarp\"\n",
        s.system,
        q(name),
        q(&s.name),
        q(&format!("{}, a {} scheme{by}.", s.name, s.system)),
    );
    for mode in ["light", "dark"] {
        for (table, map) in [("", &c), (".terminal", &t), (".syntax", &x)] {
            out.push_str(&format!("\n[{mode}{table}]\n"));
            for (k, v) in map {
                out.push_str(&format!("{k} = \"{v}\"\n"));
            }
        }
    }
    (out, moved)
}
