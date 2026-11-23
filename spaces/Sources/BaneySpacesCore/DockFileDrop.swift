import CoreGraphics
import Foundation

/// One kind of dock tile that takes files or links dropped on it. Each tile reports its frame under a key
/// (`CenterReport`: "workspace:pid" for an app's icon); a kind claims the keys that are its own, says whether the tile
/// under the pointer takes what is being dragged, and takes it on the drop. App icons are one kind (`AppTileDrop`). A
/// later tile kind (a room, say) registers its own `DockDropKind` with the dock's `DockDropTargets`; the drag, the
/// highlight, the dock staying up and the drop itself need no change for it.
public struct DockDropKind {
    /// For the trace: "app", "room".
    public let name: String
    /// The frame key is one of this kind's tiles.
    public let claims: (String) -> Bool
    /// Whether the tile under `key` takes every one of `urls`. Asked on each move over it, so keep it cheap.
    public let accepts: (_ key: String, _ urls: [URL]) -> Bool
    /// The drop. Only called after `accepts` said yes for the same key and items. Whether the tile took them.
    public let take: (_ key: String, _ urls: [URL]) -> Bool

    public init(name: String, claims: @escaping (String) -> Bool,
                accepts: @escaping (_ key: String, _ urls: [URL]) -> Bool,
                take: @escaping (_ key: String, _ urls: [URL]) -> Bool) {
        self.name = name
        self.claims = claims
        self.accepts = accepts
        self.take = take
    }
}

/// What a file drag over the dock rests on: the tile's key, its kind and whether it takes the drag.
public struct DockDropHit: Equatable, Sendable {
    public let key: String
    public let kind: String
    public let accepts: Bool

    public init(key: String, kind: String, accepts: Bool) {
        self.key = key
        self.kind = kind
        self.accepts = accepts
    }
}

/// The dock's drop targets: every kind registered, and which tile under the pointer is whose.
public struct DockDropTargets {
    public private(set) var kinds: [DockDropKind] = []

    public init(_ kinds: [DockDropKind] = []) {
        for k in kinds { register(k) }
    }

    /// Adds a kind, or replaces the one registered under the same name.
    public mutating func register(_ kind: DockDropKind) {
        kinds.removeAll { $0.name == kind.name }
        kinds.append(kind)
    }

    /// The tile under `p` that some kind claims, and that kind. Frames nest (an app's icon lies inside its workspace's
    /// tile), so the smallest claimed frame under the pointer wins. `frames` are keyed and placed as the dock reports them.
    public func tile(at p: CGPoint, frames: [String: CGRect]) -> (key: String, kind: DockDropKind)? {
        var best: (key: String, kind: DockDropKind, area: CGFloat)?
        for (key, frame) in frames where frame.contains(p) {
            guard let kind = kinds.first(where: { $0.claims(key) }) else { continue }
            let area = frame.width * frame.height
            if best == nil || area < best!.area || (area == best!.area && key < best!.key) { best = (key, kind, area) }
        }
        return best.map { ($0.key, $0.kind) }
    }

    /// What the drag of `urls` rests on at `p`, and whether that tile takes it. Nil over no claimed tile.
    public func hit(at p: CGPoint, frames: [String: CGRect], urls: [URL]) -> DockDropHit? {
        guard let (key, kind) = tile(at: p, frames: frames) else { return nil }
        return DockDropHit(key: key, kind: kind.name, accepts: !urls.isEmpty && kind.accepts(key, urls))
    }

    /// Whether the tile under `key` takes `urls`, asked again at the drop.
    public func accepts(key: String, urls: [URL]) -> Bool {
        guard !urls.isEmpty, let kind = kinds.first(where: { $0.claims(key) }) else { return false }
        return kind.accepts(key, urls)
    }

    /// The drop on the tile last lit (`key`): taken only if its kind still takes `urls`.
    @discardableResult
    public func drop(key: String, urls: [URL]) -> Bool {
        guard accepts(key: key, urls: urls), let kind = kinds.first(where: { $0.claims(key) }) else { return false }
        return kind.take(key, urls)
    }
}

/// An app's icon in the dock as a drop target, the way the macOS Dock's are: it takes a drag only when its app can open
/// every file or link in it, and a drop opens them with that app (launching it if it quit since the drag began).
public enum AppTileDrop {
    /// The app behind an icon, read once per drag: its bundle identifier, which decides what it opens, and its bundle,
    /// which opens them. `running` is false once it quit; the drop then launches it.
    public struct App: Equatable, Sendable {
        public let bundleID: String?
        public let bundleURL: URL?
        public let pid: Int32
        public let running: Bool

        public init(bundleID: String?, bundleURL: URL?, pid: Int32, running: Bool = true) {
            self.bundleID = bundleID
            self.bundleURL = bundleURL
            self.pid = pid
            self.running = running
        }
    }

    /// An app icon's key, "workspace:app id", as the dock reports its frame. Tiles ("tile:3"), buttons ("btn:new") and
    /// "+N" ("more:2") are not icons.
    public static func parse(_ key: String) -> (workspace: Int, id: String)? {
        let parts = key.split(separator: ":", maxSplits: 1)
        guard parts.count == 2, let n = Int(parts[0]), !parts[1].isEmpty else { return nil }
        return (n, String(parts[1]))
    }

    /// The kind. `app` names the app behind an icon (nil: none, which takes nothing). `openers` gives the bundle
    /// identifiers of the apps that can open every one of the URLs (`DockOpen.apps(openingAll:)`, kept per drag by the
    /// caller). `open` opens them with that app, for the icon's workspace.
    public static func kind(app: @escaping (_ workspace: Int, _ id: String) -> App?,
                            openers: @escaping ([URL]) -> Set<String>,
                            open: @escaping ([URL], App, Int) -> Void) -> DockDropKind {
        let accepts: (String, [URL]) -> Bool = { key, urls in
            guard !urls.isEmpty, let (n, id) = parse(key), let a = app(n, id), a.bundleURL != nil,
                  let bundle = a.bundleID else { return false }
            return openers(urls).contains(bundle)
        }
        return DockDropKind(name: "app", claims: { parse($0) != nil }, accepts: accepts, take: { key, urls in
            guard accepts(key, urls), let (n, id) = parse(key), let a = app(n, id) else { return false }
            open(urls, a, n)
            return true
        })
    }
}

/// A press on another app's window that turns into a drag of what is in it (a file out of Finder, text, a link, an
/// image) rather than of the window: the drag pasteboard changes while the window stays put. Polycarp's window-drag
/// watcher (`TopDragWatcher`) lets such a press go, so if the window moves later (a workspace switch the drag sprang
/// parks it) that isn't taken for the person carrying it to the top of the screen or to the dock.
public struct ContentDrag: Sendable {
    /// The drag pasteboard's change count when the button went down.
    private var atPress: Int?

    public init() {}

    public mutating func press(count: Int) { atPress = count }

    public mutating func release() { atPress = nil }

    /// Whether this press is a drag of content. `windowMoved`: the window has followed the pointer (or is pinned at the
    /// top) by now, on this tick included; a window that moved first is a window drag for good, so a late write to the
    /// pasteboard never takes a real window drag away. `dockSaw`: what the dock's watch says (`OutsideDrag.active`,
    /// sampled with the buttons up, so a drop's late write before this press doesn't count), nil while the dock isn't
    /// watching; then the count at the press decides. `count` is read only when needed.
    public func isContent(windowMoved: Bool, dockSaw: Bool?, count: () -> Int) -> Bool {
        guard !windowMoved else { return false }
        if let dockSaw { return dockSaw }
        guard let atPress else { return false }
        return count() != atPress
    }
}

/// When the buttons come up during a drag over the dock. AppKit delivers the drop (`performDragOperation`) a few
/// milliseconds after the hardware button comes up, so the dock's tick, which sees the buttons up first, waits `grace`
/// before it takes the drag for stale; a drop or an end inside that wait resets it. Without the wait a tick in that gap
/// cleared the lit tile and the drop was refused.
public struct DockDropRelease {
    public static let grace: TimeInterval = 0.5
    private var upSince: TimeInterval?

    public init() {}

    /// The buttons are up at `now`: true once they have stayed up `grace` with no drop or end, so the drag is stale.
    public mutating func buttonsUp(now: TimeInterval) -> Bool {
        guard let since = upSince else { upSince = now; return false }
        return now - since >= Self.grace
    }

    /// A button is down, or the drag dropped, ended or entered again: the wait starts over.
    public mutating func reset() { upSince = nil }
}
