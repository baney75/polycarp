import BaneySpacesCore
import Foundation

// A right click on a ref: `click` with `button: right`. The engine opens the element's context menu with AXShowMenu
// (its headless policy never posts a click), and the menu is then proved, chosen from and cancelled exactly as after a
// posted right click (`contextMenu`, `ContextMenu`).
extension HandsRouter {
    func contextClick(_ req: HandsRequest, item: String?) -> HandsEnvelope {
        guard let ref = req.string("ref") else { return .failure(HandsError(.badArguments, "ref is missing", suggestion: "usage: polycarp-spaces agent click <ref> --button right", retry: .safe)) }
        let session = req.session ?? ""
        switch resolve(ref, session: session) {
        case .failure(let e): return .failure(e)
        case .success(let (w, scope)):
            // The menu takes the keyboard and its cancel posts Escape: it waits while Donovan uses the app, as a posted key does (231 r1 first-F2).
            if let e = awaitUse(w, verb: "click", delivery: .posted, wait: req.int("wait"), session: session) { return .failure(e) }
            let token = AgentActivity.shared.begin(pid: w.pid, window: w.id)
            defer { AgentActivity.shared.end(token) }
            let acting = actingCheck(w, ref: ref, verb: "click", delivery: .posted, session: session)
            var answer: Result<[String: JSONValue], HandsError> = .failure(HandsError(.engineError, "the right click didn't run", suggestion: "Try again.", retry: .safe))
            let reply = HandsEngine.shared.transaction(window: w, check: acting) { [self] cancelled in
                // Rule 1, read when the work runs, not when it was queued: work ahead of it on this process's queue can hold it
                // for up to the budget, long enough for Donovan to put the agent workspace away (231 r1 first-F1).
                guard let frame = BackgroundAX.serverWindow(w.id)?.frame else {
                    answer = .failure(HandsError(.windowNotFound, "window \(w.id) is gone", suggestion: "Run `polycarp-spaces agent windows`.", retry: .afterSnapshot))
                    return .ok(.null)
                }
                let displays = ContextMenuAX.displays()
                // The element's own bounds: the menu opens at it, which can be on another display than the window's middle (231 r1 second-S1).
                // A read that failed (a stale ref, a busy app) is the answer, nothing sent; only a frame that can't be read is
                // the gate's to refuse (269 r1 second-S1).
                let element: CGRect?
                switch HandsEngine.shared.getInline(window: w, ref: ref, property: "bounds") {
                case .failed(let e): answer = .failure(e); return .ok(.null)
                case .ok(let v): element = HandsEvents.frame(ofBounds: v["value"])
                }
                if let e = ContextMenu.gate(agentShown: agentShown(), agentWindow: onAgentWorkspace(w, scope), window: frame, element: element, displays: displays) { answer = .failure(e); return .ok(.null) }
                // The cancel's key permit first: none, and the engine is asked for nothing (210 r1 first-F1).
                guard let keyPermit = escapeKeys(w) else { answer = .failure(ContextMenu.noCancel(w.app)); return .ok(.null) }
                // An app shut out of the pointer route for coming forward by itself gets no second AXShowMenu (269 r1 second-S2).
                if let block = BackgroundBreaker.shared.block(bundle: w.bundle, pid: w.pid, kind: .pointer) { answer = .failure(BackgroundRefusal.blocked(w.app, block)); return .ok(.null) }
                // The front app from before the press to after the cancel, as for a posted click: an app that comes forward by
                // itself is shut out of the route (231 r1 first-F3).
                guard let front = frontWatch(w, kind: .pointer) else { answer = .failure(BackgroundRefusal.frontUnknown(w.app)); return .ok(.null) }
                defer { front.stop() }
                let before = Set(ContextMenuAX.menus(w.pid, before: []).map(\.id))
                var refused: HandsError?, open = false
                if case .failed(let e) = HandsEngine.shared.actInline(window: w, ref: ref, kind: .rightClick, check: acting, cancelled: cancelled) { refused = e }
                // Refused before anything was sent: no menu can come, so no watch for one (231 r1 first-F5). An earlier attempt
                // of the engine's retry may have opened one, so a quick look first (269 r1 first-F3).
                if ContextMenu.nothingSent(refused), let refused, ContextMenuAX.menus(w.pid, before: before).isEmpty { answer = .failure(refused); return .ok(.null) }
                // The menu's own window is the proof, whatever the engine said; with no menu, the engine's refusal is the answer.
                // The front app is looked at once the menu is found, right before an item is pressed: an app that came forward
                // gets its menu cancelled, nothing pressed (269 r1 first-F1).
                answer = contextMenu(w, frame: frame, displays: displays, before: before, item: item, stopped: nil, none: refused,
                                     escape: { BackgroundPoster.keys([KeyChord(keyCode: 53, flags: 0, label: "escape")], permit: keyPermit, stop: { nil }).stopped == nil },
                                     leftOpen: &open, check: acting, cancelled: cancelled, beforePress: front.failure)
                // Seen later: it replaces only an answer that pressed nothing and left nothing open (269 r1 first-F2).
                if let late = front.failure(), case .success(let d) = answer, d["pressed"] == nil { answer = .failure(late) }
                return .ok(.null)
            }
            if case .failed(let e) = reply { return .failure(e) }
            switch answer {
            case .failure(let e): return .failure(e)
            case .success(var o):
                o["action"] = "click"; o["ref"] = .string(ref); o["button"] = "right"; o["verified"] = true
                o["evidence"] = .object(["kind": "context_menu"]); o["target"] = targetJSON(w, scope)
                return .success(.object(o))
            }
        }
    }
}
