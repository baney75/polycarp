import XCTest
@testable import BaneySpacesCore

/// A browser's windows and the Mac's (spec/browser.md R-B9, R-B10).
final class BrowserWindowsTests: XCTestCase {
    private let one = BrowserPeer("com.example.browser"), two = BrowserPeer("com.example.browser", 1)

    private func tab(_ id: Int, _ title: String, window: Int, front: Bool = true) -> BrowserRow {
        let o: [String: Any] = ["op": "browser.rows", "source": "tabs", "first": true, "last": true, "rows": [
            ["id": id, "window": window, "title": title, "url": "https://a.example/\(id)", "incognito": false, "front": front]]]
        guard let m = BrowserMessage(try! JSONSerialization.data(withJSONObject: o)), case .rows(let rows, _, _) = m.change else { fatalError() }
        return rows[0]
    }
    private func front(_ title: String, _ window: Int, _ peer: BrowserPeer? = nil) -> BrowserWindows.Front { .init(peer ?? one, tab(window * 10, title, window: window)) }
    private func match(_ windows: [(UInt32, String)], _ fronts: [BrowserWindows.Front], _ numbers: [Int: UInt32] = [:]) -> [UInt32: Int] {
        BrowserWindows.match(windows.map { (id: $0.0, title: $0.1) }, fronts, numbers: numbers).mapValues(\.tab.window)
    }

    func testAWindowIsTheOneWhoseFrontTabItsTitleNames() {
        XCTAssertEqual(match([(7, "Knitting - Helium"), (8, "Weather"), (9, "Weatherman - Helium")], [front("Knitting", 1), front("Weather", 2)]), [7: 1, 8: 2])
        XCTAssertEqual(match([(7, "Maps - Home - Helium"), (8, "Maps - Helium")], [front("Maps", 1), front("Maps - Home", 2)]), [7: 2, 8: 1], "the longest title")
        XCTAssertEqual(match([(7, "Maps - Work"), (8, "Maps - Home")], [front("Maps", 1)]), [:], "two windows could be it")
        XCTAssertEqual(match([(7, "Maps \u{2013} Work"), (8, "News \u{2014} Home")], [front("Maps", 1), front("News", 2)]), [7: 1, 8: 2], "either dash")
        XCTAssertEqual(match([(7, "Maps - Helium")], [front("Maps", 1), front("Maps", 2)]), [:], "it could be either")
        XCTAssertEqual(match([(7, ""), (8, "Helium")], [front("", 1)]), [:])
        let long = String(repeating: "x", count: 300)
        XCTAssertEqual(match([(7, long + "yz - Helium")], [front(long, 1)]), [7: 1], "a title the extension cut")
    }

    func testWhatTheSessionEngineReadComesFirst() {
        let items = [Item(id: "tab:com.example.browser:1:10", bundleID: one.bundleID, appName: "", role: .browser, kind: .tab, windowNumber: 8, group: "", title: ""),
                     Item(id: "tab:com.example.browser:2:20", bundleID: one.bundleID, appName: "", role: .browser, kind: .tab, windowNumber: 0, group: "", title: ""),
                     Item(id: "tab:com.example.other:3:30", bundleID: "com.example.other", appName: "", role: .browser, kind: .tab, windowNumber: 9, group: "", title: ""),
                     Item(id: "tab:com.example.browser:4:40:5", bundleID: one.bundleID, appName: "", role: .browser, kind: .tab, windowNumber: 6, group: "", title: "")]
        XCTAssertEqual(BrowserWindows.numbers(items, of: one.bundleID), [1: 8], "an id of another shape says nothing")
        XCTAssertEqual(match([(7, "Maps"), (8, "Maps")], [front("Maps", 1), front("Maps", 2)], [1: 8]), [7: 2, 8: 1], "which leaves one")
        XCTAssertEqual(match([(7, "Maps")], [front("Maps", 1)], [1: 99]), [7: 1], "a window that is gone")
        let both = BrowserWindows.match([(id: 7, title: "Knitting"), (id: 8, title: "Maps")], [front("Knitting", 1), front("Maps", 1, two)], numbers: [1: 8])
        XCTAssertEqual(both.mapValues { $0.peer == one ? "one" : "two" }, [7: "one", 8: "two"], "another profile's window with the same number is still matched by title")
    }

    func testOnlyTheBrowsersFrontTabsCount() {
        let book = BrowserBook()
        func take(_ peer: BrowserPeer, _ tabs: [(Int, String, Int, Bool)]) {
            book.take(BrowserMessageTests.all(.tabs, tabs.map { BrowserMessageTests.tab($0.0, $0.1, "https://a.example/", window: $0.2).merging(["front": $0.3]) { $1 } }), from: peer)
        }
        take(one, [(1, "A", 2, true), (2, "B", 2, false), (4, "D", 1, true)])
        take(two, [(5, "E", 9, true)])
        take(BrowserPeer("com.example.other"), [(3, "C", 1, true)])
        XCTAssertEqual(book.fronts(of: one.bundleID).map(\.tab.title), ["D", "A", "E"])
        book.allow([.history])
        XCTAssertEqual(book.fronts(of: one.bundleID), [], "switched off")
    }

    func testANewTabGoesToAWindowHereOrOneOfItsOwn() {
        let known: [UInt32: BrowserWindows.Front] = [7: front("A", 1), 8: front("B", 2, two)]
        func place(_ here: [UInt32], _ all: [UInt32], _ peers: [BrowserPeer]) -> BrowserWindows.Place? { BrowserWindows.place(here: here, all: all, known: known, peers: peers) }
        XCTAssertEqual(place([9, 8, 7], [7, 8, 9], [one, two]), .tab(two, window: 2, id: 8), "the one last used that is known")
        XCTAssertEqual(place([], [7, 8], [one]), .window(one))
        XCTAssertEqual(place([], [], [one]), .window(one))
        XCTAssertEqual(place([9], [9], [one]), .front(one), "all its windows are here")
        XCTAssertEqual(place([9], [9, 7], [one]), .window(one), "its front window may be elsewhere")
        XCTAssertNil(place([], [7, 8], [one, two]), "which profile's?")
        XCTAssertNil(place([], [], []))
    }
}
