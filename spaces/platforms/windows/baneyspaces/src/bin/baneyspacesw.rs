#![cfg_attr(windows, windows_subsystem = "windows")]
//! `baneyspacesw`: runs `baneyspaces.exe` (next to it) with the same arguments and no console window, waits for it
//! and exits with its code. `baneyspaces` is a console program, so anything that starts it without a console (the
//! sign-in entry, the installer) would flash one; this one is a windowed program that never opens a window.
//! The sign-in entry runs `baneyspacesw daemon --background`; the installer runs that after an install and
//! `baneyspacesw stop` before an uninstall or upgrade.

#[cfg(windows)]
fn main() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("baneyspaces.exe")));
    let Some(exe) = exe else {
        std::process::exit(1)
    };
    let code = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()
        .and_then(|s| s.code())
        .unwrap_or(1);
    std::process::exit(code);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("baneyspacesw: this build is not for Windows");
    std::process::exit(1);
}
