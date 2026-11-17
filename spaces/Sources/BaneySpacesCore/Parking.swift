import CoreGraphics

/// Where a window waits while its workspace isn't shown, and how it gets there. All frames are in Accessibility
/// coordinates: top-left origin of the primary display, y down.
public enum Parking {
    public enum Corner: String, Equatable, Sendable {
        /// The window's own display, bottom-right: the window hangs off to the right and below.
        case bottomRight
        /// The window's own display, bottom-left: the window hangs off to the left and below.
        case bottomLeft
        /// The corner of all displays that reaches furthest down and right (`Geometry.hidingSpot`).
        case furthest
    }

    /// Where a window that stood at `frame` waits: a corner of its own display, so it never crosses to another one,
    /// with one point left on that display because macOS pulls a window that is wholly off screen back into view.
    /// Bottom-right first (the spot Polycarp always used), then bottom-left, whichever puts no part of the window over
    /// another display (scored the way AeroSpace's `hideInCorner` picks a corner, but by the window's real size). When
    /// both would show on a neighbor, or the frame is on no display, the furthest corner of all, which hangs off every
    /// display.
    public static func spot(for frame: CGRect, screens: [CGRect]) -> CGPoint { place(frame, screens: screens).spot }

    public static func place(_ frame: CGRect, screens: [CGRect]) -> (corner: Corner, spot: CGPoint) {
        let furthest = (Corner.furthest, Geometry.hidingSpot(screens: screens))
        let keyed = Dictionary(uniqueKeysWithValues: screens.enumerated().map { ($0.offset, $0.element) })
        guard frame.width > 0, frame.height > 0, let i = Geometry.display(of: frame, in: keyed) else { return furthest }
        let own = screens[i]
        let candidates: [(Corner, CGPoint)] = [
            (.bottomRight, CGPoint(x: own.maxX - 1, y: own.maxY - 1)),
            (.bottomLeft, CGPoint(x: own.minX - frame.width + 1, y: own.maxY - 1)),
        ]
        for (corner, p) in candidates where seen(CGRect(origin: p, size: frame.size), besides: i, screens: screens) == 0 {
            return (corner, p)
        }
        return furthest
    }

    /// How much of a parked window's frame lies over displays other than display `own`.
    public static func seen(_ parked: CGRect, besides own: Int, screens: [CGRect]) -> CGFloat {
        screens.enumerated().reduce(CGFloat(0)) { sum, s in
            guard s.offset != own else { return sum }
            let i = s.element.intersection(parked)
            return i.isNull ? sum : sum + i.width * i.height
        }
    }

    /// How a window goes to or from its spot.
    public enum Route: Equatable, Sendable {
        /// One Accessibility move, in place. It lands in one frame: `Window.withoutAnimation` turns off the
        /// AXEnhancedUserInterface animation that made windows slide (ledger, 10-13).
        case direct
        /// Its app hides first, the window moves while off screen, and the app shows again. That costs a hide, a wait
        /// for the window server and an unhide (40 to 100 ms per switch on Donovan's Mac), so it is kept for the one case
        /// that needs it: an app seen animating its moves anyway, with the window's path in sight.
        case whileHidden
    }

    /// `hidden`: its app is hidden already, so the move is unseen. `animates`: the app is on `SlowMovers`.
    /// `undoesMovesOnUnhide`: the app puts the window back when unhidden (`UnhideUndoesMoves`), so hiding around the
    /// move would undo it. `covered` is asked last, since it reads the window list.
    public static func route(hidden: Bool, animates: Bool, undoesMovesOnUnhide: Bool, covered: () -> Bool) -> Route {
        if hidden || !animates || undoesMovesOnUnhide { return .direct }
        return covered() ? .direct : .whileHidden
    }

    /// Whether a window sent to `target` has landed: exactly there, or, when the app placed it a little differently,
    /// still for `stillFor` seconds where it can't be seen (`away`) or can (coming home).
    public static func landed(_ frame: CGRect, target: CGPoint?, away: Bool, still: Double, stillFor: Double = 0.05,
                              screens: [CGRect]) -> Bool {
        if let target, abs(frame.minX - target.x) < 1, abs(frame.minY - target.y) < 1 { return true }
        return still >= stillFor && Geometry.isStranded(frame, screens: screens) == away
    }
}
