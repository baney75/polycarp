import XCTest
@testable import BaneySpacesCore

/// R-F5 cases: input, expected result.
final class FocusKeepTests: XCTestCase {
    private func keeps(reapply: Bool = true, ours: Bool = false, since: TimeInterval = 0.1, here: Bool = false) -> Bool {
        FocusKeep.keepsFront(reapply: reapply, frontIsOurs: ours, sinceActivation: since, frontHasWindowHere: here)
    }

    /// The bug: a browser a link brought forward, a rescan re-applies the workspace 90 ms later.
    func testARescanLeavesTheBrowserYouJustBroughtForward() { XCTAssertTrue(keeps(since: 0.09)) }

    func testASwitchToAnotherWorkspaceStillTakesFocus() { XCTAssertFalse(keeps(reapply: false)) }

    func testAnAppPolycarpBroughtForwardIsNotKept() { XCTAssertFalse(keeps(ours: true)) }

    func testAnAppWithAWindowHereIsFocusedHereAsBefore() { XCTAssertFalse(keeps(here: true)) }

    func testAnOldActivationNoLongerCounts() {
        XCTAssertFalse(keeps(since: FocusKeep.window))
        XCTAssertFalse(keeps(since: 5))
    }

    func testAClockThatWentBackDoesNotCount() { XCTAssertFalse(keeps(since: -0.5)) }
}
