import BaneySpacesCore
import Foundation
import XCTest

/// #124 round 1 sol-F4: `open --wait 0` read a second copy that was still starting as no copy, answered needs_sandbox and
/// cancelled the open. Round 2 sol-sol-F5: `focus.returned` was true after a restore macOS refused, because the attempt was
/// counted before its result was checked.
final class OpenFocusReportTests: XCTestCase {
    func testACopyStillStartingIsNotNoCopy() {
        XCTAssertFalse(SeparateCopy.noneStarted(launched: nil, running: [10], before: [10], elapsed: 0.1), "sol-F4: --wait 0, the launch hasn't reported yet")
        XCTAssertFalse(SeparateCopy.noneStarted(launched: nil, running: [10], before: [10], elapsed: SeparateCopy.settle - 0.01))
        XCTAssertTrue(SeparateCopy.noneStarted(launched: nil, running: [10], before: [10], elapsed: SeparateCopy.settle), "it had time to report: none")
    }

    func testANewCopyIsNeverNoCopy() {
        XCTAssertFalse(SeparateCopy.noneStarted(launched: 11, running: [10], before: [10], elapsed: 9), "the launch reported its process")
        XCTAssertFalse(SeparateCopy.noneStarted(launched: nil, running: [10, 11], before: [10], elapsed: 9), "a new copy runs")
    }

    func testTheOpenAsksTheRuleWithItsOwnLaunch() throws {
        let r = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertTrue(r.contains("SeparateCopy.noneStarted(launched: AgentLaunches.shared.pid(token), running: runningCopies(bundle: bundle),"))
        XCTAssertTrue(r.contains("before: pidsBefore, elapsed: Date().timeIntervalSince(requestStart))"))
        XCTAssertFalse(r.contains("noNewProcess("), "no one-look verdict")
    }

    func testAReturnIsCountedOnlyWhenMacOSTookIt() throws {
        let f = try HandsSourceTests.code("Sources/BaneySpaces/Hands/AgentLaunchFocus.swift")
        XCTAssertEqual(f.components(separatedBy: "returns += 1").count - 1, 2)
        XCTAssertEqual(f.components(separatedBy: "if result == .success { returns += 1 } else {").count - 1, 2, "sol-sol-F5: both restores")
    }
}
