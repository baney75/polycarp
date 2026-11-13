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
        let tx = try XCTUnwrap(run.range(of: "HandsEngine.shared.transaction(window: w, check: check(w, session: session))"))
        XCTAssertTrue(parse.lowerBound < bare.lowerBound && bare.lowerBound < tx.lowerBound, "checked and row numbers bound before anything runs")
        XCTAssertTrue(run.contains("for g in RunSteps.groups(windows)"), "one transaction per window")
        XCTAssertTrue(run.contains("cancelled() || Date().timeIntervalSince(started) > RunSteps.deadline"), "no step starts after the caller gave up")
        XCTAssertTrue(run.contains("why = RunSteps.stop(after: env)"))
        XCTAssertTrue(run.contains(#""since": "latest""#), "one read of what changed")
        // Inside the transaction a step's own engine calls run inline, not queued behind it.
        let engine = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsEngine.swift")
        let runBlock = try XCTUnwrap(HandsSourceTests.block(after: "private func run(window", in: engine))
        let inline = try XCTUnwrap(runBlock.range(of: "if isOnQueue(of: w.pid) {"))
        let queued = try XCTUnwrap(runBlock.range(of: "queue(for: w.pid).async"))
        XCTAssertTrue(inline.lowerBound < queued.lowerBound)
        XCTAssertTrue(runBlock.contains("return check().map(Reply.failed) ?? work { false }"), "the inline call still runs its check first")
        let serialized = try XCTUnwrap(HandsSourceTests.block(after: "func serialized<T>(pid: Int32", in: engine))
        XCTAssertTrue(serialized.contains("if isOnQueue(of: pid) { return work { false } }"))
    }
}
