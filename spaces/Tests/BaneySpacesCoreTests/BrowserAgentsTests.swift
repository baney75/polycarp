import XCTest
@testable import BaneySpacesCore

/// What an agent may see of the browser (spec/browser.md R-B18): nothing until the person turns it on, then only each
/// tab's title, address, browser and whether it is in front. Every row here is made up.
final class BrowserAgentsTests: XCTestCase {
    private static let browser = BrowserPeer("org.example.browser")
    private static func tab(_ id: Int, _ title: String, _ url: String, _ more: [String: Any] = [:]) -> [String: Any] {
        BrowserMessageTests.tab(id, title, url, more)
    }
    private func book(_ tabs: [[String: Any]], history: [[String: Any]] = []) -> BrowserBook {
        let b = BrowserBook()
        b.take(BrowserMessageTests.all(.tabs, tabs), from: Self.browser)
        if !history.isEmpty { b.take(BrowserMessageTests.all(.history, history), from: Self.browser) }
        return b
    }
    private func ask(_ b: BrowserBook, on: Bool = true, text: String? = "tabs", query: String? = nil, limit: String? = nil) -> Wire.Reply {
        BrowserAgents.reply(Wire.Request(op: .browser, target: query, text: text, args: limit.map { [$0] }), on: on,
                            rows: b.rows(.tabs) + b.rows(.history))
    }
    private func list(_ r: Wire.Reply) -> [[String: Any]] {
        guard let t = r.info?["tabs"], let a = try? JSONSerialization.jsonObject(with: Data(t.utf8)) as? [[String: Any]] else { return [] }
        return a
    }

    func testOffAnswersNothingAndNeverLooksAtTheTabs() {
        var looked = false
        let r = BrowserAgents.reply(Wire.Request(op: .browser, text: "tabs"), on: false, rows: { looked = true; return [] }())
        XCTAssertFalse(r.ok)
        XCTAssertEqual(r.info, ["code": BrowserAgents.off])
        XCTAssertTrue(r.error?.contains("Let agents see my tabs") == true)
        XCTAssertFalse(looked, "the tabs aren't read while it is off")
    }

    func testOnlyTitleAddressBrowserAndFrontAndNeverAPrivateTabOrHistory() {
        let b = book([Self.tab(1, "Garden plans", "https://user:pw@a.example/plan", ["front": true, "pinned": true, "audible": true, "group": 4]),
                      Self.tab(2, "Secret garden", "https://b.example/", ["incognito": true]),
                      Self.tab(3, "Blank", "about:blank")],
                     history: [["url": "https://diary.example/", "title": "Garden diary"]])
        let r = ask(b)
        XCTAssertTrue(r.ok)
        let tabs = list(r)
        XCTAssertEqual(tabs.count, 1)
        XCTAssertEqual(Set(tabs[0].keys), ["title", "url", "browser", "front"])
        XCTAssertEqual(tabs[0]["title"] as? String, "Garden plans")
        XCTAssertEqual(tabs[0]["url"] as? String, "https://a.example/plan")
        XCTAssertEqual(tabs[0]["browser"] as? String, "org.example.browser")
        XCTAssertEqual(tabs[0]["front"] as? Bool, true)
        XCTAssertEqual(r.info?["count"], "1")
        XCTAssertFalse(r.info!["tabs"]!.contains("diary"))
    }

    func testEveryWordMustMatchAndTheLimitHolds() {
        let b = book((1...260).map { Self.tab($0, $0 % 2 == 0 ? "Caf\u{E9} menu \($0)" : "Train times \($0)", "https://s\($0).example/") })
        XCTAssertEqual(list(ask(b)).count, 50, "50 when left out")
        XCTAssertEqual(list(ask(b, limit: "999")).count, 200, "never over 200")
        XCTAssertEqual(list(ask(b, limit: "0")).count, 1)
        XCTAssertEqual(list(ask(b, query: "CAFE menu", limit: "200")).count, 130)
        XCTAssertEqual(list(ask(b, query: "cafe train")).count, 0)
        XCTAssertEqual(list(ask(b, query: "s7.example")).map { $0["title"] as? String }, ["Train times 7"])
        XCTAssertEqual(list(ask(b, query: "s7.example")).first?["front"] as? Bool, false, "a tab behind another")
    }

    func testAnAddressGoesWithoutItsQueryOrFragment() {
        let b = book([Self.tab(1, "Reset your password", "https://app.example/reset?token=abc123&u=7#step2"),
                      Self.tab(2, "Signed in", "https://login.example/cb#access_token=xyz")])
        let tabs = list(ask(b))
        XCTAssertEqual(tabs.map { $0["url"] as? String }, ["https://app.example/reset", "https://login.example/cb"])
        let r = ask(b)
        XCTAssertFalse(r.info!["tabs"]!.contains("abc123"))
        XCTAssertFalse(r.info!["tabs"]!.contains("xyz"))
        XCTAssertEqual(list(ask(b, query: "abc123")).count, 0, "a query can't probe what the query string held")
        XCTAssertEqual(list(ask(b, query: "reset")).count, 1)
        XCTAssertNil(BrowserAgents.address(""))
        XCTAssertEqual(BrowserAgents.address("https://u:p@a.example/x?y=1"), "https://a.example/x")
    }

    func testOnlyTabsIsAnswered() {
        let r = ask(book([Self.tab(1, "A", "https://a.example/")]), text: "history")
        XCTAssertFalse(r.ok)
        XCTAssertNil(r.info?["tabs"])
    }

    func testAnotherMachineNeverAsks() {
        for text in ["tabs", nil] {
            XCTAssertFalse(Remote.allows(Wire.Request(op: .browser, text: text)))
        }
    }
}
