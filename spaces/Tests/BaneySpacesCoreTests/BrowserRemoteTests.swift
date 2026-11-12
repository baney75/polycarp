import XCTest
@testable import BaneySpacesCore

/// Settings > Browser > "Use your browser from Claude, ChatGPT and Grok": the helper's JSON, the one step on screen, and the
/// words. The helper's own tests (browser/cli/test/remote-json.test.mjs) pin the JSON it prints.
final class BrowserRemoteTests: XCTestCase {
    private func report(_ json: String) throws -> RemoteReport { try XCTUnwrap(RemoteReport.parse(Data(json.utf8)), json) }

    // MARK: Parsing

    func testEveryStateTheHelperNamesParses() throws {
        for state in RemoteState.allCases {
            XCTAssertEqual(try report(#"{"state":"\#(state.rawValue)"}"#).state, state)
        }
        XCTAssertEqual(RemoteState.allCases.count, 11, "the helper's REMOTE_STATES")
    }

    func testAnUnknownStateIsAProblemNotABlankWindow() throws {
        XCTAssertEqual(try report(#"{"state":"from_the_future","message":"hi"}"#).state, .problem)
    }

    func testStatusAnswerIsRead() throws {
        let r = try report(#"""
        {"ok":true,"state":"no_browser_connected","message":"m","route":"funnel","publicUrl":"https://mac.example.ts.net:8443",
         "connectorUrl":"https://mac.example.ts.net:8443/mcp","passcodeSet":true,"extensionConnected":false,"oauthClients":0,"checks":[]}
        """#)
        XCTAssertEqual(r.state, .noBrowserConnected)
        XCTAssertEqual(r.connectorURL, "https://mac.example.ts.net:8443/mcp")
        XCTAssertTrue(r.passcodeSet)
        XCTAssertEqual(r.extensionConnected, false)
        XCTAssertNil(r.passcode, "status never carries the passcode")
    }

    func testStatusWithNothingSetUpHasNullFields() throws {
        let r = try report(#"{"ok":false,"state":"ready","route":null,"publicUrl":null,"connectorUrl":null,"passcodeSet":false,"extensionConnected":null,"checks":[]}"#)
        XCTAssertEqual(r.state, .ready)
        XCTAssertNil(r.connectorURL)
        XCTAssertNil(r.extensionConnected)
    }

    func testSetupSuccessCarriesThePasscodeOnce() throws {
        let r = try report(#"{"ok":true,"state":"on","message":"Connector ready.","connectorUrl":"https://m.ts.net:8443/mcp","passcode":"abcde-fghij-klmno-pqrst","passcodeSet":true}"#)
        XCTAssertEqual(r.passcode, "abcde-fghij-klmno-pqrst")
        let again = try report(#"{"ok":true,"state":"on","message":"Connector ready.","connectorUrl":"https://m.ts.net:8443/mcp","passcodeSet":true}"#)
        XCTAssertNil(again.passcode)
        XCTAssertTrue(again.passcodeSet)
    }

    func testFunnelNotAllowedKeepsTheAdminPageAndTheNewPasscode() throws {
        let r = try report(#"{"ok":false,"state":"funnel_not_allowed","message":"m","adminUrl":"https://login.tailscale.com/f/funnel?node=n1","passcode":"abcde-fghij-klmno-pqrst","passcodeSet":true}"#)
        XCTAssertEqual(r.adminURL?.absoluteString, "https://login.tailscale.com/f/funnel?node=n1")
        XCTAssertEqual(r.passcode, "abcde-fghij-klmno-pqrst")
    }

    func testOnlyTailscaleAddressesOpenFromTheHelpersOutput() throws {
        for bad in ["https://evil.example/login.tailscale.com/x", "http://login.tailscale.com/x", "https://nottailscale.com/x", "https://tailscale.com.evil.example/x", "file:///etc/passwd", "javascript:alert(1)"] {
            XCTAssertNil(try report(#"{"state":"funnel_not_allowed","adminUrl":"\#(bad)"}"#).adminURL, bad)
        }
        XCTAssertNotNil(try report(#"{"state":"funnel_not_allowed","adminUrl":"https://tailscale.com/s/https"}"#).adminURL)
    }

    func testAConnectorAddressMustEndInMCP() throws {
        XCTAssertNil(try report(#"{"state":"on","connectorUrl":"https://m.ts.net:8443/other"}"#).connectorURL)
        XCTAssertNil(try report(#"{"state":"on","connectorUrl":"ftp://m.ts.net/mcp"}"#).connectorURL)
        XCTAssertEqual(try report(#"{"state":"on","connectorUrl":"https://tabkyra.example.com/mcp"}"#).connectorURL, "https://tabkyra.example.com/mcp")
    }

    func testGarbageIsNotAReport() {
        XCTAssertNil(RemoteReport.parse(Data("tabkyra: command not found".utf8)))
        XCTAssertNil(RemoteReport.parse(Data("{}".utf8)))
        XCTAssertNil(RemoteReport.parse(Data(#"{"state":3}"#.utf8)))
        XCTAssertNil(RemoteReport.parse(Data()))
    }

    // MARK: The one step on screen

    private func screen(settingUp: Bool = false, status: RemoteReport? = nil, setup: RemoteReport? = nil, available: Bool = true, age: TimeInterval = 0,
                        readsFailing: Bool = false) -> RemoteScreen {
        RemoteFlow.screen(helperAvailable: available, settingUp: settingUp, status: status, setup: setup, setupAge: age, readsFailing: readsFailing)
    }
    private let url = "https://m.ts.net:8443/mcp"

    func testEachStatusIsOneStep() {
        XCTAssertEqual(screen(), .checking)
        XCTAssertEqual(screen(available: false), .unavailable)
        XCTAssertEqual(screen(status: .init(state: .tailscaleMissing)), .getTailscale(configured: false))
        XCTAssertEqual(screen(status: .init(state: .tailscaleSignedOut)), .signIn(configured: false))
        XCTAssertEqual(screen(status: .init(state: .tailnetLock)), .tailnetLock(configured: false))
        XCTAssertEqual(screen(status: .init(state: .portBusy)), .portBusy(tailscaleSetting: false, detail: ""))
        XCTAssertEqual(screen(status: .init(state: .ready)), .ready)
        XCTAssertEqual(screen(status: .init(state: .on, connectorURL: url, extensionConnected: true)), .on(connectorURL: url, browserConnected: true))
        XCTAssertEqual(screen(status: .init(state: .noBrowserConnected, connectorURL: url, extensionConnected: false)), .on(connectorURL: url, browserConnected: false))
        XCTAssertEqual(screen(status: .init(state: .problem, message: "public DNS: x")), .problem(code: nil, message: "public DNS: x"))
        XCTAssertEqual(screen(status: .init(state: .problem, code: "service")), .problem(code: "service", message: ""))
    }

    func testTurningOnShowsProgressWhateverStatusSays() {
        XCTAssertEqual(screen(settingUp: true, status: .init(state: .ready)), .turningOn)
        XCTAssertEqual(screen(settingUp: true), .turningOn)
    }

    func testInstallingTailscaleMovesTheWindowOnByItself() {
        // Each poll replaces the status; no click in between.
        let states: [RemoteState] = [.tailscaleMissing, .tailscaleSignedOut, .ready]
        XCTAssertEqual(states.map { screen(status: .init(state: $0)) }, [.getTailscale(configured: false), .signIn(configured: false), .ready])
    }

    func testAFunnelRefusalStaysOnScreenWhileStatusSaysItIsHalfDone() {
        let admin = URL(string: "https://login.tailscale.com/f/funnel?node=n1")
        let refused = RemoteReport(state: .funnelNotAllowed, adminURL: admin, passcodeSet: true)
        // After a refusal the helper's status reads "problem": remote.json is kept and the address isn't reachable.
        let half = RemoteReport(state: .problem, message: "public DNS: …")
        XCTAssertEqual(screen(status: half, setup: refused), .funnelNotAllowed(adminURL: admin))
        // Tailscale going away is more basic than the refusal.
        XCTAssertEqual(screen(status: .init(state: .tailscaleSignedOut), setup: refused), .signIn(configured: false))
        XCTAssertEqual(screen(status: .init(state: .tailnetLock), setup: refused), .tailnetLock(configured: false))
    }

    func testASetupRefusalForOtherReasonsShowsItsOwnStep() {
        XCTAssertEqual(screen(status: .init(state: .ready), setup: .init(state: .portBusy)), .portBusy(tailscaleSetting: false, detail: ""))
        XCTAssertEqual(screen(status: .init(state: .ready), setup: .init(state: .problem, message: "boom")), .problem(code: nil, message: "boom"))
        XCTAssertEqual(screen(status: .init(state: .ready), setup: .init(state: .problem, code: "launcher")), .needsBrowser)
    }

    func testSuccessIsAShortBridgeNotALastingState() {
        let done = RemoteReport(ok: true, state: .on, connectorURL: url, passcode: "abcde-fghij-klmno-pqrst", passcodeSet: true)
        XCTAssertEqual(screen(setup: done), .on(connectorURL: url, browserConnected: true), "before the first status read")
        // Inside the grace period a status that hasn't caught up (DNS or Funnel lag) doesn't undo it.
        XCTAssertEqual(screen(status: .init(state: .problem), setup: done, age: 5), .on(connectorURL: url, browserConnected: true))
        // Once the grace is over, whatever status says takes over: signed out, a dead service, or a `remote off` in a terminal.
        let over = RemoteFlow.setupGrace + 1
        XCTAssertEqual(screen(status: .init(state: .tailscaleSignedOut), setup: done, age: over), .signIn(configured: false))
        XCTAssertEqual(screen(status: .init(state: .problem, message: "local serve: down"), setup: done, age: over), .problem(code: nil, message: "local serve: down"))
        XCTAssertEqual(screen(status: .init(state: .ready), setup: done, age: over), .ready)
        // A status that confirms it speaks for itself at once, whatever the age.
        XCTAssertEqual(screen(status: .init(state: .noBrowserConnected, connectorURL: url, extensionConnected: false), setup: done), .on(connectorURL: url, browserConnected: false))
        XCTAssertEqual(screen(status: .init(state: .on, connectorURL: url, extensionConnected: true), setup: done, age: over), .on(connectorURL: url, browserConnected: true))
    }

    func testAStatusThatConfirmsTheSuccessEndsTheBridge() {
        let done = RemoteReport(ok: true, state: .on, connectorURL: url, passcodeSet: true)
        XCTAssertNil(RemoteFlow.settle(setup: done, status: .init(state: .on, connectorURL: url, extensionConnected: true)))
        XCTAssertNil(RemoteFlow.settle(setup: done, status: .init(state: .noBrowserConnected, connectorURL: url, extensionConnected: false)))
        XCTAssertEqual(RemoteFlow.settle(setup: done, status: .init(state: .problem)), done, "a status that hasn't caught up leaves the bridge to the grace period")
        XCTAssertNil(RemoteFlow.settle(setup: nil, status: .init(state: .ready)))
    }

    func testARetainedRefusalAboutTailscaleEndsWhenThatBlockerIsGone() {
        let signedOut = RemoteReport(state: .tailscaleSignedOut)
        // Still signed out: the refusal stays. Signed in again (status ready): it is cleared, with no click.
        XCTAssertEqual(RemoteFlow.settle(setup: signedOut, status: .init(state: .tailscaleSignedOut)), signedOut)
        XCTAssertNil(RemoteFlow.settle(setup: signedOut, status: .init(state: .ready)))
        XCTAssertNil(RemoteFlow.settle(setup: .init(state: .tailscaleMissing), status: .init(state: .tailscaleSignedOut)), "installed now, so the step moves on")
        XCTAssertNil(RemoteFlow.settle(setup: .init(state: .tailnetLock), status: .init(state: .ready)))
        // The Funnel refusal isn't about Tailscale itself: status "ready" can't clear it (and the helper can't say it after one).
        let refused = RemoteReport(state: .funnelNotAllowed)
        XCTAssertEqual(RemoteFlow.settle(setup: refused, status: .init(state: .problem)), refused)
        XCTAssertEqual(screen(status: .init(state: .ready), setup: signedOut), .signIn(configured: false), "before the status read that clears it, the refusal still shows")
    }

    func testTwoFailedReadsInARowSayTheHelperIsSilent() {
        XCTAssertEqual(RemoteFlow.readFailureLimit, 2)
        XCTAssertEqual(screen(readsFailing: true), .problem(code: RemoteCopy.helperSilentCode, message: RemoteCopy.helperSilent), "a first read that never answers isn't Looking… forever")
        XCTAssertEqual(screen(status: .init(state: .on, connectorURL: url, extensionConnected: true), setup: nil, readsFailing: false), .on(connectorURL: url, browserConnected: true))
        XCTAssertEqual(screen(status: .init(state: .ready), readsFailing: true), .problem(code: RemoteCopy.helperSilentCode, message: RemoteCopy.helperSilent), "and a later failure doesn't leave the old state up as current")
        // An old "On" doesn't stay up either: with the helper silent the window can't know remote access still works.
        XCTAssertEqual(screen(status: .init(state: .on, connectorURL: url, extensionConnected: true), readsFailing: true), .problem(code: RemoteCopy.helperSilentCode, message: RemoteCopy.helperSilent))
        XCTAssertEqual(screen(status: .init(state: .noBrowserConnected, connectorURL: url, extensionConnected: false), readsFailing: true), .problem(code: RemoteCopy.helperSilentCode, message: RemoteCopy.helperSilent))
        XCTAssertEqual(screen(settingUp: true, readsFailing: true), .turningOn)
    }

    func testABusyConnectionSaysWhichKindAndKeepsTheHelpersWords() throws {
        let tailscale = try report(#"{"ok":false,"state":"port_busy","message":"Port 8443 on this machine already forwards TCP traffic to 127.0.0.1:22.","code":"tailscale_port"}"#)
        let local = try report(#"{"ok":false,"state":"port_busy","message":"Something already listens on 127.0.0.1:8787","code":"local_port"}"#)
        XCTAssertEqual(screen(status: tailscale), .portBusy(tailscaleSetting: true, detail: tailscale.message))
        XCTAssertEqual(screen(status: local), .portBusy(tailscaleSetting: false, detail: local.message))
        XCTAssertEqual(screen(status: .init(state: .ready), setup: tailscale), .portBusy(tailscaleSetting: true, detail: tailscale.message))
        XCTAssertTrue(RemoteSharedCopy.steps["tailscale_port"]!.body!.contains("A setting saved in Tailscale"))
        XCTAssertFalse(RemoteSharedCopy.steps["local_port"]!.body!.contains("Tailscale"))
    }

    func testOnWithoutAnAddressIsAProblemNotAnEmptyCard() {
        XCTAssertEqual(screen(status: .init(state: .on)), .problem(code: nil, message: ""))
    }

    func testThePasscodeIsKeptUntilReplaced() {
        XCTAssertEqual(RemoteFlow.keepPasscode(current: nil, from: .init(state: .funnelNotAllowed, passcode: "first")), "first")
        XCTAssertEqual(RemoteFlow.keepPasscode(current: "first", from: .init(state: .funnelNotAllowed)), "first", "a retry that makes none doesn't clear it")
        XCTAssertEqual(RemoteFlow.keepPasscode(current: "first", from: .init(state: .on, passcode: "second")), "second")
    }

    func testPollingIsQuickWhileWaitingAndSlowWheneverStatusSaysItIsSetUp() {
        XCTAssertEqual(RemoteFlow.pollInterval(for: .getTailscale(configured: false)), 4)
        XCTAssertEqual(RemoteFlow.pollInterval(for: .on(connectorURL: url, browserConnected: true)), 30)
        // Half done after a Funnel refusal: remote.json is kept, so a full read (with its internet checks) isn't repeated every 4 s.
        let half = RemoteReport(state: .problem, connectorURL: url)
        XCTAssertEqual(RemoteFlow.pollInterval(for: .funnelNotAllowed(adminURL: nil), status: half), 30)
        // Tailscale itself being the problem is a cheap read, and the window should notice the sign-in.
        XCTAssertEqual(RemoteFlow.pollInterval(for: .signIn(configured: true), status: .init(state: .tailscaleSignedOut, connectorURL: url)), 4)
        XCTAssertEqual(RemoteFlow.pollInterval(for: .ready, status: .init(state: .ready)), 4)
        XCTAssertEqual(RemoteFlow.pollInterval(for: .on(connectorURL: url, browserConnected: true), bridging: true), 4, "just turned on: confirm quickly")
    }

    func testAnInstallThatIsSetUpAndWaitingOnTailscaleIsNotFirstRun() {
        // Funnel route, Tailscale signed out or quit: remote.json is kept and status still carries the address.
        let signedOut = RemoteReport(state: .tailscaleSignedOut, connectorURL: url)
        XCTAssertTrue(signedOut.configured)
        XCTAssertEqual(screen(status: signedOut), .signIn(configured: true))
        XCTAssertEqual(screen(status: .init(state: .tailscaleMissing, connectorURL: url)), .getTailscale(configured: true))
        XCTAssertEqual(screen(status: .init(state: .tailnetLock, connectorURL: url)), .tailnetLock(configured: true))
        // A refusal kept from this session takes its configured-ness from the status read, not from its own answer.
        XCTAssertEqual(screen(status: signedOut, setup: .init(state: .tailscaleSignedOut)), .signIn(configured: true))
        // Nothing set up yet stays the first-run step.
        XCTAssertEqual(screen(status: .init(state: .tailscaleSignedOut)), .signIn(configured: false))
        // The words: no "Nothing was changed" on an install that is already set up, and it says it will resume.
        XCTAssertTrue(RemoteSharedCopy.steps["tailnet_lock"]!.body!.contains("Nothing was changed."))
        XCTAssertTrue(RemoteCopy.stillSetUp.contains("still set up") && RemoteCopy.stillSetUp.contains("picks up again by itself"))
    }

    func testFunnelClosedAfterSetupIsItsOwnStepAndSurvivesARelaunch() {
        // No retained setup report (the app was relaunched): status alone says Funnel is closed.
        let closed = RemoteReport(state: .funnelClosed, connectorURL: url)
        XCTAssertEqual(screen(status: closed), .funnelClosed)
        XCTAssertEqual(RemoteFlow.pollInterval(for: .funnelClosed, status: closed), 30, "set up, so the full read isn't repeated every few seconds")
        // A refusal from the Try again that follows stays on screen over the status that only says Funnel is still closed.
        let refused = RemoteReport(state: .funnelNotAllowed, adminURL: URL(string: "https://login.tailscale.com/f/funnel?node=n1"))
        XCTAssertEqual(screen(status: closed, setup: refused), .funnelNotAllowed(adminURL: refused.adminURL))
        // Tailscale itself going away is still more basic.
        XCTAssertEqual(screen(status: .init(state: .tailscaleSignedOut, connectorURL: url), setup: refused), .signIn(configured: true))
        XCTAssertEqual(RemoteFlow.settle(setup: refused, status: closed), refused)
        XCTAssertEqual(RemoteSharedCopy.steps["funnel_closed"]!.kind, "open_funnel")
    }

    func testPublicDNSLagRightAfterASuccessfulSetupStaysPending() {
        let done = RemoteReport(ok: true, state: .on, connectorURL: url, passcode: "abcde-fghij-klmno-pqrst", passcodeSet: true)
        let dns = RemoteReport(state: .problem, message: "public DNS: no A record", code: "dns", connectorURL: url)
        XCTAssertGreaterThanOrEqual(RemoteFlow.dnsGrace, 600, "Tailscale can take minutes to publish a new Funnel address")
        XCTAssertEqual(RemoteFlow.grace(for: dns), RemoteFlow.dnsGrace)
        XCTAssertEqual(RemoteFlow.grace(for: .init(state: .problem)), RemoteFlow.setupGrace)
        // Past the ordinary grace but inside the DNS one: still On, with the address and passcode.
        let late = RemoteFlow.setupGrace + 30
        XCTAssertEqual(screen(status: dns, setup: done, age: late), .on(connectorURL: url, browserConnected: true))
        XCTAssertEqual(screen(status: .init(state: .problem, message: "local serve: down", connectorURL: url), setup: done, age: late), .problem(code: nil, message: "local serve: down"), "any other problem ends the bridge on time")
        // Past the DNS grace too it stays On and waiting: the name is still being published, not broken (PR 133 first-F1).
        XCTAssertEqual(screen(status: dns, setup: done, age: RemoteFlow.dnsGrace + 1), .on(connectorURL: url, browserConnected: true))
        XCTAssertEqual(try? report(#"{"state":"problem","code":"dns","message":"m","connectorUrl":"\#(url)"}"#).code, "dns")
    }

    // MARK: Commands

    func testTheHelperIsAskedExactlyTheseThings() {
        XCTAssertEqual(RemoteCommand.status.arguments, ["remote", "status", "--json"])
        XCTAssertEqual(RemoteCommand.setup.arguments, ["remote", "setup", "--json", "--connect-code"])
        XCTAssertEqual(RemoteCommand.off.arguments, ["remote", "off"])
        XCTAssertEqual(RemoteCommand.newPasscode.arguments, ["token", "passcode", "--json"])
        XCTAssertFalse(RemoteCommand.setup.arguments.contains("--public-url"), "no hosted address and no cloudflared from the app")
        XCTAssertGreaterThan(RemoteCommand.setup.timeout, 60, "setup waits up to 15 s for the service, then Tailscale")
    }

    func testNewPasscodeAnswer() {
        XCTAssertEqual(RemoteCommand.parsePasscode(Data(#"{"ok":true,"passcode":"abcde-fghij-klmno-pqrst"}"#.utf8)), "abcde-fghij-klmno-pqrst")
        XCTAssertNil(RemoteCommand.parsePasscode(Data(#"{"ok":false}"#.utf8)))
        XCTAssertNil(RemoteCommand.parsePasscode(Data("✓ OAuth passcode:".utf8)))
    }

    // MARK: Words

    func testNoJargonOnScreen() {
        // The Mac's own sentences. The shared ones (which name cloudflared and a port where that is the step) are held to the
        // side panel's words by browser/test/remote-copy.test.mjs.
        for line in RemoteCopy.everySentence {
            for banned in ["MCP", "tunnel", "OAuth2", "localhost", "127.0.0.1", "JSON", "remote.json", "tabkyra", "encrypt", "secure", "brew"] {
                XCTAssertFalse(line.contains(banned), "\"\(line)\" says \(banned)")
            }
        }
    }

    func testTheRequiredSentencesAreThere() {
        XCTAssertEqual(RemoteCopy.staysOn, "Your computer must stay on and signed in.")
        XCTAssertEqual(RemoteCopy.honest, "This runs on your own account. Assistants you approve can use your signed-in browser, so only approve ones you trust. Computer use stays off for each one unless you tick it when you approve it.")
        XCTAssertEqual(RemoteCopy.title, "Use Polycarp from Claude, ChatGPT and Grok")
        XCTAssertEqual(RemoteCopy.otherWays, "Other ways")
        XCTAssertEqual(RemoteSharedCopy.steps["ready"]!.action, "Turn on")
        XCTAssertEqual(RemoteSharedCopy.steps["tailscale_missing"]!.action, "Get Tailscale")
        // The passcode is for re-approving; autofill by the browser the assistant drives would weaken it.
        XCTAssertEqual(RemoteSharedCopy.result["passcodeLabel"], "Passcode, for re-approving")
        XCTAssertTrue(RemoteSharedCopy.result["passcodeNote"]!.contains("not one the browser Polycarp drives can fill"))
        XCTAssertTrue(RemoteCopy.intro.contains("It's off until you turn it on."))
        XCTAssertTrue(RemoteSharedCopy.steps["launcher_app"]!.body!.contains("press Check again"), "that screen doesn't update by itself, so it says to press the button")
        XCTAssertTrue(RemoteCopy.passcodeEarlier.contains("make a new one"), "never claims it was shown when it may not have been")
        XCTAssertEqual(RemoteSharedCopy.result["turnOff"], "Turn off")
        XCTAssertEqual(RemoteCopy.tailscaleDownloadURL.absoluteString, "https://tailscale.com/download")
        XCTAssertEqual(RemoteCopy.stepHeader(2), "Step 2 of 3: Get it and sign in")
    }

    func testOnlyWhatTheDocSaysAboutEncryption() {
        // The guide says who can reach the address and what stands between them and the browser; it makes no claim about
        // encryption, so neither does the window.
        let shared = RemoteSharedCopy.steps.values.flatMap { [$0.title, $0.body ?? ""] } + Array(RemoteSharedCopy.result.values)
        for line in RemoteCopy.everySentence + shared { XCTAssertNil(line.range(of: "encrypt|end-to-end|private|secure", options: [.regularExpression, .caseInsensitive]), line) }
    }

    func testTheClipboardIsClearedAfterAMinuteOnlyIfNothingWasCopiedSince() {
        XCTAssertEqual(RemoteFlow.passcodeClipboardSeconds, 60)
        XCTAssertTrue(RemoteFlow.shouldClearClipboard(copiedAt: 41, now: 41))
        XCTAssertFalse(RemoteFlow.shouldClearClipboard(copiedAt: 41, now: 42), "the person copied something else")
    }

    /// The same lines `remote setup` prints, and the guide says. browser/test/remote-copy.test.mjs holds them equal to the panel's.
    func testTheStepsMatchTheGuide() throws {
        XCTAssertEqual(RemoteSharedCopy.assistantSteps.map(\.name), ["claude.ai", "ChatGPT", "grok.com"])
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let doc = try String(contentsOf: root.appendingPathComponent("browser/docs/remote.md"), encoding: .utf8)
        for step in RemoteSharedCopy.assistantSteps {
            XCTAssertTrue(doc.contains(String(step.where.dropLast())), "the guide no longer says: \(step.where)")
        }
    }

    // MARK: Wiring

    /// The view is a new file and the Browser tab gets one line; nothing here starts a process on its own except the helper's
    /// status read, and nothing names a hosted address.
    func testTheViewIsHookedInWithOneLineAndNeverGoesOnItsOwn() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let tab = try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/BrowserSetup.swift"), encoding: .utf8)
        XCTAssertEqual(tab.components(separatedBy: "BrowserRemoteView()").count - 1, 1)
        let view = try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/BrowserRemoteView.swift"), encoding: .utf8)
        XCTAssertTrue(view.contains("Self.run(.status)"))
        XCTAssertEqual(view.components(separatedBy: "Self.run(command, connectCode: !quiet)").count - 1, 1, "setup runs from one place: runSetup()")
        // Setup runs from the Turn on button and Try again only; the poll reads status.
        let from = try XCTUnwrap(view.range(of: "func refresh()")), to = try XCTUnwrap(view.range(of: "// MARK: Acting"))
        let pollBody = String(view[from.lowerBound..<to.lowerBound])
        XCTAssertFalse(pollBody.contains("?? .setup)") || pollBody.contains("turnOn(") || pollBody.contains(".cloudflareLogin"))
        for hosted in ["workers.dev", "trycloudflare", "waitlist"] { XCTAssertFalse(view.contains(hosted), hosted) }
        // A status read that began before a click is dropped (F10), the passcode shows on the Funnel refusal screen (S3), the intro is
        // on screen (S5), and a copied passcode is cleared by change count (S7).
        XCTAssertTrue(view.contains("guard started == self.generation"))
        XCTAssertEqual(view.components(separatedBy: "generation += 1").count - 1, 5, "runSetup, repair, checkAgain, turnOff and newPasscode each bump it")
        let funnelCase = try XCTUnwrap(view.range(of: "case .funnelNotAllowed(let admin):")), lockCase = try XCTUnwrap(view.range(of: "case .funnelClosed:"))
        XCTAssertTrue(view[funnelCase.lowerBound..<lockCase.lowerBound].contains("passcodeShown"))
        // A run can make the passcode and then land on a screen other than On: every such screen shows it (F3).
        let busyCase = try XCTUnwrap(view.range(of: "case .portBusy(")), readyCase = try XCTUnwrap(view.range(of: "case .ready:"))
        XCTAssertTrue(view[busyCase.lowerBound..<readyCase.lowerBound].contains("passcodeShown"))
        let problemCase = try XCTUnwrap(view.range(of: "private func problemView(")), pieces = try XCTUnwrap(view.range(of: "/// What a step's one button does"))
        XCTAssertTrue(view[problemCase.lowerBound..<pieces.lowerBound].contains("passcodeShown"))
        // Turn off stays reachable on the screens an already set-up install can be waiting on (F2) and on the Funnel-closed one.
        for (from, to) in [("case .getTailscale(", "case .signIn("), ("case .signIn(", "case .needsBrowser"), ("case .funnelClosed:", "case .tailnetLock("), ("case .tailnetLock(", "case .portBusy(")] {
            let a = try XCTUnwrap(view.range(of: from)), b = try XCTUnwrap(view.range(of: to))
            XCTAssertTrue(view[a.lowerBound..<b.lowerBound].contains("turnOffButton"), from)
            if from != "case .funnelClosed:" { XCTAssertTrue(view[a.lowerBound..<b.lowerBound].contains("configured"), from) }
        }
        // The Copied label lives in copyRow, so every screen with a Copy button has it (S13).
        let copyRow = try XCTUnwrap(view.range(of: "private func copyRow("))
        XCTAssertTrue(view[copyRow.lowerBound...].contains("model.copied == label"))
        XCTAssertGreaterThanOrEqual(view.components(separatedBy: "line(RemoteCopy.intro)").count - 1, 3)
        XCTAssertTrue(view.contains("RemoteFlow.shouldClearClipboard") && view.contains("RemoteFlow.passcodeClipboardSeconds") && view.contains("changeCount"))
        XCTAssertTrue(view.contains("RemoteCopy.passcodeEarlier") && view.contains("result(\"noPasscode\")"))
    }

    // MARK: The route choice

    private func status(_ state: RemoteState = .ready, routes: RemoteRoutes? = RemoteRoutes(), url: String? = nil) -> RemoteReport {
        RemoteReport(state: state, connectorURL: url, routes: routes)
    }

    private func pick(_ report: RemoteReport, _ chosen: RemoteRoute?, setup: RemoteReport? = nil, signingIn: Bool = false) -> RemoteScreen {
        RemoteFlow.screen(helperAvailable: true, settingUp: false, status: report, setup: setup, chosen: chosen, signingIn: signingIn)
    }

    func testNothingSetUpAsksWhichRouteFirstEvenWhenTailscaleIsMissing() {
        let routes = RemoteRoutes(cloudflareInstalled: true)
        XCTAssertEqual(pick(status(.tailscaleMissing, routes: routes), nil), .chooseRoute(routes))
        XCTAssertEqual(pick(status(.ready, routes: routes), nil), .chooseRoute(routes))
    }

    func testPickingTailscaleIsTheFlowItAlwaysWas() {
        XCTAssertEqual(pick(status(.tailscaleMissing), .tailscale), .getTailscale(configured: false))
        XCTAssertEqual(pick(status(.tailscaleSignedOut), .tailscale), .signIn(configured: false))
        XCTAssertEqual(pick(status(.ready), .tailscale), .ready)
    }

    func testCloudflareWalksInstallThenSignInThenAddress() {
        XCTAssertEqual(pick(status(), .cloudflare), .getCloudflared(configured: false))
        let installed = RemoteRoutes(cloudflareInstalled: true)
        XCTAssertEqual(pick(status(routes: installed), .cloudflare), .cloudflareSignIn(waiting: false))
        XCTAssertEqual(pick(status(routes: installed), .cloudflare, signingIn: true), .cloudflareSignIn(waiting: true))
        let signedIn = RemoteRoutes(cloudflareInstalled: true, cloudflareSignedIn: true)
        XCTAssertEqual(pick(status(routes: signedIn), .cloudflare), .cloudflareAddress(problem: nil))
        let taken = RemoteReport(state: .problem, message: "that name is in use", code: "cloudflare_dns")
        XCTAssertEqual(pick(status(routes: signedIn), .cloudflare, setup: taken), .cloudflareAddress(problem: "that name is in use", code: "cloudflare_dns"))
    }

    func testAnOlderHelperGoesStraightToTailscale() {
        XCTAssertEqual(pick(status(.tailscaleMissing, routes: nil), nil), .getTailscale(configured: false))
    }

    func testSomethingSetUpNeverAsksAgain() {
        let on = status(.on, url: "https://a.example.com/mcp")
        XCTAssertEqual(pick(on, nil), .on(connectorURL: "https://a.example.com/mcp", browserConnected: true))
        let gone = status(.cloudflaredMissing, url: "https://a.example.com/mcp")
        XCTAssertEqual(pick(gone, nil), .getCloudflared(configured: true))
    }

    func testAProblemComesAheadOfTheChoice() {
        let noBrowser = RemoteReport(state: .problem, code: "launcher", routes: RemoteRoutes())
        XCTAssertEqual(pick(noBrowser, nil), .needsBrowser)
    }

    func testTheHelperStatusCarriesTheRoutes() throws {
        let data = Data(#"{"state":"ready","routes":{"tailscale":{"installed":true,"signedIn":false},"cloudflare":{"installed":true,"signedIn":true}}}"#.utf8)
        let routes = try XCTUnwrap(RemoteReport.parse(data)?.routes)
        XCTAssertEqual(routes, RemoteRoutes(tailscaleInstalled: true, tailscaleSignedIn: false, cloudflareInstalled: true, cloudflareSignedIn: true))
        XCTAssertEqual(RemoteReport.parse(Data(#"{"state":"cloudflared_missing"}"#.utf8))?.state, .cloudflaredMissing)
    }

    func testATypedNameIsCleanedOrRefused() {
        XCTAssertEqual(RemoteFlow.cloudflareHost("  HTTPS://Polycarp.Example.com/mcp "), "polycarp.example.com")
        XCTAssertEqual(RemoteFlow.cloudflareHost("a.example.com."), "a.example.com")
        for bad in ["", "nodots", "has space.example.com", "-bad.example.com", "a..example.com", "--cloudflare.x"] {
            XCTAssertNil(RemoteFlow.cloudflareHost(bad), bad)
        }
    }

    func testTheCloudflareCommandsAreExactlyWhatTheHelperTakes() {
        XCTAssertEqual(RemoteCommand.setupCloudflare("a.example.com").arguments, ["remote", "setup", "--json", "--connect-code", "--cloudflare", "a.example.com"])
        XCTAssertEqual(RemoteCommand.setupCloudflare("a.example.com", download: true).arguments, ["remote", "setup", "--json", "--connect-code", "--cloudflare", "a.example.com", "--yes"])
        XCTAssertEqual(RemoteCommand.cloudflareLogin.arguments, ["remote", "cloudflare", "login", "--json"])
        XCTAssertGreaterThan(RemoteCommand.cloudflareLogin.timeout, 300, "longer than cloudflared's own five-minute wait")
    }

    func testAConnectCodeComesFromTheHelpersOwnAnswer() {
        XCTAssertEqual(RemoteCommand.approvalCode.arguments, ["token", "approval-code", "--json"])
        XCTAssertEqual(RemoteCommand.parseApprovalCode(Data(#"{"ok":true,"kind":"approval","code":"TK-7QF3-K2MD","expiresAt":1800000000000}"#.utf8)),
                       ConnectCode(code: "TK-7QF3-K2MD", expiresAt: Date(timeIntervalSince1970: 1_800_000_000)))
        XCTAssertNil(RemoteCommand.parseApprovalCode(Data(#"{"ok":false}"#.utf8)))
        XCTAssertNil(RemoteCommand.parseApprovalCode(Data(#"{"ok":true,"code":"TK-L0L0-1111","expiresAt":1}"#.utf8)), "not Crockford: never shown")
        XCTAssertNil(RemoteCommand.parseApprovalCode(Data(#"{"ok":true,"code":"TK-7QF3-K2MD"}"#.utf8)), "no expiry: no countdown to show")
        XCTAssertTrue(RemoteSharedCopy.approvalStep.contains("connect code"), "a new assistant's page refuses the passcode")
    }

    // MARK: One button, the panel's words

    private func source(_ path: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }
    private let remoteSources = ["Sources/BaneySpaces/BrowserRemoteView.swift", "Sources/BaneySpacesCore/BrowserRemote.swift", "Sources/BaneySpacesCore/RemoteSharedCopy.swift"]

    /// "Get it for me" replaced the brew instruction: nobody is sent to a terminal for cloudflared.
    func testTheBrewCommandIsGone() throws {
        for path in remoteSources { XCTAssertFalse(try source(path).contains("brew"), path) }
        XCTAssertEqual(RemoteSharedCopy.steps["cloudflared_missing"]!.action, "Get it for me")
        XCTAssertEqual(RemoteSharedCopy.steps["cloudflared_missing"]!.kind, "download")
        XCTAssertTrue(try source(remoteSources[0]).contains("model.turnOn(cloudflare: host, download: true)"))
    }

    /// Every code the helper sends picks its own sentence, never a generic one, and never just the helper's words.
    func testEveryProblemCodeHasItsOwnSentence() {
        let codes = ["launcher", "hub", "service", "serve", "funnel", "config", "cloudflare_login", "cloudflare_name", "cloudflare_zone", "cloudflare_dns",
                     "cloudflare_tunnel", "connect_code", "tailscale_operator", "dns", "not_set_up"]
        var titles: [String: String] = [:]
        for code in codes {
            let c = RemoteSharedCopy.copy(for: RemoteReport(state: .problem, message: "helper words", code: code))
            XCTAssertNotEqual(c.key, "unknown", code)
            XCTAssertNotEqual(c.body, "helper words", code)
            if let other = titles[c.title] { XCTFail("\(code) and \(other) share \"\(c.title)\"") }
            titles[c.title] = code
        }
        // A failed check from outside is one entry; the checklist says which.
        for check in ["dns", "tls", "resource_metadata", "auth_metadata", "auth_challenge", "streaming"] where check != "dns" {
            XCTAssertEqual(RemoteSharedCopy.copy(for: RemoteReport(state: .problem, code: check)).key, "check_failed", check)
            XCTAssertNotNil(RemoteSharedCopy.checkLabels[check])
        }
        XCTAssertEqual(RemoteSharedCopy.copy(for: RemoteReport(state: .problem, code: "cloudflare_dns", nextKind: "choose_name")).key, "cloudflare_name_refused")
        // Every state too, and port_busy's two kinds.
        for state in RemoteState.allCases where state != .problem {
            XCTAssertNotEqual(RemoteSharedCopy.copy(for: RemoteReport(state: state)).key, "unknown", state.rawValue)
        }
        XCTAssertEqual(RemoteSharedCopy.copy(for: RemoteReport(state: .portBusy, code: "tailscale_port")).key, "tailscale_port")
        // Only a code nobody knows shows the helper's own words, and an empty answer still says something.
        XCTAssertEqual(RemoteSharedCopy.copy(for: RemoteReport(state: .problem, message: "new thing", code: "brand_new")).body, "new thing")
        XCTAssertEqual(RemoteSharedCopy.copy(for: RemoteReport(state: .problem, code: "brand_new")).body, RemoteSharedCopy.unknownBody)
        XCTAssertEqual(RemoteSharedCopy.copy(for: RemoteReport(state: .problem, rawState: "from_the_future")).key, "unknown")
        // Each screen button the shared table names is one the window knows how to press.
        let handled: Set<String> = ["try_again", "turn_on", "open_funnel", "new_code", "repair", "choose", "use_cloudflare", "sign_in_cloudflare", "check_again", "copy_command", "open_url", "download"]
        for (key, entry) in RemoteSharedCopy.steps { if let kind = entry.kind { XCTAssertTrue(handled.contains(kind), "\(key): \(kind)") } }
    }

    /// Allowing Funnel happens in Tailscale; the window runs Turn on again by itself until it works. No button to press.
    func testFunnelApprovalAdvancesWithoutAButtonPress() throws {
        let refused = RemoteReport(state: .funnelNotAllowed, adminURL: URL(string: "https://login.tailscale.com/f/funnel"))
        let t0 = Date(timeIntervalSince1970: 1_000)
        func due(_ after: TimeInterval, last: TimeInterval? = nil, busy: Bool = false, setup: RemoteReport? = refused) -> Bool {
            RemoteFlow.funnelRetryDue(setup: setup, busy: busy, firstRefusal: t0, lastTry: last.map { t0.addingTimeInterval($0) }, now: t0.addingTimeInterval(after))
        }
        XCTAssertFalse(due(5))
        XCTAssertTrue(due(15))
        XCTAssertFalse(due(20, last: 15), "15 s apart")
        XCTAssertTrue(due(30, last: 15))
        XCTAssertFalse(due(30, busy: true), "never on top of another run")
        XCTAssertFalse(due(RemoteFlow.funnelRetryFor + 1), "stops after ten minutes")
        XCTAssertFalse(due(30, setup: RemoteReport(state: .portBusy)), "only while Funnel is the refusal")
        XCTAssertFalse(RemoteFlow.funnelRetryDue(setup: refused, busy: false, firstRefusal: nil, lastTry: nil, now: t0))
        // The retry's answer moves the screen on with nobody pressing anything.
        let half = RemoteReport(state: .problem, message: "public DNS: ...", connectorURL: url)
        XCTAssertEqual(screen(status: half, setup: refused), .funnelNotAllowed(adminURL: refused.adminURL))
        let on = RemoteReport(ok: true, state: .on, connectorURL: url)
        XCTAssertEqual(screen(status: half, setup: on), .on(connectorURL: url, browserConnected: true))
        // And the screen has no "try again" button: its only buttons are the page and Turn off.
        let view = try source(remoteSources[0])
        let start = try XCTUnwrap(view.range(of: "case .funnelNotAllowed(let admin):"))
        let a = try XCTUnwrap(view.range(of: "} else if let admin {", range: start.upperBound..<view.endIndex))
        let b = try XCTUnwrap(view.range(of: "turnOffButton", range: a.upperBound..<view.endIndex))
        let buttons = view[a.lowerBound..<b.lowerBound].components(separatedBy: "Button(").count - 1
        XCTAssertEqual(buttons, 1, "Open Tailscale's page only (Turn off is turnOffButton)")
        XCTAssertFalse(view.contains("I've allowed it"))
        XCTAssertTrue(view.contains("runSetup(lastSetup, quiet: true)"))
    }

    /// The passcode and connect code are shown once: never saved, never logged, forgotten when the window closes.
    func testNeitherSecretIsPersistedOrLogged() throws {
        for path in remoteSources {
            let code = try source(path)
            for banned in ["UserDefaults", "@AppStorage", "@SceneStorage", "SecItemAdd", ".write(to:", "NSLog(", "print(", "Log.", "trace("] {
                XCTAssertFalse(code.contains(banned), "\(path) has \(banned)")
            }
        }
        let view = try source(remoteSources[0])
        let stop = try XCTUnwrap(view.range(of: "func stopWatching()")), next = try XCTUnwrap(view.range(of: "func clearSecrets()"))
        XCTAssertFalse(view[stop.lowerBound..<next.lowerBound].contains("clearSecrets()"), "a tab switch keeps them (PR 134 first-F4)")
        XCTAssertTrue(try source("Sources/BaneySpaces/Setup.swift").contains("BrowserRemoteModel.shared.clearSecrets()"), "closing the window forgets them")
        let clear = try XCTUnwrap(view.range(of: "func clearSecrets() {"))
        let body = view[clear.upperBound...].prefix(120)
        XCTAssertTrue(body.contains("passcode = nil") && body.contains("connectCode = nil"))
        // The render harness never reaches the helper: no watching while it previews.
        XCTAssertTrue(view.contains(".onAppear { if preview == nil { model.startWatching() } }"))
    }

    func testSetupsAnswerCarriesTheChecksAndTheCode() throws {
        let r = try report(#"{"ok":true,"state":"on","connectorUrl":"https://m.ts.net:8443/mcp","connectCode":"TK-7QF3-K2MD","connectCodeExpiresAt":1800000000000,"#
            + #""checks":[{"name":"dns","status":"ok","detail":"a"},{"name":"tls","status":"fail","detail":"b"},{"name":"remote.json","status":"ok","detail":"c"},{"name":"dns","status":"fail"}],"#
            + #""next":{"kind":"add_connector","command":"x\ny"}}"#)
        XCTAssertEqual(r.connectCode?.code, "TK-7QF3-K2MD")
        XCTAssertEqual(r.checks.map(\.name), ["dns", "tls"], "only the outside checks, each once")
        XCTAssertEqual(r.failedChecks.map(\.name), ["tls"])
        XCTAssertNil(r.nextCommand, "a command on two lines is never shown")
        XCTAssertEqual(r.nextKind, "add_connector")
        XCTAssertEqual(ConnectCode(code: "TK-7QF3-K2MD", expiresAt: Date(timeIntervalSince1970: 100)).secondsLeft(now: Date(timeIntervalSince1970: 54.5)), 46)
        XCTAssertEqual(RemoteSharedCopy.countdown(seconds: 545), "Expires in 9:05")
        XCTAssertEqual(RemoteSharedCopy.countdown(seconds: 0), "Expired. Make a new code.")
    }

    /// Repair: only when a check failed and this helper has `remote fix` with something to do. Feature-detected.
    func testRepairShowsOnlyWhenACheckFailedAndTheHelperCanRepair() {
        XCTAssertEqual(RemoteCommand.test.arguments, ["remote", "test", "--json"])
        XCTAssertEqual(RemoteCommand.fixPlan.arguments, ["remote", "fix", "--json", "--dry-run"])
        XCTAssertEqual(RemoteCommand.fix.arguments, ["remote", "fix", "--json", "--yes"])
        let plan = RemoteCommand.parseFix(exitCode: 0, Data(#"{"ok":true,"actions":[{"kind":"funnel","what":"Open Funnel","status":"planned"}]}"#.utf8))
        XCTAssertTrue(plan.available)
        XCTAssertEqual(plan.actions.count, 1)
        XCTAssertFalse(RemoteCommand.parseFix(exitCode: 2, Data("Usage: polycarp remote setup".utf8)).available, "an older helper has no remote fix")
        XCTAssertFalse(RemoteCommand.parseFix(exitCode: 0, Data(#"{"ok":true}"#.utf8)).available, "no actions list")
        let failed = [RemoteCheck(name: "dns", status: "fail")], passed = [RemoteCheck(name: "dns", status: "ok")]
        XCTAssertTrue(RemoteFlow.offerRepair(checks: failed, plan: plan))
        XCTAssertFalse(RemoteFlow.offerRepair(checks: passed, plan: plan))
        XCTAssertFalse(RemoteFlow.offerRepair(checks: failed, plan: nil))
        XCTAssertFalse(RemoteFlow.offerRepair(checks: failed, plan: RemoteFixPlan(available: true)))
        XCTAssertFalse(RemoteFlow.offerRepair(checks: failed, plan: RemoteFixPlan(available: false)))
    }
}
