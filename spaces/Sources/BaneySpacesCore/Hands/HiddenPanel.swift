import CoreGraphics
import Foundation

/// A panel that hides while its app is in the background, as every agent copy is. 11-15: `menu "Format > Font > Show
/// Fonts"` in TextEdit answered plain ok, and the Fonts panel (window 67321, AXFloatingWindow) became the app's focused
/// window while AXWindows left it out. Nothing named it, `close` couldn't find it, and every later menu call was refused.
public enum HiddenPanel {
    /// The app's focused window when AXWindows doesn't list it: the hidden panel to read as a child window.
    public static func unlisted(listed: [UInt32], focused: UInt32?) -> UInt32? {
        guard let focused, !listed.contains(focused) else { return nil }
        return focused
    }

    /// The windows a menu command raised that the session may close: only when the window it pressed in is the session's,
    /// since a panel raised from Donovan's window is his.
    public static func adopt(raised: [UInt32], target: UInt32, sessionOwnsTarget: Bool) -> [UInt32] {
        sessionOwnsTarget ? raised.filter { $0 != target } : []
    }

    /// The `opened` value's window ids, one child or a list of them.
    public static func ids(_ opened: JSONValue?) -> [UInt32] {
        switch opened {
        case .object(let o)?: return o["window"]?.int.flatMap { UInt32(exactly: $0) }.map { [$0] } ?? []
        case .array(let a)?: return a.flatMap { ids($0) }
        default: return []
        }
    }

    /// What `menu` says beside `opened`: the command raised a window, so the answer is never a bare ok.
    public static func note(_ ids: [UInt32], closable: Bool) -> String {
        let list = ids.map { "window \($0)" }.joined(separator: ", ")
        return "the command raised \(list); it is the app's focused window until it closes"
            + (closable ? ", so close it with `close --window \(ids[0])` when you are done" : "")
    }

    /// A closed panel stays in the window server, ordered out, so it is closed once the app shows it no more: not in
    /// AXWindows and not its focused window.
    public static func closed(inWindows: Bool, focused: Bool) -> Bool { !inWindows && !focused }

    /// One window of the app as the window server lists it, on screen or not.
    public struct ServerWindow: Equatable, Sendable {
        public let id: UInt32, layer: Int, onScreen: Bool, bounds: CGRect, title: String
        public init(id: UInt32, layer: Int, onScreen: Bool, bounds: CGRect, title: String) {
            self.id = id; self.layer = layer; self.onScreen = onScreen; self.bounds = bounds; self.title = title
        }
    }

    /// Issue #309, 11-15 on 0e4666d: `menu "Format > Font > Show Colors"` made TextEdit window 67759 "Colors" (layer 3)
    /// that never went on screen and that Accessibility has no element for, not even by remote token, so the answer named
    /// nothing and `close` said "no window that Polycarp tracks". These are the windows a press made like that: new since
    /// it, at a panel's level, sized, out of sight, and not read through Accessibility.
    public static func unreachable(_ after: [ServerWindow], before: Set<UInt32>, reached: Set<UInt32>) -> [ServerWindow] {
        after.filter { !before.contains($0.id) && !reached.contains($0.id) && panelLevels.contains($0.layer) && !$0.onScreen && $0.bounds.width > 0 && $0.bounds.height > 0 }
    }

    /// A panel's window levels: floating (3) to modal (8). A menu's (24, 101) is never one.
    public static let panelLevels = 3...8

    /// The `opened` entry for one: named, and said to be out of sight with nothing to read or press.
    public static func opened(_ w: ServerWindow) -> JSONValue {
        .object(["window": .int(Int(w.id)), "kind": .string("hidden_panel"), "title": .string(w.title), "shown": .bool(false),
                 "waiting": .bool(false), "parent": .null])
    }

    static func named(_ w: ServerWindow) -> String { w.title.isEmpty ? "window \(w.id)" : "window \(w.id) (\(w.title))" }

    /// Why one is out of sight, said where `menu` answers and where `close` refuses.
    public static func why(_ w: ServerWindow, app: String) -> String {
        "\(named(w)) is a panel \(app) shows only while it is the active app, and Polycarp never makes the agent's copy active, so it stays out of sight with nothing Polycarp can read or press"
    }

    /// `close` on one: it has no button to press, and it goes when the copy quits.
    public static func closeRefusal(_ w: ServerWindow, app: String) -> HandsError {
        HandsError(.notSupported, why(w, app: app), suggestion: "Leave it; no one sees it, and it goes when the copy quits. Polycarp never quits an app for an agent.", retry: .never)
    }
}
