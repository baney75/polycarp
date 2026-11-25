import Foundation

/// Apps that didn't answer Accessibility, and when to ask them again. A hung app costs a full timeout on every call, so
/// each miss in a row waits longer (5 s, 30 s, 2 min, 10 min) and a frozen app costs a timeout rarely.
///
/// Only a miss by an app that was free to be asked counts. One that lands while its app is already benched (a call
/// already on its way, or one that doesn't look at the bench) is the same hang seen again. Until 2026-11-24 those counted,
/// and said nothing in trace.log: a read every 15 s that kept missing (the bar's status items) reached the 10 minute wait
/// in four misses and started it again each time, so a scan never got to ask. trace.log that day: Word launched at
/// 22:14:17, one 5 s bench at 22:14:18, no line after it, and at 22:22:07 its window still had no workspace.
///
/// An app in its first minute is starting, not hung: each miss waits the shortest time and none add up. Word and Excel
/// time out while they load; 30 s for the second miss left their first window unplaced long after they were ready.
public struct AXBench: Equatable, Sendable {
    /// Seconds benched after each miss in a row by an app past `starting`; the last repeats.
    public static let hung: [TimeInterval] = [5, 30, 120, 600]
    /// How long after its launch an app counts as still starting.
    public static let starting: TimeInterval = 60

    /// This bench's waits (`hung` unless its reads are cheap enough to ask sooner).
    private let waits: [TimeInterval]
    private var strikes: [Int32: Int] = [:]
    private var until: [Int32: Date] = [:]

    public init(waits: [TimeInterval] = Self.hung) { self.waits = waits }

    /// Records a miss. `age` is the seconds since the app launched, nil when unknown (it counts as an old app). Returns
    /// how long it is benched from `now`.
    @discardableResult
    public mutating func missed(_ pid: Int32, age: TimeInterval?, now: Date) -> TimeInterval {
        if let t = until[pid], t > now { return t.timeIntervalSince(now) }
        let young = age.map { $0 >= 0 && $0 < Self.starting } ?? false
        let n = young ? 0 : strikes[pid, default: 0]
        if !young { strikes[pid] = n + 1 }
        let delay = waits[min(n, waits.count - 1)]
        until[pid] = now.addingTimeInterval(delay)
        return delay
    }

    /// The app answered, or you brought it forward: a clean slate.
    public mutating func answered(_ pid: Int32) {
        strikes[pid] = nil
        until[pid] = nil
    }

    /// Whether to leave the app alone now.
    public mutating func isBenched(_ pid: Int32, now: Date) -> Bool {
        guard let t = until[pid] else { return false }
        if t <= now { until[pid] = nil; return false }
        return true
    }

    /// When the first benched app may be asked again.
    public func nextReturn(after now: Date) -> Date? { until.values.filter { $0 > now }.min() }

    /// Seconds until the retry timer should look again: when the first benched app is due (a moment after, so it is),
    /// never sooner than `floor` and never later than `ceiling` (the timer's old fixed wait).
    public func retryDelay(now: Date, floor: TimeInterval = 0.3, ceiling: TimeInterval = 5.5) -> TimeInterval {
        guard let t = nextReturn(after: now) else { return ceiling }
        return min(ceiling, max(floor, t.timeIntervalSince(now) + 0.05))
    }

    /// Every app asked again at once: after the Mac wakes, an app that missed while it slept isn't hung (`Spaces.didWake`).
    public mutating func clear() {
        strikes = [:]
        until = [:]
    }

    /// Forgets apps that quit.
    public mutating func keep(_ alive: Set<Int32>) {
        strikes = strikes.filter { alive.contains($0.key) }
        until = until.filter { alive.contains($0.key) }
    }

    /// The trace line for an app newly benched. It names the call and the error, so a miss can be told apart: a timeout
    /// (-25204) is an app too slow or hung, anything else is not a hang (2026-11-17: Ghostty and Terminal answered in
    /// under 65 ms when asked from outside, yet one Polycarp process benched both for 3 hours, and the line said only
    /// "didn't answer").
    public static func missLine(app: String, pid: Int32, call: String, error: Int32, delay: TimeInterval) -> String {
        String(format: "accessibility: %@ (pid %d) didn't answer (%@: %@); asked again in %.1fs", app, pid, call, errorName(error), delay)
    }

    /// An AXError's number with its name, for the trace. 0 is a call that succeeded with an answer of the wrong kind.
    public static func errorName(_ code: Int32) -> String {
        let names: [Int32: String] = [
            0: "answer of the wrong kind", -25200: "failure", -25201: "illegal argument", -25202: "invalid element",
            -25203: "invalid observer", -25204: "cannot complete (timeout)", -25205: "attribute unsupported",
            -25206: "action unsupported", -25207: "notification unsupported", -25208: "not implemented",
            -25209: "notification already registered", -25210: "notification not registered", -25211: "API disabled",
            -25212: "no value", -25213: "parameterized attribute unsupported", -25214: "not enough precision",
        ]
        return "\(code) \(names[code] ?? "unknown")"
    }
}
