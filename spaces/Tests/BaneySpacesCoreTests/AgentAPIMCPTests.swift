import BaneySpacesCore
import CoreGraphics
import XCTest

/// The agent API over MCP (spec/agent-api.md): an MCP client lists the tools, sets a test window's frame, reads it back
/// with `query` and sees it move in `events`, against a small window manager made of the same facts the app reads.
/// The live variant against the running app is `scripts/agent-api-probe.swift`.
final class AgentAPIMCPTests: XCTestCase {
    var schema: AgentAPISchema!

    override func setUpWithError() throws { schema = try AgentAPISchema.load() }

    /// The app's side of each call: the router's answers, from facts it owns.
    final class FakeManager {
        var facts = AgentAPIQueryTests.facts()
        let view = AgentAPIQueryTests.agentView
        var poll: AgentEventPoll?
        var calls: [HandsRequest] = []

        func perform(_ r: HandsRequest) -> HandsEnvelope {
            calls.append(r)
            switch r.verb {
            case "query":
                return .success(AgentAPI.result(AgentAPI.Query(rawValue: r.string("what") ?? "state") ?? .state, facts, view))
            case "events":
                if let since = r.int("since"), let poll { return poll.answer(since: since, waitMs: r.int("wait_ms")) }
                let p = AgentEventPoll(types: try? AgentEvents.filter(r.string("events")).get())
                p.push([AgentEvents.hello(facts, view, types: p.types)], at: Date())
                poll = p
                return p.answer(since: 0, waitMs: 0)
            case "frame":
                guard let id = r.int("window"), case .success(let rect) = AgentCommands.frame(r.string("frame")),
                      let i = facts.windows.firstIndex(where: { $0.window.id == UInt32(id) }) else {
                    return .failure(HandsError(.badArguments, "no", suggestion: "", retry: .never))
                }
                let old = facts
                facts.windows[i].frame = rect
                poll?.push(AgentEvents.diff(old, view, facts, view), at: Date())
                return .success(.object(["version": .int(AgentAPI.version), "window": .int(id), "frame": AgentAPI.frame(rect), "applied": "now"]))
            default:
                return .failure(HandsError(.badArguments, "not in this fake: \(r.verb)", suggestion: "", retry: .never))
            }
        }
    }

    var id = 0
    func call(_ s: HandsMCP, _ method: String, _ params: JSONValue = .object([:])) throws -> JSONValue {
        id += 1
        let line = JSONValue.object(["jsonrpc": "2.0", "id": .int(id), "method": .string(method), "params": params]).text
        let reply = try XCTUnwrap(s.handle(line).flatMap(JSONValue.parse), method)
        XCTAssertNil(reply["error"], method)
        return try XCTUnwrap(reply["result"], method)
    }

    /// A `tools/call`'s answer: the envelope's data, checked against the schema.
    func tool(_ s: HandsMCP, _ name: String, _ args: [String: JSONValue], is def: String) throws -> JSONValue {
        let result = try call(s, "tools/call", .object(["name": .string(name), "arguments": .object(args)]))
        XCTAssertEqual(result["isError"], .bool(false), "\(name): \(result)")
        let text = try XCTUnwrap(result["content"]?.array?.first?["text"]?.string, name)
        let data = try XCTUnwrap(JSONValue.parse(text)?["data"], name)
        XCTAssertEqual(schema.problems(json: data.text, against: def), [], name)
        return data
    }

    func testAnMCPClientListsTheToolsMovesATestWindowAndReadsItBack() throws {
        let wm = FakeManager()
        let s = HandsMCP(version: "1", session: "mcp:probe", perform: wm.perform)
        _ = try call(s, "initialize")

        let tools = try XCTUnwrap(try call(s, "tools/list")["tools"]?.array)
        func listed(_ name: String) -> JSONValue? { tools.first { $0["name"]?.string == name } }
        for name in ["query", "events"] {
            XCTAssertEqual(listed(name)?["annotations"]?["readOnlyHint"], .bool(true), name)
        }
        for name in ["switch", "focus", "frame", "move"] {
            XCTAssertEqual(listed(name)?["annotations"]?["readOnlyHint"], .bool(false), name)
        }
        XCTAssertEqual(listed("events")?["inputSchema"]?["properties"]?["since"]?["type"]?.string, "integer")
        XCTAssertEqual(listed("events")?["inputSchema"]?["properties"]?["wait_ms"]?["type"]?.string, "integer")

        let hello = try tool(s, "events", [:], is: "events_result")
        XCTAssertEqual(hello["events"]?.array?.first?["type"]?.string, "hello")
        let since = try XCTUnwrap(hello["next"]?.int)

        let before = try tool(s, "query", ["what": "windows"], is: "windows_result")
        XCTAssertEqual(before["windows"]?.array?.map { $0["id"]?.int }, [4211], "the agent's scope: its own window only")

        _ = try tool(s, "frame", ["window": 4211, "frame": "100,120,640,480"], is: "frame_result")
        let after = try tool(s, "query", ["what": "windows"], is: "windows_result")
        let frame = try XCTUnwrap(after["windows"]?.array?.first?["frame"])
        XCTAssertEqual(["x", "y", "width", "height"].compactMap { frame[$0]?.int }, [100, 120, 640, 480])

        let moved = try tool(s, "events", ["since": .int(since), "wait_ms": 0], is: "events_result")
        XCTAssertEqual(moved["events"]?.array?.compactMap { $0["type"]?.string }, ["window_moved"])
        XCTAssertEqual(moved["events"]?.array?.first?["data"]?["to"]?["frame"]?["width"]?.int, 640)
        XCTAssertEqual(moved["next"]?.int, since + 1)
        XCTAssertEqual(wm.calls.map(\.verb), ["events", "query", "frame", "query", "events"])
        XCTAssertEqual(Set(wm.calls.compactMap(\.session)), ["mcp:probe"], "every call carries the MCP session, which picks the poll")
    }

    func testEventsIsAReadEveryoneGets() {
        XCTAssertNil(AgentAccessGate.refusal(verb: "events", mode: .readOnly))
        XCTAssertNil(WorkspaceVerbs.connectorRefusal(verb: "events"))
        XCTAssertFalse(HandsTools.tool(verb: "events")?.acts ?? true)
    }

    // MARK: the poll buffer

    func event(_ n: Int) -> AgentEvents.Event { AgentEvents.Event("workspace_switched", .object(["display": "d", "from": 1, "to": .int(n)])) }

    func types(_ r: Result<(events: [JSONValue], next: Int), HandsError>) -> [String] {
        (try? r.get().events.compactMap { $0["type"]?.string }) ?? ["failed"]
    }

    func testAnEventStaysUntilALaterSinceAcknowledgesIt() throws {
        let p = AgentEventPoll(types: nil)
        p.push([event(2), event(3)], at: Date())
        let first = try p.read(since: 0, wait: 0).get()
        XCTAssertEqual(first.events.count, 2)
        XCTAssertEqual(first.next, 2)
        XCTAssertEqual(try p.read(since: 0, wait: 0).get().events.count, 2, "a retried call gets the same answer")
        XCTAssertEqual(try p.read(since: 2, wait: 0).get().events.count, 0)
        XCTAssertEqual(try p.read(since: 2, wait: 0).get().next, 2)
        guard case .failure(let e) = p.read(since: 3, wait: 0) else { return XCTFail("since past the last event") }
        XCTAssertEqual(e.code, .badArguments)
    }

    func testAWaitEndsWhenAnEventArrives() throws {
        let p = AgentEventPoll(types: nil)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { p.push([self.event(4)], at: Date()) }
        let start = Date()
        let r = try p.read(since: 0, wait: 3).get()
        XCTAssertLessThan(Date().timeIntervalSince(start), 1, "woken by the push, not the deadline")
        XCTAssertEqual(r.events.first?["data"]?["to"]?.int, 4)
    }

    func testAnEmptyWaitEndsAtItsDeadline() throws {
        let start = Date()
        XCTAssertEqual(try AgentEventPoll(types: nil).read(since: 0, wait: 0.1).get().events.count, 0)
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(start), 0.09)
    }

    /// Past `keep` unread events the rest are counted, and one `lagged` with the count follows once there is room: `seq`
    /// never skips a number.
    func testAReaderThatFallsBehindGetsOneLaggedAndNoGap() throws {
        let p = AgentEventPoll(types: nil)
        p.push((0..<(AgentEventPoll.keep + 44)).map(event), at: Date())
        let full = try p.read(since: 0, wait: 0).get()
        XCTAssertEqual(full.events.count, AgentEventPoll.keep)
        let rest = try p.read(since: full.next, wait: 0).get()
        XCTAssertEqual(rest.events.map { $0["type"]?.string }, ["lagged"])
        XCTAssertEqual(rest.events[0]["data"]?["missed"]?.int, 44)
        XCTAssertEqual(rest.events[0]["seq"]?.int, AgentEventPoll.keep + 1)
        XCTAssertEqual(schema.problems(json: rest.events[0].text, against: "event"), [])
    }

    func testTheFilterKeepsOnlyTheTypesAskedFor() {
        let p = AgentEventPoll(types: try? AgentEvents.filter("theme_changed").get())
        p.push([event(2), AgentEvents.Event("theme_changed", .object(["theme": "a", "palette": "auto", "polycarp_theme": .null]))], at: Date())
        XCTAssertEqual(types(p.read(since: 0, wait: 0)), ["theme_changed"])
    }
}
