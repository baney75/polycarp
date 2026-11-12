import Foundation

/// Copies an agent's `open` started hidden, and when each is shown.
///
/// Measured 11-12: every agent launch drew its first window at the app's default frame (about 841,576) on Donovan's
/// screen for about 60 ms before Spaces parked it. Parking can only follow the drawing, so a copy an agent starts is
/// launched hidden: macOS draws nothing while Spaces places and parks its windows, and the copy is shown once every
/// window it has placed is on a workspace in sight or at the hiding spot. An app Spaces keeps drivable from behind
/// (one with a window on the agent workspace) is never hidden whole by a switch, so nothing else would show it.
/// Whatever happens, it is shown by `limit`, a moment past the 8 s claim: a copy never stays hidden because its window
/// went unplaced (that window then shows where the app put it, as before).
public struct HiddenLaunches: Equatable, Sendable {
    public static let limit: TimeInterval = 8.5

    /// One placed window of a hidden copy.
    public struct Placed: Equatable, Sendable {
        public var workspaceShown: Bool
        public var atHidingSpot: Bool
        public init(workspaceShown: Bool, atHidingSpot: Bool) {
            self.workspaceShown = workspaceShown
            self.atHidingSpot = atHidingSpot
        }
    }

    /// Why a copy is shown.
    public enum Release: Equatable, Sendable {
        /// Every window it placed is in sight or parked: showing it draws nothing on Donovan's screen.
        case placed
        /// `limit` passed first.
        case lapsed
    }

    private var started: [Int32: Date] = [:]

    public init() {}

    public var isEmpty: Bool { started.isEmpty }

    public mutating func launched(_ pid: Int32, at now: Date) { started[pid] = now }

    /// Whether showing a copy now draws nothing out of place: it has a placed window, and each is on a workspace in
    /// sight or at the hiding spot.
    public static func ready(_ windows: [Placed]) -> Bool {
        !windows.isEmpty && windows.allSatisfy { $0.workspaceShown || $0.atHidingSpot }
    }

    /// A launch that ran inside a copy already running (Donovan's) hid it: show it again, unless it was hidden already.
    public static func undo(hiddenNow: Bool, hiddenBefore: Bool) -> Bool { hiddenNow && !hiddenBefore }

    /// The copies to show now, each forgotten. `windows` gives a pid's placed windows.
    public mutating func release(now: Date, windows: (Int32) -> [Placed]) -> [(pid: Int32, why: Release)] {
        var out: [(pid: Int32, why: Release)] = []
        for (pid, t) in started.sorted(by: { $0.key < $1.key }) {
            if Self.ready(windows(pid)) { out.append((pid, .placed)) }
            else if now.timeIntervalSince(t) >= Self.limit { out.append((pid, .lapsed)) }
        }
        for r in out { started[r.pid] = nil }
        return out
    }
}
