import AppKit
import ApplicationServices
import BaneySpacesCore

/// Reads an accessibility element into the shape the panel check needs. Only reads. The bounded read and its fail-closed
/// rule are `AXTreeRead` in the core: a sheet or dialog any part of which was cut off is unreadable, so it is refused.
enum HandsAXTree {
    static let perLevel = AXTreeRead.perLevel

    private static func copy(_ e: AXUIElement, _ attribute: String) -> (CFTypeRef?, AXError) {
        var out: CFTypeRef?
        let r = AXUIElementCopyAttributeValue(e, attribute as CFString, &out)
        return (r == .success ? out : nil, r)
    }

    private static func string(_ e: AXUIElement, _ attribute: String) -> String? { copy(e, attribute).0 as? String }

    static func role(_ e: AXUIElement) -> String? { string(e, kAXRoleAttribute) }

    static func children(_ e: AXUIElement) -> (list: [AXUIElement], readable: Bool) {
        let (v, r) = copy(e, kAXChildrenAttribute)
        switch r {
        case .success: return ((v as? [AXUIElement]) ?? [], true)
        case .noValue, .attributeUnsupported: return ([], true)
        default: return ([], false)
        }
    }

    /// A window read `depth` levels down; any sheet met on the way, or the window itself when it is a dialog (or `deep`
    /// says so), is read to `AXTreeRead.childDepth` levels and must be read whole.
    static func node(_ e: AXUIElement, depth: Int, deep: Bool? = nil) -> AXNodeInfo {
        AXTreeRead.node(e, depth: depth, deep: deep, string: { string($0, $1) }, children: { children($0) })
    }
}

/// The windows of one process that BaneySpaces does not place, as `ChildWindowRule` needs them: dialogs, alerts, palettes
/// (from the app's AXWindows) and sheets (children of its placed windows). Only reads, from the caller's thread; a short
/// timeout so a hung app costs a quarter second.
enum ChildWindowsAX {
    struct Reading {
        var children: [ChildWindowFacts]
        /// Placed windows that hold a sheet without a window number of its own: its elements are in that window's snapshot.
        var sheetsOn: Set<UInt32>
    }

    static func read(pid: pid_t, placed: Set<UInt32>) -> Reading {
        // A system prompt's process is never read for an agent, by any path (rule 3).
        if isSystemPrompt(pid: pid) { return Reading(children: [], sheetsOn: []) }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success, let list = raw as? [AXUIElement] else {
            return Reading(children: [], sheetsOn: [])
        }
        let running = NSRunningApplication(processIdentifier: pid)
        let name = running?.localizedName ?? "App", bundle = running?.bundleIdentifier ?? ""
        let process = running?.executableURL?.lastPathComponent ?? ""
        var out: [ChildWindowFacts] = [], seen = Set<UInt32>(), sheetsOn = Set<UInt32>()
        func facts(_ el: AXUIElement, id: UInt32, parent: UInt32?) -> ChildWindowFacts {
            AXUIElementSetMessagingTimeout(el, 0.25)
            var t: CFTypeRef?, s: CFTypeRef?, r: CFTypeRef?, m: CFTypeRef?
            AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &t)
            AXUIElementCopyAttributeValue(el, kAXSubroleAttribute as CFString, &s)
            AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &r)
            let modal = AXUIElementCopyAttributeValue(el, kAXModalAttribute as CFString, &m) == .success ? (m as? Bool) : nil
            // A sheet, dialog or alert (modal ones included) is read whole or refused.
            let kind = ChildWindowRule.kind(role: r as? String, subrole: s as? String, modal: modal)
            let deep = kind == .sheet || kind == .dialog || kind == .alert
            return ChildWindowFacts(id: id, pid: pid, app: name, bundle: bundle, processName: process, title: (t as? String) ?? "",
                                    role: r as? String, subrole: s as? String, modal: modal, parent: parent,
                                    panel: PanelDetector.windowIsOffLimits(HandsAXTree.node(el, depth: 1, deep: deep ? true : nil)))
        }
        for el in list.prefix(64) {
            guard let id = BackgroundAX.windowID(of: el) else { continue }
            if placed.contains(id) {
                for c in HandsAXTree.children(el).list.prefix(HandsAXTree.perLevel) where HandsAXTree.role(c) == "AXSheet" {
                    if let sid = BackgroundAX.windowID(of: c), sid != id {
                        if seen.insert(sid).inserted { out.append(facts(c, id: sid, parent: id)) }
                    } else {
                        sheetsOn.insert(id)
                    }
                }
                continue
            }
            if seen.insert(id).inserted { out.append(facts(el, id: id, parent: nil)) }
        }
        return Reading(children: out, sheetsOn: sheetsOn)
    }

    /// The process that owns a window number, and its name, from the window server.
    static func owner(_ id: UInt32) -> (pid: pid_t, name: String)? {
        guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for w in list where (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id {
            guard let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { return nil }
            return (pid, w[kCGWindowOwnerName as String] as? String ?? "")
        }
        return nil
    }

    /// Whether `pid` shows macOS's authentication, password, keychain or permission prompts, by its bundle id, its
    /// executable or the window server's owner name. Read without touching accessibility.
    static func isSystemPrompt(pid: pid_t, serverName: String = "") -> Bool {
        let running = NSRunningApplication(processIdentifier: pid)
        let bundle = running?.bundleIdentifier ?? "", process = running?.executableURL?.lastPathComponent ?? ""
        return ChildWindowRule.isSystemPrompt(bundle: bundle, processName: process)
            || (!serverName.isEmpty && ChildWindowRule.isSystemPrompt(bundle: "", processName: serverName))
    }
}
