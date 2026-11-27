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

    /// When the theme's icon asks for one more build (spec/themes.md, "The icons", rule 9). One run at a time. An ask made
    /// during a run, or while the app itself is being updated, is kept and started once it can be, so the icon built in
    /// is the last one asked for. Any run, the daily one too, reads the icon as it starts: one that ends with no newer ask
    /// answers every ask before it, and a failed one waits for the next day, like the daily run.
    public struct Rebuild: Equatable, Sendable {
        /// An ask no run has answered yet. The app keeps it across launches.
        public private(set) var wanted: Bool
        public private(set) var running = false
        private var askedDuringRun = false

        public init(wanted: Bool = false) { self.wanted = wanted }

        /// A new icon: true when a run should start now. `free` is false while updates are off or the app is installing.
        public mutating func ask(free: Bool) -> Bool {
            wanted = true
            if running { askedDuringRun = true }
            return look(free: free)
        }

        /// A run started, for an ask or for the day.
        public mutating func started() {
            running = true
            askedDuringRun = false
        }

        /// The run ended: true when another should start now, for an ask that came during it.
        public mutating func ended(free: Bool) -> Bool {
            running = false
            if !askedDuringRun { wanted = false }
            askedDuringRun = false
            return look(free: free)
        }

        /// The app can run one again (its own update is over, or the hourly look): true when a kept ask should start.
        public func look(free: Bool) -> Bool { wanted && free && !running }
    }
}
