import XCTest
@testable import BaneySpacesCore

/// 2026-11-21: every scan asked every app with a window, on the main thread, and nearly always paid one app's 0.25 s
/// timeout. Scans now ask only the apps whose windows changed, off the main thread.
final class ScanPlanTests: XCTestCase {
    private let owners: Set<Int32> = [1, 2, 3]
    private let windows: [WindowID: Int32] = [10: 1, 11: 1, 20: 2, 30: 3]

    func testTheFirstScanAndAFullOneAskEveryApp() {
        XCTAssertEqual(ScanPlan.appsToAsk(full: false, owners: owners, now: windows, before: nil,
                                          offscreenNow: [], offscreenBefore: [], complete: owners), owners)
        XCTAssertEqual(ScanPlan.appsToAsk(full: true, owners: owners, now: windows, before: windows,
                                          offscreenNow: [], offscreenBefore: [], complete: owners), owners)
    }

    func testNothingChangedAsksNobody() {
        XCTAssertEqual(ScanPlan.appsToAsk(full: false, owners: owners, now: windows, before: windows,
                                          offscreenNow: [], offscreenBefore: [], complete: owners), [])
    }

    func testOnlyTheAppWhoseWindowsChangedIsAsked() {
        var now = windows
        now[12] = 1
        XCTAssertEqual(ScanPlan.appsToAsk(full: false, owners: owners, now: now, before: windows,
                                          offscreenNow: [], offscreenBefore: [], complete: owners), [1])
        now = windows
        now[20] = nil
        XCTAssertEqual(ScanPlan.appsToAsk(full: false, owners: owners, now: now, before: windows,
                                          offscreenNow: [], offscreenBefore: [], complete: owners), [2])
    }

    /// An app that didn't answer, or answered in part, is asked again: its windows are never taken as closed on an
    /// answer it didn't give.
    func testAnAppWithoutAWholeAnswerIsAskedAgain() {
        XCTAssertEqual(ScanPlan.appsToAsk(full: false, owners: owners, now: windows, before: windows,
                                          offscreenNow: [], offscreenBefore: [], complete: [1, 2]), [3])
    }

    func testAWindowLeavingTheScreenAsksItsApp() {
        XCTAssertEqual(ScanPlan.appsToAsk(full: false, owners: owners, now: windows, before: windows,
                                          offscreenNow: [20], offscreenBefore: [], complete: owners), [2])
        XCTAssertEqual(ScanPlan.appsToAsk(full: false, owners: owners, now: windows, before: windows,
                                          offscreenNow: [], offscreenBefore: [30], complete: owners), [3])
    }

    func testAskedAppsAreAskedButOnlyIfTheyOwnAWindow() {
        XCTAssertEqual(ScanPlan.appsToAsk(full: false, owners: owners, now: windows, before: windows,
                                          offscreenNow: [], offscreenBefore: [], complete: owners, extra: [3, 9]), [3])
    }

    func testAnAppThatQuitIsNotAsked() {
        var now = windows
        now[30] = nil
        XCTAssertEqual(ScanPlan.appsToAsk(full: false, owners: [1, 2], now: now, before: windows,
                                          offscreenNow: [], offscreenBefore: [], complete: [1, 2]), [])
    }

    func testReasonsNameWhatChanged() {
        XCTAssertEqual(ScanPlan.reason(pidsChanged: true, added: 1, removed: 0, offscreenChanged: true, asked: true), "apps")
        XCTAssertEqual(ScanPlan.reason(pidsChanged: false, added: 2, removed: 1, offscreenChanged: true, asked: false), "windows+2-1")
        XCTAssertEqual(ScanPlan.reason(pidsChanged: false, added: 0, removed: 0, offscreenChanged: true, asked: false), "offscreen")
        XCTAssertEqual(ScanPlan.reason(pidsChanged: false, added: 0, removed: 0, offscreenChanged: false, asked: true), "asked")
        XCTAssertEqual(ScanPlan.reason(pidsChanged: false, added: 0, removed: 0, offscreenChanged: false, asked: false), "unplaced")
    }
}

final class ScanRequestsTests: XCTestCase {
    func testRequestsWaitingTogetherMerge() {
        var r = ScanRequests<String>()
        r.request(full: false, pids: [1])
        r.request(full: true, pids: [2], waiter: "a")
        r.request(full: false, pids: [3], waiter: "b")
        let s = r.start()
        XCTAssertEqual(s?.ask, .init(full: true, pids: [1, 2, 3]))
        XCTAssertEqual(r.landed(s!.ticket), ["a", "b"])
        XCTAssertNil(r.start())
    }

    func testOneScanRunsAtATime() {
        var r = ScanRequests<String>()
        r.request(full: false)
        let first = r.start()!
        r.request(full: false, pids: [4], waiter: "late")
        XCTAssertNil(r.start(), "a second scan started while one ran")
        XCTAssertEqual(r.landed(first.ticket), [], "a waiter that asked after the scan started ran on its old answer")
        let second = r.start()!
        XCTAssertEqual(second.ask.pids, [4])
        XCTAssertEqual(r.landed(second.ticket), ["late"])
    }

    func testAStaleTicketAnswersNobody() {
        var r = ScanRequests<String>()
        r.request(full: false, waiter: "a")
        let s = r.start()!
        XCTAssertEqual(r.landed(s.ticket + 1), [])
        XCTAssertEqual(r.landed(s.ticket), ["a"])
        XCTAssertEqual(r.landed(s.ticket), [])
    }

    /// Mid-switch a scan nobody waits on would be thrown away; one the switch waits on starts.
    func testMidSwitchOnlyAWaitedScanStarts() {
        var r = ScanRequests<String>()
        r.request(full: false, pids: [1])
        XCTAssertNil(r.start(onlyIfWaitedOn: true))
        XCTAssertFalse(r.pendingIsWaitedOn)
        r.request(full: false, waiter: "switch")
        XCTAssertTrue(r.pendingIsWaitedOn)
        let s = r.start(onlyIfWaitedOn: true)
        XCTAssertEqual(s?.ask.pids, [1])
        XCTAssertEqual(r.landed(s!.ticket), ["switch"])
    }

    /// A switch that arrives while a scan of the same window list runs waits on that scan, not the next.
    func testAWaiterCanJoinTheRunningScan() {
        var r = ScanRequests<String>()
        XCTAssertFalse(r.join("nothing runs"))
        r.request(full: false, waiter: "a")
        let s = r.start()!
        XCTAssertTrue(r.join("switch"))
        XCTAssertEqual(r.landed(s.ticket), ["a", "switch"])
    }

    func testResetDropsEveryWaiter() {
        var r = ScanRequests<String>()
        r.request(full: false, waiter: "a")
        _ = r.start()
        r.request(full: false, waiter: "b")
        XCTAssertEqual(r.reset(), ["a", "b"])
        XCTAssertNil(r.inFlight)
        XCTAssertNil(r.pending)
    }
}
