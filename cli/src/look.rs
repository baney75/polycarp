//! `polycarp look`: how all of Polycarp looks, as one thing to save, share and put on (docs/looks.md).
//!
//! The same operations serve the command line and `polycarp mcp`.

mod fields;
mod format;
mod paper;
mod state;
mod store;

pub(crate) use format::{plain, shown};

use crate::theme::{self, exactly, first, ApiErr, Ctx, Out, Res};
use format::Look;
use serde_json::{json, Value as Json};
use state::Live;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const USAGE: &str = "\
usage: polycarp look <command> [--json]

  list                                  the shipped look and yours, and which is in force
  show <name|file|->                    what a look holds, and what it would change
  save <name> [--title T] [--force]     keep how everything looks now under a name
  apply <name|file|-> [--dry-run]       put a look on, all of it or none (--dry-run only says what would change)
  export <name> <file|-> [--force]      write a look to one file to share (<name>.polycarp-look)
  import <file|-> [--name N] [--force]  check someone's look and save it; nothing on screen changes

A look is the theme, mode, accents, style.css, the bar and other surfaces' looks, and the paper. A look you were
sent can change only how things look. Yours are in <config>/looks/. Docs: docs/looks.md in the Polycarp repo.
";

pub fn run(args: &[OsString]) -> i32 {
    theme::run_group("look", USAGE, args, |sub, rest| match sub {
        "list" => theme::cmd(rest, &[], &[], |c, p| {
            exactly(p, 0, "no arguments")?;
            op_list(c)
        }),
        "show" => theme::cmd(rest, &[], &[], |c, p| {
            exactly(p, 1, "one look name or file")?;
            op_show(c, &p.pos[0])
        }),
        "save" => theme::cmd(rest, &["title"], &["force"], |c, p| {
            exactly(p, 1, "one look name")?;
            op_save(c, &p.pos[0], p.val("title"), p.flag("force"))
        }),
        "apply" => theme::cmd(rest, &[], &["dry-run"], |c, p| {
            exactly(p, 1, "one look name or file")?;
            op_apply(c, &p.pos[0], p.flag("dry-run"))
        }),
        "export" => theme::cmd(rest, &[], &["force"], |c, p| {
            exactly(p, 2, "a look name, and a file or -")?;
            match p.pos[1].as_str() {
                "-" => op_text(c, &p.pos[0]),
                file => op_export(c, &p.pos[0], Path::new(file), p.flag("force")),
            }
        }),
        "import" => theme::cmd(rest, &["name"], &["force"], |c, p| {
            exactly(p, 1, "one look file, or -")?;
            op_import(
                c,
                &input(first(p).unwrap_or("-"))?,
                p.val("name"),
                p.flag("force"),
            )
        }),
        other => Err(ApiErr::usage(format!("unknown command {other}"))),
    })
}

/// A look file's bytes, or standard input's for `-`.
pub(crate) fn input(arg: &str) -> Result<Vec<u8>, ApiErr> {
    if arg != "-" {
        return store::read_plain(Path::new(arg), format::MAX_BYTES);
    }
    let mut out = Vec::new();
    std::io::stdin()
        .take(format::MAX_BYTES as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| theme::io_err(format!("could not read standard input: {e}")))?;
    Ok(out)
}

/// A name is a saved look's, `-` is standard input, and anything else is a file's path.
fn find(c: &Ctx, arg: &str) -> Result<(Look, Vec<String>), ApiErr> {
    let (mut look, notes) = match arg {
        "-" => parse(&input(arg)?)?,
        n if theme::valid_name(n) => store::load(c, n)?,
        file => store::read_look(Path::new(file))?,
    };
    if theme::valid_name(arg) {
        // The file's name is the look's: a file renamed by hand is called what it is listed as.
        look.name = arg.into();
    }
    look.theme.check(c)?;
    Ok((look, notes))
}

fn parse(bytes: &[u8]) -> Result<(Look, Vec<String>), ApiErr> {
    Look::parse(bytes).map_err(|ps| store::refused("the look is refused", &ps))
}

/// Where `find` read a look. What a look calls itself never says where it is.
fn place(c: &Ctx, arg: &str) -> (&'static str, Option<PathBuf>) {
    match arg {
        "-" => ("stdin", None),
        format::SHIPPED => ("shipped", None),
        n if theme::valid_name(n) => ("saved", Some(store::path(c, n))),
        file => (
            "file",
            Some(std::path::absolute(file).unwrap_or_else(|_| file.into())),
        ),
    }
}

/// The name of a look of the person's, which the shipped one's is not.
fn own_name(name: &str) -> Result<(), ApiErr> {
    if !theme::valid_name(name) {
        return Err(ApiErr::at(
            "invalid_look",
            "name",
            format!(
                "{:?} is not a look's name: use lowercase letters, digits and hyphens",
                shown(name)
            ),
        ));
    }
    if name == format::SHIPPED {
        return Err(ApiErr::at(
            "builtin_read_only",
            "name",
            "\"polycarp\" is the shipped look's name, so yours needs another",
        )
        .suggest("Pick another name."));
    }
    Ok(())
}

/// Whether a look of the person's has this name.
pub(crate) fn exists(c: &Ctx, name: &str) -> bool {
    theme::valid_name(name) && store::path(c, name).symlink_metadata().is_ok()
}

fn refuse_taken(c: &Ctx, name: &str, force: bool) -> Result<(), ApiErr> {
    if exists(c, name) && !force {
        return Err(ApiErr::at(
            "exists",
            "name",
            format!("you already have a look named {name:?}"),
        )
        .suggest("Pick another name, or pass force to replace it."));
    }
    Ok(())
}

/// What `list` and `show` say of the look `find` read for `arg`.
fn about(c: &Ctx, look: &Look, arg: &str, current: bool) -> Json {
    let (source, file) = place(c, arg);
    let t = &look.theme;
    let (theme, colors) = t.swatches(c).unzip();
    json!({
        "name": look.name,
        "title": look.title,
        "description": look.description,
        "source": source,
        "file": file.map(|f| f.display().to_string()),
        "current": current,
        "theme": theme,
        "mode": t.mode,
        "accent": {"light": t.accent_light, "dark": t.accent_dark},
        "colors": colors,
        "problems": [],
    })
}

pub(crate) fn op_list(c: &Ctx) -> Res {
    // A list is still a list when what is in force can't be read; nothing is marked then.
    let (now, warnings) = match state::now(c) {
        Ok(n) => (Some(n), Vec::new()),
        Err(e) => (
            None,
            vec![format!("what is in force can't be read: {}", e.message())],
        ),
    };
    let mut rows = Vec::new();
    let mut text = String::new();
    for name in std::iter::once(format::SHIPPED.to_string()).chain(store::names(c)) {
        match find(c, &name) {
            Ok((look, _)) => {
                let current = now.as_ref().is_some_and(|n| n.same_as(&look));
                let mark = if current { '*' } else { ' ' };
                text.push_str(&format!("{mark} {:<20} {}\n", look.name, look.title));
                rows.push(about(c, &look, &name, current));
            }
            Err(e) => {
                let problems = e.problem_list();
                text.push_str(&format!("  {name:<20} can't be used: {}\n", e.message()));
                for m in &problems {
                    text.push_str(&format!("    {m}\n"));
                }
                rows.push(json!({
                    "name": name, "title": theme::title_case(&name), "description": null, "source": "saved",
                    "file": store::path(c, &name).display().to_string(), "current": false, "colors": null,
                    "problems": problems,
                }));
            }
        }
    }
    let data = json!({
        "looks": rows, "folder": store::dir(c).display().to_string(),
    });
    Ok(warnings
        .into_iter()
        .fold(Out::new(data, text), Out::caution))
}

pub(crate) fn op_show(c: &Ctx, arg: &str) -> Res {
    let (look, mut notes) = find(c, arg)?;
    // What a look holds needs only the look; what it would change needs the present, which may not be readable.
    let (now, warnings) = match state::now(c) {
        Ok(n) => (Some(n), Vec::new()),
        Err(e) => (
            None,
            vec![format!("what is in force can't be read: {}", e.message())],
        ),
    };
    let changes = now.as_ref().map(|n| n.changes(c, &look));
    let mut text = format!("{} ({})\n", look.title, look.name);
    if let Some(d) = &look.description {
        text.push_str(&format!("{d}\n"));
    }
    let alone = leaves_alone(&look);
    let current = match (&now, &changes) {
        (Some(n), Some(ch)) => ch.is_empty() && n.same_as(&look),
        _ => false,
    };
    let mut data = about(c, &look, arg, current);
    text.push_str(&holds(&data));
    match &changes {
        None => text.push_str("what applying it would change can't be said now\n"),
        Some(ch) if ch.is_empty() => text.push_str("this is how everything looks now\n"),
        Some(ch) => text.push_str(&format!(
            "applying it would change:\n  {}\n",
            ch.join("\n  ")
        )),
    }
    if !alone.is_empty() {
        text.push_str(&format!("it leaves alone: {}\n", alone.join(", ")));
    }
    notes.extend(now.as_ref().and_then(left_for_spaces));
    data["changes"] = json!(changes);
    data["leaves_alone"] = json!(alone);
    Ok(warnings
        .into_iter()
        .fold(Out::new(data, text).noting(notes), Out::caution))
}

/// A look's theme, mode and accents, and where it was read, as lines.
fn holds(about: &Json) -> String {
    let word = |v: &Json| v.as_str().map(str::to_string);
    let mut line = format!(
        "theme: {}, mode: {}",
        word(&about["theme"]).unwrap_or_default(),
        word(&about["mode"]).unwrap_or_default()
    );
    for m in ["light", "dark"] {
        if let Some(a) = word(&about["accent"][m]) {
            line.push_str(&format!(", {m} accent: {a}"));
        }
    }
    let from = match (about["source"].as_str(), about["file"].as_str()) {
        (Some("shipped"), _) => "the look Polycarp ships with".to_string(),
        (_, Some(f)) => format!("read from {f}"),
        _ => "read from standard input".to_string(),
    };
    format!("{line}\n{from}\n")
}

/// The parts a look doesn't have, which applying it leaves as they are.
fn leaves_alone(look: &Look) -> Vec<&'static str> {
    let has = [
        (look.style.is_some(), "style"),
        (look.surfaces.is_some(), "surfaces"),
        (look.paper.is_some(), "paper"),
    ];
    has.iter().filter(|(h, _)| !h).map(|(_, n)| *n).collect()
}

fn left_for_spaces(now: &state::Now) -> Option<String> {
    now.live.is_none().then(|| {
        "Polycarp Spaces isn't installed here, so this is about the theme; the style sheet, surfaces and paper wait for it".into()
    })
}

pub(crate) fn op_save(c: &Ctx, name: &str, title: Option<&str>, force: bool) -> Res {
    own_name(name)?;
    let _held = theme::hold(c)?;
    refuse_taken(c, name, force)?;
    let now = state::now(c)?;
    let mut notes = now.notes.clone();
    // Saving over a look keeps what it is called unless a new title comes with it.
    let was = store::read_look(&store::path(c, name)).ok().map(|(l, _)| l);
    let title = match (title, &was) {
        (Some(t), _) => t.to_string(),
        (None, Some(w)) => w.title.clone(),
        (None, None) => theme::title_case(name),
    };
    let mut look = Look {
        name: name.into(),
        title,
        description: was.and_then(|w| w.description),
        theme: now.theme.clone(),
        style: None,
        surfaces: None,
        paper: None,
        pictures: Default::default(),
    };
    match &now.live {
        Some(live) => {
            look.style = Some(live.style.clone());
            let s = live.look_surfaces(&mut notes);
            look.surfaces =
                Some(s.map_err(|p| store::refused("a setting can't go in a look", &[p]))?);
            look.paper = Some(live.paper.clone());
            look.pictures = live.pictures.clone();
            state::check(c, &look)?;
        }
        None => notes
            .push("Polycarp Spaces isn't installed here, so the look holds the theme alone".into()),
    }
    // Checked as `find` checks it, so what is saved can be read back.
    look.theme.check(c)?;
    keep(c, &look, "saved", notes)
}

/// Writes a look to the looks folder, read back first as anyone else would read it.
fn keep(c: &Ctx, look: &Look, did: &str, notes: Vec<String>) -> Res {
    let text = look.to_text();
    Look::parse(text.as_bytes()).map_err(|ps| store::refused("the look can't be saved", &ps))?;
    store::ensure(&store::dir(c))?;
    let p = store::path(c, &look.name);
    let replaced = exists(c, &look.name);
    store::write_plain(&p, text.as_bytes())?;
    let mut data = about(c, look, &look.name, false);
    // Which look is in force is `list`'s and `show`'s to say.
    if let Some(o) = data.as_object_mut() {
        o.remove("current");
    }
    data["replaced"] = json!(replaced);
    let line = format!("{did} the look {} in {}\n", look.name, p.display());
    Ok(Out::new(data, line).noting(notes))
}

/// The look's file as text, for `export -`.
pub(crate) fn op_text(c: &Ctx, name: &str) -> Res {
    let (look, notes) = find(c, name)?;
    Ok(Out::new(
        json!({"name": look.name, "look": look.to_json()}),
        look.to_text(),
    )
    .noting(notes))
}

pub(crate) fn op_export(c: &Ctx, name: &str, file: &Path, force: bool) -> Res {
    let (look, notes) = find(c, name)?;
    if file.extension().and_then(|e| e.to_str()) != Some(format::EXT) {
        return Err(ApiErr::usage(format!(
            "the file's name must end in .{}, such as {}.{}",
            format::EXT,
            look.name,
            format::EXT
        )));
    }
    if file.symlink_metadata().is_ok() && !force {
        return Err(ApiErr::at(
            "exists",
            "file",
            format!("{} is already there", file.display()),
        )
        .suggest("Pick another file, or pass --force to replace it."));
    }
    store::write_plain(file, look.to_text().as_bytes())?;
    let full = std::fs::canonicalize(file).unwrap_or_else(|_| PathBuf::from(file));
    let data = json!({"name": look.name, "file": full.display().to_string()});
    Ok(Out::new(
        data,
        format!("exported {} to {}\n", look.name, full.display()),
    )
    .noting(notes))
}

pub(crate) fn op_import(c: &Ctx, bytes: &[u8], name: Option<&str>, force: bool) -> Res {
    let (mut look, mut notes) = parse(bytes)?;
    if let Some(n) = name {
        look.name = n.into();
    }
    own_name(&look.name)?;
    look.theme.check(c)?;
    let _held = theme::hold(c)?;
    refuse_taken(c, &look.name, force)?;
    match state::check(c, &look) {
        Err(e) if state::no_spaces(&e) => notes.push(
            "Polycarp Spaces isn't installed here, so the style sheet and settings were not checked; they are when the look is applied".into(),
        ),
        r => r?,
    }
    keep(c, &look, "imported", notes)
}

/// Runs the theme step, then the surfaces. A step that fails puts back what came before it, and is named.
fn change(
    c: &Ctx,
    was: Option<&Live>,
    theme_step: impl FnOnce() -> Result<theme::Did, ApiErr>,
    to: Option<&Live>,
) -> Result<theme::Did, ApiErr> {
    let did = theme_step().map_err(|e| e.step("theme", Ok(())))?;
    let (Some(now), Some(to)) = (was, to) else {
        return Ok(did);
    };
    let saved: Vec<Look> = store::names(c)
        .iter()
        .filter_map(|n| store::load(c, n).ok().map(|(l, _)| l))
        .collect();
    let Err((step, e)) = state::put(c, now, to, Some(&saved)) else {
        return Ok(did);
    };
    let surfaces = state::read()
        .and_then(|l| l.ok_or_else(|| theme::io_err("polycarp-spaces is gone".into())))
        .map_err(|e| e.message().to_string())
        .and_then(|l| {
            state::put(c, &l, now, None).map_err(|(s, e)| format!("{s}: {}", e.message()))
        });
    let theme = match did.changed {
        true => theme::rollback(c).map_err(|e| format!("theme: {}", e.message())),
        false => Ok(()),
    };
    Err((*e).step(step, surfaces.and(theme)))
}

pub(crate) fn op_apply(c: &Ctx, arg: &str, dry_run: bool) -> Res {
    // Read before the lock: standard input can take its time, and no theme change should wait for it.
    let (look, mut notes) = find(c, arg)?;
    let _held = theme::hold(c)?;
    let now = state::now(c)?;
    if now.live.is_some() {
        state::check(c, &look)?;
    }
    let changes = now.changes(c, &look);
    let data = json!({
        "name": look.name, "title": look.title, "changes": changes, "dry_run": dry_run,
        "changed": !dry_run && !changes.is_empty(),
    });
    notes.extend(left_for_spaces(&now));
    let list = match changes.is_empty() {
        true => "nothing to change: that is already how everything looks\n".to_string(),
        false => format!("  {}\n", changes.join("\n  ")),
    };
    if dry_run || changes.is_empty() {
        let lead = if changes.is_empty() {
            ""
        } else {
            "applying it would change:\n"
        };
        return Ok(Out::new(data, format!("{lead}{list}")).noting(notes));
    }
    let to = now.live.as_ref().map(|l| l.with(&look));
    let step = || theme::apply(c, &look.theme, &format!("look apply {}", look.name));
    let did = change(c, now.live.as_ref(), step, to.as_ref())?;
    notes.extend(did.notes);
    let text = format!("applied {}\n{list}", look.name);
    Ok(Out::new(data, text).noting(notes))
}
