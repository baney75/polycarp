//! The look file, schema 1: what it may hold, reading one, and writing one (docs/looks.md).
//!
//! A look comes from anyone, so reading it is the safety check: it may change only how things look. Every key is
//! known or refused with its path.

use crate::theme::{self, ThemeDoc, ThemeLook};
use serde_json::{json, Map, Value as Json};

pub const EXT: &str = "polycarp-look";
pub const SCHEMA: i64 = 1;
/// The largest look file.
pub const MAX_BYTES: usize = 32 * 1024 * 1024;
/// The shipped look: everything as Polycarp comes.
pub const SHIPPED: &str = "polycarp";

/// One look.
#[derive(Clone, Debug, PartialEq)]
pub struct Look {
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    pub theme: ThemeLook,
}

impl Look {
    pub fn shipped() -> Look {
        Look {
            name: SHIPPED.into(),
            title: "Polycarp".into(),
            description: Some("Everything as Polycarp comes".into()),
            theme: ThemeLook {
                theme: ThemeDoc::Builtin(SHIPPED.into()),
                mode: "auto".into(),
                accent_light: None,
                accent_dark: None,
            },
        }
    }

    pub fn to_json(&self) -> Json {
        let mut o = Map::new();
        o.insert("schema".into(), json!(SCHEMA));
        o.insert("name".into(), json!(self.name));
        o.insert("title".into(), json!(self.title));
        if let Some(d) = &self.description {
            o.insert("description".into(), json!(d));
        }
        self.theme.put(&mut o);
        Json::Object(o)
    }

    pub fn to_text(&self) -> String {
        format!(
            "{}\n",
            serde_json::to_string_pretty(&self.to_json()).unwrap_or_default()
        )
    }

    /// Reads a look file. Problems are `path: why`, and any of them refuses the file.
    pub fn parse(bytes: &[u8]) -> Result<Look, Vec<String>> {
        if bytes.len() > MAX_BYTES {
            return Err(vec!["a look file is at most 32 MB".into()]);
        }
        let v: Json =
            serde_json::from_slice(bytes).map_err(|e| vec![format!("not a look file: {e}")])?;
        let Some(o) = v.as_object() else {
            return Err(vec!["a look must be a JSON object".into()]);
        };
        let mut bad = Vec::new();
        for k in o.keys() {
            if ![
                "schema",
                "name",
                "title",
                "description",
                "theme",
                "mode",
                "accent",
            ]
            .contains(&k.as_str())
            {
                bad.push(format!("{}: unknown key", shown(k)));
            }
        }
        if o.get("schema") != Some(&json!(SCHEMA)) {
            bad.push(format!(
                "schema: must be {SCHEMA}, the only one this Polycarp reads"
            ));
        }
        let name = match o.get("name").and_then(Json::as_str) {
            Some(n) if theme::valid_name(n) => n.to_string(),
            _ => {
                bad.push("name: must be lowercase letters, digits and hyphens (up to 48, not starting with a hyphen)".into());
                String::new()
            }
        };
        let title = text(o, "title", 80, &mut bad).unwrap_or_else(|| theme::title_case(&name));
        let description = text(o, "description", 400, &mut bad);
        let theme = ThemeLook::parse(o, &mut bad);
        match theme {
            Some(theme) if bad.is_empty() => Ok(Look {
                name,
                title,
                description,
                theme,
            }),
            _ => Err(bad),
        }
    }
}

/// One line of words, with no control characters. Absent and empty are the same.
fn text(o: &Map<String, Json>, key: &str, max: usize, bad: &mut Vec<String>) -> Option<String> {
    let s = match o.get(key)? {
        Json::String(s) => s.trim(),
        _ => {
            bad.push(format!("{key}: must be a string"));
            return None;
        }
    };
    if s.chars().count() > max || s.chars().any(char::is_control) {
        bad.push(format!(
            "{key}: must be one line of at most {max} characters"
        ));
        return None;
    }
    (!s.is_empty()).then(|| s.to_string())
}

/// A stranger's text made safe to print: no control characters, and short.
pub fn shown(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(80).collect()
}

/// Problems made safe to print, whole: a theme document's own keys are in them.
pub fn plain(problems: &[String]) -> Vec<String> {
    let line = |p: &String| p.chars().filter(|c| !c.is_control()).collect();
    problems.iter().map(line).collect()
}
