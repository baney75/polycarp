import XCTest
@testable import BaneySpacesCore

/// Sharing a page (spec/browser.md R-B17): only a tab with a web page goes to the Reader, the library or the notes file,
/// the notes file only grows, and chosen text reaches the launcher as one short line. Every page here is made up.
final class BrowserShareTests: XCTestCase {
    private var folder: URL!
    override func setUp() {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    override func tearDown() { try? FileManager.default.removeItem(at: folder) }

    private func row(_ source: BrowserSource, _ o: [String: Any]) -> BrowserRow {
        guard case .rows(let rows, _, _)? = BrowserMessage(try! JSONSerialization.data(withJSONObject:
            ["op": "browser.rows", "source": source.rawValue, "rows": [o]]))?.change, let r = rows.first else { fatalError("a row") }
        return r
    }
    private func tab(_ title: String, _ url: String) -> BrowserRow {
        row(.tabs, ["id": 7, "window": 2, "title": title, "url": url, "incognito": false])
    }

    func testOnlyATabWithAWebPageIsSent() {
        let m = BrowserShare.send(tab("A", "https://a.example/"), to: .library)
        XCTAssertEqual(m?["op"] as? String, "browser.send")
        XCTAssertEqual(m?["tab"] as? Int, 7)
        XCTAssertEqual(m?["to"] as? String, "library")
        XCTAssertNil(BrowserShare.send(tab("Settings", "chrome://settings"), to: .reader))
        XCTAssertNil(BrowserShare.send(row(.history, ["url": "https://a.example/", "title": "A"]), to: .reader))
        XCTAssertNil(BrowserShare.send(row(.bookmarks, ["id": "5", "url": "https://a.example/", "title": "A"]), to: .reader))
    }

    func testANotesLineIsMarkdownThatCantBeBroken() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let day = Date(timeIntervalSince1970: 1_795_000_000)
        XCTAssertEqual(BrowserShare.line(tab("A [b] *c* _d_ `e` <f>", "https://a.example/x (1)?q=<2>"), on: day, calendar: utc),
                       "- [A \\[b\\] \\*c\\* \\_d\\_ \\`e\\` \\<f\\>](https://a.example/x%20%281%29?q=%3C2%3E) 2026-11-18\n")
        XCTAssertNil(BrowserShare.line(tab("Settings", "chrome://settings"), on: day))
    }

    func testTheNotesFileOnlyGrows() throws {
        let file = folder.appendingPathComponent("Pages.md")
        XCTAssertNil(BrowserShare.append("- one\n", to: file))
        try Data("- one\n- two".utf8).write(to: file)
        XCTAssertNil(BrowserShare.append("- three\n", to: file))
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "- one\n- two\n- three\n", "a line of its own, after what was there")
        XCTAssertEqual(BrowserShare.append("- x\n", to: folder), "\(folder.lastPathComponent) is a folder")
        XCTAssertNotNil(BrowserShare.append("- x\n", to: folder.appendingPathComponent("gone/Pages.md")))
    }

    func testChosenTextIsOneShortLine() {
        func find(_ o: [String: Any]) -> String? { BrowserShare.find(try! JSONSerialization.data(withJSONObject: o)) }
        XCTAssertEqual(find(["op": "browser.find", "text": " a\nb\u{202E}c "]), "a bc")
        XCTAssertEqual(find(["op": "browser.find", "text": String(repeating: "x", count: 900)])?.count, 200)
        XCTAssertNil(find(["op": "browser.find", "text": "  "]))
        XCTAssertNil(find(["op": "browser.find", "text": 5]))
        XCTAssertNil(find(["op": "browser.rows", "text": "a"]))
        XCTAssertNil(find(["op": "browser.find", "text": String(repeating: "x", count: 5000)]), "a message that big isn't one")
    }
}
