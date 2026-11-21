import CoreGraphics

/// How a window border keeps up with its window. A border that trails its window reads as broken, so there are two ways
/// and no third: it moves with the window, or it is not drawn while the window moves.
public enum BorderFollowMode: Equatable, Sendable {
    /// The window server says the moment a bordered window moves, and the border moves in a window-server transaction
    /// right then (SkyLight's window-move notices).
    case live
    /// No such notices on this macOS (or forced, for the probe and tests): a border is hidden from the moment its window
    /// may move until it holds still, then drawn where the window is (`BorderHideWhileMoving`).
    case hideWhileMoving

    public static func choose(notices: Bool, forced: Bool) -> BorderFollowMode { notices && !forced ? .live : .hideWhileMoving }
}

/// The fallback's rule: a border is drawn only at the frame its window has in this very look, and never while the window
/// may be moving. A press that can start a move or a resize (the title band or an edge) hides it before the window moves;
/// a window found anywhere but where its border was drawn hides it at once. A hidden border comes back once the button
/// is up and its window has held still for `BorderPace.settle`, or at once on a release that moved nothing.
public struct BorderHideWhileMoving: Equatable, Sendable {
    /// The part of a window from its top where a press may drag it (title bars and browser toolbars).
    public static let titleBand: CGFloat = 64
    /// How far inside or outside an edge a press may resize it.
    public static let edgeBand: CGFloat = 8

    struct Held: Equatable, Sendable {
        var frame: CGRect
        /// Since when the window has been at `frame`.
        var since: Double
        var moved: Bool
    }

    /// Windows whose border is drawn, at this frame.
    private var drawn: [UInt32: CGRect] = [:]
    /// Windows whose border is hidden for now.
    private var held: [UInt32: Held] = [:]

    public init() {}

    public func isHidden(_ id: UInt32) -> Bool { held[id] != nil }

    /// A left press at `point` (window-server coordinates) over these windows (front first: the first one under the
    /// point takes the press). Returns the window whose border hides now, if any.
    public mutating func press(at point: CGPoint, frames: [(id: UInt32, frame: CGRect)], now: Double) -> UInt32? {
        let e = Self.edgeBand
        guard let hit = frames.first(where: { $0.frame.insetBy(dx: -e, dy: -e).contains(point) }) else { return nil }
        let f = hit.frame
        let edge = point.x < f.minX + e || point.x > f.maxX - e || point.y < f.minY + e || point.y > f.maxY - e
        guard edge || point.y < f.minY + Self.titleBand else { return nil }
        drawn[hit.id] = nil
        held[hit.id] = Held(frame: f, since: now, moved: false)
        return hit.id
    }

    /// A look at where the windows are. Returns the frame to draw each border at now; a window not in the answer has no
    /// border drawn. Every frame in the answer is the one given for that window in this look.
    public mutating func look(_ frames: [UInt32: CGRect], buttonDown: Bool, now: Double) -> [UInt32: CGRect] {
        for id in Array(drawn.keys) where frames[id] == nil { drawn[id] = nil }
        for id in Array(held.keys) where frames[id] == nil { held[id] = nil }
        var out: [UInt32: CGRect] = [:]
        for (id, f) in frames {
            if var h = held[id] {
                if f != h.frame { h.frame = f; h.since = now; h.moved = true }
                held[id] = h
                guard !buttonDown, !h.moved || now - h.since >= BorderPace.settle else { continue }
                held[id] = nil
            } else if let d = drawn[id], d != f {
                drawn[id] = nil
                held[id] = Held(frame: f, since: now, moved: true)
                continue
            }
            drawn[id] = f
            out[id] = f
        }
        return out
    }
}
