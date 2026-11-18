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

    private let now = Date(timeIntervalSince1970: 1_000_000)
    /// Window 42, of pid 501, on workspace `on`, its process started `age` seconds ago.
    private func one(on n: Int, age: TimeInterval?) -> (UInt32) -> AgentAPI.Candidate? {
        { $0 == 42 ? AgentAPI.Candidate(workspace: n, pid: 501, started: age.map { self.now.addingTimeInterval(-$0) }) : nil }
    }
    private func move(_ window: @escaping (UInt32) -> AgentAPI.Candidate?, args: [String] = ["42"], ws: Int? = 9, alive: Bool = true) -> AgentAPI.Move {
        AgentAPI.move(args: args, agentWorkspace: ws, window: window, alive: { _ in alive }, now: now)
    }
    private func code(_ m: AgentAPI.Move) -> String? { if case .refused(let r) = m { return r.info?["code"] }; return nil }

    func testMoveSendsAKnownWindowToTheAgentWorkspace() {
        XCTAssertEqual(move(one(on: 2, age: 5)), .move(window: 42, to: 9))
        let reply = AgentAPI.moved(42, to: 9)
        XCTAssertTrue(reply.ok)
        XCTAssertEqual(reply.info?["window"], "42")
        XCTAssertEqual(reply.info?["workspace"], "9")
    }

    func testMoveRefusesWhenTheWorkspaceIsOff() {
        XCTAssertEqual(code(move(one(on: 2, age: 5), ws: nil)), AgentAPI.Code.agentWorkspaceOff.rawValue)
    }

    func testMoveRefusesAWindowPolycarpDoesNotPlace() {
        XCTAssertEqual(code(move(one(on: 2, age: 5), args: ["43"])), AgentAPI.Code.noSuchWindow.rawValue)
    }

    func testMoveTakesOneWindowNumberAndNothingElse() {
        for args in [[], ["notes"], ["42", "43"], ["-1"], ["42.0"], ["--window", "42"]] {
            XCTAssertEqual(code(move(one(on: 2, age: 5), args: args)), AgentAPI.Code.badRequest.rawValue, "\(args)")
        }
    }

    /// Review r1 first-F2: any local process could send Donovan's window away. Only an app started in the last minute moves.
    func testMoveRefusesAWindowOfAnAppThatHasRunLong() {
        XCTAssertEqual(code(move(one(on: 2, age: 3600))), AgentAPI.Code.refused.rawValue, "his long-running app stays")
        XCTAssertEqual(code(move(one(on: 2, age: AgentAPI.freshProcess + 1))), AgentAPI.Code.refused.rawValue)
        XCTAssertEqual(code(move(one(on: 2, age: nil))), AgentAPI.Code.refused.rawValue, "an unreadable start time is not fresh")
        XCTAssertEqual(move(one(on: 2, age: AgentAPI.freshProcess - 1)), .move(window: 42, to: 9), "an app just started moves")
        XCTAssertEqual(move(one(on: 9, age: 3600)), .move(window: 42, to: 9), "one already on the agent workspace may always move")
    }

    /// Review r1 sol-F1: the model keeps a window of a process that quit until the next scan; moving it is no_such_window.
    func testMoveRefusesAWindowWhoseProcessIsGone() {
        XCTAssertEqual(code(move(one(on: 2, age: 5), alive: false)), AgentAPI.Code.noSuchWindow.rawValue)
        XCTAssertEqual(code(move(one(on: 9, age: 5), alive: false)), AgentAPI.Code.noSuchWindow.rawValue)
    }

    // MARK: the record an older build saved (review r1 second-F7)

    func testAnOldMovedInRecordSendsEachLiveWindowBackWhereItCameFrom() {
        let saved = Data(#"[{"window":42,"pid":501,"startedAt":5,"origin":"lent","from":2,"to":9,"returning":false},{"window":43,"pid":502,"origin":"full_access","from":9,"to":9,"returning":true},{"window":44,"pid":503,"origin":"lent","from":3,"to":9,"returning":false},{"window":45,"pid":504,"origin":"lent","from":4,"to":9,"returning":false},{"window":46,"pid":505,"origin":"lent","from":12,"to":9,"returning":false}]"#.utf8)
        let entries = AgentAPI.OldMovedIn.decode(saved)
        XCTAssertEqual(entries.map { $0.window }, [42, 43, 44, 45, 46])
        let e = entries[0]
        XCTAssertEqual(AgentAPI.OldMovedIn.destination(e, current: 1, agentWorkspace: 9), 2, "back where it came from")
        XCTAssertEqual(AgentAPI.OldMovedIn.destination(entries[1], current: 1, agentWorkspace: 9), 1, "its origin is the agent workspace now")
        XCTAssertEqual(AgentAPI.OldMovedIn.destination(entries[4], current: 1, agentWorkspace: 9), 1, "its origin is no workspace")
        let places: [UInt32: AgentAPI.Candidate] = [42: .init(workspace: 9, pid: 501, started: nil), 43: .init(workspace: 9, pid: 502, started: nil),
                                                    44: .init(workspace: 3, pid: 503, started: nil), 45: .init(workspace: 9, pid: 999, started: nil),
                                                    46: .init(workspace: 9, pid: 505, started: nil)]
        let back = AgentAPI.OldMovedIn.sendBack(entries, window: { places[$0] }, alive: { $0 != 505 }, current: 1, agentWorkspace: 9)
        // 44 Donovan moved since, 45 is another process now, 46's process is gone.
        XCTAssertEqual(back.map { $0.window }, [42, 43])
        XCTAssertEqual(back.map { $0.to }, [2, 1])
        XCTAssertEqual(AgentAPI.OldMovedIn.decode(Data("not json".utf8)), [])
    }

    // MARK: the app routes both, and a caller on another machine gets neither

    func testTheSessionRoutesBothOperationsThroughTheAPI() throws {
        let session = try SourceText.code("Sources/BaneySpaces/Session/SessionController.swift")
        let agent = try XCTUnwrap(SourceText.block(after: "func agent(_ sub: String, _ args: [String]) -> Wire.Reply", in: session))
        XCTAssertTrue(agent.contains("case \"windows\":\n            return AgentAPI.windows(agentWorkspace: h.workspace(), h.windows())"))
        XCTAssertTrue(agent.contains("switch AgentAPI.move(args: args, agentWorkspace: h.workspace(), window: h.window)"))
        XCTAssertTrue(agent.contains("h.move(id, n)"))
        let app = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("h.windows = { [weak self] in self?.spaces.agentWindows() ?? [] }"))
        XCTAssertTrue(app.contains("h.window = { [weak self] id in self?.spaces.moveCandidate(id) }"))
        XCTAssertTrue(app.contains("DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.sendBackOldMovedIn() }"))
        let spaces = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(spaces.contains("return AgentAPI.Candidate(workspace: n, pid: w.pid, started: Self.processStart(w.pid))"))
    }

    func testARemoteCallerGetsNeitherOperation() {
        XCTAssertFalse(Remote.allows(Wire.Request(op: .agent, text: "windows")))
        XCTAssertFalse(Remote.allows(Wire.Request(op: .agent, text: "move", args: ["42"])))
        XCTAssertTrue(Remote.allows(Wire.Request(op: .agent, text: "status")))
    }
}
