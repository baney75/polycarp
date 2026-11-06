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
        XCTAssertEqual(RemoteState.allCases.count, 9, "the helper's REMOTE_STATES")
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

    private func screen(settingUp: Bool = false, status: RemoteReport? = nil, setup: RemoteReport? = nil, available: Bool = true) -> RemoteScreen {
        RemoteFlow.screen(helperAvailable: available, settingUp: settingUp, status: status, setup: setup)
    }
    private let url = "https://m.ts.net:8443/mcp"

    func testEachStatusIsOneStep() {
        XCTAssertEqual(screen(), .checking)
        XCTAssertEqual(screen(available: false), .unavailable)
        XCTAssertEqual(screen(status: .init(state: .tailscaleMissing)), .getTailscale)
        XCTAssertEqual(screen(status: .init(state: .tailscaleSignedOut)), .signIn)
        XCTAssertEqual(screen(status: .init(state: .tailnetLock)), .tailnetLock)
        XCTAssertEqual(screen(status: .init(state: .portBusy)), .portBusy)
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
        XCTAssertEqual(states.map { screen(status: .init(state: $0)) }, [.getTailscale, .signIn, .ready])
    }

    func testAFunnelRefusalStaysOnScreenWhileStatusSaysItIsHalfDone() {
        let admin = URL(string: "https://login.tailscale.com/f/funnel?node=n1")
        let refused = RemoteReport(state: .funnelNotAllowed, adminURL: admin, passcodeSet: true)
        // After a refusal the helper's status reads "problem": remote.json is kept and the address isn't reachable.
        let half = RemoteReport(state: .problem, message: "public DNS: …")
        XCTAssertEqual(screen(status: half, setup: refused), .funnelNotAllowed(adminURL: admin))
        // Tailscale going away is more basic than the refusal.
        XCTAssertEqual(screen(status: .init(state: .tailscaleSignedOut), setup: refused), .signIn)
        XCTAssertEqual(screen(status: .init(state: .tailnetLock), setup: refused), .tailnetLock)
    }

    func testASetupRefusalForOtherReasonsShowsItsOwnStep() {
        XCTAssertEqual(screen(status: .init(state: .ready), setup: .init(state: .portBusy)), .portBusy)
        XCTAssertEqual(screen(status: .init(state: .ready), setup: .init(state: .problem, message: "boom")), .problem("boom"))
        XCTAssertEqual(screen(status: .init(state: .ready), setup: .init(state: .problem, code: "launcher")), .needsBrowser)
    }

    func testSuccessShowsOnAtOnceAndStatusTakesOver() {
        let done = RemoteReport(ok: true, state: .on, connectorURL: url, passcode: "abcde-fghij-klmno-pqrst", passcodeSet: true)
        XCTAssertEqual(screen(setup: done), .on(connectorURL: url, browserConnected: true), "before the first status read")
        XCTAssertEqual(screen(status: .init(state: .problem), setup: done), .on(connectorURL: url, browserConnected: true))
        XCTAssertEqual(screen(status: .init(state: .noBrowserConnected, connectorURL: url, extensionConnected: false), setup: done), .on(connectorURL: url, browserConnected: false))
    }

    func testOnWithoutAnAddressIsAProblemNotAnEmptyCard() {
        XCTAssertEqual(screen(status: .init(state: .on)), .problem(RemoteCopy.genericProblem))
    }

    func testThePasscodeIsKeptUntilReplaced() {
        XCTAssertEqual(RemoteFlow.keepPasscode(current: nil, from: .init(state: .funnelNotAllowed, passcode: "first")), "first")
        XCTAssertEqual(RemoteFlow.keepPasscode(current: "first", from: .init(state: .funnelNotAllowed)), "first", "a retry that makes none doesn't clear it")
        XCTAssertEqual(RemoteFlow.keepPasscode(current: "first", from: .init(state: .on, passcode: "second")), "second")
    }

    func testPollingIsQuickWhileWaitingAndSlowOnceOn() {
        XCTAssertEqual(RemoteFlow.pollInterval(for: .getTailscale), 4)
        XCTAssertEqual(RemoteFlow.pollInterval(for: .on(connectorURL: url, browserConnected: true)), 30)
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

    func testTheTailscaleAppIsNamedOnlyWhenItExists() {
        XCTAssertNil(RemoteCommand.environment(base: ["A": "1"], tailscaleAppExists: false)["TABKYRA_TAILSCALE_APP"])
        let env = RemoteCommand.environment(base: ["A": "1"], tailscaleAppExists: true)
        XCTAssertEqual(env["TABKYRA_TAILSCALE_APP"], "/Applications/Tailscale.app/Contents/MacOS/Tailscale")
        XCTAssertEqual(env["A"], "1")
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
        let allowed: Set<String> = [RemoteCopy.funnelTitle, RemoteCopy.funnelBody, RemoteCopy.lockBody]
        for line in RemoteCopy.everySentence where line.contains("Funnel") || line.contains("funnel") {
            XCTAssertTrue(allowed.contains(line), "\"\(line)\" names Funnel")
        }
        XCTAssertTrue(RemoteCopy.funnelBody.contains("Tailscale's setting"))
    }

    func testTheRequiredSentencesAreThere() {
        XCTAssertTrue(RemoteCopy.getTailscaleBody.contains("It's free, and it's your own account."))
        XCTAssertEqual(RemoteCopy.getTailscaleButton, "Get Tailscale")
        XCTAssertEqual(RemoteCopy.staysOn, "Your computer must stay on and signed in.")
        XCTAssertEqual(RemoteCopy.honest, "This runs on your own account. Agents you approve can use your signed-in browser, so only approve ones you trust.")
        XCTAssertEqual(RemoteCopy.title, "Use your browser from Claude, ChatGPT and Grok")
        XCTAssertEqual(RemoteCopy.otherWays, "Other ways")
        XCTAssertEqual(RemoteCopy.turnOnButton, "Turn on")
        XCTAssertEqual(RemoteCopy.newPasscodeButton, "Make a new passcode")
        XCTAssertEqual(RemoteCopy.turnOffButton, "Turn off")
        XCTAssertEqual(RemoteCopy.tailscaleDownloadURL.absoluteString, "https://tailscale.com/download")
    }

    func testOnlyWhatTheDocSaysAboutEncryption() {
        // The guide says who can reach the address and what stands between them and the browser; it makes no claim about
        // encryption, so neither does the window.
        for line in RemoteCopy.everySentence { XCTAssertNil(line.range(of: "encrypt|end-to-end|private|secure", options: [.regularExpression, .caseInsensitive]), line) }
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
    }
}
