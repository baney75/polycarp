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
            if let e = awaitUse(w, verb: "click", delivery: .headlessAX, wait: req.int("wait"), session: session) { return .failure(e) }
            let token = AgentActivity.shared.begin(pid: w.pid, window: w.id)
            defer { AgentActivity.shared.end(token) }
            guard let frame = BackgroundAX.serverWindow(w.id)?.frame else {
                return .failure(HandsError(.windowNotFound, "window \(w.id) is gone", suggestion: "Run `polycarp-spaces agent windows`.", retry: .afterSnapshot))
            }
            let displays = ContextMenuAX.displays()
            // Rule 1, before the engine is asked for anything.
            if let e = ContextMenu.gate(agentShown: agentShown(), agentWindow: onAgentWorkspace(w, scope), window: frame, displays: displays) { return .failure(e) }
            let acting = actingCheck(w, ref: ref, verb: "click", delivery: .headlessAX, session: session)
            var answer: Result<[String: JSONValue], HandsError> = .failure(HandsError(.engineError, "the right click didn't run", suggestion: "Try again.", retry: .safe))
            let reply = HandsEngine.shared.transaction(window: w, check: acting) { [self] cancelled in
                // The cancel's key permit first: none, and the engine is asked for nothing (210 r1 first-F1).
                guard let keyPermit = escapeKeys(w) else { answer = .failure(ContextMenu.noCancel(w.app)); return .ok(.null) }
                let before = Set(ContextMenuAX.menus(w.pid, before: []).map(\.id))
                var refused: HandsError?, open = false
                if case .failed(let e) = HandsEngine.shared.actInline(window: w, ref: ref, kind: .rightClick, check: acting, cancelled: cancelled) { refused = e }
                // The menu's own window is the proof, whatever the engine said; with no menu, the engine's refusal is the answer.
                answer = contextMenu(w, frame: frame, displays: displays, before: before, item: item, stopped: nil, none: refused,
                                     escape: { BackgroundPoster.keys([KeyChord(keyCode: 53, flags: 0, label: "escape")], permit: keyPermit, stop: { nil }).stopped == nil },
                                     leftOpen: &open, check: acting, cancelled: cancelled)
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
