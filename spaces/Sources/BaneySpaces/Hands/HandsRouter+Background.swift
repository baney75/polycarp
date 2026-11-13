import AppKit
import BaneySpacesCore

/// Routes shut for an app or process after it misbehaved, for as long as BaneySpaces runs.
final class BackgroundBreaker {
    static let shared = BackgroundBreaker()
    private let lock = NSLock()
    private var breaker = RouteBreaker()
    func block(bundle: String, pid: Int32, kind: InputKind) -> RouteBlock? { lock.lock(); defer { lock.unlock() }; return breaker.block(bundle: bundle, pid: pid, kind: kind) }
    func update(_ change: (inout RouteBreaker) -> Void) { lock.lock(); change(&breaker); lock.unlock() }
}

/// Phase 4: keys and a pointer, posted to one process that is not in front, with proof read back from the window.
///
/// The whole action is one transaction on the target process's queue: no other action on that process runs between
/// the readings before, the post and the readings after, so another action's change can never prove this one. Inside
/// it, in order: watch activations and the session; read the window; check scope and facts again and choose one route
/// (`BackgroundPlanner`); post once, through `EventRunner` (a stop posts nothing new and releases whatever is down);
/// read the same window back. No proof is `unverified`, retry never; a second route is never tried after a post.
extension HandsRouter {
    // MARK: verbs

    func press(_ req: HandsRequest) -> HandsEnvelope {
        let chords: [KeyChord]
        switch KeyParse.sequence(req.string("key") ?? "") {
        case .failure(let e): return .failure(e)
        case .success(let c): chords = c
        }
        // The key's character in the Mac's layouts too: cmd+i is copy on Dvorak.
        if let c = chords.first(where: { SessionClipboard.usesPasteboard($0, characters: KeyLayout.characters($0.keyCode)) }) {
            return .failure(SessionClipboard.pasteboardRefusal(c.label))
        }
        switch resolve(req.string("ref"), session: req.session ?? "") {
        case .failure(let e): return .failure(e)
        case .success(let (w, scope)):
            return background(w, scope, name: "press", kind: .keys, ref: req.string("ref"), chords: chords, path: [], drag: false, session: req.session ?? "", wait: req.int("wait"))
        }
    }

    func clickAt(_ req: HandsRequest) -> HandsEnvelope {
        guard let x = req.int("x"), let y = req.int("y") else { return .failure(pointArguments("click-at --window <id> --x <points> --y <points>")) }
        switch ClickStyle.parse(count: req.int("count"), button: req.string("button"), item: req.string("item")) {
        case .failure(let e): return .failure(e)
        case .success(let style): return pointer(req, path: [CGPoint(x: x, y: y)], drag: false, name: "click-at", style: style)
        }
    }

    func drag(_ req: HandsRequest) -> HandsEnvelope {
        guard let x = req.int("x"), let y = req.int("y"), let x2 = req.int("x2"), let y2 = req.int("y2") else {
            return .failure(pointArguments("drag --window <id> --x <points> --y <points> --x2 <points> --y2 <points> [--steps N]"))
        }
        let path = PointerPath.line(from: CGPoint(x: x, y: y), to: CGPoint(x: x2, y: y2), steps: req.int("steps") ?? 12)
        return pointer(req, path: path, drag: true, name: "drag")
    }

    private func pointArguments(_ usage: String) -> HandsError {
        HandsError(.badArguments, "the point is missing", suggestion: "usage: polycarp-spaces agent " + usage, retry: .safe)
    }

    private func pointer(_ req: HandsRequest, path: [CGPoint], drag: Bool, name: String, style: ClickStyle = .single) -> HandsEnvelope {
        guard req.int("window") != nil else { return .failure(pointArguments("\(name) --window <id> ...")) }
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let (w, scope, _)):
            return background(w, scope, name: name, kind: .pointer, ref: nil, chords: [], path: path, drag: drag, style: style, session: req.session ?? "", wait: req.int("wait"))
        }
    }

    // MARK: the transaction

    private func frontPid() -> Int32? { NSWorkspace.shared.frontmostApplication?.processIdentifier }

    private func inlineValue(_ w: HandsWindow, _ ref: String) -> String? {
        if case .ok(let v) = HandsEngine.shared.getInline(window: w, ref: ref, property: "value") { return v["value"]?.string ?? "" }
        return nil
    }

    private func inlineTree(_ w: HandsWindow) -> JSONValue? {
        guard case .ok(let d) = HandsEngine.shared.snapshotInline(window: w, interactive: false, compact: true, depth: 10, evidence: true),
              d["window"]?["id"]?.string == "w-\(w.id)" else { return nil }
        return d["tree"]
    }

    private func background(_ w: HandsWindow, _ scope: ScopeDecision, name: String, kind: InputKind, ref: String?,
                            chords: [KeyChord], path: [CGPoint], drag: Bool, style: ClickStyle = .single, session: String, wait: Int?) -> HandsEnvelope {
        // Keys and the pointer are posted events: while Donovan uses the app they always wait (never the other-window rule).
        // Before the mark, so an activation while it waits is his.
        if let e = awaitUse(w, verb: name, delivery: .posted, wait: wait, session: session) { return .failure(e) }
        // The mark covers the whole action: the queue wait, the readings, the post and the proof, and a short tail.
        let token = AgentActivity.shared.begin(pid: w.pid, window: w.id)
        defer { AgentActivity.shared.end(token) }
        let scopeCheck = actingCheck(w, ref: ref, verb: name, delivery: .posted, session: session)
        if let e = scopeCheck() { return .failure(e) }
        guard BackgroundAX.serverWindow(w.id) != nil else {
            return .failure(HandsError(.windowNotFound, "the window server does not list window \(w.id)", suggestion: "Run `polycarp-spaces agent windows` and try again.", retry: .safe))
        }
        // The child windows the app has now: one that appears after this is the action's (`ChildAttribution`).
        let childrenBefore = noteAction(session: session, pid: w.pid)
        let reply = HandsEngine.shared.transaction(window: w, check: scopeCheck) { [self] cancelled in
            transact(w, scope, name: name, kind: kind, ref: ref, chords: chords, path: path, drag: drag, style: style, session: session, scopeCheck: scopeCheck, cancelled: cancelled)
        }
        switch reply {
        case .failed(let e): return .failure(e)
        case .ok(let data):
            // A dialog or sheet the keys or the click raised: said here, so the agent need not poll.
            guard let opened = openedChildren(pid: w.pid, before: childrenBefore, session: session), case .object(var o) = data else { return .success(data) }
            o["opened"] = opened
            return .success(.object(o))
        }
    }

    /// Runs on the process queue. Everything it reads goes through the engine's inline calls.
    private func transact(_ w: HandsWindow, _ scope: ScopeDecision, name: String, kind: InputKind, ref: String?, chords: [KeyChord], path: [CGPoint], drag: Bool, style: ClickStyle, session: String,
                          scopeCheck: @escaping HandsEngine.Check, cancelled: () -> Bool) -> HandsEngine.Reply {
        // From planning to a second after the last post: every activation, and every session event, is seen.
        let activations = ActivationWatch()
        let tap = SessionTap()
        let idle = IdleWatch()
        var watchHandedOff = false
        defer { if !watchHandedOff { activations.stop(); _ = tap.stop() } }
        guard let frontStart = frontPid() else { return .failed(BackgroundRefusal.frontUnknown(w.app)) }

        /// Hardware events in the span, as far as anything is listening (nil: nothing is, so nobody can be blamed or excused).
        func hardware() -> Bool? { tap.snapshot.map { $0.contains { $0.sourcePid == 0 } } }
        /// The front app, from the notifications and from a look right now. Either seeing a change is a change.
        func spanFront() -> FrontChange {
            PostGuard.span(activations: activations.activated, start: frontStart, now: frontPid(), target: w.pid)
        }
        /// What the span so far means: nil when nothing changed. An app that came forward by itself is shut out of the
        /// route; one Donovan brought forward is not blamed.
        func frontFailure() -> HandsError? {
            switch PostGuard.verdict(spanFront(), hardware: hardware()) {
            case .same: return nil
            case .userActivated: return BackgroundRefusal.userActivated(w.app)
            case .selfActivated:
                BackgroundBreaker.shared.update { $0.selfActivated(bundle: w.bundle, kind: kind) }
                return BackgroundRefusal.blocked(w.app, .selfActivates)
            case .unattributed:
                BackgroundBreaker.shared.update { $0.selfActivated(pid: w.pid, kind: kind) }
                return BackgroundRefusal.blocked(w.app, .selfActivates)
            case .other(let p): return BackgroundRefusal.frontChanged(w.app, to: p)
            case .unknown: return BackgroundRefusal.frontUnknown(w.app)
            }
        }
        let stop: () -> HandsError? = {
            if cancelled() { return HandsError(.timeout, "the caller stopped waiting", suggestion: "Read the element back before trying again.", retry: .never) }
            return frontFailure()
        }

        // Readings. The window's tree is read twice, a moment apart: what changes by itself, by place, is noise.
        func refReading() -> ElementReading? {
            guard let ref, let v = inlineValue(w, ref) else { return nil }
            return ElementReading.text(window: w.id, identity: ref, value: v)
        }
        func focusReading() -> ElementReading? { BackgroundAX.focus(pid: w.pid).element.map { BackgroundAX.reading(of: $0) } }
        func windowReading() -> WindowReading? {
            BackgroundAX.windows(pid: w.pid).mapped.first { $0.id == w.id }.map { BackgroundAX.windowReading($0.element) }
        }
        var curRef = refReading(), curFocus = focusReading(), curWindow = windowReading()
        // Reading the tree takes about 100 ms by itself, so this spans what it needs to.
        let tree1 = inlineTree(w)
        Thread.sleep(forTimeInterval: 0.05)
        let tree2 = inlineTree(w)
        var noise: Set<String> = (tree1 != nil && tree2 != nil) ? ContentChange.noise(base1: tree1!, base2: tree2!) : []
        var base = tree1
        var baseEntries: [String: String] = tree1.map { ContentChange.entries(of: $0) } ?? [:]
        let verifier: VerifierPlan = {
            switch (tree1 != nil && tree2 != nil, kind == .pointer && CGPreflightScreenCaptureAccess()) {
            case (true, true): return .axAndPixels
            case (true, false): return .ax
            case (false, true): return .pixels
            case (false, false): return .none
            }
        }()

        // Scope and facts again, at the moment of execution; one route or one refusal.
        guard let (facts, frame) = gatherFacts(w, kind: kind, verifier: verifier, path: path) else {
            return .failed(HandsError(.windowNotFound, "window \(w.id) is gone", suggestion: "Run `polycarp-spaces agent windows` and take a new snapshot.", retry: .afterSnapshot))
        }
        let permit: BackgroundPermit
        switch BackgroundPlanner.plan(facts) {
        case .failure(let e): return .failed(e)
        case .success(let p): permit = p
        }
        if let e = frontFailure() { return .failed(e) }

        // The agent cursor (phase 1b) learns where the hands are working.
        if HandsEvents.hasListener {
            // The agent cursor shows where the hands are working: the target point when there is one, the window otherwise.
            HandsEvents.willAct(HandsActionEvent(kind: name, ref: ref ?? "", window: w.id, pid: w.pid, app: w.app,
                                                 point: path.first.map { PointerPath.screenPoint(local: $0, frame: frame) }, frame: path.isEmpty ? frame : nil,
                                                 session: session, scope: scope.reason, workspace: w.workspace))
        }
        let pointerBefore = BackgroundPoster.pointerLocation()
        var posted = 0, released = 0
        var aimed: [CGPoint] = []
        var lastPostAt = Date()
        var diff: AXDiff?
        var pixels: PixelChange?
        var verdict = DeliveryVerdict(verified: false, basis: "no_reading")
        var landed = 0, stepCount = 1
        var droppedKeys = false
        var context: [String: JSONValue]?

        func treeAfter() -> (content: Bool?, tree: JSONValue?) {
            guard tree1 != nil, let after = inlineTree(w) else { return (nil, nil) }
            return (ContentChange.changed(base: baseEntries, noise: noise, after: after), after)
        }

        switch kind {
        case .keys:
            // Verified step by step: each typed segment must show its own text, each chord its own effect. The first
            // step that shows nothing stops the press, and what landed before it is reported.
            let steps = KeySteps.split(chords)
            stepCount = steps.count
            for step in steps {
                let report = BackgroundPoster.keys(step.chords, permit: permit, stop: stop)
                posted += report.posted.count; released += report.released; lastPostAt = Date()
                if let stopped = report.stopped { return .failed(frontFailure() ?? stopped) }
                let deadline = Date().addingTimeInterval(1.2)
                var after: (ref: ElementReading?, focus: ElementReading?, window: WindowReading?, tree: JSONValue?) = (nil, nil, nil, nil)
                repeat {
                    Thread.sleep(forTimeInterval: 0.05)
                    if spanFront() != .same { break }
                    let t = treeAfter()
                    after = (refReading(), focusReading(), windowReading(), t.tree)
                    verdict = DeliveryProof.keys(target: w.id, step: step, ref: (curRef, after.ref), focus: (curFocus, after.focus), content: t.content,
                                                 window: (curWindow, after.window), pixels: nil)
                    if let t = t.tree, let b = tree1 { diff = AXDiff.between(b, t) }
                } while !verdict.verified && Date() < deadline
                if !verdict.verified {
                    if let e = frontFailure() { return .failed(e) }
                    droppedKeys = KeyPrediction.certainToShow(step, focusIsText: curFocus?.isText ?? false) && verdict.basis == "no_change"
                    BackgroundBreaker.shared.update { if droppedKeys { $0.dropped(pid: w.pid, kind: kind) } }
                    return .failed(stepCount == 1 ? BackgroundRefusal.unverified(basis: verdict.basis)
                                                  : BackgroundRefusal.partial(landed: landed, of: stepCount, basis: verdict.basis))
                }
                landed += 1
                // The next step is compared with how things stand now.
                curRef = after.ref; curFocus = after.focus; curWindow = after.window
                if let t = after.tree { baseEntries = ContentChange.entries(of: t) }
            }
        case .pointer where style.right:
            // Proved by the menu's own window, not by the target window's tree or pixels (`ContextMenu`).
            // The cancel: Escape posted to the process, with a key permit of its own from the planner, planned with this
            // transaction's verifier before anything is posted (210 r1 first-F1).
            let r = contextPress(w, frame: frame, point: path[0], permit: permit, stop: stop, item: style.item, agentWindow: onAgentWorkspace(w, scope),
                                 keys: { [self] in escapeKeys(w, verifier: verifier) }, check: scopeCheck, cancelled: cancelled)
            aimed += r.aimed; posted += r.posted; released = r.released; lastPostAt = r.lastPostAt
            switch r.result {
            case .failure(let e): return .failed(r.posted > 0 && !r.leftOpen ? frontFailure() ?? e : e)
            case .success(let d): context = d; verdict = DeliveryVerdict(verified: true, basis: "context_menu"); landed = 1
            }
        case .pointer:
            let gesture = BackgroundPoster.newGesture()
            // Arrive first, then look: a hover that tints or outlines is in the picture the press is compared with.
            let hover = BackgroundPoster.pointer(InputScript.hover(at: path[0]), frame: frame, drag: drag, gesture: gesture, permit: permit, stop: stop)
            aimed += hover.screenPoints
            posted += hover.report.posted.count
            if let stopped = hover.report.stopped { return .failed(frontFailure() ?? stopped) }
            // A hover's tint can animate, and pixels compare what's there. With no pixels in the proof it doesn't matter.
            Thread.sleep(forTimeInterval: verifier.hasPixels ? 0.2 : 0.05)
            // The baseline is the window once it holds still after the hover, so a change pending before the press is noise.
            if let t = base {
                let settled = ContentChange.settle(first: inlineTree(w) ?? t, reads: 5) { inlineTree(w) }
                noise.formUnion(ContentChange.noise(base1: t, base2: settled.base).union(settled.noise))
                base = settled.base
                baseEntries = ContentChange.entries(of: settled.base)
                curRef = refReading(); curFocus = focusReading()
            }
            let shotBefore = verifier.hasPixels ? WindowShot.pixels(window: w.id, check: scopeCheck) : nil
            if verifier == .pixels, shotBefore == nil { return .failed(BackgroundRefusal.noVerifier(w.app)) }     // nothing is pressed yet
            let press = BackgroundPoster.pointer(drag ? InputScript.drag(path: path) : InputScript.click(at: path[0], count: style.count), frame: frame, drag: drag,
                                                 gesture: gesture, permit: permit, stop: stop)
            aimed += press.screenPoints
            posted += press.report.posted.count; released = press.report.released; lastPostAt = Date()
            if let stopped = press.report.stopped { return .failed(frontFailure() ?? stopped) }
            let minStroke = shotBefore.map { PointerPath.strokeMinimum(path: path, scale: $0.scale) } ?? DeliveryProof.minStrokePixels
            let deadline = Date().addingTimeInterval(1.2)
            repeat {
                Thread.sleep(forTimeInterval: 0.05)
                if spanFront() != .same { break }
                let refAfter = refReading(), focusAfter = focusReading()
                let t = treeAfter()
                if let t = t.tree, let b = base { diff = AXDiff.between(b, t) }
                if let b = shotBefore, let a = WindowShot.pixels(window: w.id, check: scopeCheck), a.width == b.width, a.height == b.height {
                    let region = PointerPath.region(path: path, margin: 14, scale: b.scale, width: b.width, height: b.height)
                    let hoverBox = PointerPath.hoverExclusion(path: path, radius: 10, scale: b.scale, width: b.width, height: b.height)
                    pixels = PixelDiff.compare(before: b.rgba, after: a.rgba, width: b.width, height: b.height, region: region, excluding: hoverBox)
                }
                verdict = DeliveryProof.pointer(target: w.id, ref: (curRef, refAfter), focus: (curFocus, focusAfter), content: t.content, pixels: pixels, minStroke: minStroke)
            } while !verdict.verified && Date() < deadline
            landed = verdict.verified ? 1 : 0
        }

        if let e = frontFailure() { return .failed(e) }
        let events = tap.snapshot ?? idle.events
        let pointerVerdict = PointerAudit.verdict(before: pointerBefore, after: BackgroundPoster.pointerLocation(), posted: aimed, tap: events, ownPid: Int64(getpid()))
        if let e = pointerVerdict.error { return .failed(e) }

        // The tail: a second after the last post (not after the proof) still counts, but the agent doesn't wait for it. An
        // app that comes forward late is shut out of the route here, so its next action is refused. The window stays marked
        // as the agent's until then, so the focus watcher doesn't take a late activation for Donovan switching apps.
        watchHandedOff = true
        let tailMark = AgentActivity.shared.begin(pid: w.pid, window: w.id)
        let lastPost = lastPostAt
        DispatchQueue.global(qos: .utility).async {
            defer { activations.stop(); _ = tap.stop(); AgentActivity.shared.end(tailMark) }
            while Date().timeIntervalSince(lastPost) < 1.0 {
                if spanFront() != .same { break }
                Thread.sleep(forTimeInterval: 0.1)
            }
            if let late = frontFailure() { Trace.log("hands: \(w.app) changed the front app after its answer: \(late.message)") }
        }

        guard verdict.verified else { return .failed(BackgroundRefusal.unverified(basis: verdict.basis)) }
        BackgroundBreaker.shared.update { $0.proved(pid: w.pid, kind: kind) }
        var evidence: [String: JSONValue] = ["kind": "delivery_proof", "basis": .string(verdict.basis), "pointer": .string(pointerVerdict.label),
                                             "pointer_check": .string(tap.available ? "tap" : "idle_fallback"), "front": "unchanged",
                                             "steps": .int(stepCount), "landed": .int(landed), "released": .int(released)]
        if let diff { evidence["ax"] = diff.json(limit: 3) }
        if let p = pixels {
            evidence["pixels"] = .object(["inside_changed": .int(p.insideChanged), "inside_total": .int(p.insideTotal),
                                          "outside_changed": .int(p.outsideChanged), "outside_total": .int(p.outsideTotal)])
        }
        var answer: [String: JSONValue] = [
            "action": .string(name), "verified": true, "route": .string(permit.route.rawValue),
            "transport": .string(permit.transport.rawValue), "events": .int(posted), "evidence": .object(evidence),
            "target": targetJSON(w, scope),
        ]
        if let context { answer["context_menu"] = .object(context) }
        return .ok(.object(answer))
    }

    /// A context menu's cancel: the key permit Escape is posted with, planned before anything is posted, with the
    /// transaction's verifier, or the one a read of the tree now gives (210 r1 first-F1). Nil: no right click.
    func escapeKeys(_ w: HandsWindow, verifier: VerifierPlan? = nil) -> BackgroundPermit? {
        guard let (keyFacts, _) = gatherFacts(w, kind: .keys, verifier: verifier ?? (inlineTree(w) != nil ? .ax : .none), path: []),
              case .success(let keys) = BackgroundPlanner.plan(keyFacts) else { return nil }
        return keys
    }

    /// The facts the planner decides on, read now, on the process queue. nil when the window is gone.
    private func gatherFacts(_ w: HandsWindow, kind: InputKind, verifier: VerifierPlan, path: [CGPoint]) -> (BackgroundFacts, CGRect)? {
        let (live, agent, owned, seen) = onMain { (host.live(w.id), host.agentWorkspace(), host.agentOwned(), host.inspect(w.id)) }
        guard let live, live.pid == w.pid, let server = BackgroundAX.serverWindow(w.id) else { return nil }
        let scope: ScopeKind
        switch decide(live, agent) {
        // Under Full Access one of Donovan's processes with a window claimed onto the agent workspace is his, like a lent one.
        case .onAgentWorkspace: scope = access == .full && !owned.contains(w.pid) ? .full : .agentWorkspace
        case .lent: scope = .lent
        case .fullAccess: scope = .full
        case .denied: scope = .outside
        }
        let axWindows = BackgroundAX.windows(pid: w.pid)
        let me = axWindows.mapped.first { $0.id == w.id }
        let hidden = NSRunningApplication(processIdentifier: w.pid)?.isHidden ?? false
        let condition: WindowCondition = hidden ? .appHidden : (me?.minimized == true ? .minimized : .normal)
        let focus = BackgroundAX.focus(pid: w.pid)
        let size = CGSize(width: server.frame.width, height: server.frame.height)
        let titleBar = me.map { BackgroundAX.titleBarHeight($0.element, windowTop: server.frame.minY) } ?? 0
        // Windows that cannot be mapped count against the keys: one of them could take the key.
        let siblings = axWindows.mapped.filter { $0.id != w.id && !$0.minimized }.count + axWindows.unmapped
        let facts = BackgroundFacts(
            kind: kind, app: w.app, pid: w.pid, window: w.id, scope: scope, pidIsAgentOwned: owned.contains(w.pid),
            windowOwnerPid: server.pid, axWindowResolved: me != nil, siblingWindows: siblings,
            condition: condition, hasSheetOrPanel: seen.panel, focusedWindow: focus.window, focusedElementWindow: focus.elementWindow,
            targetIsFront: frontPid() == w.pid, transports: BackgroundPoster.support,
            block: BackgroundBreaker.shared.block(bundle: w.bundle, pid: w.pid, kind: kind), verifier: verifier,
            pointInsideWindow: path.allSatisfy { PointerPath.inside($0, size: size) },
            pointInTitleBar: path.contains { $0.y < titleBar }, focusedElementUnplaced: focus.unplaced)
        return (facts, server.frame)
    }
}
