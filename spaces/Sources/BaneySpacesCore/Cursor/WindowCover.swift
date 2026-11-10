import CoreGraphics

/// One window as the window server lists it on screen, in the hands' coordinates (global, y down). A list of these
/// is front to back, the way `CGWindowListCopyWindowInfo(.optionOnScreenOnly)` returns it.
public struct ScreenWindow: Equatable, Sendable {
    public var id: UInt32
    public var pid: Int32
    /// The window level (`kCGWindowLayer`): 0 for app windows.
    public var layer: Int
    public var bounds: CGRect
    public var alpha: Double
    public init(id: UInt32, pid: Int32, layer: Int = 0, bounds: CGRect, alpha: Double = 1) {
        self.id = id; self.pid = pid; self.layer = layer; self.bounds = bounds; self.alpha = alpha
    }
}

/// Where the overlay for one target window goes: the window's frame and level. The overlay is ordered directly above it.
public struct CursorWindow: Equatable, Sendable {
    public var id: UInt32
    public var frame: CGRect
    public var layer: Int
    /// The window fills a display exactly, as a full-screen app's window does: only then may the overlay join a
    /// full-screen Space (`.fullScreenAuxiliary`).
    public var fullScreen: Bool
    public init(id: UInt32, frame: CGRect, layer: Int = 0, fullScreen: Bool = false) {
        self.id = id; self.frame = frame; self.layer = layer; self.fullScreen = fullScreen
    }
}

/// Whether an agent's cursor may be drawn over a window, from the window server's list alone. Pure, so it is tested
/// without a screen. The overlay is ordered directly above its window, so the window server hides whatever is under
/// another window; this decides when not to draw at all.
///
/// Only windows on the target's own level count as covering it. A window on a higher level (the menu bar, the Dock's
/// full-display window, a floating panel) is drawn over the overlay by the window server anyway, and the Dock keeps a
/// clear window the size of the display on its level all the time, which would otherwise cover everything.
///
/// Every other window in front counts, the target app's own too: a sheet or a popover can't be told apart from a second
/// document window of the same app, and drawing over a window the agent isn't using is the bug this guards. So the
/// cursor hides over a sheet in front of its window (the action still runs).
public enum WindowCover {
    public enum Verdict: Equatable, Sendable {
        case visible(CursorWindow)
        /// Minimized, closed, on another macOS Space, or parked off every display.
        case notOnScreen
        /// Another window in front of it covers the point.
        case covered
        /// The point is not inside the window: a cursor never draws outside its window.
        case outsideWindow
    }

    /// Where the overlay for `target` goes, or nil when the window is not on screen (not listed, fully transparent,
    /// empty, or on no display).
    public static func place(_ target: UInt32, windows: [ScreenWindow], displays: [CGRect] = []) -> CursorWindow? {
        guard let i = windows.firstIndex(where: { $0.id == target }) else { return nil }
        let w = windows[i]
        guard w.alpha > 0, w.bounds.width > 0, w.bounds.height > 0 else { return nil }
        if !displays.isEmpty, !displays.contains(where: { $0.intersects(w.bounds) }) { return nil }
        return CursorWindow(id: w.id, frame: w.bounds, layer: w.layer, fullScreen: displays.contains(w.bounds))
    }

    /// The whole decision for one action: the window is on screen, the point is inside it and nothing in front of it
    /// covers the point. `ignoring` holds the overlays' own window numbers.
    public static func check(_ target: UInt32, point: CGPoint, windows: [ScreenWindow], ignoring: Set<UInt32> = [], displays: [CGRect] = []) -> Verdict {
        guard let placed = place(target, windows: windows, displays: displays),
              let i = windows.firstIndex(where: { $0.id == target }) else { return .notOnScreen }
        guard placed.frame.insetBy(dx: -0.5, dy: -0.5).contains(point) else { return .outsideWindow }
        for j in 0..<i where counts(windows[j], over: windows[i], ignoring) && windows[j].bounds.contains(point) {
            return .covered
        }
        return .visible(placed)
    }

    /// Whether the overlay `overlay` sits directly above `window` in the list (nothing between them).
    public static func isDirectlyAbove(_ overlay: UInt32?, window: UInt32, windows: [ScreenWindow]) -> Bool {
        guard let overlay, let o = windows.firstIndex(where: { $0.id == overlay }),
              let a = windows.firstIndex(where: { $0.id == window }) else { return false }
        return o == a - 1
    }

    /// A window that can hide part of `target`: on its level, not an overlay, not fully transparent.
    private static func counts(_ o: ScreenWindow, over target: ScreenWindow, _ ignoring: Set<UInt32>) -> Bool {
        !ignoring.contains(o.id) && o.alpha > 0 && o.layer == target.layer && o.id != target.id
    }
}
