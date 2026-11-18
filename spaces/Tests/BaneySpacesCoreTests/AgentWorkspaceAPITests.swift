import XCTest
@testable import BaneySpacesCore

/// The agent workspace API (docs/agent-workspace-api.md): `windows` and `move`, and nothing else. Each test here fails if
/// its operation breaks: a list that drops, adds or garbles a window, or a move that goes where it shouldn't.
final class AgentWorkspaceAPITests: XCTestCase {
    private let notes = AgentAPI.Window(id: 42, pid: 501, app: "Notes", title: "Groceries")
    private let term = AgentAPI.Window(id: 7, pid: 502, app: "Terminal", title: "agent: build")

    // MARK: windows

    func testWindowsListsExactlyTheWindowsOnTheAgentWorkspace() throws {
        let reply = AgentAPI.windows(agentWorkspace: 9, [notes, term])
        XCTAssertTrue(reply.ok)
        XCTAssertEqual(reply.info?["workspace"], "9")
        XCTAssertEqual(reply.info?["version"], "\(AgentAPI.version)")
        // Sorted by id, every field round-trips.
        XCTAssertEqual(AgentAPI.decodeWindows(reply), [term, notes])
        XCTAssertEqual(reply.info?["windows"], #"[{"app":"Terminal","id":7,"pid":502,"title":"agent: build"},{"app":"Notes","id":42,"pid":501,"title":"Groceries"}]"#)
    }

    func testAnEmptyAgentWorkspaceIsAnEmptyListNotAnError() {
        let reply = AgentAPI.windows(agentWorkspace: 3, [])
        XCTAssertTrue(reply.ok)
        XCTAssertEqual(AgentAPI.decodeWindows(reply), [])
    }

    func testWindowsWithTheWorkspaceOffIsRefused() {
        let reply = AgentAPI.windows(agentWorkspace: nil, [notes])
        XCTAssertFalse(reply.ok)
        XCTAssertEqual(reply.info?["code"], AgentAPI.Code.agentWorkspaceOff.rawValue)
        XCTAssertNil(AgentAPI.decodeWindows(reply), "a refusal holds no list")
    }

    func testTheReplySurvivesTheWire() throws {
        let reply = AgentAPI.windows(agentWorkspace: 9, [notes])
        let back = try JSONDecoder().decode(Wire.Reply.self, from: JSONEncoder().encode(reply))
        XCTAssertEqual(AgentAPI.decodeWindows(back), [notes])
    }

    // MARK: move

    func testMoveSendsAKnownWindowToTheAgentWorkspace() {
        let move = AgentAPI.move(args: ["42"], agentWorkspace: 9, places: { $0 == 42 })
        XCTAssertEqual(move, .move(window: 42, to: 9))
        let reply = AgentAPI.moved(42, to: 9)
        XCTAssertTrue(reply.ok)
        XCTAssertEqual(reply.info?["window"], "42")
        XCTAssertEqual(reply.info?["workspace"], "9")
    }

    func testMoveRefusesWhenTheWorkspaceIsOff() {
        guard case .refused(let r) = AgentAPI.move(args: ["42"], agentWorkspace: nil, places: { _ in true }) else { return XCTFail("moved with the workspace off") }
        XCTAssertEqual(r.info?["code"], AgentAPI.Code.agentWorkspaceOff.rawValue)
    }

    func testMoveRefusesAWindowPolycarpDoesNotPlace() {
        guard case .refused(let r) = AgentAPI.move(args: ["43"], agentWorkspace: 9, places: { $0 == 42 }) else { return XCTFail("moved an unknown window") }
        XCTAssertEqual(r.info?["code"], AgentAPI.Code.noSuchWindow.rawValue)
        XCTAssertFalse(r.ok)
    }

    func testMoveTakesOneWindowNumberAndNothingElse() {
        for args in [[], ["notes"], ["42", "43"], ["-1"], ["42.0"], ["--window", "42"]] {
            guard case .refused(let r) = AgentAPI.move(args: args, agentWorkspace: 9, places: { _ in true }) else { return XCTFail("moved on \(args)") }
            XCTAssertEqual(r.info?["code"], AgentAPI.Code.badRequest.rawValue, "\(args)")
        }
    }

    // MARK: the app routes both, and a caller on another machine gets neither

    func testTheSessionRoutesBothOperationsThroughTheAPI() throws {
        let session = try SourceText.code("Sources/BaneySpaces/Session/SessionController.swift")
        let agent = try XCTUnwrap(SourceText.block(after: "func agent(_ sub: String, _ args: [String]) -> Wire.Reply", in: session))
        XCTAssertTrue(agent.contains("case \"windows\":\n            return AgentAPI.windows(agentWorkspace: h.workspace(), h.windows())"))
        XCTAssertTrue(agent.contains("switch AgentAPI.move(args: args, agentWorkspace: h.workspace(), places: h.placesWindow)"))
        XCTAssertTrue(agent.contains("h.move(id, n)"))
        let app = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("h.windows = { [weak self] in self?.spaces.agentWindows() ?? [] }"))
        XCTAssertTrue(app.contains("h.placesWindow = { [weak self] id in self?.spaces.placesWindow(id) ?? false }"))
    }

    func testARemoteCallerGetsNeitherOperation() {
        XCTAssertFalse(Remote.allows(Wire.Request(op: .agent, text: "windows")))
        XCTAssertFalse(Remote.allows(Wire.Request(op: .agent, text: "move", args: ["42"])))
        XCTAssertTrue(Remote.allows(Wire.Request(op: .agent, text: "status")))
    }
}
