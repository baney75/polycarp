import XCTest
@testable import BaneySpacesCore

/// A browser's part of the notification list (spec/browser.md R-B14).
final class BrowserNoticesTests: XCTestCase {
    private let one = BrowserPeer("com.example.browser")
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func banner(_ subtitle: String, bundle: String? = "com.example.browser") -> NoticeBanner {
        NoticeBanner(app: "Browser", bundle: bundle, title: "Ann wrote", subtitle: subtitle, body: "Hello", path: [0])
    }
    private func site(_ subtitle: String, _ bundle: String? = "com.example.browser") -> String? { BrowserNotices.site(banner(subtitle, bundle: bundle), from: one.bundleID) }
    private func message(_ op: String, _ source: String, _ rows: [[String: Any]]) -> BrowserMessage {
        BrowserMessage(try! JSONSerialization.data(withJSONObject: ["op": op, "source": source, "first": true, "last": true, "rows": rows]))!
    }
    private func file(_ id: Int, _ state: String, ended: Double? = nil) -> [String: Any] {
        ["id": id, "title": "file \(id)", "url": "https://d.example/\(id)", "incognito": false, "state": state, "received": 5, "total": 9]
            .merging(ended.map { ["ended": (now.timeIntervalSince1970 + $0) * 1000] } ?? [:]) { $1 }
    }

    func testTheSiteIsTheOneTheBrowsersBannerNames() {
        XCTAssertEqual(site("chat.example"), "chat.example")
        XCTAssertEqual(site("www.chat.example:8443"), "chat.example")
        XCTAssertEqual(site("chat.example", "com.example.browser.framework.AlertNotificationService"), "chat.example", "alerts come from a helper")
        for other in ["com.example.browser2", "com.apple.mail", nil] { XCTAssertNil(site("chat.example", other)) }
        for words in ["", "Saved", "Two words.", "caf\u{E9}.example", ".example", "chat.", "Chat.example"] { XCTAssertNil(site(words), words) }
    }

    func testASitesTabIsTheOneInFront() {
        let book = BrowserBook()
        func tab(_ id: Int, _ url: String, front: Bool = false) -> [String: Any] { ["id": id, "window": 1, "title": "t", "url": url, "incognito": false, "front": front] }
        book.take(message("browser.rows", "tabs", [tab(1, "https://chat.example/a"), tab(2, "https://www.chat.example/b", front: true), tab(3, "https://old.chat.example/"), tab(4, "https://b.example/"), tab(5, "https://b.example/2")]), from: one)
        XCTAssertEqual(book.tab(on: "chat.example", of: one.bundleID)?.tab.key, "2")
        XCTAssertEqual(book.tab(on: "b.example", of: one.bundleID)?.tab.key, "4")
        XCTAssertNil(book.tab(on: "chat.example", of: "com.example.other"))
        XCTAssertNil(book.tab(on: "example", of: one.bundleID))
        book.allow([.downloads])
        XCTAssertNil(book.tab(on: "chat.example", of: one.bundleID))
    }

    func testOnlyADownloadThatJustFinishedIsNews() {
        let book = BrowserBook()
        func done(_ op: String, _ rows: [String: Any]...) -> [String] { book.take(message(op, "downloads", rows), from: one, at: now).map(\.key) }
        XCTAssertEqual(done("browser.change", file(1, "complete", ended: -1)), [], "before the list")
        XCTAssertEqual(done("browser.rows", file(1, "complete", ended: -1), file(2, "in_progress"), file(3, "in_progress")), [], "what was there already")
        XCTAssertEqual(done("browser.change", file(1, "complete", ended: -1)), [], "done before")
        XCTAssertEqual(done("browser.change", file(2, "complete", ended: -1), file(3, "interrupted", ended: -1)), ["2"])
        XCTAssertEqual(done("browser.change", file(2, "complete", ended: -1)), [], "said once")
        XCTAssertEqual(done("browser.change", file(4, "complete", ended: 0), file(5, "complete", ended: -61), file(6, "complete")), ["4"], "one so short it was never on its way")
        book.allow([.tabs])
        XCTAssertEqual(done("browser.change", file(7, "complete", ended: 0)), [], "downloads are off")
    }

    func testAFullShelfStillSaysADownloadOnce() {
        let book = BrowserBook()
        let most = BrowserSource.downloads.most
        book.take(message("browser.rows", "downloads", (1...most).map { file($0, "complete") }), from: one, at: now)
        let change = message("browser.change", "downloads", [file(most + 1, "complete", ended: 0)])
        XCTAssertEqual(book.take(change, from: one, at: now).map(\.key), ["\(most + 1)"])
        XCTAssertEqual(book.take(change, from: one, at: now).map(\.key), [], "no room on the shelf, and still said once")
    }

    func testADownloadsEntryGoesWithItsBrowsersRecord() {
        let book = BrowserBook()
        func filed() -> BrowserWindows.Front {
            book.take(message("browser.rows", "downloads", []), from: one)
            return .init(one, book.take(message("browser.change", "downloads", [file(1, "complete", ended: 0)]), from: one, at: now)[0])
        }
        var shelf = NoticeShelf()
        shelf.take(.init(centerOpen: false, banners: [banner("chat.example")]), at: now)
        let f = filed()
        shelf.add(BrowserNotices.done(f, app: "Browser"), opens: f, at: now)
        shelf.dropOwn(unless: book.holds)
        XCTAssertEqual(shelf.notices.count, 2, "its browser still lists it")
        let erased = try! JSONSerialization.data(withJSONObject: ["op": "browser.change", "source": "downloads", "first": true, "last": true, "rows": [], "gone": [1]])
        book.take(BrowserMessage(erased)!, from: one, at: now)
        XCTAssertFalse(book.holds(f), "erased from the browser's history")
        XCTAssertTrue(book.holds(filed()))
        book.take(message("browser.rows", "downloads", []), from: one)
        XCTAssertFalse(book.holds(f), "switched off in the extension: its whole list came empty")
        XCTAssertTrue(book.holds(filed()))
        book.forget(one)
        XCTAssertFalse(book.holds(f), "the browser went")
        XCTAssertTrue(book.holds(filed()))
        book.allow([.tabs])
        XCTAssertFalse(book.holds(f), "downloads are off")
        shelf.dropOwn(unless: book.holds)
        XCTAssertEqual(shelf.notices.map(\.place), [nil], "a site's own banner stays")
    }

    func testAFinishedDownloadIsAnEntryUntilDismissedOrDownloadsGoOff() {
        let book = BrowserBook()
        book.take(message("browser.rows", "downloads", []), from: one)
        let row = book.take(message("browser.change", "downloads", [file(1, "complete", ended: 0)]), from: one, at: now)[0]
        let b = BrowserNotices.done(.init(one, row), app: "Browser")
        XCTAssertEqual([b.app, b.bundle, b.title, b.subtitle, b.body], ["Browser", "com.example.browser", "file 1", "Downloaded", "d.example"])
        var shelf = NoticeShelf()
        shelf.take(.init(centerOpen: false, banners: [banner("chat.example")]), at: now)
        shelf.add(b, opens: .init(one, row), at: now)
        XCTAssertEqual(shelf.notices.map(\.id), [2, 1])
        XCTAssertEqual(shelf.notices.map { $0.place?.tab.key }, ["1", nil])
        XCTAssertEqual([shelf.unread, shelf.groups.count], [2, 1])
        XCTAssertEqual(shelf.notices.map(\.live), [false, true], "nothing on screen to press")
        shelf.take(.init(centerOpen: false, banners: []), at: now)
        XCTAssertEqual(shelf.notices.count, 2, "no banner stands for it")
        shelf.dropOwn()
        XCTAssertEqual(shelf.notices.map(\.id), [1])
        shelf.quiet = ["com.example.browser"]
        for _ in 0..<250 { shelf.add(b, opens: .init(one, row), at: now) }
        XCTAssertEqual([shelf.notices.count, shelf.unread], [NoticeShelf.most, 0], "a quiet app's are filed without counting")
        XCTAssertEqual(Set(shelf.notices.map(\.id)).count, NoticeShelf.most, "each dismissed on its own")
    }
}
