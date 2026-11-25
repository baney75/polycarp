//! What Polycarp itself says of a look, asked of `polycarp-spaces` as `polycarp mcp` runs it.

use super::fields;
use super::format::Look;
use super::store;
use crate::mcp;
use crate::theme::{self, ApiErr, Ctx};
use serde_json::{json, Value as Json};
use std::path::{Path, PathBuf};

/// Pictures move through the paper store, which reads and writes them.
const LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// Runs `polycarp-spaces <argv> --json`: its data, or its refusal.
pub fn spaces(argv: &[&str]) -> Result<Json, ApiErr> {
    let argv: Vec<String> = argv.iter().map(|a| a.to_string()).collect();
    let probe = argv.iter().take(2).cloned().collect::<Vec<_>>().join(" ");
    let (mut env, ok) = mcp::spaces_run_within(argv, &probe, LIMIT);
    if ok {
        return Ok(env["data"].take());
    }
    Err(ApiErr::from_spaces(&env))
}

pub fn no_spaces(e: &ApiErr) -> bool {
    e.code() == "spaces_not_found"
}

/// Polycarp's own checks of a look's sheet and settings. Nothing is changed.
pub fn check(c: &Ctx, look: &Look) -> Result<(), ApiErr> {
    let work = Work::new(c)?;
    if let Some(Some(css)) = &look.style {
        let f = work.file("style.css", css.as_bytes())?;
        spaces(&["style", "check", &f])
            .map_err(|e| e.under("style", "the look's style sheet is refused"))?;
    }
    if let Some(s) = &look.surfaces {
        let mut t = fields::tree(s);
        t["version"] = json!(1);
        let f = work.file("surfaces.json", theme::pretty(&t).as_bytes())?;
        let d = spaces(&["surfaces", "validate", &f])
            .map_err(|e| e.under("surfaces", "the look's settings are refused"))?;
        let unknown: Vec<String> = d["warnings"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|w| {
                let (p, m) = (
                    w["path"].as_str().unwrap_or("$"),
                    w["message"].as_str().unwrap_or_default(),
                );
                format!("surfaces.{p}: {m}")
            })
            .collect();
        if !unknown.is_empty() {
            return Err(store::refused(
                "this Polycarp doesn't know all of the look's settings",
                &unknown,
            ));
        }
    }
    Ok(())
}

/// A folder of the person's alone for files handed to `polycarp-spaces`, gone when it is dropped.
pub struct Work(PathBuf);

impl Work {
    pub fn new(c: &Ctx) -> Result<Work, ApiErr> {
        let looks = store::dir(c);
        store::ensure(&looks)?;
        let d = looks.join(format!(".work-{}", std::process::id()));
        store::ensure(&d)?;
        Ok(Work(d))
    }
    pub fn file(&self, name: &str, bytes: &[u8]) -> Result<String, ApiErr> {
        let p: &Path = &self.0.join(name);
        store::write_plain(p, bytes)?;
        Ok(p.display().to_string())
    }
}

impl Drop for Work {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
