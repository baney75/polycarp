//! R-S2: the display you are on is the one you last clicked into, switched to or moved to. A click on a window
//! already moves it (the window's activation, R-F1), but the desktop spans every display and is not one of your
//! windows, so a click on the other display's bare desktop or taskbar changed nothing: with display B on an empty
//! workspace, Win+5 still switched display A. The daemon's mouse hook reports each press; this decides what it means.

use baneyspaces_core::model::Effect;

/// The button presses that say where you are: left, right and middle, down, made by a hand (not injected).
pub fn is_a_press(msg: u32, injected: bool) -> bool {
    const WM_LBUTTONDOWN: u32 = 0x0201;
    const WM_RBUTTONDOWN: u32 = 0x0204;
    const WM_MBUTTONDOWN: u32 = 0x0207;
    !injected && matches!(msg, WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN)
}

/// The display to be on after a press on display `at`, when that is not the one you are on already. A display the
/// model does not know (one just plugged in, before the next poll) moves nothing.
pub fn after_press<'a>(focused: Option<&str>, at: Option<&'a str>, known: &[&str]) -> Option<&'a str> {
    let at = at?;
    (known.contains(&at) && focused != Some(at)).then_some(at)
}

/// What takes the front after the model's effects. The last `focus_window` wins: it is where the model says the front
/// should be. With none, a `focus_monitor` means you went to a display with no window to put in front (R-S7, a click
/// on an empty workspace on the other display's bar): the desktop takes the front, so typing no longer goes to the
/// window on the display you left. The desktop spans every display, and the daemon does not follow it (it is not one of
/// your windows). `None` leaves the front alone.
pub fn front_after(effects: &[Effect]) -> Option<Front> {
    let window = effects.iter().rev().find_map(|e| match e {
        Effect::FocusWindow { window } => Some(Front::Window(window.clone())),
        _ => None,
    });
    window.or_else(|| effects.iter().any(|e| matches!(e, Effect::FocusMonitor { .. })).then_some(Front::Desktop))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Front {
    Window(String),
    Desktop,
}

#[cfg(test)]
mod tests {
    use super::*;
    use baneyspaces_core::model::{Event, Model};
    use serde_json::json;

    fn switch_from_b(n: u8) -> Vec<Effect> {
        let mut m = Model::new();
        for ev in [json!({"do":"monitor_added","monitor":"A"}), json!({"do":"monitor_added","monitor":"B"}), json!({"do":"open","window":"w1","pid":1})] {
            m.apply(serde_json::from_value::<Event>(ev).unwrap()).unwrap();
        }
        m.apply(Event::Switch { n, monitor: Some("B".into()) }).unwrap()
    }

    #[test]
    fn going_to_an_empty_workspace_on_the_other_display_takes_the_front_off_the_window_you_left() {
        // You are on A with w1 in front; a click on 5 on B's bar. No window to put in front there: the desktop.
        assert_eq!(front_after(&switch_from_b(5)), Some(Front::Desktop));
    }

    #[test]
    fn the_last_window_the_model_names_takes_the_front() {
        let effects = [
            Effect::FocusMonitor { monitor: "B".into() },
            Effect::FocusWindow { window: "w1".into() },
            Effect::FocusWindow { window: "w2".into() },
        ];
        assert_eq!(front_after(&effects), Some(Front::Window("w2".into())));
        // A switch on the display you are on, with nothing there, leaves the front to the hiding (R-E1).
        assert_eq!(front_after(&[Effect::ShowWorkspace { monitor: "A".into(), workspace: 3 }]), None);
        assert_eq!(front_after(&[]), None);
    }

    #[test]
    fn the_daemon_puts_in_front_what_front_after_says() {
        let daemon = &include_str!("daemon.rs").replace("\r\n", "\n");
        let exec = &daemon[daemon.find("fn exec(").expect("exec")..];
        let exec = &exec[..exec.find("\n    }\n").unwrap()];
        assert!(exec.contains("focus::front_after(effects)") && exec.contains("Front::Desktop"), "{exec}");
    }

    #[test]
    fn a_press_on_the_other_display_puts_you_there() {
        assert_eq!(after_press(Some("A"), Some("B"), &["A", "B"]), Some("B"));
        assert_eq!(after_press(None, Some("A"), &["A", "B"]), Some("A"));
    }

    #[test]
    fn a_press_where_you_are_or_on_an_unknown_display_changes_nothing() {
        assert_eq!(after_press(Some("A"), Some("A"), &["A", "B"]), None);
        assert_eq!(after_press(Some("A"), Some("C"), &["A", "B"]), None);
        assert_eq!(after_press(Some("A"), None, &["A", "B"]), None);
    }

    #[test]
    fn only_a_hand_pressing_a_button_counts() {
        assert!(is_a_press(0x0201, false) && is_a_press(0x0204, false) && is_a_press(0x0207, false));
        assert!(!is_a_press(0x0200, false), "a move is not a press");
        assert!(!is_a_press(0x0202, false), "nor is a release");
        assert!(!is_a_press(0x0201, true), "nor an injected press");
    }

    /// The hook thread watches the mouse, and the worker moves the display you are on for a press.
    #[test]
    fn the_daemon_hears_presses_and_moves_the_display_you_are_on() {
        let hook = include_str!("hook.rs");
        assert!(hook.contains("SetWindowsHookExW(WH_MOUSE_LL"), "a low-level mouse hook");
        assert!(hook.contains("focus::is_a_press("), "it reports presses only");
        // Windows checks the source out with CRLF line ends.
        let daemon = &include_str!("daemon.rs").replace("\r\n", "\n");
        assert!(daemon.contains("Ok(Msg::Press { x, y }) =>"), "the worker hears them");
        let on = &daemon[daemon.find("fn on_press(").expect("on_press")..];
        let on = &on[..on.find("\n    }\n").unwrap()];
        assert!(on.contains("focus::after_press(") && on.contains("Event::ObserveFocusMonitor"), "{on}");
    }
}
