import XCTest
@testable import BaneySpacesCore

/// 11-12: every agent launch drew its first window at the app's default frame for about 60 ms on Donovan's screen
/// before it was parked. A copy an agent starts launches hidden and is shown only once nothing of it would show out of place.
final class HiddenLaunchTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)
    private let parked = HiddenLaunches.Placed(workspaceShown: false, atHidingSpot: true)
    private let inSight = HiddenLaunches.Placed(workspaceShown: true, atHidingSpot: false)
    private let notYetParked = HiddenLaunches.Placed(workspaceShown: false, atHidingSpot: false)

    /// Placed on the agent workspace, out of sight, but not parked yet: showing it now is the flash.
    func testACopyWhoseWindowIsntParkedYetStaysHidden() {
        var h = HiddenLaunches()
        h.launched(42, at: t0)
        XCTAssertTrue(h.release(now: t0.addingTimeInterval(0.2)) { _ in [self.notYetParked] }.isEmpty)
        XCTAssertTrue(h.release(now: t0.addingTimeInterval(0.2)) { _ in [] }.isEmpty, "nothing placed yet")
        XCTAssertTrue(h.release(now: t0.addingTimeInterval(0.2)) { _ in [self.parked, self.notYetParked] }.isEmpty, "every window, not the first")
    }

    func testACopyIsShownOnceEveryWindowIsParkedOrInSight() {
        var h = HiddenLaunches()
        h.launched(42, at: t0)
        let r = h.release(now: t0.addingTimeInterval(0.3)) { _ in [self.parked, self.inSight] }
        XCTAssertEqual(r.map(\.pid), [42]); XCTAssertEqual(r.map(\.why), [.placed])
        XCTAssertTrue(h.isEmpty, "shown once, then forgotten")
        XCTAssertTrue(h.release(now: t0.addingTimeInterval(0.4)) { _ in [self.parked] }.isEmpty)
    }

    /// A window that never got placed: the copy is shown anyway once the claim is over, never left hidden for good.
    func testACopyNeverStaysHiddenPastTheClaim() {
        var h = HiddenLaunches()
        h.launched(42, at: t0)
        XCTAssertTrue(h.release(now: t0.addingTimeInterval(8)) { _ in [] }.isEmpty)
        let r = h.release(now: t0.addingTimeInterval(HiddenLaunches.limit)) { _ in [] }
        XCTAssertEqual(r.map(\.why), [.lapsed])
        XCTAssertGreaterThan(HiddenLaunches.limit, 8, "past the 8 s claim, so a late placement still parks it first")
    }

    func testEachCopyIsReleasedOnItsOwn() {
        var h = HiddenLaunches()
        h.launched(1, at: t0); h.launched(2, at: t0)
        let r = h.release(now: t0.addingTimeInterval(0.5)) { $0 == 1 ? [self.parked] : [self.notYetParked] }
        XCTAssertEqual(r.map(\.pid), [1])
        XCTAssertFalse(h.isEmpty)
    }

    /// A launch macOS ran inside a copy already running (Donovan's) hid that copy: it is shown again, unless he had hidden it.
    func testALaunchThatHidDonovansCopyShowsItAgain() {
        XCTAssertTrue(HiddenLaunches.undo(hiddenNow: true, hiddenBefore: false))
        XCTAssertFalse(HiddenLaunches.undo(hiddenNow: true, hiddenBefore: true))
        XCTAssertFalse(HiddenLaunches.undo(hiddenNow: false, hiddenBefore: false))
    }
}

/// The app wiring (source checks: each fails with its line reverted).
final class HiddenLaunchSourceTests: XCTestCase {
    func testOnlyANewAgentCopyLaunchesHiddenAndIsShownAfterPlacement() throws {
        let c = try HandsSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        let hides = try XCTUnwrap(c.range(of: "cfg.hides = true"))
        let newCopy = try XCTUnwrap(c.range(of: "cfg.createsNewApplicationInstance = true"))
        let running = try XCTUnwrap(c.range(of: "if !separate, let running = NSWorkspace.shared.runningApplications.first"))
        XCTAssertLessThan(newCopy.lowerBound, hides.lowerBound, "set only on the new-copy path")
        XCTAssertLessThan(running.upperBound, hides.lowerBound, "never on the path that opens files in Donovan's running copy")
        XCTAssertTrue(c.contains("h.launchedHidden(app.processIdentifier)\n                adoptAgentStartedProcess"), "Spaces is told the new copy is hidden")
        XCTAssertTrue(c.contains("HiddenLaunches.undo(hiddenNow: app.isHidden, hiddenBefore: hiddenBefore.contains(app.processIdentifier))"))
        let a = try HandsSourceTests.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(a.contains("h.launchedHidden = { [weak self] pid in self?.spaces.launchedHidden(pid) }"))
        let s = try HandsSourceTests.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(s.contains("placedBefore.formUnion(model.home.keys)\n        releaseHiddenLaunches()"), "looked at after each scan")
        XCTAssertTrue(s.contains("switching = false\n        releaseHiddenLaunches()"), "and after each switch, which parks")
        XCTAssertTrue(s.contains("asyncAfter(deadline: .now() + HiddenLaunches.limit + 0.05)"), "and once the time is up")
        XCTAssertTrue(s.contains("guard !saved.hiddenApps.contains(pid)"), "a copy Spaces hid itself stays hidden")
    }
}
