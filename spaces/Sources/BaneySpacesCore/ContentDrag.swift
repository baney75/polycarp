/// A press on another app's window that turns into a drag of what is in it (a file out of Finder, text, a link, an
/// image) rather than of the window: the drag pasteboard changes while the window stays put. Polycarp's window-drag
/// watcher (`TopDragWatcher`) lets such a press go, so if the window moves later (a workspace switch the drag sprang
/// parks it) that isn't taken for the person carrying it to the top of the screen.
public struct ContentDrag: Sendable {
    /// The drag pasteboard's change count when the button went down.
    private var atPress: Int?

    public init() {}

    public mutating func press(count: Int) { atPress = count }

    public mutating func release() { atPress = nil }

    /// Whether this press is a drag of content. `windowMoved`: the window has followed the pointer (or is pinned at the
    /// top) by now, on this tick included; a window that moved first is a window drag for good, so a late write to the
    /// pasteboard never takes a real window drag away. `count` is the drag pasteboard's change count now, read only
    /// when needed.
    public func isContent(windowMoved: Bool, count: () -> Int) -> Bool {
        guard !windowMoved, let atPress else { return false }
        return count() != atPress
    }
}
