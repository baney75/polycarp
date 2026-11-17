import BaneySpacesCore
import CoreGraphics
import XCTest

/// The agent API's events (spec/agent-api.md, "Events"): the diff of two reads through a caller's scope, every event
/// validated against the schema, and the stream on a real Unix socket.
final class AgentEventsTests: XCTestCase {
    let main = AgentAPIQueryTests.main, side = AgentAPIQueryTests.side
    let agentView = AgentAPIQueryTests.agentView, fullView = AgentAPIQueryTests.fullView
    var schema: AgentAPISchema!

    override func setUpWithError() throws { schema = try AgentAPISchema.load() }

    func facts(_ change: (inout AgentAPI.Facts) -> Void = { _ in }) -> AgentAPI.Facts {
        var f = AgentAPIQueryTests.facts()
        change(&f)
        return f
    }

    /// Every event validates as a line on the wire, and the types come back in order.
    func types(_ old: AgentAPI.Facts, _ new: AgentAPI.Facts, _ v: AgentAPI.View, _ nv: AgentAPI.View? = nil) -> [String] {
        let events = AgentEvents.diff(old, v, new, nv ?? v)
        for (i, e) in events.enumerated() {
            XCTAssertEqual(schema.problems(json: AgentEvents.line(e, seq: i + 1, at: Date()), against: "event"), [], e.type)
        }
        return events.map(\.type)
    }

    func testHelloCarriesTheWholeStateAndWhatWillBeSent() throws {
        let filter = try AgentEvents.filter("window_focused").get()
        let hello = AgentEvents.hello(facts(), agentView, types: filter)
        let line = AgentEvents.line(hello, seq: 1, at: Date(timeIntervalSince1970: 1_763_400_000.123))
        XCTAssertEqual(schema.problems(json: line, against: "event"), [])
        let parsed = try XCTUnwrap(JSONValue.parse(line))
        XCTAssertEqual(parsed["at"]?.int, 1_763_400_000_123, "unix milliseconds")
        XCTAssertEqual(parsed["data"]?["events"]?.array?.compactMap(\.string), ["hello", "window_focused", "lagged"])
        XCTAssertEqual(parsed["data"]?["state"]?["windows"]?.array?.count, 1, "the state through the caller's scope")
        XCTAssertFalse(line.contains("Bank statement"))
    }

    func testTheFilterRefusesUnknownTypes() throws {
        XCTAssertNil(try AgentEvents.filter(nil).get())
        XCTAssertNil(try AgentEvents.filter(" ").get())
        XCTAssertEqual(try AgentEvents.filter("workspace_switched, theme_changed").get(), ["workspace_switched", "theme_changed", "hello", "lagged"])
        guard case .failure(let e) = AgentEvents.filter("window_focussed") else { return XCTFail() }
        XCTAssertEqual(e.code, .badArguments)
    }

    func testNothingChangedSendsNothing() {
        XCTAssertEqual(types(facts(), facts(), fullView), [])
    }

    func testASwitchIsReportedPerDisplay() {
        let after = facts { $0.shown[self.side] = 4 }
        XCTAssertEqual(types(facts(), after, agentView), ["workspace_switched"])
        let e = AgentEvents.diff(facts(), agentView, after, agentView)[0]
        XCTAssertEqual(e.data, .object(["display": .string(side), "from": 2, "to": 4]))
        let current = facts { $0.shown[self.main] = 3; $0.current = 3 }
        XCTAssertEqual(types(facts(), current, agentView), ["workspace_switched", "window_focused"])
    }

    func testFocusIsSentOnlyWhenTheCallerCouldSeeADifference() {
        // Donovan moves between two of his own windows on the workspace he is on: an agent-scoped caller learns nothing.
        let other = facts { $0.focusedWindow = 78 }
        XCTAssertEqual(types(facts(), other, agentView), [])
        XCTAssertEqual(types(facts(), other, fullView), ["window_focused"])
        let mine = facts { $0.focusedWindow = 4211; $0.current = 9; $0.shown[self.main] = 9 }
        let events = AgentEvents.diff(facts(), agentView, mine, agentView)
        XCTAssertEqual(events.first { $0.type == "window_focused" }?.data["window"]?.int, 4211)
    }

    func testWindowsComeGoAndMoveInScopeOnly() {
        let opened = facts { $0.windows.append(.init(window: HandsWindow(id: 5000, pid: 902, app: "Preview", bundle: "com.apple.Preview", title: "", workspace: 9))) }
        let wider = AgentAPI.View(access: .standard, inScope: [4211, 5000])
        XCTAssertEqual(types(facts(), opened, agentView, wider), ["window_created"])
        XCTAssertEqual(types(facts(), opened, agentView), [], "a window out of scope is never sent")
        XCTAssertEqual(types(opened, facts(), wider, agentView), ["window_closed"])

        let moved = facts { $0.windows[2].window.workspace = 8 }
        XCTAssertEqual(types(facts(), moved, agentView), ["window_moved"])
        let e = AgentEvents.diff(facts(), agentView, moved, agentView)[0]
        XCTAssertEqual(e.data["from"]?["workspace"]?.int, 9)
        XCTAssertEqual(e.data["to"]?["workspace"]?.int, 8)
        XCTAssertEqual(e.data["to"]?["frame"]?["width"], .double(756.5))

        let nudged = facts { $0.windows[2].frame?.origin.x += 0.4 }
        XCTAssertEqual(types(facts(), nudged, agentView), [], "under a point is noise")
        let resized = facts { $0.windows[2].frame?.size.width = 900 }
        XCTAssertEqual(types(facts(), resized, agentView), ["window_moved"])
    }

    /// A lend that ends takes the window out of scope: the caller sees it close, never where it went.
    func testLeavingScopeIsAClose() {
        let lent = AgentAPI.View(access: .standard, inScope: [4211, 77])
        let after = facts { $0.windows[0].window.workspace = 3 }
        let events = AgentEvents.diff(facts(), lent, after, agentView)
        XCTAssertEqual(events.map(\.type), ["window_closed"])
        XCTAssertEqual(events[0].data, .object(["window": 77, "workspace": 1]))
    }

    func testTheLookChanging() {
        let after = facts { $0.theme.polycarp = (name: "dawn", title: "Dawn", mode: "light") }
        XCTAssertEqual(types(facts(), after, agentView), ["theme_changed"])
    }

    func testSubscribeIsLocalOnly() {
        let r = Wire.Request(op: .subscribe, target: "s1")
        XCTAssertFalse(Remote.allows(r), "no other machine subscribes on the tailnet socket")
        XCTAssertNil(SocketPolicy.refusal(for: r))
    }

    /// The reader hands over every line, also when the app writes several in one packet or one line across two.
    func testTheStreamDeliversEveryLineOnARealSocket() throws {
        let path = NSTemporaryDirectory() + "pcev-\(getpid()).sock"
        unlink(path)
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = try XCTUnwrap(Wire.address(path: path))
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(listen(listener, 1), 0)
        defer { close(listener); unlink(path) }
        let asked = expectation(description: "request read")
        DispatchQueue.global().async {
            let c = accept(listener, nil, nil)
            guard let req = Wire.readLine(c), let r = try? JSONDecoder().decode(Wire.Request.self, from: req), r.op == .subscribe, r.text == "theme_changed" else { close(c); return }
            asked.fulfill()
            _ = Wire.writeAll(c, Data("{\"seq\":1}\n{\"seq\":2}\n{\"se".utf8))
            usleep(20_000)
            _ = Wire.writeAll(c, Data("q\":3}\n".utf8))
            close(c)
        }
        var got: [Int] = []
        let reached = Wire.stream(Wire.Request(op: .subscribe, target: "s1", text: "theme_changed"), path: path) { line in
            got.append(JSONValue.parse(line)?["seq"]?.int ?? -1)
            return true
        }
        wait(for: [asked], timeout: 5)
        XCTAssertTrue(reached)
        XCTAssertEqual(got, [1, 2, 3])
    }

    /// The app keeps the connection for `subscribe` and hears every change the model publishes.
    func testTheAppHoldsTheConnectionAndHooksTheModel() throws {
        let server = try Repo.code("Sources/BaneySpaces/Session/Server.swift")
        XCTAssertTrue(server.contains("} else if req.op == .subscribe {\n                kept = true"))
        let spaces = try Repo.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(spaces.contains("private func persist() {\n        onModelChange?()"))
        XCTAssertTrue(spaces.contains("model.noteFocus(id)\n        onModelChange?()"))
        let app = try Repo.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("spaces.onModelChange = { [weak self] in self?.session.hands.events.changed() }"))
        XCTAssertTrue(app.contains("forName: Appearance.didChange, object: nil, queue: .main) { [weak self] _ in\n            self?.session.hands.events.changed()"))
    }
}
