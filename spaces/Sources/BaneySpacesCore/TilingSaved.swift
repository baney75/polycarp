import CoreGraphics
import Foundation

/// Tiling as it is kept across restarts: each workspace's layout on each display, and what it takes to know the windows
/// again. It names no window: titles are keyed hashes (`WindowRecord`).
public struct TilingSaved: Codable, Equatable, Sendable {
    public static let version = 1
    /// Records older than this are dropped: their windows are not coming back.
    public static let keep: Double = 14 * 24 * 60 * 60

    struct Slot: Codable, Equatable, Sendable {
        var key: TilingKey
        var layout: TileLayout
        var focused: WindowID?
        /// The windows of each group, in tab order. Nil in a file from before there were any.
        var groups: [[WindowID]]?
    }

    struct Window: Codable, Equatable, Sendable {
        var record: WindowRecord
        /// Its frame from before tiling.
        var before: CGRect?
        /// Whether the person floated it, or tiled it against a rule.
        var floats: Bool?
    }

    var version = TilingSaved.version
    var slots: [Slot] = []
    var windows: [Window] = []

    /// A file that can't be read, was cut short or is another version gives nothing, and every layout starts fresh.
    public static func read(_ data: Data?, now: Double) -> TilingSaved? {
        guard let data, var saved = try? JSONDecoder().decode(TilingSaved.self, from: data), saved.version == version else { return nil }
        saved.windows.removeAll { now - $0.record.at > keep || !($0.before.map(Self.sane) ?? true) }
        return saved
    }

    public func data() -> Data? {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return try? e.encode(self)
    }

    private static func sane(_ r: CGRect) -> Bool {
        [r.minX, r.minY, r.width, r.height].allSatisfy { $0.isFinite && abs($0) < 100_000 } && r.width > 1 && r.height > 1
    }
}

extension TilingEngine {
    /// A saved window not seen yet: it has a place under a number no window has, until one turns up that is it.
    struct Waiting: Equatable, Sendable {
        var record: WindowRecord
        var before: CGRect?
        var floats: Bool?
    }

    /// Everything to keep. `record` describes a window; a place whose window has none isn't kept.
    public func saved(_ record: (WindowID) -> WindowRecord?) -> TilingSaved {
        var out = TilingSaved()
        var known: [WindowID: WindowRecord] = [:]
        func know(_ id: WindowID) -> WindowRecord? {
            if known[id] == nil { known[id] = waiting[id]?.record ?? record(id) }
            return known[id]
        }
        for (key, slot) in slots.sorted(by: { $0.key < $1.key }) {
            var s = slot
            // The windows that are away are kept in their places.
            for id in slot.away.keys.sorted() { if let was = s.away.removeValue(forKey: id), !was.floating { bring(id, back: was, [], &s) } }
            let unknown = Set(s.all.filter { know($0) == nil })
            s.ungroup(unknown)
            for id in unknown { s.layout.remove(id, area: s.area) }
            if !s.layout.windows.isEmpty {
                out.slots.append(.init(key: key, layout: s.layout, focused: s.focused, groups: s.groups.isEmpty ? nil : s.groups.map(\.members)))
            }
        }
        // A saved window still away is kept too, in a layout or not: one owed a frame or a float waits for the next run.
        for id in Set(before.keys).union(choice.keys).union(waiting.keys) { _ = know(id) }
        out.windows = known.sorted { $0.key < $1.key }.map { id, r in
            var r = r
            r.window = id
            return .init(record: r, before: waiting[id]?.before ?? before[id], floats: waiting[id]?.floats ?? choice[id])
        }
        return out
    }

    /// Takes the layouts back. Their windows wait under numbers of their own until `claim` finds them.
    public mutating func restore(_ saved: TilingSaved) {
        // A window still waiting when the file was written is saved under its stand-in number: no new one may be the same.
        let used = Set(saved.windows.map(\.record.window)).union(saved.slots.flatMap(\.layout.windows))
        var number = WindowID.max
        var phantom: [WindowID: WindowID] = [:]
        for w in saved.windows where phantom[w.record.window] == nil {
            while used.contains(number) { number -= 1 }
            phantom[w.record.window] = number
            waiting[number] = Waiting(record: w.record, before: w.before, floats: w.floats)
            number -= 1
        }
        for s in saved.slots where slots[s.key] == nil {
            var layout = s.layout
            for id in layout.windows {
                if let p = phantom[id] { layout.replace(id, with: p) } else { layout.remove(id, area: .zero) }
            }
            guard !layout.windows.isEmpty else { continue }
            var slot = Slot(layout: layout, focused: s.focused.flatMap { phantom[$0] })
            slot.restore((s.groups ?? []).map { $0.compactMap { phantom[$0] } })
            slots[s.key] = slot
            lastDisplay[s.key.workspace] = s.key.display
        }
        dropUnneeded()
    }

    /// Whether any saved window is still to turn up: while not, the app need not read a title.
    public var awaits: Bool { !waiting.isEmpty }

    /// Gives windows that turned up the places kept for them: the very window first (same number, process and app), then
    /// the same app and title, by hash, on the same workspace.
    public mutating func claim(_ live: [(window: LiveWindow, workspace: Int)]) {
        guard awaits else { return }
        let free = live.filter { !claimed.contains($0.window.id) }
        for (w, _) in free {
            if let p = waiting.first(where: { $0.value.record.window == w.id && $0.value.record.pid == w.pid && $0.value.record.bundle == w.bundle })?.key {
                take(p, w.id)
            }
        }
        for (workspace, some) in Dictionary(grouping: free.filter { !claimed.contains($0.window.id) }, by: \.workspace) {
            let rows = waiting.filter { $0.value.record.workspace == workspace }.sorted { $0.key > $1.key }
            for pair in WindowPairing.pair(some.map(\.window), with: rows.map(\.value.record)) where pair.rule != .order {
                take(rows[pair.record].key, pair.window)
            }
        }
    }

    private mutating func take(_ phantom: WindowID, _ id: WindowID) {
        guard let w = waiting.removeValue(forKey: phantom) else { return }
        claimed.insert(id)
        // Tiled already, before its app gave it a title: it leaves that place for its own.
        for key in slots.keys { slots[key]!.take(id) }
        rename(phantom, to: id)
        if let b = w.before { before[id] = b }
        if let f = w.floats { choice[id] = f }
    }

    /// Saved windows no layout, frame or choice needs any more aren't waited for. One owed its frame from before tiling
    /// is, even after tiling is turned off: it gets that frame back when it turns up.
    mutating func dropUnneeded() {
        guard !waiting.isEmpty else { return }
        var placed = Set<WindowID>()
        for s in slots.values { placed.formUnion(s.all); placed.formUnion(s.away.keys) }
        waiting = waiting.filter { placed.contains($0.key) || $0.value.floats != nil || $0.value.before != nil }
    }
}
