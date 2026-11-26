import BaneySpacesCore
import Foundation

/// Made-up rows for the renders (`Render.swift`).
enum BrowserRender {
    static func actions() -> LauncherActions {
        let book = BrowserBook()
        func take(_ source: BrowserSource, _ rows: [[String: Any]]) {
            let o: [String: Any] = ["op": "browser.rows", "source": source.rawValue, "first": true, "last": true, "rows": rows]
            if let d = try? JSONSerialization.data(withJSONObject: o), let m = BrowserMessage(d) { book.take(m, from: BrowserPeer("com.apple.Safari")) }
        }
        take(.tabs, [["id": 1, "window": 2, "title": "Orchard maps and walks", "url": "https://orchard.example/maps", "incognito": false, "audible": true],
                     ["id": 2, "window": 2, "title": "Map of the orchard", "url": "https://trees.example/", "incognito": false]])
        take(.bookmarks, [["id": "5", "title": "Orchard planting guide", "url": "https://guide.example/plant"]])
        take(.history, [["title": "Orchard weather", "url": "https://weather.example/orchard", "visits": 3]])
        take(.downloads, [["id": 7, "title": "orchard-plan.pdf", "url": "https://guide.example/plan.pdf", "incognito": false, "state": "in_progress", "received": 42, "total": 100]])
        var a = LauncherActions()
        a.browserHits = { book.search($0) }
        return a
    }
}
