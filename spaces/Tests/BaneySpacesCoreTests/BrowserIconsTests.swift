import XCTest
@testable import BaneySpacesCore

/// Site icons (spec/browser.md R-B8): small PNGs, only the ones asked for, one a site, in memory.
final class BrowserIconsTests: XCTestCase {
    private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2])
    private func icon(_ o: [String: Any]) -> BrowserIcon? { BrowserIcon(try! JSONSerialization.data(withJSONObject: o)) }

    func testOnlyASmallPNGIsAnIcon() {
        let good: [String: Any] = ["op": "browser.icon", "url": "https://a.example/x", "png": png.base64EncodedString()]
        XCTAssertEqual(icon(good)?.png, png)
        XCTAssertEqual(icon(good)?.url, "https://a.example/x")
        let big = png + Data(count: 64 << 10)
        for (key, value) in [("op", "browser.rows"), ("png", "not base64"), ("png", Data("<svg/>".utf8).base64EncodedString()), ("png", big.base64EncodedString())] {
            XCTAssertNil(icon(good.merging([key: value]) { $1 }), key)
        }
        XCTAssertNil(BrowserIcon(Data("[]".utf8)))
        XCTAssertNil(icon(good.merging(["pad": String(repeating: "x", count: 128 << 10)]) { $1 }), "a message that big isn't read at all")
    }

    func testASiteIsAskedForOnceAndNothingUnaskedIsKept() {
        var book = BrowserIconBook<String>(most: 2)
        XCTAssertEqual(book.icon("https://a.example/one").ask, "https://a.example/one")
        XCTAssertNil(book.icon("https://a.example/two").ask, "asked already")
        XCTAssertFalse(book.take("b", for: "https://b.example/"), "nobody asked")
        XCTAssertFalse(book.take("a", for: "https://a.example/two"))
        XCTAssertTrue(book.take("a", for: "https://a.example/one"))
        XCTAssertFalse(book.take("again", for: "https://a.example/one"))
        XCTAssertEqual(book.icon("https://www.a.example/three").image, "a")
        XCTAssertNil(book.icon("chrome://settings").ask)
        _ = book.icon("https://b.example/")
        _ = book.icon("https://c.example/")
        XCTAssertEqual(book.icon("https://a.example/one").ask, "https://a.example/one", "the oldest was let go")
        XCTAssertTrue(book.take("c", for: "https://c.example/"))
        book.clear()
        XCTAssertFalse(book.take("late", for: "https://a.example/one"), "what comes after a clear isn't kept")
        let after = book.icon("https://c.example/")
        XCTAssertNil(after.image)
        XCTAssertEqual(after.ask, "https://c.example/", "asked again")
    }
}
