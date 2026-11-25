import Foundation

/// Keeps Polycarp Browser current. Once a day the app runs the `polycarp` it carries: it looks for a newer release, checks
/// and builds it, and puts it in once the browser quits. Where the browser isn't installed it does nothing. The app is
/// running whenever the person is logged in, so this needs no launchd job of its own.
public enum BrowserUpdate {
    public static let arguments = ["browser", "update", "--when-quit"]

    public static func command(resources: URL) -> URL {
        resources.appendingPathComponent("bin/polycarp")
    }

    /// A run that failed is not tried again before the next day: a build takes a minute of work.
    public static func due(last: Date?, now: Date, automatic: Bool) -> Bool {
        guard automatic else { return false }
        guard let last, last <= now else { return true }
        return now.timeIntervalSince(last) >= 23 * 3600
    }
}
