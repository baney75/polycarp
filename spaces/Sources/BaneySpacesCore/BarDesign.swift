import Foundation

/// The bar's one geometry. Every icon sits in the same slot whatever its own shape, so the row keeps one rhythm, and
/// everything you can click has the same face behind it.
public enum BarGeometry {
    /// An icon's slot, across.
    public static let slot = 27.0
    /// An app's own icon.
    public static let canvas = 16.0
    /// A symbol's point size: about 13 of ink in the slot.
    public static let symbol = 13.0
    /// A title's room either side, inside its face.
    public static let textInset = 6.0
    /// A workspace number's slot, across.
    public static let number = 23.0
    /// Between two groups (`|` in a module list) of a bar with no islands.
    public static let group = 8.0
    /// From the screen's edge to the first slot.
    public static let edge = 7.0

    /// The height of the face behind what the pointer is on, in a bar this tall: inside the bar's own height, and no
    /// taller than a button in the strip beside a notch.
    public static func face(bar height: Double) -> Double { min(24, max(14, height - 4)) }
}

/// How the bar's rows share a width.
public enum BarSides {
    /// A screen without a notch: the middle's width, what it needs up to `BarLayout.middleShare`, and each side's.
    public static func middle(ideal: Double, gap: Double, room: Double) -> (middle: Double, side: Double) {
        let middle = min(ideal, room * BarLayout.middleShare)
        return (middle, max(0, (room - middle) / 2 - (middle > 0 ? gap : gap / 2)))
    }

    /// Beside a notch: the middle's modules (the clock) at the notch, the side's own at the screen's edge. The widths of both rows in `room`: the side's own row is whole while it fits, and the middle's gives way to it
    /// down to `BarLayout.middleShare` of the room, so a long verse shortens instead of pushing icons off.
    public static func widths(lead: Double, trail: Double, gap: Double, room: Double) -> (lead: Double, trail: Double) {
        guard lead > 0 else { return (0, min(trail, room)) }
        guard trail > 0 else { return (min(lead, room), 0) }
        let space = max(0, room - gap)
        if lead + trail <= space { return (lead, trail) }
        let kept = min(lead, max(space * BarLayout.middleShare, space - trail))
        return (kept, max(0, space - kept))
    }
}

/// The wheel over the workspaces: one workspace a step, however the wheel reports itself.
public struct BarScroll: Equatable, Sendable {
    private var carried = 0.0
    private var last = -Double.infinity
    private var seen = -Double.infinity
    private var done = false
    /// A trackpad's points for one workspace.
    static let points = 28.0
    /// The least time between two steps.
    static let pause = 0.14
    /// A trackpad quiet this long has begun another gesture, where it doesn't say so itself.
    static let rest = 0.3

    public init() {}

    /// -1 for the workspace before, 1 for the next, 0 to stay. `precise` is a trackpad's points rather than a wheel's
    /// clicks, one step a gesture, which `began` starts; `momentum` is the glide after the fingers lift, which never
    /// switches, and neither does a swipe more `across` than down.
    public mutating func step(_ delta: Double, across: Double = 0, precise: Bool, began: Bool = false, momentum: Bool = false,
                              at time: Double) -> Int {
        if began || time - seen > Self.rest { (carried, done) = (0, false) }
        seen = time
        guard !momentum, delta != 0, abs(delta) >= abs(across), !(precise && done) else { return 0 }
        if carried * delta < 0 { carried = 0 }
        carried += precise ? delta : delta.sign == .minus ? -Self.points : Self.points
        guard abs(carried) >= Self.points else { return 0 }
        let way = carried < 0 ? 1 : -1
        carried = 0
        guard time - last >= Self.pause else { return 0 }
        (last, done) = (time, true)
        return way
    }

    /// The workspace `way` along from `n` among the ones drawn, or nil at either end.
    public static func target(from n: Int, way: Int, shown: [Int]) -> Int? {
        guard way != 0, let i = shown.firstIndex(of: n), shown.indices.contains(i + way) else { return nil }
        return shown[i + way]
    }
}
