import CoreGraphics
import XCTest
@testable import BaneySpacesCore

final class DragReleaseTests: XCTestCase {
    // Donovan's MacBook: 1512x982 points, a 35 pt menu bar, no Dock reserved.
    let mac = (frame: CGRect(x: 0, y: 0, width: 1512, height: 982), visible: CGRect(x: 0, y: 35, width: 1512, height: 947))
    // A second display to its right, same size, no menu bar.
    let right = (frame: CGRect(x: 1512, y: 0, width: 1512, height: 982), visible: CGRect(x: 1512, y: 0, width: 1512, height: 982))
    let middle = CGPoint(x: 700, y: 500)

    func plain(_ p: CGPoint) -> DragEnd { DragEnd(pointer: p, coveredFrom: nil, dropped: false) }

    func testAWindowDraggedPartlyOffTheScreenOnPurposeStaysPut() {
        // Review of #150: a window with a third hanging off the right edge was pulled back after every drag.
        let offRight = CGRect(x: 912, y: 200, width: 900, height: 600)
        XCTAssertNil(DragRelease.correction(for: offRight, after: plain(CGPoint(x: 1200, y: 214)), displays: [mac]))
        let offLeft = CGRect(x: -300, y: 200, width: 900, height: 600)
        XCTAssertNil(DragRelease.correction(for: offLeft, after: plain(CGPoint(x: 100, y: 214)), displays: [mac]))
        let offBottom = CGRect(x: 300, y: 700, width: 900, height: 600)
        XCTAssertNil(DragRelease.correction(for: offBottom, after: plain(CGPoint(x: 700, y: 714)), displays: [mac]))
    }

    func testAWindowStraddlingTwoDisplaysStaysPut() {
        let seam = CGRect(x: 1100, y: 200, width: 900, height: 600)
        XCTAssertNil(DragRelease.correction(for: seam, after: plain(CGPoint(x: 1300, y: 214)), displays: [mac, right]))
        XCTAssertNil(DragRelease.correction(for: seam, after: plain(CGPoint(x: 1700, y: 214)), displays: [mac, right]))
    }

    func testABlindDropUnderTheOverviewGoesBackToItsFrameBeforeTheOverview() throws {
        // 2026-11-12 10:31:55 to 10:32:00: the overview opened over Helium at the top, it was carried blind, and let go over
        // no workspace about (-608, 478).
        let before = CGRect(x: 65, y: 35, width: 1492, height: 928)
        let end = DragEnd(pointer: CGPoint(x: -130, y: 498), coveredFrom: before, dropped: false)
        let reported = CGRect(x: -608, y: 478, width: 1492, height: 928)
        // The pointer itself was off the display there; any release point not in a tile zone counts.
        XCTAssertEqual(DragRelease.correction(for: reported, after: end, displays: [mac]), .backToBeforeOverview(before))
        let inside = DragEnd(pointer: CGPoint(x: 290, y: 498), coveredFrom: before, dropped: false)
        XCTAssertEqual(DragRelease.correction(for: reported, after: inside, displays: [mac]), .backToBeforeOverview(before))
        XCTAssertNil(DragRelease.correction(for: before, after: inside, displays: [mac]), "already there")
    }

    func testADropOnAWorkspaceIsTheDrops() {
        let end = DragEnd(pointer: middle, coveredFrom: CGRect(x: 0, y: 35, width: 900, height: 600), dropped: true)
        XCTAssertNil(DragRelease.correction(for: CGRect(x: -608, y: 478, width: 1492, height: 928), after: end, displays: [mac]))
        XCTAssertNil(DragRelease.correction(for: CGRect(x: -2000, y: 478, width: 900, height: 600),
                                            after: DragEnd(pointer: middle, coveredFrom: nil, dropped: true), displays: [mac]))
    }

    func testAReleaseWhereMacOSTilesIsLeftToMacOS() {
        let before = CGRect(x: 65, y: 35, width: 1492, height: 928)
        let off = CGRect(x: -345, y: 35, width: 1492, height: 928)
        for p in [CGPoint(x: 400, y: 0), CGPoint(x: 0, y: 400), CGPoint(x: 1511, y: 400)] {
            XCTAssertNil(DragRelease.correction(for: off, after: DragEnd(pointer: p, coveredFrom: before, dropped: false), displays: [mac]), "\(p)")
        }
    }

    func testATitleBarOutOfReachComesBackJustEnoughToGrab() throws {
        let gone = CGRect(x: 1600, y: 300, width: 900, height: 600)
        let next = try XCTUnwrap(DragRelease.correction(for: gone, after: plain(middle), displays: [mac]))
        guard case let .titleBarBackInReach(f) = next else { return XCTFail("\(next)") }
        XCTAssertEqual(f, CGRect(x: 1512 - DragRelease.grip, y: 300, width: 900, height: 600), "only the grip comes back")
        let below = CGRect(x: 300, y: 1000, width: 900, height: 600)
        XCTAssertEqual(DragRelease.correction(for: below, after: plain(middle), displays: [mac])?.frame.minY, 982 - DragRelease.titleHeight)
        // On the second display, the title bar is in reach.
        XCTAssertNil(DragRelease.correction(for: gone, after: plain(middle), displays: [mac, right]))
    }

    func testTheWatcherReportsTheDropItselfAndCorrectsOnlyStillWindows() throws {
        // The drop decision travels in DragEnd, not in shared state set by an earlier callback (review of #150, F5), and a
        // window still moving after 0.5 s is left alone (F4).
        let watcher = try HandsSourceTests.code("Sources/BaneySpaces/TopDragWatcher.swift")
        XCTAssertTrue(watcher.contains("var dropped = endCarry(at: p)"))
        XCTAssertTrue(watcher.contains("dropped = onRelease(g, p != nil) || dropped"))
        XCTAssertTrue(watcher.contains("onDragEnd(dragged.window, DragEnd(pointer: p, coveredFrom: covered, dropped: dropped))"))
        let app = try HandsSourceTests.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("guard !end.dropped else { return }"))
        XCTAssertTrue(app.contains("guard heldStill, now != nil else {"))
        XCTAssertFalse(app.contains("settling[id] == nil, now != nil"), "the old shared-state check is gone")
    }

    func testAPressPassesThroughARecordersOverlay() {
        // Measured with SLSGetWindowTags on macOS 27: a plain window, then the same with ignoresMouseEvents.
        let plain: UInt64 = 0b1000000000000100000000000010000010010000000001
        let ignoring: UInt64 = 0b1000000000000100000000000010000010001000000001
        XCTAssertTrue(PressTarget.takesPress(alpha: 1, tags: plain))
        XCTAssertFalse(PressTarget.takesPress(alpha: 1, tags: ignoring), "alpha 1, clear, ignoresMouseEvents")
        XCTAssertFalse(PressTarget.takesPress(alpha: 0, tags: plain), "alpha 0")
        XCTAssertTrue(PressTarget.takesPress(alpha: nil, tags: nil), "unreadable: counted, as before")
    }
}
