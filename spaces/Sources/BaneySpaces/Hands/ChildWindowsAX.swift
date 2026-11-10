import AppKit
import ApplicationServices
import BaneySpacesCore

/// Reads an accessibility element into the shape the panel check needs. Only reads. A sheet's or dialog's subtree is read
/// deeper than a window's, within a node budget; a subtree that could not be read, or ran past the budget, is marked
/// unreadable, so the panel check fails closed on it.
enum HandsAXTree {
    static let perLevel = 40
    static let budget = 1500

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

    /// A window read `depth` levels down; any sheet met on the way, or the window itself when it is a dialog, is read to
    /// `childDepth` levels.
    static func node(_ e: AXUIElement, depth: Int, childDepth: Int = 5) -> AXNodeInfo {
        var left = budget
        func read(_ el: AXUIElement, depth: Int, strict: Bool) -> AXNodeInfo {
            left -= 1
            let role = self.role(el)
            let subrole = string(el, kAXSubroleAttribute)
            let deep = strict || role == "AXSheet" || subrole == "AXSheet"
            var n = AXNodeInfo(role: role, subrole: subrole, identifier: string(el, "AXIdentifier"), title: string(el, kAXTitleAttribute),
                               value: role == "AXStaticText" ? string(el, kAXValueAttribute) : nil)
            let reach = deep && !strict ? childDepth : depth
            guard reach > 0 else { return n }
            let (kids, readable) = children(el)
            if !readable && deep { n.readable = false; return n }
            if deep && (left <= 0 || kids.count > perLevel * 4) { n.readable = false; return n }
            n.children = kids.prefix(perLevel).map { read($0, depth: reach - 1, strict: deep) }
            if deep && left <= 0 { n.readable = false }
            return n
        }
        let subrole = string(e, kAXSubroleAttribute)
        let dialog = subrole == "AXDialog" || subrole == "AXSystemDialog" || role(e) == "AXSheet"
        return read(e, depth: dialog ? childDepth : depth, strict: dialog)
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
            return ChildWindowFacts(id: id, pid: pid, app: name, bundle: bundle, processName: process, title: (t as? String) ?? "",
                                    role: r as? String, subrole: s as? String, modal: modal, parent: parent,
                                    panel: PanelDetector.windowIsOffLimits(HandsAXTree.node(el, depth: 1)))
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

    /// The process that owns a window number, from the window server.
    static func owner(_ id: UInt32) -> pid_t? { BackgroundAX.serverWindow(id)?.pid }
}
