import CoreGraphics
import XCTest
@testable import BaneySpacesCore

/// A window border never trails its window: it moves with it (live), or, where macOS gives no move notices, it is not
/// drawn while the window moves (the fallback, forced here).
final class BorderFollowTests: XCTestCase {
    func testTheFallbackIsChosenWithoutNoticesOrWhenForced() {
        XCTAssertEqual(BorderFollowMode.choose(notices: true, forced: false), .live)
        XCTAssertEqual(BorderFollowMode.choose(notices: false, forced: false), .hideWhileMoving)
        XCTAssertEqual(BorderFollowMode.choose(notices: true, forced: true), .hideWhileMoving)
    }

    /// A drag by the title bar, forced onto the fallback: from the press until the window has held still, no border is
    /// drawn for it, and every border drawn is at the frame given in that very look.
    func testTheForcedFallbackDrawsNoBorderMidDrag() {
        guard BorderFollowMode.choose(notices: true, forced: true) == .hideWhileMoving else { return XCTFail("forced") }
        var g = BorderHideWhileMoving()
        let other = CGRect(x: 900, y: 100, width: 300, height: 200)
        var w = CGRect(x: 100, y: 100, width: 400, height: 300)
        var t = 0.0
        func look(_ down: Bool) -> [UInt32: CGRect] {
            let out = g.look([7: w, 8: other], buttonDown: down, now: t)
            for (id, f) in out { XCTAssertEqual(f, id == 7 ? w : other, "drawn only where the window is now") }
            return out
        }
        XCTAssertEqual(look(false)[7], w, "still: drawn")
        // The press in the title bar hides it before the window moves.
        t += 0.01
        XCTAssertEqual(g.press(at: CGPoint(x: 300, y: 120), frames: [(7, w), (8, other)], now: t), 7)
        // 60 frames of dragging at 120 Hz, the button down.
        for _ in 0..<60 {
            t += 1.0 / 120
            w.origin.x += 4
            let out = look(true)
            XCTAssertNil(out[7], "no border mid-drag")
            XCTAssertEqual(out[8], other, "the window not moving keeps its border")
        }
        // Let go while it still slides a little (a throw, or the app easing), then still.
        for _ in 0..<5 { t += 1.0 / 120; w.origin.x += 2; XCTAssertNil(look(false)[7], "still moving after the release") }
        t += BorderPace.settle - 0.01
        XCTAssertNil(look(false)[7], "not yet held still for the settle time")
        t += 0.02
        XCTAssertEqual(look(false)[7], w, "back where it settled")
    }

    func testAMoveWithNoPressHidesAtTheFirstLookAndAClickThatMovesNothingComesBackAtOnce() {
        var g = BorderHideWhileMoving()
        var w = CGRect(x: 100, y: 100, width: 400, height: 300)
        XCTAssertEqual(g.look([7: w], buttonDown: false, now: 0)[7], w)
        w.origin.y += 50   // a key moved it
        XCTAssertNil(g.look([7: w], buttonDown: false, now: 0.1)[7], "never drawn at the old place, nor followed while it may move")
        XCTAssertNil(g.look([7: w], buttonDown: false, now: 0.2)[7])
        XCTAssertEqual(g.look([7: w], buttonDown: false, now: 0.11 + BorderPace.settle)[7], w)
        // A click in the title bar that moves nothing.
        XCTAssertEqual(g.press(at: CGPoint(x: 200, y: 160), frames: [(7, w)], now: 1), 7)
        XCTAssertNil(g.look([7: w], buttonDown: true, now: 1.05)[7])
        XCTAssertEqual(g.look([7: w], buttonDown: false, now: 1.1)[7], w, "released without a move: back at once")
    }

    func testAPressInTheContentOrOnAnotherWindowLeavesTheBorder() {
        var g = BorderHideWhileMoving()
        let w = CGRect(x: 100, y: 100, width: 400, height: 300)
        _ = g.look([7: w], buttonDown: false, now: 0)
        XCTAssertNil(g.press(at: CGPoint(x: 300, y: 300), frames: [(7, w)], now: 1), "the middle of the window")
        XCTAssertNil(g.press(at: CGPoint(x: 1000, y: 300), frames: [(7, w)], now: 1), "elsewhere")
        XCTAssertEqual(g.press(at: CGPoint(x: 497, y: 300), frames: [(7, w)], now: 1), 7, "the right edge resizes")
        // A window in front takes the press.
        let front = CGRect(x: 250, y: 50, width: 400, height: 300)
        var h = BorderHideWhileMoving()
        _ = h.look([7: w, 9: front], buttonDown: false, now: 0)
        XCTAssertEqual(h.press(at: CGPoint(x: 300, y: 110), frames: [(9, front), (7, w)], now: 1), 9)
        XCTAssertFalse(h.isHidden(7))
    }
}
