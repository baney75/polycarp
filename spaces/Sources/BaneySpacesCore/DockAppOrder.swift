/// The order a workspace's apps take on its ⌘Tab card: the one you used there last comes first.
/// Apps never used on that workspace since BaneySpaces started keep the order they came in, which
/// is their windows' order there, after every app that has been used. The dock doesn't use it: its
/// tiles keep the order apps joined the workspace (`DockJoinOrder`).
public enum DockAppOrder {
    /// `activatedAt` is when each app last came forward on the workspace, larger being later.
    public static func sort(_ keys: [String], activatedAt: [String: Double]) -> [String] {
        keys.enumerated().sorted { a, b in
            switch (activatedAt[a.element], activatedAt[b.element]) {
            case let (x?, y?) where x != y: return x > y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.offset < b.offset
            }
        }.map(\.element)
    }

    /// Under the pointer icons hold still: `proposed` replaces `previous` only when nobody hovers
    /// the tile, or when the set of apps changed (an app opened or quit). `replayOwed` says the
    /// held order differs from `proposed`, so a reload is due once the pointer leaves.
    public static func held(proposed: [String], previous: [String]?, hovering: Bool) -> (order: [String], replayOwed: Bool) {
        guard hovering, let previous, Set(previous) == Set(proposed), previous.count == proposed.count else { return (proposed, false) }
        return (previous, previous != proposed)
    }
}

/// The order apps joined each workspace, for the dock's tiles and "+N" lists. A tile that re-sorted by
/// focus put a different app under the pointer after each switch, so a second click opened the wrong
/// one (Donovan, 2026-11-16: workspace 1 read T3, Helium, Claude, then Helium, T3, Claude after
/// he clicked Helium). Focus never moves an app here. An app keeps its place while it has a window
/// on the workspace; one that arrives joins at the end; one whose last window leaves drops out, so
/// it joins at the end if it comes back.
public struct DockJoinOrder: Equatable, Sendable {
    private var keys: [Int: [String]] = [:]

    public init() {}

    /// `windows[n]` is the app of each window on workspace `n`, in window order. A workspace
    /// missing from it, or with no windows, forgets its order.
    public mutating func update(_ windows: [Int: [String]]) {
        var next: [Int: [String]] = [:]
        for (n, list) in windows where !list.isEmpty {
            let present = Set(list)
            var order = (keys[n] ?? []).filter { present.contains($0) }
            var seen = Set(order)
            for key in list where seen.insert(key).inserted { order.append(key) }
            next[n] = order
        }
        keys = next
    }

    public func on(_ workspace: Int) -> [String] { keys[workspace] ?? [] }

    /// `apps` in join order on `workspace`; apps not seen there yet follow in their given order.
    public func arrange(_ apps: [String], on workspace: Int) -> [String] {
        let known = on(workspace)
        let wanted = Set(apps)
        return known.filter { wanted.contains($0) } + apps.filter { !known.contains($0) }
    }
}

/// When each app last came forward on each workspace. An app split across workspaces has a time
/// on each, so using it on one doesn't move it to the front of another.
public struct AppActivations: Equatable, Sendable {
    private var stamps: [Int: [String: Double]] = [:]

    public init() {}

    public mutating func note(_ key: String, on workspace: Int, at time: Double) {
        stamps[workspace, default: [:]][key] = time
    }

    public func on(_ workspace: Int) -> [String: Double] { stamps[workspace] ?? [:] }

    public var all: [Int: [String: Double]] { stamps }

    /// An app that quit: its process id may come back as another app.
    public mutating func forget(_ key: String) {
        for n in stamps.keys { stamps[n]?[key] = nil }
    }
}
