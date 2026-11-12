import AppKit
import BaneySpacesCore

// Item C: a menu-bar command by path. The window's app's menu bar is read (its refs are this window's, so every
// ref check holds), the path is found in it, and the command is the ordinary click on that ref: AXPress, headless,
// with every gate `act` has, plus the key-window rule (`MenuPath.refusal`) read on the process queue at the press.
extension HandsRouter {
    func menu(_ req: HandsRequest) -> HandsEnvelope {
        let path = MenuPath.parse(req.string("path") ?? "")
        guard req.int("window") != nil, !path.isEmpty else {
            return .failure(HandsError(.badArguments, "window and path are needed", suggestion: #"usage: polycarp-spaces agent menu --window <id> "Format > Font > Bold""#, retry: .safe, nextCall: .null))
        }
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let (w, _, _)):
            let session = req.session ?? ""
            let rule = menuRule(w)
            // Refused before the menu bar is even read when it could only be refused at the press.
            if let e = rule() { return .failure(e) }
            switch read(w, interactive: false, compact: false, depth: 12, surface: HandsEngine.surfaceMenubar, session: session) {
            case .failure(let e): return .failure(e)
            case .success(let data):
                let found = MenuPath.find(data["tree"] ?? .null, path: path)
                guard case .item(let ref, let spelled) = found else {
                    return .failure(MenuPath.error(found, path: path, window: Int(w.id)) ?? HandsError(.engineError, "the menu path came out as nothing", suggestion: "Snapshot the window.", retry: .safe))
                }
                var args = req.args
                args["ref"] = .string(ref)
                let reply = clickMenuItem(HandsRequest(verb: "menu", args: args, session: req.session), rule: rule)
                guard case .object(var o) = reply.data else { return reply }
                o["action"] = "menu"
                o["path"] = .array(spelled.map(JSONValue.string))
                return .success(.object(o))
            }
        }
    }

    /// The key-window rule, from facts read when it runs.
    private func menuRule(_ w: HandsWindow) -> HandsEngine.Check {
        { [self] in
            let (agent, owned) = onMain { (host.agentWorkspace(), host.agentOwned()) }
            let others = BackgroundAX.windows(pid: w.pid)
            let count = others.mapped.filter { $0.id != w.id && !$0.minimized }.count + others.unmapped
            return MenuPath.refusal(app: w.app, window: w.id, onAgentWorkspace: agent != nil && w.workspace == agent,
                                    agentOwned: owned.contains(w.pid), otherWindows: count,
                                    focusedWindow: BackgroundAX.focus(pid: w.pid).window,
                                    front: NSWorkspace.shared.frontmostApplication?.processIdentifier == w.pid)
        }
    }
}
