import CoreGraphics

/// Where a window goes once a drag of it ends: on screen. A drag can leave a window mostly off the screen without anyone
/// seeing it happen, as when the overview is up over the window and the drag ends over no workspace (Donovan, 2026-11-12:
/// Helium let go at about (-608, 478), 40% off the left edge). macOS then saves that frame as the window's "untiled" size
/// on the next drag to the top, and gives it back off screen when the window is dragged down again.
public enum DragRelease {
    /// A release this close to a display's top, left or right edge is one macOS tiles (fill the screen, or a half), and
    /// its tile animation is still running. The bottom edge tiles nothing: a window let go at the dock's edge counts.
    public static let edgeBand: CGFloat = 6

    /// The frame that puts `frame` inside its display's visible area, moved as little as possible and never resized.
    /// Nil when it's already inside, or the release was in one of macOS's tile zones. `displays` are in window-server
    /// coordinates (top-left origin): each display's whole frame and its visible area.
    public static func onScreen(_ frame: CGRect, releasedAt p: CGPoint, displays: [(frame: CGRect, visible: CGRect)]) -> CGRect? {
        guard frame.width > 0, frame.height > 0, let d = displays.first(where: { $0.frame.contains(p) }) else { return nil }
        if p.x <= d.frame.minX + edgeBand || p.x >= d.frame.maxX - edgeBand || p.y <= d.frame.minY + edgeBand { return nil }
        let v = d.visible
        let x = frame.width >= v.width ? v.minX : min(max(frame.minX, v.minX), v.maxX - frame.width)
        let y = frame.height >= v.height ? v.minY : min(max(frame.minY, v.minY), v.maxY - frame.height)
        let next = CGRect(x: x.rounded(), y: y.rounded(), width: frame.width, height: frame.height)
        return abs(next.minX - frame.minX) < 1 && abs(next.minY - frame.minY) < 1 ? nil : next
    }
}

/// Whether a window under a press can take it. The window server routes a press past a fully transparent window and past
/// one that ignores mouse events (a screen recorder's overlay). `tags` are SkyLight's window tags: measured on macOS 27,
/// `ignoresMouseEvents` sets bit 9 and clears bit 10 (`SLSGetWindowTags`, 2026-11-12).
public enum PressTarget {
    public static let ignoresEventsTag: UInt64 = 1 << 9

    public static func takesPress(alpha: Double?, tags: UInt64?) -> Bool {
        if let alpha, alpha == 0 { return false }
        if let tags, tags & ignoresEventsTag != 0 { return false }
        return true
    }
}
