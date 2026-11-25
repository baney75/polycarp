//! Which programs are running from inside a folder, read from the process list. Nothing is started to find out.

use std::ffi::OsStr;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

fn program(pid: i32) -> Option<PathBuf> {
    let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    let n = usize::try_from(n).ok().filter(|n| *n > 0)?;
    Some(OsStr::from_bytes(&path[..n]).into())
}

/// The processes whose program is inside `dir`. An error when the process list can't be read whole: a caller that must
/// not act on a running browser takes that as a refusal.
pub fn inside(dir: &Path) -> io::Result<Vec<i32>> {
    let Ok(dir) = dir.canonicalize() else {
        return Ok(Vec::new());
    };
    let mut room = 1024;
    loop {
        let mut pids = vec![0i32; room];
        let bytes = i32::try_from(pids.len() * size_of::<i32>()).map_err(io::Error::other)?;
        // SAFETY: the buffer holds `bytes` bytes.
        let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        let n = usize::try_from(n).ok().filter(|n| *n > 0);
        let n = n.ok_or_else(io::Error::last_os_error)?;
        // A full buffer may have been cut short: asked again with more room.
        if n >= pids.len() {
            room *= 2;
            continue;
        }
        pids.truncate(n);
        pids.retain(|pid| *pid > 0 && program(*pid).is_some_and(|p| p.starts_with(&dir)));
        return Ok(pids);
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::Fake;
    use super::*;

    #[test]
    fn a_program_is_found_by_where_it_runs_from() {
        let t = Fake::new();
        let dir = t.work();
        std::fs::create_dir_all(dir.join("Contents/MacOS")).unwrap();
        assert!(inside(&dir).unwrap().is_empty());
        let mut child = t.start_inside(&dir);
        assert_eq!(inside(&dir).unwrap(), [child.id() as i32]);
        assert!(inside(&dir.join("elsewhere")).unwrap().is_empty());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(inside(&dir).unwrap().is_empty());
    }
}
