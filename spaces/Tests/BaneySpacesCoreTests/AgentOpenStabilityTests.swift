import XCTest
@testable import BaneySpacesCore

/// 11-12: `agent open` identified 1 window of 3. Font Book's and Calculator's windows stayed drawn on Donovan's workspace,
/// because one Accessibility miss while the app was starting benched it for 5 s and a second for 30 s, past the 8 s claim.
final class AXBenchTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    /// Font Book, measured: misses at +0.58 s and +3.40 s after launch. It must be asked again well inside the 8 s claim.
    func testAnAppStillStartingIsAskedAgainWithinASecond() {
        var b = AXBench()
        let first = b.missed(7, age: 0.58, now: t0)
        XCTAssertLessThan(first, 1)
        XCTAssertTrue(b.isBenched(7, now: t0.addingTimeInterval(0.1)))
        XCTAssertFalse(b.isBenched(7, now: t0.addingTimeInterval(first + 0.01)))
        let second = b.missed(7, age: 3.40, now: t0.addingTimeInterval(2.82))
        XCTAssertLessThan(second, 1, "a second miss while starting must not bench it for 30 s")
        XCTAssertFalse(b.isBenched(7, now: t0.addingTimeInterval(2.82 + second + 0.01)))
    }

    func testAYoungAppIsNeverBenchedLongerThanItsLastStep() {
        var b = AXBench()
        for i in 0..<10 { XCTAssertLessThanOrEqual(b.missed(7, age: Double(i), now: t0), AXBench.young.last!) }
    }

    /// A hung app keeps its back-off, so one frozen app still costs a timeout rarely.
    func testAnOldAppBacksOffAsBefore() {
        var b = AXBench()
        XCTAssertEqual([5, 30, 120, 600, 600].map { _ in b.missed(9, age: 3_600, now: t0) }, [5, 30, 120, 600, 600])
        var unknown = AXBench()
        XCTAssertEqual(unknown.missed(9, age: nil, now: t0), 5)
    }

    /// Misses while starting don't count against it once it's running: its first real miss is benched 5 s, not 2 min.
    func testMissesWhileStartingDontCountTowardTheHungBackOff() {
        var b = AXBench()
        for age in [0.5, 1.0, 2.0, 4.0] { b.missed(7, age: age, now: t0) }
        XCTAssertEqual(b.missed(7, age: 20, now: t0), 5)
    }

    func testAnAnswerClearsEverything() {
        var b = AXBench()
        b.missed(9, age: 3_600, now: t0); b.missed(9, age: 3_600, now: t0)
        b.answered(9)
        XCTAssertFalse(b.isBenched(9, now: t0))
        XCTAssertEqual(b.missed(9, age: 3_600, now: t0), 5)
    }

    /// The retry timer follows the first app due back, so a young app's window isn't held behind a hung app's 5.5 s.
    func testTheRetryTimerFollowsTheFirstAppDueBack() {
        var b = AXBench()
        XCTAssertEqual(b.retryDelay(now: t0), 5.5)
        b.missed(9, age: 3_600, now: t0)
        XCTAssertEqual(b.retryDelay(now: t0), 5.05, accuracy: 0.001)
        b.missed(7, age: 0.6, now: t0)
        XCTAssertEqual(b.retryDelay(now: t0), 0.35, accuracy: 0.001)
        XCTAssertEqual(b.retryDelay(now: t0.addingTimeInterval(0.29)), 0.3, "never sooner than the floor")
    }

    func testAppsThatQuitAreForgotten() {
        var b = AXBench()
        b.missed(7, age: 0.5, now: t0); b.missed(9, age: 3_600, now: t0)
        b.keep([9])
        XCTAssertFalse(b.isBenched(7, now: t0))
        XCTAssertTrue(b.isBenched(9, now: t0))
    }
}

final class OpenMissTests: XCTestCase {
    private let start: TimeInterval = 1_000

    /// The agent's own copy drew its window on Donovan's workspace and Polycarp still can't place it: quit that copy.
    func testTheAgentsOwnCopyWithAWindowOutsideTheAgentWorkspaceIsQuit() {
        XCTAssertEqual(OpenMiss.decide(launched: 42, agentStarted: [42], startedAt: start + 0.2, requestStart: start, stray: 1), .quit(pid: 42))
    }

    /// Never kill a copy Donovan started: not in the agent-started record, or started before this request.
    func testACopyThisRequestDidntStartIsNeverQuit() {
        XCTAssertEqual(OpenMiss.decide(launched: 42, agentStarted: [], startedAt: start + 0.2, requestStart: start, stray: 1), .leave)
        XCTAssertEqual(OpenMiss.decide(launched: 42, agentStarted: [42], startedAt: start - 60, requestStart: start, stray: 1), .leave)
        XCTAssertEqual(OpenMiss.decide(launched: 42, agentStarted: [42], startedAt: nil, requestStart: start, stray: 1), .leave)
    }

    /// Nothing drawn yet, or no pid: the window may still come, and the pending open takes it.
    func testNothingDrawnWaits() {
        XCTAssertEqual(OpenMiss.decide(launched: 42, agentStarted: [42], startedAt: start + 0.2, requestStart: start, stray: 0), .wait)
        XCTAssertEqual(OpenMiss.decide(launched: nil, agentStarted: [42], startedAt: start + 0.2, requestStart: start, stray: 3), .wait)
    }
}

final class CloseReadbackTests: XCTestCase {
    private final class Clock {
        var t = Date(timeIntervalSince1970: 0)
        func sleep(_ s: TimeInterval) { t = t.addingTimeInterval(s) }
    }

    /// Measured: the window left the window server within 0.3 s, but the one look at 0.2 s said `closed: false`.
    func testAWindowThatGoesAMomentLaterReadsAsClosed() {
        let c = Clock()
        let gone = CloseReadback.gone(now: { c.t }, sleep: c.sleep) { c.t < Date(timeIntervalSince1970: 0.6) }
        XCTAssertTrue(gone)
    }

    func testAWindowThatStaysReadsAsOpenWithinTheTimeout() {
        let c = Clock()
        var looks = 0
        let gone = CloseReadback.gone(now: { c.t }, sleep: c.sleep) { looks += 1; return true }
        XCTAssertFalse(gone)
        XCTAssertLessThanOrEqual(c.t.timeIntervalSince1970, CloseReadback.timeout + CloseReadback.interval)
        XCTAssertLessThanOrEqual(looks, Int(CloseReadback.timeout / CloseReadback.interval) + 2)
    }

    func testAWindowAlreadyGoneAnswersAtOnce() {
        let c = Clock()
        XCTAssertTrue(CloseReadback.gone(now: { c.t }, sleep: c.sleep) { false })
        XCTAssertEqual(c.t.timeIntervalSince1970, 0)
    }
}

/// The app code uses the rules above (source checks: each fails with its fix reverted).
final class AgentOpenStabilitySourceTests: XCTestCase {
    func testEveryAccessibilityMissGoesThroughTheBench() throws {
        let w = try HandsSourceTests.code("Sources/BaneySpaces/Windows.swift")
        XCTAssertTrue(w.contains("bench.missed(pid, age: age, now: now)"), "the miss is recorded with the app's age")
        XCTAssertFalse(w.contains("let backoff: [TimeInterval] = [5, 30, 120, 600]"), "no fixed back-off for an app still starting")
        let s = try HandsSourceTests.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(s.contains("asyncAfter(deadline: .now() + delay, execute: work)") && s.contains("let delay = Windows.retryDelay()"),
                      "the retry timer follows the first app due back")
        XCTAssertFalse(s.contains("asyncAfter(deadline: .now() + 5.5)"))
    }

    func testAnAgentStartedProcessesFirstWindowIsAdoptedAfterTheClaimLapses() throws {
        let s = try HandsSourceTests.code("Sources/BaneySpaces/Spaces.swift")
        let adopt = try XCTUnwrap(HandsSourceTests.between("private func adoptBackgroundWindows", "func claimNextWindow", in: s))
        XCTAssertTrue(adopt.contains("if agent != nil, AgentOwned.shared.pids.contains(w.pid) { return true }"), "its first window is a candidate")
        XCTAssertTrue(adopt.contains("ClaimRule.applies(windowPid: w.pid, frontPid: front, agentStartedProcess: owned)"), "even when it came forward")
    }

    func testOpenDecidesAMissAndCloseReadsBack() throws {
        let r = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertTrue(r.contains("onMain { host.rescan() }"), "one more full look before giving up")
        XCTAssertTrue(r.contains("switch OpenMiss.decide(launched: pid, agentStarted: host.agentOwned(), startedAt: AgentOwned.startTime(pid)"))
        XCTAssertTrue(r.contains("let launched = runningPid == nil ? AgentLaunches.shared.pid(token) : nil"), "never a running copy of Donovan's")
        let c = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        XCTAssertTrue(c.contains("CloseReadback.gone {"))
        XCTAssertFalse(c.contains("let gone = onMain { host.live(w.id) } == nil"), "not one early look")
    }
}
