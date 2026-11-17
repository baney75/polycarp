//! What products read: the CSS for one surface and `theme.json`.

use super::{Full, Resolved, State, MODES, ROLES, SURFACES};
use serde_json::{json, Value as Json};

/// The shape of `theme.json`. It goes up by one whenever the shape changes; readers ignore
/// fields they don't know.
pub const SCHEMA: u32 = 2;

fn num(f: f64) -> String {
    format!("{f}")
}

pub fn shared_vars(r: &Resolved) -> Vec<(String, String)> {
    let px = |n: i64| format!("{n}px");
    let ms = |n: i64| format!("{n}ms");
    vec![
        ("radius-small".into(), px(r.shape.radius_small)),
        ("radius".into(), px(r.shape.radius)),
        ("radius-large".into(), px(r.shape.radius_large)),
        ("border-width".into(), px(r.shape.border_width)),
        ("blur".into(), px(r.shape.blur)),
        ("shadow".into(), num(r.shape.shadow)),
        ("density".into(), r.shape.density.clone()),
        ("indicator".into(), r.shape.indicator.clone()),
        ("font-display".into(), r.typ.display.clone()),
        ("font-ui".into(), r.typ.ui.clone()),
        ("font-mono".into(), r.typ.mono.clone()),
        ("font-size".into(), px(r.typ.size)),
        ("font-weight".into(), r.typ.weight.to_string()),
        ("line-height".into(), num(r.typ.line_height)),
        ("motion-fast".into(), ms(r.motion.fast)),
        ("motion-normal".into(), ms(r.motion.normal)),
        ("motion-slow".into(), ms(r.motion.slow)),
        ("motion-easing".into(), r.motion.easing.clone()),
        ("motion-scale-from".into(), num(r.motion.scale_from)),
    ]
}

pub fn color_lines(r: &Resolved, mode: &str, indent: &str) -> String {
    let mut s = String::new();
    let c = r.colors(mode);
    for role in ROLES {
        if let Some(v) = c.get(role) {
            s.push_str(&format!("{indent}--pc-{}: {v};\n", role.replace('_', "-")));
        }
    }
    s
}

/// CSS for one surface. `forced` is a fixed mode ("light" or "dark"); None follows the system.
pub fn css(full: &Full, surface: Option<&str>, forced: Option<&str>) -> String {
    let r = match surface {
        Some(s) => full.surface(s),
        None => &full.base,
    }
    .exported();
    let mut s = format!(
        "/* Polycarp theme \"{}\", {}. Written by `polycarp theme`; do not edit. */\n",
        full.name,
        surface.map_or("no surface overrides".to_string(), |x| format!(
            "surface \"{x}\""
        ))
    );
    s.push_str(":root {\n");
    s.push_str(&format!(
        "  color-scheme: {};\n",
        forced.unwrap_or("light dark")
    ));
    for (k, v) in shared_vars(&r) {
        s.push_str(&format!("  --pc-{k}: {v};\n"));
    }
    s.push_str(&color_lines(&r, forced.unwrap_or("light"), "  "));
    s.push_str("}\n");
    for mode in MODES {
        s.push_str(&format!(
            ":root[data-theme-mode=\"{mode}\"] {{\n  color-scheme: {mode};\n{}}}\n",
            color_lines(&r, mode, "  ")
        ));
    }
    if forced.is_none() {
        s.push_str("@media (prefers-color-scheme: dark) {\n  :root:not([data-theme-mode=\"light\"]) {\n    color-scheme: dark;\n");
        s.push_str(&color_lines(&r, "dark", "    "));
        s.push_str("  }\n}\n");
    }
    s
}

/// A resolved theme as JSON, with every code color (set or derived) inside `light` and `dark`.
pub fn json_of(r: &Resolved) -> Json {
    let mut v = serde_json::to_value(r).unwrap_or(Json::Null);
    for m in MODES {
        if let Some(o) = v.get_mut(m).and_then(Json::as_object_mut) {
            for (group, colors) in r.code(m) {
                o.insert(group, json!(colors));
            }
        }
    }
    v
}

/// What products read: `json_of` after `reduced` motion is applied.
pub fn resolved_json(r: &Resolved) -> Json {
    json_of(&r.exported())
}

pub fn theme_json(full: &Full, state: Option<&State>) -> Json {
    let mut surfaces = serde_json::Map::new();
    for s in SURFACES {
        surfaces.insert(s.to_string(), resolved_json(full.surface(s)));
    }
    let mut v = json!({
        "schema": SCHEMA,
        "name": full.name,
        "title": full.title,
        "description": full.description,
        "surfaces": surfaces,
    });
    if let (Some(st), Some(o)) = (state, v.as_object_mut()) {
        o.insert("mode".into(), json!(st.mode));
        o.insert("accent_light".into(), json!(st.accent_light));
        o.insert("accent_dark".into(), json!(st.accent_dark));
    }
    v
}
