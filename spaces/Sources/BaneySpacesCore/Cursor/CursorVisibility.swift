import CoreGraphics
import Foundation

/// When an agent's cursor is drawn. `shown` is every workspace some display is showing right now (one per display), so
/// the agent workspace on a display that isn't the focused one still counts as looked at. It shows on the agent workspace while you are looking at it, and over a lent
/// app while the agent uses it. Anywhere else it stays hidden, and the action still runs: hiding is only about
/// drawing. (docs/agent-computer-use.md, "The agent cursor".)
public enum CursorVisibility {
    public enum Hidden: String, Equatable, Sendable {
        /// Turned off in Settings.
        case disabled
        /// The window is on a workspace you are not looking at (parked out of view).
        case notWatching
        /// The target's frame couldn't be read.
        case noFrame
        /// The frame is not on any display.
        case offscreen
        /// The target window is not on screen: minimized, closed, on another macOS Space, or parked off every display.
        case notOnScreen
        /// Another window in front of the target window covers the point.
        case covered
        /// The point is outside the target window, and a cursor never draws outside its window.
        case outsideWindow
    }

    public enum Decision: Equatable, Sendable {
        case show
        case hidden(Hidden)
        public var shown: Bool { self == .show }
    }

    /// The part that needs no frame: whether to measure the target at all. Cheap, so the hands ask it before
    /// spending an engine call on the target's bounds.
    public static func wantsFrame(enabled: Bool, scope: String, windowWorkspace: Int?, shown: Set<Int>, agent: Int?) -> Bool {
        if case .show = watching(enabled: enabled, scope: scope, windowWorkspace: windowWorkspace, shown: shown, agent: agent) { return true }
        return false
    }

    /// `cover` is the window server's word on the target window at the frame's center (`WindowCover.check`); nil when
    /// the window list couldn't be read, and then only the workspace and display rules apply.
    public static func decide(enabled: Bool, scope: String, windowWorkspace: Int?, shown: Set<Int>, agent: Int?,
                              frame: CGRect?, displays: [CGRect], cover: WindowCover.Verdict? = nil) -> Decision {
        let w = watching(enabled: enabled, scope: scope, windowWorkspace: windowWorkspace, shown: shown, agent: agent)
        guard case .show = w else { return w }
        guard let frame, !frame.isNull, !frame.isInfinite else { return .hidden(.noFrame) }
        let center = CGPoint(x: frame.midX, y: frame.midY)
        guard displays.contains(where: { $0.contains(center) }) else { return .hidden(.offscreen) }
        switch cover {
        case nil, .visible?: return .show
        case .notOnScreen?: return .hidden(.notOnScreen)
        case .covered?: return .hidden(.covered)
        case .outsideWindow?: return .hidden(.outsideWindow)
        }
    }

    /// Whether the "in use" veil may be drawn over a window: the same workspace rule as the cursor, with the veil's own
    /// switch. It needs no frame: the veil covers the whole window.
    public static func veilShown(enabled: Bool, scope: String, windowWorkspace: Int?, shown: Set<Int>, agent: Int?) -> Bool {
        wantsFrame(enabled: enabled, scope: scope, windowWorkspace: windowWorkspace, shown: shown, agent: agent)
    }

    private static func watching(enabled: Bool, scope: String, windowWorkspace: Int?, shown: Set<Int>, agent: Int?) -> Decision {
        guard enabled else { return .hidden(.disabled) }
        switch scope {
        case "agent_workspace":
            // Parked windows are out of view; the cursor is drawn only while you are on the agent workspace.
            guard let agent, shown.contains(agent), windowWorkspace == agent else { return .hidden(.notWatching) }
            return .show
        case "lent", "full_access":
            // A lent app, or any window under Full Access, is on your own workspace: it shows when you are on that workspace.
            guard let windowWorkspace, shown.contains(windowWorkspace) else { return .hidden(.notWatching) }
            return .show
        default:
            return .hidden(.notWatching)
        }
    }
}
