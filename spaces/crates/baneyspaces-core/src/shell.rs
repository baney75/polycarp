//! What a desktop shell (the Windows bar and launcher) is told by the daemon: one `ShellState` line on the control
//! pipe each time something it shows changes. `spec/shell.md` is the contract.
//!
//! Only your own windows are in it: an agent's windows and the agent workspace's contents never are.

use crate::model::{Home, Model, WORKSPACES};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellState {
    /// Every display, in the order the daemon numbers them (left to right).
    pub monitors: Vec<MonitorView>,
    pub focused_monitor: Option<String>,
    /// Workspaces with at least one of your windows, ascending.
    pub occupied: Vec<u8>,
    /// The window in front, when it is one of yours.
    pub active: Option<WindowView>,
    /// Your windows, oldest first within each workspace, workspaces ascending.
    pub windows: Vec<WindowView>,
    /// The agent workspace is showing.
    pub agent_shown: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonitorView {
    /// The display's device name, as `MONITORINFOEX.szDevice` gives it (`\\.\DISPLAY1`).
    pub id: String,
    /// The workspace it shows (0: none of the nine).
    pub current: u8,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowView {
    pub id: String,
    pub app: String,
    pub title: String,
    pub workspace: u8,
}

impl ShellState {
    /// Builds the state from the model; `facts` gives a window's app name and title.
    pub fn from_model(m: &Model, facts: impl Fn(&str) -> (String, String)) -> Self {
        let mut monitors: Vec<(u32, MonitorView)> = m
            .monitors()
            .map(|id| {
                (
                    m.slot(id).unwrap_or(u32::MAX),
                    MonitorView {
                        id: id.to_string(),
                        current: m.current(id).unwrap_or(0),
                    },
                )
            })
            .collect();
        monitors.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
        let mut windows = Vec::new();
        let mut occupied = Vec::new();
        for n in WORKSPACES {
            let mine: Vec<&str> = m
                .windows_on(n)
                .into_iter()
                .filter(|w| !m.is_agent_window(w))
                .collect();
            if !mine.is_empty() {
                occupied.push(n);
            }
            for w in mine {
                let (app, title) = facts(w);
                windows.push(WindowView {
                    id: w.to_string(),
                    app,
                    title,
                    workspace: n,
                });
            }
        }
        let active = m
            .active()
            .filter(|w| !m.is_agent_window(w))
            .and_then(|w| match m.home(w) {
                Some(Home::Workspace { n }) => {
                    let (app, title) = facts(w);
                    Some(WindowView {
                        id: w.to_string(),
                        app,
                        title,
                        workspace: *n,
                    })
                }
                _ => None,
            });
        ShellState {
            monitors: monitors.into_iter().map(|(_, v)| v).collect(),
            focused_monitor: m.focused_monitor().map(String::from),
            occupied,
            active,
            windows,
            agent_shown: m.agent_shown(),
        }
    }

    /// The line the daemon writes for this state.
    pub fn line(&self) -> String {
        serde_json::json!({ "event": "state", "state": self }).to_string()
    }

    /// Reads one line from the daemon: the state, or `None` for any other event.
    pub fn parse_line(line: &str) -> Option<ShellState> {
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        if v["event"] != "state" {
            return None;
        }
        serde_json::from_value(v["state"].clone()).ok()
    }

    /// The workspace a display shows.
    pub fn current_on(&self, monitor: &str) -> Option<u8> {
        self.monitors
            .iter()
            .find(|m| m.id == monitor)
            .map(|m| m.current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Cause, Event};

    fn model() -> Model {
        let mut m = Model::new();
        m.apply(Event::MonitorAdded {
            monitor: "\\\\.\\DISPLAY2".into(),
        })
        .unwrap();
        m.apply(Event::MonitorAdded {
            monitor: "\\\\.\\DISPLAY1".into(),
        })
        .unwrap();
        m.apply(Event::Open {
            window: "w-1".into(),
            pid: 10,
            start: 1,
            app: "notepad.exe".into(),
            monitor: None,
            workspace: None,
        })
        .unwrap();
        m.apply(Event::Open {
            window: "w-2".into(),
            pid: 11,
            start: 1,
            app: "code.exe".into(),
            monitor: None,
            workspace: None,
        })
        .unwrap();
        // A window opens on the workspace its display shows (R-P1); send this one to 3 and stay.
        m.apply(Event::Move {
            n: 3,
            window: Some("w-2".into()),
            follow: false,
        })
        .unwrap();
        m.apply(Event::AgentRegister { pid: 20, start: 5 }).unwrap();
        m.apply(Event::Open {
            window: "w-9".into(),
            pid: 20,
            start: 5,
            app: "calc.exe".into(),
            monitor: None,
            workspace: None,
        })
        .unwrap();
        m
    }

    fn facts(w: &str) -> (String, String) {
        (format!("app of {w}"), format!("title of {w}"))
    }

    #[test]
    fn lists_your_windows_and_occupied_workspaces_never_an_agents() {
        let s = ShellState::from_model(&model(), facts);
        assert_eq!(s.occupied, vec![1, 3]);
        assert_eq!(
            s.windows
                .iter()
                .map(|w| (w.id.as_str(), w.workspace))
                .collect::<Vec<_>>(),
            vec![("w-1", 1), ("w-2", 3)]
        );
        assert!(!s.windows.iter().any(|w| w.id == "w-9"));
        assert!(!s.line().contains("w-9"));
    }

    #[test]
    fn a_switch_changes_the_state_and_the_line_reads_back() {
        let mut m = model();
        let before = ShellState::from_model(&m, facts);
        m.apply(Event::Switch { n: 3, monitor: None }).unwrap();
        m.apply(Event::Activate {
            window: Some("w-2".into()),
            cause: Cause::User,
        })
        .unwrap();
        let after = ShellState::from_model(&m, facts);
        assert_ne!(before, after);
        let focused = after.focused_monitor.clone().unwrap();
        assert_eq!(after.current_on(&focused), Some(3));
        assert_eq!(after.active.as_ref().map(|a| a.id.as_str()), Some("w-2"));
        assert_eq!(ShellState::parse_line(&after.line()), Some(after));
        assert_eq!(ShellState::parse_line(r#"{"event":"other"}"#), None);
    }

    #[test]
    fn an_agents_window_in_front_is_not_shown_as_active() {
        let mut m = model();
        // R-G1: an agent window comes to the front only after you show the agent workspace and pick it yourself.
        m.apply(Event::AgentShow).unwrap();
        m.apply(Event::Activate {
            window: Some("w-9".into()),
            cause: Cause::User,
        })
        .unwrap();
        assert_eq!(m.active(), Some("w-9"), "the model has the agent's window in front");
        let s = ShellState::from_model(&m, facts);
        assert_eq!(s.active, None);
        assert!(s.agent_shown);
        assert!(!s.line().contains("w-9"));
    }
}
