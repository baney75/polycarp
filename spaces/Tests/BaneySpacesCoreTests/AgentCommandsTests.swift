import BaneySpacesCore
import CoreGraphics
import CryptoKit
import XCTest

/// The agent API's commands (spec/agent-api.md): who may change what Donovan sees, the arguments, and the results'
/// shapes against the schema.
final class AgentCommandsTests: XCTestCase {
    let facts = AgentAPIQueryTests.facts()
    let main = AgentAPIQueryTests.main, side = AgentAPIQueryTests.side

    func testViewControlNeedsThisMacFullAccessAndTheSettingAndSaysWhichIsMissing() {
        XCTAssertNil(ViewControl.refusal("switching", access: .full, enabled: true, remote: false))
        let cases: [(AgentAccessMode, Bool, Bool, String)] = [
            (.full, true, true, "another machine"),
            (.standard, true, false, "needs Full Access"),
            (.readOnly, true, false, "needs Full Access"),
            (.full, false, false, ViewControl.settingTitle),
        ]
        for (access, enabled, remote, names) in cases {
            let e = ViewControl.refusal("switching", access: access, enabled: enabled, remote: remote)
            XCTAssertEqual(e?.code, .permissionDenied, "\(access) \(enabled) \(remote)")
            XCTAssertEqual(e?.retry, .never)
            XCTAssertTrue(e?.message.contains(names) == true, e?.message ?? "")
        }
    }

    func testFramesAreFourNumbersWithASize() {
        XCTAssertEqual(try AgentCommands.frame("0,40,800,600").get(), CGRect(x: 0, y: 40, width: 800, height: 600))
        XCTAssertEqual(try AgentCommands.frame(" -1512, 0.5, 756.5 ,949").get(), CGRect(x: -1512, y: 0.5, width: 756.5, height: 949))
        for bad in [nil, "", "0,40,800", "0,40,0,600", "a,b,c,d", "0,40,800,600,1", "nan,0,10,10", "0,0,1e9,10"] {
            guard case .failure(let e) = AgentCommands.frame(bad) else { return XCTFail(bad ?? "nil") }
            XCTAssertEqual(e.code, .badArguments)
        }
    }

    func testSwitchTakesAWorkspaceAndAKnownDisplay() throws {
        let plain = try AgentCommands.switchTarget(workspace: 3, display: nil, facts: facts).get()
        XCTAssertEqual(plain.workspace, 3)
        XCTAssertEqual(plain.display, main, "the focused display by default")
        XCTAssertEqual(try AgentCommands.switchTarget(workspace: 4, display: side, facts: facts).get().display, side)
        for (n, d) in [(0, nil), (10, nil), (3, "no-such-display")] as [(Int, String?)] {
            guard case .failure(let e) = AgentCommands.switchTarget(workspace: n, display: d, facts: facts) else { return XCTFail("\(n) \(d ?? "")") }
            XCTAssertEqual(e.code, .badArguments)
        }
    }

    func testMoveGoesToAWorkspaceOrTheOneADisplayShows() throws {
        XCTAssertNil(try AgentCommands.moveTarget(workspace: nil, display: nil, facts: facts).get(), "the older move: onto the agent workspace")
        XCTAssertEqual(try AgentCommands.moveTarget(workspace: 5, display: nil, facts: facts).get(), 5)
        XCTAssertEqual(try AgentCommands.moveTarget(workspace: nil, display: side, facts: facts).get(), 2, "Sidecar shows workspace 2")
        for (n, d) in [(5, side), (0, nil), (nil, "no-such-display")] as [(Int?, String?)] {
            guard case .failure(let e) = AgentCommands.moveTarget(workspace: n, display: d, facts: facts) else { return XCTFail("\(n ?? -1) \(d ?? "")") }
            XCTAssertEqual(e.code, .badArguments)
        }
    }

    func testOnlyTheAgentWorkspaceOutOfSightLeavesTheViewAlone() {
        XCTAssertFalse(AgentCommands.changesView(from: 9, to: 9, agentWorkspace: 9, shown: [1, 2]), "frame on the hidden agent workspace")
        XCTAssertFalse(AgentCommands.changesView(from: 3, to: 9, agentWorkspace: 9, shown: [1, 2]), "from a hidden workspace onto it")
        XCTAssertTrue(AgentCommands.changesView(from: 9, to: 9, agentWorkspace: 9, shown: [9]), "Donovan is looking at it")
        XCTAssertTrue(AgentCommands.changesView(from: 1, to: 9, agentWorkspace: 9, shown: [1]), "from under him")
        XCTAssertTrue(AgentCommands.changesView(from: 9, to: 4, agentWorkspace: 9, shown: [1]), "onto one of his workspaces")
        XCTAssertTrue(AgentCommands.changesView(from: 9, to: 9, agentWorkspace: nil, shown: []), "no agent workspace")
        XCTAssertTrue(AgentCommands.changesView(from: 1, to: 9, agentWorkspace: 9, shown: [1, 2]), "review F1: off a workspace he sees")
        XCTAssertTrue(AgentCommands.changesView(from: nil, to: 9, agentWorkspace: 9, shown: []), "a window with no workspace")
    }

    /// Review F1: `move --window <a window on his workspace> --workspace 9` under Full Access with view control off never
    /// takes it from under him, and `move --frame` on the agent workspace while a display shows it needs view control.
    func testMoveNeverChangesAWorkspaceHeSeesWithoutViewControl() throws {
        let his = HandsWindow(id: 77, pid: 300, app: "Mail", bundle: "com.apple.mail", title: "Inbox", workspace: 1)
        let e = try XCTUnwrap(WorkspaceVerbs.moveRefusal(window: his, scope: .fullAccess, agentWorkspace: 9, agentShown: false, sourceShown: true))
        XCTAssertEqual(e.code, .inUse)
        XCTAssertEqual(e.retry, .safe)
        let mine = HandsWindow(id: 4211, pid: 901, app: "TextEdit", bundle: "com.apple.TextEdit", title: "Untitled", workspace: 9)
        XCTAssertNil(WorkspaceVerbs.moveRefusal(window: mine, scope: .onAgentWorkspace, agentWorkspace: 9, agentShown: true, sourceShown: true),
                     "the old rule lets a reframe through on a shown agent workspace, so the router checks view control for it")
        let router = try Repo.text("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        XCTAssertTrue(router.contains("if req.string(\"frame\") != nil, before.agentShown, let e = viewRefusal(reframing) { return .failure(e) }"))
        XCTAssertTrue(router.contains("if case .success = r, relative != nil, after.agentShown, let e = viewRefusal(reframing) { return .failure(e) }"),
                      "checked again in the pass that frames")
        let commands = try Repo.text("Sources/BaneySpaces/Hands/HandsRouter+Commands.swift")
        XCTAssertTrue(commands.contains("let what = \"moving window \\(w.id) of \\(w.app) to workspace \\(n)\"\n        if let e = viewRefusal(what) { return .failure(e) }"),
                      "any other workspace always needs view control")
    }

    /// The router builds each answer from `place`; every shape validates against the schema.
    func testCommandResultsValidate() throws {
        let schema = try AgentAPISchema.load()
        let v: JSONValue = .int(AgentAPI.version)
        let moved = JSONValue.object(["version": v, "window": 4211, "from": 9].merging(AgentCommands.place(4211, facts)) { a, _ in a })
        XCTAssertEqual(schema.problems(json: moved.text, against: "move_result"), [])
        XCTAssertEqual(moved["frame"]?["width"], .double(756.5))
        XCTAssertEqual(moved["display"], .null, "the agent workspace is out of sight")
        XCTAssertEqual(AgentCommands.place(77, facts)["display"]?.string, main)
        let framed = JSONValue.object(["version": v, "window": 77, "frame": AgentCommands.place(77, facts)["frame"]!, "applied": "now"])
        XCTAssertEqual(schema.problems(json: framed.text, against: "frame_result"), [])
        XCTAssertEqual(schema.problems(json: JSONValue.object(["version": v, "workspace": 3, "display": .string(main), "shown": true]).text, against: "switch_result"), [])
        XCTAssertEqual(schema.problems(json: JSONValue.object(["version": v, "window": 77, "workspace": 1, "focused": true]).text, against: "focus_result"), [])
    }

    func testTheCommandsAreToolsThatActAndNeitherReadOnlyNorAConnectorGets() throws {
        for verb in ["switch", "focus", "frame"] {
            let tool = try XCTUnwrap(HandsTools.tool(verb: verb), verb)
            XCTAssertTrue(tool.acts, verb)
            XCTAssertEqual(AgentAccessGate.refusal(verb: verb, mode: .readOnly)?.code, .permissionDenied, verb)
            XCTAssertNotNil(WorkspaceVerbs.connectorRefusal(verb: verb), verb)
            XCTAssertTrue(HandsMCP.toolList().array?.contains { $0["name"]?.string == verb } == true, verb)
        }
        let move = try XCTUnwrap(HandsTools.tool(verb: "move"))
        XCTAssertEqual(Set(move.params.map(\.name)).intersection(["workspace", "display", "frame"]), ["workspace", "display", "frame"])
        guard case .success(let s) = HandsParse.command(["switch", "3", "--display", side]) else { return XCTFail("switch") }
        XCTAssertEqual(s.int("workspace"), 3)
        XCTAssertEqual(s.string("display"), side)
        guard case .success(let f) = HandsParse.command(["frame", "0,40,800,600", "--window", "4211"]) else { return XCTFail("frame") }
        XCTAssertEqual(f.string("frame"), "0,40,800,600")
        XCTAssertEqual(f.int("window"), 4211)
        guard case .success(let m) = HandsParse.command(["move", "--window", "4211", "--workspace", "3"]) else { return XCTFail("move") }
        XCTAssertEqual(m.int("workspace"), 3)
    }

    /// Only the Settings switch turns view control on, through the consent sheet, and the hands read the live switch.
    func testOnlySettingsTurnsViewControlOn() throws {
        let sources = try FileManager.default.subpathsOfDirectory(atPath: Repo.root.appendingPathComponent("Sources").path).filter { $0.hasSuffix(".swift") }
        let naming = try sources.filter { path in
            let text = try Repo.code("Sources/" + path)
            return text.contains("legacyDefaultsKey") || text.contains("\"agentViewControl\"")
        }
        XCTAssertEqual(Set(naming), ["BaneySpacesCore/AgentCommands.swift"], "only the Core code that removes it names the old key")
        XCTAssertTrue(try Repo.text("Sources/BaneySpaces/AppDelegate.swift").contains("viewControl: { ViewControlSetting.shared.enabled }"))
        XCTAssertTrue(try Repo.text("Sources/BaneySpaces/Setup.swift").contains("ViewControlSetting.shared.set($0)"))
        let setting = try Repo.code("Sources/BaneySpaces/Hands/AgentAccess.swift")
        XCTAssertTrue(setting.contains("next.set(new, confirm: AccessConsent.askViewControl)"), "turning it on asks on Polycarp's sheet")
        XCTAssertTrue(setting.contains("ViewControlSwitch.forgetSaved(in: .standard)"))
        let sheet = try Repo.code("Sources/BaneySpaces/LendConsent.swift")
        XCTAssertTrue(sheet.contains("static func askViewControl() -> Bool {\n        confirm("), "the same sheet and hardware-click check as Full Access")
    }

    /// Review F2: what `defaults write com.baney.polycarp agentViewControl -bool true`, a hand edit of the plist or a value
    /// copied from another Mac leaves on disk never turns view control on. The app removes it and starts off.
    func testADefaultsWriteLeavesViewControlOff() throws {
        let suite = "polycarp-view-control-test-\(UUID().uuidString)"
        let d = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { d.removePersistentDomain(forName: suite) }
        let written: [Any] = [true, 1, "true", "on", "YES", Data("on".utf8), ["on": true]]
        for value in written {
            d.set(value, forKey: ViewControl.legacyDefaultsKey)
            XCTAssertTrue(ViewControlSwitch.forgetSaved(in: d), "\(value)")
            XCTAssertNil(d.object(forKey: ViewControl.legacyDefaultsKey), "\(value) is removed")
            XCTAssertFalse(ViewControlSwitch().on, "\(value)")
        }
        XCTAssertFalse(ViewControlSwitch.forgetSaved(in: d), "nothing saved, nothing to remove")
    }

    /// Review F2, round 2: what the sealed design (3a4b0e34) trusted no longer turns view control on. Plant a key, as an
    /// agent could in the Keychain item that design read, and the seal that key makes under the old defaults key: the
    /// plant verifies by the old rule, yet the switch reads off at launch and the value is removed unread.
    func testAPlantedKeyAndMatchingSealLeaveViewControlOffAtLaunch() throws {
        let suite = "polycarp-view-control-seal-\(UUID().uuidString)"
        let d = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { d.removePersistentDomain(forName: suite) }
        let planted = SymmetricKey(size: .bits256)
        let sealed = Data("com.baney.polycarp agentViewControl on".utf8)
        let seal = Data(HMAC<SHA256>.authenticationCode(for: sealed, using: planted)).base64EncodedString()
        XCTAssertTrue(HMAC<SHA256>.isValidAuthenticationCode(try XCTUnwrap(Data(base64Encoded: seal)), authenticating: sealed, using: planted),
                      "the plant is a seal the sealed design accepted")
        d.set(seal, forKey: ViewControl.legacyDefaultsKey)

        let launch = ViewControlSwitch.atLaunch(d)
        XCTAssertFalse(launch.state.on, "a valid seal under a planted key reads off")
        XCTAssertTrue(launch.forgot)
        XCTAssertNil(d.object(forKey: ViewControl.legacyDefaultsKey), "removed unread")
        XCTAssertFalse(ViewControlSwitch.atLaunch(d).state.on, "and off on every launch after")

        // Nothing reads a Keychain item for the switch, so a planted one is never consulted.
        let sources = try FileManager.default.subpathsOfDirectory(atPath: Repo.root.appendingPathComponent("Sources").path).filter { $0.hasSuffix(".swift") }
        for path in sources {
            let code = try Repo.code("Sources/" + path)
            XCTAssertFalse(code.contains("com.baney.polycarp.agentViewControl"), path)
            XCTAssertFalse(code.contains("ViewControlKey"), path)
        }
        XCTAssertTrue(try Repo.code("Sources/BaneySpaces/Hands/AgentAccess.swift").contains("ViewControlSwitch.atLaunch(.standard)"), "the app starts from atLaunch")
    }

    /// Review F2, round 2: an event that isn't a hardware click can't confirm the view control sheet. The sheet counts an
    /// answer only when `LendConsent.notByHand` passes it, which asks the lend check's two questions
    /// (`UserEventSource.isGenuine`, `ConsentClick.valid`); every synthetic answer fails one, so the switch stays off.
    func testASyntheticEventCannotConfirmTheViewControlSheet() throws {
        struct Answer {
            var pid: Int64 = 0
            var state: Int64 = UserEventSource.hidSystemState
            var age: TimeInterval = 0.1
            var kind: ConsentClick.Kind = .mouseUp
            var time: Double = 12
            var inside = true
            var activation = false
        }
        func byHand(_ a: Answer) -> Bool {   // what notByHand decides, for a button enabled at 11
            UserEventSource.isGenuine(sourcePID: a.pid, sourceState: a.state, age: a.age)
                && ConsentClick.valid(kind: a.kind, eventTime: a.time, buttonEnabledAt: 11, insideButton: a.inside, keyIsActivation: a.activation)
        }
        let synthetic: [(String, Answer)] = [
            ("posted with CGEventPost by an agent's process", Answer(pid: 4242)),
            ("from a private event source", Answer(state: -1)),
            ("from the combined session source", Answer(state: 0)),
            ("an old click replayed", Answer(age: 5)),
            ("stamped in the future", Answer(age: -1)),
            ("an Accessibility press, which carries no click", Answer(kind: .other)),
            ("before the button was enabled", Answer(time: 10.5)),
            ("somewhere else on the sheet", Answer(inside: false)),
            ("a key that doesn't press the button", Answer(kind: .keyDown)),
        ]
        for (why, answer) in synthetic {
            var s = ViewControlSwitch()
            XCTAssertFalse(s.set(true) { byHand(answer) }, why)
            XCTAssertFalse(s.on, why)
        }
        var s = ViewControlSwitch()
        XCTAssertTrue(s.set(true) { byHand(Answer()) }, "a hardware click on Turn On")
        XCTAssertTrue(s.on)

        // The view control sheet goes through that check, the same one a lend's answer does.
        let sheet = try Repo.code("Sources/BaneySpaces/LendConsent.swift")
        XCTAssertTrue(sheet.contains("static func askViewControl() -> Bool {\n        confirm("))
        XCTAssertTrue(sheet.contains("if let why = LendConsent.notByHand(alert: alert, button: button, enabledAt: enabledAt) {"))
        XCTAssertTrue(sheet.contains("UserEventSource.isGenuine(sourcePID: cg.getIntegerValueField(.eventSourceUnixProcessID),"))
        XCTAssertTrue(sheet.contains("ConsentClick.valid(kind: kind, eventTime: event.timestamp, buttonEnabledAt: enabledAt, insideButton: inside, keyIsActivation: activation)"))
        XCTAssertTrue(try Repo.code("Sources/BaneySpaces/Hands/AgentAccess.swift").contains("next.set(new, confirm: AccessConsent.askViewControl)"))
    }

    /// Review F2: on only after the sheet is confirmed; a declined sheet leaves it off; off never asks.
    func testViewControlTurnsOnOnlyWhenTheSheetIsConfirmed() {
        var s = ViewControlSwitch()
        var asked = 0
        XCTAssertFalse(s.set(true) { asked += 1; return false })
        XCTAssertFalse(s.on)
        XCTAssertTrue(s.set(true) { asked += 1; return true })
        XCTAssertTrue(s.on)
        XCTAssertTrue(s.set(true) { asked += 1; return true }, "already on: no second sheet")
        XCTAssertTrue(s.set(false) { asked += 1; return false }, "turning it off never asks")
        XCTAssertFalse(s.on)
        XCTAssertEqual(asked, 2)
    }
}
