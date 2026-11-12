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
        /// The item is there and has no ref in this read.
        case noRef(path: [String])
        /// Never pressed: the Apple menu (the bar's first item, in any language) acts on the whole Mac.
        case appleMenu
    }

    /// The command at `path` in the menu-bar tree `tree`.
    public static func find(_ tree: JSONValue, path: [String]) -> Found {
        var node = tree
        var spelled: [String] = []
        for (level, want) in path.enumerated() {
            let items = Self.items(under: node)
            guard let at = items.firstIndex(where: { same($0["name"]?.string ?? "", want) }) else {
                return .missing(level: level, choices: titles(items))
            }
            // By position and role, not title: the first menu item of the bar is the Apple menu in every language.
            if level == 0, items[at] == firstItem(under: node) { return .appleMenu }
            let hit = items[at]
            spelled.append(hit["name"]?.string ?? want)
            node = hit
        }
        let below = items(under: node)
        if !below.isEmpty { return .submenu(path: spelled, choices: titles(below)) }
        if (node["states"]?.array ?? []).contains("disabled") { return .disabled(path: spelled) }
        guard let ref = node["ref_id"]?.string else { return .noRef(path: spelled) }
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

    /// Whether the path starts in the app menu: the bar's second menu item, named or not.
    public static func inAppMenu(_ tree: JSONValue, path: [String]) -> Bool {
        var all: [JSONValue] = []
        func walk(_ n: JSONValue) { for c in n["children"]?.array ?? [] { if c["role"]?.string == "menuitem" { all.append(c) } else { walk(c) } } }
        walk(tree)
        guard all.count > 1, let first = path.first else { return false }
        return same(all[1]["name"]?.string ?? "", first)
    }

    /// The first menu item in the bar, named or not.
    static func firstItem(under node: JSONValue) -> JSONValue? {
        for child in node["children"]?.array ?? [] {
            if child["role"]?.string == "menuitem" { return child }
            if let f = firstItem(under: child) { return f }
        }
        return nil
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
        case .noRef(let p):
            return HandsError(.engineError, "\(p.joined(separator: " > ")) is in the menu bar but has no ref in this read", suggestion: "Snapshot the window, then try the menu command again.", retry: .afterSnapshot,
                              nextCall: HandsError.call("snapshot", ["window": .int(window)]))
        case .appleMenu:
            return HandsError(.notSupported, "the Apple menu is never used: its commands (Lock Screen, Sleep, Log Out, Force Quit) act on the whole Mac, not on your window",
                              suggestion: "Use the app's own menus.", retry: .never, nextCall: .null)
        }
    }

    /// A menu command goes to the app's key window, not to a window the caller names. So it is sent only to a copy the
    /// agent's own `open` started (never Donovan's process: not lent, not under Full Access), with no other window, that
    /// window focused in the app, and the app not in front (Donovan would be using it). `front` is left out of the check
    /// before the in-use wait (which handles it) and kept in the one at the press.
    public static func refusal(app: String, window: UInt32, agentOwned: Bool, otherWindows: Int, focusedWindow: UInt32?, front: Bool) -> HandsError? {
        if !agentOwned {
            return HandsError(.needsLend, "menus work only in the agent's own copy of \(app), one your `open` started; this window belongs to Donovan's copy",
                              suggestion: "Open your own copy with `open`, then run `menu` in that window.", retry: .never, nextCall: HandsError.call("open", ["app": .string(app)]))
        }
        if front { return BackgroundRefusal.inUse(app) }
        if otherWindows > 0 {
            return HandsError(.notSupported, "\(app) has \(otherWindows) other window\(otherWindows == 1 ? "" : "s"); a menu command goes to the app's front window and could land in one of them",
                              suggestion: "Close the other window\(otherWindows == 1 ? "" : "s") of this copy of \(app) with `close`, or act on the element with click, type or set-value.", retry: .never, nextCall: .null)
        }
        if focusedWindow != window {
            return HandsError(.notSupported, "window \(window) is not \(app)'s focused window (that is \(focusedWindow.map(String.init) ?? "none")), so a menu command would go elsewhere",
                              suggestion: "Polycarp cannot focus a window without bringing it in front of Donovan, so no call fixes this. Act on the element with click, type or set-value instead.", retry: .never, nextCall: .null)
        }
        return nil
    }

    /// One item of the app menu (the bar's second item), as accessibility reports it.
    public struct AppMenuItem: Equatable, Sendable {
        public var identifier: String?, cmdChar: String?
        /// AXMenuItemCmdModifiers: 1 shift, 2 option, 4 control, 8 no command key.
        public var modifiers: Int?
        public var title: String
        public init(identifier: String? = nil, cmdChar: String? = nil, modifiers: Int? = nil, title: String) {
            self.identifier = identifier; self.cmdChar = cmdChar; self.modifiers = modifiers; self.title = title
        }
    }

    /// Quit, Hide Others and Services in the app menu: never pressed (`close` promises no app is quit; the others act on
    /// other apps). Known by identifier, then key equivalent (cmd+q, opt+cmd+h), and by title only when neither is there.
    public static func appMenuRefusal(_ item: AppMenuItem) -> HandsError? {
        let id = (item.identifier ?? "").lowercased()
        let command = item.modifiers.map { $0 & 8 == 0 } ?? false
        let key = (item.cmdChar ?? "").lowercased()
        let option = (item.modifiers ?? 0) & 2 != 0
        var what: String?
        if id.contains("terminate") || id.contains("quit") { what = "Quit" }
        else if id.contains("hideotherapplications") || id.contains("hideothers") { what = "Hide Others" }
        else if id.contains("services") { what = "Services" }
        else if command, key == "q" { what = "Quit" }
        else if command, option, key == "h" { what = "Hide Others" }
        else if item.cmdChar == nil {
            let t = item.title.lowercased()
            if t.hasPrefix("quit") { what = "Quit" } else if t == "hide others" { what = "Hide Others" } else if t == "services" { what = "Services" }
        }
        guard let what else { return nil }
        let why = what == "Quit" ? "no app is ever quit for an agent" : "it acts on other apps, not on your window"
        return HandsError(.notSupported, "\(item.title) (\(what) in the app menu) is never used: \(why)", suggestion: "Close your window with `close`.", retry: .never, nextCall: .null)
    }

    /// After the press: the windows (and sheets) of the app that are Open or Save panels, by subrole, identifier and
    /// contents (`PanelDetector`), never by the menu's title. Each is cancelled at once and never offered to the agent.
    public static func panels(_ windows: [AXNodeInfo]) -> [Int] { windows.indices.filter { PanelDetector.windowIsOffLimits(windows[$0]) } }

    public static func panelRefusal(_ app: String, cancelled: Bool) -> HandsError {
        HandsError(.notSupported, "the command opened an Open or Save panel in \(app); agents never get one, and \(cancelled ? "it was cancelled" : "it could not be cancelled, so it is still open")",
                   suggestion: "Work with files through the agent handoff folder: `open` the app with a file from it, and save to that document.", retry: .never, nextCall: .null)
    }

    /// The panel's Cancel button in an engine read: the button named as the panel's AXCancelButton says (read live, so any language).
    public static func cancelRef(_ tree: JSONValue, title: String) -> String? {
        if tree["role"]?.string == "button", tree["name"]?.string == title, let ref = tree["ref_id"]?.string { return ref }
        for c in tree["children"]?.array ?? [] { if let r = cancelRef(c, title: title) { return r } }
        return nil
    }
}
