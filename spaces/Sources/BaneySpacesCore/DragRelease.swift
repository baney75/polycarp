import CoreGraphics

/// How a drag of a window's title bar ended, as `TopDragWatcher` saw it.
public struct DragEnd: Equatable, Sendable {
    /// Where the button came up, in window-server coordinates (top-left origin).
    public var pointer: CGPoint
    /// The window's frame when Polycarp's overview opened over it, set only when the overview was still showing over the
    /// display the button came up on. Nil when the person could see where they put the window.
    public var coveredFrom: CGRect?
    /// The release dropped the window on a workspace (an overview or dock tile): the drop moves it, nothing else may.
    public var dropped: Bool

    public init(pointer: CGPoint, coveredFrom: CGRect?, dropped: Bool) {
        self.pointer = pointer
        self.coveredFrom = coveredFrom
        self.dropped = dropped
    }
}

/// The order `TopDragWatcher` ends a drag in. Whether the overview covers the release is asked first, because ending the
/// overview closes it; then the dock carry ends, then the overview's own release. Either one dropping the window makes
/// it a drop.
public enum ReleaseOrder {
    public static func end(at pointer: CGPoint, coveredFrom: CGRect?, overviewCovers: () -> Bool,
                           endCarry: () -> Bool, release: (() -> Bool)?) -> DragEnd {
        let covered = coveredFrom != nil && overviewCovers() ? coveredFrom : nil
        var dropped = endCarry()
        if let release { dropped = release() || dropped }
        return DragEnd(pointer: pointer, coveredFrom: covered, dropped: dropped)
    }
}

/// Waits, a look every 20 ms, for a window to hold still after a drag: `stillLooks` unchanged looks in a row (three by
/// default), and at least five in all, so the window server, the app and a tile animation have finished. Every change
/// starts the stillness over, so an app setting its own frame just after the release, or macOS animating a tile, is
/// waited out and the decision comes from where the window rests. Gives up after `giveUpAfter` looks in all (25, 0.5 s)
/// without that much stillness: an app animating its own frame is left alone, since moving it then would fight the
/// animation. `DragRelease.settleWatch` picks the watch for a release; `waitsForTile` marks the long side-edge wait.
public struct SettleWatch: Sendable {
    public enum Verdict: Equatable, Sendable { case wait, still, gaveUp }
    public private(set) var looks = 0
    public let stillLooks: Int
    public let giveUpAfter: Int
    public let waitsForTile: Bool
    private var still = 0
    private var last: CGRect?

    public init(from frame: CGRect?, stillLooks: Int = 3, giveUpAfter: Int = 25, waitsForTile: Bool = false) {
        last = frame
        self.stillLooks = stillLooks
        self.giveUpAfter = giveUpAfter
        self.waitsForTile = waitsForTile
    }

    public mutating func look(_ frame: CGRect?) -> Verdict {
        looks += 1
        still = frame == last ? still + 1 : 0
        last = frame
        if looks >= 5 && still >= stillLooks { return .still }
        return looks >= giveUpAfter ? .gaveUp : .wait
    }
}

/// Windows waiting to hold still after a drag before Polycarp may correct them, each with its watch and how its drag
/// ended. Only a press on the window or a new drag of it cancels its wait (`cancel`), since then the old release no
/// longer says where the person wants it (review of #155). A click anywhere else leaves the wait alone: a blind drop must
/// still come back though the person clicks the Dock in that second (review of #158). While a button is down the
/// correction holds off, in case the press was on the window and Polycarp missed it, and runs once the button is up.
public struct PendingSettles: Sendable {
    public enum Outcome: Equatable, Sendable {
        case wait
        case correct(DragEnd)
        case leftAlone(String)
        /// Nothing waits for this window: cancelled, or already decided.
        case none
    }
    private var pending: [WindowID: (watch: SettleWatch, end: DragEnd)] = [:]

    public init() {}

    public mutating func start(_ id: WindowID, watch: SettleWatch, end: DragEnd) { pending[id] = (watch, end) }

    /// The window was pressed or dragged again: its wait ends with nothing done.
    public mutating func cancel(_ id: WindowID) { pending[id] = nil }

    /// One look, 20 ms after the last, at `id`'s frame. `buttonDown` is whether any mouse button is down now.
    public mutating func look(_ id: WindowID, frame: CGRect?, buttonDown: Bool) -> Outcome {
        guard var p = pending.removeValue(forKey: id) else { return .none }
        switch p.watch.look(frame) {
        case .wait:
            pending[id] = p
            return .wait
        case .still:
            guard let _ = frame else { return .leftAlone("its frame can't be read") }
            guard buttonDown else { return .correct(p.end) }
            // Held off while a button is down, as long as the watch would have waited anyway.
            if p.watch.looks >= p.watch.giveUpAfter { return .leftAlone("a button stayed down \(p.watch.looks * 20) ms after the release") }
            pending[id] = p
            return .wait
        case .gaveUp: return .leftAlone("still moving: no \(p.watch.stillLooks * 20) ms rest within \(p.watch.looks * 20) ms")
        }
    }
}

/// What Polycarp does with a window once a drag of it ends and it holds still. Almost always nothing: a window the person
/// dragged partly off the screen stays there, as macOS allows. Two exceptions:
///
/// - The overview was over the window when the drag ended over no workspace. The person dragged it blind (Donovan,
///   2026-11-12: Helium let go about (-608, 478), 40% off the left edge, which macOS then saved as its untiled frame), so
///   it goes back to the frame it had when the overview opened, unless macOS tiled it or it ended in plain sight.
/// - No part of the title bar is on any display: it comes back just far enough to grab.
public enum DragRelease {
    /// A release this close to a display's outer top, left or right edge is one macOS may tile (fill the screen, or a
    /// half). An edge another display touches is a seam, where the pointer just crosses over, and tiles nothing.
    public static let edgeBand: CGFloat = 6
    /// How much title bar a rescued window shows, and how tall a title bar is taken to be.
    public static let grip: CGFloat = 40
    public static let titleHeight: CGFloat = 28
    /// macOS fills a little past the visible area (Donovan's Mac: 949 tall in a 947 visible area).
    public static let tileSlack: CGFloat = 3

    public enum Correction: Equatable, Sendable {
        case backToBeforeOverview(CGRect)
        case titleBarBackInReach(CGRect)

        public var frame: CGRect {
            switch self {
            case let .backToBeforeOverview(f), let .titleBarBackInReach(f): f
            }
        }
    }

    /// macOS can pause before it animates a window let go at a side edge into a half, and that pause hasn't been measured
    /// yet (`fill-drag-probe.swift --no-polycarp`, case 6, prints it). Until it is, a covered release there must rest a
    /// generous 1 s before Polycarp decides; each move, macOS's tile or the app's own, starts that second over, and the
    /// window is judged where it rests (review of #158). Past 2 s without such a rest it is left alone.
    public static let sideTileStillLooks = 50
    public static let sideTileGiveUpAfter = 100

    public enum Edge: Sendable { case top, left, right }

    /// The outer edge of `d` that `p` is within `edgeBand` of, among `edges`. Nil at a seam: where another display
    /// touches that edge right at the pointer. Elsewhere along the same edge, past the other display, macOS still tiles.
    public static func tileEdge(_ p: CGPoint, on d: CGRect, displays: [CGRect], edges: [Edge]) -> Edge? {
        func touched(_ e: Edge) -> Bool {
            displays.contains { o in
                guard o != d else { return false }
                switch e {
                case .top: return abs(o.maxY - d.minY) < 1 && o.minX <= p.x && p.x < o.maxX
                case .left: return abs(o.maxX - d.minX) < 1 && o.minY <= p.y && p.y < o.maxY
                case .right: return abs(o.minX - d.maxX) < 1 && o.minY <= p.y && p.y < o.maxY
                }
            }
        }
        return edges.first { e in
            let near: Bool
            switch e {
            case .top: near = p.y <= d.minY + edgeBand
            case .left: near = p.x <= d.minX + edgeBand
            case .right: near = p.x >= d.maxX - edgeBand
            }
            return near && !touched(e)
        }
    }

    /// How long to wait for the window to hold still before `correction` looks at it. A covered release in a side edge's
    /// band waits out macOS's half tile (review of #154, first-F2): moved back mid-animation, the window would fight it.
    /// A pointer pushed past a display's side ends up on no display; it counts in the side band of the nearest one, as
    /// `correction` reads it (review of #155, second-F7).
    public static func settleWatch(from frame: CGRect?, after end: DragEnd, displays: [(frame: CGRect, visible: CGRect)]) -> SettleWatch {
        guard end.coveredFrom != nil, !end.dropped, let d = display(of: end.pointer, in: displays) else { return SettleWatch(from: frame) }
        let p = CGPoint(x: min(max(end.pointer.x, d.frame.minX), d.frame.maxX - 1), y: min(max(end.pointer.y, d.frame.minY), d.frame.maxY - 1))
        guard tileEdge(p, on: d.frame, displays: displays.map(\.frame), edges: [.left, .right]) != nil else { return SettleWatch(from: frame) }
        return SettleWatch(from: frame, stillLooks: sideTileStillLooks, giveUpAfter: sideTileGiveUpAfter, waitsForTile: true)
    }

    /// The display a release belongs to: the one under the pointer, or else the nearest, for a pointer past every edge.
    public static func display(of p: CGPoint, in displays: [(frame: CGRect, visible: CGRect)]) -> (frame: CGRect, visible: CGRect)? {
        func distance(_ r: CGRect) -> CGFloat {
            let dx = max(r.minX - p.x, 0, p.x - r.maxX), dy = max(r.minY - p.y, 0, p.y - r.maxY)
            return dx * dx + dy * dy
        }
        return displays.first { $0.frame.contains(p) } ?? displays.min { distance($0.frame) < distance($1.frame) }
    }

    /// `displays` are in window-server coordinates: each display's whole frame and its visible area. Called once the
    /// window holds still.
    public static func correction(for frame: CGRect, after end: DragEnd, displays: [(frame: CGRect, visible: CGRect)]) -> Correction? {
        guard !end.dropped, frame.width > 0, frame.height > 0 else { return nil }
        let p = end.pointer
        let frames = displays.map(\.frame)
        let under = displays.first { $0.frame.contains(p) }
        if let from = end.coveredFrom {
            // At the top macOS fills the window: its own.
            if let d = under, tileEdge(p, on: d.frame, displays: frames, edges: [.top]) != nil { return nil }
            // Let go blind at a side edge, the pointer stops at x 0 while the window goes on off the screen, so the side
            // edges count only by what macOS did: a window it tiled lies inside the visible area, and so does one let go
            // in plain sight.
            if let d = display(of: p, in: displays), d.visible.insetBy(dx: -tileSlack, dy: -tileSlack).contains(frame) { return nil }
            let same = abs(from.minX - frame.minX) < 1 && abs(from.minY - frame.minY) < 1
                && abs(from.width - frame.width) < 1 && abs(from.height - frame.height) < 1
            return same ? nil : .backToBeforeOverview(from)
        }
        if let d = under, tileEdge(p, on: d.frame, displays: frames, edges: [.top, .left, .right]) != nil { return nil }
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
