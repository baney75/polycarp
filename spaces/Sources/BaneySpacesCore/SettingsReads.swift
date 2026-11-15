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

    /// Whether this pane shows the Automation list, the only one that needs every window read.
    public static func readsWindows(pane: String) -> Bool { pane == "Automation" }

    /// Opening reads slower than this on the main thread go to the trace log.
    public static let slow: TimeInterval = 0.05

    /// The trace line for a slow read when the window shows, or nil when it was quick.
    public static func slowLine(seconds: TimeInterval, pane: String, windows: Bool) -> String? {
        guard seconds >= slow else { return nil }
        return "slow settings read: \(Int((seconds * 1000).rounded())) ms on main, \(pane) pane" + (windows ? ", every window read" : "")
    }
}
