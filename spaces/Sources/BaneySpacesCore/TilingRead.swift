import CoreGraphics
import Foundation

/// What the app knows of one window, from the window server, the last scan and one question to its app.
public struct TilingFacts: Equatable, Sendable {
    public var id: WindowID
    public var pid: Int32
    public var bundle: String
    public var workspace: Int
    /// Where the window server has it; nil when it no longer lists it.
    public var frame: CGRect?
    /// Drawn on the desktop macOS shows now.
    public var onScreen = false
    public var minimized = false
    /// Out of sight with its workspace, or held there.
    public var parked = false
    /// Polycarp filled the screen with it.
    public var filled = false
    /// Its frame is one macOS gives a full-screen window.
    public var screenSized = false
    /// What its app said of it, nil until it answered.
    public var answer: TilingAnswer?

    public init(id: WindowID, pid: Int32, bundle: String, workspace: Int, frame: CGRect?) {
        self.id = id; self.pid = pid; self.bundle = bundle; self.workspace = workspace; self.frame = frame
    }

    /// In a tile's reach: drawn here, and neither in the Dock, hidden, parked, filled nor in full screen.
    var here: Bool { frame != nil && onScreen && !minimized && !parked && !filled && answer.map { !$0.fullScreen } == true }
}

public struct TilingAnswer: Equatable, Sendable {
    public var resizable: Bool
    public var fullScreen: Bool
    /// Whether its frame was screen-sized when it was asked: a change means full screen may have started or ended.
    public var screenSized: Bool
    public init(resizable: Bool, fullScreen: Bool, screenSized: Bool) {
        self.resizable = resizable; self.fullScreen = fullScreen; self.screenSized = screenSized
    }
}

public enum TilingRead {
    /// The area a display's windows tile in: what macOS leaves usable, less the part of Polycarp's bar that reaches into it.
    public static func area(frame: CGRect, visible: CGRect, bar: CGFloat) -> CGRect {
        let top = max(visible.minY, frame.minY + bar)
        return CGRect(x: visible.minX, y: top, width: visible.width, height: max(0, visible.maxY - top))
    }

    /// How far bars at the top of a screen reach into it, both as AppKit has them (up is more). One elsewhere on it takes
    /// nothing from the windows.
    public static func reach(of bars: [CGRect], into screen: CGRect) -> CGFloat {
        bars.filter { $0.intersects(screen) && $0.minY >= screen.maxY - screen.height / 4 }.map { screen.maxY - $0.minY }.max() ?? 0
    }

    /// The windows whose app must be asked before they can be placed: one never asked, and one whose full screen may have
    /// changed. Only those on a workspace in sight that tiles: the rest are never asked anything.
    public static func toAsk(_ facts: [TilingFacts], shown: Set<Int>, options: TilingOptions) -> [TilingFacts] {
        facts.filter { f in
            guard shown.contains(f.workspace), options.tiles(f.workspace), f.onScreen, !f.minimized, !f.parked else { return false }
            return f.answer.map { $0.screenSized != f.screenSized } ?? true
        }
    }

    /// What the engine looks at. A workspace with windows and none of them drawn is behind a full-screen app's desktop: it
    /// waits as it is.
    public static func shot(_ facts: [TilingFacts], shown: [Int: TilingShot.Place], focused: WindowID?) -> TilingShot {
        let windows = facts.map { f in
            TilingWindow(id: f.id, pid: f.pid, bundle: f.bundle, workspace: f.workspace, frame: f.frame ?? .zero,
                         fixed: f.answer.map { !$0.resizable } ?? false, away: !f.here)
        }
        let seen = shown.filter { n, _ in
            let here = facts.filter { $0.workspace == n && !$0.minimized && !$0.parked }
            return here.isEmpty || here.contains { $0.onScreen && $0.answer?.fullScreen != true }
        }
        return TilingShot(windows: windows, shown: seen, focused: focused)
    }

    /// Windows that should be drawn and aren't yet: one opened a moment ago. The app looks again for them.
    public static func late(_ facts: [TilingFacts], shown: Set<Int>, known: (WindowID) -> Bool) -> Set<WindowID> {
        Set(facts.filter { shown.contains($0.workspace) && !$0.onScreen && !$0.minimized && !$0.parked && !known($0.id) }.map(\.id))
    }
}
