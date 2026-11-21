//! `polycarp agent service install|uninstall|status [--tunnel]`: per-user units that keep the gateway (and the
//! tunnel, when there is one) running: a launchd agent on the Mac, a systemd user unit on Linux, a Scheduled Task on
//! Windows. Like `files service`, install and uninstall only write or remove the unit and print the one command that
//! starts or stops it; they never load anything, need no admin rights and change no OS setting.

use crate::files::config::Os;
use crate::files::service::{systemd_quote, xml_escape};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    /// `polycarp agent serve`.
    Gateway,
    /// `polycarp agent tunnel run`.
    Tunnel,
}

impl Unit {
    pub fn label(self) -> &'static str {
        match self {
            Unit::Gateway => "com.polycarp.agent",
            Unit::Tunnel => "com.polycarp.agent-tunnel",
        }
    }
    pub fn systemd(self) -> &'static str {
        match self {
            Unit::Gateway => "polycarp-agent.service",
            Unit::Tunnel => "polycarp-agent-tunnel.service",
        }
    }
    pub fn task(self) -> &'static str {
        match self {
            Unit::Gateway => "Polycarp Agent",
            Unit::Tunnel => "Polycarp Agent Tunnel",
        }
    }
    fn description(self) -> &'static str {
        match self {
            Unit::Gateway => "Polycarp agent gateway: one MCP endpoint for your assistants",
            Unit::Tunnel => {
                "Polycarp agent tunnel: your own cloudflared, to the gateway on loopback"
            }
        }
    }
    /// What the unit runs after the polycarp command.
    pub fn args(self, tailnet: bool) -> Vec<&'static str> {
        match self {
            Unit::Gateway if tailnet => vec!["agent", "serve", "--tailnet"],
            Unit::Gateway => vec!["agent", "serve"],
            Unit::Tunnel => vec!["agent", "tunnel", "run"],
        }
    }
    pub fn log_name(self) -> &'static str {
        match self {
            Unit::Gateway => "polycarp-agent.log",
            Unit::Tunnel => "polycarp-agent-tunnel.log",
        }
    }
}

pub fn unit_path(unit: Unit, os: Os, home: &Path, local_app_data: Option<&Path>) -> PathBuf {
    match os {
        Os::Mac => home.join(format!("Library/LaunchAgents/{}.plist", unit.label())),
        Os::Linux => home.join(".config/systemd/user").join(unit.systemd()),
        Os::Windows => local_app_data
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Local"))
            .join("Polycarp")
            .join("agent")
            .join(format!(
                "{}-task.xml",
                unit.systemd().trim_end_matches(".service")
            )),
    }
}

pub fn log_path(unit: Unit, home: &Path) -> PathBuf {
    home.join("Library/Logs").join(unit.log_name())
}

pub fn render(unit: Unit, os: Os, exe: &Path, log: &Path, user: &str, tailnet: bool) -> String {
    let e = exe.to_string_lossy();
    let args = unit.args(tailnet);
    match os {
        Os::Mac => {
            let argv: String = args
                .iter()
                .map(|a| format!("    <string>{a}</string>\n"))
                .collect();
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
{argv}  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
                label = unit.label(),
                exe = xml_escape(&e),
                log = xml_escape(&log.to_string_lossy()),
            )
        }
        Os::Linux => format!(
            "[Unit]\nDescription={}\nAfter=network-online.target\n\n[Service]\nExecStart={} {}\nRestart=on-failure\nRestartSec=30\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n",
            unit.description(),
            systemd_quote(&e),
            args.join(" ")
        ),
        Os::Windows => format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>{desc}</Description></RegistrationInfo>
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
  <Actions Context="Author"><Exec><Command>{exe}</Command><Arguments>{args}</Arguments></Exec></Actions>
</Task>
"#,
            desc = xml_escape(unit.description()),
            exe = xml_escape(&e),
            args = args.join(" "),
            user = xml_escape(user),
        ),
    }
}

pub fn start_cmd(unit: Unit, os: Os, path: &Path) -> String {
    match os {
        Os::Mac => format!("launchctl bootstrap gui/$(id -u) {}", path.display()),
        Os::Linux => format!(
            "systemctl --user daemon-reload && systemctl --user enable --now {}",
            unit.systemd()
        ),
        Os::Windows => format!(
            "schtasks /Create /TN \"{t}\" /XML \"{}\" && schtasks /Run /TN \"{t}\"",
            path.display(),
            t = unit.task()
        ),
    }
}

pub fn stop_cmd(unit: Unit, os: Os) -> String {
    match os {
        Os::Mac => format!("launchctl bootout gui/$(id -u)/{}", unit.label()),
        Os::Linux => format!("systemctl --user disable --now {}", unit.systemd()),
        Os::Windows => format!(
            "schtasks /End /TN \"{t}\" && schtasks /Delete /TN \"{t}\" /F",
            t = unit.task()
        ),
    }
}

/// The program and arguments that restart a loaded unit (`fix` runs this, never a shell).
pub fn restart_argv(unit: Unit, os: Os, uid: Option<u32>) -> Option<(PathBuf, Vec<String>)> {
    match os {
        Os::Mac => Some((
            PathBuf::from("/bin/launchctl"),
            vec![
                "kickstart".into(),
                "-k".into(),
                format!("gui/{}/{}", uid?, unit.label()),
            ],
        )),
        Os::Linux => Some((
            PathBuf::from("/usr/bin/systemctl"),
            vec!["--user".into(), "restart".into(), unit.systemd().into()],
        )),
        Os::Windows => {
            let root = std::env::var_os("SystemRoot")?;
            Some((
                PathBuf::from(root).join("System32").join("schtasks.exe"),
                vec!["/Run".into(), "/TN".into(), unit.task().into()],
            ))
        }
    }
}

/// The program and arguments that ask whether the unit is loaded, read-only.
pub fn query_argv(unit: Unit, os: Os, uid: Option<u32>) -> Option<(PathBuf, Vec<String>)> {
    match os {
        Os::Mac => Some((
            PathBuf::from("/bin/launchctl"),
            vec!["print".into(), format!("gui/{}/{}", uid?, unit.label())],
        )),
        Os::Linux => Some((
            PathBuf::from("/usr/bin/systemctl"),
            vec!["--user".into(), "is-active".into(), unit.systemd().into()],
        )),
        Os::Windows => {
            let root = std::env::var_os("SystemRoot")?;
            Some((
                PathBuf::from(root).join("System32").join("schtasks.exe"),
                vec!["/Query".into(), "/TN".into(), unit.task().into()],
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_run_the_gateway_or_the_tunnel_need_no_admin_and_dont_collide() {
        let exe = Path::new("/Users/d/.local/bin/polycarp");
        let log = Path::new("/Users/d/Library/Logs/polycarp-agent.log");
        let mac = render(Unit::Gateway, Os::Mac, exe, log, "d", true);
        assert!(mac.contains("<string>agent</string>\n    <string>serve</string>\n    <string>--tailnet</string>"), "{mac}");
        assert!(mac.contains("com.polycarp.agent<"));
        let t = render(
            Unit::Tunnel,
            Os::Linux,
            Path::new("/home/d/.local/bin/polycarp"),
            log,
            "d",
            false,
        );
        assert!(
            t.contains("ExecStart=\"/home/d/.local/bin/polycarp\" agent tunnel run"),
            "{t}"
        );
        let w = render(
            Unit::Gateway,
            Os::Windows,
            Path::new("C:\\p.exe"),
            log,
            "PC\\d & co",
            false,
        );
        assert!(w.contains("<Arguments>agent serve</Arguments>") && w.contains("PC\\d &amp; co"));
        assert!(w.contains("LeastPrivilege"));
        for u in [Unit::Gateway, Unit::Tunnel] {
            assert_ne!(u.label(), crate::files::service::LABEL);
            // `update --retire-old-browser` removes the old helper's jobs on every Mac install: never ours.
            assert!(!crate::retire::LABELS.contains(&u.label()), "{}", u.label());
            assert!(
                !u.label().starts_with("com.tabkyra") && !u.label().starts_with("com.tychicus")
            );
            assert_ne!(u.systemd(), crate::files::service::SYSTEMD_UNIT);
            for os in [Os::Mac, Os::Linux, Os::Windows] {
                let p = unit_path(u, os, Path::new("/h"), None);
                for cmd in [start_cmd(u, os, &p), stop_cmd(u, os)] {
                    assert!(!cmd.contains("sudo"), "{cmd}");
                }
            }
        }
        assert_ne!(
            unit_path(Unit::Gateway, Os::Windows, Path::new("/h"), None),
            unit_path(Unit::Tunnel, Os::Windows, Path::new("/h"), None)
        );
    }
}
