@testable import BaneySpacesCore
import XCTest

final class RunStepsTests: XCTestCase {
    private func steps(_ json: String) -> JSONValue { JSONValue.parse(json)! }

    func testEveryStepIsCheckedBeforeAnyRuns() throws {
        // Step 3 is wrong: the whole run is refused, naming it, and nothing is handed on.
        let bad = steps(#"[{"tool":"click","args":{"ref":"5"}},{"tool":"type","args":{"ref":"7","text":"hi"}},{"tool":"press","args":{"ref":"7"}}]"#)
        guard case .failure(let e) = RunSteps.parse(bad, session: "s", wait: nil) else { return XCTFail("a step with no key ran") }
        XCTAssertEqual(e.code, .badArguments)
        XCTAssertTrue(e.message.hasPrefix("step 3 (press)"), e.message)
        XCTAssertTrue(e.suggestion.contains("Nothing ran"))
        // Through the tool's own parse too, over MCP and on the command line.
        guard case .failure(let m) = HandsParse.call(name: "run_steps", arguments: ["steps": bad]) else { return XCTFail("MCP let a bad step in") }
        XCTAssertTrue(m.message.hasPrefix("step 3"))
        guard case .failure = HandsParse.command(["run-steps", "--steps", #"[{"tool":"open","args":{"app":"TextEdit"}}]"#]) else { return XCTFail("open as a step") }

        for (json, why) in [
            (#"[{"tool":"snapshot","args":{"window":4}}]"#, "a read"),
            (#"[{"tool":"run_steps","args":{"steps":[]}}]"#, "itself"),
            (#"[{"tool":"close","args":{"window":4}}]"#, "close"),
            (#"[{"args":{"ref":"5"}}]"#, "no tool"),
            ("[]", "no steps"),
        ] {
            guard case .failure(let e) = RunSteps.parse(steps(json), session: nil, wait: nil) else { XCTFail(why); continue }
            XCTAssertEqual(e.code, .badArguments, why)
            XCTAssertEqual(e.nextCall, .null, why)
        }
        let many = JSONValue.array(Array(repeating: steps(#"{"tool":"click","args":{"ref":"5"}}"#), count: RunSteps.maxSteps + 1))
        guard case .failure = RunSteps.parse(many, session: nil, wait: nil) else { return XCTFail("over the cap") }
    }

    func testAStepTakesTheToolsOwnArgumentsAndTheRunsWait() throws {
        let ok = steps(#"[{"tool":"computer_click","args":{"ref":"5"}},{"tool":"set_value","ref":"@s1:e2","value":"x"},{"tool":"click_at","args":{"window":4,"x":1,"y":2,"wait":0}}]"#)
        let reqs = try RunSteps.parse(ok, session: "s", wait: 9).get()
        XCTAssertEqual(reqs.map(\.verb), ["click", "set-value", "click-at"])
        XCTAssertEqual(reqs[1].string("value"), "x", "arguments beside tool count")
        XCTAssertEqual(reqs[0].int("wait"), 9, "the run's wait")
        XCTAssertEqual(reqs[2].int("wait"), 0, "a step's own wait wins")
        XCTAssertEqual(reqs[0].session, "s")
        // The CLI takes the list as JSON.
        let cli = try HandsParse.command(["run-steps", "--steps", #"[{"tool":"toggle","args":{"ref":"3"}}]"#]).get()
        XCTAssertEqual(cli.args["steps"]?.array?.count, 1)
    }

    func testEachWindowsStepsAreOneTransaction() {
        XCTAssertEqual(RunSteps.groups([4, 4, 5, 4]), [0..<2, 2..<3, 3..<4])
        XCTAssertEqual(RunSteps.groups([7]), [0..<1])
        XCTAssertEqual(RunSteps.groups([]), [])
    }

    func testTheRunStopsAtAFailureAnUnprovedStepOrANewDialog() {
        XCTAssertEqual(RunSteps.stop(after: .failure(HandsError(.staleRef, "x", suggestion: "y"))), .failed)
        XCTAssertEqual(RunSteps.stop(after: .success(.object(["verified": false]))), .unverified)
        XCTAssertEqual(RunSteps.stop(after: .success(.object(["verified": true, "opened": .object(["window": 9, "kind": "sheet"])]))), .opened)
        XCTAssertNil(RunSteps.stop(after: .success(.object(["verified": true, "opened": .null]))))
        XCTAssertNil(RunSteps.stop(after: .success(.object(["verified": true]))))

        let click = HandsRequest(verb: "click", args: ["ref": "@s1:e5"])
        let lines = [
            RunSteps.line(1, click, .success(.object(["verified": true, "landed": "press", "evidence": .object(["kind": "ax_diff"])])), full: false),
            RunSteps.line(2, click, .failure(HandsError(.staleRef, "gone", suggestion: "Take a new snapshot.")), full: true),
        ]
        XCTAssertNil(lines[0]["result"], "a step that went on stays short")
        XCTAssertEqual(lines[0]["landed"], "press")
        XCTAssertEqual(lines[1]["error"]?["code"], "stale_ref")
        let a = RunSteps.answer(lines: lines, total: 4, stop: .failed, read: .object(["rows": "~ [5] button"]), readError: nil)
        XCTAssertEqual(a["done"], 1)
        XCTAssertEqual(a["of"], 4)
        XCTAssertEqual(a["complete"], false)
        XCTAssertEqual(a["stopped"], "failed")
        XCTAssertEqual(a["note"]?.string, "step 2 failed; the 2 after it did not run. Its error says what to do.")
        XCTAssertNotNil(a["read"])
        let all = RunSteps.answer(lines: [lines[0]], total: 1, stop: nil, read: nil, readError: nil)
        XCTAssertEqual(all["complete"], true)
        XCTAssertNil(all["stopped"])
    }

    func testTheToolIsListedAsAnActionWithAListOfObjects() throws {
        let tool = try XCTUnwrap(HandsTools.tool(verb: "run_steps"))
        XCTAssertTrue(tool.acts)
        XCTAssertTrue(AgentAccessGate.changes.contains("run-steps"), "Read Only refuses it")
        XCTAssertTrue(tool.summary.contains("Example: {"), "one example call")
        XCTAssertLessThan(tool.summary.count, 700)
        let listed = try XCTUnwrap(HandsMCP.toolList().array?.first { $0["name"] == "run_steps" })
        XCTAssertEqual(listed["inputSchema"]?["properties"]?["steps"]?["items"]?["type"], "object")
        XCTAssertEqual(listed["inputSchema"]?["required"], .array(["steps"]))
        // Every step verb is an action of its own, and none manages windows.
        for v in RunSteps.verbs { XCTAssertEqual(HandsTools.tool(verb: v)?.acts, true, v) }
        XCTAssertTrue(RunSteps.verbs.isDisjoint(with: ["open", "close", "move", "arrange", "run-steps", "snapshot", "shot"]))
    }

    func testTheRouterRunsEachWindowInOneTransactionAndReadsOnce() throws {
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertTrue(router.contains(#"case "run-steps": return runSteps(req)"#))
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Steps.swift")
        let run = try XCTUnwrap(HandsSourceTests.block(after: "func runSteps(_ req: HandsRequest)", in: src))
        let parse = try XCTUnwrap(run.range(of: "RunSteps.parse("))
        let bare = try XCTUnwrap(run.range(of: "bareRef(n, steps[i])"))
        let tx = try XCTUnwrap(run.range(of: "HandsEngine.shared.transaction(window: w, until: until, check: check(w, session: session))"))
        XCTAssertTrue(parse.lowerBound < bare.lowerBound && bare.lowerBound < tx.lowerBound, "checked and row numbers bound before anything runs")
        XCTAssertTrue(run.contains("for g in RunSteps.groups(windows)"), "one transaction per window")
        XCTAssertTrue(run.contains("if cancelled() || left <= 0 { why = .time; break }"), "no step starts after the caller gave up or the deadline")
        XCTAssertTrue(run.contains("why = RunSteps.stop(after: env)"))
        XCTAssertTrue(run.contains(#""since": "latest""#), "one read of what changed")
        // Inside the transaction a step's own engine calls run inline, not queued behind it.
        let engine = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsEngine.swift")
        let runBlock = try XCTUnwrap(HandsSourceTests.block(after: "private func run(window", in: engine))
        let inline = try XCTUnwrap(runBlock.range(of: "if isOnQueue(of: w.pid) {"))
        let queued = try XCTUnwrap(runBlock.range(of: "queue(for: w.pid).async"))
        XCTAssertTrue(inline.lowerBound < queued.lowerBound)
        XCTAssertTrue(runBlock.contains("return check().map(Reply.failed) ?? work(inlineCancelled(w.pid))"), "the inline call still runs its check first")
        let serialized = try XCTUnwrap(HandsSourceTests.block(after: "func serialized<T>(pid: Int32", in: engine))
        XCTAssertTrue(serialized.contains("if isOnQueue(of: pid) { return work(inlineCancelled(pid)) }"))
    }

    // MARK: 251 r2

    /// first-F2: a step that starts inside the deadline can't wait past it. The run's `wait` (up to 120 s) was copied into
    /// every step unchanged, so a step started at 39 s could sit in its in-use wait long after the transaction's 60 s.
    func testAStepNeverWaitsPastTheDeadline() {
        let step = HandsRequest(verb: "click", args: ["ref": "w1:5", "wait": 90], session: "s")
        XCTAssertEqual(RunSteps.clamped(step, left: 12.7).int("wait"), 12)
        XCTAssertEqual(RunSteps.clamped(step, left: 100).int("wait"), 90)
        XCTAssertEqual(RunSteps.clamped(step, left: -1).int("wait"), 0, "no time left answers in_use at once")
        let plain = HandsRequest(verb: "click", args: ["ref": "w1:5"], session: "s")
        XCTAssertEqual(RunSteps.clamped(plain, left: 30).int("wait"), Int(InUseRule.defaultWait))
        XCTAssertEqual(RunSteps.clamped(plain, left: 3).int("wait"), 3)
    }

    /// first-F2: a transaction that outlives its budget reports the steps that ran, and the step still running then as one
    /// that may still land, never as step 1 failing. Before, the group's lines were dropped and step 1 was charged.
    func testATimedOutGroupReportsWhatRanAndTheStepStillRunning() throws {
        let steps = [HandsRequest(verb: "type", args: ["ref": "w1:7", "text": "hi"], session: "s"),
                     HandsRequest(verb: "click", args: ["ref": "w1:5"], session: "s"),
                     HandsRequest(verb: "click", args: ["ref": "w1:6"], session: "s")]
        let progress = RunSteps.Progress()
        progress.begin(0)
        progress.finish(RunSteps.line(1, steps[0], .success(.object(["verified": true])), full: false))
        progress.begin(1)
        let timeout = HandsError(.timeout, "the app didn't answer within 60 s", suggestion: "It may still land", retry: .never)
        let (lines, stop) = RunSteps.lines(failed: timeout, progress: progress, group: 0..<3, steps: steps)
        XCTAssertEqual(stop, .landing)
        guard lines.count == 2 else { return XCTFail("the lines of steps 1 and 2, not \(lines.count)") }
        XCTAssertEqual(lines[0]["step"], 1)
        XCTAssertEqual(lines[0]["ok"], true, "step 1 landed and says so")
        XCTAssertEqual(lines[1]["step"], 2)
        XCTAssertEqual(lines[1]["may_land"], true)
        let answer = RunSteps.answer(lines: lines, total: 3, stop: stop, read: nil, readError: nil)
        XCTAssertEqual(answer["done"], 1)
        let note = try XCTUnwrap(answer["note"]?.string)
        XCTAssertTrue(note.hasPrefix("step 2 was still running"), note)
        XCTAssertTrue(note.contains("may still land"), note)
        XCTAssertFalse(note.contains("step 1 failed"), note)
    }

    /// first-F2: only when no step began does the group's first step carry the transaction's error: then nothing ran.
    func testAGroupThatNeverStartedChargesItsFirstStep() {
        let steps = [HandsRequest(verb: "click", args: ["ref": "w1:5"], session: "s")]
        let gone = HandsError(.windowNotFound, "window 1 is gone", suggestion: "Take a new snapshot", retry: .afterSnapshot)
        let (lines, stop) = RunSteps.lines(failed: gone, progress: RunSteps.Progress(), group: 0..<1, steps: steps)
        XCTAssertEqual(stop, .failed)
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines[0]["ok"], false)
        XCTAssertNil(lines[0]["may_land"])
    }

    /// first-F2: the router publishes lines as steps finish, clamps each step's wait, and hands the engine the deadline
    /// that its inline calls (an act's retry, a step's own transaction) stop at.
    func testTheRouterPublishesLinesAndInlineCallsStopAtTheDeadline() throws {
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Steps.swift")
        let run = try XCTUnwrap(HandsSourceTests.block(after: "func runSteps(_ req: HandsRequest)", in: src))
        XCTAssertTrue(run.contains("HandsEngine.shared.transaction(window: w, until: until, check: check(w, session: session))"))
        XCTAssertTrue(run.contains("handle(RunSteps.clamped(steps[i], left: left))"))
        let begin = try XCTUnwrap(run.range(of: "progress.begin(i)"))
        let call = try XCTUnwrap(run.range(of: "handle(RunSteps.clamped("))
        let finish = try XCTUnwrap(run.range(of: "progress.finish("))
        XCTAssertTrue(begin.lowerBound < call.lowerBound && call.lowerBound < finish.lowerBound)
        XCTAssertTrue(run.contains("RunSteps.lines(failed: e, progress: progress, group: g, steps: steps)"))
        XCTAssertFalse(run.contains("lines.append(RunSteps.line(g.lowerBound + 1"), "a timeout no longer charges the group's first step")
        let engine = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsEngine.swift")
        let tx = try XCTUnwrap(HandsSourceTests.block(after: "func transaction(window w: HandsWindow, until: Date? = nil", in: engine))
        XCTAssertTrue(tx.contains("guard let until else { return work(cancelled) }"), "a step's own transaction keeps the run's deadline")
        XCTAssertTrue(tx.contains("inlineUntil[w.pid] = until"))
        XCTAssertTrue(engine.contains("return { until.map { Date() >= $0 } ?? false }"))
    }

    /// first-F1 (disputed): a connector's steps run under the connector's cap. `cap` and `remote` are the router's own
    /// stored state, set once in init; `runSteps` calls `handle` on that same router, so every step and the closing read
    /// pass the connector gate and the capped access, and a capped Full Access never reaches a window off the agent workspace.
    func testAConnectorsStepsRunUnderTheConnectorsCap() throws {
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertTrue(router.contains("var access: AgentAccessMode { cap(AgentAccess.shared.current) }"))
        XCTAssertTrue(router.contains("let remote: Bool"))
        let handle = try XCTUnwrap(HandsSourceTests.block(after: "func handle(_ req: HandsRequest) -> HandsEnvelope", in: router))
        XCTAssertTrue(handle.contains("AgentAccessGate.refusal(verb: req.verb, mode: access)"))
        XCTAssertTrue(handle.contains("if remote, let e = WorkspaceVerbs.connectorRefusal(verb: req.verb)"))
        let session = try HandsSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertTrue(session.contains("HandsRouter(cap: { $0.forRemote }, remote: true)"), "the connector's router is capped and remote")
        // Every nested call goes to the same router: no other router is made in the hands.
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Steps.swift")
        XCTAssertFalse(src.contains("HandsRouter("))
        XCTAssertTrue(src.contains("handle(RunSteps.clamped(steps[i]") || src.contains("handle(steps[i])"))
        XCTAssertTrue(src.contains("let read = handle(readReq)"))
        // What that cap means for a window off the agent workspace under Full Access.
        let off = HandsWindow(id: 40, pid: 400, app: "Notes", workspace: 2)
        XCTAssertEqual(ScopeGuard.check(off, agentWorkspace: 9, lends: LendBook(), now: Date(), mode: .full), .fullAccess)
        guard case .denied(let e) = ScopeGuard.check(off, agentWorkspace: 9, lends: LendBook(), now: Date(), mode: AgentAccessMode.full.forRemote) else {
            return XCTFail("a connector under Full Access reached a window off the agent workspace")
        }
        XCTAssertEqual(e.code, .outsideAgentWorkspace)
    }
}
