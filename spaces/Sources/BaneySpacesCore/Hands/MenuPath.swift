import Foundation

/// Item C: a menu-bar command by its path, like "Format > Font > Bold", found in a read of the app's menu bar
/// (the engine's menubar surface: menu, then menuitem per title, then menu, then menuitem per command).
/// Pressing the found item is the ordinary click on its ref (AXPress, headless): no menu opens on screen.
public enum MenuPath {
    /// "Format > Font > Bold" as its titles. Spaces around each ">" don't matter.
    public static func parse(_ s: String) -> [String] {
        s.split(separator: ">").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    public enum Found: Equatable, Sendable {
        /// The command's ref and its titles as the app spells them.
        case item(ref: String, path: [String])
        /// No title at `level` (0 is the menu bar) matched; `choices` are the titles there.
        case missing(level: Int, choices: [String])
        /// The command is there but greyed out.
        case disabled(path: [String])
        /// The path stops at a submenu; `choices` are its commands.
        case submenu(path: [String], choices: [String])
    }

    /// The command at `path` in the menu-bar tree `tree`.
    public static func find(_ tree: JSONValue, path: [String]) -> Found {
        var node = tree
        var spelled: [String] = []
        for (level, want) in path.enumerated() {
            let items = Self.items(under: node)
            guard let hit = items.first(where: { same($0["name"]?.string ?? "", want) }) else {
                return .missing(level: level, choices: titles(items))
            }
            spelled.append(hit["name"]?.string ?? want)
            node = hit
        }
        let below = items(under: node)
        if !below.isEmpty { return .submenu(path: spelled, choices: titles(below)) }
        if (node["states"]?.array ?? []).contains("disabled") { return .disabled(path: spelled) }
        guard let ref = node["ref_id"]?.string, !path.isEmpty else { return .missing(level: max(0, path.count - 1), choices: []) }
        return .item(ref: ref, path: spelled)
    }

    /// The menu items reachable from `node` without passing another menu item: the titles of the bar, or the commands
    /// of one menu (through the menu element between them).
    static func items(under node: JSONValue) -> [JSONValue] {
        var out: [JSONValue] = []
        for child in node["children"]?.array ?? [] {
            if child["role"]?.string == "menuitem" {
                if !(child["name"]?.string ?? "").isEmpty { out.append(child) }
            } else {
                out += items(under: child)
            }
        }
        return out
    }

    /// The titles, without the Apple menu's unnamed items and separators, at most 40 (a long menu says how many more).
    static func titles(_ items: [JSONValue]) -> [String] {
        let names = items.compactMap { $0["name"]?.string }
        return names.count > 40 ? Array(names.prefix(40)) + ["(\(names.count - 40) more)"] : names
    }

    /// Any case, and "Save As…" matches "Save As..." and "Save As".
    static func same(_ a: String, _ b: String) -> Bool {
        func plain(_ s: String) -> String {
            var s = s.lowercased().replacingOccurrences(of: "\u{2026}", with: "...")
            while s.hasSuffix(".") { s.removeLast() }
            return s.trimmingCharacters(in: .whitespaces)
        }
        return plain(a) == plain(b)
    }

    /// The error for a path that didn't come out as one command. Its message lists the titles to choose from; next_call is
    /// a read or none, never another press.
    public static func error(_ found: Found, path: [String], window: Int) -> HandsError? {
        switch found {
        case .item: return nil
        case .missing(let level, let choices):
            let at = level == 0 ? "the menu bar" : path.prefix(level).joined(separator: " > ")
            let wanted = path.indices.contains(level) ? path[level] : ""
            return HandsError(.unknownRef, "no \"\(wanted)\" in \(at); there: \(choices.joined(separator: ", "))",
                              suggestion: "Pass a path of titles from the list.", retry: .safe,
                              nextCall: .null)
        case .disabled(let p):
            return HandsError(.notSupported, "\(p.joined(separator: " > ")) is greyed out now", suggestion: "Snapshot the window: the command may need a selection first.", retry: .afterSnapshot,
                              nextCall: HandsError.call("snapshot", ["window": .int(window)]))
        case .submenu(let p, let choices):
            return HandsError(.badArguments, "\(p.joined(separator: " > ")) is a submenu: \(choices.joined(separator: ", "))", suggestion: "Add one of its commands to the path.", retry: .safe,
                              nextCall: .null)
        }
    }

    /// A menu command goes to the app's key window, not to a window the caller names. So it is sent only when that
    /// can only be the agent's window: a process Polycarp started (on the agent workspace), no other window of it,
    /// that window focused in the app, and the app not in front (Donovan would be using it). Read at the press.
    public static func refusal(app: String, window: UInt32, onAgentWorkspace: Bool, agentOwned: Bool, otherWindows: Int,
                               focusedWindow: UInt32?, front: Bool) -> HandsError? {
        if onAgentWorkspace, !agentOwned {
            return HandsError(.needsLend, "this copy of \(app) is not one Polycarp started for an agent, so its menu commands are never sent",
                              suggestion: "Start your own copy with `polycarp-spaces agent open \(app)`.", retry: .never, nextCall: .null)
        }
        if front { return BackgroundRefusal.inUse(app) }
        if otherWindows > 0 {
            return HandsError(.notSupported, "\(app) has \(otherWindows) other window\(otherWindows == 1 ? "" : "s"); a menu command goes to the app's front window and could land in one of them",
                              suggestion: "Close the other window\(otherWindows == 1 ? "" : "s") of this copy of \(app), or act on the element with click, type or set-value.", retry: .never, nextCall: .null)
        }
        if focusedWindow != window {
            return HandsError(.notSupported, "window \(window) is not \(app)'s focused window (that is \(focusedWindow.map(String.init) ?? "none")), so a menu command would go elsewhere",
                              suggestion: "`click` an element in this window first so the app focuses it, then run the menu command again.", retry: .never, nextCall: .null)
        }
        return nil
    }
}
