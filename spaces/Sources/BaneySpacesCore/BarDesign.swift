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
    /// The room either side of a symbol in its slot (about 17 pt of ink in 27). A glyph wider than the slot (the
    /// battery) keeps it, so the gaps between status items stay even.
    public static let glyphSide = 5.0
    /// The battery's button: the glyph with a symbol's room either side, up to a whole point so the items beside it
    /// stay on whole pixels at 1x.
    public static var battery: Double { (BatteryGlyphSpec.width + 2 * glyphSide).rounded(.up) }
    /// The most room the battery takes, its charge in digits included (`bar.batteryPercent`) at `textSize`: "100%" in
    /// monospaced digits of about 0.62 em, 4 pt from the glyph. The drawer counts this, so it never opens too wide.
    public static func battery(percentAt textSize: Double?) -> Double {
        guard let textSize else { return battery }
        return battery + (4 + 4 * 0.62 * textSize).rounded(.up)
    }
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

    /// The least the middle's row is shortened to before icons go.
    static let least = 120.0

    /// Beside a notch: the middle's modules (the clock) at the notch, the side's own at the screen's edge. The widths of both rows in `room`: the side's own row
    /// is whole while the middle's keeps `least`, so a long verse shortens instead of pushing icons off. When even that
    /// doesn't fit, icons go and the middle's keeps `BarLayout.middleShare` of the room.
    public static func widths(lead: Double, trail: Double, gap: Double, room: Double) -> (lead: Double, trail: Double) {
        guard lead > 0 else { return (0, min(trail, room)) }
        guard trail > 0 else { return (min(lead, room), 0) }
        let space = max(0, room - gap)
        if lead + trail <= space { return (lead, trail) }
        let kept = min(lead, trail <= space - least ? space - trail : space * BarLayout.middleShare)
        return (kept, max(0, space - kept))
    }
}

/// What the drawer in the `status` module holds and when it is open.
public enum BarTray {
    /// The places in the status row: your apps' items, which fold away, and macOS's own, which stay. Each keeps its
    /// place in the list, which is what a click presses.
    public static func split(_ items: [BarStatus.Item]) -> (apps: [Int], system: [Int]) {
        let places = Array(items.indices)
        return (places.filter { !items[$0].isSystem }, places.filter { items[$0].isSystem })
    }

    /// One item takes no more room than the button that would hide it, so it stays out.
    public static func folds(_ apps: Int) -> Bool { apps > 1 }

    /// How many of the drawer's items open over a row with this much room.
    public static func open(_ apps: Int, room: Double) -> Int { max(0, min(apps, Int(room / BarGeometry.slot))) }

    /// How long the pointer can leave the drawer before it closes.
    public static let linger = 0.35
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
    /// Quiet this long begins another gesture on a device that doesn't say when one begins.
    static let rest = 0.3

    public init() {}

    /// -1 for the workspace before, 1 for the next, 0 to stay. `precise` is a trackpad's points rather than a wheel's
    /// clicks, one step a gesture, which `began` starts on a device that is `phased`; fingers held still don't end one.
    /// `momentum` is the glide after the fingers lift, which never switches, and neither does a swipe more `across` than
    /// down.
    public mutating func step(_ delta: Double, across: Double = 0, precise: Bool, phased: Bool = false, began: Bool = false,
                              momentum: Bool = false, at time: Double) -> Int {
        if began || !phased && time - seen > Self.rest { (carried, done) = (0, false) }
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

    /// The workspace `way` along from `n` among the ones drawn, or nil at either end. One another display shows
    /// (`elsewhere`) is passed over: going to it leaves this display where it was, so the wheel would stop there.
    public static func target(from n: Int, way: Int, shown: [Int], elsewhere: Set<Int> = []) -> Int? {
        let stops = shown.filter { $0 == n || !elsewhere.contains($0) }
        guard way != 0, let i = stops.firstIndex(of: n), stops.indices.contains(i + way) else { return nil }
        return stops[i + way]
    }
}
