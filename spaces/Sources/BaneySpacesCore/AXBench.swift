import Foundation

/// Apps that didn't answer Accessibility, and when to ask them again. A hung app costs a full timeout on every call, so
/// each miss in a row waits longer (5 s, 30 s, 2 min, 10 min) and a frozen app costs a timeout rarely.
///
/// An app that is still starting is not hung. For its first second or so it answers `cannotComplete` or runs out the
/// timeout while its Accessibility server comes up (measured: Font Book at +0.58 s and again at +3.40 s, Calculator at
/// +0.58 s, each a 0.25 s timeout). Benching it like a hung app hid its first window for 35 s, past the 8 s claim an
/// agent's `open` holds on it, so the window stayed where macOS drew it: on your screen. A young app is asked again within
/// a second, and those misses don't count toward the hung back-off.
public struct AXBench: Equatable, Sendable {
    /// Seconds benched after each miss in a row by an app past `launching`; the last repeats.
    public static let hung: [TimeInterval] = [5, 30, 120, 600]
    /// Seconds benched after each miss by an app younger than `launching`.
    public static let young: [TimeInterval] = [0.3, 0.6, 1.2, 2.5]
    /// How long after its launch an app counts as still starting.
    public static let launching: TimeInterval = 15

    private var strikes: [Int32: Int] = [:]
    private var youngMisses: [Int32: Int] = [:]
    private var until: [Int32: Date] = [:]

    public init() {}

    /// Records a miss. `age` is the seconds since the app launched, nil when unknown (it counts as an old app).
    /// Returns how long it is benched.
    @discardableResult
    public mutating func missed(_ pid: Int32, age: TimeInterval?, now: Date) -> TimeInterval {
        let delay: TimeInterval
        if let age, age >= 0, age < Self.launching {
            let n = youngMisses[pid, default: 0]
            youngMisses[pid] = n + 1
            delay = Self.young[min(n, Self.young.count - 1)]
        } else {
            let n = strikes[pid, default: 0]
            strikes[pid] = n + 1
            delay = Self.hung[min(n, Self.hung.count - 1)]
        }
        until[pid] = now.addingTimeInterval(delay)
        return delay
    }

    /// The app answered, or you brought it forward: a clean slate.
    public mutating func answered(_ pid: Int32) {
        strikes[pid] = nil
        youngMisses[pid] = nil
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
        youngMisses = [:]
        until = [:]
    }

    /// Forgets apps that quit.
    public mutating func keep(_ alive: Set<Int32>) {
        strikes = strikes.filter { alive.contains($0.key) }
        youngMisses = youngMisses.filter { alive.contains($0.key) }
        until = until.filter { alive.contains($0.key) }
    }
}
