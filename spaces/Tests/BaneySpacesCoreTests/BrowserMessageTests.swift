import XCTest
@testable import BaneySpacesCore

/// What the extension sends is checked row by row (spec/browser.md): nothing from a private window gets in, a malformed row
/// is left out, and no row can print itself into a log. Every row here is made up.
final class BrowserMessageTests: XCTestCase {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)

    static func message(_ o: [String: Any]) -> BrowserMessage? {
        BrowserMessage(try! JSONSerialization.data(withJSONObject: o), now: now)
    }
    static func all(_ source: BrowserSource, _ rows: [[String: Any]], first: Bool = true, last: Bool = true) -> BrowserMessage {
        message(["op": "browser.rows", "source": source.rawValue, "first": first, "last": last, "rows": rows])!
    }
    static func tab(_ id: Int, _ title: String, _ url: String, window: Int = 7, _ more: [String: Any] = [:]) -> [String: Any] {
        ["id": id, "window": window, "title": title, "url": url, "incognito": false].merging(more) { $1 }
    }
    private func rows(_ m: BrowserMessage?) -> [BrowserRow] {
        switch m?.change {
        case .rows(let rows, _, _), .change(let rows, _): return rows
        case nil: return []
        }
    }

    func testAPrivateWindowsTabGroupOrDownloadNeverGetsIn() {
        let open = Self.tab(1, "Open", "https://a.example/")
        var unsaid = Self.tab(3, "Unsaid", "https://c.example/")
        unsaid["incognito"] = nil
        let all = [open, Self.tab(2, "Secret", "https://b.example/", ["incognito": true]), unsaid,
                   Self.tab(4, "Odd", "https://d.example/", ["incognito": "no"])]
        for source in [BrowserSource.tabs, .groups, .downloads] {
            for op in ["browser.rows", "browser.change"] {
                let m = Self.message(["op": op, "source": source.rawValue, "rows": all])
                XCTAssertEqual(rows(m).map(\.title), ["Open"], "\(op) \(source.rawValue)")
                XCTAssertEqual(m?.folded.count, 1)
            }
        }
    }

    func testAGroupNeedsItsWindowAndRanksAboveATab() {
        let group: [String: Any] = ["id": 12, "window": 2, "title": "Trip", "incognito": false]
        let got = rows(Self.all(.groups, [group, group.merging(["id": 13, "window": NSNull()]) { $1 }, group.merging(["id": 14, "window": 0]) { $1 }]))
        XCTAssertEqual(got.map(\.key), ["12"], "no window, no group")
        XCTAssertEqual(got.first?.window, 2)
        XCTAssertEqual(got.first?.weight, 30)
        XCTAssertEqual(rows(Self.all(.tabs, [Self.tab(1, "Trip", "https://a.example/")])).first?.weight, 25)
        XCTAssertEqual(BrowserSource.allCases.map(\.most), [5_000, 500, 20_000, 50_000, 500])
    }

    func testATabIsInAGroupOnlyWhenTheBrowserGivesOne() {
        let m = Self.all(.tabs, [Self.tab(1, "In", "https://a.example/", ["group": 4]),
                                 Self.tab(2, "Out", "https://b.example/", ["group": -1]), Self.tab(3, "Unsaid", "https://c.example/")])
        XCTAssertEqual(rows(m).map(\.group), [4, nil, nil])
    }

    func testARowPrintsNothingOfThePage() {
        let message = Self.all(.history, [["url": "https://private.example/diary", "title": "Dear diary"]])
        let row = rows(message)[0]
        var dumped = "", whole = ""
        dump(row, to: &dumped)
        dump(message, to: &whole)
        for text in ["\(row)", String(reflecting: row), dumped, "\([row])", "\(Optional(row) as Any)", "\(message)", whole,
                     String(reflecting: message)] {
            XCTAssertFalse(text.lowercased().contains("diary"), text)
            XCTAssertFalse(text.contains("private.example"), text)
        }
        XCTAssertFalse(row as Any is Encodable, "a row can't be written out")
    }

    func testAMalformedMessageOrRowIsLeftOut() {
        XCTAssertNil(BrowserMessage(Data("nonsense".utf8)))
        XCTAssertNil(Self.message(["op": "browser.rows", "source": "passwords", "rows": []]))
        XCTAssertNil(Self.message(["op": "focus", "source": "tabs"]))
        XCTAssertEqual(rows(Self.all(.tabs, [Self.tab(1, "Kept", "https://a.example/"), ["title": "no id", "incognito": false],
                                             Self.tab(0, "no window", "https://a.example/", window: 0), Self.tab(5, "", "")])).map(\.title), ["Kept"])
        XCTAssertEqual(rows(Self.all(.history, [["url": "file:///etc/hosts", "title": "a file"], ["url": "chrome://settings", "title": "settings"]])), [])
        XCTAssertEqual(rows(Self.all(.bookmarks, [["id": "9", "url": "javascript:alert(1)", "title": "a script"]])), [])
        guard case .change(_, let gone)? = Self.message(["op": "browser.change", "source": "tabs", "gone": [4, "5", "", 1.5, NSNull()]])?.change else {
            return XCTFail("a change")
        }
        XCTAssertEqual(gone, ["4", "5"])
        guard case .change(_, let pages)? = Self.message(["op": "browser.change", "source": "history",
                                                          "gone": ["https://me:pw@a.example/x", "about:blank"]])?.change else {
            return XCTFail("a change")
        }
        XCTAssertEqual(pages, ["https://a.example/x"], "a visited page goes by the address it is kept by")
        let sly = Self.all(.tabs, [Self.tab(1, "zero", "https://a.example/", ["incognito": 0]),
                                   Self.tab(2, "true window", "https://a.example/", ["window": true]),
                                   Self.tab(3, "true id", "https://a.example/", ["id": true])])
        XCTAssertEqual(rows(sly), [], "only a JSON true or false says whether a window is private")
        XCTAssertEqual(rows(Self.all(.downloads, (1...501).map { Self.tab($0, "f\($0)", "") })).count, 500, "past the most, rows are dropped")
    }

    func testAnAddressLosesItsNameAndPasswordAndAPageWithNoneHasNone() {
        XCTAssertEqual(BrowserMessage.clean("https://me:pass@a.example/x@y"), "https://a.example/x@y")
        XCTAssertEqual(BrowserMessage.clean("https://a@b@c.example?q=1"), "https://c.example?q=1")
        XCTAssertEqual(BrowserMessage.clean("https://a.example/@me"), "https://a.example/@me")
        for u in ["data:text/html,hi", "about:blank", "blob:https://a.example/1", "JavaScript:void 0", "", "nothing"] {
            XCTAssertEqual(BrowserMessage.clean(u), "", u)
        }
        XCTAssertEqual(BrowserMessage.site("https://www.a.example:8080/x"), "a.example")
        XCTAssertEqual(BrowserMessage.site("chrome://settings"), "")
        XCTAssertEqual(BrowserMessage.shown("chrome://settings/"), "settings", "no scheme is matched")
    }

    func testWhatAVisitedPageAndADownloadCarry() {
        let ms = Self.now.timeIntervalSince1970 * 1000, day = 86_400_000.0
        let pages = rows(Self.all(.history, [(0, 0.5), (90, 3), (4, 20), (4, 60)].map { ["url": "https://a.example/\($0)", "visits": $0, "last": ms - $1 * day] }))
        XCTAssertEqual(pages.map(\.weight), [20, 42, 9, 4])
        XCTAssertEqual(rows(Self.all(.tabs, [Self.tab(1, "a", "")])).map(\.weight), [25])
        XCTAssertEqual(pages[0].title, "a.example/0", "a page with no title goes by its address")
        let long = rows(Self.all(.history, [["url": "https://a.example/?" + String(repeating: "q", count: 1_900)]]))[0]
        XCTAssertEqual(long.title.count, 300, "and only so far")
        let loads = rows(Self.all(.downloads, [Self.tab(1, "a.zip", "", ["state": "in_progress", "received": 5, "total": 10]),
                                               Self.tab(2, "b.zip", "", ["state": "in_progress", "received": 5, "total": -1]),
                                               Self.tab(3, "c.zip", "", ["state": "complete", "received": 5, "total": 5])]))
        XCTAssertEqual(loads.map(\.progress), [.init(done: 5, total: 10), .init(done: 5, total: nil), nil])
        XCTAssertEqual(rows(Self.all(.tabs, [Self.tab(1, "a\u{0}b\n\(String(repeating: "c", count: 400))", "https://a.example/")]))[0].title.count, 300)
        XCTAssertEqual(rows(Self.all(.tabs, [Self.tab(1, " a\u{202E}b\nc \u{1F469}\u{200D}\u{1F4BB}", "")]))[0].title, "ab c \u{1F469}\u{200D}\u{1F4BB}",
                       "one line, nothing that turns it around, and emoji whole")
    }
}
