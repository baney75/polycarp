import AppKit
import ApplicationServices
import BaneySpacesCore

/// What a right click did: what was posted (for the pointer audit) and its answer.
struct ContextPress {
    var posted = 0, released = 0
    var aimed: [CGPoint] = []
    var lastPostAt = Date()
    /// A cancel didn't take: the menu may still be open, which is said over anything else (210 r1 first-F3).
    var leftOpen = false
    var result: Result<[String: JSONValue], HandsError> = .failure(HandsError(.engineError, "the right click didn't run", suggestion: "Try again.", retry: .safe))
}

extension HandsRouter {
    /// Whether the window is the agent workspace's own: not lent, not Full Access, and placed there now (210 r1 second-S4).
    func onAgentWorkspace(_ w: HandsWindow, _ scope: ScopeDecision) -> Bool {
        scope == .onAgentWorkspace && onMain { host.agentWorkspace().map { host.live(w.id)?.workspace == $0 } ?? false }
    }

    /// Whether the agent workspace is on screen now.
    func agentShown() -> Bool {
        onMain {
            guard let n = host.agentWorkspace() else { return false }
            return host.workspaceRows().first { $0.number == n }?.shown ?? false
        }
    }

    /// A right click at `point` (window-local) and its context menu, on the process queue (`ContextMenu` has the rules).
    /// Every path that posted ends with no menu of this press open.
    /// The cancel is Escape posted to the process (the engine has none for a menu, and the router never performs
    /// accessibility actions itself), with the key permit `keys` plans before anything is posted: no permit, no right
    /// click (210 r1 first-F1). The item is pressed by ref through the engine's menu surface.
    func contextPress(_ w: HandsWindow, frame: CGRect, point: CGPoint, permit: BackgroundPermit, stop: () -> HandsError?, item: String?, agentWindow: Bool,
                      keys: () -> BackgroundPermit?, check: @escaping HandsEngine.Check, cancelled: () -> Bool) -> ContextPress {
        var out = ContextPress()
        let displays = ContextMenuAX.displays()
        let screen = PointerPath.screenPoint(local: point, frame: frame)
        if let e = ContextMenu.gate(agentShown: agentShown(), agentWindow: agentWindow, window: frame, point: screen, displays: displays) { out.result = .failure(e); return out }
        guard let keyPermit = keys() else { out.result = .failure(ContextMenu.noCancel(w.app)); return out }
        let escape = { BackgroundPoster.keys([KeyChord(keyCode: 53, flags: 0, label: "escape")], permit: keyPermit, stop: { nil }).stopped == nil }
        let before = Set(ContextMenuAX.menus(w.pid, before: []).map(\.id))
        let post = BackgroundPoster.pointer(InputScript.rightClick(at: point), frame: frame, drag: false, gesture: BackgroundPoster.newGesture(), permit: permit, stop: stop)
        out.aimed = post.screenPoints; out.posted = post.report.posted.count; out.released = post.report.released; out.lastPostAt = Date()
        func waitShown(_ t: TimeInterval) -> [ContextMenu.Shown] {
            let deadline = Date().addingTimeInterval(t)
            repeat {
                let shown = ContextMenuAX.menus(w.pid, before: before)
                if !shown.isEmpty { return shown }
                Thread.sleep(forTimeInterval: 0.03)
            } while Date() < deadline
            return []
        }
        let shown = waitShown(ContextMenu.wait)
        func cancel() -> Bool {
            if ContextMenuAX.gone(w.pid, before: before, within: 0) { return true }
            _ = escape()
            let gone = ContextMenuAX.gone(w.pid, before: before, within: 0.5)
            if !gone { out.leftOpen = true }
            return gone
        }
        if let stopped = post.report.stopped {
            out.result = .failure(shown.isEmpty || cancel() ? stopped : ContextMenu.stillOpen(w.app))
            return out
        }
        switch ContextMenu.verdict(shown, agentShown: agentShown(), display: ContextMenu.display(window: frame, displays: displays)) {
        case .none:
            // A busy app can draw its menu after the wait: a second look, and a late menu is cancelled (210 r1 first-F2).
            let late = waitShown(ContextMenu.wait)
            out.result = .failure(late.isEmpty ? ContextMenu.noMenu(w.app) : cancel() ? ContextMenu.late(w.app) : ContextMenu.stillOpen(w.app))
        case .elsewhere:
            out.result = .failure(ContextMenu.elsewhere(w.app, cancelled: cancel()))
        case .onAgent(let menus):
            guard let read = ContextMenuAX.items(w.pid) else {
                out.result = .failure(ContextMenu.unread(w.app, cancelled: cancel()))
                return out
            }
            var data: [String: JSONValue] = ["menu_windows": .array(menus.map { .int(Int($0.id)) }),
                                             "items": .array(read.items.map(\.title).filter { !$0.isEmpty }.map(JSONValue.string))]
            guard let item else {
                guard cancel() else { out.result = .failure(ContextMenu.stillOpen(w.app)); return out }
                data["cancelled"] = true
                out.result = .success(data)
                return out
            }
            switch ContextMenu.choose(read.items, enabled: read.enabled, want: item) {
            case .failure(let e):
                out.result = .failure(cancel() ? e : ContextMenu.stillOpen(w.app))
            case .success(let at):
                guard pressItem(w, title: read.items[at].title, check: check, cancelled: cancelled) else {
                    out.result = .failure(cancel() ? ContextMenu.notPressed(w.app, item: item) : ContextMenu.stillOpen(w.app))
                    return out
                }
                // Pressed is pressed, whatever the menu does next, so it is never retried. Escape only while the menu is
                // still listed after the wait (210 r1 second-S1).
                data["pressed"] = .string(read.items[at].title)
                guard ContextMenuAX.gone(w.pid, before: before, within: 0.5) || cancel() else {
                    out.result = .failure(ContextMenu.pressedOpen(w.app, item: read.items[at].title))
                    return out
                }
                out.result = .success(data)
            }
        }
        return out
    }

    /// The item, by ref from the engine's read of the open menu, pressed through the engine. True when the press went through.
    private func pressItem(_ w: HandsWindow, title: String, check: @escaping HandsEngine.Check, cancelled: () -> Bool) -> Bool {
        guard case .ok(let d) = HandsEngine.shared.snapshotInline(window: w, interactive: false, compact: false, depth: 8, evidence: true, surface: HandsEngine.surfaceMenu),
              let ref = ContextMenu.ref(d["tree"] ?? .null, title: title) else { return false }
        if case .ok = HandsEngine.shared.actInline(window: w, ref: ref, kind: .click, evidence: true, check: check, cancelled: cancelled) { return true }
        return false
    }
}

/// Reads with the menu bar's short timeout (`MenuAX`).
enum ContextMenuAX {
    static func displays() -> [CGRect] {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16), count: UInt32 = 0
        CGGetActiveDisplayList(16, &ids, &count)
        return ids.prefix(Int(count)).map(CGDisplayBounds)
    }

    static func menus(_ pid: Int32, before: Set<UInt32>) -> [ContextMenu.Shown] {
        ContextMenu.menus(CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? [], pid: pid, before: before)
    }

    static func gone(_ pid: Int32, before: Set<UInt32>, within: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(within)
        repeat {
            if menus(pid, before: before).isEmpty { return true }
            Thread.sleep(forTimeInterval: 0.03)
        } while Date() < deadline
        return false
    }

    /// The open context menu: the app's child with the AXMenu role.
    static func menu(_ pid: Int32) -> AXUIElement? {
        MenuAX.children(MenuAX.app(pid)).first { (MenuAX.copy($0, kAXRoleAttribute) as? String) == (kAXMenuRole as String) }
    }

    /// Its items with whether each is enabled, or nil when any item couldn't be read.
    static func items(_ pid: Int32) -> (items: [MenuPath.MenuItem], enabled: [Bool?])? {
        guard let m = menu(pid) else { return nil }
        let kids = MenuAX.children(m)
        let items = kids.compactMap(MenuAX.item)
        guard !kids.isEmpty, items.count == kids.count else { return nil }
        let enabled: [Bool?] = kids.map { e in
            switch MenuAX.read(e, kAXEnabledAttribute, { ($0 as? NSNumber)?.boolValue }) {
            case .value(let b): return b
            case .absent: return false
            case .failed: return nil
            }
        }
        return (items, enabled)
    }
}
