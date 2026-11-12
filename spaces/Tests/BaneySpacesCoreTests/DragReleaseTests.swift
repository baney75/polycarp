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
        let reported = CGRect(x: -608, y: 478, width: 1492, height: 928)
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

    func testABlindDropPushedAgainstTheSideEdgeStillGoesBack() {
        // Review of #152: pushed left blind, the pointer stops at x 0 while the window goes on off the screen. Waiting
        // for the window to hold still, a side edge counts only by what macOS did with it.
        let before = CGRect(x: 65, y: 35, width: 1492, height: 928)
        let reported = CGRect(x: -608, y: 478, width: 1492, height: 928)
        for p in [CGPoint(x: 0, y: 498), CGPoint(x: 1511, y: 498)] {
            let end = DragEnd(pointer: p, coveredFrom: before, dropped: false)
            XCTAssertEqual(DragRelease.correction(for: reported, after: end, displays: [mac]), .backToBeforeOverview(before), "\(p)")
        }
        // macOS half-tiled it at the left edge: in the visible area, macOS's.
        let leftHalf = CGRect(x: 0, y: 35, width: 756, height: 947)
        XCTAssertNil(DragRelease.correction(for: leftHalf, after: DragEnd(pointer: CGPoint(x: 0, y: 498), coveredFrom: before, dropped: false), displays: [mac]))
        // At the top macOS fills it, whatever the frame reads while it still animates.
        XCTAssertNil(DragRelease.correction(for: reported, after: DragEnd(pointer: CGPoint(x: 400, y: 0), coveredFrom: before, dropped: false), displays: [mac]))
    }

    func testAnUncoveredReleaseWhereMacOSTilesIsLeftToMacOS() {
        let gone = CGRect(x: 1600, y: 300, width: 900, height: 600)
        for p in [CGPoint(x: 400, y: 0), CGPoint(x: 0, y: 400), CGPoint(x: 1511, y: 400)] {
            XCTAssertNil(DragRelease.correction(for: gone, after: plain(p), displays: [mac]), "\(p)")
        }
    }

    func testASeamBetweenDisplaysIsNoTileZone() {
        // Review of #152: at the inner seam the pointer crosses to the next display; macOS tiles nothing there.
        let before = CGRect(x: 65, y: 35, width: 1492, height: 928)
        let off = CGRect(x: 600, y: 900, width: 1492, height: 928)
        let atSeam = DragEnd(pointer: CGPoint(x: 1508, y: 914), coveredFrom: before, dropped: false)
        XCTAssertEqual(DragRelease.correction(for: off, after: atSeam, displays: [mac, right]), .backToBeforeOverview(before))
        XCTAssertNil(DragRelease.tileEdge(CGPoint(x: 1508, y: 400), on: mac.frame, displays: [mac.frame, right.frame], edges: [.right]))
        XCTAssertEqual(DragRelease.tileEdge(CGPoint(x: 1508, y: 400), on: mac.frame, displays: [mac.frame], edges: [.right]), .right)
        // A display stacked below: its top edge is a seam too, the primary's top still tiles.
        let below = CGRect(x: 0, y: 982, width: 1512, height: 982)
        XCTAssertNil(DragRelease.tileEdge(CGPoint(x: 700, y: 984), on: below, displays: [mac.frame, below], edges: [.top]))
        XCTAssertEqual(DragRelease.tileEdge(CGPoint(x: 700, y: 2), on: mac.frame, displays: [mac.frame, below], edges: [.top]), .top)
        // The uncovered rescue still skips the outer edges.
        let gone = CGRect(x: 3100, y: 300, width: 900, height: 600)
        XCTAssertNil(DragRelease.correction(for: gone, after: plain(CGPoint(x: 3022, y: 400)), displays: [mac, right]))
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

    func testCoveredMeansTheOverviewStillShowsThereAtRelease() {
        let from = CGRect(x: 65, y: 35, width: 900, height: 600)
        let p = CGPoint(x: 290, y: 498)
        // Asked before the overview's release closes it.
        var showing = true
        let end = ReleaseOrder.end(at: p, coveredFrom: from, overviewCovers: { showing }, endCarry: { false },
                                   release: { showing = false; return false })
        XCTAssertEqual(end, DragEnd(pointer: p, coveredFrom: from, dropped: false))
        // Review of #152 (F1, F6): closed mid-carry, or carried to a display the overview isn't on.
        let notThere = ReleaseOrder.end(at: p, coveredFrom: from, overviewCovers: { false }, endCarry: { false }, release: { false })
        XCTAssertNil(notThere.coveredFrom)
        // No overview for this drag: nothing to ask.
        let plainDrag = ReleaseOrder.end(at: p, coveredFrom: nil, overviewCovers: { XCTFail("asked"); return true }, endCarry: { false }, release: nil)
        XCTAssertEqual(plainDrag, DragEnd(pointer: p, coveredFrom: nil, dropped: false))
    }

    func testEitherDropMakesTheDragADrop() {
        // The drop travels in DragEnd from the callbacks' own answers (review of #150, F5), carry first, then the overview.
        var order: [String] = []
        let p = CGPoint(x: 290, y: 498)
        func end(carry: Bool, release: Bool?) -> DragEnd {
            ReleaseOrder.end(at: p, coveredFrom: nil, overviewCovers: { true },
                             endCarry: { order.append("carry"); return carry },
                             release: release.map { r in { order.append("release"); return r } })
        }
        XCTAssertTrue(end(carry: true, release: nil).dropped)
        XCTAssertTrue(end(carry: false, release: true).dropped)
        XCTAssertTrue(end(carry: true, release: false).dropped)
        XCTAssertFalse(end(carry: false, release: nil).dropped)
        order = []
        XCTAssertFalse(end(carry: false, release: false).dropped)
        XCTAssertEqual(order, ["carry", "release"])
    }

    func testAWindowIsCorrectedOnlyOnceItHoldsStill() {
        let f = CGRect(x: 0, y: 35, width: 900, height: 600)
        var still = SettleWatch(from: f)
        XCTAssertEqual((1...4).map { _ in still.look(f) }, [.wait, .wait, .wait, .wait], "at least five looks")
        XCTAssertEqual(still.look(f), .still)
        // Settles after a tile animation.
        var settling = SettleWatch(from: f)
        let frames = (0..<8).map { f.offsetBy(dx: CGFloat($0) * 10, dy: 0) } + Array(repeating: f.offsetBy(dx: 70, dy: 0), count: 3)
        let verdicts = frames.map { settling.look($0) }
        XCTAssertEqual(verdicts.last, .still)
        XCTAssertFalse(verdicts.dropLast().contains(.still))
        // Review of #150, F4: still moving after 0.5 s, given up on, never corrected.
        var moving = SettleWatch(from: f)
        let all = (1...25).map { moving.look(f.offsetBy(dx: CGFloat($0), dy: 0)) }
        XCTAssertEqual(all.last, .gaveUp)
        XCTAssertFalse(all.contains(.still))
        XCTAssertEqual(moving.looks, 25)
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
