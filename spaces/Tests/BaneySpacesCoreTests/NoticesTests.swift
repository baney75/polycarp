import Foundation
import XCTest
@testable import BaneySpacesCore

final class NoticesTests: XCTestCase {
    private func banner(_ app: String, _ title: String, _ body: String, bundle: String? = nil, subrole: String = "AXNotificationCenterBanner") -> NoticeNode {
        NoticeNode(subrole: subrole, label: "\(app), \(title), \(body)", stacking: bundle.map { "bundleIdentifier=\($0),threadIdentifier=x" } ?? "",
                   actions: ["AXPress", "Name:Show Details\nTarget:0x0\nSelector:(null)", "Name:Close\nTarget:0x0\nSelector:(null)"],
                   children: [NoticeNode(identifier: "date", text: "now"), NoticeNode(identifier: "title", text: title), NoticeNode(identifier: "body", text: body)])
    }
    private func screen(_ banners: NoticeNode...) -> NoticeReader.Reading {
        NoticeReader.read([NoticeNode(children: [NoticeNode(children: banners)])])
    }
    private let now = Date(timeIntervalSince1970: 1_000)

    func testReadsWordsSenderAndPlace() {
        let r = screen(banner("Mail", "Ann", "Lunch, at noon?", bundle: "com.apple.mail"), banner("Notes, Inc", "Hi", "there", subrole: "AXNotificationCenterAlert"))
        XCTAssertEqual(r.banners.map(\.app), ["Mail", "Notes, Inc"])
        XCTAssertEqual(r.banners[0].bundle, "com.apple.mail")
        XCTAssertEqual(r.banners[0].body, "Lunch, at noon?")
        XCTAssertEqual(r.banners[1].path, [0, 0, 1])
        XCTAssertEqual(r.banners[0].close, "Name:Close\nTarget:0x0\nSelector:(null)")
        XCTAssertFalse(r.centerOpen)
    }

    func testReadsTheLabelWhenNoPartIsNamed() {
        let r = screen(NoticeNode(subrole: "AXNotificationCenterBanner", label: "Mail, Ann, Lunch, at noon?"))
        XCTAssertEqual(r.banners.first?.app, "Mail")
        XCTAssertEqual(r.banners.first?.title, "Ann")
        XCTAssertEqual(r.banners.first?.body, "Lunch, at noon?")
        XCTAssertNil(r.banners.first?.close)
        XCTAssertEqual(screen(NoticeNode(subrole: "AXNotificationCenterBanner")).banners, [])
    }

    func testTextIsBoundedAndCannotTurnItselfAround() {
        let r = screen(banner("Mail", "a\u{202E}b\nc\u{0007}", String(repeating: "x", count: 5_000)))
        XCTAssertEqual(r.banners[0].title, "ab c")
        XCTAssertEqual(r.banners[0].body.count, NoticeReader.maxText)
        XCTAssertEqual(NoticeReader.clean("👩‍👧 é"), "👩‍👧 é")
        XCTAssertNil(NoticeReader.bundle("threadIdentifier=x"))
        XCTAssertEqual(NoticeReader.bundle("bundleIdentifier=com.a-b.c_d;rm"), "com.a-b.c_d")
    }

    func testAHugeTreeStopsAtTheLimits() {
        var deep = banner("A", "t", "b")
        for _ in 0...NoticeReader.maxDepth { deep = NoticeNode(children: [deep]) }
        XCTAssertEqual(NoticeReader.read([deep]).banners, [])
        let wide = NoticeNode(children: (0..<2_000).map { banner("A", "t\($0)", "b") })
        XCTAssertLessThan(NoticeReader.read([wide]).banners.count, NoticeReader.maxNodes)
    }

    func testABannerIsOneNoticeHoweverOftenItIsRead() {
        var s = NoticeShelf()
        XCTAssertEqual(s.take(screen(banner("Mail", "Ann", "Hi")), at: now).count, 1)
        XCTAssertEqual(s.take(screen(banner("Mail", "Ann", "Hi")), at: now + 1).count, 0)
        s.take(screen(), at: now + 2)
        XCTAssertEqual(s.notices.map(\.live), [false])
        XCTAssertEqual(s.unread, 1)
        s.see()
        XCTAssertEqual(s.take(screen(banner("Mail", "Ann", "Hi")), at: now + 9).count, 1, "sent again")
        XCTAssertEqual(s.notices.count, 1)
        XCTAssertEqual(s.notices[0].at, now + 9)
        XCTAssertEqual(s.count, "1")
    }

    func testOpeningNotificationCenterReadsEverythingAndAddsNothing() {
        var s = NoticeShelf()
        s.take(screen(banner("Mail", "Ann", "Hi")), at: now)
        let open = NoticeReader.read([NoticeNode(children: [banner("Old", "a", "b"), NoticeNode(identifier: "widget-1")])])
        XCTAssertTrue(open.centerOpen)
        XCTAssertEqual(s.take(open, at: now + 1), [])
        XCTAssertEqual(s.notices.map(\.banner.app), ["Mail"])
        XCTAssertEqual(s.unread, 0)
    }

    func testGroupsNewestFirstAndClearing() {
        var s = NoticeShelf()
        s.take(screen(banner("Mail", "1", "x", bundle: "m")), at: now)
        s.take(screen(banner("Chat", "2", "x")), at: now + 1)
        s.take(screen(banner("Mail", "3", "x", bundle: "m")), at: now + 2)
        XCTAssertEqual(s.groups.map(\.app), ["Mail", "Chat"])
        XCTAssertEqual(s.groups[0].notices.map(\.banner.title), ["3", "1"])
        s.dismiss(s.groups[0].notices[0].id)
        XCTAssertEqual(s.groups.map(\.app), ["Chat", "Mail"])
        s.clear(key: "m")
        XCTAssertEqual(s.groups.map(\.app), ["Chat"])
        s.clearAll()
        XCTAssertEqual(s.count, "")
    }

    func testAQuietAppIsFiledWithoutBeingCounted() {
        var s = NoticeShelf()
        s.quiet = ["m"]
        XCTAssertEqual(s.take(screen(banner("Mail", "1", "x", bundle: "m"), banner("Chat", "2", "x")), at: now).count, 2)
        XCTAssertEqual(s.unread, 1)
        XCTAssertEqual(s.notices.count, 2)
    }

    func testTheShelfIsBounded() {
        var s = NoticeShelf()
        for i in 0..<(NoticeShelf.most + 20) { s.take(screen(banner("A", "\(i)", "x")), at: now) }
        XCTAssertEqual(s.notices.count, NoticeShelf.most)
        XCTAssertEqual(s.notices[0].banner.title, "\(NoticeShelf.most + 19)")
        XCTAssertEqual(s.count, "99+")
    }
}
