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

    func testOnlyNamedPartsAreUsedWhenAnyIs() {
        let b = screen(NoticeNode(subrole: "AXNotificationCenterBanner", label: "Chat, Lunch, at noon?",
                                  children: [NoticeNode(identifier: "body", text: "Lunch, at noon?")])).banners[0]
        XCTAssertEqual([b.app, b.title, b.body], ["Chat", "", "Lunch, at noon?"])
    }

    func testAHugeTreeStopsAtTheLimits() {
        var deep = banner("A", "t", "b")
        for _ in 0...NoticeReader.maxDepth { deep = NoticeNode(children: [deep]) }
        XCTAssertEqual(NoticeReader.read([deep]).banners, [])
        let wide = NoticeNode(children: (0..<2_000).map { banner("A", "t\($0)", "b") })
        let cut = NoticeReader.read([wide])
        XCTAssertLessThan(cut.banners.count, NoticeReader.maxNodes)
        XCTAssertTrue(cut.centerOpen, "a cut read can't tell, so nothing in it is new")
        let one = NoticeNode(subrole: "AXNotificationCenterBanner", label: "A, t, b", children: (0..<5_000).map { _ in NoticeNode() })
        XCTAssertTrue(NoticeReader.read([one]).centerOpen, "a banner's own parts count too")
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
        for mark in ["widget-1", "header"] {
            var s = NoticeShelf()
            s.take(screen(banner("Mail", "Ann", "Hi")), at: now)
            let open = NoticeReader.read([NoticeNode(children: [banner("Old", "a", "b"), NoticeNode(identifier: mark)])])
            XCTAssertTrue(open.centerOpen)
            XCTAssertEqual(s.take(open, at: now + 1), [])
            XCTAssertEqual(s.notices.map(\.banner.app), ["Mail"])
            XCTAssertEqual(s.unread, 0)
            XCTAssertEqual(s.take(screen(banner("Mail", "Ann", "Hi")), at: now + 2), [], "an alert still up after")
            XCTAssertEqual(s.unread, 0)
            XCTAssertEqual(s.notices.map(\.live), [true])
        }
    }

    func testTheDesktopsWidgetsAreNotNotificationCenterOpen() {
        let r = NoticeReader.read([NoticeNode(children: [NoticeNode(identifier: "widget-1")]), NoticeNode(children: [banner("Mail", "Ann", "Hi")])])
        XCTAssertFalse(r.centerOpen)
        XCTAssertEqual(r.banners.map(\.path), [[1, 0]])
    }

    func testAWindowFullOfWidgetsDoesNotHideTheNextWindowsBanner() {
        let widgets = NoticeNode(children: (0..<2_000).map { _ in NoticeNode(children: [NoticeNode(identifier: "widget-x", children: [NoticeNode(), NoticeNode()])]) })
        let r = NoticeReader.read([widgets, NoticeNode(children: [banner("Mail", "Ann", "Lunch")])])
        XCTAssertEqual(r.banners.map(\.title), ["Ann"])
        XCTAssertFalse(r.centerOpen)
        XCTAssertEqual(r.banners.first?.path, [1, 0])
    }

    func testAnAlertThatCountsDownInPlaceIsOneNotice() {
        var s = NoticeShelf()
        func alert(_ body: String, _ title: String = "Class") -> NoticeNode { banner("Calendar", title, body, subrole: "AXNotificationCenterAlert") }
        XCTAssertEqual(s.take(screen(alert("in 10 minutes")), at: now).count, 1)
        s.see()
        XCTAssertEqual(s.take(screen(alert("in 9 minutes")), at: now).count, 0)
        XCTAssertEqual(s.take(screen(alert("in 1 minute")), at: now).count, 0, "a plural is the same words")
        XCTAssertEqual(s.notices.map(\.banner.body), ["in 1 minute"])
        XCTAssertEqual(s.notices.map(\.live), [true])
        XCTAssertEqual(s.unread, 0)
        XCTAssertEqual(s.take(screen(alert("now")), at: now).count, 1, "other words are a new one")
        // A banner with new words is another message, whatever changed in it.
        var m = NoticeShelf()
        m.take(screen(banner("Messages", "Ann", "meet at 6")), at: now)
        XCTAssertEqual(m.take(screen(banner("Messages", "Ann", "meet at 5")), at: now).count, 1)
        XCTAssertEqual(m.notices.count, 2)
    }

    func testAnotherAlertInTheSamePlaceIsNotATick() {
        func alert(_ body: String, _ title: String = "T", subrole: String = "AXNotificationCenterAlert") -> NoticeNode { banner("App", title, body, subrole: subrole) }
        for (a, b) in [("Your code is 987654", "Your code is 123456"), ("in 9 minutes", "in 10 minutes"), ("9 of 10 done", "8 of 10 done"), ("in 5 minutes", "for 4 minutes")] {
            var s = NoticeShelf()
            s.take(screen(alert(a)), at: now)
            XCTAssertEqual(s.take(screen(alert(b)), at: now).count, 1, b)
            XCTAssertEqual(s.notices.count, 2, b)
        }
        var s = NoticeShelf()
        s.take(screen(alert("in 5 minutes", "One")), at: now)
        XCTAssertEqual(s.take(screen(alert("in 4 minutes", "Two")), at: now).count, 1)
        s = NoticeShelf()
        s.take(screen(alert("in 5 minutes", subrole: "AXNotificationCenterAlertStack")), at: now)
        XCTAssertEqual(s.take(screen(alert("in 4 minutes", subrole: "AXNotificationCenterAlertStack")), at: now).count, 1, "a stack shows another one")
    }

    func testADismissedCountdownStaysGoneAsItTicks() {
        func alert(_ body: String) -> NoticeNode { banner("Calendar", "Class", body, subrole: "AXNotificationCenterAlert") }
        var s = NoticeShelf()
        s.take(screen(alert("in 10 minutes")), at: now)
        s.dismiss(s.notices[0].id)
        XCTAssertTrue(s.watching)
        XCTAssertEqual(s.take(screen(alert("in 9 minutes")), at: now).count, 0)
        XCTAssertEqual(s.take(screen(alert("in 8 minutes")), at: now).count, 0)
        XCTAssertEqual(s.notices, [])
        s.take(screen(), at: now)
        XCTAssertFalse(s.watching)
    }

    func testCloseIsFoundInTheMacsLanguageAndAStackIsNeverClosed() {
        func node(_ actions: [String]) -> NoticeNode { var n = banner("Mail", "Ann", "Hi"); n.actions = actions; return n }
        let german = NoticeNode(children: [node(["AXPress", "Name:Schlie\u{DF}en\nTarget:0x0\nSelector:(null)"])])
        XCTAssertNil(NoticeReader.read([german]).banners[0].close)
        XCTAssertNotNil(NoticeReader.read([german], close: ["Close", "Schlie\u{DF}en"]).banners[0].close)
        XCTAssertNil(NoticeReader.read([NoticeNode(children: [node(["Name:Clear All\nTarget:0x0"])])]).banners[0].close)
    }

    func testWhatIsClearedWhileItsBannerIsUpStaysGone() {
        let up = screen(banner("Mail", "Ann", "Hi", bundle: "m"))
        for clear: (inout NoticeShelf) -> Void in [{ $0.dismiss($0.notices[0].id) }, { $0.clear(key: "m") }, { $0.clearAll() }] {
            var s = NoticeShelf()
            s.take(up, at: now)
            clear(&s)
            XCTAssertEqual(s.take(up, at: now + 1), [])
            XCTAssertEqual(s.notices, [])
            s.take(screen(), at: now + 2)
            XCTAssertEqual(s.take(up, at: now + 3).count, 1, "sent again later")
        }
    }

    func testTheSameWordsTwiceOnScreenAreOneNoticeSentAgain() {
        var s = NoticeShelf()
        s.take(screen(banner("Mail", "Ann", "ok"), banner("Chat", "x", "y")), at: now)
        s.see()
        let came = s.take(screen(banner("Mail", "Ann", "ok"), banner("Mail", "Ann", "ok"), banner("Chat", "x", "y")), at: now + 1)
        XCTAssertEqual(came.map(\.id), [s.notices[0].id])
        XCTAssertEqual(s.notices.map(\.banner.app), ["Mail", "Chat"])
        XCTAssertEqual(s.unread, 1)
        XCTAssertEqual(s.take(screen(banner("Mail", "Ann", "ok")), at: now + 2), [])
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
