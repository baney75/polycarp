import XCTest
@testable import BaneySpacesCore

/// 11-12: `agent open` identified 1 window of 3. Font Book's and Calculator's windows stayed drawn on Donovan's workspace,
/// because one Accessibility miss while the app was starting benched it for 5 s and a second for 30 s, past the 8 s claim.
final class AXBenchTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    /// Font Book, measured: misses at +0.58 s and +3.40 s after launch. It must be asked again well inside the 8 s claim.
    func testAnAppStillStartingIsAskedAgainWithinASecond() {
        var b = AXBench()
        let first = b.missed(7, age: 0.58, waitedOn: true, now: t0)
        XCTAssertLessThan(first, 1)
        XCTAssertTrue(b.isBenched(7, now: t0.addingTimeInterval(0.1)))
        XCTAssertFalse(b.isBenched(7, now: t0.addingTimeInterval(first + 0.01)))
        let second = b.missed(7, age: 3.40, waitedOn: true, now: t0.addingTimeInterval(2.82))
        XCTAssertLessThan(second, 1, "a second miss while starting must not bench it for 30 s")
        XCTAssertFalse(b.isBenched(7, now: t0.addingTimeInterval(2.82 + second + 0.01)))
    }

    func testAYoungAppIsNeverBenchedLongerThanItsLastStep() {
        var b = AXBench()
        for i in 0..<10 { XCTAssertLessThanOrEqual(b.missed(7, age: Double(i), waitedOn: true, now: t0), AXBench.young.last!) }
    }

    /// A hung app keeps its back-off, so one frozen app still costs a timeout rarely.
    func testAnOldAppBacksOffAsBefore() {
        var b = AXBench()
        XCTAssertEqual([5, 30, 120, 600, 600].map { _ in b.missed(9, age: 3_600, waitedOn: true, now: t0) }, [5, 30, 120, 600, 600])
        var unknown = AXBench()
        XCTAssertEqual(unknown.missed(9, age: nil, waitedOn: true, now: t0), 5)
    }

    /// Misses while starting don't count against it once it's running: its first real miss is benched 5 s, not 2 min.
    func testMissesWhileStartingDontCountTowardTheHungBackOff() {
        var b = AXBench()
        for age in [0.5, 1.0, 2.0, 4.0] { b.missed(7, age: age, waitedOn: true, now: t0) }
        XCTAssertEqual(b.missed(7, age: 20, waitedOn: true, now: t0), 5)
    }

    func testAnAnswerClearsEverything() {
        var b = AXBench()
        b.missed(9, age: 3_600, waitedOn: true, now: t0); b.missed(9, age: 3_600, waitedOn: true, now: t0)
        b.answered(9)
        XCTAssertFalse(b.isBenched(9, now: t0))
        XCTAssertEqual(b.missed(9, age: 3_600, waitedOn: true, now: t0), 5)
    }

    /// The retry timer follows the first app due back, so a young app's window isn't held behind a hung app's 5.5 s.
    func testTheRetryTimerFollowsTheFirstAppDueBack() {
        var b = AXBench()
        XCTAssertEqual(b.retryDelay(now: t0), 5.5)
        b.missed(9, age: 3_600, waitedOn: true, now: t0)
        XCTAssertEqual(b.retryDelay(now: t0), 5.05, accuracy: 0.001)
        b.missed(7, age: 0.6, waitedOn: true, now: t0)
        XCTAssertEqual(b.retryDelay(now: t0), 0.35, accuracy: 0.001)
        XCTAssertEqual(b.retryDelay(now: t0.addingTimeInterval(0.29)), 0.3, "never sooner than the floor")
    }

    /// Review 157 F8: an app nobody waits on that hangs as it launches keeps the hung back-off, so it can't cost a
    /// timeout every 0.3 s on each switch for its first 15 s.
    func testAYoungAppNobodyWaitsOnBacksOffLikeAHungOne() {
        var b = AXBench()
        XCTAssertEqual([0.5, 1, 2].map { b.missed(7, age: $0, waitedOn: false, now: t0) }, [5, 30, 120])
    }

    /// After a wake every app is asked again: misses while the Mac slept don't bench anything.
    func testClearAsksEveryAppAgain() {
        var b = AXBench()
        for _ in 0..<4 { b.missed(9, age: 3_600, waitedOn: true, now: t0) }
        b.missed(7, age: 1, waitedOn: true, now: t0)
        b.clear()
        XCTAssertFalse(b.isBenched(9, now: t0))
        XCTAssertFalse(b.isBenched(7, now: t0))
        XCTAssertEqual(b.missed(9, age: 3_600, waitedOn: true, now: t0), 5, "the hung back-off starts over")
    }

    func testAppsThatQuitAreForgotten() {
        var b = AXBench()
        b.missed(7, age: 0.5, waitedOn: true, now: t0); b.missed(9, age: 3_600, waitedOn: true, now: t0)
        b.keep([9])
        XCTAssertFalse(b.isBenched(7, now: t0))
        XCTAssertTrue(b.isBenched(9, now: t0))
    }
}

final class OpenMissTests: XCTestCase {
    private let start: TimeInterval = 1_000

    /// The agent's own copy drew its window on Donovan's workspace and Polycarp still can't place it: quit that copy.
    func testTheAgentsOwnCopyWithNothingOnTheAgentWorkspaceIsQuit() {
        XCTAssertEqual(OpenMiss.decide(launched: 42, agentStarted: [42], startedAt: start + 0.2, requestStart: start, held: 0), .quit(pid: 42))
    }

    /// 11-12, PR 172: a copy launched hidden drew nothing, the check waited, and its window then showed unplaced on
    /// Donovan's screen. Placing failed is enough: whether its window is drawn yet doesn't matter.
    func testACopyWhoseWindowIsntDrawnYetIsQuitToo() {
        XCTAssertEqual(OpenMiss.decide(launched: 42, agentStarted: [42], startedAt: start + 0.2, requestStart: start, held: 0), .quit(pid: 42),
                       "nothing drawn is no reason to leave an unplaced copy running")
    }

    /// Never kill a copy Donovan started: not in the agent-started record, or started before this request.
    func testACopyThisRequestDidntStartIsNeverQuit() {
        XCTAssertEqual(OpenMiss.decide(launched: 42, agentStarted: [], startedAt: start + 0.2, requestStart: start, held: 0), .leave)
        XCTAssertEqual(OpenMiss.decide(launched: 42, agentStarted: [42], startedAt: start - 60, requestStart: start, held: 0), .leave)
        XCTAssertEqual(OpenMiss.decide(launched: 42, agentStarted: [42], startedAt: nil, requestStart: start, held: 0), .leave)
    }

    /// No pid for the launch: nothing of it can be told from anyone else's.
    func testNoPidWaits() {
        XCTAssertEqual(OpenMiss.decide(launched: nil, agentStarted: [42], startedAt: start + 0.2, requestStart: start, held: 0), .wait)
    }
}

extension OpenMissTests {
    /// Review 157 F3: the app's window is on the agent workspace and a sheet or panel of it is drawn elsewhere. The app is
    /// placed; quitting it would lose the agent's window.
    func testAPlacedAppIsNeverQuit() {
        XCTAssertEqual(OpenMiss.decide(launched: 42, agentStarted: [42], startedAt: start + 0.2, requestStart: start, held: 1), .placed)
    }

    /// F3: a clear or tiny window (a status item, a helper's 1 x 1) isn't one a person sees.
    func testOnlyAWindowAPersonCanSeeCounts() {
        XCTAssertTrue(OpenMiss.visible(alpha: 1, bounds: CGRect(x: 0, y: 0, width: 400, height: 300)))
        XCTAssertFalse(OpenMiss.visible(alpha: 0, bounds: CGRect(x: 0, y: 0, width: 400, height: 300)))
        XCTAssertFalse(OpenMiss.visible(alpha: 1, bounds: CGRect(x: 0, y: 0, width: 1, height: 1)))
        XCTAssertFalse(OpenMiss.visible(alpha: 1, bounds: CGRect(x: 0, y: 0, width: 400, height: 22)))
    }

    /// A caller that waited the full claim off main gets the check in its answer.
    func testAFullWaitOffMainChecksNow() {
        XCTAssertEqual(OpenMiss.check(wait: 7, mainThread: false, elapsed: 7.1), .now)
        XCTAssertEqual(OpenMiss.check(wait: 20, mainThread: false, elapsed: 7.1), .now)
    }

    /// Review 163 second-F5: `open --wait 2` (or 0, or any open on the main thread) skipped the check, so nothing ever
    /// quit a copy whose window stayed on Donovan's screen. It still runs, once the claim has passed, never sooner (157 F2).
    func testAShortWaitOrTheMainThreadStillGetsTheCheckOnceTheClaimHasPassed() {
        XCTAssertEqual(OpenMiss.check(wait: 2, mainThread: false, elapsed: 2.1), .after(OpenMiss.claimWait - 2.1))
        XCTAssertEqual(OpenMiss.check(wait: 0, mainThread: false, elapsed: 0.2), .after(OpenMiss.claimWait - 0.2))
        XCTAssertEqual(OpenMiss.check(wait: 20, mainThread: true, elapsed: 0.3), .after(OpenMiss.claimWait - 0.3))
        XCTAssertEqual(OpenMiss.check(wait: 2, mainThread: true, elapsed: 9), .after(0), "never a negative delay")
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
        let gone = CloseReadback.gone(now: { c.t }, sleep: c.sleep, listed: { c.t < Date(timeIntervalSince1970: 0.6) }, inModel: { true })
        XCTAssertTrue(gone)
    }

    func testAWindowThatStaysReadsAsOpenWithinTheTimeout() {
        let c = Clock()
        var looks = 0
        var modelLooks = 0
        let gone = CloseReadback.gone(now: { c.t }, sleep: c.sleep, listed: { looks += 1; return true }, inModel: { modelLooks += 1; return true })
        XCTAssertFalse(gone)
        XCTAssertEqual(modelLooks, 1, "one model look at the timeout, not one per tick")
        XCTAssertLessThanOrEqual(c.t.timeIntervalSince1970, CloseReadback.timeout + CloseReadback.interval)
        XCTAssertLessThanOrEqual(looks, Int(CloseReadback.timeout / CloseReadback.interval) + 2)
    }

    func testAWindowAlreadyGoneAnswersAtOnce() {
        let c = Clock()
        var modelLooks = 0
        XCTAssertTrue(CloseReadback.gone(now: { c.t }, sleep: c.sleep, listed: { false }, inModel: { modelLooks += 1; return true }))
        XCTAssertEqual(c.t.timeIntervalSince1970, 0)
        XCTAssertEqual(modelLooks, 0, "the window server's answer is enough")
    }

    /// An app that closes a window but keeps it alive stays listed by the window server: the model decides at the timeout.
    func testAWindowTheAppKeptAliveReadsAsClosedFromTheModel() {
        let c = Clock()
        XCTAssertTrue(CloseReadback.gone(now: { c.t }, sleep: c.sleep, listed: { true }, inModel: { false }))
    }

    /// Review 157 F9: on the main thread it looks once and never sleeps (a 2 s poll there would hold up every switch).
    func testOnTheMainThreadItLooksOnceAndNeverSleeps() {
        let c = Clock()
        var looks = 0
        XCTAssertFalse(CloseReadback.gone(mainThread: true, now: { c.t }, sleep: c.sleep, listed: { looks += 1; return true }, inModel: { true }))
        XCTAssertEqual(looks, 1)
        XCTAssertEqual(c.t.timeIntervalSince1970, 0)
        XCTAssertTrue(CloseReadback.gone(mainThread: true, now: { c.t }, sleep: c.sleep, listed: { false }, inModel: { true }))
    }
}

/// The app code uses the rules above (source checks: each fails with its fix reverted).
final class AgentOpenStabilitySourceTests: XCTestCase {
    func testEveryAccessibilityMissGoesThroughTheBench() throws {
        let w = try HandsSourceTests.code("Sources/BaneySpaces/Windows.swift")
        XCTAssertTrue(w.contains("bench.missed(pid, age: age, waitedOn: waitedOn, now: now)"), "the miss is recorded with the app's age")
        XCTAssertTrue(w.contains("let waitedOn = AgentOwned.shared.pids.contains(pid)"), "only an agent's launch gets the young schedule (F8)")
        XCTAssertFalse(w.contains("let backoff: [TimeInterval] = [5, 30, 120, 600]"), "no fixed back-off for an app still starting")
        let s = try HandsSourceTests.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(s.contains("asyncAfter(deadline: .now() + delay, execute: work)") && s.contains("let delay = Windows.retryDelay()"),
                      "the retry timer follows the first app due back")
        XCTAssertFalse(s.contains("asyncAfter(deadline: .now() + 5.5)"))
        XCTAssertTrue(s.contains("Windows.keepBench(pidsNow)"), "apps that quit leave the bench (F7)")
    }

    func testAnAgentStartedProcessesFirstWindowIsAdoptedAfterTheClaimLapses() throws {
        let s = try HandsSourceTests.code("Sources/BaneySpaces/Spaces.swift")
        let adopt = try XCTUnwrap(HandsSourceTests.between("private func adoptBackgroundWindows", "func claimNextWindow", in: s))
        XCTAssertTrue(adopt.contains("if agent != nil, AgentOwned.shared.pids.contains(w.pid) { return true }"), "its first window is a candidate")
        XCTAssertTrue(adopt.contains("ClaimRule.applies(windowPid: w.pid, frontPid: front, agentStartedProcess: owned)"), "even when it came forward")
    }

    func testOpenDecidesAMissAndCloseReadsBack() throws {
        let r = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let miss = try XCTUnwrap(HandsSourceTests.block(after: "private func missCheck(", in: r))
        XCTAssertTrue(miss.contains("Windows.markResponsive(pid)\n        onMain { host.rescan() }"), "the bench is cleared before the extra look (157 F1)")
        XCTAssertTrue(miss.contains("let owned = onMain { host.agentOwned() }"), "the host is read on main (F4)")
        XCTAssertTrue(miss.contains("switch OpenMiss.decide(launched: pid, agentStarted: owned, startedAt: AgentOwned.startTime(pid)"))
        XCTAssertTrue(miss.contains("held: held.count)"), "a placed app is never quit (F3)")
        XCTAssertTrue(r.contains("switch OpenMiss.check(wait: wait, mainThread: Thread.isMainThread, elapsed: Date().timeIntervalSince(requestStart))"),
                      "every miss is checked, whatever the wait or thread (163 second-F5)")
        XCTAssertTrue(r.contains("DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay) { [self] in\n                    _ = missCheck("),
                      "a short wait's check runs later, off main")
        XCTAssertFalse(r.contains("OpenMiss.looksAgain("), "no wait-length guard that drops the check")
        XCTAssertTrue(r.contains("CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID)") && !r.contains("static func drawnWindows"),
                      "a hidden copy's windows are listed too: the on-screen list leaves them out (PR 172)")
        XCTAssertTrue(r.contains("OpenMiss.visible(alpha:"), "only windows a person can see count (F3)")
        let raw = try String(contentsOf: HandsSourceTests.root.appendingPathComponent("Sources/BaneySpaces/Hands/HandsRouter.swift"), encoding: .utf8)
        XCTAssertTrue(raw.contains("/// Whether every running copy of the app was already running before the launch.\n    private func noNewProcess"),
                      "the doc comment sits on its function (F6)")
        XCTAssertTrue(r.contains("let launched = runningPid == nil ? AgentLaunches.shared.pid(token) : nil"), "never a running copy of Donovan's")
        let c = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        XCTAssertTrue(c.contains("CloseReadback.gone(mainThread: Thread.isMainThread, listed: { Self.serverLists(w.id) }"),
                      "read back from the window server, not a scan on main per tick (F9)")
        XCTAssertFalse(c.contains("let gone = onMain { host.live(w.id) } == nil"), "not one early look")
    }

    /// Review 163 second-F6: a miss before the pid joined `AgentOwned` took the hung back-off (5 s, then 30 s, past the
    /// claim). Recording the pid clears its bench, so it is asked again at once and later misses take the young schedule.
    func testAnAgentsPidIsAskedAgainOnceItIsRecorded() throws {
        let c = try HandsSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        let adopt = try XCTUnwrap(HandsSourceTests.block(after: "func adoptAgentStartedProcess(", in: c))
        let added = try XCTUnwrap(adopt.range(of: "AgentOwned.shared.add(pid)")), cleared = try XCTUnwrap(adopt.range(of: "Windows.markResponsive(pid)"))
        XCTAssertLessThan(added.lowerBound, cleared.lowerBound, "cleared after the record, outside its lock")
        var b = AXBench()
        let t0 = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(b.missed(7, age: 0.58, waitedOn: false, now: t0), 5, "before the record: the hung step")
        b.answered(7)
        XCTAssertFalse(b.isBenched(7, now: t0.addingTimeInterval(0.6)))
        XCTAssertLessThan(b.missed(7, age: 3.4, waitedOn: true, now: t0.addingTimeInterval(3)), 1, "after it: the young schedule")
    }

    /// Review 163 first-F1: `AgentOwned.pids` is read from `concurrentPerform` workers. Every touch of its set holds the
    /// lock, and `pids` filters a copy taken under it (the kernel's start-time lookup is safe from any thread).
    func testAgentOwnedTouchesItsSetOnlyUnderItsLock() throws {
        let c = try HandsSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        let owned = try XCTUnwrap(HandsSourceTests.between("final class AgentOwned {", "final class SessionController {", in: c))
        XCTAssertTrue(owned.contains("private let lock = NSLock()") && owned.contains("private var set = AgentOwnedSet()"))
        let touches = owned.components(separatedBy: "\n").filter { $0.contains("set.") || $0.contains("= set") }
        XCTAssertEqual(touches.count, 3, "add, remove and the copy in pids")
        for line in touches { XCTAssertTrue(line.contains("lock.lock()") && line.contains("lock.unlock()"), line) }
    }

    func testWakeAsksEveryAppAgainAndReappliesTheWorkspace() throws {
        let d = try HandsSourceTests.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(d.contains("NSWorkspace.didWakeNotification") && d.contains("self.spaces.didWake()"))
        let s = try HandsSourceTests.code("Sources/BaneySpaces/Spaces.swift")
        let wake = try XCTUnwrap(HandsSourceTests.block(after: "func didWake()", in: s))
        XCTAssertTrue(wake.contains("Windows.clearBench()") && wake.contains("refresh(full: true)") && wake.contains("screensChanged()"))
    }
}
