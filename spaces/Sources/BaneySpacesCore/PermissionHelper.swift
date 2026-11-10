import Foundation

/// The drag helper: a small panel beside System Settings with a Polycarp tile to drag into a Privacy list. It shows only
/// after you press a list permission's button and System Settings comes up, follows that window, and goes away the moment
/// the permission is on (after a short "done") or System Settings closes. Plain geometry and timing, tested without AppKit.
/// System Settings is read from the window server's list (owner and bounds only), never scripted or clicked.
public enum PermissionHelper {
    public static let settingsBundleID = "com.apple.systempreferences"
    /// The helper's size: an app tile and one line.
    public static let size = CGSize(width: 260, height: 92)
    public static let gap: CGFloat = 12
    /// System Settings' sidebar, the one part of its window the helper may cover when no screen has room beside it.
    public static let settingsSidebarWidth: CGFloat = 215
    /// How long to wait for System Settings to come up after the button, before giving up quietly.
    public static let waitForSettings: TimeInterval = 8
    /// System Settings may vanish from the list for a moment while it switches panes: closed only after this long.
    public static let goneAfter: TimeInterval = 0.8
    /// How long the "done" state stays.
    public static let successFor: TimeInterval = 1.2

    /// One window from `CGWindowListCopyWindowInfo`: its owner, layer, alpha and bounds (window server coordinates, the
    /// top left of the main display at 0,0 and y growing down).
    public struct ServerWindow: Equatable, Sendable {
        public let pid: Int32
        public let layer: Int
        public let alpha: Double
        public let bounds: CGRect
        public init(pid: Int32, layer: Int, alpha: Double, bounds: CGRect) {
            self.pid = pid; self.layer = layer; self.alpha = alpha; self.bounds = bounds
        }
    }

    /// System Settings' main window: the largest visible normal-level window of its process. Its sheets and the
    /// authentication box are smaller, so they never win.
    public static func settingsWindow(in windows: [ServerWindow], pids: Set<Int32>) -> CGRect? {
        windows.filter { pids.contains($0.pid) && $0.layer == 0 && $0.alpha > 0 && $0.bounds.width >= 300 && $0.bounds.height >= 200 }
            .max { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }?.bounds
    }

    /// Window server bounds to AppKit's (origin at the bottom left of the main display, y up).
    public static func appKitRect(_ server: CGRect, mainDisplayHeight: CGFloat) -> CGRect {
        CGRect(x: server.minX, y: mainDisplayHeight - server.maxY, width: server.width, height: server.height)
    }

    /// Where the helper goes, in AppKit coordinates: beside System Settings on the right, else on the left, else under or
    /// over it, top-aligned with its content and kept on its screen. Never over the list on the right of its window: with no
    /// room anywhere outside, it sits at the bottom of the sidebar.
    public static func frame(beside settings: CGRect, screens: [CGRect], size: CGSize = size, gap: CGFloat = gap) -> CGRect {
        let screen = screens.max { overlap($0, settings) < overlap($1, settings) } ?? settings
        // Level with the top of the list, under System Settings' toolbar.
        let topY = min(settings.maxY - 52, screen.maxY) - size.height
        let y = clamp(topY, screen.minY, screen.maxY - size.height)
        let right = CGRect(x: settings.maxX + gap, y: y, width: size.width, height: size.height)
        if screen.contains(right) { return right }
        let left = CGRect(x: settings.minX - gap - size.width, y: y, width: size.width, height: size.height)
        if screen.contains(left) { return left }
        let x = clamp(settings.minX, screen.minX, screen.maxX - size.width)
        let below = CGRect(x: x, y: settings.minY - gap - size.height, width: size.width, height: size.height)
        if screen.contains(below) { return below }
        let above = CGRect(x: x, y: settings.maxY + gap, width: size.width, height: size.height)
        if screen.contains(above) { return above }
        // No room outside: narrower and taller, at the bottom of the sidebar, so the list stays clear.
        let narrow = CGSize(width: settingsSidebarWidth - 2 * gap, height: size.height + 28)
        return CGRect(x: settings.minX + gap, y: clamp(settings.minY + gap, screen.minY, screen.maxY - narrow.height),
                      width: narrow.width, height: narrow.height)
    }

    /// The part of System Settings' window that holds the list: everything right of its sidebar.
    public static func listArea(of settings: CGRect) -> CGRect {
        CGRect(x: settings.minX + settingsSidebarWidth, y: settings.minY,
               width: max(0, settings.width - settingsSidebarWidth), height: settings.height)
    }

    static func overlap(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let i = a.intersection(b)
        return i.isNull ? 0 : i.width * i.height
    }

    static func clamp(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { max(lo, min(v, max(lo, hi))) }

    // MARK: When it shows

    public enum Phase: Equatable, Sendable {
        /// The button was pressed; System Settings isn't up yet. Nothing on screen.
        case waiting(since: TimeInterval)
        /// On screen beside System Settings. `missingSince`: when System Settings dropped out of the list.
        case showing(missingSince: TimeInterval?)
        /// The permission came on: the tile says so, then the helper goes.
        case done(since: TimeInterval)
        case closed
    }

    /// One look at the world: System Settings' frame if it is on screen, and whether the permission is on now.
    public static func step(_ phase: Phase, now: TimeInterval, settings: CGRect?, granted: Bool) -> Phase {
        switch phase {
        case .waiting(let since):
            // Already on, or System Settings never came: there's nothing to help with.
            if granted { return .closed }
            if settings != nil { return .showing(missingSince: nil) }
            return now - since > waitForSettings ? .closed : phase
        case .showing(let missingSince):
            if granted { return .done(since: now) }
            if settings != nil { return .showing(missingSince: nil) }
            guard let missingSince else { return .showing(missingSince: now) }
            return now - missingSince >= goneAfter ? .closed : phase
        case .done(let since):
            return now - since >= successFor ? .closed : phase
        case .closed:
            return .closed
        }
    }

    /// Whether the panel is on screen in this phase.
    public static func isVisible(_ phase: Phase) -> Bool {
        switch phase {
        case .showing, .done: true
        case .waiting, .closed: false
        }
    }

    /// The one line on the helper.
    public static let instruction = "Drag Polycarp into the list, then switch it on"
    public static let doneLine = "Polycarp is on"

    /// The file the tile carries: the app that is running, so macOS adds this copy. Nil when this isn't an app bundle
    /// (a `swift build` run), and then the helper never shows.
    public static func dragURL(bundleURL: URL) -> URL? {
        bundleURL.pathExtension == "app" ? bundleURL : nil
    }
}
