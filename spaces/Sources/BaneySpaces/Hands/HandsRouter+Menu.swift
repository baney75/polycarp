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
            if let e = menuRule(w, front: false)() { return .failure(e) }
            if let e = awaitUse(w, verb: "menu", delivery: .posted, wait: req.int("wait"), session: session) { return .failure(e) }
            let token = AgentActivity.shared.begin(pid: w.pid, window: w.id)
            defer { AgentActivity.shared.end(token) }
            let acting = actingCheck(w, verb: "menu", delivery: .posted, session: session, also: menuRule(w, front: true))
            let childrenBefore = noteAction(session: session, pid: w.pid)
            var spelled: [String] = [], press: JSONValue = .null
            let reply = HandsEngine.shared.transaction(window: w, check: acting) { [self] cancelled in
                guard case .ok(let bar) = HandsEngine.shared.snapshotInline(window: w, interactive: false, compact: false, depth: 12, evidence: true, surface: HandsEngine.surfaceMenubar) else {
                    return .failed(HandsError(.engineError, "the menu bar couldn't be read", suggestion: "Snapshot the window and try again.", retry: .safe))
                }
                let tree = bar["tree"] ?? .null
                let found = MenuPath.find(tree, path: path)
                guard case .item(let ref, let names) = found else {
                    return .failed(MenuPath.error(found, path: path, window: Int(w.id)) ?? HandsError(.engineError, "no menu item", suggestion: "Snapshot the window.", retry: .safe))
                }
                if names.count > 1, MenuPath.inAppMenu(tree, path: names), let e = MenuPath.appMenuRefusal(appMenuItem(pid: w.pid, title: names[1])) { return .failed(e) }
                spelled = names
                switch HandsEngine.shared.actInline(window: w, ref: ref, kind: .click, evidence: true, check: acting, cancelled: cancelled) {
                case .failed(let e): return .failed(e)
                case .ok(let d): press = d
                }
                if let e = cancelPanels(w, cancelled: cancelled) { return .failed(e) }
                return .ok(.null)
            }
            if case .failed(let e) = reply { return .failure(e) }
            var o: [String: JSONValue] = ["action": "menu", "path": .array(spelled.map(JSONValue.string)), "engine": press, "target": targetJSON(w, scope),
                                          "verified": .bool(press["disposition"]?["delivery"]?.string == "delivered_verified")]
            if o["verified"] == false { o["next_call"] = HandsNextCall.after(.unverified, window: Int(w.id)) }
            if let opened = openedChildren(pid: w.pid, before: childrenBefore, session: session) { o["opened"] = opened }
            return .success(.object(o))
        }
    }

    /// The key-window rule, from facts read when it runs.
    private func menuRule(_ w: HandsWindow, front: Bool) -> HandsEngine.Check {
        { [self] in
            let owned = onMain { host.agentOwned() }
            let others = BackgroundAX.windows(pid: w.pid)
            let count = others.mapped.filter { $0.id != w.id && !$0.minimized }.count + others.unmapped
            return MenuPath.refusal(app: w.app, window: w.id, agentOwned: owned.contains(w.pid), otherWindows: count,
                                    focusedWindow: BackgroundAX.focus(pid: w.pid).window,
                                    front: front && NSWorkspace.shared.frontmostApplication?.processIdentifier == w.pid)
        }
    }

    /// For up to a second after the press: any window or sheet of the app that is an Open or Save panel is cancelled
    /// through the engine (its AXCancelButton's title names the button in the engine's read of that window).
    private func cancelPanels(_ w: HandsWindow, cancelled: () -> Bool) -> HandsError? {
        let deadline = Date().addingTimeInterval(1)
        repeat {
            let windows = MenuAX.windows(w.pid)
            let hits = MenuPath.panels(windows.map { HandsAXTree.node($0.element, depth: 3) })
            if let i = hits.first {
                var target = w
                target.id = windows[i].id ?? w.id
                return MenuPath.panelRefusal(w.app, cancelled: cancelPanel(target, element: windows[i].element, scope: check(w), cancelled: cancelled))
            }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline
        return nil
    }

    /// Presses the panel's Cancel button through the engine; true when that press went through.
    private func cancelPanel(_ target: HandsWindow, element: AXUIElement, scope: @escaping HandsEngine.Check, cancelled: () -> Bool) -> Bool {
        guard let title = MenuAX.cancelTitle(element) else { return false }
        guard case .ok(let d) = HandsEngine.shared.snapshotInline(window: target, interactive: false, compact: false, depth: 12, evidence: true) else { return false }
        guard let ref = MenuPath.cancelRef(d["tree"] ?? .null, title: title) else { return false }
        if case .ok = HandsEngine.shared.actInline(window: target, ref: ref, kind: .click, evidence: true, check: scope, cancelled: cancelled) { return true }
        return false
    }

    /// The app menu's item titled `title`, as accessibility reports it; only its title when it can't be read.
    private func appMenuItem(pid: Int32, title: String) -> MenuPath.AppMenuItem {
        var items: [AXUIElement] = []
        if let raw = MenuAX.copy(MenuAX.app(pid), kAXMenuBarAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() {
            let top = MenuAX.children(raw as! AXUIElement).dropFirst().first
            if let menu = top.flatMap({ MenuAX.children($0).first }) { items = MenuAX.children(menu) }
        }
        guard let item = items.first(where: { (MenuAX.copy($0, kAXTitleAttribute) as? String) == title }) else { return .init(title: title) }
        return .init(identifier: MenuAX.copy(item, kAXIdentifierAttribute) as? String, cmdChar: MenuAX.copy(item, kAXMenuItemCmdCharAttribute) as? String,
                     modifiers: (MenuAX.copy(item, kAXMenuItemCmdModifiersAttribute) as? NSNumber)?.intValue, title: title)
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
    static func cancelTitle(_ e: AXUIElement) -> String? {
        guard let b = copy(e, kAXCancelButtonAttribute), CFGetTypeID(b) == AXUIElementGetTypeID() else { return nil }
        return copy(b as! AXUIElement, kAXTitleAttribute) as? String
    }
}
