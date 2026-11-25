import CoreGraphics
import Foundation

/// When windows a switch just moved have stopped where they were sent, from looks at the window server's frames. Some apps
/// animate a move over several frames; `slow` names the windows still changing position `animating` after the move.
public struct Settling {
    public enum Goal: Sendable {
        /// Each window to its own place.
        case home([WindowID: CGPoint])
        /// Every window out of sight, at the hiding spot.
        case parked(at: CGPoint)
    }

    /// How long a window must keep still to count as stopped somewhere other than where it was sent.
    public static let still: TimeInterval = 0.05
    /// A window that changes position later than this after the move is animating it.
    public static let animating: TimeInterval = 0.12

    private let ids: Set<WindowID>
    private let goal: Goal
    private let screens: [CGRect]
    private let start: TimeInterval
    private var last: [WindowID: CGRect] = [:]
    private var stillSince: [WindowID: TimeInterval] = [:]
    public private(set) var slow: Set<WindowID> = []

    /// `start` and every look's time come from one clock.
    public init(_ ids: Set<WindowID>, goal: Goal, screens: [CGRect], start: TimeInterval) {
        self.ids = ids
        self.goal = goal
        self.screens = screens
        self.start = start
    }

    /// One look at time `t`; whether every window has stopped. A window the server doesn't list has nothing to wait for.
    public mutating func look(_ frames: [WindowID: CGRect], at t: TimeInterval) -> Bool {
        let now = frames.filter { ids.contains($0.key) }
        // Only position counts: an app snapping its size to a grid isn't animating a move.
        for (id, b) in now where last[id]?.origin != b.origin {
            // A position between two others, late: the app is animating.
            if last[id] != nil, t - start > Self.animating { slow.insert(id) }
            stillSince[id] = t
        }
        last = now
        return ids.allSatisfy { id in
            guard let b = now[id] else { return true }
            let still = t - (stillSince[id] ?? start) >= Self.still
            let away = Geometry.isStranded(b, screens: screens)
            switch goal {
            case .home(let targets):
                if let to = targets[id], abs(b.minX - to.x) < 1, abs(b.minY - to.y) < 1 { return true }
                return still && !away
            case .parked: return still && away
            }
        }
    }
}
