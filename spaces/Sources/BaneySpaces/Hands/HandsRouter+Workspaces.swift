import AppKit
import BaneySpacesCore

/// Child windows (dialogs, alerts, sheets, palettes an app raises) and the verbs that let an agent manage its own workspace
/// (`workspaces`, `arrange`, `move`, `close`). Donovan, 2026-11-10: "make it so spaces can be managed by the agents so they
/// can start windows in a BG if they so choose so the user doesnt have to deal with it". Every rule here is in the core:
/// `ChildWindowRule`, `ChildAttribution`, `WorkspaceVerbs`, `AgentArrange`, `SessionWindows`. Nothing here switches the
/// shown workspace, focuses or raises a window, or quits an app.
extension HandsRouter {
    func childLocked<T>(_ f: () -> T) -> T { childLock.lock(); defer { childLock.unlock() }; return f() }

    // MARK: child windows

    /// One process's child windows, read now (off the main thread), each seen by the attribution book.
    func readChildren(pid: Int32, all: [HandsWindow]) -> ChildWindowsAX.Reading {
        let placed = Set(all.filter { $0.pid == pid }.map(\.id))
        let r = ChildWindowsAX.read(pid: pid, placed: placed)
        let now = Date()
        childLocked { attribution.observed(Set(r.children.map(\.id)), pid: pid, at: now) }
        return r
    }

    /// A window BaneySpaces doesn't place, as the engine and the scope checks see it; nil when no process lists it as a
    /// child window (closed, a menu, or unreadable).
    func childWindow(_ id: UInt32) -> HandsWindow? {
        guard let pid = ChildWindowsAX.owner(id) else { return nil }
        let all = listWindows().windows
        return readChildren(pid: pid, all: all).children.first { $0.id == id }?.window
    }

    /// The decision for one child window of `pid`, read now.
    func childDecision(_ id: UInt32, pid: Int32, agent: Int?, session: String) -> (facts: ChildWindowFacts, decision: ChildWindowRule.Decision)? {
        let all = listWindows().windows
        let running = NSRunningApplication(processIdentifier: pid)
        let bundle = running?.bundleIdentifier ?? "", process = running?.executableURL?.lastPathComponent ?? ""
        // Rule 3 before reading anything of it: a system prompt's window is never read for an agent.
        if ChildWindowRule.isSystemPrompt(bundle: bundle, processName: process) {
            let facts = ChildWindowFacts(id: id, pid: pid, app: running?.localizedName ?? process, bundle: bundle, processName: process)
            return (facts, ChildWindowRule.decide(facts, placed: [], attributed: false, selfPid: getpid()))
        }
        guard let facts = readChildren(pid: pid, all: all).children.first(where: { $0.id == id }) else { return nil }
        return (facts, decideChild(facts, all: all, agent: agent, session: session))
    }

    func decideChild(_ c: ChildWindowFacts, all: [HandsWindow], agent: Int?, session: String) -> ChildWindowRule.Decision {
        let placed = all.filter { $0.pid == c.pid }.map { (window: $0, scope: decide($0, agent, session: session)) }
        let attributed = childLocked { attribution.attributed(c.id, pid: c.pid, session: session) }
        return ChildWindowRule.decide(c, placed: placed, attributed: attributed, selfPid: getpid())
    }

    /// `windows`: the child windows of these processes, decided, and which placed windows hold a sheet with no number.
    func children(ofPids pids: Set<Int32>, all: [HandsWindow], agent: Int?, session: String)
        -> (rows: [(facts: ChildWindowFacts, decision: ChildWindowRule.Decision)], sheetsOn: Set<UInt32>) {
        let list = Array(pids)
        var readings = [ChildWindowsAX.Reading](repeating: .init(children: [], sheetsOn: []), count: list.count)
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: list.count) { i in
            let r = readChildren(pid: list[i], all: all)
            lock.lock(); readings[i] = r; lock.unlock()
        }
        let facts = readings.flatMap(\.children).sorted { $0.id < $1.id }
        return (facts.map { ($0, decideChild($0, all: all, agent: agent, session: session)) }, readings.reduce(into: Set<UInt32>()) { $0.formUnion($1.sheetsOn) })
    }

    /// Right before an action on `pid`: the child windows it has now, recorded as this session's action, and a watch that
    /// looks again every half second for 10 s so a dialog the action raises is seen within the window.
    func noteAction(session: String, pid: Int32) -> Set<UInt32> {
        let all = listWindows().windows
        let existing = Set(ChildWindowsAX.read(pid: pid, placed: Set(all.filter { $0.pid == pid }.map(\.id))).children.map(\.id))
        let now = Date()
        childLocked { attribution.acted(session: session, pid: pid, at: now, existing: existing) }
        watch(pid: pid)
        return existing
    }

    private func watch(pid: Int32) {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, self.childLocked({ self.attribution.watching(pid: pid, now: Date()) }) else { return }
            _ = self.readChildren(pid: pid, all: self.listWindows().windows)
            self.watch(pid: pid)
        }
    }

    /// After an action: the child windows that appeared since `before`, looked for up to 200 ms. Nil when none did.
    func openedChildren(pid: Int32, before: Set<UInt32>, session: String) -> JSONValue? {
        let deadline = Date().addingTimeInterval(0.2)
        repeat {
            let all = listWindows().windows
            let new = readChildren(pid: pid, all: all).children.filter { !before.contains($0.id) }
            if !new.isEmpty {
                let agent = onMain { host.agentWorkspace() }
                let usable = new.filter { decideChild($0, all: all, agent: agent, session: session).allowed }
                return usable.isEmpty ? nil : (usable.count == 1 ? ChildWindowList.opened(usable[0]) : .array(usable.map(ChildWindowList.opened)))
            }
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < deadline
        return nil
    }

    // MARK: workspaces

    func workspaces(_ req: HandsRequest) -> HandsEnvelope {
        let (all, agent) = listWindows(fresh: true)
        let rows = onMain { host.workspaceRows() }
        let usable = all.map { (window: $0, scope: decide($0, agent, session: req.session ?? "")) }.filter { $0.scope.allowed }
        return .success(WorkspaceList.json(rows: rows, agentWorkspace: agent, access: access, usable: usable))
    }

    /// The agent workspace windows this request may lay out, in order, each still in scope; or why not.
    private func agentWindows(_ ids: [UInt32]?, session: String) -> Result<[HandsWindow], HandsError> {
        let (all, agent) = listWindows(fresh: true)
        guard let agent else { return .failure(HandsError(.agentWorkspaceOff, "there is no agent workspace", suggestion: "Ask Donovan to run `polycarp-spaces agent on`.", retry: .never)) }
        let mine = all.filter { $0.workspace == agent && decide($0, agent, session: session) == .onAgentWorkspace }
        guard let ids else { return .success(mine.sorted { $0.id < $1.id }) }
        var out: [HandsWindow] = []
        for id in ids {
            guard let w = mine.first(where: { $0.id == id }) else {
                return .failure(HandsError(.outsideAgentWorkspace, "window \(id) isn't a window of yours on the agent workspace",
                                           suggestion: "arrange lays out only agent workspace windows; `workspaces` lists where yours are. Bring a lent one over with `move` first.", retry: .never))
            }
            out.append(w)
        }
        return .success(out)
    }

    func arrange(_ req: HandsRequest) -> HandsEnvelope {
        let session = req.session ?? ""
        guard let layout = req.string("layout").flatMap({ AgentArrange.Layout(rawValue: $0.lowercased()) }) else {
            return .failure(HandsError(.badArguments, "layout is missing", suggestion: "usage: " + HandsParse.usageLine(HandsTools.tool(verb: "arrange")!), retry: .safe))
        }
        let items = req.args["windows"]?.array?.compactMap(\.string) ?? []
        let area = onMain { host.agentArea() }
        guard area.width > 0, area.height > 0 else { return .failure(HandsError(.engineError, "the screen's size couldn't be read", suggestion: "Try again.", retry: .safe)) }
        var frames: [UInt32: CGRect] = [:]
        let chosen: [HandsWindow]
        if layout == .frames {
            let parsed = items.compactMap(AgentArrange.parseFrame)
            switch agentWindows(parsed.map(\.window), session: session) {
            case .failure(let e): return .failure(e)
            case .success(let ws): chosen = ws
            }
            for p in parsed { frames[p.window] = AgentArrange.place(p.frame, in: area) }
        } else {
            switch agentWindows(items.isEmpty ? nil : items.compactMap { UInt32($0) }, session: session) {
            case .failure(let e): return .failure(e)
            case .success(let ws): chosen = ws
            }
            for (w, f) in zip(chosen, AgentArrange.frames(layout, count: chosen.count, area: area)) { frames[w.id] = f }
        }
        guard !chosen.isEmpty else { return .success(.object(["layout": .string(layout.rawValue), "windows": .array([]), "note": "no window of yours is on the agent workspace"])) }
        for w in chosen {
            if let e = awaitUse(w, verb: "arrange", delivery: .posted, wait: req.int("wait"), session: session) { return .failure(e) }
        }
        // Read Only, a narrowed scope or Donovan back in the app since the wait: checked again right before.
        for w in chosen { if let e = actingCheck(w, verb: "arrange", delivery: .posted, session: session)() { return .failure(e) } }
        let applied = onMain { host.arrange(frames) }
        return .success(.object([
            "layout": .string(layout.rawValue),
            "area": .object(["x": .int(Int(area.minX)), "y": .int(Int(area.minY)), "width": .int(Int(area.width)), "height": .int(Int(area.height))]),
            "windows": .array(chosen.map { w in
                let f = frames[w.id] ?? .zero
                return .object(["window": .int(Int(w.id)), "app": .string(w.app), "applied": .string(applied[w.id] ?? "skipped"),
                                "frame": .object(["x": .int(Int(f.minX)), "y": .int(Int(f.minY)), "width": .int(Int(f.width)), "height": .int(Int(f.height))])])
            }),
        ]))
    }

    func move(_ req: HandsRequest) -> HandsEnvelope {
        let session = req.session ?? ""
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let (w, scope, _)):
            let agent = onMain { host.agentWorkspace() }
            let shown = onMain { agent.map { n in host.workspaceRows().contains { $0.number == n && $0.shown } } ?? false }
            if let e = WorkspaceVerbs.moveRefusal(window: w, scope: scope, agentWorkspace: agent, agentShown: shown) { return .failure(e) }
            if let e = awaitUse(w, verb: "move", delivery: .posted, wait: req.int("wait"), session: session) { return .failure(e) }
            if let e = actingCheck(w, verb: "move", delivery: .posted, session: session)() { return .failure(e) }
            guard let n = agent else { return .failure(HandsError(.agentWorkspaceOff, "the agent workspace is off", suggestion: "Ask Donovan to run `polycarp-spaces agent on`.", retry: .never)) }
            let from = w.workspace
            if from != n {
                // Checked again at the moment it moves: still not shown, still in scope.
                let stillShown = onMain { host.workspaceRows().contains { $0.number == n && $0.shown } }
                if let e = WorkspaceVerbs.moveRefusal(window: w, scope: decide(w, agent, session: session), agentWorkspace: agent, agentShown: stillShown) { return .failure(e) }
                onMain { host.move(w.id, n) }
                Trace.log("hands: moved window \(w.id) of \(w.app) from workspace \(from.map(String.init) ?? "?") to the agent workspace")
            }
            var data: [String: JSONValue] = ["window": .int(Int(w.id)), "app": .string(w.app), "from": from.map(JSONValue.int) ?? .null, "to": .int(n), "moved": .bool(from != n)]
            if let text = req.string("frame"), let rel = AgentArrange.parseFrame("0=" + text)?.frame {
                let area = onMain { host.agentArea() }
                let f = AgentArrange.place(rel, in: area)
                // Spaces.move applies on the next pass of the main queue: the frame follows it there.
                let applied = onMain { host.arrange([w.id: f]) }
                data["frame"] = .object(["x": .int(Int(f.minX)), "y": .int(Int(f.minY)), "width": .int(Int(f.width)), "height": .int(Int(f.height))])
                data["applied"] = .string(applied[w.id] ?? "skipped")
            }
            return .success(.object(data))
        }
    }

    func close(_ req: HandsRequest) -> HandsEnvelope {
        let session = req.session ?? ""
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let (w, scope, _)):
            if let e = childLocked({ WorkspaceVerbs.closeRefusal(window: w, session: session, opened: sessionWindows) }) { return .failure(e) }
            if let e = awaitUse(w, verb: "close", delivery: .posted, wait: req.int("wait"), session: session) { return .failure(e) }
            let before = noteAction(session: session, pid: w.pid)
            if let e = actingCheck(w, verb: "close", delivery: .posted, session: session)() { return .failure(e) }
            let token = AgentActivity.shared.begin(pid: w.pid, window: w.id)
            defer { AgentActivity.shared.end(token) }
            guard onMain({ host.close(w.id) }) else {
                return .failure(HandsError(.notSupported, "window \(w.id) of \(w.app) has no close button Polycarp can press",
                                           suggestion: "Leave it open; Polycarp never quits an app for an agent.", retry: .never))
            }
            var data: [String: JSONValue] = ["window": .int(Int(w.id)), "app": .string(w.app), "pressed": "close", "target": targetJSON(w, scope)]
            if let opened = openedChildren(pid: w.pid, before: before, session: session) {
                data["opened"] = opened
                data["note"] = "the app asked something before closing: answer the sheet or dialog in opened"
            } else {
                Thread.sleep(forTimeInterval: 0.2)
                let gone = onMain { host.live(w.id) } == nil
                data["closed"] = .bool(gone)
                if gone { childLocked { sessionWindows.forget(window: w.id) } }
            }
            return .success(.object(data))
        }
    }
}
