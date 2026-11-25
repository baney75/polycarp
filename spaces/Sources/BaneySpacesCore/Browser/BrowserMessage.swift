import Foundation

/// What the Polycarp extension may tell the app about a browser (spec/browser.md). Each has its own switch.
public enum BrowserSource: String, CaseIterable, Sendable {
    case tabs, bookmarks, history, downloads

    /// The most rows kept from one browser; rows past it are dropped.
    public var most: Int {
        switch self {
        case .tabs: return 5_000
        case .bookmarks: return 20_000
        case .history: return 50_000
        case .downloads: return 500
        }
    }
}

/// One tab, bookmark, page visited or download. Held in memory and nowhere else: it isn't `Codable`, and printing,
/// dumping or interpolating one says only what kind of row it is, so a log line or a crash's text can't carry a page.
public struct BrowserRow: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let source: BrowserSource
    /// The browser's own id for it: a tab's, bookmark's or download's id; a visited page's address.
    public let key: String
    public let title: String
    /// Without a name and password in it. Empty when the page has none worth opening (`about:`, `data:`, `blob:`).
    public let url: String
    /// Tabs: the browser's window, the tab group it is in, and how it stands.
    public let window: Int
    public let group: Int?
    public let audible: Bool
    public let pinned: Bool
    /// The front tab of its window.
    public let front: Bool
    /// Downloads: done of total bytes while one is on its way.
    public let progress: Progress?
    /// How much the person uses it, 0 to 60, for ranking.
    public let weight: Int

    public struct Progress: Equatable, Sendable {
        public let done: Int64
        /// Nil when the site didn't say.
        public let total: Int64?
    }

    /// `example.com`, without `www.`; empty for a page that isn't on the web.
    public var site: String { BrowserMessage.site(url) }
    public var description: String { "browser row (\(source.rawValue))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// One message from the extension, checked. It carries either all of a source's rows, in pieces (`rows`, from `first` to
/// `last`), or what changed in it.
public struct BrowserMessage: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public enum Change: Sendable {
        case rows([BrowserRow], first: Bool, last: Bool)
        case change([BrowserRow], gone: [String])
    }
    public let source: BrowserSource
    public let change: Change
    /// Each row's title and address as they are matched, worked out here, off the main thread.
    let folded: [(title: String, address: String)]

    static let titleMost = 300

    public var description: String { "browser message (\(source.rawValue))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
    static let addressMost = 2_048

    /// Nil when it isn't one of ours. A row that is malformed, or that could be from a private window, is left out and
    /// the rest of the message stands.
    public init?(_ data: Data, now: Date = Date()) {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let op = o["op"] as? String,
              let source = (o["source"] as? String).flatMap(BrowserSource.init(rawValue:)) else { return nil }
        let rows = (o["rows"] as? [Any] ?? []).prefix(source.most).compactMap { ($0 as? [String: Any]).flatMap { Self.row($0, source, now) } }
        switch op {
        case "browser.rows": change = .rows(rows, first: o["first"] as? Bool ?? false, last: o["last"] as? Bool ?? false)
        case "browser.change":
            // A visited page is kept by its address without a name and password, so it goes by that address.
            let gone = (o["gone"] as? [Any] ?? []).compactMap(Self.key)
            change = .change(rows, gone: source == .history ? gone.map(Self.clean).filter { !$0.isEmpty } : gone)
        default: return nil
        }
        self.source = source
        folded = rows.map { (Fuzzy.fold($0.title), Fuzzy.fold(Self.shown($0.url))) }
    }

    private static func row(_ o: [String: Any], _ source: BrowserSource, _ now: Date) -> BrowserRow? {
        let url = clean(o["url"] as? String ?? "")
        let title = NoticeReader.clean(o["title"] as? String ?? "", most: titleMost)
        var weight = 0, window = 0
        var progress: BrowserRow.Progress?
        let name: String
        switch source {
        case .tabs, .downloads:
            // A private window's tab or download never gets in: the extension must say outright that it is neither.
            guard flag(o["incognito"]) == false, let k = key(o["id"]) else { return nil }
            name = k
            if source == .tabs {
                guard flag(o["window"]) == nil, let w = o["window"] as? Int, w > 0 else { return nil }
                (window, weight) = (w, 25)
            } else if o["state"] as? String == "in_progress" {
                let total = (o["total"] as? NSNumber)?.int64Value ?? -1
                progress = .init(done: max(0, (o["received"] as? NSNumber)?.int64Value ?? 0), total: total > 0 ? total : nil)
            }
        case .bookmarks:
            guard let k = key(o["id"]), web(url) else { return nil }
            (name, weight) = (k, 10)
        case .history:
            guard web(url) else { return nil }
            name = url
            let visits = max(0, o["visits"] as? Int ?? 0)
            let days = max(0, now.timeIntervalSince1970 - (o["last"] as? Double ?? 0) / 1000) / 86_400
            weight = min(30, visits) + (days < 1 ? 20 : days < 7 ? 12 : days < 30 ? 5 : 0)
        }
        guard !title.isEmpty || !url.isEmpty else { return nil }
        return BrowserRow(source: source, key: name, title: title.isEmpty ? String(shown(url).prefix(titleMost)) : title, url: url, window: window,
                          group: (o["group"] as? Int).flatMap { $0 >= 0 ? $0 : nil }, audible: o["audible"] as? Bool ?? false,
                          pinned: o["pinned"] as? Bool ?? false, front: o["front"] as? Bool ?? false, progress: progress, weight: weight)
    }

    /// A JSON true or false, and nothing else: `0` and `1` come out of `JSONSerialization` as numbers that cast to `Bool`.
    static func flag(_ v: Any?) -> Bool? {
        guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }

    private static func key(_ v: Any?) -> String? {
        if flag(v) != nil { return nil }
        if let s = v as? String { return s.isEmpty || s.utf8.count > addressMost ? nil : s }
        return (v as? Int).map(String.init)
    }

    static func web(_ url: String) -> Bool { url.hasPrefix("https://") || url.hasPrefix("http://") }

    /// The address to keep: none for a page with no address of its own, and never a name and password.
    static func clean(_ url: String) -> String {
        guard url.utf8.count <= addressMost, let colon = url.firstIndex(of: ":") else { return "" }
        let scheme = url[..<colon].lowercased()
        guard !["data", "blob", "javascript", "about", "filesystem"].contains(scheme) else { return "" }
        guard let from = url.range(of: "://")?.upperBound else { return url }
        let end = url[from...].firstIndex { "/?#\\".contains($0) } ?? url.endIndex
        guard let at = url[from..<end].lastIndex(of: "@") else { return url }
        return String(url[..<from] + url[url.index(after: at)...])
    }

    /// The address as it is matched and shown: no scheme, no `www.`, no closing slash.
    static func shown(_ url: String) -> String {
        guard let from = url.range(of: "://")?.upperBound else { return url }
        var s = url[from...]
        if s.hasPrefix("www.") { s = s.dropFirst(4) }
        if s.hasSuffix("/") { s = s.dropLast() }
        return String(s)
    }

    static func site(_ url: String) -> String {
        web(url) ? String(shown(url).prefix { !"/?#:".contains($0) }) : ""
    }
}
