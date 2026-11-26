//! Where looks are kept: `<config>/looks/<name>.polycarp-look`, and reading and writing them without following links.

use super::format::{self, Look};
use crate::theme::{self, ApiErr, Ctx};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub fn dir(c: &Ctx) -> PathBuf {
    c.dir().join("looks")
}

pub fn path(c: &Ctx, name: &str) -> PathBuf {
    dir(c).join(format!("{name}.{}", format::EXT))
}

fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

pub fn refuse_link(p: &Path) -> Result<(), ApiErr> {
    if is_link(p) {
        return Err(theme::io_err(format!(
            "{} is a symbolic link, and looks are not read or written through one",
            p.display()
        )));
    }
    Ok(())
}

/// A file's bytes: a plain file, no link, no more than `limit`.
pub fn read_plain(p: &Path, limit: usize) -> Result<Vec<u8>, ApiErr> {
    let fail = |e: std::io::Error| theme::io_err(format!("could not read {}: {e}", p.display()));
    refuse_link(p)?;
    let mut open = fs::OpenOptions::new();
    open.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Never a link swapped in since the check above, and never a wait on a pipe.
        open.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = open.open(p).map_err(fail)?;
    if !file.metadata().map_err(fail)?.is_file() {
        return Err(theme::io_err(format!("{} is not a file", p.display())));
    }
    let mut out = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut out)
        .map_err(fail)?;
    if out.len() > limit {
        return Err(theme::io_err(format!(
            "{} is over {} MB",
            p.display(),
            limit / (1024 * 1024)
        )));
    }
    Ok(out)
}

/// Writes a file whole, over nothing but a plain file.
pub fn write_plain(p: &Path, bytes: &[u8]) -> Result<(), ApiErr> {
    refuse_link(p)?;
    if p.is_dir() {
        return Err(theme::io_err(format!("{} is a folder", p.display())));
    }
    theme::write_atomic(p, bytes).map_err(theme::io_err)
}

/// Makes the looks folder, the person's alone.
pub fn ensure(dir: &Path) -> Result<(), ApiErr> {
    refuse_link(dir)?;
    theme::private_dir(dir).map_err(theme::io_err)
}

/// The saved looks' names, in order. A file with a name that is no look's is not one.
pub fn names(c: &Ctx) -> Vec<String> {
    let d = dir(c);
    if is_link(&d) {
        return Vec::new();
    }
    let suffix = format!(".{}", format::EXT);
    let mut out: Vec<String> = fs::read_dir(d)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            e.file_name()
                .to_str()?
                .strip_suffix(&suffix)
                .map(str::to_string)
        })
        .filter(|n| theme::valid_name(n) && n != format::SHIPPED)
        .collect();
    out.sort();
    out
}

/// A saved look, or the shipped one.
pub fn load(c: &Ctx, name: &str) -> Result<(Look, Vec<String>), ApiErr> {
    if name == format::SHIPPED {
        return Ok((Look::shipped(), Vec::new()));
    }
    if !names(c).iter().any(|n| n == name) {
        return Err(ApiErr::at("unknown_look", "name", format!("no look named {name:?}"))
            .suggest("Run `polycarp look list` for the names you can use. A file is named by its path, such as ./evening.polycarp-look."));
    }
    read_look(&path(c, name))
}

pub fn read_look(p: &Path) -> Result<(Look, Vec<String>), ApiErr> {
    let bytes = read_plain(p, format::MAX_BYTES)?;
    Look::parse(&bytes).map_err(|ps| refused(&format!("{} is refused", p.display()), &ps))
}

/// A look that is not one, with every problem's path.
pub fn refused(what: &str, problems: &[String]) -> ApiErr {
    let mut e = ApiErr::problems(what, &super::format::plain(problems));
    e.recode("invalid_look");
    e.suggest(
        "Fix each path in `errors`. docs/looks.md in the Polycarp repo lists what a look may hold.",
    )
}
