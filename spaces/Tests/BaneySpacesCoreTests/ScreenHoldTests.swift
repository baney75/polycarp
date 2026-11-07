import BaneySpacesCore
import Foundation
import XCTest

/// A held screen looks like a frozen Mac, so every way through a switch must let go. Unit tests can't see the screen; the measure of the
/// hold itself is `scripts/switch-frames-probe.py`.
final class ScreenHoldTests: XCTestCase {
    private func spaces() throws -> String { try HandsSourceTests.code("Sources/BaneySpaces/Spaces.swift") }

    func testAHoldHasAShortLimitRunOffTheMainThread() throws {
        XCTAssertLessThanOrEqual(ScreenHoldPolicy.longest, 0.15, "any longer reads as a freeze")
        let hold = try HandsSourceTests.code("Sources/BaneySpaces/ScreenHold.swift")
        XCTAssertTrue(hold.contains("watchdog.asyncAfter(deadline: .now() + ScreenHoldPolicy.longest)"))
        XCTAssertFalse(hold.contains("DispatchQueue.main"), "the main thread may be what's stuck")
    }

    func testASwitchThatStopsEarlyLetsGo() throws {
        let code = try spaces()
        let apply = try XCTUnwrap(HandsSourceTests.block(after: "private func apply(_ plan: SwitchPlan", in: code))
        XCTAssertTrue(apply.contains("ScreenHold.begin()"))
        XCTAssertTrue(apply.contains("guard gen == generation, active else { return ScreenHold.end() }"), "a newer switch took over")
        XCTAssertEqual(apply.components(separatedBy: "ScreenHold.end()").count - 1, 2, "the newer switch, and the normal way out")
        XCTAssertLessThan(try XCTUnwrap(apply.range(of: "clock.mark(.done)")).lowerBound, try XCTUnwrap(apply.range(of: "clock.mark(.parked)")).lowerBound)
    }
}
