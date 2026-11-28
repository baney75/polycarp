import XCTest
@testable import BaneySpacesCore

/// R-F5 cases: input, expected result.
final class FocusKeepTests: XCTestCase {
    private func keeps(reapply: Bool = true, browser: Bool = true, ours: Bool = false, agents: Bool = false,
                       decided: Bool = false, since: TimeInterval = 0.1, here: Bool = false) -> Bool {
        FocusKeep.keepsFront(reapply: reapply, frontIsBrowser: browser, frontIsOurs: ours, frontIsAgents: agents,
                             decided: decided, sinceActivation: since, frontHasWindowHere: here)
    }

    /// The bug: a browser a link brought forward, a rescan re-applies the workspace 90 ms later.
    func testARescanLeavesTheBrowserYouJustBroughtForward() { XCTAssertTrue(keeps(since: 0.09)) }

    /// A switch you asked for (a key, a bar click, even for the workspace you are on) is not a re-apply.
    func testASwitchYouAskedForStillTakesFocus() { XCTAssertFalse(keeps(reapply: false)) }

    /// R-F2: an app that came forward on its own (a notification, a sign-in prompt) is put back behind your window.
    func testANonBrowserThatCameForwardOnItsOwnIsPutBack() { XCTAssertFalse(keeps(browser: false)) }

    func testAnAppPolycarpBroughtForwardIsNotKept() { XCTAssertFalse(keeps(ours: true)) }

    /// R-A1: a browser with a window on the agent workspace may have come forward by an agent's click.
    func testABrowserTheAgentMayDriveIsNotKept() { XCTAssertFalse(keeps(agents: true)) }

    /// Review r2 F1/F2: once Polycarp decided (put it away behind you, or a window you left), the re-apply that
    /// hides it again must not keep it.
    func testAnActivationAlreadyDecidedIsNotKept() { XCTAssertFalse(keeps(decided: true)) }

    func testAnAppWithAWindowHereIsFocusedHereAsBefore() { XCTAssertFalse(keeps(here: true)) }

    func testAnOldActivationNoLongerCounts() {
        XCTAssertFalse(keeps(since: FocusKeep.window))
        XCTAssertFalse(keeps(since: 5))
    }

    /// Review r2 F6: a browser Polycarp hid (not on the parked list) is unhidden by the link; the re-apply must not
    /// hide it again, or macOS hands focus back to the app you clicked in.
    func testAKeptBrowserIsNotHiddenAgain() {
        XCTAssertEqual(FocusKeep.hiddenNow([7, 8, 9], deferred: [8], kept: [9]), [7])
        XCTAssertEqual(FocusKeep.hiddenNow([7, 9], deferred: [], kept: []), [7, 9])
    }

    func testAClockThatWentBackDoesNotCount() { XCTAssertFalse(keeps(since: -0.5)) }
}
