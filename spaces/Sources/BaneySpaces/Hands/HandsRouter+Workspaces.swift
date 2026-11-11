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
        var r = ChildWindowsAX.read(pid: pid, placed: placed)
        let now = Date()
        // Each child's window as first seen: its own, else the app's main window when it is also the focused one and usable.
        let agent = onMain { host.agentWorkspace() }
        let usable = r.children.contains { $0.parent == nil } && r.main != nil && r.main == r.focused
            ? Set(all.filter { $0.pid == pid && decide($0, agent).allowed }.map(\.id)) : []
        let hint = ChildCollect.hint(main: r.main, focused: r.focused, usable: usable)
        var firstParents: [UInt32: UInt32] = [:]
        for c in r.children { if let p = c.parent ?? hint { firstParents[c.id] = p } }
        let known = childLocked { () -> [UInt32: UInt32] in
            attribution.observed(Set(r.children.map(\.id)), pid: pid, at: now, parents: firstParents)
            attribution.observedSheets(on: r.sheetsOn, pid: pid, at: now)
            return r.children.reduce(into: [:]) { m, c in if let p = attribution.parent(of: c.id, pid: pid) { m[c.id] = p } }
        }
        for i in r.children.indices where r.children[i].parent == nil { r.children[i].parent = known[r.children[i].id] }
        return r
    }

    /// A window BaneySpaces doesn't place, as the engine and the scope checks see it; nil when no process lists it as a
    /// child window (closed, a menu, or unreadable).
    func childWindow(_ id: UInt32) -> HandsWindow? {
        guard let owner = ChildWindowsAX.owner(id) else { return nil }
        // Rule 3 before any accessibility read: a system prompt's window is named from the window server only, and its
        // decision (`childDecision`) refuses it without reading it.
        if ChildWindowsAX.isSystemPrompt(pid: owner.pid, serverName: owner.name) {
            return HandsWindow(id: id, pid: owner.pid, app: owner.name.isEmpty ? "a system prompt" : owner.name, workspace: nil)
        }
        let all = listWindows().windows
        return readChildren(pid: owner.pid, all: all).children.first { $0.id == id }?.window
    }

    /// The decision for one child window of `pid`, read now.
    func childDecision(_ id: UInt32, pid: Int32, agent: Int?, session: String) -> (facts: ChildWindowFacts, decision: ChildWindowRule.Decision)? {
        let all = listWindows().windows
        let running = NSRunningApplication(processIdentifier: pid)
        let bundle = running?.bundleIdentifier ?? "", process = running?.executableURL?.lastPathComponent ?? ""
        let serverName = ChildWindowsAX.owner(id).map { $0.pid == pid ? $0.name : "" } ?? ""
        // Rule 3 before reading anything of it: a system prompt's window is never read for an agent.
        if ChildWindowsAX.isSystemPrompt(pid: pid, serverName: serverName) {
            let named = ChildWindowRule.isSystemPrompt(bundle: bundle, processName: process) ? process : serverName
            let facts = ChildWindowFacts(id: id, pid: pid, app: running?.localizedName ?? named, bundle: bundle, processName: named)
            return (facts, ChildWindowRule.decide(facts, placed: [], attributed: false, selfPid: getpid()))
        }
        guard let facts = readChildren(pid: pid, all: all).children.first(where: { $0.id == id }) else { return nil }
        return (facts, decideChild(facts, all: all, agent: agent, session: session))
    }

    func decideChild(_ c: ChildWindowFacts, all: [HandsWindow], agent: Int?, session: String) -> ChildWindowRule.Decision {
        // sol-F1: a window that fails inspection now (an outside document, a file panel) authorizes no child of it.
        let placed = ChildWindowRule.inspected(all.filter { $0.pid == c.pid }.map { (window: $0, scope: decide($0, agent, session: session)) }) { inspectProblem($0) }
        let attributed = childLocked { attribution.attributed(c.id, pid: c.pid, session: session) }
        return ChildWindowRule.decide(c, placed: placed, attributed: attributed, selfPid: getpid())
    }

    /// `windows`: the child windows of these processes, decided, and which placed windows hold a sheet with no number.
    func children(ofPids pids: Set<Int32>, all: [HandsWindow], agent: Int?, session: String)
        -> (rows: [(facts: ChildWindowFacts, decision: ChildWindowRule.Decision)], sheetsOn: Set<UInt32>) {
        let list = Array(pids)
        var readings = [ChildWindowsAX.Reading](repeating: .init(children: [], sheetsOn: []), count: list.count)
        let lock = NSLock()
        // On the main thread one at a time: each read waits on main (`onMain`), which concurrentPerform would hold.
        if Thread.isMainThread { for i in list.indices { readings[i] = readChildren(pid: list[i], all: all) } } else {
            DispatchQueue.concurrentPerform(iterations: list.count) { i in
                let r = readChildren(pid: list[i], all: all)
                lock.lock(); readings[i] = r; lock.unlock()
            }
        }
        let facts = readings.flatMap(\.children).sorted { $0.id < $1.id }
        return (facts.map { ($0, decideChild($0, all: all, agent: agent, session: session)) }, readings.reduce(into: Set<UInt32>()) { $0.formUnion($1.sheetsOn) })
    }

    /// sol-F1: a placed window of an app split between the agent and Donovan, holding a sheet this session's action didn't
    /// raise (`ChildWindowRule.sheetOnWindowRefusal`). Nothing to read when the app isn't split.
    func sheetProblem(_ w: HandsWindow, agent: Int?, session: String) -> HandsError? {
        let all = listWindows().windows
        // sol-F2: split as the child rule sees it, each window inspected too, so an outside document makes the app split.
        let placed = ChildWindowRule.inspected(all.filter { $0.pid == w.pid }.map { (window: $0, scope: decide($0, agent, session: session)) }) { inspectProblem($0) }
        guard placed.contains(where: { !$0.scope.allowed }) else { return nil }
        let r = readChildren(pid: w.pid, all: all)
        let attributed = childLocked { () -> [Bool] in
            (r.sheetsOn.contains(w.id) ? [attribution.sheetAttributed(on: w.id, pid: w.pid, session: session)] : [])
                + r.children.filter { $0.parent == w.id && $0.kind == .sheet }.map { attribution.attributed($0.id, pid: w.pid, session: session) }
        }
        return ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: attributed, split: true)
    }

    /// Right before an action on `pid`: the child windows it has now, recorded as this session's action, and a watch that
    /// looks again every half second for 10 s so a dialog the action raises is seen within the window.
    func noteAction(session: String, pid: Int32) -> Set<UInt32> {
        let all = listWindows().windows
        let read = ChildWindowsAX.read(pid: pid, placed: Set(all.filter { $0.pid == pid }.map(\.id)))
        let existing = Set(read.children.map(\.id))
        let now = Date()
        // The action is recorded first, so a running watch sees it before deciding to stop; a pid has one watch at most.
        let start = childLocked { () -> Bool in
            attribution.acted(session: session, pid: pid, at: now, existing: existing, sheetsOn: read.sheetsOn)
            return childWatchers.insert(pid).inserted
        }
        if start { watch(pid: pid) }
        return existing
    }

    /// Looks every half second while an action on `pid` is under 10 s old; a later action extends this same watch.
    private func watch(pid: Int32) {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self else { return }
            let go = self.childLocked { () -> Bool in
                if self.attribution.watching(pid: pid, now: Date()) { return true }
                self.childWatchers.remove(pid)
                return false
            }
            guard go else { return }
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
        // Read Only, a narrowed scope or Donovan back in the app since the wait: checked again for every window in the pass
        // that applies the frames, and no frame is applied unless all of them pass.
        let applied: [UInt32: String]
        switch mutateOnMain(chosen, verb: "arrange", session: session, perform: { _ in .success(host.arrange(frames)) }) {
        case .failure(let e): return .failure(e)
        case .success(let a): applied = a
        }
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
            let before = onMain { () -> MoveState in
                let agent = host.agentWorkspace()
                return MoveState(agentWorkspace: agent, window: w, scope: scope, agentShown: agentShown(agent))
            }
            if let e = WorkspaceVerbs.moveRefusal(window: w, scope: scope, agentWorkspace: before.agentWorkspace, agentShown: before.agentShown) { return .failure(e) }
            if let e = awaitUse(w, verb: "move", delivery: .posted, wait: req.int("wait"), session: session) { return .failure(e) }
            if let e = actingCheck(w, verb: "move", delivery: .posted, session: session)() { return .failure(e) }
            // After the wait: the agent workspace, the live window, its scope and whether it is shown, read together on the
            // main thread and acted on in the same pass. The agent workspace may have been turned off or changed meanwhile.
            var fromSeen: Int?
            let relative = req.string("frame").flatMap { AgentArrange.parseFrame("0=" + $0)?.frame }
            var framed: (frame: CGRect, applied: String)?
            // The move and the frame are applied in the gate's own pass, so a frame is never applied outside it.
            let result = mutateOnMain([w], verb: "move", session: session) { agent -> Result<MoveDecision.Go, HandsError> in
                let live = host.live(w.id)
                let now = live.map { decide($0, agent, session: session) }
                    ?? .denied(HandsError(.windowNotFound, "window \(w.id) is gone", suggestion: "Run `polycarp-spaces agent windows`.", retry: .afterSnapshot))
                let after = MoveState(agentWorkspace: agent, window: live, scope: now, agentShown: agentShown(agent))
                let r = MoveDecision.decide(before: before, after: after)
                if case .success(let go) = r, go.moves, let live, let from = live.workspace {
                    // What it may do there ends with the lend or Full Access that let it move, and then it goes back.
                    let origin = MovedInWindows.origin(scope: now, agentOwned: host.agentOwned().contains(live.pid))
                    HandsMovedIn.shared.record(window: live.id, pid: live.pid, origin: origin, from: from, to: go.to)
                    if origin == .fullAccess { AgentAccess.shared.grant(live.pid) }
                    host.move(live.id, go.to)
                }
                if case .success = r, let relative {
                    let f = AgentArrange.place(relative, in: host.agentArea())
                    framed = (f, host.arrange([w.id: f])[w.id] ?? "skipped")
                }
                fromSeen = live?.workspace
                return r
            }
            let go: MoveDecision.Go
            switch result {
            case .failure(let e): return .failure(e)
            case .success(let g): go = g
            }
            let from = fromSeen
            if go.moves { Trace.log("hands: moved window \(w.id) of \(w.app) from workspace \(from.map(String.init) ?? "?") to the agent workspace") }
            var data: [String: JSONValue] = ["window": .int(Int(w.id)), "app": .string(w.app), "from": from.map(JSONValue.int) ?? .null, "to": .int(go.to), "moved": .bool(go.moves)]
            if go.changed { data["note"] = "the agent workspace changed while the move waited; the window went to the new one" }
            if go.moves, scope != .onAgentWorkspace {
                data["goes_back"] = .string("it goes back to workspace \(from.map(String.init) ?? "?") when the lend or Full Access that let it move ends")
            }
            if let (f, applied) = framed {
                data["frame"] = .object(["x": .int(Int(f.minX)), "y": .int(Int(f.minY)), "width": .int(Int(f.width)), "height": .int(Int(f.height))])
                data["applied"] = .string(applied)
            }
            return .success(.object(data))
        }
    }

    /// Whether workspace `agent` is shown on a display now. Main thread.
    private func agentShown(_ agent: Int?) -> Bool {
        agent.map { n in host.workspaceRows().contains { $0.number == n && $0.shown } } ?? false
    }

    func close(_ req: HandsRequest) -> HandsEnvelope {
        let session = req.session ?? ""
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let (w, scope, _)):
            resolvePendingOpens(all: listWindows().windows, agent: onMain { host.agentWorkspace() })
            if let e = childLocked({ WorkspaceVerbs.closeRefusal(window: w, session: session, opened: sessionWindows) }) { return .failure(e) }
            if let e = awaitUse(w, verb: "close", delivery: .posted, wait: req.int("wait"), session: session) { return .failure(e) }
            let before = noteAction(session: session, pid: w.pid)
            if let e = actingCheck(w, verb: "close", delivery: .posted, session: session)() { return .failure(e) }
            let token = AgentActivity.shared.begin(pid: w.pid, window: w.id)
            defer { AgentActivity.shared.end(token) }
            // Read Only, scope and in use, read again in the pass that presses the button.
            let pressed: Bool
            // On the process's queue, so the press never falls inside a background action's transaction on it (sol-F1).
            let busy = HandsError(.inUse, "another action on \(w.app) is still running", suggestion: "Try `close` again when it has answered.", retry: .safe)
            // The main thread never waits (the work needs it to finish): there it refuses at once.
            switch HandsEngine.shared.serialized(pid: w.pid, wait: Thread.isMainThread ? 0 : 10, { [self] cancelled in
                mutateOnMain([w], verb: "close", session: session, perform: { _ in cancelled() ? .failure(busy) : .success(host.close(w.id)) })
            }) ?? .failure(busy) {
            case .failure(let e): return .failure(e)
            case .success(let p): pressed = p
            }
            guard pressed else {
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
