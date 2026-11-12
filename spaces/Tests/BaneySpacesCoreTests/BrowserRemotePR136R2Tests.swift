import XCTest
@testable import BaneySpacesCore

/// PR 136 review round 2, the medium leftovers, as the Mac window has them: Tailscale not answering in time is its own step
/// that keeps checking, on a saved route and before one (first-F1, second-S1), and a failed check whose Repair has nothing
/// planned keeps Check again (first-F2). The side panel's are browser/test/remote-flow-pr136-r2.test.mjs.
final class BrowserRemotePR136R2Tests: XCTestCase {
    private let url = "https://m.tail1.ts.net:8443/mcp"
    private let words = "Tailscale didn't answer within 15 seconds, so nothing was changed. Check that Tailscale is running, then try again."
    private let plan = RemoteFixPlan(available: true, actions: [.init(kind: "service", what: "restart serve", status: "planned")])
    private func report(_ json: String) throws -> RemoteReport { try XCTUnwrap(RemoteReport.parse(Data(json.utf8)), json) }
    private func source(_ path: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }

    func testTailscaleSilentHasAStepThatChecksAgainByItself() throws {
        XCTAssertEqual(RemoteSharedCopy.key(state: "problem", code: "tailscale_silent"), "tailscale_silent")
        XCTAssertTrue(RemoteSharedCopy.problemCodes.contains("tailscale_silent"))
        let entry = try XCTUnwrap(RemoteSharedCopy.steps["tailscale_silent"])
        XCTAssertEqual(entry.title, "Tailscale didn't answer, checking again")
        XCTAssertTrue(entry.waits)
        XCTAssertEqual(entry.kind, "check_again")
        XCTAssertEqual(RemoteFlow.tailscaleSilentCode, "tailscale_silent")
    }

    // MARK: first-F1

    func testOnASavedRouteTailscaleSilenceComesFirstAndPollsQuickly() throws {
        // `remote status --json` on a saved Funnel route whose serve status read hit the limit.
        let status = try report(#"{"ok":false,"state":"problem","code":"tailscale_silent","message":"\#(words)","route":"funnel","connectorUrl":"\#(url)","#
            + #""checks":[{"name":"tailscale","status":"fail","detail":"\#(words)"}]}"#)
        XCTAssertTrue(status.configured)
        XCTAssertFalse(status.answerOn, "never on")
        XCTAssertEqual(RemoteFlow.screen(helperAvailable: true, settingUp: false, status: status, setup: nil), .problem(code: "tailscale_silent", message: words))
        // An older refusal from setup doesn't hide it.
        let refusal = RemoteReport(state: .problem, message: "tailscale funnel failed", code: "funnel", connectorURL: url)
        XCTAssertEqual(RemoteFlow.screen(helperAvailable: true, settingUp: false, status: status, setup: refusal), .problem(code: "tailscale_silent", message: words))
        XCTAssertTrue(RemoteFlow.isMoreBasic(status))
        // The step says it checks again by itself, so status is read every few seconds, not every 30.
        let screen = RemoteFlow.screen(helperAvailable: true, settingUp: false, status: status, setup: nil)
        XCTAssertEqual(RemoteFlow.pollInterval(for: screen, status: status), 4)
        // Its button reads status again; it never runs setup.
        XCTAssertEqual(RemoteFlow.problemAction(key: "tailscale_silent", plan: nil)?.kind, "check_again")
        XCTAssertFalse(RemoteFlow.checkAgainTests(key: "tailscale_silent"))
        // Any other problem on a saved route still waits 30 seconds between reads.
        let other = RemoteReport(state: .problem, message: "x", code: "serve", connectorURL: url)
        XCTAssertFalse(RemoteFlow.isMoreBasic(other))
        XCTAssertEqual(RemoteFlow.pollInterval(for: .problem(code: "serve", message: "x"), status: other), 30)
    }

    // MARK: second-S1

    func testNothingSavedTheReadyPollThatTimesOutKeepsPolling() throws {
        let status = try report(#"{"ok":false,"state":"problem","code":"tailscale_silent","message":"\#(words)","#
            + #""routes":{"tailscale":{"installed":true,"signedIn":true},"cloudflare":{"installed":false,"signedIn":false}}}"#)
        XCTAssertFalse(status.configured)
        let screen = RemoteFlow.screen(helperAvailable: true, settingUp: false, status: status, setup: nil, chosen: .tailscale)
        XCTAssertEqual(screen, .problem(code: "tailscale_silent", message: words))
        XCTAssertNotEqual(RemoteSharedCopy.copy(for: status).key, "unknown", "not \"Setup stopped\"")
        XCTAssertNotEqual(RemoteFlow.problemAction(key: "tailscale_silent", plan: nil)?.kind, "try_again", "Try again would run remote setup")
        XCTAssertEqual(RemoteFlow.pollInterval(for: screen, status: status), 4)
        // The next good read is the ready step again.
        let ready = RemoteReport(state: .ready, routes: RemoteRoutes(tailscaleInstalled: true, tailscaleSignedIn: true))
        XCTAssertEqual(RemoteFlow.screen(helperAvailable: true, settingUp: false, status: ready, setup: nil, chosen: .tailscale), .ready)
    }

    // MARK: first-F2

    func testACheckFailedStepWithNothingToRepairKeepsCheckAgain() throws {
        for none in [nil, RemoteFixPlan(available: false), RemoteFixPlan(available: true, actions: [])] {
            let action = try XCTUnwrap(RemoteFlow.problemAction(key: "check_failed", plan: none), "a way forward")
            XCTAssertEqual(action.kind, "check_again")
            XCTAssertEqual(action.label, RemoteSharedCopy.result["checkAgain"])
        }
        XCTAssertEqual(RemoteFlow.problemAction(key: "check_failed", plan: plan)?.kind, "repair", "with a plan, Repair")
        XCTAssertTrue(RemoteFlow.checkAgainTests(key: "check_failed"), "it checks from outside again")
        XCTAssertNil(RemoteFlow.problemAction(key: "tailscale_operator", plan: nil), "a copy_command step's command box is its action")

        // The turn-on whose deadline passed (next names `remote fix`) is that step; a later test that passes ends it.
        let gaveUp = try report(#"{"ok":false,"state":"problem","code":"resource_metadata","message":"m","connectorUrl":"\#(url)","#
            + #""next":{"kind":"run_command","command":"polycarp remote fix"},"#
            + #""checks":[{"name":"resource_metadata","status":"fail","detail":"tunnel not connected","pending":true}]}"#)
        XCTAssertEqual(RemoteSharedCopy.copy(for: gaveUp).key, "check_failed")
        var s = RemoteSession()
        _ = s.take(gaveUp, pressed: true, now: Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertTrue(s.startTest(force: true), "Check again always runs the test")
        let passed = try report(#"{"ok":true,"state":"on","connectorUrl":"\#(url)","checks":[{"name":"resource_metadata","status":"ok","detail":"fine"}]}"#)
        _ = s.tested(passed)
        XCTAssertNil(s.setup, "the step is over once a test says the route is on")

        // The window draws problemAction's button, and a test-key Check again runs `remote test`.
        let view = try source("Sources/BaneySpaces/BrowserRemoteView.swift")
        XCTAssertTrue(view.contains("if let action = RemoteFlow.problemAction(key: copy.key, plan: model.fixPlan) {"))
        XCTAssertTrue(view.contains(#"case "check_again" where RemoteFlow.checkAgainTests(key: key): model.checkFromOutside(force: true)"#))
    }
}
