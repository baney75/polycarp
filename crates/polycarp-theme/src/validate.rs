//! Checks one theme file by itself: names, types, ranges and unknown keys.

use super::{fields, Kind, CODE, MODES, SECTIONS, SURFACES};
use toml::{Table, Value};

/// Names Windows will not use for a file, whatever the extension. Refused on every system so a
/// theme made on one machine works on all of them.
fn is_reserved_name(n: &str) -> bool {
    matches!(n, "con" | "prn" | "aux" | "nul")
        || ["com", "lpt"].iter().any(|p| {
            n.strip_prefix(p)
                .is_some_and(|d| matches!(d.as_bytes(), [b'1'..=b'9']))
        })
}

pub fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && !is_reserved_name(n)
        && n.len() <= 48
        && !n.starts_with('-')
        && n.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn is_hex(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn check_easing(s: &str) -> Result<(), String> {
    if matches!(
        s,
        "ease" | "linear" | "ease-in" | "ease-out" | "ease-in-out"
    ) {
        return Ok(());
    }
    let bad = || {
        format!(
            "{s:?} is not ease, ease-in, ease-out, ease-in-out, linear or cubic-bezier(a, b, c, d)"
        )
    };
    let inner = s
        .strip_prefix("cubic-bezier(")
        .and_then(|r| r.strip_suffix(')'))
        .ok_or_else(bad)?;
    let parts: Vec<&str> = inner.split(',').collect();
    if parts.len() != 4 {
        return Err(bad());
    }
    let mut nums = Vec::new();
    for p in parts {
        match p.trim().parse::<f64>() {
            Ok(n) if n.is_finite() => nums.push(n),
            _ => return Err(bad()),
        }
    }
    if !(0.0..=1.0).contains(&nums[0]) || !(0.0..=1.0).contains(&nums[2]) {
        return Err(format!(
            "{s:?} needs its x values (first and third) between 0 and 1"
        ));
    }
    Ok(())
}

/// A font stack: family names separated by commas. Each is either plain (letters, digits, spaces,
/// hyphens, underscores) or in matching quotes with no quote, backslash, `<`, control character or
/// `/*` inside. Anything else could break out of the stylesheet, so it is refused.
pub fn check_font(s: &str) -> Result<(), String> {
    let bad = |why: &str| {
        Err(format!(
            "{s:?} is not a font stack: {why}. Use names separated by commas, such as Georgia, \"Times New Roman\", serif"
        ))
    };
    if s.trim().is_empty() {
        return Err("must not be empty".into());
    }
    let mut rest = s;
    loop {
        rest = rest.trim_start();
        let after = if let Some(q) = rest.chars().next().filter(|c| matches!(c, '"' | '\'')) {
            let body = &rest[1..];
            let Some(end) = body.find(q) else {
                return bad("a quote is not closed");
            };
            let inner = &body[..end];
            if inner.trim().is_empty() {
                return bad("a quoted name is empty");
            }
            if inner.contains("/*") {
                return bad("a quoted name contains /*");
            }
            if inner
                .chars()
                .any(|c| c.is_control() || matches!(c, '\\' | '"' | '\'' | '<'))
            {
                return bad("a quoted name has a backslash, quote, < or control character");
            }
            &body[end + 1..]
        } else {
            let end = rest.find(',').unwrap_or(rest.len());
            let name = rest[..end].trim_end();
            if name.is_empty() {
                return bad("a name is missing");
            }
            if !name
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
            {
                return bad(
                    "a name has a character other than letters, digits, spaces, hyphens and underscores (put it in quotes only if it is a real family name)",
                );
            }
            &rest[end..]
        };
        let after = after.trim_start();
        match after.strip_prefix(',') {
            Some(next) => rest = next,
            None if after.is_empty() => return Ok(()),
            None => return bad("something follows a quoted name that is not a comma"),
        }
    }
}

pub fn check_value(path: &str, v: &Value, kind: Kind, out: &mut Vec<String>) {
    match kind {
        Kind::Hex => match v.as_str() {
            Some(s) if is_hex(s) => {}
            Some(s) => out.push(format!("{path}: {s:?} is not a color like \"#rrggbb\"")),
            None => out.push(format!("{path}: must be a string like \"#rrggbb\"")),
        },
        Kind::Int(lo, hi) => match v.as_integer() {
            Some(n) if (lo..=hi).contains(&n) => {}
            Some(n) => out.push(format!("{path}: {n} is out of range {lo}..{hi}")),
            None => out.push(format!("{path}: must be a whole number from {lo} to {hi}")),
        },
        Kind::Float(lo, hi) => {
            let n = v.as_float().or_else(|| v.as_integer().map(|i| i as f64));
            match n {
                Some(n) if n >= lo && n <= hi => {}
                Some(n) => out.push(format!("{path}: {n:?} is out of range {lo:?}..{hi:?}")),
                None => out.push(format!("{path}: must be a number from {lo:?} to {hi:?}")),
            }
        }
        Kind::Enum(options) => match v.as_str() {
            Some(s) if options.contains(&s) => {}
            Some(s) => out.push(format!(
                "{path}: {s:?} is not one of {}",
                options.join(", ")
            )),
            None => out.push(format!("{path}: must be one of {}", options.join(", "))),
        },
        Kind::Font => match v.as_str() {
            Some(s) => {
                if let Err(e) = check_font(s) {
                    out.push(format!("{path}: {e}"));
                }
            }
            None => out.push(format!("{path}: must be a font stack string")),
        },
        Kind::Easing => match v.as_str() {
            Some(s) => {
                if let Err(e) = check_easing(s) {
                    out.push(format!("{path}: {e}"));
                }
            }
            None => out.push(format!("{path}: must be a CSS easing string")),
        },
        Kind::Bool => {
            if v.as_bool().is_none() {
                out.push(format!("{path}: must be true or false"));
            }
        }
    }
}

fn check_section(path: &str, section: &str, v: &Value, out: &mut Vec<String>) {
    let Some(t) = v.as_table() else {
        out.push(format!("{path}: must be a table"));
        return;
    };
    let known = fields(section);
    for (k, val) in t {
        if MODES.contains(&section) && CODE.contains(&k.as_str()) {
            check_section(&format!("{path}.{k}"), k, val, out);
            continue;
        }
        match known.iter().find(|(n, _)| n == k) {
            Some((_, kind)) => check_value(&format!("{path}.{k}"), val, *kind, out),
            None => out.push(format!("{path}.{k}: unknown key")),
        }
    }
}

/// Checks one theme file by itself: names, types, ranges, unknown keys.
pub fn check_doc(t: &Table, expected_name: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    match t.get("name") {
        None => out.push("name: missing".to_string()),
        Some(v) => match v.as_str() {
            Some(s) if !valid_name(s) => out.push(format!(
                "name: {s:?} must be lowercase letters, digits and hyphens (up to 48, not starting with a hyphen)"
            )),
            Some(s) => {
                if let Some(e) = expected_name {
                    if s != e {
                        out.push(format!("name: {s:?} must match the file name {e:?}"));
                    }
                }
            }
            None => out.push("name: must be a string".to_string()),
        },
    }
    for (k, v) in t {
        match k.as_str() {
            "name" => {}
            "title" => match v.as_str() {
                Some(s) if s.trim().is_empty() => out.push("title: must not be empty".into()),
                Some(s) if s.chars().any(char::is_control) => out.push(
                    "title: must not contain control characters (line breaks, tabs, escapes)"
                        .into(),
                ),
                Some(_) => {}
                None => out.push("title: must be a string".into()),
            },
            "description" => match v.as_str() {
                None => out.push("description: must be a string".into()),
                Some(s) if s.chars().any(char::is_control) => out.push(
                    "description: must not contain control characters (line breaks, tabs, escapes)"
                        .into(),
                ),
                Some(_) => {}
            },
            "extends" => match v.as_str() {
                Some(s) if valid_name(s) => {}
                Some(s) => out.push(format!("extends: {s:?} is not a valid theme name")),
                None => out.push("extends: must be a string".into()),
            },
            "light" | "dark" | "shape" | "type" | "motion" => check_section(k, k, v, &mut out),
            "surface" => match v.as_table() {
                None => out.push("surface: must be a table".into()),
                Some(st) => {
                    for (s, sv) in st {
                        if !SURFACES.contains(&s.as_str()) {
                            out.push(format!(
                                "surface.{s}: unknown surface (use {})",
                                SURFACES.join(", ")
                            ));
                            continue;
                        }
                        let Some(sec_t) = sv.as_table() else {
                            out.push(format!("surface.{s}: must be a table"));
                            continue;
                        };
                        for (sec, secv) in sec_t {
                            if SECTIONS.contains(&sec.as_str()) {
                                check_section(&format!("surface.{s}.{sec}"), sec, secv, &mut out);
                            } else {
                                out.push(format!("surface.{s}.{sec}: unknown key"));
                            }
                        }
                    }
                }
            },
            _ => out.push(format!("{k}: unknown key")),
        }
    }
    out
}
