import XCTest
@testable import BaneySpacesCore

/// Sites made into apps (spec/browser.md R-B15).
final class WebAppsTests: XCTestCase {
    private let one = BrowserPeer("com.example.browser")
    private func add(_ name: String, _ url: String = "https://mail.example/", _ browser: String = "com.example.browser", icon: Data? = nil, to list: [WebApp] = [], id: String = "a-1") -> (list: [WebApp], app: WebApp)? {
        WebApps.adding(name, url: url, browser: browser, icon: icon, to: list, id: id)
    }

    func testTheNameOfferedIsTheSitesPartOfTheTitle() {
        for (title, name) in [("Inbox (3) - Mail", "Mail"), ("a - b - c", "c"), ("Plan \u{2013} Docs \u{2014} Orchard", "Orchard"), ("a | b \u{B7} c", "c"), ("Tree-top", "Tree-top"), ("", "mail.example"), ("Mail - ", "mail.example"),
                              ("https://mail.example/a - b", "mail.example"), ("x\u{202E}y", "xy"), (String(repeating: "n", count: 60), nil)] as [(String, String?)] {
            let got = WebApps.name(title: title, site: "mail.example")
            if let name { XCTAssertEqual(got, name, title) } else { XCTAssertLessThanOrEqual(got.count, 41) }
        }
    }

    func testOnlyAWebPageWithANameIsMadeAnApp() throws {
        let made = try XCTUnwrap(add("  Mail\n", icon: Data([1])))
        XCTAssertEqual(made.list, [made.app])
        XCTAssertEqual(made.app, WebApp(id: "a-1", name: "Mail", url: "https://mail.example/", browser: one.bundleID, icon: Data([1])))
        for url in ["chrome://settings", "javascript:x", "file:///etc", "", "mail.example"] { XCTAssertNil(add("Mail", url), url) }
        for name in ["", "  ", "\u{202E}"] { XCTAssertNil(add(name)) }
        XCTAssertNil(add("Mail", id: "A 1"))
        XCTAssertNil(add("Mail", icon: Data(count: WebApps.iconMost + 1))?.app.icon)
        XCTAssertEqual(add("Mail", icon: Data(count: WebApps.iconMost))?.app.icon?.count, WebApps.iconMost)
    }

    func testTheSamePageInTheSameBrowserIsOneApp() throws {
        let list = try XCTUnwrap(add("Mail", icon: Data([1]))).list
        let again = try XCTUnwrap(add("Post", to: list, id: "b-2"))
        XCTAssertEqual(again.list, [WebApp(id: "a-1", name: "Post", url: "https://mail.example/", browser: one.bundleID, icon: Data([1]))], "it keeps its windows and its icon")
        XCTAssertEqual(again.app, again.list[0])
        XCTAssertEqual(add("Mail", icon: Data([2]), to: list)?.app.icon, Data([2]))
        XCTAssertEqual(add("Mail", "https://mail.example/", "com.example.other", to: list, id: "b-2")?.list.map(\.id), ["a-1", "b-2"])
        XCTAssertEqual(add("Mail", "https://mail.example/b", to: list, id: "b-2")?.list.map(\.id), ["a-1", "b-2"])
        let full = (0..<WebApps.most).map { WebApp(id: "n-\($0)", name: "n", url: "https://\($0).example/", browser: "b", icon: nil) }
        XCTAssertNil(add("Mail", to: full))
        XCTAssertEqual(add("New", "https://3.example/", "b", to: full)?.list[3].name, "New")
    }

    func testTheFileIsReadBackAndABadOneIsNeverTakenForAnEmptyOne() throws {
        let list = try XCTUnwrap(add("Mail", icon: Data([1, 2]))).list
        XCTAssertEqual(WebApps.decode(WebApps.encode(list)), list)
        XCTAssertEqual(WebApps.decode(nil), [])
        for bad in ["", "{}", "[{\"id\":\"a\"}]"] { XCTAssertNil(WebApps.decode(Data(bad.utf8)), bad) }
        let odd = list + [WebApp(id: "A B", name: "x", url: "https://x.example/", browser: "b", icon: nil), WebApp(id: "x", name: "x", url: "file:///etc", browser: "b", icon: nil), WebApp(id: "y", name: "", url: "https://x.example/", browser: "b", icon: nil)]
        XCTAssertEqual(WebApps.decode(WebApps.encode(odd)), list)
        let big = WebApp(id: "big", name: "Big", url: "https://x.example/", browser: "b", icon: Data(count: WebApps.iconMost + 1))
        XCTAssertEqual(WebApps.decode(WebApps.encode([big]))?.map { [$0.id, $0.icon == nil ? "no icon" : "icon"] }, [["big", "no icon"]])
        XCTAssertEqual(WebApps.decode(WebApps.encode((0..<150).map { WebApp(id: "n-\($0)", name: "n", url: "https://x.example/", browser: "b", icon: nil) }))?.count, WebApps.most)
    }

    func testTheLauncherFindsThemByName() {
        let list = ["Orchard Map", "Map", "Mail", "Mast"].enumerated().map { WebApp(id: "a-\($0)", name: $1, url: "https://x.example/", browser: "b", icon: nil) }
        XCTAssertEqual(WebApps.find("map", in: list).map(\.name), ["Map", "Orchard Map"])
        XCTAssertEqual(WebApps.find("ma", in: list).map(\.name), ["Map", "Mail", "Mast", "Orchard Map"], "a tie goes by name")
        XCTAssertEqual(WebApps.find(" ", in: list), [])
        XCTAssertEqual(WebApps.find("zzz", in: list), [])
    }

    func testATabSaysItsAppAndAWindowWithNoTabStripTakesNoTab() throws {
        func rows(_ o: [String: Any], _ source: String = "tabs") -> [BrowserRow] {
            let base: [String: Any] = ["id": 1, "window": 4, "title": "Inbox", "url": "https://mail.example/", "incognito": false, "front": true]
            let m = BrowserMessage(try! JSONSerialization.data(withJSONObject: ["op": "browser.rows", "source": source, "first": true, "last": true, "rows": [base.merging(o) { $1 }]]))
            guard case .rows(let rows, _, _)? = m?.change else { return [] }
            return rows
        }
        XCTAssertEqual(rows([:]).map(\.popup), [false])
        XCTAssertEqual(rows(["popup": true, "app": "mail-1"]).map(\.app), ["mail-1"])
        for bad in ["A", "", "a b", String(repeating: "a", count: 41)] { XCTAssertEqual(rows(["app": bad]).map(\.app), [nil], bad) }
        XCTAssertTrue(WebApps.fits(rows([:])[0]))
        XCTAssertFalse(WebApps.fits(rows(["app": "mail-1"])[0]), "an app already")
        XCTAssertFalse(WebApps.fits(rows(["url": "chrome://settings"])[0]))
        for (source, fits) in [("bookmarks", true), ("history", true), ("groups", false), ("downloads", false)] {
            XCTAssertEqual(rows([:], source).map(WebApps.fits), [fits], source)
        }
        for (row, badge) in [(rows([:])[0], "Tab"), (rows(["app": "mail-1"])[0], "App"), (rows(["app": "mail-1", "audible": true])[0], "Playing")] {
            XCTAssertEqual(BrowserListing.rows([BrowserHit(BrowserWindows.Front(one, row))], listed: [], app: { $0 }).map(\.badge), [badge])
        }
        let app = BrowserWindows.Front(one, rows(["popup": true, "app": "mail-1"])[0]), plain = BrowserWindows.Front(one, rows([:])[0])
        XCTAssertEqual(BrowserWindows.place(here: [7, 8], all: [7, 8], known: [7: app, 8: plain], peers: [one]), .tab(one, window: 4, id: 8))
        XCTAssertEqual(BrowserWindows.place(here: [7], all: [7, 8], known: [7: app], peers: [one]), .window(one), "only an app's window is here")
        XCTAssertEqual(BrowserWindows.place(here: [7, 8], all: [7, 8], known: [7: app], peers: [one]), .front(one), "every window with tabs is here")
    }
}
