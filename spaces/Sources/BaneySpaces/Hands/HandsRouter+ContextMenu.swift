import AppKit
import ApplicationServices
import BaneySpacesCore

/// What a right click did: what was posted (for the pointer audit) and its answer.
struct ContextPress {
    var posted = 0, released = 0
    var aimed: [CGPoint] = []
    var lastPostAt = Date()
    var result: Result<[String: JSONValue], HandsError> = .failure(HandsError(.engineError, "the right click didn't run", suggestion: "Try again.", retry: .safe))
}

extension HandsRouter {
    /// Whether the agent workspace is on screen now.
    func agentShown() -> Bool {
        onMain {
            guard let n = host.agentWorkspace() else { return false }
            return host.workspaceRows().first { $0.number == n }?.shown ?? false
        }
    }

    /// A right click at `point` (window-local) and its context menu, on the process queue (`ContextMenu` has the rules).
    /// `escape` posts Escape to the process with a key permit: the cancel (the engine has none for a menu, and the router
    /// never performs accessibility actions itself). The item is pressed by ref through the engine's menu surface.
    func contextPress(_ w: HandsWindow, frame: CGRect, point: CGPoint, permit: BackgroundPermit, stop: () -> HandsError?, item: String?,
                      escape: () -> Bool, check: @escaping HandsEngine.Check, cancelled: () -> Bool) -> ContextPress {
        var out = ContextPress()
        let displays = ContextMenuAX.displays()
        let screen = PointerPath.screenPoint(local: point, frame: frame)
        if let e = ContextMenu.gate(agentShown: agentShown(), window: frame, point: screen, displays: displays) { out.result = .failure(e); return out }
        let before = Set(ContextMenuAX.menus(w.pid, before: []).map(\.id))
        let post = BackgroundPoster.pointer(InputScript.rightClick(at: point), frame: frame, drag: false, gesture: BackgroundPoster.newGesture(), permit: permit, stop: stop)
        out.aimed = post.screenPoints; out.posted = post.report.posted.count; out.released = post.report.released; out.lastPostAt = Date()
        out.result = contextMenu(w, frame: frame, displays: displays, before: before, item: item, stopped: post.report.stopped, none: nil,
                                 escape: escape, check: check, cancelled: cancelled)
        return out
    }

    /// After the press (a posted right click or the engine's show-menu): find the press's menu, prove where it is, then
    /// press `item` in it or list its items and cancel it. Every path ends with no menu of this press open.
    /// `stopped`: the press was cut short. `none`: what to answer when no menu showed (the engine's refusal), else `noMenu`.
    func contextMenu(_ w: HandsWindow, frame: CGRect, displays: [CGRect], before: Set<UInt32>, item: String?, stopped: HandsError?, none: HandsError?,
                     escape: () -> Bool, check: @escaping HandsEngine.Check, cancelled: () -> Bool) -> Result<[String: JSONValue], HandsError> {
        var shown: [ContextMenu.Shown] = []
        let deadline = Date().addingTimeInterval(ContextMenu.wait)
        repeat {
            shown = ContextMenuAX.menus(w.pid, before: before)
            if !shown.isEmpty { break }
            Thread.sleep(forTimeInterval: 0.03)
        } while Date() < deadline
        func cancel() -> Bool {
            if ContextMenuAX.gone(w.pid, before: before, within: 0) { return true }
            _ = escape()
            return ContextMenuAX.gone(w.pid, before: before, within: 0.5)
        }
        if let stopped {
            if !shown.isEmpty { _ = cancel() }
            return .failure(stopped)
        }
        switch ContextMenu.verdict(shown, agentShown: agentShown(), display: ContextMenu.display(window: frame, displays: displays)) {
        case .none:
            return .failure(none ?? ContextMenu.noMenu(w.app))
        case .elsewhere:
            return .failure(ContextMenu.elsewhere(w.app, cancelled: cancel()))
        case .onAgent(let menus):
            guard let read = ContextMenuAX.items(w.pid) else { return .failure(ContextMenu.unread(w.app, cancelled: cancel())) }
            var data: [String: JSONValue] = ["menu_windows": .array(menus.map { .int(Int($0.id)) }),
                                             "items": .array(read.items.map(\.title).filter { !$0.isEmpty }.map(JSONValue.string))]
            guard let item else {
                guard cancel() else { return .failure(ContextMenu.stillOpen(w.app)) }
                data["cancelled"] = true
                return .success(data)
            }
            switch ContextMenu.choose(read.items, enabled: read.enabled, want: item) {
            case .failure(let e):
                return .failure(cancel() ? e : ContextMenu.stillOpen(w.app))
            case .success(let at):
                guard pressItem(w, title: read.items[at].title, check: check, cancelled: cancelled), ContextMenuAX.gone(w.pid, before: before, within: 0.5) else {
                    return .failure(cancel() ? ContextMenu.notPressed(w.app, item: item) : ContextMenu.stillOpen(w.app))
                }
                data["pressed"] = .string(read.items[at].title)
                return .success(data)
            }
        }
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
        ContextMenu.menus(CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? [], pid: pid, before: before)
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
