//! `polycarp files service install|uninstall|status`: a per-user unit that runs `polycarp files serve --watch`
//! (the server plus the watching index). Install and uninstall only write or remove the unit file and print the
//! one command that starts or stops it; they never load anything, need no admin rights and change no OS setting.

use super::config::Os;
use std::fs;
use std::path::{Path, PathBuf};

pub const LABEL: &str = "com.polycarp.files";
pub const SYSTEMD_UNIT: &str = "polycarp-files.service";
pub const TASK_NAME: &str = "Polycarp Files";

/// Where the unit file goes for this user.
pub fn unit_path(os: Os, home: &Path, local_app_data: Option<&Path>) -> PathBuf {
    match os {
        Os::Mac => home.join(format!("Library/LaunchAgents/{LABEL}.plist")),
        Os::Linux => home.join(".config/systemd/user").join(SYSTEMD_UNIT),
        Os::Windows => local_app_data
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Local"))
            .join("Polycarp")
            .join("files")
            .join("polycarp-files-task.xml"),
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn systemd_quote(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}

/// The unit's text. `exe` is the polycarp command it runs; `log` where launchd writes its output.
pub fn render(os: Os, exe: &Path, log: &Path, user: &str) -> String {
    let e = exe.to_string_lossy();
    match os {
        Os::Mac => format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>files</string>
    <string>serve</string>
    <string>--watch</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>{}</string>
  <key>StandardErrorPath</key><string>{}</string>
</dict>
</plist>
"#,
            xml_escape(&e),
            xml_escape(&log.to_string_lossy()),
            xml_escape(&log.to_string_lossy()),
        ),
        Os::Linux => format!(
            "[Unit]\nDescription=Polycarp Files: search and share your files with your own devices over Tailscale\nAfter=network-online.target tailscaled.service\n\n[Service]\nExecStart={} files serve --watch\nRestart=on-failure\nRestartSec=30\nNice=10\nIOSchedulingClass=idle\n\n[Install]\nWantedBy=default.target\n",
            systemd_quote(&e)
        ),
        Os::Windows => format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Polycarp Files: search and share your files with your own devices over Tailscale</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author"><Exec><Command>{}</Command><Arguments>files serve --watch</Arguments></Exec></Actions>
</Task>
"#,
            xml_escape(&e),
            user = xml_escape(user),
        ),
    }
}

/// The commands that start, stop and restart the unit, as text for a person or an agent to run.
pub fn start_cmd(os: Os, unit: &Path) -> String {
    match os {
        Os::Mac => format!("launchctl bootstrap gui/$(id -u) {}", unit.display()),
        Os::Linux => format!(
            "systemctl --user daemon-reload && systemctl --user enable --now {SYSTEMD_UNIT}"
        ),
        Os::Windows => format!(
            "schtasks /Create /TN \"{TASK_NAME}\" /XML \"{}\" && schtasks /Run /TN \"{TASK_NAME}\"",
            unit.display()
        ),
    }
}

pub fn stop_cmd(os: Os, unit: &Path) -> String {
    match os {
        Os::Mac => {
            let _ = unit;
            format!("launchctl bootout gui/$(id -u)/{LABEL}")
        }
        Os::Linux => format!("systemctl --user disable --now {SYSTEMD_UNIT}"),
        Os::Windows => {
            format!("schtasks /End /TN \"{TASK_NAME}\" && schtasks /Delete /TN \"{TASK_NAME}\" /F")
        }
    }
}

/// The program and arguments that restart a loaded unit (`fix` runs this, never a shell).
pub fn restart_argv(os: Os, uid: Option<u32>) -> Option<(PathBuf, Vec<String>)> {
    match os {
        Os::Mac => Some((
            PathBuf::from("/bin/launchctl"),
            vec![
                "kickstart".into(),
                "-k".into(),
                format!("gui/{}/{LABEL}", uid?),
            ],
        )),
        Os::Linux => Some((
            PathBuf::from("/usr/bin/systemctl"),
            vec!["--user".into(), "restart".into(), SYSTEMD_UNIT.into()],
        )),
        Os::Windows => {
            let root = std::env::var_os("SystemRoot")?;
            Some((
                PathBuf::from(root).join("System32").join("schtasks.exe"),
                vec!["/Run".into(), "/TN".into(), TASK_NAME.into()],
            ))
        }
    }
}

/// The program and arguments that ask whether the unit is loaded, read-only.
pub fn query_argv(os: Os, uid: Option<u32>) -> Option<(PathBuf, Vec<String>)> {
    match os {
        Os::Mac => Some((
            PathBuf::from("/bin/launchctl"),
            vec!["print".into(), format!("gui/{}/{LABEL}", uid?)],
        )),
        Os::Linux => Some((
            PathBuf::from("/usr/bin/systemctl"),
            vec!["--user".into(), "is-active".into(), SYSTEMD_UNIT.into()],
        )),
        Os::Windows => {
            let root = std::env::var_os("SystemRoot")?;
            Some((
                PathBuf::from(root).join("System32").join("schtasks.exe"),
                vec!["/Query".into(), "/TN".into(), TASK_NAME.into()],
            ))
        }
    }
}

#[cfg(unix)]
pub fn uid() -> Option<u32> {
    // SAFETY: getuid has no preconditions and cannot fail.
    Some(unsafe { libc::getuid() })
}

#[cfg(not(unix))]
pub fn uid() -> Option<u32> {
    None
}

/// Writes the unit. Windows wants the task file in UTF-16 with a byte order mark.
pub fn write_unit(os: Os, path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    let bytes: Vec<u8> = if os == Os::Windows {
        let mut b = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        b
    } else {
        text.as_bytes().to_vec()
    };
    fs::write(path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// The polycarp command a unit should run: the installed link where there is one, so an update needs no new unit.
pub fn service_exe() -> Option<PathBuf> {
    if !cfg!(windows) {
        if let Some(p) = crate::installed_polycarp() {
            return Some(p);
        }
    }
    std::env::current_exe().ok()
}

pub fn log_path(home: &Path) -> PathBuf {
    home.join("Library/Logs/polycarp-files.log")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_run_serve_with_watch_and_need_no_admin() {
        let exe = Path::new("/Users/d/.local/bin/polycarp");
        let log = Path::new("/Users/d/Library/Logs/polycarp-files.log");
        let mac = render(Os::Mac, exe, log, "d");
        assert!(mac.contains("<string>serve</string>") && mac.contains("<string>--watch</string>"));
        assert!(mac.contains(LABEL));
        let linux = render(
            Os::Linux,
            Path::new("/home/d/.local/bin/polycarp"),
            log,
            "d",
        );
        assert!(linux.contains("ExecStart=\"/home/d/.local/bin/polycarp\" files serve --watch"));
        assert!(linux.contains("WantedBy=default.target"));
        let win = render(
            Os::Windows,
            Path::new("C:\\Users\\d\\polycarp.exe"),
            log,
            "PC\\d & co",
        );
        assert!(win.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(win.contains("PC\\d &amp; co"));
        assert!(win.contains("<Arguments>files serve --watch</Arguments>"));
        for os in [Os::Mac, Os::Linux, Os::Windows] {
            let unit = unit_path(os, Path::new("/h"), None);
            for cmd in [start_cmd(os, &unit), stop_cmd(os, &unit)] {
                assert!(!cmd.contains("sudo"), "{cmd}");
            }
        }
    }

    #[test]
    fn the_unit_is_written_where_asked_and_windows_gets_utf16() {
        let d = std::env::temp_dir().join(format!("pc-files-unit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let p = unit_path(Os::Linux, &d, None);
        write_unit(Os::Linux, &p, "x").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "x");
        let w = d.join("task.xml");
        write_unit(Os::Windows, &w, "ab").unwrap();
        assert_eq!(fs::read(&w).unwrap(), vec![0xFF, 0xFE, b'a', 0, b'b', 0]);
        let _ = fs::remove_dir_all(&d);
    }
}
