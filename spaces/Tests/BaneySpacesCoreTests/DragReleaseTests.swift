import CoreGraphics
import XCTest
@testable import BaneySpacesCore

final class DragReleaseTests: XCTestCase {
    // Donovan's MacBook: 1512x982 points, a 35 pt menu bar, no Dock reserved.
    let display = (frame: CGRect(x: 0, y: 0, width: 1512, height: 982), visible: CGRect(x: 0, y: 35, width: 1512, height: 947))
    let middle = CGPoint(x: 700, y: 500)

    func testTheFrameFromTheRecordingComesBackOnScreen() throws {
        // Helium let go at (-608, 478) over no workspace with the overview up (2026-11-12, 10:32:00).
        let reported = CGRect(x: -608, y: 478, width: 1492, height: 928)
        let next = try XCTUnwrap(DragRelease.onScreen(reported, releasedAt: middle, displays: [display]))
        XCTAssertEqual(next, CGRect(x: 0, y: 54, width: 1492, height: 928))
        XCTAssertTrue(display.visible.contains(next))
    }

    func testAWindowLetGoAtTheDockEdgeComesUp() throws {
        let low = CGRect(x: 300, y: 900, width: 800, height: 600)
        let next = try XCTUnwrap(DragRelease.onScreen(low, releasedAt: CGPoint(x: 700, y: 980), displays: [display]))
        XCTAssertEqual(next.origin, CGPoint(x: 300, y: 382))
        XCTAssertEqual(next.size, low.size, "never resized")
    }

    func testAReleaseWhereMacOSTilesIsLeftToMacOS() {
        let off = CGRect(x: -345, y: 35, width: 1492, height: 928)
        XCTAssertNil(DragRelease.onScreen(off, releasedAt: CGPoint(x: 400, y: 0), displays: [display]), "the top fills")
        XCTAssertNil(DragRelease.onScreen(off, releasedAt: CGPoint(x: 0, y: 400), displays: [display]), "the left edge tiles")
        XCTAssertNil(DragRelease.onScreen(off, releasedAt: CGPoint(x: 1511, y: 400), displays: [display]), "the right edge tiles")
    }

    func testAWindowAlreadyOnScreenStays() {
        XCTAssertNil(DragRelease.onScreen(CGRect(x: 100, y: 100, width: 800, height: 600), releasedAt: middle, displays: [display]))
        XCTAssertNil(DragRelease.onScreen(CGRect(x: 0, y: 35, width: 1512, height: 947), releasedAt: middle, displays: [display]))
    }

    func testATallerThanTheScreenWindowSitsUnderTheMenuBar() throws {
        let tall = CGRect(x: 40, y: 200, width: 900, height: 1200)
        XCTAssertEqual(try XCTUnwrap(DragRelease.onScreen(tall, releasedAt: middle, displays: [display])).origin, CGPoint(x: 40, y: 35))
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
