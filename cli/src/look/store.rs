//! Reading a look's file without following links.

use crate::theme::{self, ApiErr};
use std::fs;
use std::io::Read;
use std::path::Path;

fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

fn refuse_link(p: &Path) -> Result<(), ApiErr> {
    if is_link(p) {
        return Err(theme::io_err(format!(
            "{} is a symbolic link, and looks are not read through one",
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

/// A look that is not one, with every problem's path.
pub fn refused(what: &str, problems: &[String]) -> ApiErr {
    let mut e = ApiErr::problems(what, &super::format::plain(problems));
    e.recode("invalid_look");
    e.suggest(
        "Fix each path in `errors`. docs/looks.md in the Polycarp repo lists what a look may hold.",
    )
}
