//! `polycarp look`: how all of Polycarp looks, as one thing to save, share and put on (docs/looks.md).
//!
//! The same operations serve the command line and `polycarp mcp`.

mod format;
mod store;

pub(crate) use format::{plain, shown};

use crate::theme::{self, exactly, first, ApiErr, Ctx, Out, Res};
use format::Look;
use serde_json::{json, Value as Json};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const USAGE: &str = "\
usage: polycarp look <command> [--json]

  list                                  the shipped look and yours
  show <name|file>                      what a look holds
  export <name> <file|-> [--force]      write a look to one file to share (<name>.polycarp-look)
  import <file|-> [--name N] [--force]  check someone's look and save it; nothing on screen changes

A look is the theme, its mode and its accents. A look you were sent can change only how things look. Yours are in <config>/looks/. Docs: docs/looks.md in the Polycarp repo.
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

/// A name is a saved look's; anything else is a file's path.
fn find(c: &Ctx, arg: &str) -> Result<Look, ApiErr> {
    let look = match theme::valid_name(arg) {
        true => store::load(c, arg)?,
        false => store::read_look(Path::new(arg))?,
    };
    look.theme.check(c)?;
    Ok(look)
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

/// What `list` and `show` say of a look.
fn about(c: &Ctx, look: &Look) -> Json {
    let saved = store::path(c, &look.name);
    json!({
        "name": look.name,
        "title": look.title,
        "description": look.description,
        "source": if look.name == format::SHIPPED { "shipped" } else { "saved" },
        "file": (look.name != format::SHIPPED).then(|| saved.display().to_string()),
        "colors": look.theme.swatches(c).map(|(_, j)| j),
        "problems": [],
    })
}

pub(crate) fn op_list(c: &Ctx) -> Res {
    let mut rows = Vec::new();
    let mut text = String::new();
    for name in std::iter::once(format::SHIPPED.to_string()).chain(store::names(c)) {
        match find(c, &name) {
            Ok(mut look) => {
                // The file's name is the look's: a file renamed by hand still lists and applies.
                look.name = name;
                text.push_str(&format!("  {:<20} {}\n", look.name, look.title));
                rows.push(about(c, &look));
            }
            Err(e) => {
                text.push_str(&format!("  {name:<20} can't be used: {}\n", e.message()));
                rows.push(json!({
                    "name": name, "title": theme::title_case(&name), "description": null, "source": "saved",
                    "file": store::path(c, &name).display().to_string(), "colors": null,
                    "problems": e.problem_list(),
                }));
            }
        }
    }
    let data = json!({
        "looks": rows, "folder": store::dir(c).display().to_string(),
    });
    Ok(Out::new(data, text))
}

pub(crate) fn op_show(c: &Ctx, arg: &str) -> Res {
    let look = find(c, arg)?;
    let mut text = format!("{} ({})\n", look.title, look.name);
    if let Some(d) = &look.description {
        text.push_str(&format!("{d}\n"));
    }
    Ok(Out::new(about(c, &look), text))
}

/// Writes a look to the looks folder, read back first as anyone else would read it.
fn keep(c: &Ctx, look: &Look, did: &str) -> Res {
    let text = look.to_text();
    Look::parse(text.as_bytes()).map_err(|ps| store::refused("the look can't be saved", &ps))?;
    store::ensure(&store::dir(c))?;
    let p = store::path(c, &look.name);
    let replaced = exists(c, &look.name);
    store::write_plain(&p, text.as_bytes())?;
    let mut data = about(c, look);
    data["replaced"] = json!(replaced);
    let line = format!("{did} the look {} in {}\n", look.name, p.display());
    Ok(Out::new(data, line))
}

/// The look's file as text, for `export -`.
pub(crate) fn op_text(c: &Ctx, name: &str) -> Res {
    let look = find(c, name)?;
    Ok(Out::new(
        json!({"name": look.name, "look": look.to_json()}),
        look.to_text(),
    ))
}

pub(crate) fn op_export(c: &Ctx, name: &str, file: &Path, force: bool) -> Res {
    let look = find(c, name)?;
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
    ))
}

pub(crate) fn op_import(c: &Ctx, bytes: &[u8], name: Option<&str>, force: bool) -> Res {
    let mut look = Look::parse(bytes).map_err(|ps| store::refused("the look is refused", &ps))?;
    if let Some(n) = name {
        look.name = n.into();
    }
    own_name(&look.name)?;
    look.theme.check(c)?;
    let _held = theme::hold(c)?;
    refuse_taken(c, &look.name, force)?;
    keep(c, &look, "imported")
}
