//! `polycarp look`: how Polycarp looks, as one file to share (docs/looks.md).

mod format;
mod store;

pub(crate) use format::shown;

use crate::theme::{self, exactly, ApiErr, Ctx, Out, Res};
use format::Look;
use serde_json::json;
use std::ffi::OsString;
use std::io::Read;
use std::path::Path;

pub const USAGE: &str = "\
usage: polycarp look <command> [--json]

  show <file|->                         check a look file, and say what it holds

A look is the theme, its mode and its accents. A look you were sent can change only how things look.
Docs: docs/looks.md in the Polycarp repo.
";

pub fn run(args: &[OsString]) -> i32 {
    theme::run_group("look", USAGE, args, |sub, rest| match sub {
        "show" => theme::cmd(rest, &[], &[], |c, p| {
            exactly(p, 1, "one look file, or -")?;
            op_show(c, &p.pos[0])
        }),
        other => Err(ApiErr::usage(format!("unknown command {other}"))),
    })
}

/// A look file's bytes, or standard input's for `-`.
fn input(arg: &str) -> Result<Vec<u8>, ApiErr> {
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

fn op_show(c: &Ctx, arg: &str) -> Res {
    let look =
        Look::parse(&input(arg)?).map_err(|ps| store::refused("the look is refused", &ps))?;
    look.theme.check(c)?;
    let mut text = format!("{} ({})\n", look.title, look.name);
    if let Some(d) = &look.description {
        text.push_str(&format!("{d}\n"));
    }
    let data = json!({
        "name": look.name,
        "title": look.title,
        "description": look.description,
        "theme": look.theme.theme_title(c),
        "mode": look.theme.mode,
        "colors": look.theme.swatches(c).map(|(_, j)| j),
    });
    text.push_str(&format!(
        "theme: {}, mode: {}\n",
        look.theme.theme_title(c),
        look.theme.mode
    ));
    Ok(Out::new(data, text))
}
