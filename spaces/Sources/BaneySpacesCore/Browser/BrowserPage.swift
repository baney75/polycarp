import Foundation

/// What the bar's `page` module shows for a workspace: the page in front of the browser window there, a tab that plays
/// sound and the downloads on their way. Made from what the sources switched on say, and from nothing else.
public struct BrowserPage: Equatable, Sendable {
    public let front: BrowserWindows.Front?
    /// The front page when it plays, else the first tab that does.
    public let playing: BrowserWindows.Front?
    public let downloads: Downloads?

    public struct Downloads: Equatable, Sendable {
        public let count: Int
        /// Nil when a site didn't say how much there is.
        public let percent: Int?
        /// One of them, to show in Finder.
        public let one: BrowserWindows.Front

        public var short: String { percent.map { "\($0)%" } ?? (count == 1 ? "" : "\(count)") }
        public var label: String {
            let what = count == 1 ? "1 download" : "\(count) downloads"
            return percent.map { "\(what), \($0)%" } ?? what
        }
    }

    /// Nil when there is nothing to show.
    public init?(front: BrowserWindows.Front?, tabs: [(peer: BrowserPeer, row: BrowserRow)], downloads rows: [(peer: BrowserPeer, row: BrowserRow)]) {
        let loud = tabs.filter(\.row.audible).map { BrowserWindows.Front($0.peer, $0.row) }
        self.front = front
        playing = loud.first { $0 == front } ?? loud.first
        let coming = rows.compactMap { r in r.row.progress.map { (r, $0) } }
        downloads = coming.first.map { first in
            let totals = coming.compactMap { $0.1.total }
            let done = coming.reduce(0.0) { $0 + Double($1.1.done) }, all = totals.reduce(0.0) { $0 + Double($1) }
            return Downloads(count: coming.count, percent: totals.count == coming.count && all > 0 ? Int(min(100, done / all * 100)) : nil,
                             one: .init(first.0.peer, first.0.row))
        }
        if front == nil, playing == nil, downloads == nil { return nil }
    }

    /// The window whose page is in front on a workspace, of its windows `here`: the one last used there when it is a
    /// browser's, else the browser's that was (`before`), else the only one known.
    public static func window(here: [UInt32], last: UInt32?, before: UInt32?, known: [UInt32: BrowserWindows.Front]) -> UInt32? {
        let open = here.filter { known[$0] != nil }
        for id in [last, before] { if let id, open.contains(id) { return id } }
        return open.count == 1 ? open[0] : nil
    }

    /// A page's title as the bar has room for it: at most 36 characters.
    public static func title(_ front: BrowserWindows.Front) -> String {
        let t = front.tab.title
        return t.count <= 36 ? t : t.prefix(35).trimmingCharacters(in: .whitespaces) + "\u{2026}"
    }
}
