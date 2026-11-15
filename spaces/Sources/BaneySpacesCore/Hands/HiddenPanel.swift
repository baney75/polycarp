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
}
