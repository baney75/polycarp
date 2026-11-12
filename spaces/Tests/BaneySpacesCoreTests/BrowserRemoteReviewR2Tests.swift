import XCTest
@testable import BaneySpacesCore

/// PR 134 review round 2: "Get it for me" says why it stopped, the secrets leave setup's answer too, a step's command comes from
/// the answer on screen, a failed Repair's note points only at words it shows, the model's decisions are tested by value,
/// Repair can be pressed again, and `dns_lookup` has its own step.
final class BrowserRemoteReviewR2Tests: XCTestCase {
    private let admin = URL(string: "https://login.tailscale.com/admin/machines")!
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private let code = ConnectCode(code: "TK-ABCD-EFGH", expiresAt: Date(timeIntervalSince1970: 1_800_000_600))
    private let plan = RemoteFixPlan(available: true, actions: [.init(kind: "service", what: "restart serve", status: "planned")])
    private func report(_ json: String) throws -> RemoteReport { try XCTUnwrap(RemoteReport.parse(Data(json.utf8)), json) }
    private func fix(_ json: String, exit: Int32 = 0) -> RemoteFixPlan { RemoteCommand.parseFix(exitCode: exit, Data(json.utf8)) }

    /// Setup's answer when its deadline passed on a tunnel that never connected: only a pending check, and `next` is `remote fix`.
    private func gaveUp() throws -> RemoteReport {
        try report(#"{"ok":false,"state":"problem","code":"resource_metadata","message":"m","connectorUrl":"https://m.ts.net:8443/mcp","#
            + #""next":{"kind":"run_command","command":"polycarp remote fix"},"#
            + #""checks":[{"name":"resource_metadata","status":"fail","detail":"tunnel not connected","pending":true}]}"#)
    }

    // MARK: first-F1

    func testGetItForMeSaysWhyItStopped() {
        let status = RemoteReport(state: .ready, routes: RemoteRoutes(tailscaleInstalled: true))
        let failed = RemoteReport(state: .problem, message: "cloudflared's SHA-256 didn't match, so it wasn't installed.", code: "cloudflared")
        XCTAssertEqual(RemoteFlow.screen(helperAvailable: true, settingUp: false, status: status, setup: failed, chosen: .cloudflare),
                       .getCloudflared(configured: false, problem: failed.message), "the helper's words, under Details")
        XCTAssertEqual(RemoteFlow.screen(helperAvailable: true, settingUp: false, status: status, setup: nil, chosen: .cloudflare),
                       .getCloudflared(configured: false, problem: nil), "nothing tried yet: nothing to say")
        XCTAssertEqual(RemoteFlow.screen(helperAvailable: true, settingUp: false, status: status, setup: RemoteReport(state: .problem), chosen: .cloudflare),
                       .getCloudflared(configured: false, problem: nil), "an answer with no words adds no empty Details")
    }

    // MARK: first-F2

    func testSecretsLeaveSetupsAnswerToo() throws {
        let on = try report(#"{"ok":true,"state":"on","connectorUrl":"https://m.ts.net:8443/mcp","passcode":"horse-battery","#
            + #""connectCode":"TK-ABCD-EFGH","connectCodeExpiresAt":1800000600000}"#)
        XCTAssertNotNil(on.passcode); XCTAssertNotNil(on.connectCode)
        var s = RemoteSession()
        _ = s.take(on, pressed: true, now: start)
        XCTAssertEqual(s.passcode, "horse-battery")
        XCTAssertEqual(s.connectCode?.code, "TK-ABCD-EFGH")
        XCTAssertNil(s.setup?.passcode, "setup's answer keeps no copy of the passcode")
        XCTAssertNil(s.setup?.connectCode, "or of the code")
        XCTAssertTrue(s.setup?.passcodeSet ?? false, "only the fact that one exists")
        s.clearSecrets()
        XCTAssertNil(s.passcode); XCTAssertNil(s.connectCode)
        XCTAssertNil(s.setup?.passcode); XCTAssertNil(s.setup?.connectCode)
        XCTAssertNotNil(s.setup, "the step itself stays")
    }

    // MARK: first-F3

    func testAStepsCommandComesFromTheAnswerOnScreen() throws {
        let operatorCmd = "sudo tailscale set --operator=$USER"
        let status = try report(#"{"ok":false,"state":"problem","code":"tailscale_operator","message":"denied","connectorUrl":"https://m.ts.net:8443/mcp","#
            + #""next":{"kind":"copy_command","command":"sudo tailscale set --operator=$USER"}}"#)
        let fromStatus = RemoteFlow.shown(helperAvailable: true, settingUp: false, status: status, setup: nil)
        XCTAssertEqual(fromStatus.screen, .problem(code: "tailscale_operator", message: "denied"))
        XCTAssertEqual(fromStatus.answer?.nextCommand, operatorCmd, "a status read's step shows its own command")
        XCTAssertEqual(RemoteSharedCopy.steps["tailscale_operator"]?.kind, "copy_command")

        // An older setup answer that only bridged (on, past its grace) must not lend the step its `next`.
        let oldOn = try report(#"{"ok":true,"state":"on","connectorUrl":"https://m.ts.net:8443/mcp","next":{"kind":"run_command","command":"polycarp remote test"}}"#)
        let stale = RemoteFlow.shown(helperAvailable: true, settingUp: false, status: status, setup: oldOn, setupAge: 3600)
        XCTAssertEqual(stale.screen, .problem(code: "tailscale_operator", message: "denied"))
        XCTAssertEqual(stale.answer, status)

        // A refusal setup is showing speaks for its own step.
        let refusal = RemoteReport(state: .problem, message: "taken", code: "cloudflare_dns", nextKind: "choose_name")
        let fromSetup = RemoteFlow.shown(helperAvailable: true, settingUp: false, status: RemoteReport(state: .ready), setup: refusal)
        XCTAssertEqual(fromSetup.answer, refusal)
        XCTAssertEqual(RemoteFlow.screen(helperAvailable: true, settingUp: false, status: status, setup: nil), fromStatus.screen, "screen is shown's screen")
    }

    // MARK: first-F4

    func testAFailedRepairPointsOnlyAtWordsItShows() throws {
        let stopped = fix(#"{"ok":false,"state":"problem","message":"tailscale serve refused: permission denied","actions":[]}"#, exit: 3)
        XCTAssertEqual(stopped.message, "tailscale serve refused: permission denied")
        let note = try XCTUnwrap(RemoteFlow.repairNote(stopped))
        XCTAssertEqual(note.note, RemoteCopy.repairFailed)
        XCTAssertEqual(note.details, stopped.message, "Details has the helper's words")

        for silent in [fix("not json"), fix(#"{"ok":false,"actions":[]}"#), RemoteFixPlan(available: false)] {
            let n = try XCTUnwrap(RemoteFlow.repairNote(silent))
            XCTAssertEqual(n.note, RemoteCopy.repairFailedSilent)
            XCTAssertNil(n.details)
            XCTAssertFalse(n.note.contains("Details"), "no words: the note points at nothing")
        }
        XCTAssertNil(RemoteFlow.repairNote(fix(#"{"ok":true,"actions":[]}"#)), "a Repair that finished says nothing")
        XCTAssertEqual(fix(#"{"ok":false,"message":"\#(String(repeating: "x", count: 400))","actions":[]}"#).message?.count, 300, "capped")
    }

    // MARK: first-F5

    func testLeavingPausesAndComingBackResumesTheRetry() {
        var s = RemoteSession()
        XCTAssertEqual(s.startWatching(now: start), [], "nothing to resume")
        XCTAssertEqual(s.take(RemoteReport(state: .funnelNotAllowed, adminURL: admin), pressed: true, now: start), [.open(admin), .startFunnelTimer])
        XCTAssertEqual(s.take(RemoteReport(state: .funnelNotAllowed, adminURL: admin), pressed: false, now: start + 15), [.startFunnelTimer], "the page opens once per refusal run")
        XCTAssertEqual(s.startWatching(now: start + 20), [], "a second view resumes nothing")
        XCTAssertEqual(s.stopWatching(), [])
        XCTAssertEqual(s.stopWatching(), [.pause], "the last one pauses")
        XCTAssertNotNil(s.funnel.firstRefusal, "leaving keeps the retry's clock")
        // Ten minutes away: it comes back with a fresh ten minutes and tries at once.
        XCTAssertEqual(s.startWatching(now: start + 700), [.startFunnelTimer])
        XCTAssertEqual(s.funnelTick(busy: false, now: start + 701), .run)
        XCTAssertFalse(s.funnel.gaveUp)
        XCTAssertEqual(s.stopWatching(), [.pause])
        XCTAssertEqual(s.stopWatching(), [], "never below zero")
        XCTAssertEqual(s.watchers, 0)
    }

    func testOnlyAPressAsksForAndTakesAConnectCode() throws {
        var s = RemoteSession()
        _ = s.take(RemoteReport(state: .funnelNotAllowed, adminURL: admin), pressed: true, now: start)
        let quiet = s.setupStarts(quiet: true, now: start + 15)
        XCTAssertFalse(quiet.connectCode, "the Funnel retry asks for no code")
        XCTAssertEqual(quiet.effects, [], "and keeps running")
        XCTAssertEqual(s.funnel.lastTry, start + 15)
        let on = RemoteReport(ok: true, state: .on, connectorURL: "https://m.ts.net:8443/mcp", connectCode: code)
        _ = s.take(on, pressed: false, now: start + 16)
        XCTAssertNil(s.connectCode, "an answer nobody pressed for brings no code")

        let pressed = s.setupStarts(quiet: false, now: start + 20)
        XCTAssertTrue(pressed.connectCode)
        XCTAssertEqual(pressed.effects, [.stopFunnelTimer], "a press ends the retry")
        XCTAssertNil(s.funnel.firstRefusal)
        _ = s.take(on, pressed: true, now: start + 21)
        XCTAssertEqual(s.connectCode, code)

        var r = RemoteSession()
        var stuck = try gaveUp()
        stuck.connectCode = code
        XCTAssertEqual(r.take(stuck, pressed: true, now: start), [.stopFunnelTimer, .planFix], "it plans Repair")
        XCTAssertNil(r.connectCode, "an answer that needs repair is not on: no code")
    }

    func testTheOnScreenChecksOncePerVisitAndPlansForRealFailures() {
        var s = RemoteSession()
        let on = RemoteReport(ok: true, state: .on, connectorURL: "https://m.ts.net:8443/mcp", checks: [RemoteCheck(name: "tls", status: "fail")])
        XCTAssertEqual(s.take(on, pressed: true, now: start), [.stopFunnelTimer, .planFix, .recheckIfWaiting])
        XCTAssertFalse(s.startTest(force: false), "setup's proof was this visit's test")
        XCTAssertTrue(s.startTest(force: true), "Check again always runs")
        _ = s.startWatching(now: start); _ = s.stopWatching()
        XCTAssertTrue(s.startTest(force: false), "a new visit tests once")
        XCTAssertEqual(s.tested(RemoteReport(state: .on, checks: [RemoteCheck(name: "tls", status: "ok")])), [.recheckIfWaiting])
        XCTAssertEqual(s.checks.map(\.status), ["ok"])
        XCTAssertEqual(s.tested(nil), [.recheckIfWaiting], "no answer keeps the old checks")
        XCTAssertEqual(s.checks.map(\.status), ["ok"])
    }

    // MARK: second-F6

    func testRepairCanBePressedAgainOnAnAnswerThatNamesRemoteFix() throws {
        var s = RemoteSession()
        XCTAssertTrue(try s.take(gaveUp(), pressed: true, now: start).contains(.planFix))
        s.planned(plan)
        XCTAssertTrue(s.offersRepair, "Repair shows for it")
        XCTAssertTrue(s.wantsRepair)
        // Repair stops, and its checks are still only pending: the plan is asked for again, so the button comes back.
        let done = fix(#"{"ok":false,"state":"problem","message":"tunnel still not connected","actions":[],"#
            + #""checks":[{"name":"resource_metadata","status":"fail","pending":true}]}"#, exit: 3)
        XCTAssertEqual(s.repaired(done), [.planFix, .recheckIfWaiting])
        XCTAssertNil(s.fixPlan, "the old plan is spent")
        s.planned(plan)
        XCTAssertTrue(s.offersRepair, "the step can be repaired again")

        // Nothing left to repair: no new plan.
        var ok = RemoteSession()
        _ = ok.take(RemoteReport(ok: true, state: .on, connectorURL: "https://m.ts.net:8443/mcp", checks: [RemoteCheck(name: "tls", status: "fail")]), pressed: true, now: start)
        ok.planned(plan)
        XCTAssertEqual(ok.repaired(fix(#"{"ok":true,"actions":[],"checks":[{"name":"tls","status":"ok"}]}"#)), [.recheckIfWaiting])
        XCTAssertFalse(ok.offersRepair)
    }

    // MARK: Turning off

    func testTurningOffKeepsNothingFromTheOldRoute() {
        var s = RemoteSession()
        _ = s.take(RemoteReport(ok: true, state: .on, connectorURL: "https://m.ts.net:8443/mcp", passcode: "p",
                                checks: [RemoteCheck(name: "tls", status: "fail")], connectCode: code), pressed: true, now: start)
        s.planned(plan)
        XCTAssertEqual(s.turnedOff(), [.stopFunnelTimer])
        XCTAssertNil(s.setup); XCTAssertNil(s.passcode); XCTAssertNil(s.connectCode); XCTAssertNil(s.fixPlan)
        XCTAssertEqual(s.checks, [])
    }

    // MARK: second-F7

    func testDnsLookupHasItsOwnStep() throws {
        XCTAssertEqual(RemoteSharedCopy.key(state: "problem", code: "dns_lookup"), "dns_lookup")
        XCTAssertTrue(RemoteSharedCopy.problemCodes.contains("dns_lookup"))
        let entry = try XCTUnwrap(RemoteSharedCopy.steps["dns_lookup"])
        XCTAssertEqual(entry.kind, "check_again", "its button checks again; running setup again can't fix DNS records")
        XCTAssertFalse(entry.waits, "waiting doesn't fix it")
        XCTAssertTrue(entry.body?.contains("DNSSEC") ?? false)
        let status = try report(#"{"ok":false,"state":"problem","code":"dns_lookup","message":"public DNS: SERVFAIL","connectorUrl":"https://a.example.com/mcp"}"#)
        XCTAssertEqual(RemoteSharedCopy.copy(for: status).key, "dns_lookup")
        XCTAssertFalse(status.answerOn, "a failed lookup is not a name still publishing")
        XCTAssertEqual(RemoteFlow.screen(helperAvailable: true, settingUp: false, status: status, setup: nil),
                       .problem(code: "dns_lookup", message: "public DNS: SERVFAIL"))
    }
}
