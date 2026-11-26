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

    /// The same look, whatever its theme is called.
    pub(crate) fn same_as(&self, other: &ThemeLook) -> bool {
        (&self.mode, &self.accent_light, &self.accent_dark)
            == (&other.mode, &other.accent_light, &other.accent_dark)
            && same_doc(&self.theme, &other.theme)
    }

    /// The theme's own title, or its name.
    pub(crate) fn theme_title(&self, c: &Ctx) -> String {
        self.swatches(c)
            .map_or_else(|| "a theme".into(), |(t, _)| t)
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

fn same_doc(a: &ThemeDoc, b: &ThemeDoc) -> bool {
    let plain = |t: &Table| {
        let mut t = t.clone();
        for k in ["name", "title", "description"] {
            t.remove(k);
        }
        t
    };
    match (a, b) {
        (ThemeDoc::Builtin(a), ThemeDoc::Builtin(b)) => a == b,
        (ThemeDoc::Document(a), ThemeDoc::Document(b)) => plain(a) == plain(b),
        _ => false,
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

/// A theme's file with everything it extends merged in, so it needs no other theme.
fn flatten(cfg: &Cfg, name: &str) -> Result<Table, String> {
    let mut chain = vec![load_raw(cfg, name)?];
    while let Some(ext) = chain.last().and_then(ext_of) {
        if chain.len() > MAX_DEPTH {
            return Err(format!("extends: more than {MAX_DEPTH} themes deep"));
        }
        chain.push(load_raw(cfg, &ext)?);
    }
    let mut merged = Table::new();
    for t in chain.iter().rev() {
        merge(&mut merged, t);
    }
    merged.remove("extends");
    Ok(merged)
}

fn doc_of(cfg: &Cfg, name: &str) -> Result<ThemeDoc, String> {
    Ok(match is_builtin(name) {
        true => ThemeDoc::Builtin(name.to_string()),
        false => ThemeDoc::Document(flatten(cfg, name)?),
    })
}

/// The theme in force as a look holds it. A theme that is off is still the one chosen.
pub(crate) fn capture(c: &Ctx) -> Result<(ThemeLook, Vec<String>), ApiErr> {
    let eff = effective(&c.cfg);
    require_healthy(&eff)?;
    let st = eff.state;
    let notes = match st.enabled {
        true => Vec::new(),
        false => vec![
            "the theme is off; the look holds the one chosen, and applying it turns the theme on"
                .into(),
        ],
    };
    let look = ThemeLook {
        theme: doc_of(&c.cfg, &st.theme).map_err(|e| bad_theme("the theme can't be read", &[e]))?,
        mode: st.mode,
        accent_light: st.accent_light,
        accent_dark: st.accent_dark,
    };
    Ok((look, notes))
}

/// What `polycarp look` adds to a refusal.
impl ApiErr {
    pub(crate) fn recode(&mut self, code: &'static str) {
        self.code = code;
    }

    /// A refusal `polycarp-spaces` gave.
    pub(crate) fn from_spaces(env: &Json) -> ApiErr {
        let e = &env["error"];
        let code = match e["code"].as_str() {
            Some("spaces_not_found") => "spaces_not_found",
            Some("spaces_too_old") => "spaces_too_old",
            Some("spaces_failed") => "spaces_failed",
            _ => "refused",
        };
        // It may quote the look it refuses.
        let plain = |s: &str| crate::look::plain(&[s.to_string()]).concat();
        let mut out = ApiErr::new(
            code,
            plain(e["message"].as_str().unwrap_or("polycarp-spaces refused")),
        );
        if let Some(s) = e["suggestion"].as_str().filter(|s| !s.is_empty()) {
            out = out.suggest(s);
        }
        if let Some(a) = e["data"]["errors"].as_array().filter(|a| !a.is_empty()) {
            out.items = a.clone();
            for i in &mut out.items {
                for k in ["path", "message"] {
                    if let Some(s) = i[k].as_str().map(plain) {
                        i[k] = json!(s);
                    }
                }
            }
        }
        out
    }

    /// The step of a look that failed, and whether what came before it was put back.
    pub(crate) fn step(mut self, step: &str, back: Result<(), String>) -> ApiErr {
        let why = std::mem::take(&mut self.message);
        (self.code, self.message) = match back {
            Ok(()) => (
                "step_failed",
                format!("the {step} step failed, so everything was put back: {why}"),
            ),
            Err(e) => (
                "stuck",
                format!("the {step} step failed ({why}), and putting things back failed too ({e})"),
            ),
        };
        for i in self
            .items
            .iter_mut()
            .filter(|i| i["path"].is_null() || i["path"] == json!("$"))
        {
            i["path"] = json!(step);
        }
        self
    }

    /// The refusal of one part of a look: its paths start with the part's name.
    pub(crate) fn under(mut self, part: &str, what: &str) -> ApiErr {
        if self.code != "refused" {
            return self;
        }
        for i in &mut self.items {
            let path = match i["path"].as_str() {
                None | Some("$") => part.to_string(),
                Some(p) => format!("{part}.{p}"),
            };
            i["path"] = json!(path);
        }
        self.lines = self
            .items
            .iter()
            .map(|i| {
                format!(
                    "{}: {}",
                    i["path"].as_str().unwrap_or(part),
                    i["message"].as_str().unwrap_or("refused")
                )
            })
            .collect();
        self.code = "invalid_look";
        self.message = what.to_string();
        self
    }
}

/// What a theme step did: whether it is in history, and what to tell the person.
pub(crate) struct Did {
    pub(crate) changed: bool,
    pub(crate) notes: Vec<String>,
}

fn did(out: Out, mut notes: Vec<String>) -> Did {
    let changed = out.data["changed"] != json!(false);
    notes.extend(out.warnings);
    notes.extend(out.notes.into_iter().filter(|_| changed));
    Did { changed, notes }
}

/// A user theme with the document's contents, or the name a new file for it takes.
fn place_for(c: &Ctx, doc: &Table, notes: &mut Vec<String>) -> (String, bool) {
    let name = doc
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("look")
        .to_string();
    let same = |n: &str| {
        flatten(&c.cfg, n)
            .is_ok_and(|t| same_doc(&ThemeDoc::Document(t), &ThemeDoc::Document(doc.clone())))
    };
    let free = |n: &str| !is_builtin(n) && c.cfg.theme_path(n).symlink_metadata().is_err();
    if free(&name) {
        return (name, true);
    }
    if same(&name) {
        return (name, false);
    }
    // The person's theme of that name is not this one, so it stays and the look's goes beside it.
    let stem: String = name.chars().take(40).collect();
    let (to, new) = (1..)
        .map(|i| {
            if i == 1 {
                format!("{stem}-look")
            } else {
                format!("{stem}-look-{i}")
            }
        })
        .find_map(|n| match free(&n) {
            true => Some((n, true)),
            false => same(&n).then_some((n, false)),
        })
        .unwrap_or((format!("{stem}-look"), true));
    notes.push(format!(
        "you have another theme named {name:?}, so the look's is {to:?}"
    ));
    (to, new)
}

/// Puts a look's theme, mode and accents in force as one change in theme history. The caller holds the lock.
pub(crate) fn apply(c: &Ctx, look: &ThemeLook, action: &str) -> Result<Did, ApiErr> {
    look.check(c)?;
    let mut notes = Vec::new();
    let (mut st, _) = load_state(&c.cfg);
    turn_on(&mut st, &mut notes);
    let (name, text) = match &look.theme {
        ThemeDoc::Builtin(n) => (n.clone(), None),
        ThemeDoc::Document(t) => {
            let (name, new) = place_for(c, t, &mut notes);
            let mut t = t.clone();
            t.insert("name".into(), Value::String(name.clone()));
            let text = toml::to_string(&t)
                .map_err(|e| io_err(format!("could not write the theme: {e}")))?;
            (name, new.then_some(text))
        }
    };
    st.theme = name.clone();
    st.mode = look.mode.clone();
    st.accent_light = look.accent_light.clone();
    st.accent_dark = look.accent_dark.clone();
    let file = text.as_deref().map(|t| (name.as_str(), Some(t)));
    let out = commit(c, Some(&st), action, file)?;
    Ok(did(out, notes))
}

/// Takes back the newest theme change, which the caller made under the lock it still holds.
pub(crate) fn rollback(c: &Ctx) -> Result<(), ApiErr> {
    undo_locked(c, true).map(|_| ())
}
