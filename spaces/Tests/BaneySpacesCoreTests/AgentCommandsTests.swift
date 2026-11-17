import BaneySpacesCore
import CoreGraphics
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

    /// Only the Settings switch writes the setting; the app reads it once at launch (`ViewControlSetting`), never live.
    func testOnlySettingsTurnsViewControlOn() throws {
        let sources = try FileManager.default.subpathsOfDirectory(atPath: Repo.root.appendingPathComponent("Sources").path).filter { $0.hasSuffix(".swift") }
        let naming = try sources.filter { path in
            let text = try Repo.text("Sources/" + path)
            return text.contains("ViewControl.defaultsKey") || text.contains("\"agentViewControl\"")
        }
        XCTAssertEqual(Set(naming), ["BaneySpacesCore/AgentCommands.swift", "BaneySpaces/Hands/AgentAccess.swift"])
        XCTAssertTrue(try Repo.text("Sources/BaneySpaces/AppDelegate.swift").contains("viewControl: { ViewControlSetting.shared.enabled }"))
        XCTAssertTrue(try Repo.text("Sources/BaneySpaces/Setup.swift").contains("ViewControlSetting.shared.set($0)"))
    }
}
