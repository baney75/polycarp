import AppKit
import BaneySpacesCore
import Foundation

/// Made-up rows for the renders (`Render.swift`).
enum BrowserRender {
    static func actions() -> LauncherActions {
        let book = book()
        var a = LauncherActions()
        a.browserHits = { book.search($0) }
        a.frontPage = { book.fronts(of: "com.apple.Safari").first }
        let made = WebApps.adding("Orchard Post", url: "https://post.example/", browser: "com.apple.Safari", icon: nil, to: [])
        a.webApps = WebAppStore(at: URL(fileURLWithPath: "/dev/null/webapps.json"), list: made?.list ?? [])
        return a
    }

    static func page() -> TopBarModel.Page {
        let book = book()
        return .init(now: BrowserPage(front: book.fronts(of: "com.apple.Safari").first, tabs: book.rows(.tabs), downloads: book.rows(.downloads))!,
                     icon: NSImage(systemSymbolName: "tree.fill", accessibilityDescription: nil))
    }

    /// A made-up page's text, as the extension sends it for a quick look.
    static func text() -> BrowserText {
        let text = """
        Plant young trees in late autumn, once the leaves have fallen and before the ground freezes.
        Dig a hole twice as wide as the roots and no deeper than they grew. Spread the roots out, fill in with the soil you took out, and water it well.

        Stake each tree on the side the wind comes from, and tie it loosely so it can still sway a little. A tree that moves grows a stronger trunk.
        In the first summer, water once a week when it doesn't rain, and keep grass back from the trunk for a yard all round.
        """
        let o: [String: Any] = ["op": "browser.text", "tab": 1, "title": "Orchard planting guide", "text": text]
        return BrowserText(try! JSONSerialization.data(withJSONObject: o))!
    }

    static func download() -> NoticeBanner { BrowserNotices.done(page().now.downloads!.one, app: "Safari") }

    private static func book() -> BrowserBook {
        let book = BrowserBook()
        func take(_ source: BrowserSource, _ rows: [[String: Any]]) {
            let o: [String: Any] = ["op": "browser.rows", "source": source.rawValue, "first": true, "last": true, "rows": rows]
            if let d = try? JSONSerialization.data(withJSONObject: o), let m = BrowserMessage(d) { book.take(m, from: BrowserPeer("com.apple.Safari")) }
        }
        take(.tabs, [["id": 1, "window": 2, "title": "Orchard maps and walks", "url": "https://orchard.example/maps", "incognito": false, "audible": true],
                     ["id": 2, "window": 2, "title": "Map of the orchard", "url": "https://trees.example/", "incognito": false, "front": true]])
        take(.bookmarks, [["id": "5", "title": "Orchard planting guide", "url": "https://guide.example/plant"]])
        take(.history, [["title": "Orchard weather", "url": "https://weather.example/orchard", "visits": 3]])
        take(.downloads, [["id": 7, "title": "orchard-plan.pdf", "url": "https://guide.example/plan.pdf", "incognito": false, "state": "in_progress", "received": 42, "total": 100]])
        return book
    }
}
