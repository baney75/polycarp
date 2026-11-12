import AppKit
import ApplicationServices
import BaneySpacesCore

// Item C: a menu-bar command by path, in one transaction on the app's queue. The menu bar is read into the evidence
// store (it never costs the agent's saved snapshots or renumbers its refs), the item is pressed from that read (AXPress,
// headless), and an Open or Save panel it raised is cancelled at once. Only in a copy the agent's own `open` started.
extension HandsRouter {
    func menu(_ req: HandsRequest) -> HandsEnvelope {
        let path = MenuPath.parse(req.string("path") ?? "")
        guard req.int("window") != nil, !path.isEmpty else {
            return .failure(HandsError(.badArguments, "window and path are needed", suggestion: #"usage: polycarp-spaces agent menu --window <id> "Format > Font > Bold""#, retry: .safe, nextCall: .null))
        }
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let (w, scope, _)):
            let session = req.session ?? ""
            // Everything but the app being in front, which the wait below handles like posted keys.
            if let e = menuRule(w, session: session, front: false)() { return .failure(e) }
            if let e = awaitUse(w, verb: "menu", delivery: .posted, wait: req.int("wait"), session: session) { return .failure(e) }
            let token = AgentActivity.shared.begin(pid: w.pid, window: w.id)
            defer { AgentActivity.shared.end(token) }
            let acting = actingCheck(w, verb: "menu", delivery: .posted, session: session, also: menuRule(w, session: session, front: true))
            let childrenBefore = noteAction(session: session, pid: w.pid)
            var spelled: [String] = [], press: JSONValue = .null
            let reply = HandsEngine.shared.transaction(window: w, check: acting) { [self] cancelled in
                guard case .ok(let bar) = HandsEngine.shared.snapshotInline(window: w, interactive: false, compact: false, depth: 12, evidence: true, surface: HandsEngine.surfaceMenubar) else {
                    return .failed(HandsError(.engineError, "the menu bar couldn't be read", suggestion: "Snapshot the window and try again.", retry: .safe))
                }
                let found = MenuPath.find(bar["tree"] ?? .null, path: path)
                // Every level the path reached is judged before anything is pressed or listed (a submenu's choices too).
                guard let steps = MenuAX.steps(pid: w.pid, path: MenuPath.reached(found, path: path)) else {
                    return .failed(HandsError(.engineError, "the menu's key equivalents couldn't be read, so Polycarp can't tell whether the command is safe",
                                              suggestion: "Snapshot the window, then try the menu command again.", retry: .afterSnapshot, nextCall: HandsError.call("snapshot", ["window": .int(Int(w.id))])))
                }
                if let e = MenuPath.policy(steps) { return .failed(e) }
                guard case .item(let ref, let names) = found else {
                    return .failed(MenuPath.error(found, path: path, window: Int(w.id)) ?? HandsError(.engineError, "no menu item", suggestion: "Snapshot the window.", retry: .safe))
                }
                spelled = names
                switch HandsEngine.shared.actInline(window: w, ref: ref, kind: .click, evidence: true, check: acting, cancelled: cancelled) {
                case .failed(let e): return .failed(e)
                case .ok(let d): press = d
                }
                return .ok(.null)
            }
            if case .failed(let e) = reply { return .failure(e) }
            // Off the app's queue, so other calls on it don't wait: a panel now is refused, a slower one still cancelled.
            if let e = cancelPanels(w, within: 0.3) { return .failure(e) }
            DispatchQueue.global(qos: .utility).async { [weak self] in _ = self?.cancelPanels(w, within: 3) }
            var o: [String: JSONValue] = ["action": "menu", "path": .array(spelled.map(JSONValue.string)), "engine": press, "target": targetJSON(w, scope),
                                          "verified": .bool(press["disposition"]?["delivery"]?.string == "delivered_verified")]
            if o["verified"] == false { o["next_call"] = HandsNextCall.after(.unverified, window: Int(w.id)) }
            if let opened = openedChildren(pid: w.pid, before: childrenBefore, session: session) { o["opened"] = opened }
            return .success(.object(o))
        }
    }

    /// The key-window rule, from facts read when it runs.
    private func menuRule(_ w: HandsWindow, session: String, front: Bool) -> HandsEngine.Check {
        { [self] in
            let owned = onMain { host.agentOwned() }
            let mine = !session.isEmpty && childLocked { sessionWindows.owner(of: w.id) } == session
            let others = BackgroundAX.windows(pid: w.pid)
            let count = others.mapped.filter { $0.id != w.id && !$0.minimized }.count + others.unmapped
            return MenuPath.refusal(app: w.app, window: w.id, agentOwned: owned.contains(w.pid), sessionOwns: mine, otherWindows: count,
                                    focusedWindow: BackgroundAX.focus(pid: w.pid).window,
                                    front: front && NSWorkspace.shared.frontmostApplication?.processIdentifier == w.pid)
        }
    }

    /// For `within` seconds: any window or sheet of the app that is an Open or Save panel is cancelled through the engine,
    /// in its own transaction (the button its AXCancelButton names, or one whose identifier says cancel).
    private func cancelPanels(_ w: HandsWindow, within: TimeInterval) -> HandsError? {
        let deadline = Date().addingTimeInterval(within)
        repeat {
            let windows = MenuAX.windows(w.pid)
            let nodes = windows.map { HandsAXTree.node($0.element, depth: 5) }
            if let i = MenuPath.panels(nodes).first {
                var target = w
                target.id = windows[i].id ?? w.id
                let title = MenuPath.cancelTitle(nodes[i], cancelButton: MenuAX.cancelTitle(windows[i].element))
                return MenuPath.panelRefusal(w.app, cancelled: title.map { cancelPanel(target, title: $0, scope: check(w)) } ?? false)
            }
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < deadline
        return nil
    }

    /// Presses the panel's Cancel button through the engine; true when that press went through.
    private func cancelPanel(_ target: HandsWindow, title: String, scope: @escaping HandsEngine.Check) -> Bool {
        let reply = HandsEngine.shared.transaction(window: target, check: scope) { cancelled in
            guard case .ok(let d) = HandsEngine.shared.snapshotInline(window: target, interactive: false, compact: false, depth: 12, evidence: true),
                  let ref = MenuPath.cancelRef(d["tree"] ?? .null, title: title) else {
                return .failed(HandsError(.engineError, "no Cancel button in the panel's read", suggestion: "", retry: .never))
            }
            return HandsEngine.shared.actInline(window: target, ref: ref, kind: .click, evidence: true, check: scope, cancelled: cancelled)
        }
        if case .ok = reply { return true }
        return false
    }
}

/// Reads only, with a short timeout.
enum MenuAX {
    static func app(_ pid: Int32) -> AXUIElement {
        let a = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(a, 0.25)
        return a
    }
    static func copy(_ e: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var out: CFTypeRef?
        return AXUIElementCopyAttributeValue(e, attribute as CFString, &out) == .success ? out : nil
    }
    static func children(_ e: AXUIElement) -> [AXUIElement] { (copy(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
    /// The app's windows with their sheets (a Save panel is often a sheet), and the window number where there is one.
    static func windows(_ pid: Int32) -> [(element: AXUIElement, id: UInt32?)] {
        let list = (copy(app(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
        return list.flatMap { w -> [(element: AXUIElement, id: UInt32?)] in
            let id = BackgroundAX.windowID(of: w)
            let sheets = children(w).filter { (copy($0, kAXRoleAttribute) as? String) == "AXSheet" }
            return [(w, id)] + sheets.map { ($0, id) }
        }
    }
    /// The menu bar along `path`: each menu's items with their key equivalents, and the one the path takes. Nil when unread.
    static func steps(pid: Int32, path: [String]) -> [MenuPath.Step]? {
        guard !path.isEmpty else { return [] }
        guard let raw = copy(app(pid), kAXMenuBarAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        var level = children(raw as! AXUIElement), out: [MenuPath.Step] = []
        for want in path {
            let items = level.map(item)
            guard let at = items.firstIndex(where: { MenuPath.same($0.title, want) }) else { return nil }
            out.append(.init(items: items, at: at))
            level = children(level[at]).first.map(children) ?? []
        }
        return out
    }
    static func item(_ e: AXUIElement) -> MenuPath.MenuItem {
        .init(identifier: copy(e, kAXIdentifierAttribute) as? String, cmdChar: copy(e, kAXMenuItemCmdCharAttribute) as? String,
              modifiers: (copy(e, kAXMenuItemCmdModifiersAttribute) as? NSNumber)?.intValue, title: (copy(e, kAXTitleAttribute) as? String) ?? "",
              submenu: !children(e).isEmpty)
    }
    static func cancelTitle(_ e: AXUIElement) -> String? {
        guard let b = copy(e, kAXCancelButtonAttribute), CFGetTypeID(b) == AXUIElementGetTypeID() else { return nil }
        return copy(b as! AXUIElement, kAXTitleAttribute) as? String
    }
}
