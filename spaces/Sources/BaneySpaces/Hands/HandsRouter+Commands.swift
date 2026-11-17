import AppKit
import BaneySpacesCore

/// The agent API's commands (spec/agent-api.md): `switch`, `focus`, `frame`, and `move` to a workspace or display. Each
/// answers with what it read back from the model after acting. Anything that changes what Donovan sees passes
/// `ViewControl` first: this Mac, Full Access and his own setting.
extension HandsRouter {
    /// How long a command waits to see its change in the model before it answers `unverified`.
    static let readBackLimit: TimeInterval = 1.0

    static let notStarted = HandsError(.notRunning, "Polycarp hasn't finished starting", suggestion: "Try again in a moment.", retry: .safe)

    func viewRefusal(_ what: String) -> HandsError? {
        ViewControl.refusal(what, access: access, enabled: onMain { host.viewControl() }, remote: remote)
    }

    /// The facts, read again every 10 ms until `done` holds or the limit passes.
    func readBack(_ done: (AgentAPI.Facts) -> Bool) -> AgentAPI.Facts? {
        let end = Date().addingTimeInterval(Self.readBackLimit)
        repeat {
            if let f = onMain({ host.facts() }), done(f) { return f }
            Thread.sleep(forTimeInterval: 0.01)
        } while Date() < end
        return nil
    }

    func unverified(_ what: String) -> HandsEnvelope {
        .failure(HandsError(.unverified, "\(what) was asked for, but the window manager didn't show it within \(Int(Self.readBackLimit * 1000)) ms",
                            suggestion: "Read `query state` to see where things are now.", retry: .afterSnapshot))
    }

    private func shownNow() -> (agent: Int?, shown: Set<Int>) {
        onMain { (host.agentWorkspace(), Set(host.workspaceRows().filter(\.shown).map(\.number))) }
    }

    private static func childRefusal(_ w: HandsWindow) -> HandsError {
        HandsError(.notSupported, "window \(w.id) is a child window of \(w.app); it goes where its app's window goes",
                   suggestion: "Use its parent window from `query windows`.", retry: .never)
    }

    func switchWorkspace(_ req: HandsRequest) -> HandsEnvelope {
        guard let facts = onMain({ host.facts() }) else { return .failure(Self.notStarted) }
        let (n, display): (Int, String?)
        switch AgentCommands.switchTarget(workspace: req.int("workspace"), display: req.string("display"), facts: facts) {
        case .failure(let e): return .failure(e)
        case .success(let t): (n, display) = t
        }
        if let e = viewRefusal("switching to workspace \(n)") { return .failure(e) }
        onMain { host.switchTo(n, display) }
        guard readBack({ f in display.map { f.shown[$0] == n } ?? (f.current == n) }) != nil else { return unverified("workspace \(n)") }
        Trace.log("hands: switched to workspace \(n) for an agent")
        return .success(.object(["version": .int(AgentAPI.version), "workspace": .int(n), "display": display.map(JSONValue.string) ?? .null, "shown": .bool(true)]))
    }

    func focusWindow(_ req: HandsRequest) -> HandsEnvelope {
        let w: HandsWindow
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let t): w = t.0
        }
        guard w.workspace != nil else { return .failure(Self.childRefusal(w)) }
        if let e = viewRefusal("focusing window \(w.id) of \(w.app)") { return .failure(e) }
        // Scope read again on the live window in the pass that acts.
        let refused: HandsError? = onMain {
            guard let live = host.live(w.id), live.pid == w.pid, let n = live.workspace else {
                return HandsError(.windowNotFound, "window \(w.id) is gone", suggestion: "Read `query windows`.", retry: .afterSnapshot)
            }
            if case .denied(let e) = decide(live, host.agentWorkspace(), session: req.session ?? "") { return e }
            host.focus(live.id, n)
            return nil
        }
        if let refused { return .failure(refused) }
        guard let after = readBack({ $0.focusedWindow == w.id }) else { return unverified("focus on window \(w.id)") }
        Trace.log("hands: focused window \(w.id) of \(w.app) for an agent")
        return .success(.object(["version": .int(AgentAPI.version), "window": .int(Int(w.id)), "workspace": .int(after.current), "focused": .bool(true)]))
    }

    func frameWindow(_ req: HandsRequest) -> HandsEnvelope {
        let session = req.session ?? ""
        let rect: CGRect
        switch AgentCommands.frame(req.string("frame")) {
        case .failure(let e): return .failure(e)
        case .success(let r): rect = r
        }
        let w: HandsWindow
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let t): w = t.0
        }
        guard let n = w.workspace else { return .failure(Self.childRefusal(w)) }
        let what = "framing window \(w.id) of \(w.app)"
        func viewProblem(_ ws: Int) -> HandsError? {
            let (agent, shown) = shownNow()
            switch AgentCommands.need(from: ws, to: ws, agentWorkspace: agent, shown: shown) {
            case .nothing: return nil
            case .notWhileShown: return ViewControl.notWhileShown(what)
            case .viewControl: return viewRefusal(what)
            }
        }
        if let e = viewProblem(n) { return .failure(e) }
        if let e = awaitUse(w, verb: "frame", delivery: .posted, wait: req.int("wait"), session: session) { return .failure(e) }
        let busy = Self.busy(w.app, verb: "frame")
        let applied = onProcessQueues([w.pid], busy: busy) { [self] cancelled in
            mutateOnMain([w], verb: "frame", session: session) { _ -> Result<String, HandsError> in
                if cancelled() { return .failure(busy) }
                // The agent workspace may have come into sight, or the window moved, while the frame waited.
                guard let live = host.live(w.id), let ws = live.workspace else { return .failure(Self.childRefusal(w)) }
                if let e = viewProblem(ws) { return .failure(e) }
                return .success(host.setFrame(w.id, rect))
            }
        }
        switch applied {
        case .failure(let e): return .failure(e)
        case .success(let how):
            let close = { (f: AgentAPI.Facts) in
                f.windows.first { $0.window.id == w.id }?.frame.map { abs($0.minX - rect.minX) < 2 && abs($0.minY - rect.minY) < 2 && abs($0.width - rect.width) < 2 && abs($0.height - rect.height) < 2 } ?? false
            }
            let after = readBack(close) ?? onMain { host.facts() }
            var data: [String: JSONValue] = ["version": .int(AgentAPI.version), "window": .int(Int(w.id)), "applied": .string(how)]
            data["frame"] = after.map { AgentCommands.place(w.id, $0)["frame"] ?? .null } ?? .null
            if after.map(close) != true { data["note"] = "the app kept a different frame than the one asked for" }
            guard data["frame"] != .null else { return unverified("frame of window \(w.id)") }
            return .success(.object(data))
        }
    }

    /// `move` with `workspace` or `display`. Onto the agent workspace it is the older `move`, with all its rules; anywhere
    /// else it changes what Donovan sees and needs view control.
    func moveTo(_ req: HandsRequest, workspace n: Int) -> HandsEnvelope {
        let session = req.session ?? ""
        if n == shownNow().agent {
            var plain = req
            plain.args["workspace"] = nil
            plain.args["display"] = nil
            return moveCommand(plain)
        }
        let w: HandsWindow
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let t): w = t.0
        }
        guard let from = w.workspace else { return .failure(Self.childRefusal(w)) }
        let what = "moving window \(w.id) of \(w.app) to workspace \(n)"
        if let e = viewRefusal(what) { return .failure(e) }
        if from != n {
            if let e = awaitUse(w, verb: "move", delivery: .posted, wait: req.int("wait"), session: session) { return .failure(e) }
            let busy = Self.busy(w.app, verb: "move")
            let moved = onProcessQueues([w.pid], busy: busy) { [self] cancelled in
                mutateOnMain([w], verb: "move", session: session) { _ -> Result<Void, HandsError> in
                    if cancelled() { return .failure(busy) }
                    host.move(w.id, n)
                    return .success(())
                }
            }
            if case .failure(let e) = moved { return .failure(e) }
        }
        guard let after = readBack({ f in f.windows.contains { $0.window.id == w.id && $0.window.workspace == n } }) else { return unverified("window \(w.id) on workspace \(n)") }
        Trace.log("hands: moved window \(w.id) of \(w.app) from workspace \(from) to \(n) for an agent")
        return .success(.object(["version": .int(AgentAPI.version), "window": .int(Int(w.id)), "from": .int(from)].merging(AgentCommands.place(w.id, after)) { a, _ in a }))
    }

    /// `move`: to a workspace or display when one is given, else onto the agent workspace as before.
    func moveCommand(_ req: HandsRequest) -> HandsEnvelope {
        if req.args["workspace"] != nil || req.args["display"] != nil {
            guard let facts = onMain({ host.facts() }) else { return .failure(Self.notStarted) }
            // A workspace that isn't a number is refused, never read as "no workspace".
            let n = req.args["workspace"] == nil ? nil : (req.int("workspace") ?? 0)
            switch AgentCommands.moveTarget(workspace: n, display: req.string("display"), facts: facts) {
            case .failure(let e): return .failure(e)
            case .success(let n?): return moveTo(req, workspace: n)
            case .success(nil): break
            }
        }
        return withPlace(move(req), window: req.int("window").flatMap { UInt32(exactly: $0) } ?? 0)
    }

    /// `move`'s older answer, with the place it ended up in as the agent API reports it.
    func withPlace(_ env: HandsEnvelope, window id: UInt32) -> HandsEnvelope {
        guard env.ok, case .object(var o)? = env.data, let facts = onMain({ host.facts() }) else { return env }
        o["version"] = .int(AgentAPI.version)
        o.merge(AgentCommands.place(id, facts)) { _, new in new }
        var out = env
        out.data = .object(o)
        return out
    }
}
