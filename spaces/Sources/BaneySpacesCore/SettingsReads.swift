import Foundation

/// When the Settings window reads what it shows. Opening it used to read everything three times (`show`, then the window
/// taking the keyboard, then the app coming forward) and the Automation list twice, whatever pane was up. Each Automation
/// read refreshes every window (`Spaces.refresh`), an Accessibility scan on the main thread that one slow app holds for
/// up to 0.25 s.
public enum SettingsReads {
    /// Reads this close together are one read: opening the window sets off all three within a few milliseconds.
    public static let again: TimeInterval = 0.5

    /// Whether to read again, `last` and `now` in uptime seconds. nil: never read.
    public static func due(last: TimeInterval?, now: TimeInterval) -> Bool { last.map { now - $0 >= again } ?? true }

    /// Whether to read every window: only for the Automation list, and only when the window opens. Coming forward or
    /// taking the keyboard again doesn't (up to 0.25 s on main, every 0.5 s); `tick` reads the list every 3 s.
    public static func readsWindows(pane: String, opening: Bool) -> Bool { opening && pane == "Automation" }

    /// Opening reads slower than this on the main thread go to the trace log.
    public static let slow: TimeInterval = 0.05

    /// The trace line for a slow read when the window shows, or nil when it was quick.
    public static func slowLine(seconds: TimeInterval, pane: String, windows: Bool) -> String? {
        guard seconds >= slow else { return nil }
        return "slow settings read: \(Int((seconds * 1000).rounded())) ms on main, \(pane) pane" + (windows ? ", every window read" : "")
    }
}

/// What the open Settings window reads and when, with the login item's status behind `ask` (`SMAppService.mainApp.status`
/// in the app, about 0.1 s a read there). Used on the main thread. `ask` runs on one serial queue, never the caller's
/// thread, and only the newest read reaches `land`: two reads can't land out of order and put back an old switch value.
public final class SettingsWindowReads<Status> {
    private let ask: () -> Status
    private let land: (Status) -> Void
    private let queue = DispatchQueue(label: "polycarp.settings.login-item", qos: .userInitiated)
    private var asked = 0
    private var last: TimeInterval?

    public init(ask: @escaping () -> Status, land: @escaping (Status) -> Void) { self.ask = ask; self.land = land }

    /// The window opened (`opening`), took the keyboard or came forward. nil: it read a moment ago, so nothing now.
    /// Otherwise everything is read, the login item off this thread, and every window when the result is true.
    public func shown(pane: String, opening: Bool, now: TimeInterval) -> Bool? {
        guard opening || SettingsReads.due(last: last, now: now) else { return nil }
        last = now
        refreshLogin()
        return SettingsReads.readsWindows(pane: pane, opening: opening)
    }

    /// `tick` number `n` (four a second): the slower reads once a second, every window every 3 s on a visible Automation
    /// pane, the login item never.
    public func tick(_ n: Int, pane: String, visible: @autoclosure () -> Bool) -> (slower: Bool, windows: Bool) {
        (n % 4 == 0, n % 12 == 0 && pane == "Automation" && visible())
    }

    /// Reads the login item off this thread; a later call's read replaces this one's.
    public func refreshLogin() {
        asked += 1
        let mine = asked, ask = ask
        queue.async {
            let status = ask()
            DispatchQueue.main.async { [weak self] in
                guard let self, self.asked == mine else { return }
                self.land(status)
            }
        }
    }
}
