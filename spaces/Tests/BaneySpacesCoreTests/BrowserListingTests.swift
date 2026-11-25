import XCTest
@testable import BaneySpacesCore

/// How a browser's answers read in the launcher, and where they stand.
final class BrowserListingTests: XCTestCase {
    private let peer = BrowserPeer("org.example.browser", 1)
    private func book(_ source: BrowserSource, _ row: [String: Any]) -> BrowserBook {
        let b = BrowserBook()
        let m: [String: Any] = ["op": "browser.rows", "source": source.rawValue, "first": true, "last": true, "rows": [row]]
        b.take(BrowserMessage(try! JSONSerialization.data(withJSONObject: m))!, from: peer)
        return b
    }
    private func row(_ source: BrowserSource, _ o: [String: Any], listed: Set<String> = []) -> BrowserListing.Row? {
        BrowserListing.rows(book(source, o).search("knit"), listed: listed) { _ in "Browser" }.first
    }

    func testEachKindSaysWhatItIsAndWhereItGoes() {
        let tab: [String: Any] = ["id": 4, "window": 2, "title": "Knitting", "url": "https://www.yarn.example/p", "incognito": false]
        XCTAssertEqual(row(.tabs, tab)?.subtitle, "Browser · yarn.example")
        XCTAssertEqual(row(.tabs, tab)?.badge, "Tab")
        XCTAssertEqual(row(.tabs, tab.merging(["url": "about:blank"]) { $1 })?.subtitle, "Browser", "no empty part")
        XCTAssertNil(row(.tabs, tab)?.symbol)
        XCTAssertEqual(row(.tabs, tab.merging(["audible": true]) { $1 })?.badge, "Playing")
        XCTAssertEqual(row(.groups, tab)?.subtitle, "Tab group · Browser · add a workspace's number to send it there")
        XCTAssertEqual(row(.bookmarks, ["id": "9", "title": "Knitting", "url": "https://yarn.example/p"])?.subtitle, "Bookmark · yarn.example/p · opens in Browser")
        XCTAssertEqual(row(.history, ["title": "Knitting", "url": "https://yarn.example/p"])?.subtitle, "Visited · yarn.example/p · opens in Browser")
        let file: [String: Any] = ["id": 7, "title": "knit.pdf", "url": "https://yarn.example/k", "incognito": false]
        XCTAssertEqual(row(.downloads, file)?.badge, "")
        XCTAssertEqual(row(.downloads, file.merging(["state": "in_progress", "received": 42, "total": 100]) { $1 })?.badge, "42%")
        XCTAssertEqual(row(.downloads, file.merging(["state": "in_progress", "received": 900, "total": 100]) { $1 })?.badge, "100%")
        XCTAssertEqual(row(.downloads, file.merging(["state": "in_progress", "received": 2_000, "total": -1]) { $1 })?.badge, "2 KB")
        XCTAssertEqual(BrowserListing.progress(.init(done: 2_000, total: 0)), "2 KB", "a size of nothing is no percent")
    }

    func testATabTheSessionRowsListIsNotListedAgain() {
        let tab: [String: Any] = ["id": 4, "window": 2, "title": "Knitting", "url": "https://yarn.example/", "incognito": false]
        XCTAssertNil(row(.tabs, tab, listed: ["tab:org.example.browser:2:4"]))
        XCTAssertNotNil(row(.tabs, tab, listed: ["tab:org.example.browser:2:5", "tab:org.example.other:2:4"]))
        // The session engine's own row for the same tab has the same id.
        let spec = AppSpec(bundleID: "org.example.browser", name: "Browser", role: .browser, adapter: .chromium)
        let snap = ScriptedSnapshot(windows: [.init(id: "2", title: "Knitting", activeTab: 1, isPrivate: false)],
                                    tabs: [.init(windowID: "2", id: "4", index: 1, title: "Knitting", url: "https://yarn.example/", tty: "", selected: true)])
        let engine = Build.scripted(spec, snap, numbers: [:], front: false, frontWindowNumber: 0).map(\.id)
        XCTAssertEqual(engine, ["tab:org.example.browser:2:4"])
        XCTAssertNil(row(.tabs, tab, listed: Set(engine)))
        // Off, the tabs switch stops what the extension sends; the engine's own tab still shows.
        let items = Build.scripted(spec, snap, numbers: [:], front: false, frontWindowNumber: 0)
        XCTAssertEqual(BrowserListing.sessionItems(items, on: []).map(\.id), engine)
    }

    func testTheBetterOfTheBestAppAndTheBestPageComesFirst() {
        let hits = book(.tabs, ["id": 4, "window": 2, "title": "Knitting", "url": "https://yarn.example/", "incognito": false]).search("knit")
        XCTAssertEqual(hits.first?.score, 892 + 25)
        XCTAssertEqual(BrowserListing.above(hits, apps: [905, 892, 891, 250]), 2, "equal, the app goes first; a tab's use isn't counted")
        XCTAssertEqual(BrowserListing.above(hits, apps: [300]), 0)
        XCTAssertEqual(BrowserListing.above([], apps: [300, 200]), 2)
        XCTAssertEqual(BrowserListing.above(hits, listed: [hits[0].id], apps: [300]), 1, "a page the session rows list puts no app below it")
        XCTAssertEqual(Set(BrowserSource.allCases.map { BrowserListing.setting($0).title }).count, BrowserSource.allCases.count)
    }

    func testTheSwitchesAndWhatTheBrowserIsAsked() {
        XCTAssertEqual(BrowserListing.sources(off: []), Set(BrowserSource.allCases))
        XCTAssertEqual(BrowserListing.sources(off: ["history", "tabs", "nonsense"]), [.groups, .bookmarks, .downloads])
        let tab = book(.tabs, ["id": 4, "window": 2, "title": "Knitting", "incognito": false]).rows(.tabs)[0].row
        XCTAssertEqual(BrowserListing.ask(tab) as NSDictionary?, ["op": "browser.go", "tab": 4])
        let group = book(.groups, ["id": 12, "window": 2, "title": "Knitting", "incognito": false]).rows(.groups)[0].row
        XCTAssertEqual(BrowserListing.ask(group) as NSDictionary?, ["op": "browser.go", "group": 12])
        let file = book(.downloads, ["id": 7, "title": "knit.pdf", "incognito": false]).rows(.downloads)[0].row
        XCTAssertEqual(BrowserListing.ask(file) as NSDictionary?, ["op": "browser.show", "download": 7])
        let mark = book(.bookmarks, ["id": "9", "title": "Knitting", "url": "https://yarn.example/"]).rows(.bookmarks)[0].row
        XCTAssertNil(BrowserListing.ask(mark))
    }

    func testAGroupsNameAndAWorkspacesNumberSendsItThere() {
        func sending(_ q: String) -> [String] { BrowserListing.sending(q, to: 1...9).map { [$0.name, String($0.workspace)] } ?? [] }
        XCTAssertEqual(sending("trip planning 3"), ["trip planning", "3"])
        XCTAssertEqual(sending("trip 2026 9"), ["trip 2026", "9"])
        for q in ["trip 0", "trip 10", "3", "trip", "trip three", ""] { XCTAssertEqual(sending(q), [], q) }
        let b = book(.groups, ["id": 12, "window": 2, "title": "Trip planning", "incognito": false])
        b.take(BrowserMessage(try! JSONSerialization.data(withJSONObject: ["op": "browser.rows", "source": "groups", "first": true, "last": true, "rows": [
            ["id": 13, "window": 5, "title": "Trip", "incognito": false], ["id": 14, "window": 5, "title": "Trip, secret", "incognito": true]]]))!, from: BrowserPeer("org.example.other"))
        XCTAssertEqual(b.group("trip")?.row.key, "13", "the better match, whichever browser has it")
        XCTAssertEqual(b.group("trip plan")?.row.key, "12")
        XCTAssertEqual(b.group("trip plan")?.peer, peer)
        XCTAssertNil(b.group("secret"))
        XCTAssertNil(b.group("tg"), "letters apart are no name")
        b.allow([.tabs])
        XCTAssertNil(b.group("trip"), "switched off")
    }
}
