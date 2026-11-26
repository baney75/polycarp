import XCTest
@testable import BaneySpacesCore

/// spec/tiling-speed.md R-TS9, cases 31 to 35: a frame is sent so the window never shows one in between that the
/// display clamps or that lies outside both frames.
final class FrameStepsTests: XCTestCase {
    private let display = CGRect(x: 0, y: 0, width: 1512, height: 982)

    private func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect { CGRect(x: x, y: y, width: w, height: h) }

    /// The trace of 2026-11-26: sized first, the window was clamped to 1512 - 92 = 1420 wide on its way.
    func testCase31AWindowGrowingLeftMovesFirst() {
        XCTAssertEqual(FrameSteps.order(from: r(92, 40, 744, 934), to: r(8, 40, 1496, 934), display: display), [.position, .size])
    }

    func testCase32TheSameSizeIsOnlyMoved() {
        XCTAssertEqual(FrameSteps.order(from: r(8, 40, 744, 934), to: r(760, 40, 744, 934), display: display), [.position])
    }

    func testCase33TheSamePlaceIsOnlySized() {
        XCTAssertEqual(FrameSteps.order(from: r(8, 40, 744, 934), to: r(8, 40, 1496, 934), display: display), [.size])
    }

    func testCase34AWindowShrinkingRightIsSizedFirst() {
        XCTAssertEqual(FrameSteps.order(from: r(8, 40, 1496, 934), to: r(760, 40, 744, 934), display: display), [.size, .position])
    }

    /// Off the display's right edge moved first, off its bottom sized first: the old three messages.
    func testCase35NeitherFitsSendsTheOldThree() {
        let d = r(0, 40, 1512, 985)
        XCTAssertEqual(FrameSteps.order(from: r(700, 600, 800, 300), to: r(750, 40, 760, 985), display: d), [.size, .position, .size])
        XCTAssertEqual(FrameSteps.order(from: r(92, 40, 744, 934), to: r(8, 40, 1496, 934), display: nil), [.size, .position, .size])
    }

    /// Whichever two messages are chosen, the window between them stays on the display, so it is never clamped.
    func testNothingInBetweenLeavesTheDisplay() {
        var seed: UInt64 = 7
        func next(_ n: CGFloat) -> CGFloat {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return CGFloat((seed >> 33) % UInt64(n))
        }
        for _ in 0..<2000 {
            let a = r(next(700), 40 + next(400), 100 + next(800), 100 + next(500))
            let b = r(next(700), 40 + next(400), 100 + next(800), 100 + next(500))
            let steps = FrameSteps.order(from: a, to: b, display: display)
            guard steps.count == 2 else { continue }
            let mid = steps[0] == .position ? CGRect(origin: b.origin, size: a.size) : CGRect(origin: a.origin, size: b.size)
            XCTAssertTrue(display.insetBy(dx: -0.5, dy: -0.5).contains(mid), "\(a) to \(b): \(mid)")
        }
    }
}
