import CoreGraphics

/// How a drag of a window's title bar ended, as `TopDragWatcher` saw it.
public struct DragEnd: Equatable, Sendable {
    /// Where the button came up, in window-server coordinates (top-left origin).
    public var pointer: CGPoint
    /// The window's frame when Polycarp's overview opened over it and took the drag. Nil when nothing of Polycarp's
    /// covered the window, so the person saw where they put it.
    public var coveredFrom: CGRect?
    /// The release dropped the window on a workspace (an overview or dock tile): the drop moves it, nothing else may.
    public var dropped: Bool

    public init(pointer: CGPoint, coveredFrom: CGRect?, dropped: Bool) {
        self.pointer = pointer
        self.coveredFrom = coveredFrom
        self.dropped = dropped
    }
}

/// What Polycarp does with a window once a drag of it ends and it holds still. Almost always nothing: a window the person
/// dragged partly off the screen stays there, as macOS allows. Two exceptions:
///
/// - The overview covered the window and the drag ended over no workspace. The person dragged it blind (Donovan,
///   2026-11-12: Helium let go about (-608, 478), 40% off the left edge, which macOS then saved as its untiled frame), so
///   it goes back to the frame it had when the overview opened.
/// - No part of the title bar is on any display: it comes back just far enough to grab.
public enum DragRelease {
    /// A release this close to a display's top, left or right edge is one macOS tiles (fill the screen, or a half), and
    /// its tile animation is still running. Nothing is corrected there.
    public static let edgeBand: CGFloat = 6
    /// How much title bar a rescued window shows, and how tall a title bar is taken to be.
    public static let grip: CGFloat = 40
    public static let titleHeight: CGFloat = 28

    public enum Correction: Equatable, Sendable {
        case backToBeforeOverview(CGRect)
        case titleBarBackInReach(CGRect)

        public var frame: CGRect {
            switch self {
            case let .backToBeforeOverview(f), let .titleBarBackInReach(f): f
            }
        }
    }

    /// `displays` are in window-server coordinates: each display's whole frame and its visible area.
    public static func correction(for frame: CGRect, after end: DragEnd, displays: [(frame: CGRect, visible: CGRect)]) -> Correction? {
        guard !end.dropped, frame.width > 0, frame.height > 0 else { return nil }
        if let d = displays.first(where: { $0.frame.contains(end.pointer) }) {
            let p = end.pointer
            if p.x <= d.frame.minX + edgeBand || p.x >= d.frame.maxX - edgeBand || p.y <= d.frame.minY + edgeBand { return nil }
        }
        if let from = end.coveredFrom {
            let same = abs(from.minX - frame.minX) < 1 && abs(from.minY - frame.minY) < 1
                && abs(from.width - frame.width) < 1 && abs(from.height - frame.height) < 1
            return same ? nil : .backToBeforeOverview(from)
        }
        let bar = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: titleHeight)
        guard !displays.contains(where: { $0.visible.intersects(bar) }) else { return nil }
        func distance(_ v: CGRect) -> CGFloat {
            let dx = max(v.minX - bar.midX, 0, bar.midX - v.maxX), dy = max(v.minY - bar.midY, 0, bar.midY - v.maxY)
            return dx * dx + dy * dy
        }
        guard let v = displays.map(\.visible).min(by: { distance($0) < distance($1) }) else { return nil }
        let x = min(max(frame.minX, v.minX + grip - frame.width), v.maxX - grip)
        let y = min(max(frame.minY, v.minY), v.maxY - titleHeight)
        return .titleBarBackInReach(CGRect(x: x.rounded(), y: y.rounded(), width: frame.width, height: frame.height))
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
