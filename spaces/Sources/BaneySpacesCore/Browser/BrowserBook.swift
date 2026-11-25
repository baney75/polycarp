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

    init(row: BrowserRow, peer: BrowserPeer, score: Int, id: String) { self.row = row; self.peer = peer; self.score = score; self.id = id }
    /// A row the bar shows, to go to.
    public init(_ f: BrowserWindows.Front) {
        self.init(row: f.tab, peer: f.peer, score: 0, id: f.tab.source == .tabs ? "tab:\(f.peer.bundleID):\(f.tab.window):\(f.tab.key)" : "")
    }
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
        /// A tab shelf's open pages, by address, so nothing else offers one again.
        var open: [String: Set<Int>] = [:]
        /// While a list comes in, the rows a change has told of since: a later piece, read before the change, doesn't undo it.
        var newer: Set<String> = []

        mutating func put(_ row: BrowserRow, _ folded: (title: String, address: String)) {
            if slots[row.key] == nil, slots.count >= row.source.most { return }
            drop(row.key)
            let slot = table.add(title: folded.title, address: folded.address, weight: row.weight)
            slots[row.key] = slot
            rows[slot] = row
            if row.source == .tabs, !row.url.isEmpty { open[BrowserBook.address(row.url), default: []].insert(slot) }
        }
        mutating func drop(_ key: String) {
            guard let slot = slots.removeValue(forKey: key) else { return }
            table.remove(slot)
            if let row = rows.removeValue(forKey: slot), row.source == .tabs, !row.url.isEmpty {
                let a = BrowserBook.address(row.url)
                open[a]?.remove(slot)
                if open[a]?.isEmpty == true { open[a] = nil }
            }
            // Rows that came and went (a tab's title changing all day) are let go once they outnumber what is held.
            if table.slots > 2_000, table.live * 2 < table.slots { rebuild() }
        }
        private mutating func rebuild() {
            let (kept, told) = (rows.sorted { $0.key < $1.key }.map(\.value), newer)
            self = Shelf()
            newer = told
            for r in kept { put(r, (Fuzzy.fold(r.title), Fuzzy.fold(BrowserMessage.shown(r.url)))) }
        }
    }
    /// A source's new rows while they come in: the old ones answer until the last piece is here.
    private var coming: [BrowserPeer: [BrowserSource: Shelf]] = [:]
    /// Downloads already given back as finished, by browser: a full shelf has no room to remember one.
    private var filed: [BrowserPeer: Set<String>] = [:]

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
        filed[peer] = nil
    }

    /// Whether a browser still lists a download, so its entry in the notification list may stay (R-B5). Off, a source has no shelf.
    public func holds(_ download: BrowserWindows.Front) -> Bool {
        guard let shelf = browsers[download.peer]?[.downloads] else { return false }
        return shelf.slots[download.tab.key] != nil || filed[download.peer]?.contains(download.tab.key) == true
    }

    /// Gives back the downloads that just finished: those of a change that weren't done before, and ended in the last minute.
    @discardableResult
    public func take(_ m: BrowserMessage, from peer: BrowserPeer, at now: Date = Date()) -> [BrowserRow] {
        guard allowed.contains(m.source) else { return [] }
        switch m.change {
        case .rows(let rows, let first, let last):
            // A piece with no beginning belongs to a list that was dropped (the switch went off and on).
            guard var shelf = first ? Shelf() : coming[peer]?[m.source] else { return [] }
            for (r, f) in zip(rows, m.folded) where !shelf.newer.contains(r.key) { shelf.put(r, f) }
            coming[peer, default: [:]][m.source] = last ? nil : shelf
            if last {
                browsers[peer, default: [:]][m.source] = shelf
                // A whole list is all the browser has: one it no longer lists was erased, or its switch went off there.
                if m.source == .downloads { filed[peer] = filed[peer]?.filter { shelf.slots[$0] != nil } }
            }
        case .change(let rows, let gone):
            if var next = coming[peer]?[m.source] {
                coming[peer]?[m.source] = nil
                for k in gone { next.drop(k) }
                for (r, f) in zip(rows, m.folded) { next.put(r, f) }
                next.newer.formUnion(gone + rows.map(\.key))
                coming[peer]?[m.source] = next
            }
            // The whole list comes first; a change before it would look like all there is.
            guard var shelf = browsers[peer]?[m.source] else { return [] }
            browsers[peer]?[m.source] = nil
            let done = rows.filter { r in
                guard let ended = r.ended, abs(now.timeIntervalSince(ended)) < 60, filed[peer]?.contains(r.key) != true else { return false }
                return shelf.slots[r.key].flatMap { shelf.rows[$0] }?.ended == nil
            }
            for k in gone { shelf.drop(k); filed[peer]?.remove(k) }
            for (r, f) in zip(rows, m.folded) { shelf.put(r, f) }
            browsers[peer]?[m.source] = shelf
            if !done.isEmpty {
                var told = filed[peer] ?? []
                if told.count >= BrowserSource.downloads.most { told = [] }
                filed[peer] = told.union(done.map(\.key))
            }
            return done
        }
        return []
    }

    /// Every row of a source, by browser; none when it is off.
    public func rows(_ source: BrowserSource) -> [(peer: BrowserPeer, row: BrowserRow)] {
        browsers.sorted { $0.key < $1.key }.flatMap { b, shelves in
            (shelves[source]?.rows.sorted { $0.key < $1.key } ?? []).map { (b, $0.value) }
        }
    }

    /// The front tab of each window of a browser, all its profiles together.
    public func fronts(of bundleID: String) -> [BrowserWindows.Front] {
        browsers.sorted { $0.key < $1.key }.filter { $0.key.bundleID == bundleID }.flatMap { peer, shelves in
            (shelves[.tabs]?.rows.values.filter(\.front) ?? []).sorted { $0.window < $1.window }.map { BrowserWindows.Front(peer, $0) }
        }
    }

    /// A tab open on a site in a browser: one in front of its window before another.
    public func tab(on site: String, of bundleID: String) -> BrowserWindows.Front? {
        let there = rows(.tabs).filter { $0.peer.bundleID == bundleID && $0.row.site == site }
        return (there.first(where: \.row.front) ?? there.first).map { .init($0.peer, $0.row) }
    }

    /// The tab group `typed` names best.
    public func group(_ typed: String) -> (peer: BrowserPeer, row: BrowserRow)? {
        let q = Fuzzy.fold(typed)
        return browsers.sorted { $0.key < $1.key }.compactMap { peer, shelves -> (peer: BrowserPeer, row: BrowserRow, score: Int)? in
            guard let shelf = shelves[.groups], let h = shelf.table.search(q, limit: 1).first, let row = shelf.rows[h.slot] else { return nil }
            return (peer, row, h.score)
        }.max { $0.score < $1.score }.map { ($0.peer, $0.row) }
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
                // The floor is for the match: a page visited often still has to match as well as one visited once.
                for h in shelf.table.search(q, limit: each) {
                    guard let row = shelf.rows[h.slot], h.score - row.weight >= Self.floor else { continue }
                    let id = source == .tabs ? Self.id(row, b) : "browser:\(source.rawValue):\(b.bundleID):\(b.number):\(h.slot)"
                    hits.append(BrowserHit(row: row, peer: b, score: h.score, id: id))
                }
            }
            hits.sort { $0.score != $1.score ? $0.score > $1.score : $0.id < $1.id }
            // Two tabs of one page are two places to go; anything else with that address isn't, and is offered as the tab.
            for var h in hits.prefix(each) {
                let address = h.row.url.isEmpty ? h.id : Self.address(h.row.url)
                if source != .tabs, !h.row.url.isEmpty, let t = tab(at: address, first: h.peer) {
                    h = BrowserHit(row: t.row, peer: t.peer, score: h.score, id: Self.id(t.row, t.peer))
                }
                if source == .tabs { seen.insert(address) } else if !seen.insert(address).inserted { continue }
                found.append(h)
            }
        }
        return Array(found.sorted { $0.score != $1.score ? $0.score > $1.score : $0.id < $1.id }.prefix(limit))
    }

    /// A page's address without its fragment, as the launcher shows it.
    static func address(_ url: String) -> String { BrowserMessage.shown(String(url.prefix { $0 != "#" })) }
    private static func id(_ row: BrowserRow, _ peer: BrowserPeer) -> String { "tab:\(peer.bundleID):\(row.window):\(row.key)" }

    /// An open tab on `address`: in `peer`'s browser if it has one, its front tab before another.
    private func tab(at address: String, first peer: BrowserPeer) -> (peer: BrowserPeer, row: BrowserRow)? {
        let peers = [peer] + browsers.keys.sorted().filter { $0 != peer }
        for b in peers {
            guard let shelf = browsers[b]?[.tabs], let slots = shelf.open[address] else { continue }
            let rows = slots.sorted().compactMap { shelf.rows[$0] }
            if let r = rows.first(where: \.front) ?? rows.first { return (b, r) }
        }
        return nil
    }

    /// The least a row must match to be offered: the letters together, in a title or address of a fair length.
    static let floor = 380
}
