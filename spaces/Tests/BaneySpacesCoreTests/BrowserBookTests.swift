import XCTest
import BrowserMatch
@testable import BaneySpacesCore

/// The browser's record (spec/browser.md): what the extension sends is checked row by row, nothing from a private window
/// gets in, a source that is off holds and answers nothing, and no row can print itself into a log. Every row here is made up.
final class BrowserBookTests: XCTestCase {
    static let browser = BrowserPeer("org.example.browser")
    private static let now = BrowserMessageTests.now
    private static let message = BrowserMessageTests.message
    private static func all(_ source: BrowserSource, _ rows: [[String: Any]], first: Bool = true, last: Bool = true) -> BrowserMessage {
        BrowserMessageTests.all(source, rows, first: first, last: last)
    }
    private static func tab(_ id: Int, _ title: String, _ url: String, window: Int = 7, _ more: [String: Any] = [:]) -> [String: Any] {
        BrowserMessageTests.tab(id, title, url, window: window, more)
    }
    private func book(_ messages: BrowserMessage...) -> BrowserBook {
        let b = BrowserBook()
        for m in messages { b.take(m, from: Self.browser) }
        return b
    }
    private func titles(_ b: BrowserBook, _ q: String) -> [String] { b.search(q).map(\.row.title) }

    // MARK: Private windows

    func testAPrivateWindowsTabGroupOrDownloadNeverGetsIn() {
        for source in [BrowserSource.tabs, .groups, .downloads] {
            let open = Self.tab(1, "Open gardening", "https://a.example/")
            let secret = Self.tab(2, "Secret gardening", "https://b.example/", ["incognito": true])
            var unsaid = Self.tab(3, "Unsaid gardening", "https://c.example/")
            unsaid["incognito"] = nil
            let odd = Self.tab(4, "Odd gardening", "https://d.example/", ["incognito": "no"])
            let b = book(Self.all(source, [open, secret, unsaid, odd]))
            XCTAssertEqual(titles(b, "gardening"), ["Open gardening"], source.rawValue)
            b.take(Self.message(["op": "browser.change", "source": source.rawValue, "rows": [secret, unsaid, odd]])!, from: Self.browser)
            XCTAssertEqual(b.rows(source).map(\.row.title), ["Open gardening"], source.rawValue)
        }
    }

    // MARK: Switches

    func testASourceThatIsOffHoldsAndAnswersNothing() {
        for source in BrowserSource.allCases {
            let row = Self.tab(1, "Sourdough starter", "https://bread.example/")
            let b = book(Self.all(source, [row]))
            XCTAssertEqual(titles(b, "sourdough"), ["Sourdough starter"], source.rawValue)
            let others = Set(BrowserSource.allCases).subtracting([source])
            b.allow(others)
            XCTAssertEqual(titles(b, "sourdough"), [])
            XCTAssertTrue(b.rows(source).isEmpty)
            b.take(Self.all(source, [row]), from: Self.browser)
            b.allow(others.union([source]))
            XCTAssertEqual(titles(b, "sourdough"), [], "what it held, and what came while off, is gone: \(source.rawValue)")
        }
    }

    func testAListInPiecesIsDroppedWhenItsSourceGoesOffPartWay() {
        let b = book(Self.all(.history, [["url": "https://one.example/", "title": "Alpha page"]], last: false))
        b.allow([.tabs])
        b.allow([.tabs, .history])
        b.take(Self.all(.history, [["url": "https://two.example/", "title": "Beta page"]], first: false), from: Self.browser)
        XCTAssertEqual(b.rows(.history).count, 0)
    }

    func testASourceHoldsNoMoreThanItsMostHoweverManyChangesCome() {
        let most = BrowserSource.downloads.most
        let b = book(Self.all(.downloads, (1...most).map { Self.tab($0, "File \($0)", "https://f\($0).example/") }))
        b.take(Self.message(["op": "browser.change", "source": "downloads", "rows": [Self.tab(most + 1, "One more", "https://more.example/")]])!, from: Self.browser)
        XCTAssertEqual(b.rows(.downloads).count, most)
        b.take(Self.message(["op": "browser.change", "source": "downloads", "rows": [Self.tab(1, "File one again", "https://f1.example/")]])!, from: Self.browser)
        XCTAssertTrue(b.rows(.downloads).contains { $0.row.title == "File one again" }, "a row it holds still changes")
    }

    func testABrowserThatGoesTakesItsRecordWithIt() {
        let b = book(Self.all(.tabs, [Self.tab(1, "Sourdough", "https://bread.example/")]))
        b.take(Self.all(.tabs, [Self.tab(1, "Sourdough two", "https://bread.example/2")]), from: BrowserPeer("org.example.browser", 2))
        b.forget(Self.browser)
        XCTAssertEqual(titles(b, "sourdough"), ["Sourdough two"])
    }

    // MARK: Nothing in a log

    func testARowPrintsNothingOfThePage() {
        let b = book(Self.all(.history, [["url": "https://private.example/diary", "title": "Dear diary"]]))
        let row = b.rows(.history)[0].row
        let hit = b.search("diary")[0]
        var dumped = ""
        dump(row, to: &dumped)
        for text in ["\(row)", String(reflecting: row), dumped, "\([row])", "\(Optional(row) as Any)"] {
            XCTAssertFalse(text.lowercased().contains("diary"), text)
            XCTAssertFalse(text.contains("private.example"), text)
        }
        for text in ["\(hit)", String(reflecting: hit)] { XCTAssertFalse(text.lowercased().contains("diary"), text) }
        XCTAssertFalse(row as Any is Encodable, "a row can't be written out")
    }

    // MARK: Messages

    func testAMalformedMessageOrRowIsLeftOut() {
        XCTAssertNil(BrowserMessage(Data("nonsense".utf8)))
        XCTAssertNil(Self.message(["op": "browser.rows", "source": "passwords", "rows": []]))
        XCTAssertNil(Self.message(["op": "focus", "source": "tabs"]))
        let b = book(Self.all(.tabs, [Self.tab(1, "Kept", "https://a.example/"), ["title": "no id", "incognito": false],
                                      Self.tab(0, "no window", "https://a.example/", window: 0), Self.tab(5, "", "")]),
                     Self.all(.history, [["url": "file:///etc/hosts", "title": "a file"], ["url": "chrome://settings", "title": "settings"]]),
                     Self.all(.bookmarks, [["id": "9", "url": "javascript:alert(1)", "title": "a script"]]))
        XCTAssertEqual(b.rows(.tabs).map(\.row.title), ["Kept"])
        XCTAssertEqual(b.rows(.history).count + b.rows(.bookmarks).count, 0)
    }

    func testTheOldRowsAnswerUntilTheLastPieceIsHere() {
        let b = book(Self.all(.history, [["url": "https://old.example/", "title": "Old page"]]))
        b.take(Self.all(.history, [["url": "https://n1.example/", "title": "New page one"]], last: false), from: Self.browser)
        XCTAssertEqual(titles(b, "page"), ["Old page"])
        b.take(Self.all(.history, [["url": "https://n2.example/", "title": "New page two"]], first: false), from: Self.browser)
        XCTAssertEqual(Set(titles(b, "page")), ["New page one", "New page two"])
    }

    func testAChangeReplacesAddsAndRemovesAndWaitsForTheWholeList() {
        let b = book(Self.all(.history, [["url": "https://old.example/", "title": "Old page"]]))
        let change: (([[String: Any]], [Any]) -> BrowserMessage) = { Self.message(["op": "browser.change", "source": "tabs", "rows": $0, "gone": $1])! }
        b.take(change([Self.tab(1, "Early", "https://a.example/")], []), from: Self.browser)
        XCTAssertTrue(b.rows(.tabs).isEmpty)
        b.take(Self.all(.tabs, [Self.tab(1, "One", "https://a.example/"), Self.tab(2, "Two", "https://b.example/")]), from: Self.browser)
        b.take(change([Self.tab(1, "One now", "https://a.example/"), Self.tab(3, "Three", "https://c.example/", ["audible": true])], [2]), from: Self.browser)
        XCTAssertEqual(Set(b.rows(.tabs).map(\.row.title)), ["One now", "Three"])
        XCTAssertEqual(titles(b, "two"), [])
        XCTAssertEqual(b.search("three").first?.row.audible, true)
        b.take(change([Self.tab(4, "Left alone", "https://d.example/")], []), from: Self.browser)
        for n in 0..<5_000 { b.take(change([Self.tab(1, "Title \(n)", "https://a.example/")], []), from: Self.browser) }
        XCTAssertEqual(titles(b, "title"), ["Title 4999"], "a tab whose title changes all day stays one row")
        XCTAssertEqual(titles(b, "alone"), ["Left alone"])
        XCTAssertLessThan(b.slots(.tabs, Self.browser), 2_100, "the rows it was are let go")
    }

    func testNoMoreRowsAreKeptThanASourcesMost() {
        let rows = (0..<600).map { Self.tab($0 + 1, "File \($0).zip", "https://a.example/\($0)") }
        XCTAssertEqual(book(Self.all(.downloads, rows)).rows(.downloads).count, 500)
    }

    // MARK: Ranking

    func testTheSameAddressIsOfferedOnceAsItsOpenTab() {
        let page = "https://recipes.example/soup"
        let b = book(Self.all(.history, [["url": page + "#top", "title": "Soup recipe", "visits": 90, "last": Self.now.timeIntervalSince1970 * 1000]]),
                     Self.all(.bookmarks, [["id": "4", "url": page, "title": "Soup recipe"]]),
                     Self.all(.tabs, [Self.tab(11, "Soup recipe", page), Self.tab(12, "Soup recipe", page)]))
        XCTAssertEqual(b.search("soup").map(\.id).sorted(), ["tab:org.example.browser:7:11", "tab:org.example.browser:7:12"],
                       "two tabs of a page are two places; the id is the session engine's")
    }

    func testATitlesStartBeatsAWordBeatsInsideAndWordsApartMustAllBeThere() {
        let b = book(Self.all(.bookmarks, [["id": "1", "url": "https://a.example/", "title": "Unparking meters"],
                                           ["id": "2", "url": "https://b.example/", "title": "National park maps"],
                                           ["id": "3", "url": "https://c.example/", "title": "Parks by county"],
                                           ["id": "4", "url": "https://parkrun.example/", "title": "Saturday five"]]))
        XCTAssertEqual(titles(b, "park"), ["Parks by county", "Saturday five", "National park maps", "Unparking meters"])
        XCTAssertEqual(titles(b, "maps park"), ["National park maps"])
        XCTAssertEqual(titles(b, "park zebra"), [])
        XCTAssertEqual(titles(b, "PARKS BY"), ["Parks by county"])
        b.take(Self.all(.tabs, [Self.tab(1, "!g park", "https://d.example/")]), from: Self.browser)
        XCTAssertEqual(titles(b, "!g park"), [], "a bang is for the web")
    }

    func testAFewOfEachAreOfferedAndAFaintMatchIsNot() {
        let b = book(Self.all(.tabs, (1...9).map { Self.tab($0, "Garden \($0)", "https://a.example/\($0)") }),
                     Self.all(.bookmarks, (1...9).map { ["id": "\($0)", "url": "https://b.example/\($0)", "title": "Garden \($0)"] }),
                     Self.all(.downloads, [Self.tab(1, String(repeating: "long ", count: 30), "https://c.example/xgardens")]))
        b.take(Self.all(.tabs, (1...9).map { Self.tab($0, "Garden \($0)", "https://e.example/\($0)") }), from: BrowserPeer("org.example.browser", 2))
        XCTAssertEqual(b.search("garden").map(\.row.source).filter { $0 == .tabs }.count, 4)
        XCTAssertEqual(b.search("garden").count, 6)
        XCTAssertEqual(b.search("xgardens").count, 1, "its address has a word that starts so")
        XCTAssertEqual(b.search("ardens").count, 0)
    }

    func testAPageVisitedOftenAndLatelyComesFirst() {
        let ms = Self.now.timeIntervalSince1970 * 1000
        let b = book(Self.all(.history, [["url": "https://a.example/", "title": "Weather north", "visits": 1, "last": ms - 60 * 86_400_000],
                                         ["url": "https://b.example/", "title": "Weather south", "visits": 25, "last": ms]]))
        XCTAssertEqual(titles(b, "weather"), ["Weather south", "Weather north"])
    }

    func testARowRanksOnAnAppsScale() {
        let b = book(Self.all(.tabs, [Self.tab(1, "Calendar", "https://a.example/")]))
        XCTAssertGreaterThan(b.search("calendar")[0].score, Fuzzy.score("calendar", "Calendar Helper")!)
        XCTAssertEqual(b.search("cal")[0].score - b.search("cal")[0].row.weight, Fuzzy.score("cal", "Calendar"))
    }
}

/// The launcher's answer with 2,000 tabs and 50,000 visited pages stays inside one frame (R-B2).
final class BrowserSpeedTests: XCTestCase {
    func testAKeyPressOver2000TabsAnd50000PagesIsInsideAFrame() {
        let words = ["garden", "recipe", "weather", "river", "school", "music", "history", "atlas", "engine", "letter", "market", "winter",
                     "bridge", "coffee", "planet", "silver", "travel", "window", "yellow", "orchard"]
        func title(_ i: Int) -> String { "\(words[i % 20]) \(words[(i / 20) % 20]) \(words[(i / 400) % 20]) number \(i)" }
        func address(_ i: Int) -> String { "https://www.\(words[(i / 7) % 20])\(i % 97).example/\(words[(i / 3) % 20])/\(i)?page=\(i % 31)" }
        let b = BrowserBook()
        b.take(BrowserMessageTests.all(.tabs, (0..<2_000).map { BrowserMessageTests.tab($0 + 1, title($0), address($0), window: 1 + $0 % 9) }), from: BrowserBookTests.browser)
        b.take(BrowserMessageTests.all(.history, (0..<50_000).map { ["url": address($0 + 2_000), "title": title($0 + 2_000), "visits": $0 % 40] }), from: BrowserBookTests.browser)
        XCTAssertEqual(b.rows(.history).count, 50_000)
        // A word typed letter by letter, words apart, an address, letters that are everywhere and nothing at all like a row.
        let queries = ["g", "ga", "gar", "garden", "garden ri", "river garden number 4", "e", "er", "number", "example", "garden3.ex", "zzzz", "weather 1", "a e", "page=3"]
        var times: [Double] = []
        for _ in 0..<8 {
            for q in queries {
                let t = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
                _ = b.search(q)
                times.append(Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - t) / 1e6)
            }
        }
        times.sort()
        let p50 = times[times.count / 2], p90 = times[times.count * 9 / 10]
        print("browser search: p50 \(p50) ms, p90 \(p90) ms, max \(times.last!) ms")
        XCTAssertLessThan(p90, 16, "a key press has one frame")
    }
}
