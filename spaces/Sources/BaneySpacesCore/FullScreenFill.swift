import CoreGraphics
import Foundation

/// What the green button and ⌃⌘F do while Polycarp runs. macOS full screen moves a window to a desktop of its own, and every
/// switch to or from it plays macOS's slide, which nothing can speed up. So a window fills the screen on its own workspace
/// instead: at once, with no slide, and ⌘1 to ⌘9 stay instant (Donovan, 2026-11-06). Anything else that asks for full screen
/// (a video's own button, Window > Enter Full Screen, a slideshow) stays native.
public enum FullScreenFill {
    /// A preference, on unless the person turned it off.
    public static let enabledKey = "fullScreenFills"

    public static func isEnabled(stored: Any?) -> Bool { (stored as? Bool) ?? true }

    /// F's virtual key code.
    public static let fKey: Int64 = 3

    /// ⌃⌘F and fn-F, the two standard full-screen keys. Any other modifier means something else.
    public static func isFullScreenKey(code: Int64, control: Bool, command: Bool, shift: Bool, option: Bool, fn: Bool) -> Bool {
        guard code == fKey, !shift, !option else { return false }
        return (control && command && !fn) || (fn && !control && !command)
    }

    /// A plain click only: ⌥-click on the green button is macOS's own zoom, and stays that.
    public static func isPlainClick(command: Bool, control: Bool, shift: Bool, option: Bool) -> Bool {
        !command && !control && !shift && !option
    }

    /// Accessibility's name for the green button.
    public static let buttonSubrole = "AXFullScreenButton"

    /// A window this filled: where it was, and where it landed, which can fall short of the screen for an app that snaps to
    /// character cells or has a maximum size.
    public struct Record: Equatable, Sendable, Codable {
        public var from: CGRect
        public var landed: CGRect
        public init(from: CGRect, landed: CGRect) {
            self.from = from
            self.landed = landed
        }
    }

    /// Where a press sends a window. Still where this filled it: back where it was. Anywhere else, including somewhere the
    /// person dragged it since: it fills.
    public static func target(current: CGRect, fill: CGRect, record: Record?) -> CGRect {
        if let record, isFilling(current, record.landed), !isFilling(record.from, record.landed) { return record.from }
        // Already this big with nowhere to go back to (sized by hand, or filled before the last launch). A press that
        // refilled it would look like a dead button.
        if isFilling(current, fill) { return smaller(fill) }
        return fill
    }

    /// A window's size when there's no earlier one to go back to: comfortably not the whole screen, centered.
    public static func smaller(_ fill: CGRect) -> CGRect {
        let size = CGSize(width: (fill.width * 0.72).rounded(), height: (fill.height * 0.8).rounded())
        return CGRect(x: (fill.midX - size.width / 2).rounded(), y: (fill.midY - size.height / 2).rounded(),
                      width: size.width, height: size.height)
    }

    /// Where a window this filled goes when its title bar is dragged away: its earlier size, with the pointer over the same
    /// share of the title bar. Nil for any window this didn't fill. Compares size only, since the drag has moved it.
    /// A full-size window with no record was filled by macOS (a drag to the top) or sized by hand. macOS gives a tiled
    /// window its old size back on its own as the drag starts, so resizing it here too made two size changes in one drag
    /// and threw the window off the pointer (Donovan, 2026-11-12).
    public static func unfilled(current: CGRect, fill: CGRect, record: Record?, pointer: CGPoint) -> CGRect? {
        func sameSize(_ a: CGRect, _ b: CGRect) -> Bool {
            abs(a.width - b.width) <= 3 && abs(a.height - b.height) <= 3
        }
        guard let record, sameSize(current, record.landed) else { return nil }
        let size = sameSize(record.from, current) ? smaller(fill).size : record.from.size
        let share = current.width > 0 ? min(max((pointer.x - current.minX) / current.width, 0), 1) : 0.5
        return CGRect(x: (pointer.x - share * size.width).rounded(), y: current.minY, width: size.width, height: size.height)
    }

    /// What a drag of a window's title bar does to it as the drag starts.
    public enum DragStart: Equatable, Sendable {
        /// Polycarp filled it and it's still that size: its earlier size comes back under the pointer.
        case unfill(CGRect)
        /// Polycarp filled it, but it has been resized since: the fill is over, so the record goes. Kept, it matched again
        /// once macOS filled the window and resized it a second time in the next drag (review of #146).
        case forget
        /// Full size with no record: macOS filled it (a drag to the top) and puts it back itself.
        case leftToMacOS
        /// Any other window: nothing to do or log.
        case ordinary
    }

    public static func dragStart(current: CGRect, fill: CGRect, record: Record?, pointer: CGPoint) -> DragStart {
        if let next = unfilled(current: current, fill: fill, record: record, pointer: pointer) { return .unfill(next) }
        if record != nil { return .forget }
        let full = abs(current.width - fill.width) <= 3 && abs(current.height - fill.height) <= 3
        return full ? .leftToMacOS : .ordinary
    }

    /// Whether a click could be on a window's green button, from the window server's geometry alone: within the corner where
    /// the traffic lights sit. Only such a click is worth asking the app about, so ordinary clicks cost no call to any app.
    public static func isInButtonCorner(_ point: CGPoint, window: CGRect) -> Bool {
        CGRect(x: window.minX, y: window.minY, width: min(100, window.width), height: min(60, window.height)).contains(point)
    }

    public static func isFilling(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = 3) -> Bool {
        abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
            && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }
}

/// A window on a workspace you aren't on, coming to the front. Polycarp puts away every window it leaves behind, parked or
/// hidden. One that was neither wasn't on screen when you left: its own app had put it away, as a screenshot tool does with
/// the one window it reuses for each capture. It coming back is that app showing something now, so it belongs where you are.
public enum ReappearedWindow {
    /// Whether a window is really put away. A record alone doesn't say so: a window parked while it showed, then hidden by
    /// its own app, keeps its record, and when the app shows it again it's back in plain sight. So is a window whose app
    /// undid the park. Just after a switch it may still be on its way out, and it counts as away.
    public static func isAway(hasRecord: Bool, atHidingSpot: Bool, justSwitched: Bool) -> Bool {
        hasRecord && (atHidingSpot || justSwitched)
    }

    public static func belongsHere(workspaceShown: Bool, onAgentWorkspace: Bool, parked: Bool, appHiddenByUs: Bool,
                                   minimized: Bool, fullScreen: Bool, onScreen: Bool) -> Bool {
        !workspaceShown && !onAgentWorkspace && !parked && !appHiddenByUs && !minimized && !fullScreen && onScreen
    }
}

