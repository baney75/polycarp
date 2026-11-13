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
            var spelled: [String] = [], press: JSONValue = .null, cancelledEarlier = false, oldPanels: [AXUIElement] = []
            let before = MenuAX.ids(), agent = onMain { host.agentWorkspace() }
            let watch = MenuWatch<MenuPath.Seen>()
            let reply = HandsEngine.shared.transaction(window: w, check: acting) { [self] cancelled in
                func pressable() -> Result<(ref: String, names: [String]), HandsError> {
                    guard case .ok(let bar) = HandsEngine.shared.snapshotInline(window: w, interactive: false, compact: false, depth: 12, evidence: true, surface: HandsEngine.surfaceMenubar) else {
                        return .failure(HandsError(.engineError, "the menu bar couldn't be read", suggestion: "Snapshot the window and try again.", retry: .safe))
                    }
                    let found = MenuPath.find(bar["tree"] ?? .null, path: path)
                    // Every level the path reached is judged before anything is pressed or listed (a submenu's choices too).
                    // An item whose attributes couldn't be read (a busy app timed out) is unknown, and unknown is refused.
                    if let e = MenuPath.judge(MenuAX.steps(pid: w.pid, path: MenuPath.reached(found, path: path)), window: Int(w.id)) { return .failure(e) }
                    guard case .item(let ref, let names) = found else {
                        return .failure(MenuPath.error(found, path: path, window: Int(w.id)) ?? HandsError(.engineError, "no menu item", suggestion: "Snapshot the window.", retry: .safe))
                    }
                    return .success((ref, names))
                }
                var item = pressable()
                // A panel already up is not the command's (197 r1 second-S1), but nothing else would cancel it: once the path
                // is judged and found, it is cancelled just before the press (217 r1 first-F1). Its read replaces the
                // evidence store's, so the bar is read again.
                if case .success = item {
                    var why: HandsError?
                    let earlier = withoutActuallyEscaping(cancelled) { c in
                        MenuPath.cancelEarlier(count: MenuAX.panelElements(w.pid).count, pause: { Thread.sleep(forTimeInterval: 0.1) }) {
                            // The error belongs to the last attempt only (258 r1 first-F2).
                            why = nil
                            return cancelOnePanel(w, old: [], inline: c, failed: { why = $0 })
                        }
                    }
                    switch earlier {
                    case .none: break
                    case .stuck(let after): return .failed(MenuPath.earlierError(w.app, afterCancelling: after, engine: why))
                    case .cancelled: cancelledEarlier = true; item = pressable()
                    }
                }
                let found: (ref: String, names: [String])
                switch item {
                case .failure(let e): return .failed(e)
                case .success(let f): found = f
                }
                let ref = found.ref
                spelled = found.names
                oldPanels = MenuAX.panelElements(w.pid)
                watch.start(menuWatchStep(w, before: before, agent: agent, oldPanels: oldPanels))
                switch HandsEngine.shared.actInline(window: w, ref: ref, kind: .click, evidence: true, check: acting, cancelled: cancelled) {
                case .failed(let e): return .failed(e)
                case .ok(let d): press = d
                }
                return .ok(.null)
            }
            // Whatever the press answered: a panel, or a window outside the agent workspace, it raised within the watch is
            // undone and the call fails, named so it isn't retried. A watch that couldn't finish never answers ok. A panel
            // later than the watch stays open on the agent workspace, where the next snapshot shows it (192 r1 second-F9).
            let named = (spelled.isEmpty ? path : spelled).joined(separator: " > ")
            // A failure after the earlier panel's cancel still says it (217 r1 first-F1).
            func failed(_ e: HandsError) -> HandsEnvelope { var e = e; if cancelledEarlier { e.message += MenuPath.earlierNote }; return .failure(e) }
            switch watch.finish() {
            case .seen(let looks): return failed(undo(MenuPath.Seen.merged(looks), w, path: named, oldPanels: oldPanels))
            case .unknown: return failed(MenuWatch<MenuPath.Seen>.unknownRefusal(named, window: Int(w.id)))
            case .quiet: break
            }
            if case .failed(let e) = reply { return failed(e) }
            var o: [String: JSONValue] = ["action": "menu", "path": .array(spelled.map(JSONValue.string)), "engine": press, "target": targetJSON(w, scope),
                                          "verified": .bool(press["disposition"]?["delivery"]?.string == "delivered_verified")]
            if o["verified"] == false { o["next_call"] = HandsNextCall.after(.unverified, window: Int(w.id)) }
            if cancelledEarlier { o["cancelled_earlier_panel"] = true }
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
            let panels = others.mapped.contains { $0.id != w.id && !$0.minimized } ? MenuAX.panelWindows(w.pid) : []
            let count = MenuPath.otherWindows(others.mapped.map { ($0.id, $0.minimized) }, unmapped: others.unmapped, window: w.id, panels: panels)
            return MenuPath.refusal(app: w.app, window: w.id, agentOwned: owned.contains(w.pid), sessionOwns: mine, otherWindows: count,
                                    focusedWindow: BackgroundAX.focus(pid: w.pid).window, panels: panels,
                                    front: front && NSWorkspace.shared.frontmostApplication?.processIdentifier == w.pid)
        }
    }

    /// One look for layer 2: an Open or Save panel of the app, or a new window outside the agent workspace that may be
    /// the press's (`MenuPath.escaped`). Input from Donovan shortly before or since the press unties a helper's window from it.
    private func menuWatchStep(_ w: HandsWindow, before: Set<UInt32>, agent: Int?, oldPanels: [AXUIElement]) -> @Sendable (Bool) -> MenuPath.Seen? {
        let started = Date()
        return { [self] settled in
            let windows = MenuAX.windows(w.pid)
            let old = windows.map { x in oldPanels.contains { CFEqual($0, x.element) } }
            let nodes = windows.map { MenuAX.node($0.element) }
            let panel = MenuPath.panel(nodes, old: old) != nil
            let all = MenuAX.listed()
            // A panel that is a window of its own is the panel, cancelled as one, never an escape (205 r1 second-S1).
            var new = MenuPath.fresh(all, before: before, panels: MenuPath.panelWindows(nodes, sheet: windows.map(\.sheet), ids: windows.map(\.id)))
            guard !new.isEmpty else { return panel ? MenuPath.Seen(panel: true) : nil }
            // One trip to the main thread per look, not one per window (first-F1).
            let ids = new.map(\.id)
            let places = onMain { ids.map { host.live($0)?.workspace } }
            for i in new.indices { new[i].workspace = places[i]; MenuAX.fillProcess(&new[i]) }
            let userInput = MenuPath.userInput(idle: IdleWatch.idle(), sincePress: Date().timeIntervalSince(started))
            let found = MenuPath.escaped(before: before, now: new, pid: w.pid, agentWorkspace: agent, settled: settled,
                                         parent: all.first { $0.id == w.id }?.bounds, userInput: userInput)
            return found.isEmpty && !panel ? nil : MenuPath.Seen(panel: panel, escapes: found)
        }
    }

    /// Undoes what the watch saw, through the engine and Polycarp's own close, and says it as the call's error. Only a
    /// window tied to the press is closed; any other is reported and left alone (192 r1 first-F2).
    /// A panel and windows seen in the same watch are both undone; the panel's error leads.
    /// A window that closed on its own since a look saw it is reported as gone, not closed or still open (205 r1 second-S2).
    private func undo(_ seen: MenuPath.Seen, _ w: HandsWindow, path: String, oldPanels: [AXUIElement]) -> HandsError {
        let (found, gone) = seen.split(MenuAX.listed())
        var open = found.filter(\.tied)
        let (panelError, closed) = MenuPath.undoing(panel: seen.panel,
            cancel: { cancelPanels(w, within: 0.3, old: oldPanels) ?? MenuPath.panelRefusal(w.app, cancelled: false, gone: true) },
            close: { open.removeAll { x in onMain { host.close(x.window.id) } }; return open.isEmpty },
            pause: { Thread.sleep(forTimeInterval: 0.1) })
        let escape = seen.escapes.isEmpty ? nil : MenuPath.escapeRefusal(path, found: found, gone: gone, closed: closed, window: Int(w.id))
        guard var e = panelError else { return escape ?? MenuPath.panelRefusal(w.app, cancelled: false, gone: true) }
        if let escape { e.message += "; also: " + escape.message }
        return e
    }

    /// For `within` seconds: any window or sheet of the app that is an Open or Save panel is cancelled through the engine,
    /// in its own transaction (the button its AXCancelButton names, or one whose identifier says cancel).
    private func cancelPanels(_ w: HandsWindow, within: TimeInterval, old oldPanels: [AXUIElement] = []) -> HandsError? {
        let deadline = Date().addingTimeInterval(within)
        repeat {
            if let cancelled = cancelOnePanel(w, old: oldPanels) { return MenuPath.panelRefusal(w.app, cancelled: cancelled) }
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < deadline
        return nil
    }

    /// The app's first Open or Save panel not in `old`, cancelled: nil when there is none, else whether the cancel went through.
    /// `inline`: already in the app's transaction, so the cancel runs in it.
    private func cancelOnePanel(_ w: HandsWindow, old oldPanels: [AXUIElement], inline cancelled: (() -> Bool)? = nil, failed: (HandsError) -> Void = { _ in }) -> Bool? {
        let windows = MenuAX.windows(w.pid)
        let nodes = windows.map { MenuAX.node($0.element) }
        guard let i = MenuPath.panel(nodes, old: windows.map { x in oldPanels.contains { CFEqual($0, x.element) } }) else { return nil }
        var target = w
        target.id = windows[i].id ?? w.id
        let title = MenuPath.cancelTitle(nodes[i], cancelButton: MenuAX.cancelTitle(windows[i].element))
        guard let title else { return false }
        if let cancelled {
            guard let e = cancelInline(target, title: title, scope: check(w), cancelled: cancelled) else { return true }
            failed(e)
            return false
        }
        return cancelPanel(target, title: title, scope: check(w))
    }

    /// Presses the panel's Cancel button through the engine; true when that press went through.
    private func cancelPanel(_ target: HandsWindow, title: String, scope: @escaping HandsEngine.Check) -> Bool {
        let reply = HandsEngine.shared.transaction(window: target, check: scope) { [self] cancelled in
            cancelInline(target, title: title, scope: scope, cancelled: cancelled).map { .failed($0) } ?? .ok(.null)
        }
        if case .ok = reply { return true }
        return false
    }

    /// The panel's Cancel, read and pressed through the engine on the app's queue: only inside a transaction. Nil when
    /// the press went through, else why not.
    private func cancelInline(_ target: HandsWindow, title: String, scope: @escaping HandsEngine.Check, cancelled: () -> Bool) -> HandsError? {
        let read = HandsEngine.shared.snapshotInline(window: target, interactive: false, compact: false, depth: 12, evidence: true)
        if case .failed(let e) = read { return e }
        guard case .ok(let d) = read, let ref = MenuPath.cancelRef(d["tree"] ?? .null, title: title) else {
            return HandsError(.actionFailed, "the panel has no Cancel button Polycarp can press", suggestion: "", retry: .never)
        }
        if case .failed(let e) = HandsEngine.shared.actInline(window: target, ref: ref, kind: .click, evidence: true, check: scope, cancelled: cancelled) { return e }
        return nil
    }
}

/// Reads only, each with a short timeout. The timeout is set on every element read, since it holds only for the element
/// it is set on, not for its children (192 r1 first-F1): a hung app costs 0.25 s a read, not 6.
enum MenuAX {
    static let timeout: Float = 0.25
    static func app(_ pid: Int32) -> AXUIElement { AXUIElementCreateApplication(pid) }
    static func copy(_ e: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var out: CFTypeRef?
        AXUIElementSetMessagingTimeout(e, timeout)
        return AXUIElementCopyAttributeValue(e, attribute as CFString, &out) == .success ? out : nil
    }
    /// A read that tells "no value" from "the read failed" (a busy app times out): first-F2, second-F10.
    static func read<T: Sendable>(_ e: AXUIElement, _ attribute: String, _ cast: (CFTypeRef) -> T?) -> MenuPath.Read<T> {
        var out: CFTypeRef?
        AXUIElementSetMessagingTimeout(e, timeout)
        let code = AXUIElementCopyAttributeValue(e, attribute as CFString, &out)
        return MenuPath.read(code: code.rawValue, value: code == .success ? out.flatMap(cast) : nil)
    }
    /// A window's tree for the panel check, through the same short-timeout reads.
    static func node(_ e: AXUIElement) -> AXNodeInfo {
        AXTreeRead.node(e, depth: 5, string: { copy($0, $1) as? String }, children: { el in
            var out: CFTypeRef?
            AXUIElementSetMessagingTimeout(el, timeout)
            let ok = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &out)
            return ((out as? [AXUIElement]) ?? [], ok == .success || ok == .noValue)
        })
    }
    /// A new window's process: its bundle id and parent pid, for tying it to the press.
    static func fillProcess(_ w: inout MenuPath.Listed) {
        w.bundle = MenuPath.processBundle(pid: w.pid) ?? NSRunningApplication(processIdentifier: w.pid)?.bundleIdentifier
        var info = proc_bsdinfo()
        if proc_pidinfo(w.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size) {
            w.parent = Int32(info.pbi_ppid)
        }
    }
    static func children(_ e: AXUIElement) -> [AXUIElement] { (copy(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
    /// The app's windows and sheets that are Open or Save panels now.
    static func panelElements(_ pid: Int32) -> [AXUIElement] {
        let windows = self.windows(pid)
        return MenuPath.panels(windows.map { node($0.element) }).map { windows[$0].element }
    }
    /// The numbers of the app's panel windows (not sheets), read only when the app has other windows.
    static func panelWindows(_ pid: Int32) -> Set<UInt32> {
        let windows = self.windows(pid)
        return MenuPath.panelWindows(windows.map { node($0.element) }, sheet: windows.map(\.sheet), ids: windows.map(\.id))
    }
    /// The app's windows with their sheets (a Save panel is often a sheet), and the window number where there is one.
    /// `sheet`: a sheet, which carries its window's number (217 r1 first-F2).
    static func windows(_ pid: Int32) -> [(element: AXUIElement, id: UInt32?, sheet: Bool)] {
        let list = (copy(app(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
        return list.flatMap { w -> [(element: AXUIElement, id: UInt32?, sheet: Bool)] in
            let id = BackgroundAX.windowID(of: w)
            let sheets = children(w).filter { (copy($0, kAXRoleAttribute) as? String) == "AXSheet" }
            return [(w, id, false)] + sheets.map { ($0, id, true) }
        }
    }
    /// The menu bar along `path`: each menu's items with their key equivalents, and the one the path takes. Nil when unread.
    static func steps(pid: Int32, path: [String]) -> [MenuPath.Step]? {
        guard !path.isEmpty else { return [] }
        guard let raw = copy(app(pid), kAXMenuBarAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        var level = children(raw as! AXUIElement), out: [MenuPath.Step] = []
        for want in path {
            let items = level.compactMap(item)
            guard items.count == level.count, let at = items.firstIndex(where: { MenuPath.same($0.title, want) }) else { return nil }
            out.append(.init(items: items, at: at))
            level = children(level[at]).first.map(children) ?? []
        }
        // A path that stops at a submenu of the Edit menu (Edit > Find) lists it: its items are judged too (197 r1 second-S4),
        // by `appended` alone; one that can't be read is left out and `appended` refuses (205 r1 first-F2, 217 r1 first-F4).
        if MenuPath.listsOpens(out) {
            let opens = level.compactMap(item)
            if opens.count == level.count { out[1].opens = opens }
        }
        return out
    }
    static func item(_ e: AXUIElement) -> MenuPath.MenuItem? {
        let kids = read(e, kAXChildrenAttribute) { ($0 as? [AXUIElement])?.count }
        let submenu: Bool? = switch kids { case .value(let n): n > 0; case .absent: false; case .failed: nil }
        return MenuPath.item(identifier: read(e, kAXIdentifierAttribute) { $0 as? String }, cmdChar: read(e, kAXMenuItemCmdCharAttribute) { $0 as? String },
                             modifiers: read(e, kAXMenuItemCmdModifiersAttribute) { ($0 as? NSNumber)?.intValue }, title: read(e, kAXTitleAttribute) { $0 as? String },
                             submenu: submenu)
    }
    /// Every window the window server lists, with whether a person could see it now. Workspaces are filled in by the caller.
    static func listed() -> [MenuPath.Listed] {
        let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
        var ids = [CGDirectDisplayID](repeating: 0, count: 16), count: UInt32 = 0
        CGGetActiveDisplayList(16, &ids, &count)
        let displays = ids.prefix(Int(count)).map(CGDisplayBounds)
        return info.compactMap { w in
            guard let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value, let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { return nil }
            let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) } ?? .zero
            let on = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
            let alpha = (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            return .init(id: id, pid: pid, owner: w[kCGWindowOwnerName as String] as? String ?? "",
                         visible: on && alpha > 0 && b.width > 1 && b.height > 1 && displays.contains { $0.intersects(b) }, workspace: nil, bounds: b)
        }
    }
    static func ids() -> Set<UInt32> { Set(listed().map(\.id)) }
    static func cancelTitle(_ e: AXUIElement) -> String? {
        guard let b = copy(e, kAXCancelButtonAttribute), CFGetTypeID(b) == AXUIElementGetTypeID() else { return nil }
        return copy(b as! AXUIElement, kAXTitleAttribute) as? String
    }
}
