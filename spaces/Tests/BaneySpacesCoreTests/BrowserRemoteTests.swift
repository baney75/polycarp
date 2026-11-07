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
        XCTAssertEqual(RemoteState.allCases.count, 10, "the helper's REMOTE_STATES")
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
        XCTAssertEqual(screen(status: .init(state: .problem, message: "public DNS: x")), .problem("public DNS: x"))
        XCTAssertEqual(screen(status: .init(state: .problem)), .problem(RemoteCopy.genericProblem))
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
        XCTAssertEqual(screen(status: .init(state: .ready), setup: .init(state: .problem, message: "boom")), .problem("boom"))
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
        XCTAssertEqual(screen(status: .init(state: .problem, message: "local serve: down"), setup: done, age: over), .problem("local serve: down"))
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
        XCTAssertEqual(screen(readsFailing: true), .problem(RemoteCopy.helperSilent), "a first read that never answers isn't Looking… forever")
        XCTAssertEqual(screen(status: .init(state: .on, connectorURL: url, extensionConnected: true), setup: nil, readsFailing: false), .on(connectorURL: url, browserConnected: true))
        XCTAssertEqual(screen(status: .init(state: .ready), readsFailing: true), .problem(RemoteCopy.helperSilent), "and a later failure doesn't leave the old state up as current")
        // An old "On" doesn't stay up either: with the helper silent the window can't know remote access still works.
        XCTAssertEqual(screen(status: .init(state: .on, connectorURL: url, extensionConnected: true), readsFailing: true), .problem(RemoteCopy.helperSilent))
        XCTAssertEqual(screen(status: .init(state: .noBrowserConnected, connectorURL: url, extensionConnected: false), readsFailing: true), .problem(RemoteCopy.helperSilent))
        XCTAssertEqual(screen(settingUp: true, readsFailing: true), .turningOn)
    }

    func testABusyConnectionSaysWhichKindAndKeepsTheHelpersWords() throws {
        let tailscale = try report(#"{"ok":false,"state":"port_busy","message":"Port 8443 on this machine already forwards TCP traffic to 127.0.0.1:22.","code":"tailscale_port"}"#)
        let local = try report(#"{"ok":false,"state":"port_busy","message":"Something already listens on 127.0.0.1:8787","code":"local_port"}"#)
        XCTAssertEqual(screen(status: tailscale), .portBusy(tailscaleSetting: true, detail: tailscale.message))
        XCTAssertEqual(screen(status: local), .portBusy(tailscaleSetting: false, detail: local.message))
        XCTAssertEqual(screen(status: .init(state: .ready), setup: tailscale), .portBusy(tailscaleSetting: true, detail: tailscale.message))
        XCTAssertTrue(RemoteCopy.busyTailscaleBody.contains("isn't a program you can quit"))
        XCTAssertFalse(RemoteCopy.busyBody.contains("Tailscale"))
    }

    func testOnWithoutAnAddressIsAProblemNotAnEmptyCard() {
        XCTAssertEqual(screen(status: .init(state: .on)), .problem(RemoteCopy.genericProblem))
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
        XCTAssertTrue(RemoteCopy.lockBody.contains("Nothing was changed."))
        XCTAssertFalse(RemoteCopy.lockConfiguredBody.contains("Nothing was changed"))
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
        XCTAssertTrue(RemoteCopy.funnelClosedBody.contains("Try again"))
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
        XCTAssertEqual(screen(status: .init(state: .problem, message: "local serve: down", connectorURL: url), setup: done, age: late), .problem("local serve: down"), "any other problem ends the bridge on time")
        // Once the DNS grace is over it is a problem like any other.
        XCTAssertEqual(screen(status: dns, setup: done, age: RemoteFlow.dnsGrace + 1), .problem("public DNS: no A record"))
        XCTAssertEqual(try? report(#"{"state":"problem","code":"dns","message":"m","connectorUrl":"\#(url)"}"#).code, "dns")
    }

    // MARK: Commands

    func testTheHelperIsAskedExactlyTheseThings() {
        XCTAssertEqual(RemoteCommand.status.arguments, ["remote", "status", "--json"])
        XCTAssertEqual(RemoteCommand.setup.arguments, ["remote", "setup", "--json"])
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
        for line in RemoteCopy.everySentence {
            for banned in ["MCP", "tunnel", "Tunnel", "cloudflared", "OAuth2", "localhost", "127.0.0.1", "port ", "JSON", "remote.json", "tabkyra", "encrypt", "secure", "safe"] {
                XCTAssertFalse(line.contains(banned), "\"\(line)\" says \(banned)")
            }
        }
    }

    func testFunnelIsNamedOnlyWhereItIsTailscalesOwnSetting() {
        let allowed: Set<String> = [RemoteCopy.funnelTitle, RemoteCopy.funnelBody, RemoteCopy.lockBody, RemoteCopy.lockConfiguredBody, RemoteCopy.funnelClosedTitle, RemoteCopy.funnelClosedBody]
        for line in RemoteCopy.everySentence where line.contains("Funnel") || line.contains("funnel") {
            XCTAssertTrue(allowed.contains(line), "\"\(line)\" names Funnel")
        }
        XCTAssertTrue(RemoteCopy.funnelBody.contains("Tailscale's setting"))
    }

    func testTheRequiredSentencesAreThere() {
        XCTAssertTrue(RemoteCopy.getTailscaleBody.contains("It's free, and it's your own account."))
        XCTAssertEqual(RemoteCopy.getTailscaleButton, "Get Tailscale")
        XCTAssertEqual(RemoteCopy.staysOn, "Your computer must stay on and signed in.")
        XCTAssertEqual(RemoteCopy.honest, "This runs on your own account. Assistants you approve can use your signed-in browser, so only approve ones you trust. Computer use stays off for each one unless you tick it when you approve it.")
        XCTAssertEqual(RemoteCopy.title, "Use Polycarp from Claude, ChatGPT and Grok")
        XCTAssertEqual(RemoteCopy.otherWays, "Other ways")
        XCTAssertEqual(RemoteCopy.turnOnButton, "Turn on")
        XCTAssertEqual(RemoteCopy.newPasscodeButton, "Make a new passcode")
        // The passcode is the approval gate, so autofill by the browser the assistant drives would weaken it.
        XCTAssertTrue(RemoteCopy.passcodeOnce.contains("not one built into the browser Polycarp uses"))
        // Turning on makes an address anyone on the internet can reach; the passcode is what stands in the way.
        XCTAssertTrue(RemoteCopy.readyBody.contains("Anyone on the internet can reach that address"))
        XCTAssertTrue(RemoteCopy.readyBody.contains("an assistant still needs the passcode"))
        XCTAssertTrue(RemoteCopy.intro.contains("It's off until you turn it on."))
        XCTAssertTrue(RemoteCopy.needsBrowserBody.contains("press Check again"), "that screen doesn't update by itself, so it says to press the button")
        XCTAssertTrue(RemoteCopy.passcodeEarlier.contains("make a new one"), "never claims it was shown when it may not have been")
        XCTAssertEqual(RemoteCopy.turnOffButton, "Turn off")
        XCTAssertEqual(RemoteCopy.tailscaleDownloadURL.absoluteString, "https://tailscale.com/download")
    }

    func testOnlyWhatTheDocSaysAboutEncryption() {
        // The guide says who can reach the address and what stands between them and the browser; it makes no claim about
        // encryption, so neither does the window.
        for line in RemoteCopy.everySentence { XCTAssertNil(line.range(of: "encrypt|end-to-end|private|secure", options: [.regularExpression, .caseInsensitive]), line) }
    }

    func testTheClipboardIsClearedAfterAMinuteOnlyIfNothingWasCopiedSince() {
        XCTAssertEqual(RemoteFlow.passcodeClipboardSeconds, 60)
        XCTAssertTrue(RemoteFlow.shouldClearClipboard(copiedAt: 41, now: 41))
        XCTAssertFalse(RemoteFlow.shouldClearClipboard(copiedAt: 41, now: 42), "the person copied something else")
    }

    func testTheStepsMatchTheGuide() throws {
        XCTAssertEqual(RemoteCopy.assistants.map(\.name), ["Claude", "ChatGPT", "Grok"])
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let doc = try String(contentsOf: root.appendingPathComponent("browser/docs/remote.md"), encoding: .utf8)
        for phrase in ["Settings > Connectors > Add custom connector", "Settings > Apps & Connectors (turn on developer mode) > Create. Choose OAuth.", "grok.com/connectors > New Connector > Custom"] {
            XCTAssertTrue(doc.contains(phrase), "the guide no longer says: \(phrase)")
        }
        let claude = RemoteCopy.assistants[0].steps.joined(separator: " ")
        XCTAssertTrue(claude.contains("Settings, then Connectors") && claude.contains("Add custom connector"))
        let chatgpt = RemoteCopy.assistants[1].steps.joined(separator: " ")
        XCTAssertTrue(chatgpt.contains("Apps & Connectors") && chatgpt.contains("developer mode") && chatgpt.contains("Create") && chatgpt.contains("OAuth"))
        let grok = RemoteCopy.assistants[2].steps.joined(separator: " ")
        XCTAssertTrue(grok.contains("grok.com/connectors") && grok.contains("New Connector") && grok.contains("Custom"))
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
        XCTAssertEqual(view.components(separatedBy: "Self.run(.setup)").count - 1, 1, "setup runs from one place: turnOn()")
        // Setup runs from the Turn on button and Try again only; the poll reads status.
        let from = try XCTUnwrap(view.range(of: "func refresh()")), to = try XCTUnwrap(view.range(of: "// MARK: Acting"))
        let pollBody = String(view[from.lowerBound..<to.lowerBound])
        XCTAssertFalse(pollBody.contains("Self.run(.setup)") || pollBody.contains("turnOn()"))
        for hosted in ["workers.dev", "cloudflared", "trycloudflare", "waitlist"] { XCTAssertFalse(view.contains(hosted), hosted) }
        // A status read that began before a click is dropped (F10), the passcode shows on the Funnel refusal screen (S3), the intro is
        // on screen (S5), and a copied passcode is cleared by change count (S7).
        XCTAssertTrue(view.contains("guard started == self.generation"))
        XCTAssertEqual(view.components(separatedBy: "generation += 1").count - 1, 4, "turnOn, checkAgain, turnOff and newPasscode each bump it")
        let funnelCase = try XCTUnwrap(view.range(of: "case .funnelNotAllowed(let admin):")), lockCase = try XCTUnwrap(view.range(of: "case .funnelClosed:"))
        XCTAssertTrue(view[funnelCase.lowerBound..<lockCase.lowerBound].contains("passcodeShown"))
        // A run can make the passcode and then land on a screen other than On: every such screen shows it (F3).
        let busyCase = try XCTUnwrap(view.range(of: "case .portBusy(")), readyCase = try XCTUnwrap(view.range(of: "case .ready:"))
        XCTAssertTrue(view[busyCase.lowerBound..<readyCase.lowerBound].contains("passcodeShown"))
        let problemCase = try XCTUnwrap(view.range(of: "case .problem(let message):")), pieces = try XCTUnwrap(view.range(of: "/// The helper's own words"))
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
        XCTAssertTrue(view.contains("RemoteCopy.newPasscodeNote") && view.contains("RemoteCopy.noPasscodeNote"))
    }
}
