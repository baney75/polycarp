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
    public static func same(_ a: String, _ b: String) -> Bool {
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
    /// `sessionOwns`: this session's `open` made the window (another session's copy is not yours either).
    public static func refusal(app: String, window: UInt32, agentOwned: Bool, sessionOwns: Bool, otherWindows: Int, focusedWindow: UInt32?, front: Bool) -> HandsError? {
        if !agentOwned {
            return HandsError(.needsLend, "menus work only in the agent's own copy of \(app), one your `open` started; this window belongs to Donovan's copy",
                              suggestion: "Open your own copy with `open`, then run `menu` in that window.", retry: .never, nextCall: .null)
        }
        if !sessionOwns {
            return HandsError(.notSupported, "window \(window) is not one your `open` made; menus work only in a window of your own session",
                              suggestion: "Open your own copy of \(app) with `open`, then run `menu` in that window.", retry: .never, nextCall: .null)
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

    /// One menu item as accessibility reports it; a separator has an empty title.
    public struct MenuItem: Equatable, Sendable {
        public var identifier: String?, cmdChar: String?
        /// AXMenuItemCmdModifiers: 1 shift, 2 option, 4 control, 8 no command key. Unread with a key is plain command, AppKit's default.
        public var modifiers: Int?
        public var title: String
        public var submenu: Bool
        public init(identifier: String? = nil, cmdChar: String? = nil, modifiers: Int? = nil, title: String, submenu: Bool = false) {
            self.identifier = identifier; self.cmdChar = cmdChar; self.modifiers = modifiers; self.title = title; self.submenu = submenu
        }
        var key: String { (cmdChar ?? "").lowercased() }
        var bits: Int { modifiers ?? 0 }
        var command: Bool { cmdChar != nil && bits & 8 == 0 }
        func chord(_ k: String, shift: Bool = false, option: Bool = false, control: Bool = false) -> Bool {
            command && key == k && (bits & 1 != 0) == shift && (bits & 2 != 0) == option && (bits & 4 != 0) == control
        }
        var id: String { (identifier ?? "").lowercased() }
        var name: String { title.lowercased() }
    }

    /// One accessibility read: a value, no value (the attribute is unset or unsupported), or a read that failed (a busy
    /// app times out). A failed read never counts as unset: an item with one is unknown, and unknown is refused.
    public enum Read<T: Sendable>: Sendable {
        case value(T), absent, failed
        var known: T?? { switch self { case .value(let v): return .some(v); case .absent: return .some(nil); case .failed: return nil } }
    }

    /// The item from its reads, or nil when any of them failed.
    public static func item(identifier: Read<String>, cmdChar: Read<String>, modifiers: Read<Int>, title: Read<String>, submenu: Bool?) -> MenuItem? {
        guard let submenu, let id = identifier.known, let key = cmdChar.known, let mods = modifiers.known, let t = title.known else { return nil }
        return MenuItem(identifier: id, cmdChar: key, modifiers: mods, title: t ?? "", submenu: submenu)
    }

    /// `policy`, or the refusal for a path whose items couldn't all be read (`steps` nil).
    public static func judge(_ steps: [Step]?, window: Int) -> HandsError? {
        guard let steps else {
            return HandsError(.engineError, "the menu's key equivalents couldn't be read, so Polycarp can't tell whether the command is safe",
                              suggestion: "Snapshot the window, then try the menu command again.", retry: .afterSnapshot, nextCall: HandsError.call("snapshot", ["window": .int(window)]))
        }
        return policy(steps)
    }

    /// One menu on the path: its items in order and the one the path takes. The first step is the bar itself.
    public struct Step: Equatable, Sendable {
        public var items: [MenuItem], at: Int
        public init(items: [MenuItem], at: Int) { self.items = items; self.at = at }
        var chosen: MenuItem { items[at] }
    }

    /// Commands never pressed, wherever they sit and in any language: known by the bar's position, the key equivalents
    /// macOS gives them and identifiers, with English titles only as a last resort. Checked on every level of the path
    /// before anything is pressed or listed, so a submenu's choices (Open Recent's documents) are never shown either.
    public static func policy(_ steps: [Step]) -> HandsError? {
        guard let bar = steps.first, bar.items.indices.contains(bar.at) else { return nil }
        if bar.at == 0 { return error(.appleMenu, path: [], window: 0) }
        let path = steps.map { $0.chosen.title }.joined(separator: " > ")
        guard steps.count > 1 else { return nil }
        let menu = steps[1], top = bar.chosen.name
        if bar.at == 1 {
            // The app menu: About (its first command) and Settings (cmd+,) only. The rest quit, hide or act on other apps.
            let first = menu.items.firstIndex { !$0.title.isEmpty }
            return steps.count == 2 && (menu.at == first || menu.chosen.chord(",")) ? nil : refuse(path, why: appMenu)
        }
        if isWindowMenu(menu.items, title: top) { return refuse(path, why: windows) }
        // The Help menu, the bar's last: search and help pages open Help Viewer or Tips on Donovan's screen.
        if bar.at == bar.items.lastIndex(where: { !$0.title.isEmpty }) || top == "help" || menu.items.contains(where: { $0.id == "showhelp:" }) {
            return refuse(path, why: outside)
        }
        for (k, step) in steps.enumerated().dropFirst() {
            let i = step.chosen
            if i.chord("f", control: true) || i.id.contains("fullscreen") || i.name.contains("full screen") { return refuse(path, why: windows) }
            if i.chord("\\", shift: true) || i.id.contains("taboverview") || i.name.contains("all tabs") { return refuse(path, why: windows) }
            if i.command && ["c", "x", "v"].contains(i.key) || ["cut:", "copy:"].contains(i.id) || i.id.hasPrefix("paste") { return clipboard(path) }
            if i.chord("o") || i.id.hasPrefix("opendocument") { return refuse(path, why: documents) }
            let afterOpen = step.at > 0 && step.items[step.at - 1].chord("o")
            if i.submenu && (afterOpen || i.id.contains("recent") || i.name.contains("open recent")) { return refuse(path, why: documents) }
            if k == 1, isEditMenu(menu.items, title: top), clipboardGroup(menu.items, at: menu.at) { return clipboard(path) }
            if i.cmdChar == nil, ["cut", "copy", "paste"].contains(where: { i.name.hasPrefix($0) }) { return clipboard(path) }
            if leavesTheApp(i) { return refuse(path, why: outside) }
        }
        return nil
    }

    /// Items macOS adds or that reach past the app: the Character Viewer, dictation (his microphone), speech (his speakers),
    /// AutoFill, Writing Tools, the Substitutions panel, print and page setup, Share, Import from iPhone or iPad, screenshots.
    /// By identifier and key equivalent first, English title last.
    static let systemActions: Set<String> = ["orderfrontcharacterpalette:", "startdictation:", "stopdictation:", "showhelp:", "print:", "printdocument:",
                                             "runpagelayout:", "startspeaking:", "stopspeaking:", "orderfrontsubstitutionspanel:", "showwritingtools:"]
    static let systemFragments = ["autofill", "writingtools", "dictation", "speaking", "speech", "share", "sharing", "importfromdevice", "continuitycamera", "screenshot", "screencapture"]
    static let systemTitles = ["emoji", "dictation", "autofill", "writing tools", "show substitutions", "speech", "print", "page setup", "share", "import from", "take screenshot"]
    static func leavesTheApp(_ i: MenuItem) -> Bool {
        if systemActions.contains(i.id) || systemFragments.contains(where: { i.id.contains($0) }) { return true }
        if i.chord(" ", control: true) || i.chord("p") || i.chord("p", shift: true) || (i.command && i.key == "?") { return true }
        return systemTitles.contains { i.name.hasPrefix($0) || i.name.contains(" " + $0) }
    }

    /// The Window menu: it minimizes (cmd+m), or is titled so. Every command in it moves, sizes, tiles or raises windows.
    static func isWindowMenu(_ items: [MenuItem], title: String) -> Bool {
        title == "window" || items.contains { $0.chord("m") || $0.id.contains("arrangeinfront") }
    }

    /// The Edit menu: it undoes (cmd+z) or copies (cmd+c), or is titled so.
    static func isEditMenu(_ items: [MenuItem], title: String) -> Bool {
        title == "edit" || items.contains { $0.chord("z") || $0.chord("c") }
    }

    /// The Edit menu's second group (after Undo and Redo): Cut, Copy, Paste, Paste and Match Style, Delete. Select All (cmd+a) stays.
    static func clipboardGroup(_ items: [MenuItem], at: Int) -> Bool {
        let group = items[..<at].filter { $0.title.isEmpty }.count
        return group == 1 && !items[at].chord("a")
    }

    static let appMenu = "the app menu's commands quit, hide or act on other apps (only About and Settings are used)"
    static let windows = "it moves, raises, fills or tiles windows or switches to full screen, which changes what Donovan sees"
    static let documents = "it opens documents, and an agent opens only files from the handoff folder"
    static let outside = "it opens a window outside the agent workspace or reaches Donovan's microphone, speakers, printer or other apps"

    static func refuse(_ path: String, why: String) -> HandsError {
        let suggestion = why == documents ? "`open` the app with a file from the agent handoff folder."
            : why == windows ? "Lay out agent windows with `arrange` or `move`."
            : why == outside ? "Do it in the app's own window with click, type or set-value." : "Close your window with `close`."
        return HandsError(.notSupported, "\(path) is never used: \(why)", suggestion: suggestion, retry: .never, nextCall: .null)
    }

    /// Cut, copy and paste reach the Mac's clipboard, which is Donovan's.
    static func clipboard(_ path: String) -> HandsError {
        HandsError(.notSupported, "\(path) uses the Mac's clipboard, which is Donovan's, so Polycarp doesn't send it",
                   suggestion: "Use the agent clipboard, held per session: `get` with copy, then `type` with paste. To delete a selection, press Delete.",
                   retry: .never, nextCall: .null)
    }

    /// After the press: the windows (and sheets) of the app that are Open or Save panels, by subrole, identifier and
    /// contents (`PanelDetector`), never by the menu's title. Each is cancelled at once and never offered to the agent.
    public static func panels(_ windows: [AXNodeInfo]) -> [Int] { windows.indices.filter { PanelDetector.windowIsOffLimits(windows[$0]) } }

    public static func panelRefusal(_ app: String, cancelled: Bool) -> HandsError {
        HandsError(.notSupported, "the command opened an Open or Save panel in \(app); agents never get one, and \(cancelled ? "it was cancelled" : "it could not be cancelled, so it is still open")",
                   suggestion: "Work with files through the agent handoff folder: `open` the app with a file from it, and save to that document.", retry: .never, nextCall: .null)
    }

    /// A window the window server lists. `visible`: on screen, not clear, and inside a display (a parked window is not).
    /// `workspace`: Polycarp's workspace for it, nil when it tracks none.
    public struct Listed: Equatable, Sendable {
        public var id: UInt32, pid: Int32, owner: String, visible: Bool, workspace: Int?
        public init(id: UInt32, pid: Int32, owner: String, visible: Bool, workspace: Int?) {
            self.id = id; self.pid = pid; self.owner = owner; self.visible = visible; self.workspace = workspace
        }
    }

    /// How long after the press windows are watched.
    public static let watch: TimeInterval = 1
    /// System processes a menu command can bring up: the Character Viewer, Help Viewer and Tips, dictation, printing,
    /// the share sheet, the screenshot tool. By owner name, any case.
    static let helpers = ["characterpalette", "character viewer", "helpviewer", "help viewer", "tips", "dictation", "printcenter", "print center",
                          "printer", "sharingui", "sharesheet", "share sheet", "screencapture", "screenshot"]

    /// After the press: windows that are new since `before`, visible and not on the agent workspace, of the app (once
    /// `settled`, so Polycarp has had the watch to place a new window of its own) or of a system helper (at once).
    public static func escaped(before: Set<UInt32>, now: [Listed], pid: Int32, agentWorkspace: Int?, settled: Bool) -> [Listed] {
        now.filter { w in
            guard !before.contains(w.id), w.visible, w.workspace == nil || w.workspace != agentWorkspace else { return false }
            if w.pid == pid { return settled }
            let owner = w.owner.lowercased()
            return helpers.contains { owner.contains($0) }
        }
    }

    public static func escapeRefusal(_ path: String, opened: [String], closed: Bool) -> HandsError {
        HandsError(.outsideAgentWorkspace, "\(path) opened \(opened.joined(separator: ", ")) outside the agent workspace, where Donovan would see it; \(closed ? "it was closed" : "it could not be closed, so it is still open")",
                   suggestion: "Don't use \(path) again: do it in the app's own window with click, type or set-value.", retry: .never, nextCall: .null)
    }

    /// The titles the path got through before it stopped: what `policy` judges, whatever `find` answered.
    public static func reached(_ found: Found, path: [String]) -> [String] {
        switch found {
        case .item(_, let p), .disabled(let p), .submenu(let p, _), .noRef(let p): return p
        case .missing(let level, _): return Array(path.prefix(level))
        case .appleMenu: return []
        }
    }

    /// The panel's Cancel title: what its AXCancelButton names, else a button whose identifier says cancel.
    public static func cancelTitle(_ panel: AXNodeInfo, cancelButton: String?) -> String? {
        if let cancelButton { return cancelButton }
        if panel.role == "AXButton", (panel.identifier ?? "").lowercased().contains("cancel"), let t = panel.title { return t }
        for c in panel.children { if let t = cancelTitle(c, cancelButton: nil) { return t } }
        return nil
    }

    /// The panel's Cancel button in an engine read: the button named as the panel's AXCancelButton says (read live, so any language).
    public static func cancelRef(_ tree: JSONValue, title: String) -> String? {
        if tree["role"]?.string == "button", tree["name"]?.string == title, let ref = tree["ref_id"]?.string { return ref }
        for c in tree["children"]?.array ?? [] { if let r = cancelRef(c, title: title) { return r } }
        return nil
    }
}

/// Item C layer 2: a watch that starts with the press and runs until `MenuPath.watch` after the press ended. `step`
/// looks once (settled: the watch is over, judge the app's own new windows too) and answers what it saw. It only looks:
/// what it saw is undone through the engine once the press is back, since agents never act on AX directly.
public final class MenuWatch<Found: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var started = false, ended: Date?, found: Found?
    private let done = DispatchSemaphore(value: 0)
    private let every: TimeInterval
    public init(every: TimeInterval = 0.05) { self.every = every }

    public func start(_ step: @escaping @Sendable (_ settled: Bool) -> Found?) {
        lock.lock(); started = true; lock.unlock()
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            defer { done.signal() }
            while true {
                lock.lock(); let end = ended; lock.unlock()
                let settled = end.map { Date() >= $0.addingTimeInterval(MenuPath.watch) } ?? false
                if let e = step(settled) { lock.lock(); found = e; lock.unlock(); return }
                if settled { return }
                Thread.sleep(forTimeInterval: every)
            }
        }
    }

    /// The press ended: waits out the watch and answers what it found. Nil at once when no press started.
    public func finish() -> Found? {
        lock.lock(); let was = started; if ended == nil { ended = Date() }; lock.unlock()
        guard was else { return nil }
        done.wait()
        lock.lock(); defer { lock.unlock() }
        return found
    }
}
