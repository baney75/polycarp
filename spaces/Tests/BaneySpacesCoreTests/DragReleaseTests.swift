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
        // Review of #154, first-F3: the pointer itself let go past the left edge, on no display.
        let pastTheEdge = DragEnd(pointer: CGPoint(x: -130, y: 498), coveredFrom: before, dropped: false)
        XCTAssertEqual(DragRelease.correction(for: reported, after: pastTheEdge, displays: [mac]), .backToBeforeOverview(before))
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

    func testASeamCountsOnlyWhereTheOtherDisplayIsAtThePointer() {
        // Review of #154, second-F6: a laptop with a wider external display above, offset to the right. Its top edge is a
        // seam only under the external display; left of it, the laptop's top is its own and macOS fills there.
        let external = CGRect(x: 1000, y: -1080, width: 1920, height: 1080)
        XCTAssertEqual(DragRelease.tileEdge(CGPoint(x: 400, y: 2), on: mac.frame, displays: [mac.frame, external], edges: [.top]), .top)
        XCTAssertNil(DragRelease.tileEdge(CGPoint(x: 1200, y: 2), on: mac.frame, displays: [mac.frame, external], edges: [.top]))
        // The same along a side: a shorter display to the right touches only the top of the right edge.
        let short = CGRect(x: 1512, y: 0, width: 1024, height: 600)
        XCTAssertNil(DragRelease.tileEdge(CGPoint(x: 1510, y: 300), on: mac.frame, displays: [mac.frame, short], edges: [.right]))
        XCTAssertEqual(DragRelease.tileEdge(CGPoint(x: 1510, y: 800), on: mac.frame, displays: [mac.frame, short], edges: [.right]), .right)
        // A covered release at the top left of the laptop is macOS's fill, not a blind drop, even before the fill lands.
        let before = CGRect(x: 65, y: 35, width: 900, height: 600)
        let top = DragEnd(pointer: CGPoint(x: 400, y: 0), coveredFrom: before, dropped: false)
        let ext = (frame: external, visible: external)
        XCTAssertNil(DragRelease.correction(for: CGRect(x: 0, y: 10, width: 1300, height: 900), after: top, displays: [mac, ext]))
    }

    /// Every look a pending correction of window 7 takes over `frames`, until it decides: the outcome, how many looks, and
    /// the frame it rested at then. `buttonDown` holds the looks (from 1) when a button is down.
    func settle(_ watch: SettleWatch, _ end: DragEnd, _ frames: [CGRect?], buttonDown: Set<Int> = []) -> (PendingSettles.Outcome, Int, CGRect?) {
        var p = PendingSettles()
        p.start(7, watch: watch, end: end)
        for (i, f) in frames.enumerated() {
            let o = p.look(7, frame: f, buttonDown: buttonDown.contains(i + 1))
            if o != .wait { return (o, i + 1, f) }
        }
        return (.wait, frames.count, frames.last ?? nil)
    }

    func testACoveredReleaseAtASideEdgeIsJudgedWhereItRests() {
        // Reviews of #154 (first-F2), #155 (first-F3) and #158 (first-F1): let go blind at the left edge, the window may
        // be moved again after the release, by macOS's half tile after a pause or by the app itself (Helium is Chromium,
        // which sets its own frame a tick or two after a tab-strip drag). Polycarp waits until it rests 1 s and judges it
        // there: back if it rests off screen, alone if it rests tiled.
        let before = CGRect(x: 65, y: 35, width: 1492, height: 928)
        let blind = CGRect(x: -608, y: 478, width: 1492, height: 928)
        let leftHalf = CGRect(x: 0, y: 35, width: 756, height: 947)
        let end = DragEnd(pointer: CGPoint(x: 0, y: 498), coveredFrom: before, dropped: false)
        func lerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { (a + (b - a) * t).rounded() }
        let animation: [CGRect?] = (1...10).map { i in
            let t = CGFloat(i) / 10
            return CGRect(x: lerp(blind.minX, leftHalf.minX, t), y: lerp(blind.minY, leftHalf.minY, t),
                          width: lerp(blind.width, leftHalf.width, t), height: lerp(blind.height, leftHalf.height, t))
        }
        func tiled(afterPause looks: Int) -> [CGRect?] { Array(repeating: blind, count: looks) + animation + Array(repeating: leftHalf, count: 60) }
        let watch = { DragRelease.settleWatch(from: blind, after: end, displays: [self.mac]) }
        // The plain watch calls it still in the pause, off screen, and the correction would fight macOS's tile.
        XCTAssertEqual(settle(SettleWatch(from: blind), end, tiled(afterPause: 8)).0, .correct(end))
        XCTAssertEqual(DragRelease.correction(for: blind, after: end, displays: [mac]), .backToBeforeOverview(before))
        // The side watch waits the tile out, after a short pause or a long one, and finds it resting in the left half.
        for pause in [8, 25] {
            let (outcome, looks, rest) = settle(watch(), end, tiled(afterPause: pause))
            XCTAssertEqual(outcome, .correct(end), "pause of \(pause * 20) ms")
            XCTAssertEqual(looks, pause + 10 + DragRelease.sideTileStillLooks)
            XCTAssertEqual(rest, leftHalf)
            XCTAssertNil(DragRelease.correction(for: leftHalf, after: end, displays: [mac]), "tiled: left alone")
        }
        // A tile that starts late can't rest a full second inside the 2 s limit: left alone, still tiled.
        XCTAssertEqual(settle(watch(), end, tiled(afterPause: 45)).0, .leftAlone("still moving: no 1000 ms rest within 2000 ms"))
        // Chromium's own last move lands one and two ticks after mouse-up, then it rests off screen: it goes back.
        let trailing: [CGRect?] = [blind.offsetBy(dx: 30, dy: -6), blind.offsetBy(dx: 10, dy: -2)] + Array(repeating: blind, count: 80)
        let (outcome, looks, rest) = settle(DragRelease.settleWatch(from: blind.offsetBy(dx: 60, dy: -12), after: end, displays: [mac]), end, trailing)
        XCTAssertEqual(outcome, .correct(end))
        XCTAssertEqual(looks, 3 + DragRelease.sideTileStillLooks, "the release frame, then two moves, then the rest")
        XCTAssertEqual(rest.flatMap { DragRelease.correction(for: $0, after: end, displays: [mac]) }, .backToBeforeOverview(before))
        // macOS doesn't tile it: it goes back once it has rested the whole second.
        XCTAssertEqual(settle(watch(), end, Array(repeating: blind, count: 80)).0, .correct(end))
        XCTAssertEqual(settle(watch(), end, Array(repeating: blind, count: 80)).1, DragRelease.sideTileStillLooks)
        // Moved again and again, it never rests a second within 2 s: left alone.
        let restless: [CGRect?] = (1...120).map { blind.offsetBy(dx: CGFloat($0 / 30) * 20, dy: 0) }
        XCTAssertEqual(settle(watch(), end, restless).0, .leftAlone("still moving: no 1000 ms rest within 2000 ms"))
        // The limit until case 6 measures macOS's pause: one longer than the 1 s wait is corrected before the tile.
        XCTAssertEqual(settle(watch(), end, tiled(afterPause: 60)).2, blind)
        // Only a covered release in a side band waits that way: a plain one, the top, the middle and a seam don't.
        let side = { (e: DragEnd, d: [(frame: CGRect, visible: CGRect)]) in DragRelease.settleWatch(from: blind, after: e, displays: d) }
        XCTAssertTrue(side(end, [mac]).waitsForTile)
        XCTAssertTrue(side(DragEnd(pointer: CGPoint(x: 1511, y: 498), coveredFrom: before, dropped: false), [mac]).waitsForTile)
        XCTAssertFalse(side(plain(CGPoint(x: 0, y: 498)), [mac]).waitsForTile)
        XCTAssertFalse(side(DragEnd(pointer: CGPoint(x: 400, y: 0), coveredFrom: before, dropped: false), [mac]).waitsForTile)
        XCTAssertFalse(side(DragEnd(pointer: CGPoint(x: 700, y: 498), coveredFrom: before, dropped: false), [mac]).waitsForTile)
        XCTAssertFalse(side(DragEnd(pointer: CGPoint(x: 1510, y: 498), coveredFrom: before, dropped: false), [mac, right]).waitsForTile)
        XCTAssertEqual(side(plain(CGPoint(x: 0, y: 498)), [mac]).stillLooks, 3)
    }

    func testAPointerPastEveryEdgeBelongsToTheNearestDisplay() {
        // Review of #155, second-F7: pushed blind past the left edge, the pointer is on no display. The watch and the
        // correction must both read it as the laptop's left band.
        let before = CGRect(x: 65, y: 35, width: 1492, height: 928)
        let pastTheEdge = DragEnd(pointer: CGPoint(x: -130, y: 498), coveredFrom: before, dropped: false)
        let watch = DragRelease.settleWatch(from: before, after: pastTheEdge, displays: [mac])
        XCTAssertTrue(watch.waitsForTile)
        XCTAssertEqual(watch.stillLooks, DragRelease.sideTileStillLooks)
        // Past the outer right edge of the second display, its visible area decides, not the first display's.
        let pastRight = DragEnd(pointer: CGPoint(x: 3200, y: 498), coveredFrom: before, dropped: false)
        let tiledRight = CGRect(x: 2268, y: 0, width: 756, height: 982)
        XCTAssertNil(DragRelease.correction(for: tiledRight, after: pastRight, displays: [mac, right]))
        XCTAssertTrue(DragRelease.settleWatch(from: before, after: pastRight, displays: [mac, right]).waitsForTile)
        XCTAssertEqual(DragRelease.display(of: CGPoint(x: 3200, y: 498), in: [mac, right])?.frame, right.frame)
        XCTAssertEqual(DragRelease.display(of: CGPoint(x: -130, y: 498), in: [mac, right])?.frame, mac.frame)
        XCTAssertNil(DragRelease.display(of: .zero, in: []))
    }

    func testOnlyThatWindowCancelsItsPendingCorrection() {
        // Review of #155, first-F1: let go blind, then grabbed again within the wait and held still part off screen. The
        // stale release must not snap it back while it's held. Review of #158, second-second-F1: a click anywhere else in
        // that second must not cost the blind drop its correction.
        let before = CGRect(x: 65, y: 35, width: 1492, height: 928)
        let blind = CGRect(x: -608, y: 478, width: 1492, height: 928)
        let end = DragEnd(pointer: CGPoint(x: 0, y: 498), coveredFrom: before, dropped: false)
        var p = PendingSettles()
        p.start(7, watch: DragRelease.settleWatch(from: blind, after: end, displays: [mac]), end: end)
        p.start(8, watch: DragRelease.settleWatch(from: blind, after: end, displays: [mac]), end: end)
        XCTAssertEqual(p.look(7, frame: blind, buttonDown: false), .wait)
        p.cancel(7)  // pressed again
        XCTAssertEqual(p.look(7, frame: blind, buttonDown: false), .none)
        XCTAssertEqual(p.look(8, frame: blind, buttonDown: false), .wait, "another window's wait goes on")
        // A click on the Dock in the middle of the wait, down for 120 ms and up again: still goes back, on time.
        let side = { DragRelease.settleWatch(from: blind, after: end, displays: [self.mac]) }
        let clicked = settle(side(), end, Array(repeating: blind, count: 80), buttonDown: Set(20...25))
        XCTAssertEqual(clicked.0, .correct(end))
        XCTAssertEqual(clicked.1, DragRelease.sideTileStillLooks)
        // A button down just as it comes to rest holds the correction off until the button is up.
        let held = settle(SettleWatch(from: blind), end, Array(repeating: blind, count: 20), buttonDown: Set(4...8))
        XCTAssertEqual(held.0, .correct(end))
        XCTAssertEqual(held.1, 9)
        // Held down past the wait's own limit, unsure what the person is doing: left alone.
        let forever = settle(SettleWatch(from: blind), end, Array(repeating: blind, count: 40), buttonDown: Set(1...40))
        XCTAssertEqual(forever.0, .leftAlone("a button stayed down 500 ms after the release"))
        // Undisturbed, the same wait corrects with the release it started from.
        XCTAssertEqual(settle(SettleWatch(from: blind), end, Array(repeating: blind, count: 5)).0, .correct(end))
        XCTAssertEqual(settle(SettleWatch(from: blind), end, Array(repeating: nil, count: 30)).0, .leftAlone("its frame can't be read"))
        XCTAssertEqual(settle(SettleWatch(from: blind), end, (1...30).map { blind.offsetBy(dx: CGFloat($0), dy: 0) }).0, .leftAlone("still moving: no 60 ms rest within 500 ms"))
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
