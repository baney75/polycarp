import XCTest
@testable import BaneySpacesCore

/// PR 134 review round 1: the Funnel retry survives leaving Settings, a quiet retry changes the screen only for a real change,
/// a Cloudflare step's Turn on stays on Cloudflare, secrets last until the window closes, the name step's words fit it, a
/// failed probe cleanup isn't a pass, and an answer that names `remote fix` is a problem to repair (PR 133's second-N2).
final class BrowserRemoteReviewR1Tests: XCTestCase {
    private let admin = URL(string: "https://login.tailscale.com/admin/machines")!
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private func report(_ json: String) throws -> RemoteReport { try XCTUnwrap(RemoteReport.parse(Data(json.utf8)), json) }
    private func source(_ path: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }
    private let view = "Sources/BaneySpaces/BrowserRemoteView.swift"

    /// The text of one function in the view, from its declaration to the next `func`.
    private func body(of name: String) throws -> String {
        let src = try source(view)
        let from = try XCTUnwrap(src.range(of: "func \(name)("), name)
        let rest = src[from.upperBound...]
        let end = rest.range(of: #"\n    (@ViewBuilder )?(private )?func "#, options: .regularExpression)?.lowerBound ?? rest.endIndex
        return String(rest[..<end])
    }

    // MARK: first-F1

    func testComingBackResumesTheFunnelRetryWithoutReopeningThePage() {
        let refusal = RemoteReport(state: .funnelNotAllowed, adminURL: admin)
        var retry = FunnelRetry()
        XCTAssertEqual(retry.refused(admin: admin, now: start), admin, "the first refusal opens Tailscale's page")
        XCTAssertNil(retry.refused(admin: admin, now: start + 15), "once per refusal run")
        // Ten minutes away: the old clock would have given up, the resumed one starts fresh and tries at once.
        let back = start + 700
        XCTAssertTrue(retry.resume(setup: refusal, now: back))
        XCTAssertFalse(retry.gaveUp)
        XCTAssertEqual(retry.tick(setup: refusal, busy: false, now: back + 1), .run, "Funnel may have been allowed meanwhile")
        XCTAssertNil(retry.refused(admin: admin, now: back + 2), "coming back never reopens the page")
        retry.tried(now: back + 2)
        XCTAssertEqual(retry.tick(setup: refusal, busy: false, now: back + 5), .wait)
        XCTAssertEqual(retry.tick(setup: refusal, busy: false, now: back + 601), .gaveUp)
        XCTAssertTrue(retry.gaveUp)

        var fresh = FunnelRetry()
        XCTAssertTrue(fresh.resume(setup: refusal, now: back), "a window reopened on the refusal resumes too")
        XCTAssertNil(fresh.refused(admin: admin, now: back), "the page counts as opened")
        XCTAssertFalse(fresh.resume(setup: RemoteReport(state: .ready), now: back), "nothing to resume on any other step")
        XCTAssertFalse(fresh.resume(setup: nil, now: back))
    }

    // MARK: first-F2

    func testAQuietRetryOnlyTakesARealChange() throws {
        XCTAssertNil(RemoteFlow.setupOutcome(nil, quiet: true), "a timeout or text that isn't JSON leaves the screen as it is")
        XCTAssertNil(RemoteFlow.setupOutcome(RemoteReport(state: .funnelNotAllowed, adminURL: admin), quiet: true), "the same refusal")
        let on = try report(#"{"ok":true,"state":"on","connectorUrl":"https://m.ts.net:8443/mcp"}"#)
        XCTAssertEqual(RemoteFlow.setupOutcome(on, quiet: true), on, "allowed: the screen moves on")
        let other = RemoteReport(state: .problem, message: "m", code: "serve")
        XCTAssertEqual(RemoteFlow.setupOutcome(other, quiet: true), other, "a new problem is a real change")
        XCTAssertEqual(RemoteFlow.setupOutcome(nil, quiet: false)?.message, RemoteCopy.helperSilent, "a press always answers")
    }

    // MARK: first-F3

    func testACloudflareStepsTurnOnStaysOnCloudflare() throws {
        for key in ["cloudflare_name", "cloudflare_name_refused", "cloudflare_zone"] {
            XCTAssertEqual(RemoteFlow.turnOnStep(key: key, last: .setup), .askName, key)
            XCTAssertEqual(RemoteFlow.turnOnStep(key: key, last: .setupCloudflare("old.example.com")), .askName, "\(key): a refused name isn't tried again")
            XCTAssertEqual(Shared.steps[key]?.kind, "turn_on", key)
        }
        XCTAssertEqual(RemoteFlow.turnOnStep(key: "unknown", last: .setupCloudflare("a.example.com")), .run(.setupCloudflare("a.example.com")))
        XCTAssertEqual(RemoteFlow.turnOnStep(key: "unknown", last: .setup), .run(.setup))
        // Every turn_on step a problem can show is a name step: none of them may fall back to plain (Tailscale) setup.
        for (key, entry) in Shared.steps where entry.kind == "turn_on" && key != "ready" {
            XCTAssertTrue(RemoteFlow.cloudflareNameKeys.contains(key), "\(key) turns on without a route")
        }
        let act = try body(of: "act")
        XCTAssertFalse(act.contains("case \"turn_on\", \"open_funnel\": model.turnOn()"), "turn_on no longer runs plain setup")
        XCTAssertTrue(act.contains("model.turnOn(step: key"))
        XCTAssertTrue(try body(of: "problemView").contains("nameField"), "the name step keeps its field wherever it shows")
    }

    private typealias Shared = RemoteSharedCopy

    // MARK: first-F4 and second-S2

    func testSecretsLastUntilTheWindowCloses() throws {
        var s = RemoteSession()
        _ = s.take(RemoteReport(ok: true, state: .on, connectorURL: "https://m.ts.net:8443/mcp", passcode: "p"), pressed: true, now: start)
        _ = s.startWatching(now: start)
        XCTAssertEqual(s.stopWatching(), [.pause])
        XCTAssertEqual(s.passcode, "p", "a tab switch keeps the passcode shown once")
        let setup = try source("Sources/BaneySpaces/Setup.swift")
        let close = try XCTUnwrap(setup.range(of: "func windowWillClose(_ n: Notification) {"))
        let closeBody = setup[close.upperBound...].prefix(400)
        XCTAssertTrue(closeBody.contains("BrowserRemoteModel.shared.clearSecrets()"), "closing Settings forgets them")
    }

    func testTheHelperSilentStepShowsThePasscode() throws {
        let problem = try body(of: "problemView")
        let branch = try XCTUnwrap(problem.range(of: "if code == RemoteCopy.helperSilentCode {"))
        let elseAt = try XCTUnwrap(problem.range(of: "} else {", range: branch.upperBound..<problem.endIndex))
        XCTAssertTrue(problem[branch.upperBound..<elseAt.lowerBound].contains("passcodeShown"))
    }

    // MARK: second-S1

    func testTheAddressStepUsesOnlyNameWords() {
        let status = RemoteReport(state: .ready, routes: RemoteRoutes(tailscaleInstalled: true, cloudflareInstalled: true, cloudflareSignedIn: true))
        let setup = RemoteReport(state: .problem, message: "cert.pem is stale", code: "cloudflare_login")
        let screen = RemoteFlow.screen(helperAvailable: true, settingUp: false, status: status, setup: setup, chosen: .cloudflare)
        XCTAssertEqual(screen, .cloudflareAddress(problem: "cert.pem is stale", code: "cloudflare_login"))
        XCTAssertEqual(RemoteFlow.addressStepKey(code: "cloudflare_login", nextKind: nil), "cloudflare_name", "a sign-in sentence over a name field")
        XCTAssertEqual(RemoteFlow.addressStepKey(code: "cloudflare_tunnel", nextKind: nil), "cloudflare_name")
        XCTAssertEqual(RemoteFlow.addressStepKey(code: "serve", nextKind: nil), "cloudflare_name")
        XCTAssertEqual(RemoteFlow.addressStepKey(code: nil, nextKind: nil), "cloudflare_name")
        XCTAssertEqual(RemoteFlow.addressStepKey(code: "cloudflare_zone", nextKind: "choose_name"), "cloudflare_zone")
        XCTAssertEqual(RemoteFlow.addressStepKey(code: "cloudflare_dns", nextKind: "choose_name"), "cloudflare_name_refused")
        XCTAssertEqual(RemoteFlow.addressStepKey(code: "cloudflare_dns", nextKind: nil), "cloudflare_dns")
        XCTAssertEqual(RemoteFlow.addressStepKey(code: "cloudflare_name", nextKind: nil), "cloudflare_name")
    }

    // MARK: second-S3

    func testAFailedProbeCleanupIsNotAPass() throws {
        let test = try report(#"{"ok":false,"state":"on","connectorUrl":"https://m.ts.net:8443/mcp","checks":["#
            + #"{"name":"dns","status":"ok"},{"name":"tls","status":"ok"},{"name":"streaming","status":"ok"},"#
            + #"{"name":"probe_cleanup","status":"fail","detail":"The probe's token couldn't be deleted; it expires on its own."}]}"#)
        XCTAssertEqual(test.checks.map(\.name), ["dns", "tls", "streaming", "probe_cleanup"])
        XCTAssertEqual(test.failedChecks.map(\.name), ["probe_cleanup"])
        XCTAssertEqual(RemoteFlow.resultHead(checks: test.checks, answer: test, browserConnected: true).head, "check_failed")
        XCTAssertEqual(RemoteCopy.checkLabel("probe_cleanup"), "Test token removed")
        XCTAssertEqual(RemoteCopy.checkLabel("dns"), Shared.checkLabels["dns"])
        XCTAssertNil(Shared.checkLabels["probe_cleanup"], "a Mac label, so the shared table stays the panel's")
        XCTAssertEqual(Shared.key(state: "problem", code: "probe_cleanup"), "unknown", "not a setup check code")
    }

    // MARK: PR 133 second-N2, the Mac side

    func testAnAnswerThatNamesRemoteFixIsAProblemToRepair() throws {
        let gaveUp = try report(#"{"ok":false,"state":"problem","code":"resource_metadata","message":"m","connectorUrl":"https://m.ts.net:8443/mcp","#
            + #""next":{"kind":"run_command","command":"polycarp remote fix"},"#
            + #""checks":[{"name":"resource_metadata","status":"fail","detail":"tunnel not connected","pending":true}]}"#)
        XCTAssertTrue(gaveUp.needsRepair)
        XCTAssertFalse(gaveUp.answerOn, "not a name still being published")
        XCTAssertEqual(RemoteFlow.screen(helperAvailable: true, settingUp: false, status: nil, setup: gaveUp), .problem(code: "resource_metadata", message: "m"))
        XCTAssertEqual(Shared.copy(for: gaveUp).key, "check_failed")
        XCTAssertEqual(Shared.steps["check_failed"]?.kind, "repair", "its one button is Repair")
        let plan = RemoteFixPlan(available: true, actions: [.init(kind: "service", what: "restart serve", status: "planned")])
        XCTAssertFalse(RemoteFlow.offerRepair(checks: gaveUp.checks, plan: plan), "its only check is pending")
        XCTAssertTrue(RemoteFlow.offerRepair(checks: gaveUp.checks, plan: plan, answer: gaveUp), "Repair runs for it")
        XCTAssertFalse(RemoteFlow.offerRepair(checks: gaveUp.checks, plan: RemoteFixPlan(available: false), answer: gaveUp), "only with remote fix")
        var s = RemoteSession()
        _ = s.take(gaveUp, pressed: true, now: start)
        s.planned(plan)
        XCTAssertTrue(s.offersRepair, "the button's press isn't dropped")

        let soon = try report(#"{"ok":false,"state":"problem","code":"resource_metadata","connectorUrl":"https://m.ts.net:8443/mcp","#
            + #""next":{"kind":"run_command","command":"polycarp remote test"},"#
            + #""checks":[{"name":"resource_metadata","status":"fail","pending":true}]}"#)
        XCTAssertFalse(soon.needsRepair)
        XCTAssertTrue(soon.answerOn, "a tunnel still connecting is on and waiting")
        XCTAssertFalse(RemoteReport(state: .problem, nextKind: "run_command", nextCommand: "polycarp remote fixup").needsRepair)
        XCTAssertTrue(RemoteReport(state: .problem, nextKind: "run_command", nextCommand: "remote fix --yes").needsRepair)
        XCTAssertFalse(RemoteReport(state: .problem, nextKind: "copy_command", nextCommand: "polycarp remote fix").needsRepair)
    }
}

/// second-S4: the Swift key() and remote-copy.ts's copyKey pick the same entry for the same answers, row by row, from one
/// fixture that test/remote-copy.test.mjs asserts too.
final class BrowserRemoteKeyFixtureTests: XCTestCase {
    func testKeyMatchesTheSharedFixture() throws {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: repo.appendingPathComponent("browser/test/fixtures/remote-copy-keys.json"))
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 40, "the fixture lost its rows")
        for row in cases {
            let state = try XCTUnwrap(row["state"] as? String)
            let next = row["next"] as? [String: Any]
            let want = (row["macKey"] as? String) ?? (row["key"] as? String)
            let got = RemoteSharedCopy.key(state: state, code: row["code"] as? String, nextKind: next?["kind"] as? String, nextCommand: next?["command"] as? String)
            XCTAssertEqual(got, want, "\(row)")
        }
    }
}
