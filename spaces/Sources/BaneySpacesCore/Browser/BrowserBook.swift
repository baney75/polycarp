import BrowserMatch
import Foundation

/// One browser profile running the extension: the browser's app, and which of the profiles that came it is.
public struct BrowserPeer: Hashable, Comparable, Sendable {
    public let bundleID: String
    public let number: Int
    public init(_ bundleID: String, _ number: Int = 0) { self.bundleID = bundleID; self.number = number }
    public static func < (a: BrowserPeer, b: BrowserPeer) -> Bool { (a.bundleID, a.number) < (b.bundleID, b.number) }
}

/// One answer from a browser, for the launcher.
public struct BrowserHit: Equatable, Sendable {
    public let row: BrowserRow
    /// Where it is.
    public let peer: BrowserPeer
    /// Comparable with `Fuzzy.score`.
    public let score: Int
    /// A tab's id is the one the session engine gives the same tab. The others say where the row is held and nothing of
    /// the page: an id gets into traces.
    public let id: String
}

/// What the browsers running the Polycarp extension have told the app: their tabs, bookmarks, recent history and downloads,
/// in memory until the browser goes, the source is switched off or Polycarp quits. Kept apart from the session engine's
/// rows, which are written to session.json and answer other machines.
///
/// Main thread only; messages are parsed off it.
public final class BrowserBook {
    /// The sources switched on. What an off one held is dropped, and it takes and answers nothing.
    public private(set) var allowed: Set<BrowserSource>
    private var browsers: [BrowserPeer: [BrowserSource: Shelf]] = [:]

    private struct Shelf {
        var table = BrowserTable()
        var slots: [String: Int] = [:]
        var rows: [Int: BrowserRow] = [:]

        mutating func put(_ row: BrowserRow, _ folded: (title: String, address: String)) {
            if slots[row.key] == nil, slots.count >= row.source.most { return }
            drop(row.key)
            let slot = table.add(title: folded.title, address: folded.address, weight: row.weight)
            slots[row.key] = slot
            rows[slot] = row
        }
        mutating func drop(_ key: String) {
            guard let slot = slots.removeValue(forKey: key) else { return }
            table.remove(slot)
            rows[slot] = nil
            // Rows that came and went (a tab's title changing all day) are let go once they outnumber what is held.
            if table.slots > 2_000, table.live * 2 < table.slots { rebuild() }
        }
        private mutating func rebuild() {
            let kept = rows.sorted { $0.key < $1.key }.map(\.value)
            self = Shelf()
            for r in kept { put(r, (Fuzzy.fold(r.title), Fuzzy.fold(BrowserMessage.shown(r.url)))) }
        }
    }
    /// A source's new rows while they come in: the old ones answer until the last piece is here.
    private var coming: [BrowserPeer: [BrowserSource: Shelf]] = [:]

    public init(allowed: Set<BrowserSource> = Set(BrowserSource.allCases)) { self.allowed = allowed }

    public func allow(_ sources: Set<BrowserSource>) {
        allowed = sources
        for (b, shelves) in browsers { browsers[b] = shelves.filter { sources.contains($0.key) } }
        for (b, shelves) in coming { coming[b] = shelves.filter { sources.contains($0.key) } }
    }

    /// The browser's extension is gone: so is all of its record.
    public func forget(_ peer: BrowserPeer) {
        browsers[peer] = nil
        coming[peer] = nil
    }

    public func take(_ m: BrowserMessage, from peer: BrowserPeer) {
        guard allowed.contains(m.source) else { return }
        switch m.change {
        case .rows(let rows, let first, let last):
            // A piece with no beginning belongs to a list that was dropped (the switch went off and on).
            guard var shelf = first ? Shelf() : coming[peer]?[m.source] else { return }
            for (r, f) in zip(rows, m.folded) { shelf.put(r, f) }
            coming[peer, default: [:]][m.source] = last ? nil : shelf
            if last { browsers[peer, default: [:]][m.source] = shelf }
        case .change(let rows, let gone):
            // The whole list comes first; a change before it would look like all there is.
            guard var shelf = browsers[peer]?[m.source] else { return }
            browsers[peer]?[m.source] = nil
            for k in gone { shelf.drop(k) }
            for (r, f) in zip(rows, m.folded) { shelf.put(r, f) }
            browsers[peer]?[m.source] = shelf
        }
    }

    /// Every row of a source, by browser; none when it is off.
    public func rows(_ source: BrowserSource) -> [(peer: BrowserPeer, row: BrowserRow)] {
        browsers.sorted { $0.key < $1.key }.flatMap { b, shelves in
            (shelves[source]?.rows.sorted { $0.key < $1.key } ?? []).map { (b, $0.value) }
        }
    }

    /// A source's rows ever added since its last rebuild, for the tests.
    func slots(_ source: BrowserSource, _ peer: BrowserPeer) -> Int { browsers[peer]?[source]?.table.slots ?? 0 }

    /// What answers `typed`, best first: open tabs, bookmarks, history and downloads together, at most `limit` and a few
    /// of each. The same address is offered once: the open tab, then the bookmark, then the page visited.
    public func search(_ typed: String, limit: Int = 6, each: Int = 4) -> [BrowserHit] {
        guard OneSearch.findsSessions(typed) else { return [] }
        let q = Fuzzy.fold(typed.trimmingCharacters(in: .whitespacesAndNewlines))
        var found: [BrowserHit] = []
        var seen = Set<String>()
        for source in BrowserSource.allCases {
            var hits: [BrowserHit] = []
            for (b, shelves) in browsers {
                guard let shelf = shelves[source] else { continue }
                for h in shelf.table.search(q, limit: each) where h.score >= Self.floor {
                    guard let row = shelf.rows[h.slot] else { continue }
                    let id = source == .tabs ? "tab:\(b.bundleID):\(row.window):\(row.key)" : "browser:\(source.rawValue):\(b.bundleID):\(b.number):\(h.slot)"
                    hits.append(BrowserHit(row: row, peer: b, score: h.score, id: id))
                }
            }
            hits.sort { $0.score != $1.score ? $0.score > $1.score : $0.id < $1.id }
            // Two tabs of one page are two places to go; anything else with that address isn't.
            for h in hits.prefix(each) {
                let address = h.row.url.isEmpty ? h.id : BrowserMessage.shown(String(h.row.url.prefix { $0 != "#" }))
                if source == .tabs { seen.insert(address) } else if !seen.insert(address).inserted { continue }
                found.append(h)
            }
        }
        return Array(found.sorted { $0.score != $1.score ? $0.score > $1.score : $0.id < $1.id }.prefix(limit))
    }

    /// The least a row must match to be offered: the letters together, in a title or address of a fair length.
    static let floor = 380
}
