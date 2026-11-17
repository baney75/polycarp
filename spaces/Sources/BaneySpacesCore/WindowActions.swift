import CoreGraphics

public enum Direction: String, CaseIterable, Sendable {
    case left, right, up, down
}

/// A window action bound to a key (K2, W1). Spelled `window left-half`, `focus left`, `swap up`.
public enum WindowAction: Hashable, Sendable {
    case place(Placement)
    case center, maximize, restore, grow, shrink
    case focus(Direction), swap(Direction)
    case nextDisplay, previousDisplay

    public static let all: [WindowAction] = Placement.allCases.map { .place($0) }
        + [.center, .maximize, .restore, .grow, .shrink]
        + Direction.allCases.map { .focus($0) } + Direction.allCases.map { .swap($0) } + [.nextDisplay, .previousDisplay]

    public var spelling: String {
        switch self {
        case let .place(p): "window \(p.rawValue)"
        case .center: "window center"
        case .maximize: "window maximize"
        case .restore: "window restore"
        case .grow: "window grow"
        case .shrink: "window shrink"
        case let .focus(d): "focus \(d.rawValue)"
        case let .swap(d): "swap \(d.rawValue)"
        case .nextDisplay: "window next-display"
        case .previousDisplay: "window previous-display"
        }
    }

    public static func parse(_ text: String) -> WindowAction? { all.first { $0.spelling == text } }

    public var title: String {
        switch self {
        case let .place(p): p.title
        case .center: "Center the window"
        case .maximize: "Fill the screen, inside the menu bar and dock"
        case .restore: "Put the window back as it was"
        case .grow: "Make the window bigger"
        case .shrink: "Make the window smaller"
        case let .focus(d): "Focus the window to the \(d.rawValue)"
        case let .swap(d): "Swap places with the window to the \(d.rawValue)"
        case .nextDisplay: "Send the window to the next display"
        case .previousDisplay: "Send the window to the previous display"
        }
    }
}

/// Where a placement puts a window, as fractions of the usable area. A repeat cycles its sizes, as in Rectangle.
public enum Placement: String, CaseIterable, Sendable {
    case leftHalf = "left-half", rightHalf = "right-half", topHalf = "top-half", bottomHalf = "bottom-half"
    case topLeft = "top-left", topRight = "top-right", bottomLeft = "bottom-left", bottomRight = "bottom-right"
    case firstThird = "first-third", centerThird = "center-third", lastThird = "last-third"
    case firstTwoThirds = "first-two-thirds", lastTwoThirds = "last-two-thirds"

    public var title: String {
        switch self {
        case .leftHalf: "Left half (again: two thirds, one third)"
        case .rightHalf: "Right half (again: two thirds, one third)"
        case .topHalf: "Top half (again: two thirds, one third)"
        case .bottomHalf: "Bottom half (again: two thirds, one third)"
        case .topLeft: "Top left quarter"
        case .topRight: "Top right quarter"
        case .bottomLeft: "Bottom left quarter"
        case .bottomRight: "Bottom right quarter"
        case .firstThird: "First third (again: the next third)"
        case .centerThird: "Center third"
        case .lastThird: "Last third (again: the third before)"
        case .firstTwoThirds: "First two thirds"
        case .lastTwoThirds: "Last two thirds"
        }
    }

    /// How many sizes a repeat cycles through.
    var steps: Int {
        switch self {
        case .leftHalf, .rightHalf, .topHalf, .bottomHalf, .topLeft, .topRight, .bottomLeft, .bottomRight: 3
        case .firstThird, .lastThird: 3
        default: 1
        }
    }
}

/// The frame math for window actions: pure, in Accessibility coordinates (y down). Every result lies inside the usable
/// area; adjacent placements share an edge exactly.
public enum WindowLayout {
    /// A share of one axis: from `a` to `b` of its length.
    struct Span { let a: Double, b: Double }

    private static let cycle: [Double] = [1.0 / 2, 2.0 / 3, 1.0 / 3]

    /// The usable area: the display's visible frame (no menu bar, no macOS Dock) less what Polycarp keeps for its own
    /// dock while it stays up on that display.
    public static func usable(visible: CGRect, dock: (edge: DockEdge, thickness: CGFloat)?) -> CGRect {
        guard let dock, dock.thickness > 0 else { return visible }
        var r = visible
        switch dock.edge {
        case .bottom: r.size.height -= dock.thickness
        case .left: r.origin.x += dock.thickness; r.size.width -= dock.thickness
        case .right: r.size.width -= dock.thickness
        case .top: r.origin.y += dock.thickness; r.size.height -= dock.thickness
        }
        return r
    }

    /// The frame for `p` in `area`, at repeat `step` (0 the first press).
    public static func rect(_ p: Placement, in area: CGRect, step: Int = 0) -> CGRect {
        let f = cycle[step % cycle.count]
        let all = Span(a: 0, b: 1)
        func lead(_ f: Double) -> Span { Span(a: 0, b: f) }
        func trail(_ f: Double) -> Span { Span(a: 1 - f, b: 1) }
        // Thirds run along the long side: across a landscape display, down a portrait one.
        let portrait = area.height > area.width
        func third(_ s: Span) -> CGRect { portrait ? frame(area, x: all, y: s) : frame(area, x: s, y: all) }
        switch p {
        case .leftHalf: return frame(area, x: lead(f), y: all)
        case .rightHalf: return frame(area, x: trail(f), y: all)
        case .topHalf: return frame(area, x: all, y: lead(f))
        case .bottomHalf: return frame(area, x: all, y: trail(f))
        case .topLeft: return frame(area, x: lead(f), y: lead(0.5))
        case .topRight: return frame(area, x: trail(f), y: lead(0.5))
        case .bottomLeft: return frame(area, x: lead(f), y: trail(0.5))
        case .bottomRight: return frame(area, x: trail(f), y: trail(0.5))
        case .firstThird: return third([Span(a: 0, b: 1.0 / 3), Span(a: 1.0 / 3, b: 2.0 / 3), Span(a: 2.0 / 3, b: 1)][step % 3])
        case .lastThird: return third([Span(a: 2.0 / 3, b: 1), Span(a: 1.0 / 3, b: 2.0 / 3), Span(a: 0, b: 1.0 / 3)][step % 3])
        case .centerThird: return third(Span(a: 1.0 / 3, b: 2.0 / 3))
        case .firstTwoThirds: return third(Span(a: 0, b: 2.0 / 3))
        case .lastTwoThirds: return third(Span(a: 1.0 / 3, b: 1))
        }
    }

    /// Edges rounded to whole points from the area's own edges, so two halves meet with no gap or overlap.
    static func frame(_ area: CGRect, x: Span, y: Span) -> CGRect {
        func at(_ lo: CGFloat, _ len: CGFloat, _ f: Double) -> CGFloat { f >= 1 ? lo + len : (lo + len * f).rounded() }
        let x0 = at(area.minX, area.width, x.a), x1 = at(area.minX, area.width, x.b)
        let y0 = at(area.minY, area.height, y.a), y1 = at(area.minY, area.height, y.b)
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    /// `r` moved (and shrunk only if it must) to lie inside `area`.
    public static func fit(_ r: CGRect, in area: CGRect) -> CGRect {
        let w = min(r.width, area.width), h = min(r.height, area.height)
        let x = min(max(r.minX, area.minX), area.maxX - w)
        let y = min(max(r.minY, area.minY), area.maxY - h)
        return CGRect(x: x, y: y, width: w, height: h)
    }

    public static func centered(_ r: CGRect, in area: CGRect) -> CGRect {
        let w = min(r.width, area.width), h = min(r.height, area.height)
        return CGRect(x: (area.midX - w / 2).rounded(), y: (area.midY - h / 2).rounded(), width: w, height: h)
    }

    /// How far grow and shrink move each edge, and the smallest a shrink leaves.
    public static let resizeStep: CGFloat = 30
    public static let smallest = CGSize(width: 320, height: 200)

    /// Grows (or shrinks, with a negative `by`) every edge, keeping the middle, then keeps it inside the area.
    public static func resized(_ r: CGRect, by d: CGFloat, in area: CGRect) -> CGRect {
        let w = max(min(r.width + 2 * d, area.width), min(smallest.width, r.width))
        let h = max(min(r.height + 2 * d, area.height), min(smallest.height, r.height))
        return fit(CGRect(x: (r.midX - w / 2).rounded(), y: (r.midY - h / 2).rounded(), width: w, height: h), in: area)
    }

    /// The window to `d` of `from`, among `others` (front to back): the nearest whose middle lies that way at least as
    /// far as it lies off to the side, where a window beside it on the other axis counts nearer than one off to the side.
    /// Nil when there's none.
    public static func neighbor(of from: CGRect, toward d: Direction, among others: [(id: WindowID, frame: CGRect)]) -> WindowID? {
        func score(_ r: CGRect) -> CGFloat? {
            let ahead: CGFloat, side: CGFloat, off: CGFloat
            switch d {
            case .left: ahead = from.midX - r.midX; side = r.midY - from.midY; off = gap(from.minY, from.maxY, r.minY, r.maxY)
            case .right: ahead = r.midX - from.midX; side = r.midY - from.midY; off = gap(from.minY, from.maxY, r.minY, r.maxY)
            case .up: ahead = from.midY - r.midY; side = r.midX - from.midX; off = gap(from.minX, from.maxX, r.minX, r.maxX)
            case .down: ahead = r.midY - from.midY; side = r.midX - from.midX; off = gap(from.minX, from.maxX, r.minX, r.maxX)
            }
            // A window mostly below is not "left" because its middle sits a little left.
            return ahead > 1 && ahead >= abs(side) ? ahead + 3 * off : nil
        }
        var best: (WindowID, CGFloat)?
        for o in others {
            guard let s = score(o.frame), s < (best?.1 ?? .infinity) else { continue }
            best = (o.id, s)
        }
        return best?.0
    }

    private static func gap(_ a0: CGFloat, _ a1: CGFloat, _ b0: CGFloat, _ b1: CGFloat) -> CGFloat {
        max(0, max(a0, b0) - min(a1, b1))
    }

    /// The display after (or before) `current`, left to right, wrapping. Nil with one display.
    public static func display(after current: DisplayKey, in displays: [(key: DisplayKey, frame: CGRect)], backward: Bool = false) -> DisplayKey? {
        let sorted = displays.sorted { ($0.frame.minX, $0.frame.minY) < ($1.frame.minX, $1.frame.minY) }
        guard sorted.count > 1, let i = sorted.firstIndex(where: { $0.key == current }) else { return nil }
        return sorted[(i + (backward ? sorted.count - 1 : 1)) % sorted.count].key
    }
}

/// What the actions remember per window: the frame to restore, and the last placement, so a repeat cycles sizes and a
/// move to another display keeps the placement.
public struct WindowActionMemory: Sendable {
    public struct Last: Equatable, Sendable {
        public let action: WindowAction
        public let step: Int
        /// Where the window landed, read back: a repeat counts only while it is still there.
        public let landed: CGRect
    }

    public private(set) var before: [WindowID: CGRect] = [:]
    public private(set) var last: [WindowID: Last] = [:]

    public init() {}

    /// Within 2 points: an app that snaps its size to text cells lands a little short.
    public static func same(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) <= 2 && abs(a.minY - b.minY) <= 2 && abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2
    }

    /// The repeat for pressing `action` on window `id` that now has `frame`: one more than last time when it's the same
    /// action and the window hasn't moved since, else 0.
    public func step(_ action: WindowAction, window id: WindowID, frame: CGRect) -> Int {
        guard let l = last[id], l.action == action, Self.same(l.landed, frame) else { return 0 }
        return l.step + 1
    }

    /// The window is about to move from `frame` by an action. The first action, or the first after the person moved it,
    /// keeps `frame` to restore.
    public mutating func willMove(_ id: WindowID, from frame: CGRect) {
        if let l = last[id], Self.same(l.landed, frame), before[id] != nil { return }
        before[id] = frame
    }

    public mutating func landed(_ id: WindowID, _ action: WindowAction, step: Int, at frame: CGRect) {
        last[id] = Last(action: action, step: step, landed: frame)
    }

    /// Restore: the frame kept, once, then forgotten.
    public mutating func restore(_ id: WindowID) -> CGRect? {
        last[id] = nil
        return before.removeValue(forKey: id)
    }

    public mutating func keep(only alive: Set<WindowID>) {
        before = before.filter { alive.contains($0.key) }
        last = last.filter { alive.contains($0.key) }
    }
}
