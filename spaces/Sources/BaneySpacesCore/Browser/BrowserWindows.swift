import Foundation

/// Which of a browser's windows is which window on the Mac. The extension knows windows by the browser's number and their
/// tabs; Polycarp knows them by the window server's and a title, which is the front tab's. Nothing is guessed: a title two
/// windows share says nothing.
public enum BrowserWindows {
    /// A browser window's front tab.
    public struct Front: Equatable, Sendable {
        public let peer: BrowserPeer
        public let tab: BrowserRow
        public init(_ peer: BrowserPeer, _ tab: BrowserRow) { self.peer = peer; self.tab = tab }
    }

    /// The window numbers the session engine read for the tabs it lists (`tab:<bundle>:<window>:<tab>`).
    public static func numbers(_ items: [Item], of bundleID: String) -> [Int: UInt32] {
        var out: [Int: UInt32] = [:]
        for i in items where i.kind == .tab && i.bundleID == bundleID && i.windowNumber != 0 {
            let parts = i.id.split(separator: ":")
            if parts.count == 4, let w = Int(parts[2]) { out[w] = i.windowNumber }
        }
        return out
    }

    /// The front tab of each of the Mac's windows that is known for sure: by `numbers`, else by the one title only it has.
    public static func match(_ windows: [(id: UInt32, title: String)], _ fronts: [Front], numbers: [Int: UInt32] = [:]) -> [UInt32: Front] {
        var out: [UInt32: Front] = [:]
        for f in fronts { if let n = numbers[f.tab.window], windows.contains(where: { $0.id == n }) { out[n] = f } }
        let left = windows.filter { out[$0.id] == nil }
        let untold = fronts.filter { f in !out.values.contains { $0.peer == f.peer && $0.tab.window == f.tab.window } }
        // The longest title wins: "Maps" is not "Maps - Home".
        let best: [(id: UInt32, front: Int)] = left.compactMap { w in
            let fits = untold.indices.filter { says(w.title, untold[$0].tab.title) }
            guard let most = fits.map({ untold[$0].tab.title.count }).max() else { return nil }
            let longest = fits.filter { untold[$0].tab.title.count == most }
            return longest.count == 1 ? (w.id, longest[0]) : nil
        }
        for b in best where best.filter({ $0.front == b.front }).count == 1 { out[b.id] = untold[b.front] }
        return out
    }

    /// "Title", or "Title - Browser" and whatever the browser adds after it.
    static func says(_ window: String, _ tab: String) -> Bool {
        guard window.hasPrefix(tab) else { return false }
        let rest = window.dropFirst(tab.count)
        return rest.isEmpty || [" - ", " \u{2013} ", " \u{2014} "].contains { rest.hasPrefix($0) } || tab.count >= 300
    }

    public enum Place: Equatable, Sendable {
        /// In this one of the browser's windows, here.
        case tab(BrowserPeer, window: Int, id: UInt32)
        /// In a window of its own, which opens here.
        case window(BrowserPeer)
        /// The browser's front window: it is here, or there is none.
        case front(BrowserPeer)
    }

    /// Where a new tab goes for a person on one workspace: the first of its windows there (`here`, the last used first) that
    /// is known; else a new window. A window with no tab strip takes no tab. Nil when it can't be said whose window that would be.
    public static func place(here: [UInt32], all: [UInt32], known: [UInt32: Front], peers: [BrowserPeer]) -> Place? {
        let strip = { (id: UInt32) in known[id]?.tab.popup != true }
        let here = here.filter(strip), all = all.filter(strip)
        for id in here { if let f = known[id] { return .tab(f.peer, window: f.tab.window, id: id) } }
        // Two profiles of one browser: which of them, only a known window tells.
        guard peers.count == 1, let peer = peers.first else { return nil }
        return !here.isEmpty && here.count == all.count ? .front(peer) : .window(peer)
    }
}
