import XCTest
@testable import BaneySpacesCore

/// Donovan, 2026-11-10: an agent told him "Polycarp refused access because Word is in front or was used within the last
/// 30 seconds. Please switch to this chat, leave Word idle for 30 seconds, and tell me when it is ready." Agents work in the
/// background without him babysitting them: reads never wait, the quiet time is 5 s, actions wait on their own, and an
/// accessibility action on a background window of the app may go ahead.
final class InUseTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let busy: [InUseState] = [.front, .recent(leftAgo: 2, freeIn: 3)]

    func win(_ ws: Int?, pid: Int32 = 100, app: String = "Word") -> HandsWindow {
        HandsWindow(id: 7, pid: pid, app: app, bundle: "com.microsoft.Word", title: "Doc", workspace: ws)
    }

    // MARK: rule 1: reads

    func testReadsNeverWaitWhileTheAppIsInUseInAnyScope() {
        let lent: LendBook = { var b = LendBook(); b.lend(app: "Word", bundle: "com.microsoft.Word", pid: 100, windows: [7], session: "s", now: now, for: 600); return b }()
        let scopes: [(String, ScopeDecision, Bool)] = [
            ("agent workspace", ScopeGuard.check(win(9), agentWorkspace: 9, lends: LendBook(), now: now), true),
            ("lent", ScopeGuard.check(win(2), agentWorkspace: 9, lends: lent, now: now), false),
            ("full access", ScopeGuard.check(win(2), agentWorkspace: 9, lends: LendBook(), now: now, mode: .full), false),
        ]
        XCTAssertEqual(scopes.map(\.1), [.onAgentWorkspace, .lent, .fullAccess], "the app in use leaves every scope as it was")
        for (name, _, onAgent) in scopes {
            for verb in InUseRule.reads {
                for state in busy {
                    for focused in [true, false, nil] as [Bool?] {
                        XCTAssertEqual(InUseRule.decide(verb: verb, state: state, onAgentWorkspace: onAgent, isFocusedWindow: focused, isMainWindow: focused, delivery: .posted),
                                       .proceed, "\(verb) in \(name) while \(state)")
                    }
                }
            }
        }
        XCTAssertEqual(InUseRule.reads, ["windows", "snapshot", "find", "get", "shot"])
    }

    /// The scope rule no longer knows about in use at all, and the router doesn't hand it in.
    func testScopeTakesNoInUse() throws {
        let scope = try HandsSourceTests.code("Sources/BaneySpacesCore/Hands/Scope.swift")
        XCTAssertFalse(scope.contains("inUse"), "ScopeGuard must not refuse for in use (reads ignore it)")
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let decide = try XCTUnwrap(HandsSourceTests.block(after: "func decide(_ w: HandsWindow, _ agent: Int?)", in: router))
        XCTAssertFalse(decide.contains("UserActivity"), "decide is the scope for reads and actions alike")
    }

    func testWindowsListsAWindowInUseAndSaysSo() {
        let free = HandsWindowList.entry(win(9), scope: .onAgentWorkspace, inUse: .free)
        XCTAssertNil(free["in_use"])
        XCTAssertNil(free["in_use_note"])
        let front = HandsWindowList.entry(win(9), scope: .onAgentWorkspace, inUse: .front)
        XCTAssertEqual(front["in_use"]?.bool, true)
        XCTAssertEqual(front["scope"]?.string, "agent_workspace")
        XCTAssertEqual(front["id"]?.int, 7)
        let note = try? XCTUnwrap(front["in_use_note"]?.string)
        XCTAssertTrue(note?.hasPrefix("Word is in front.") == true, note ?? "")
        XCTAssertTrue(note?.contains("Reads work now") == true)
        let recent = HandsWindowList.entry(win(2), scope: .lent, inUse: .recent(leftAgo: 1.2, freeIn: 3.8))
        XCTAssertEqual(recent["in_use"]?.bool, true)
        XCTAssertTrue(recent["in_use_note"]?.string?.hasPrefix("Word left the front 1 s ago; free in 4 s.") == true)
    }

    func testTheRouterListsWindowsInUseWithTheMark() throws {
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let windows = try XCTUnwrap(HandsSourceTests.block(after: "private func windows() -> HandsEnvelope", in: router))
        XCTAssertTrue(windows.contains("HandsWindowList.entry(w, scope: u.scope, inUse: UserActivity.shared.state(w.pid))"))
    }

    // MARK: rule 2: quiet time

    func testQuietIsFiveSecondsAtTheBoundaries() {
        XCTAssertEqual(UserUse.quiet, 5)
        var u = UserUse()
        let t = now
        u.activated(1, now: t)
        XCTAssertEqual(u.state(1, frontNow: 1, now: t), .front)
        u.activated(2, now: t)
        XCTAssertEqual(u.state(1, frontNow: 2, now: t.addingTimeInterval(4.5)), .recent(leftAgo: 4.5, freeIn: 0.5))
        XCTAssertEqual(u.state(1, frontNow: 2, now: t.addingTimeInterval(4.9)).describe("Word"), "Word left the front 4 s ago; free in 1 s")
        XCTAssertTrue(u.inUse(1, frontNow: 2, now: t.addingTimeInterval(4.999)))
        XCTAssertEqual(u.state(1, frontNow: 2, now: t.addingTimeInterval(5)), .free, "free at 5 s exactly")
        XCTAssertFalse(u.inUse(1, frontNow: 2, now: t.addingTimeInterval(6)))
    }

    func testTheMessageIsExact() {
        XCTAssertEqual(InUseState.front.describe("Word"), "Word is in front")
        XCTAssertEqual(InUseState.recent(leftAgo: 2.7, freeIn: 2.3).describe("Word"), "Word left the front 2 s ago; free in 3 s")
        XCTAssertEqual(InUseState.recent(leftAgo: 4.95, freeIn: 0.05).describe("Word"), "Word left the front 4 s ago; free in 1 s")
        XCTAssertNil(InUseState.free.describe("Word"))
    }

    /// No user-visible text of the hands still says 30 seconds for in use.
    func testNoTextStillSaysThirtySeconds() throws {
        for f in ["Sources/BaneySpacesCore/Hands/AccessMode.swift", "Sources/BaneySpacesCore/Hands/BackgroundInput.swift",
                  "Sources/BaneySpacesCore/Hands/Scope.swift", "Sources/BaneySpacesCore/Hands/Envelope.swift",
                  "Sources/BaneySpaces/Hands/HandsRouter.swift", "Sources/BaneySpaces/Session/SessionController.swift"] {
            let text = try String(contentsOf: HandsSourceTests.root.appendingPathComponent(f), encoding: .utf8)
            for old in ["last 30 s", "for 30 seconds", "wait 30 seconds", "in the last 30 seconds"] {
                XCTAssertFalse(text.contains(old), "\(f) still says \(old)")
            }
        }
    }

    // MARK: rule 3: actions wait

    final class Clock {
        var t = Date(timeIntervalSince1970: 0)
        var sleeps: [TimeInterval] = []
        func now() -> Date { t }
        func sleep(_ s: TimeInterval) { sleeps.append(s); t = t.addingTimeInterval(s) }
    }

    func testAWaitProceedsWhenTheAppFreesWithinTheBound() {
        let c = Clock()
        var looks = 0
        let out = InUseWait.run(bound: 20, now: c.now, sleep: c.sleep) {
            looks += 1
            return looks < 4 ? .busy(.recent(leftAgo: 4, freeIn: 1)) : .ready
        }
        XCTAssertEqual(out, .ready(waited: 0.75))
        XCTAssertEqual(c.sleeps, [0.25, 0.25, 0.25], "looks again every 250 ms, never faster")
    }

    func testAWaitTimesOutWithTheExactMessage() {
        let c = Clock()
        let out = InUseWait.run(bound: 20, now: c.now, sleep: c.sleep) { .busy(.recent(leftAgo: 2, freeIn: 3)) }
        guard case .timedOut(let state, let waited) = out else { return XCTFail("\(out)") }
        XCTAssertEqual(waited, 20, accuracy: 0.001)
        XCTAssertEqual(c.sleeps.count, 80)
        XCTAssertTrue(c.sleeps.allSatisfy { $0 == 0.25 })
        let e = InUseWait.refusal(app: "Word", state: state, waited: waited)
        XCTAssertEqual(e.code, .inUse)
        XCTAssertEqual(e.message, "Word left the front 2 s ago; free in 3 s")
        XCTAssertEqual(e.retry, .safe)
        XCTAssertTrue(e.suggestion.contains("Polycarp waited 20 s."))
        XCTAssertTrue(e.suggestion.contains("Retry later"))
        XCTAssertTrue(e.suggestion.contains("work on another window"))
        XCTAssertTrue(e.suggestion.contains("Do not ask Donovan to switch away from Word unless he asked for this result right now."))
        XCTAssertEqual(InUseWait.refusal(app: "Word", state: .front, waited: 20).message, "Word is in front")
    }

    func testWaitZeroFailsAtOnce() {
        let c = Clock()
        var looks = 0
        let out = InUseWait.run(bound: InUseRule.bound(0), now: c.now, sleep: c.sleep) { looks += 1; return .busy(.front) }
        XCTAssertEqual(out, .timedOut(.front, waited: 0))
        XCTAssertEqual(looks, 1)
        XCTAssertEqual(c.sleeps, [])
        XCTAssertTrue(InUseWait.refusal(app: "Word", state: .front, waited: 0).suggestion.hasPrefix("Polycarp did not wait (wait was 0)."))
    }

    func testTheBoundIsTwentySecondsByDefaultAndAtMostTwoMinutes() {
        XCTAssertEqual(InUseRule.bound(nil), 20)
        XCTAssertEqual(InUseRule.bound(0), 0)
        XCTAssertEqual(InUseRule.bound(7), 7)
        XCTAssertEqual(InUseRule.bound(500), 120)
        XCTAssertEqual(InUseRule.bound(-3), 0)
    }

    func testEveryActionToolTakesWaitAndNoReadDoes() {
        for tool in HandsTools.all {
            let has = tool.params.contains { $0.name == "wait" && $0.kind == .integer && !$0.positional }
            XCTAssertEqual(has, AgentAccessGate.changes.contains(tool.verb), tool.verb)
        }
        guard case .success(let r) = HandsParse.command(["click", "@s1:e2", "--wait", "0"]) else { return XCTFail() }
        XCTAssertEqual(r.int("wait"), 0)
        guard case .success(let t) = HandsParse.command(["type", "@s1:e2", "hello", "there", "--wait", "45"]) else { return XCTFail() }
        XCTAssertEqual(t.string("text"), "hello there")
        XCTAssertEqual(t.int("wait"), 45)
        guard case .success(let o) = HandsParse.call(name: "open", arguments: ["app": "TextEdit", "wait": .int(120)]) else { return XCTFail() }
        XCTAssertEqual(o.int("wait"), 120)
        guard case .failure(let e) = HandsParse.command(["press", "@s1:e2", "Return", "--wait", "121"]) else { return XCTFail("over 120 s") }
        XCTAssertEqual(e.code, .badArguments)
        guard case .failure = HandsParse.call(name: "click", arguments: ["ref": "@s1:e2", "wait": .int(-1)]) else { return XCTFail("negative") }
        guard case .failure = HandsParse.command(["snapshot", "--app", "Word", "--wait", "5"]) else { return XCTFail("reads take no wait") }
    }

    func testReadOnlyRefusesWithoutWaiting() {
        let c = Clock()
        let out = InUseWait.run(bound: 20, now: c.now, sleep: c.sleep) {
            InUseWait.step(mode: .readOnly, scope: .onAgentWorkspace, state: .front, verdict: .wait)
        }
        guard case .refused(let e) = out else { return XCTFail("\(out)") }
        XCTAssertEqual(e.code, .permissionDenied)
        XCTAssertEqual(c.sleeps, [], "refused before any wait")
        XCTAssertNotNil(AgentAccessGate.refusal(verb: "click", mode: .readOnly), "and the router refuses the verb before it reaches the wait")
    }

    func testScopeNarrowingDuringAWaitRefuses() {
        let c = Clock()
        var looks = 0
        let gone = HandsError(.outsideAgentWorkspace, "moved", suggestion: "", retry: .never)
        let out = InUseWait.run(bound: 20, now: c.now, sleep: c.sleep) {
            looks += 1
            switch looks {
            case 1, 2: return InUseWait.step(mode: .full, scope: .fullAccess, state: .front, verdict: .wait)
            case 3: return InUseWait.step(mode: .standard, scope: .denied(gone), state: .front, verdict: .wait)
            default: return .ready
            }
        }
        XCTAssertEqual(out, .refused(gone))
        XCTAssertEqual(c.sleeps.count, 2)
        // Read Only set while waiting also stops it.
        looks = 0
        let ro = InUseWait.run(bound: 20, now: c.now, sleep: c.sleep) {
            looks += 1
            return InUseWait.step(mode: looks < 3 ? .standard : .readOnly, scope: .onAgentWorkspace, state: .front, verdict: .wait)
        }
        guard case .refused(let e) = ro else { return XCTFail() }
        XCTAssertEqual(e.code, .permissionDenied)
    }

    func testTheStepGoesAheadOnlyWhenTheRuleSaysSo() {
        XCTAssertEqual(InUseWait.step(mode: .standard, scope: .onAgentWorkspace, state: .free, verdict: .proceed), .ready)
        XCTAssertEqual(InUseWait.step(mode: .standard, scope: .onAgentWorkspace, state: .front, verdict: .otherWindow), .ready)
        XCTAssertEqual(InUseWait.step(mode: .standard, scope: .lent, state: .front, verdict: .wait), .busy(.front))
    }

    /// The router waits before the action's mark and before dispatch, off the main thread, and checks again at delivery.
    func testTheRouterWaitsBeforeEveryAction() throws {
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let act = try XCTUnwrap(HandsSourceTests.block(after: "private func act(", in: router))
        let wait = try XCTUnwrap(act.range(of: "awaitUse(w, verb: name, delivery: .headlessAX, wait: req.int(\"wait\"))"))
        XCTAssertLessThan(wait.lowerBound, try XCTUnwrap(act.range(of: "AgentActivity.shared.begin")).lowerBound)
        let awaitUse = try XCTUnwrap(HandsSourceTests.block(after: "func awaitUse(", in: router))
        XCTAssertTrue(awaitUse.contains("Thread.isMainThread ? 0 : InUseRule.bound(wait)"), "never blocks the main thread")
        XCTAssertTrue(awaitUse.contains("InUseWait.step(mode: access, scope: decide(live, agent)"), "Read Only and the whole scope at every look")
        let acting = try XCTUnwrap(HandsSourceTests.block(after: "func actingCheck(", in: router))
        XCTAssertTrue(acting.contains("inUseProblem(w, verb: verb, delivery: delivery)"), "checked again at delivery")
        let bg = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Background.swift")
        let background = try XCTUnwrap(HandsSourceTests.block(after: "private func background(", in: bg))
        let bgWait = try XCTUnwrap(background.range(of: "awaitUse(w, verb: name, delivery: .posted, wait: wait)"))
        XCTAssertLessThan(bgWait.lowerBound, try XCTUnwrap(background.range(of: "AgentActivity.shared.begin")).lowerBound)
        let open = try XCTUnwrap(HandsSourceTests.block(after: "private func open(", in: router))
        let openWait = try XCTUnwrap(open.range(of: "InUseWait.run("))
        XCTAssertLessThan(openWait.lowerBound, try XCTUnwrap(open.range(of: "host.open(")).lowerBound, "open waits before it asks the session")
        XCTAssertTrue(open.contains("reply.info?[\"code\"] == HandsErrorCode.inUse.rawValue"), "and passes the session's in_use through")
    }

    // MARK: rule 4: same app, other window

    func testOtherWindowTruthTable() {
        func d(_ verb: String, agent: Bool = true, focused: Bool? = false, main: Bool? = false, delivery: InUseDelivery = .headlessAX, state: InUseState = .front) -> InUseRule.Verdict {
            InUseRule.decide(verb: verb, state: state, onAgentWorkspace: agent, isFocusedWindow: focused, isMainWindow: main, delivery: delivery)
        }
        for verb in ["click", "set-value", "select", "toggle", "scroll", "type"] {
            for state in busy {
                XCTAssertEqual(d(verb, state: state), .otherWindow, "\(verb): a background window of the agent workspace")
                XCTAssertEqual(d(verb, focused: true, state: state), .wait, "\(verb): the focused window")
                XCTAssertEqual(d(verb, main: true, state: state), .wait, "\(verb): the main window")
                XCTAssertEqual(d(verb, focused: true, main: true, state: state), .wait)
                XCTAssertEqual(d(verb, focused: nil, state: state), .wait, "\(verb): focus unreadable")
                XCTAssertEqual(d(verb, main: nil, state: state), .wait, "\(verb): main window unreadable")
                XCTAssertEqual(d(verb, agent: false, state: state), .wait, "\(verb): a lent or Full Access window is not on the agent workspace")
                XCTAssertEqual(d(verb, delivery: .posted, state: state), .wait, "\(verb): posted, not the headless accessibility path")
            }
            XCTAssertEqual(d(verb, focused: true, main: true, state: .free), .proceed, "not in use: nothing to decide")
        }
        for verb in ["press", "click-at", "drag", "open"] {
            for delivery in [InUseDelivery.headlessAX, .posted] {
                XCTAssertEqual(d(verb, delivery: delivery), .wait, "\(verb) always waits")
            }
        }
    }

    /// A lent window and a Full Access window of an app in use, as the router sees them: not on the agent workspace.
    func testLentAndFullAccessWindowsAlwaysWait() {
        var b = LendBook()
        b.lend(app: "Word", bundle: "com.microsoft.Word", pid: 100, windows: [7], session: "s", now: now, for: 600)
        for (scope, mode, book) in [(ScopeDecision.lent, AgentAccessMode.standard, b), (.fullAccess, .full, LendBook())] {
            let w = win(2)
            XCTAssertEqual(ScopeGuard.check(w, agentWorkspace: 9, lends: book, now: now, mode: mode), scope)
            let onAgent = w.workspace == 9
            for verb in AgentAccessGate.changes {
                XCTAssertEqual(InUseRule.decide(verb: verb, state: .front, onAgentWorkspace: onAgent, isFocusedWindow: false, isMainWindow: false, delivery: .headlessAX), .wait, "\(scope) \(verb)")
            }
        }
    }

    /// `type` goes under rule 4 because the engine path can't post keys: `HandsEngine.act` passes the strict Headless
    /// policy, a constant, and under it the pinned engine's TypeText writes AXSelectedText (crates/macos/src/actions/type_text.rs).
    func testTypeTakesTheHeadlessAccessibilityPath() throws {
        let engine = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsEngine.swift")
        XCTAssertTrue(engine.contains("static let headlessPolicy: Int32 = 0"))
        XCTAssertTrue(engine.contains("ad_execute_by_ref_timeout(adapter, r, &action, Self.headlessPolicy, 0, &out)"))
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertTrue(router.contains("case \"type\": return act(req, .typeText, \"type\""), "type goes through act, the engine path")
        let reads = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let verdict = try XCTUnwrap(HandsSourceTests.block(after: "func inUseVerdict(", in: reads))
        XCTAssertTrue(verdict.contains("BackgroundAX.isFocusedOrMain(w.id, pid: w.pid)"), "focused and main window read at decision time")
    }

    // MARK: rule 5: lending

    func testALendRequestIsNotRefusedForInUse() throws {
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let ask = try XCTUnwrap(HandsSourceTests.block(after: "func askToLend(", in: router))
        XCTAssertFalse(ask.contains("UserActivity"), "the sheet is Donovan's decision; in use doesn't stop the request")
        XCTAssertFalse(ask.contains(".inUse"))
        XCTAssertTrue(ask.contains("host.askToLend(name, Int(seconds / 60), false)"), "it still asks him in the sheet")
        XCTAssertTrue(ask.contains("found.count == 1"), "the other lend rules stay")
    }
}
