import XCTest
@testable import BaneySpacesCore

/// PR 133 review round 1, as it applies to the Mac window: a new name still being published is On and waiting, pending checks
/// are waiting (never failed, never Repair), no connect code is made without a press, and Repair needs a real plan.
final class BrowserRemoteRoundOneTests: XCTestCase {
    private let url = "https://m.ts.net:8443/mcp"
    private func report(_ json: String) throws -> RemoteReport { try XCTUnwrap(RemoteReport.parse(Data(json.utf8)), json) }
    private func source(_ path: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }
    private let view = "Sources/BaneySpaces/BrowserRemoteView.swift"

    /// Setup's answer when the tunnel is up but public DNS hasn't caught up with a brand-new ts.net name.
    private var lagging: String {
        #"{"ok":false,"state":"problem","code":"dns","message":"m","connectorUrl":"https://m.ts.net:8443/mcp","#
            + #""connectCode":"TK-7QF3-K2MD","connectCodeExpiresAt":1800000000000,"#
            + #""checks":[{"name":"dns","status":"fail","detail":"not yet","pending":true},{"name":"tls","status":"ok","detail":""}]}"#
    }

    func testPendingIsReadAndOnlyCountsOnAFailure() throws {
        let r = try report(lagging)
        XCTAssertEqual(r.checks.first?.pending, true)
        XCTAssertTrue(r.checks.first?.waiting ?? false)
        XCTAssertEqual(r.failedChecks, [], "a pending failure is not a failure to repair")
        let ok = try report(#"{"state":"on","checks":[{"name":"dns","status":"ok","pending":true}]}"#)
        XCTAssertEqual(ok.checks.first?.pending, false, "pending means nothing on a check that passed")
    }

    func testANameStillBeingPublishedIsOn() throws {
        let r = try report(lagging)
        XCTAssertTrue(r.answerOn)
        XCTAssertTrue(RemoteReport(state: .problem, code: "dns", connectorURL: url).answerOn, "an older helper's bare dns code")
        XCTAssertFalse(RemoteReport(state: .problem, code: "dns").answerOn, "no address, nothing to show")
        let real = RemoteReport(state: .problem, code: "tls", connectorURL: url, checks: [RemoteCheck(name: "tls", status: "fail")])
        XCTAssertFalse(real.answerOn, "a real failure is a failure")
        XCTAssertEqual(RemoteFlow.screen(helperAvailable: true, settingUp: false, status: nil, setup: r), .on(connectorURL: url, browserConnected: true))
        let half = RemoteReport(state: .problem, message: "public DNS", code: "dns", connectorURL: url)
        XCTAssertEqual(RemoteFlow.screen(helperAvailable: true, settingUp: false, status: half, setup: r, setupAge: 900), .on(connectorURL: url, browserConnected: true),
                       "a status that says only dns is on too, after any grace")
    }

    func testDnsHasItsOwnWordsNotCheckFailed() {
        XCTAssertEqual(RemoteSharedCopy.key(state: "problem", code: "dns"), "dns")
        XCTAssertEqual(RemoteSharedCopy.key(state: "problem", code: "tls"), "check_failed")
    }

    func testTheResultHeadWaitsOnPendingChecks() throws {
        let r = try report(lagging)
        XCTAssertEqual(RemoteFlow.resultHead(checks: r.checks, answer: r, browserConnected: true).head, "on_waiting")
        XCTAssertTrue(RemoteFlow.resultHead(checks: r.checks, answer: r, browserConnected: true).waiting)
        XCTAssertEqual(RemoteFlow.resultHead(checks: [], answer: RemoteReport(state: .problem, code: "dns", connectorURL: url), browserConnected: true).head, "on_waiting")
        let failed = [RemoteCheck(name: "tls", status: "fail"), RemoteCheck(name: "dns", status: "fail", pending: true)]
        XCTAssertEqual(RemoteFlow.resultHead(checks: failed, answer: nil, browserConnected: true).head, "check_failed")
        XCTAssertFalse(RemoteFlow.resultHead(checks: failed, answer: nil, browserConnected: true).waiting)
        XCTAssertEqual(RemoteFlow.resultHead(checks: [RemoteCheck(name: "dns", status: "ok")], answer: nil, browserConnected: false).head, "no_browser_connected")
        XCTAssertEqual(RemoteFlow.resultHead(checks: [], answer: nil, browserConnected: true).head, "on")
        XCTAssertNotNil(RemoteSharedCopy.steps["on_waiting"])
    }

    func testRepairNeverForAWaitingCheckAndNeedsARealPlan() throws {
        let plan = RemoteFixPlan(available: true, actions: [.init(kind: "funnel", what: "Open Funnel", status: "planned")])
        XCTAssertFalse(RemoteFlow.offerRepair(checks: [RemoteCheck(name: "dns", status: "fail", pending: true)], plan: plan))
        XCTAssertTrue(RemoteFlow.offerRepair(checks: [RemoteCheck(name: "tls", status: "fail")], plan: plan))
        XCTAssertTrue(RemoteFlow.repairAvailable(plan))
        XCTAssertFalse(RemoteFlow.repairAvailable(RemoteFixPlan(available: true)))
        XCTAssertFalse(RemoteFlow.repairAvailable(nil))
        // The real `remote fix --json --dry-run` answer (browser/cli/src/remote-fix.ts): every path has actions, maybe empty.
        let real = RemoteCommand.parseFix(exitCode: 0, Data(#"""
        {"ok":true,"state":"on","message":"Nothing to repair.","publicUrl":"https://m.ts.net:8443","actions":[],"advice":[],
         "checks":[{"name":"dns","status":"fail","detail":"lag","pending":true}]}
        """#.utf8))
        XCTAssertTrue(real.available)
        XCTAssertFalse(RemoteFlow.repairAvailable(real), "nothing to do: no Repair")
        XCTAssertEqual(real.checks.first?.pending, true)
        let some = RemoteCommand.parseFix(exitCode: 0, Data(#"{"ok":true,"state":"problem","message":"m","publicUrl":null,"actions":[{"kind":"funnel","what":"Open Funnel again","status":"planned","detail":"x"}],"advice":[]}"#.utf8))
        XCTAssertEqual(some.actions.map(\.kind), ["funnel"])
        // A step whose button is Repair draws it only when the plan has something in it; else Check again (PR 136 r2 first-F2).
        XCTAssertEqual(RemoteFlow.problemAction(key: "check_failed", plan: real)?.kind, "check_again")
        XCTAssertEqual(RemoteFlow.problemAction(key: "check_failed", plan: some)?.kind, "repair")
        XCTAssertTrue(try source(view).contains("RemoteFlow.problemAction(key: copy.key, plan: model.fixPlan)"))
    }

    /// second-N2: the quiet Funnel retry runs by itself, so it never asks for a connect code. Only a press makes one.
    func testNoConnectCodeWithoutAPress() throws {
        XCTAssertFalse(RemoteCommand.setup.arguments(connectCode: false).contains("--connect-code"))
        XCTAssertFalse(RemoteCommand.setupCloudflare("a.example.com").arguments(connectCode: false).contains("--connect-code"))
        XCTAssertEqual(RemoteCommand.setup.arguments(connectCode: false), ["remote", "setup", "--json"])
        XCTAssertEqual(RemoteCommand.setup.arguments, ["remote", "setup", "--json", "--connect-code"], "a press still asks for one")
        // The session decides; BrowserRemoteReviewR2Tests.testOnlyAPressAsksForAndTakesAConnectCode holds it by value.
        var s = RemoteSession()
        XCTAssertFalse(s.setupStarts(quiet: true, now: Date()).connectCode, "the retry's run carries no --connect-code")
        _ = s.take(RemoteReport(ok: true, state: .on, connectorURL: "https://m.ts.net:8443/mcp",
                                connectCode: ConnectCode(code: "TK-ABCD-EFGH", expiresAt: Date().addingTimeInterval(600))), pressed: false, now: Date())
        XCTAssertNil(s.connectCode, "a code only from a pressed run")
    }

    /// first-F1: a run that stopped on dns or a failed check is over once a later test says the route is on.
    func testAStaleRunEndsWhenATestSaysOn() {
        let stale = RemoteReport(state: .problem, code: "dns")
        let failedCheck = RemoteReport(state: .problem, code: "tls")
        let on = [RemoteCheck(name: "dns", status: "ok")]
        XCTAssertNil(RemoteFlow.settleAfterTest(setup: stale, checks: on))
        XCTAssertNil(RemoteFlow.settleAfterTest(setup: failedCheck, checks: on))
        XCTAssertEqual(RemoteFlow.settleAfterTest(setup: stale, checks: [RemoteCheck(name: "dns", status: "fail")]), stale)
        let refused = RemoteReport(state: .funnelNotAllowed)
        XCTAssertEqual(RemoteFlow.settleAfterTest(setup: refused, checks: on), refused, "anything else is the person's")
    }

    /// first-F3: after ten minutes the waiting line goes and the step's button checks again.
    func testFunnelGiveUpUsesTheSharedStep() throws {
        XCTAssertEqual(RemoteSharedCopy.steps["funnel_gave_up"]?.action, "Check again")
        let src = try source(view)
        XCTAssertTrue(src.contains(#"model.funnelGaveUp ? "funnel_gave_up" : "funnel_not_allowed""#))
        XCTAssertFalse(try source("Sources/BaneySpacesCore/BrowserRemote.swift").contains("static let funnelGaveUp"), "the shared words replace the Mac's own")
    }

    /// While a check waits, the window checks again by itself every 30 seconds.
    func testWaitingChecksAgainByItself() throws {
        XCTAssertEqual(RemoteFlow.waitingRecheckEvery, 30)
        var s = RemoteSession()
        let waiting = RemoteReport(state: .problem, connectorURL: "https://m.ts.net:8443/mcp", checks: [RemoteCheck(name: "dns", status: "fail", pending: true)])
        XCTAssertTrue(s.take(waiting, pressed: true, now: Date()).contains(.recheckIfWaiting))
        let src = try source(view)
        XCTAssertTrue(src.contains(#"Shared.result["checksWaiting"]"#) || src.contains(#"result("checksWaiting")"#))
        XCTAssertTrue(src.contains(#"result("codeNone")"#), "no code yet: the line says to press New code")
    }
}
