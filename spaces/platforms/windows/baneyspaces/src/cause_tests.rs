use super::*;

#[test]
fn closing_the_last_window_does_not_follow_windows_to_another_workspace() {
    // You click the close box (40 ms ago), the window closes (20 ms ago), Windows activates a hidden window.
    assert_eq!(foreground_by(40, Some(20), false, None), Cause::App);
    // The foreground event came before the close was seen: the active window is already gone.
    assert_eq!(foreground_by(40, None, true, None), Cause::App);
    assert_eq!(foreground_by(40, Some(9_000), true, None), Cause::App);
}

#[test]
fn a_click_after_a_close_is_still_yours() {
    // A taskbar click 30 ms ago, after a close five seconds earlier, may take you to that window's workspace.
    assert_eq!(foreground_by(30, Some(5_000), false, None), Cause::User);
    assert_eq!(foreground_by(30, None, false, None), Cause::User);
}

#[test]
fn no_recent_input_is_the_apps() {
    assert_eq!(foreground_by(2_000, None, false, None), Cause::App);
    assert_eq!(foreground_by(300, Some(9_000), false, None), Cause::App);
}

#[test]
fn a_window_the_daemon_asked_for_is_never_yours() {
    // Win+6 typed 40 ms ago, and the front goes to a window the daemon asked for 300 ms ago: the daemon's, not yours.
    assert_eq!(foreground_by(40, None, false, Some(300)), Cause::App);
    assert_eq!(foreground_by(40, None, false, Some(0)), Cause::App);
    // An ask over ASKED_MS old no longer counts, and none at all leaves your input to decide.
    let asks = Asks::new();
    asks.note(0x7001, 0x7001, 3_000);
    assert_eq!(foreground_by(40, None, false, asks.take(0x7001, 0x7001, 5_000)), Cause::User);
}

#[test]
fn a_late_activation_from_the_switch_before_does_not_follow() {
    // #545, speed run 44275966979: Win+2 asks for a (refused, it lands later); Win+6 asks for b; a takes the front
    // 47 ms after Win+6 went down. Following it showed workspace 2 again, b's late front showed 6, seven times over.
    let asks = Asks::new();
    let (a, b, c) = (0x10216, 0x30264, 0x10218);
    asks.note(c, c, 10_000);
    asks.note(a, a, 10_000);
    asks.note(b, b, 10_150);
    assert_eq!(foreground_by(47, None, false, asks.take(a, a, 10_197)), Cause::App, "a's late front is the daemon's");
    assert_eq!(foreground_by(60, None, false, asks.take(b, b, 10_210)), Cause::App, "and so is b's");
    assert_eq!(asks.take(c, c, 11_000), None, "an ask lasts ASKED_MS");
}

#[test]
fn an_ask_that_landed_never_refuses_your_front_later() {
    // Win+1 asks for x and x takes the front; Win+2 asks for a. Within the second you click x: that's yours.
    let asks = Asks::new();
    let (x, a) = (0x40216, 0x40218);
    asks.note(x, x, 20_000);
    assert_eq!(asks.take(x, x, 20_080), Some(80), "x's front landed late: the daemon's");
    asks.note(a, a, 20_200);
    assert_eq!(asks.take(x, x, 20_500), None, "x's ask was used up when its front landed");
    // An ask Windows granted at once leaves nothing to land late.
    let y = 0x40220;
    asks.note(y, y, 20_000);
    asks.landed(y);
    assert_eq!(asks.take(y, y, 20_100), None);
}

#[test]
fn an_ask_covers_the_dialog_its_window_owns() {
    // Win+2 asks for Notepad's window a, which owns an open Save As dialog d. Windows grants the ask late, and
    // gives the front to d. That's the daemon's front too, or Win+6's 300 ms would call it yours (#545 again).
    let asks = Asks::new();
    let (a, d) = (0x50216, 0x50300);
    asks.note(a, a, 30_000);
    assert_eq!(asks.take(d, a, 30_250), Some(250));
    // A window with another root is no part of the ask.
    asks.note(a, a, 30_400);
    assert_eq!(asks.take(0x50400, 0x50400, 30_450), None);
}

#[test]
fn only_the_daemons_own_keys_are_never_yours() {
    // Your keys, and keys another program sends for you (On-Screen Keyboard, voice access, AutoHotkey), count.
    // The daemon's own 0xE8 nudge moves GetLastInputInfo too, a tick or two from the hook's time for it.
    let c = InputClock::new();
    c.note(false, 500);
    c.note(true, 1_000);
    assert_eq!(c.idle(1_100, 100), 600, "the nudge at 1 000 is not your input");
    assert_eq!(c.idle(1_100, 98), 600, "nor is the system's time for it");
    let only = InputClock::new();
    only.note(true, 1_000);
    assert_eq!(only.idle(1_100, 100), u32::MAX, "nothing but the daemon's own keys: no input of yours");
}

#[test]
fn input_the_hooks_never_saw_still_counts() {
    // Nothing heard yet: the system's count.
    let c = InputClock::new();
    assert_eq!(c.idle(1_000, 700), 700);
    // A key typed into an elevated window, a remapper's re-sent key, or a click after Windows dropped a slow
    // mouse hook: only GetLastInputInfo hears it, and it is newer than anything the hooks heard.
    c.note(false, 500);
    assert_eq!(c.idle(2_000, 40), 40);
    c.note(true, 1_900);
    assert_eq!(c.idle(2_000, 40), 40, "newer than the daemon's own key too");
}

fn body<'a>(src: &'a str, f: &str) -> &'a str {
    let start = src.find(&format!("fn {f}(")).unwrap_or_else(|| panic!("{f}"));
    let line = src[..start].rfind('\n').map_or(0, |i| i + 1);
    let indent: String = src[line..start].chars().take_while(|c| *c == ' ').collect();
    let end = format!("\n{indent}}}\n");
    &src[start..start + src[start..].find(&end).unwrap_or_else(|| panic!("end of {f}"))]
}

#[test]
fn the_daemon_asks_before_it_calls_an_activation_yours() {
    let src = include_str!("daemon.rs").replace("\r\n", "\n");
    let f = body(&src, "on_foreground");
    assert!(f.contains("cause::foreground_by("), "on_foreground must classify the activation with cause::foreground_by");
    assert!(!f.contains("idle_ms() < 300"), "the bare 300 ms guess calls a close's activation yours");
    assert!(f.contains("hook::idle_ms("), "on_foreground must time your input from the hooks, not GetLastInputInfo alone");
    // first-F1: Win+1's refused ask for x lands on x, which the model already holds active. Left, the ask refuses
    // your click on x after Win+2.
    let take = f.find("ASKS.take(").expect("on_foreground must know which windows the daemon asked for");
    let guard = f.find("self.model.active() == Some(").expect("the guard for the window already active");
    assert!(take < guard, "an ask is used up when its front lands, on the window already active too");
    // first-F2: every ask goes through one helper, which uses the ask up when Windows grants it at once.
    assert_eq!(src.matches("ASKS.note(").count(), 1, "one place notes asks");
    let b = body(&src, "bring_to_front");
    assert!(b.contains("ASKS.note(") && b.contains("winapi::set_foreground(") && b.contains("ASKS.landed("));
    for f in ["exec", "keep_focus_off_hidden_windows"] {
        assert!(body(&src, f).contains("bring_to_front("), "{f} must ask through bring_to_front");
    }
    let f = body(&src, "close_window");
    assert!(f.contains("self.closed_at = Some("), "close_window must note when the close happened");
}

#[test]
fn the_daemons_nudge_carries_its_own_mark() {
    let src = include_str!("winapi.rs").replace("\r\n", "\n");
    assert!(body(&src, "nudge_input").contains("dwExtraInfo: OWN_INPUT_MARK"), "the idle clock knows the nudge by its mark");
    let src = include_str!("hook.rs").replace("\r\n", "\n");
    assert_eq!(src.matches("OWN_INPUT_MARK").count(), 2, "both hooks tell the daemon's own input apart");
    assert!(body(&src, "idle_ms").contains("crate::winapi::idle_ms()"), "idle_ms must weigh the system's count too");
}
