import XCTest
@testable import BaneySpacesCore

/// When a switch's moved windows have stopped (`Settling`): the rules `Spaces.settle` had inline.
final class SettlingTests: XCTestCase {
    private let screens = [CGRect(x: 0, y: 0, width: 1512, height: 982)]
    private let spot = CGPoint(x: 1511, y: 981)
    private func at(_ x: CGFloat, _ y: CGFloat) -> CGRect { CGRect(x: x, y: y, width: 800, height: 600) }

    /// Looks a hair over 10 ms apart (so five of them are 50 ms, whatever the rounding); when it ended, in ms, or nil.
    private func ended(_ s: inout Settling, _ frames: [[WindowID: CGRect]]) -> Int? {
        for (i, f) in frames.enumerated() where s.look(f, at: 100 + 0.0101 * Double(i + 1)) { return 10 * (i + 1) }
        return nil
    }

    func testAWindowAtItsPlaceIsHomeAtTheNextLook() {
        var s = Settling([1], goal: .home([1: CGPoint(x: 100, y: 50)]), screens: screens, start: 100)
        XCTAssertEqual(ended(&s, [[1: at(1511, 954)], [1: at(100.4, 50)], [1: at(100, 50)]]), 20)
    }

    func testAWindowStillSomewhereElseInSightIsHomeAfter50ms() {
        var s = Settling([1], goal: .home([1: CGPoint(x: 100, y: 50)]), screens: screens, start: 100)
        XCTAssertEqual(ended(&s, Array(repeating: [1: at(100, 80)], count: 20)), 60)
    }

    func testAWindowThatStaysParkedIsNeverHome() {
        var s = Settling([1], goal: .home([1: CGPoint(x: 100, y: 50)]), screens: screens, start: 100)
        XCTAssertNil(ended(&s, Array(repeating: [1: at(1511, 954)], count: 40)))
    }

    func testAParkedWindowSomewhereElseMustKeepStillFor50ms() {
        var s = Settling([1], goal: .parked(at: spot), screens: screens, start: 100)
        XCTAssertEqual(ended(&s, [[1: at(900, 500)], [1: at(1500, 800)]] + Array(repeating: [1: at(1480, 800)], count: 20)), 80)
    }

    func testAWindowInSightIsNeverParked() {
        var s = Settling([1], goal: .parked(at: spot), screens: screens, start: 100)
        XCTAssertNil(ended(&s, Array(repeating: [1: at(100, 50)], count: 40)))
    }

    func testAWindowTheServerDoesNotListIsNotWaitedFor() {
        var s = Settling([1, 2], goal: .parked(at: spot), screens: screens, start: 100)
        XCTAssertEqual(ended(&s, [[3: at(0, 0)]]), 10)
    }

    /// An app that animates: positions between two others past 0.12 s.
    func testAWindowStillMovingLateIsASlowMover() {
        var s = Settling([1, 2], goal: .parked(at: spot), screens: screens, start: 100)
        let slide: [[WindowID: CGRect]] = (0..<20).map { i in [1: at(100 + 70 * CGFloat(i), 50 + 45 * CGFloat(i)), 2: at(1480, 900)] }
        XCTAssertNotNil(ended(&s, slide + Array(repeating: [1: at(1480, 900), 2: at(1480, 900)], count: 20)))
        XCTAssertEqual(s.slow, [1])
    }

    func testAMoveDoneEarlyIsNotSlow() {
        var s = Settling([1], goal: .parked(at: spot), screens: screens, start: 100)
        XCTAssertNotNil(ended(&s, [[1: at(100, 50)], [1: at(800, 500)]] + Array(repeating: [1: at(1480, 900)], count: 20)))
        XCTAssertEqual(s.slow, [])
    }
}
