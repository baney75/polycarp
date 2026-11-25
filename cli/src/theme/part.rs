//! The theme's part of a look (`crate::look`): which theme, whole in itself, with its mode and accents.

use super::*;
use serde_json::Map;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ThemeDoc {
    Builtin(String),
    /// A whole theme that extends nothing.
    Document(Table),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ThemeLook {
    pub(crate) theme: ThemeDoc,
    pub(crate) mode: String,
    pub(crate) accent_light: Option<String>,
    pub(crate) accent_dark: Option<String>,
}

impl ThemeLook {
    /// Reads `theme`, `mode` and `accent` of a look file. Whether the theme is any good is `check`.
    pub(crate) fn parse(o: &Map<String, Json>, bad: &mut Vec<String>) -> Option<ThemeLook> {
        let theme = match o
            .get("theme")
            .and_then(Json::as_object)
            .filter(|t| t.len() == 1)
        {
            Some(t) => match (t.get("builtin").and_then(Json::as_str), t.get("document")) {
                (Some(n), _) if is_builtin(n) => Some(ThemeDoc::Builtin(n.to_string())),
                (Some(_), _) => {
                    bad.push("theme.builtin: not a built-in theme".into());
                    None
                }
                (_, Some(d @ Json::Object(_))) => match json_to_toml(d, "") {
                    Ok(Value::Table(t)) => Some(ThemeDoc::Document(t)),
                    Ok(_) => None,
                    Err(e) => {
                        bad.push(format!("theme.document.{e}"));
                        None
                    }
                },
                _ => {
                    bad.push("theme: must be {\"builtin\": name} or {\"document\": theme}".into());
                    None
                }
            },
            None => {
                bad.push("theme: must be {\"builtin\": name} or {\"document\": theme}".into());
                None
            }
        };
        let mode = match o.get("mode") {
            None => "auto".to_string(),
            Some(Json::String(m)) if mode_ok(m) => m.clone(),
            Some(_) => {
                bad.push("mode: must be auto, light or dark".into());
                return None;
            }
        };
        let mut accents = BTreeMap::new();
        match o.get("accent") {
            None => {}
            Some(Json::Object(a)) => {
                for (k, v) in a {
                    match v.as_str() {
                        _ if !MODES.contains(&k.as_str()) => bad.push(format!(
                            "accent.{}: unknown key (use light or dark)",
                            crate::look::shown(k)
                        )),
                        Some(s) if is_hex(s) => {
                            accents.insert(k.clone(), s.to_lowercase());
                        }
                        _ => bad.push(format!("accent.{k}: must be a color like \"#rrggbb\"")),
                    }
                }
            }
            Some(_) => bad.push("accent: must be an object with light, dark or both".into()),
        }
        Some(ThemeLook {
            theme: theme?,
            mode,
            accent_light: accents.remove("light"),
            accent_dark: accents.remove("dark"),
        })
    }

    /// Writes the keys `parse` reads.
    pub(crate) fn put(&self, o: &mut Map<String, Json>) {
        let theme = match &self.theme {
            ThemeDoc::Builtin(n) => json!({ "builtin": n }),
            ThemeDoc::Document(t) => json!({ "document": t }),
        };
        o.insert("theme".into(), theme);
        o.insert("mode".into(), json!(self.mode));
        let mut a = Map::new();
        for (k, v) in [("light", &self.accent_light), ("dark", &self.accent_dark)] {
            if let Some(v) = v {
                a.insert(k.into(), json!(v));
            }
        }
        if !a.is_empty() {
            o.insert("accent".into(), Json::Object(a));
        }
    }

    /// The theme resolved with its accents, held to every rule a theme is. A document must be whole in itself.
    fn full(&self, cfg: &Cfg) -> Result<Full, Vec<String>> {
        let full = match &self.theme {
            ThemeDoc::Builtin(n) => resolve_name(cfg, n)?,
            ThemeDoc::Document(t) => {
                let name = t.get("name").and_then(Value::as_str).unwrap_or_default();
                let mut first = Vec::new();
                if t.contains_key("extends") {
                    first.push(
                        "extends: a look's theme is whole, so it extends nothing".to_string(),
                    );
                }
                if is_builtin(name) {
                    first.push(format!("name: {name:?} is a built-in theme's name"));
                }
                let within = |ps: Vec<String>| {
                    ps.into_iter()
                        .map(|p| match p.split_once(": ") {
                            Some((head, _)) if path_like(head) => format!("theme.document.{p}"),
                            _ => p,
                        })
                        .collect::<Vec<_>>()
                };
                if !first.is_empty() {
                    return Err(within(first));
                }
                resolve_doc(cfg, t.clone(), None).map_err(within)?
            }
        };
        apply_accents(
            &full,
            self.accent_light.as_deref(),
            self.accent_dark.as_deref(),
        )
    }

    pub(crate) fn check(&self, c: &Ctx) -> Result<(), ApiErr> {
        self.full(&c.cfg)
            .map(|_| ())
            .map_err(|ps| bad_theme("the look's theme is refused", &crate::look::plain(&ps)))
    }

    /// The theme's title and the few colors a picker shows, in each mode.
    pub(crate) fn swatches(&self, c: &Ctx) -> Option<(String, Json)> {
        let full = self.full(&c.cfg).ok()?;
        let of = |mode: &str| {
            let colors = full.base.colors(mode);
            let mut o = Map::new();
            for r in ["background", "surface", "foreground", "accent"] {
                o.insert(r.into(), json!(colors.get(r)));
            }
            Json::Object(o)
        };
        Some((
            full.title.clone(),
            json!({"light": of("light"), "dark": of("dark")}),
        ))
    }
}

/// Where the theme's files are; looks are kept beside them.
impl Ctx {
    pub(crate) fn dir(&self) -> &Path {
        &self.cfg.dir
    }
}

/// The lock every theme change takes, held for a whole look.
pub(crate) struct Held(#[allow(dead_code)] Lock);

pub(crate) fn hold(c: &Ctx) -> Result<Held, ApiErr> {
    Lock::acquire(&c.cfg).map(Held)
}

/// What `polycarp look` adds to a refusal.
impl ApiErr {
    pub(crate) fn recode(&mut self, code: &'static str) {
        self.code = code;
    }
}
