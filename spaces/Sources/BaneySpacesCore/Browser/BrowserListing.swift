import Foundation

/// How a browser's answers read and where they stand in the launcher's list (spec/browser.md).
public enum BrowserListing {
    public struct Row: Equatable, Sendable {
        public let hit: BrowserHit
        public let title: String
        public let subtitle: String
        public let badge: String
        /// An SF Symbol, shown until the site's own icon is known. Nil for a tab: the browser's icon says it is open.
        public let symbol: String?
    }

    /// The rows to list. A tab that is already among the session rows (`listed`, their ids) isn't listed twice.
    public static func rows(_ hits: [BrowserHit], listed: Set<String>, app: (String) -> String) -> [Row] {
        hits.filter { !listed.contains($0.id) }.map { h in
            let r = h.row, name = app(h.peer.bundleID), place = URLDisplay.short(r.url)
            func line(_ parts: String...) -> String { parts.filter { !$0.isEmpty }.joined(separator: " · ") }
            switch r.source {
            case .tabs: return Row(hit: h, title: r.title, subtitle: line(name, r.site), badge: r.audible ? "Playing" : r.app != nil ? "App" : "Tab", symbol: nil)
            case .groups: return Row(hit: h, title: r.title, subtitle: line("Tab group", name, "add a workspace's number to send it there"), badge: "", symbol: "rectangle.stack")
            case .bookmarks: return Row(hit: h, title: r.title, subtitle: line("Bookmark", place, "opens in \(name)"), badge: "", symbol: "bookmark")
            case .history: return Row(hit: h, title: r.title, subtitle: line("Visited", place, "opens in \(name)"), badge: "", symbol: "clock")
            case .downloads:
                return Row(hit: h, title: r.title, subtitle: line("Download", r.site, "shows it in Finder"), badge: progress(r.progress), symbol: "arrow.down.circle")
            }
        }
    }

    /// The browser's own row behind each session row (`listed`, their ids), by id: the session row keeps that row's
    /// second action and its "App" badge, since only one of the two is listed.
    public static func behind(_ hits: [BrowserHit], listed: Set<String>) -> [String: BrowserHit] {
        Dictionary(hits.filter { listed.contains($0.id) }.map { ($0.id, $0) }) { first, _ in first }
    }

    /// "42%" while the size is known, else how much has come.
    static func progress(_ p: BrowserRow.Progress?) -> String {
        guard let p else { return "" }
        guard let total = p.total, total > 0 else { return ByteCountFormatter.string(fromByteCount: p.done, countStyle: .file) }
        return "\(min(100, Int(Double(p.done) / Double(total) * 100)))%"
    }

    /// How many of the apps found (their scores, best first) go above the browser's rows: those at least as good as its
    /// best, use left out, so a page visited all day doesn't push an app off its own name. All of them with no rows.
    public static func above(_ hits: [BrowserHit], listed: Set<String> = [], apps: [Int]) -> Int {
        guard let best = hits.filter({ !listed.contains($0.id) }).map({ $0.score - $0.row.weight }).max() else { return apps.count }
        return apps.prefix { $0 >= best }.count
    }

    /// The session engine's rows the launcher ranks. A source's switch governs only what the extension sends (R-B4):
    /// the tabs Polycarp reads from the default browser itself stay, as the tabs switch's help says.
    public static func sessionItems(_ items: [Item], on: Set<BrowserSource>) -> [Item] { items }

    /// A source's switch in Settings.
    public static func setting(_ s: BrowserSource) -> (title: String, help: String) {
        switch s {
        case .tabs: return ("Open tabs", "Return goes to the exact tab. Off, the extension sends none and the bar shows no page; the tabs Polycarp reads from your default browser itself still show in the launcher.")
        case .groups: return ("Tab groups", "Return goes to the group; its name and a workspace's number sends it there.")
        case .bookmarks: return ("Bookmarks", "Opens in the browser that has it.")
        case .history: return ("Recent history", "The pages visited in the last 90 days.")
        case .downloads: return ("Downloads", "Return shows the file in Finder.")
        }
    }

    /// The sources on, from the names of those the person switched off.
    public static func sources(off: [String]) -> Set<BrowserSource> { Set(BrowserSource.allCases.filter { !off.contains($0.rawValue) }) }

    /// "trip planning 3": what a tab group is called and the workspace to send it to.
    public static func sending(_ typed: String, to workspaces: ClosedRange<Int>) -> (name: String, workspace: Int)? {
        let words = typed.split(separator: " ")
        guard words.count > 1, let n = Int(words.last!), workspaces.contains(n) else { return nil }
        return (words.dropLast().joined(separator: " "), n)
    }

    /// What the app asks a browser's extension to do about a row; nil for one it opens itself (a web page).
    public static func ask(_ row: BrowserRow) -> [String: Any]? {
        guard let id = Int(row.key) else { return nil }
        switch row.source {
        case .tabs: return ["op": "browser.go", "tab": id]
        case .groups: return ["op": "browser.go", "group": id]
        case .downloads: return ["op": "browser.show", "download": id]
        case .bookmarks, .history: return nil
        }
    }
}
