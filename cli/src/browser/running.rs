//! Which programs are running from inside a folder, read from the process list. Nothing is started to find out.

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

fn program(pid: i32) -> Option<PathBuf> {
    let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    let n = usize::try_from(n).ok().filter(|n| *n > 0)?;
    Some(OsStr::from_bytes(&path[..n]).into())
}

/// The processes whose program is inside `dir`.
pub fn inside(dir: &Path) -> Vec<i32> {
    let Ok(dir) = dir.canonicalize() else {
        return Vec::new();
    };
    let room = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    let mut pids = vec![0i32; usize::try_from(room).unwrap_or(0) + 256];
    let bytes = (pids.len() * size_of::<i32>()) as i32;
    let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    pids.truncate(usize::try_from(n).unwrap_or(0));
    pids.retain(|pid| *pid > 0 && program(*pid).is_some_and(|p| p.starts_with(&dir)));
    pids
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
        assert!(inside(&dir).is_empty());
        let mut child = t.start_inside(&dir);
        assert_eq!(inside(&dir), [child.id() as i32]);
        assert!(inside(&dir.join("elsewhere")).is_empty());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(inside(&dir).is_empty());
    }
}
