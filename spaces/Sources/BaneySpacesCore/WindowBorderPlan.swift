import CoreGraphics
import Foundation

// Themed window borders (T5): a border in the theme's accent around the focused window and, optionally, one in its
// border color around the others. Polycarp draws them in its own clear windows that follow each window's frame; it
// never touches another app. These are the pure parts: the style a look gives, which windows get one, how fast to
// follow, and how late a border was. The windows themselves are `WindowBorders` in the app.

/// What a border looks like, all from the look in force.
public struct WindowBorderStyle: Equatable, Sendable {
    public var focused: RGB
    public var unfocused: RGB
    /// Points, drawn wholly outside the window.
    public var width: Double
    /// The corner radius of the window's own edge; the stroke's centre line is `width / 2` further out.
    public var radius: Double

    /// For a look whose border has no width (most built-ins draw none on their panels).
    public static let defaultWidth = 2.0
    public static let widthRange: ClosedRange<Double> = 1...8

    public init(focused: RGB, unfocused: RGB, width: Double, radius: Double) {
        self.focused = focused; self.unfocused = unfocused; self.width = width; self.radius = radius
    }

    /// The theme's focused role and width (`shape.border_width` times 1.5 in a Polycarp theme), its border role, and
    /// its large radius (`shape.radius_large`, the dock bar's). No new theme fields.
    public init(_ look: Look) {
        let b = look.spec.border
        let w = b.focusedWidth > 0 ? b.focusedWidth : (b.width > 0 ? b.width : WindowBorderStyle.defaultWidth)
        self.init(focused: look.color(b.focusedRole), unfocused: look.color(b.role),
                  width: min(WindowBorderStyle.widthRange.upperBound, max(WindowBorderStyle.widthRange.lowerBound, w)),
                  radius: max(0, look.spec.radius.bar))
    }

    /// The border window for a window frame: the frame grown by the width on every side.
    public func panelFrame(_ window: CGRect) -> CGRect { window.insetBy(dx: -width, dy: -width) }

    /// The stroke's centre line inside a border window of `size`, and its corner radius.
    public func stroke(in size: CGSize) -> (rect: CGRect, radius: Double) {
        (CGRect(origin: .zero, size: size).insetBy(dx: width / 2, dy: width / 2), radius > 0 ? radius + width / 2 : 0)
    }
}

/// One window as the window server lists it (front to back), in global coordinates with y down.
public struct BorderCandidate: Equatable, Sendable {
    public var id: UInt32
    public var pid: Int32
    public var frame: CGRect
    public var layer: Int
    public var alpha: Double
    public init(id: UInt32, pid: Int32, frame: CGRect, layer: Int = 0, alpha: Double = 1) {
        self.id = id; self.pid = pid; self.frame = frame; self.layer = layer; self.alpha = alpha
    }
}

public enum WindowBorderPlan {
    /// Smaller than this on a side (a sliver, a helper) gets no border; so does a window with less than this square on any display.
    public static let minSide = 50.0
    /// The most borders drawn at once, unfocused ones included.
    public static let limit = 32

    /// Whether a window can carry a border: an ordinary window (layer 0, drawn), not Polycarp's own, big enough, mostly on
    /// a display (a parked window is not), and not a full-screen one (it fills its display exactly).
    public static func eligible(_ w: BorderCandidate, selfPID: Int32, screens: [CGRect]) -> Bool {
        guard w.layer == 0, w.alpha > 0, w.pid != selfPID, w.frame.width >= minSide, w.frame.height >= minSide else { return false }
        guard !screens.contains(where: { $0 == w.frame }) else { return false }
        return screens.contains { s in
            let i = s.intersection(w.frame)
            return !i.isNull && i.width >= minSide && i.height >= minSide
        }
    }

    /// The focused window is the front eligible window of the app in front; with `others`, every other eligible window
    /// gets the unfocused border, front first, up to `limit` in all.
    public static func targets(_ list: [BorderCandidate], frontPID: Int32?, selfPID: Int32, screens: [CGRect],
                               others: Bool) -> (focused: UInt32?, others: [UInt32]) {
        let ok = list.filter { eligible($0, selfPID: selfPID, screens: screens) }
        let focused = frontPID.flatMap { pid in ok.first { $0.pid == pid }?.id }
        guard others else { return (focused, []) }
        let rest = ok.filter { $0.id != focused }.map(\.id)
        return (focused, Array(rest.prefix(limit - (focused == nil ? 0 : 1))))
    }
}

/// How fast a border follows its window. Every display frame while a button is down or the window moved within
/// `settle`; otherwise a cheap look `idleInterval` apart, which notices a keyboard move or a resize and turns the pace up.
public struct BorderPace: Equatable, Sendable {
    public static let settle = 0.4
    public static let idleInterval = 0.1
    private var lastMove = -Double.infinity

    public init() {}

    /// After one look at the window: true to follow it every display frame.
    public mutating func look(moved: Bool, buttonDown: Bool, now: Double) -> Bool {
        if moved { lastMove = now }
        return buttonDown || now - lastMove < BorderPace.settle
    }
}

/// How late a border was. The window's side says when it went to each place; the border's side says when it moved a
/// border for the window at some place. Both are times on the same clock (`systemUptime`), so no sampling sits between.
public enum BorderLag {
    public struct Move: Equatable, Sendable {
        public var t: Double
        public var at: CGPoint
        public init(t: Double, at: CGPoint) { self.t = t; self.at = at }
    }

    /// For every place the window went, the time until a border was moved for it or for a later place (a border that
    /// skips to the newest place has caught up with the ones in between). A place no border reached before `end`
    /// counts until `end`, so a border that falls behind can't look fast.
    public static func lags(window: [Move], border: [Move], end: Double) -> [Double] {
        var out: [Double] = []
        var next = 0
        for b in border.sorted(by: { $0.t < $1.t }) {
            // The latest place the window had gone to by then that matches what the border saw.
            var j = window.count - 1
            while j >= next, window[j].t > b.t { j -= 1 }
            while j >= next, window[j].at != b.at { j -= 1 }
            guard j >= next else { continue }
            for i in next...j { out.append(b.t - window[i].t) }
            next = j + 1
        }
        for i in next..<window.count where window[i].t < end { out.append(end - window[i].t) }
        return out
    }
}
