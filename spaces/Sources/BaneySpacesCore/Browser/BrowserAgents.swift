import Foundation

/// What an agent may see of the browser through Polycarp's MCP gateway (the `browser:read` scope, `browser_tabs`):
/// each open tab's title and address, which browser it is in, and whether it is its window's front tab. Nothing else:
/// no page text, history, bookmarks, downloads or groups, no private window (the extension never sends one), and no
/// way to click, open or close. It stays off until the person turns it on in Settings.
public enum BrowserAgents {
    /// The setting's key. Only the Settings switch writes it: no wire op or `SettingKey` reaches it.
    public static let key = "browserAgentsRead"
    public static let most = 200
    public static let shown = 50
    public static let off = "browser_read_off"

    /// The tabs an agent asked for: every word of `query` in the title or address, at most `limit` (1 to 200, 50 when
    /// left out). A tab with no address worth opening is left out.
    public static func tabs(_ rows: [(peer: BrowserPeer, row: BrowserRow)], query: String?, limit: Int?) -> [[String: Any]] {
        let words = (query ?? "").prefix(200).split(whereSeparator: \.isWhitespace).map(String.init)
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let wanted = words.map(fold)
        let n = min(max(limit ?? shown, 1), most)
        var out: [[String: Any]] = []
        for (peer, row) in rows where row.source == .tabs && !row.url.isEmpty {
            let hay = fold(row.title + "\n" + row.url)
            guard wanted.allSatisfy({ hay.contains($0) }) else { continue }
            out.append(["title": row.title, "url": row.url, "browser": peer.bundleID, "front": row.front])
            if out.count == n { break }
        }
        return out
    }

    /// The app's answer to the wire op `browser` with text `tabs`. `on` is the person's switch, read at each request.
    public static func reply(_ r: Wire.Request, on: Bool, rows: @autoclosure () -> [(peer: BrowserPeer, row: BrowserRow)]) -> Wire.Reply {
        guard on else {
            return .init(ok: false, error: "The owner hasn't let agents see their browser tabs. They can turn on \u{201C}Let agents see my tabs\u{201D} in Polycarp's Settings, under Agents.",
                         info: ["code": off])
        }
        guard r.text == "tabs" else { return .init(ok: false, error: "browser answers only tabs", info: ["code": "unknown"]) }
        let list = tabs(rows(), query: r.target, limit: r.args?.first.flatMap { Int($0) })
        guard let data = try? JSONSerialization.data(withJSONObject: list, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return .init(ok: false, error: "couldn't list the tabs") }
        return .init(ok: true, info: ["tabs": text, "count": String(list.count)])
    }
}
