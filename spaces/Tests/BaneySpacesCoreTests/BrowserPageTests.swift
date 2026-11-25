import XCTest
@testable import BaneySpacesCore

/// What the bar's `page` module shows (spec/browser.md R-B13).
final class BrowserPageTests: XCTestCase {
    private let one = BrowserPeer("com.example.browser"), two = BrowserPeer("com.example.other")

    private func book(_ source: BrowserSource, _ rows: [[String: Any]], allowed: Set<BrowserSource> = Set(BrowserSource.allCases)) -> BrowserBook {
        let b = BrowserBook(allowed: allowed)
        let o: [String: Any] = ["op": "browser.rows", "source": source.rawValue, "first": true, "last": true, "rows": rows]
        b.take(BrowserMessage(try! JSONSerialization.data(withJSONObject: o))!, from: one)
        return b
    }
    private func tab(_ id: Int, window: Int = 1, _ more: [String: Any] = [:]) -> [String: Any] {
        ["id": id, "window": window, "title": "Page \(id)", "url": "https://a.example/\(id)", "incognito": false].merging(more) { $1 }
    }
    private func file(_ id: Int, _ done: Int, _ total: Int, _ state: String = "in_progress") -> [String: Any] {
        ["id": id, "title": "file \(id)", "url": "https://d.example/\(id)", "incognito": false, "state": state, "received": done, "total": total]
    }
    private func page(_ b: BrowserBook, front: BrowserWindows.Front? = nil) -> BrowserPage? {
        BrowserPage(front: front, tabs: b.rows(.tabs), downloads: b.rows(.downloads))
    }

    func testNothingOpenPlayingOrComingIsNoModule() {
        XCTAssertNil(page(BrowserBook()))
        XCTAssertNil(page(book(.tabs, [tab(1, ["front": true])])), "a page that isn't on this workspace")
        XCTAssertNil(page(book(.downloads, [file(1, 10, 10, "complete"), file(2, 3, 10, "interrupted")])))
    }

    func testSoundIsTheFrontPagesOwnBeforeAnothers() {
        let b = book(.tabs, [tab(1, ["audible": true]), tab(2, ["audible": true, "front": true]), tab(3)])
        XCTAssertEqual(page(b)?.playing?.tab.key, "1")
        XCTAssertEqual(page(b, front: b.fronts(of: one.bundleID)[0])?.playing?.tab.key, "2")
        XCTAssertNil(page(book(.tabs, [tab(1), tab(3)])))
        XCTAssertNil(page(book(.tabs, [tab(1, ["audible": true])], allowed: [.downloads])), "tabs are off")
    }

    func testDownloadsAreOneNumberWhenEverySizeIsKnown() {
        let two = page(book(.downloads, [file(1, 25, 100), file(2, 50, 300), file(3, 9, 9, "complete")]))?.downloads
        XCTAssertEqual([two?.short, two?.label, two?.one.tab.key], ["18%", "2 downloads, 18%", "1"])
        let one = page(book(.downloads, [file(1, 120, 100)]))?.downloads
        XCTAssertEqual([one?.short, one?.label], ["100%", "1 download, 100%"], "a site that said too little")
        let wild = page(book(.downloads, [file(1, Int(Int64.max), 1)]))?.downloads
        XCTAssertEqual(wild?.short, "100%", "far more than its size is clamped before it becomes a number")
        let unsaid = page(book(.downloads, [file(1, 25, 100), file(2, 50, -1)]))?.downloads
        XCTAssertEqual([unsaid?.short, unsaid?.label], ["2", "2 downloads"])
        XCTAssertEqual(page(book(.downloads, [file(2, 50, -1)]))?.downloads?.short, "")
    }

    func testTheFrontWindowIsTheBrowsersLastUsedHere() {
        let b = book(.tabs, [tab(1, window: 1, ["front": true]), tab(2, window: 2, ["front": true])])
        let f = b.fronts(of: one.bundleID), known: [UInt32: BrowserWindows.Front] = [7: f[0], 8: f[1]]
        func window(_ here: [UInt32], last: UInt32? = nil, before: UInt32? = nil) -> UInt32? { BrowserPage.window(here: here, last: last, before: before, known: known) }
        XCTAssertEqual(window([7, 8, 9], last: 8, before: 7), 8)
        XCTAssertEqual(window([7, 8, 9], last: 9, before: 7), 7, "another app is in front: the browser window used before it")
        XCTAssertNil(window([7, 8, 9], last: 9), "either could be")
        XCTAssertEqual(window([7, 9], last: 9, before: 8), 7, "the one used before has gone elsewhere")
        XCTAssertNil(window([9], last: 8, before: 7))
    }

    func testATitleIsShort() {
        func title(_ t: String) -> String { BrowserPage.title(book(.tabs, [tab(1, ["title": t, "front": true])]).fronts(of: one.bundleID)[0]) }
        XCTAssertEqual(title("Orchard"), "Orchard")
        XCTAssertEqual(title(String(repeating: "a", count: 36)), String(repeating: "a", count: 36))
        XCTAssertEqual(title(String(repeating: "a", count: 34) + " bcd"), String(repeating: "a", count: 34) + "\u{2026}")
    }
}
