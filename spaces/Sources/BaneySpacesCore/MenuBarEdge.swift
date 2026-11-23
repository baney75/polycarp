import Foundation

/// Where the pointer may not go while Polycarp's bar is up: the top row of each screen that has the bar, so macOS
/// never sees the pointer at that edge and never slides its own auto-hidden menu bar in (Donovan, 2026-11-23: "block
/// the bar from coming in any form"). Coordinates are Quartz global ones: origin at the top left of the main screen,
/// y growing down, so a screen's top edge is its smallest y.
public enum MenuBarEdge {
    /// One screen's top edge that is guarded.
    public struct Edge: Equatable, Sendable {
        public var minX: Double
        public var maxX: Double
        public var top: Double
        public init(minX: Double, maxX: Double, top: Double) {
            self.minX = minX; self.maxX = maxX; self.top = top
        }
    }

    /// A screen's frame in Quartz global coordinates.
    public struct Screen: Equatable, Sendable {
        public var x: Double, y: Double, width: Double, height: Double
        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x; self.y = y; self.width = width; self.height = height
        }
    }

    /// How far below the edge the pointer is held. macOS slides its hidden bar in with the pointer 2 points under the
    /// top edge, not at 3 (measured 2026-11-23 on a MacBook Pro with a notch, held 1.2 s at each depth): 4 keeps a
    /// point to spare and stays well inside Polycarp's bar unless a window or a full-screen app covers it there.
    public static let inset = 4.0

    /// The edges to guard: the top of each screen in `guarded`, less the stretches where another screen of `all` sits
    /// directly on top of it, since there the pointer is crossing to that screen, not touching an edge macOS reveals its
    /// bar from. A screen partly under another keeps the rest of its edge guarded.
    public static func edges(guarded: [Screen], all: [Screen]) -> [Edge] {
        guarded.flatMap { s -> [Edge] in
            let covers = all.filter { o in o != s && abs((o.y + o.height) - s.y) < 0.5 }
                .map { (max($0.x, s.x), min($0.x + $0.width, s.x + s.width)) }
                .filter { $0.0 < $0.1 }
                .sorted { $0.0 < $1.0 }
            var out: [Edge] = []
            var from = s.x
            for (a, b) in covers {
                if a > from { out.append(Edge(minX: from, maxX: a, top: s.y)) }
                from = max(from, b)
            }
            if from < s.x + s.width { out.append(Edge(minX: from, maxX: s.x + s.width, top: s.y)) }
            return out
        }
    }

    /// Where the pointer goes instead of `(x, y)`, or nil when it may stay.
    public static func clamp(x: Double, y: Double, edges: [Edge]) -> (x: Double, y: Double)? {
        for e in edges where x >= e.minX && x < e.maxX && y < e.top + inset {
            // Only near the edge: a point far above it is on another screen.
            guard y > e.top - 50 else { continue }
            return (x, e.top + inset)
        }
        return nil
    }
}
