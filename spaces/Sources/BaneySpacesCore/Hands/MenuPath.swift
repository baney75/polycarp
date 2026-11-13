import CoreGraphics
import Darwin
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
    /// `background`: the app isn't active. macOS enables a window's commands only in the active app, whose window is key,
    /// and Polycarp never brings an agent's copy forward, so a greyed command there stays greyed: no retry, no hint that a
    /// selection would help. Measured on 952839c: Select All, Duplicate and Make Rich Text read disabled in such a copy, an
    /// AXPress on them did nothing, and setting AXMain or AXFocused changed neither.
    public static func error(_ found: Found, path: [String], window: Int, background: Bool = false, app: String = "the app") -> HandsError? {
        switch found {
        case .item: return nil
        case .missing(let level, let choices):
            let at = level == 0 ? "the menu bar" : path.prefix(level).joined(separator: " > ")
            let wanted = path.indices.contains(level) ? path[level] : ""
            return HandsError(.unknownRef, "no \"\(wanted)\" in \(at); there: \(choices.joined(separator: ", "))",
                              suggestion: "Pass a path of titles from the list.", retry: .safe,
                              nextCall: .null)
        case .disabled(let p) where background:
            return HandsError(.notSupported, "\(p.joined(separator: " > ")) is greyed out because \(app) is in the background: macOS enables a window's commands only in the app in front, and Polycarp never brings an agent's copy forward",
                              suggestion: "Retrying won't change it. Do it on the element instead: click, type, set-value, select or toggle by ref.", retry: .never, nextCall: .null)
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
    /// `panels`: the app's Open or Save panel windows. A modal one is the focused window while it is up, and it is cancelled
    /// before the press, so focus on it counts as focus on `window`; the check at the press decides again (246 r1 first-F2).
    public static func refusal(app: String, window: UInt32, agentOwned: Bool, sessionOwns: Bool, otherWindows: Int, focusedWindow: UInt32?, panels: Set<UInt32> = [], front: Bool) -> HandsError? {
        let focusedWindow = focusedWindow.map { panels.contains($0) ? window : $0 }
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

    /// A read from its AXError code: unset, unsupported or not implemented by the app is no value; any other failure (a
    /// busy app's cannotComplete) is unknown (192 r1 second-F10). Codes: success 0, illegalArgument -25201,
    /// attributeUnsupported -25205, notImplemented -25208, noValue -25212.
    public static func read<T: Sendable>(code: Int32, value: T?) -> Read<T> {
        switch code {
        case 0: return value.map { .value($0) } ?? .absent
        case -25201, -25205, -25208, -25212: return .absent
        default: return .failed
        }
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
        /// The chosen submenu's items when the path stops at it (a listing), read like any other step.
        public var opens: [MenuItem]?
        public init(items: [MenuItem], at: Int, opens: [MenuItem]? = nil) { self.items = items; self.at = at; self.opens = opens }
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
            let afterOpen = step.at > 0 && step.items[step.at - 1].chord("o")
            if i.submenu && afterOpen { return refuse(path, why: documents) }
            if k == 1, isEditMenu(menu.items, title: top), clipboardGroup(menu.items, at: menu.at) { return clipboard(path) }
            if k == 1, isEditMenu(menu.items, title: top), appended(menu.items, at: menu.at, inside: steps.dropFirst(2).first?.items ?? menu.opens) { return refuse(path, why: outside) }
            if let e = itemRule(i, path: path) { return e }
        }
        return nil
    }

    /// The rules one item answers to by itself, wherever it sits: the menu bar's and a context menu's (`ContextMenu`).
    static func itemRule(_ i: MenuItem, path: String) -> HandsError? {
        if i.chord("f", control: true) || i.id.contains("fullscreen") || i.name.contains("full screen") { return refuse(path, why: windows) }
        if i.chord("\\", shift: true) || i.id.contains("taboverview") || i.name.contains("all tabs") { return refuse(path, why: windows) }
        if i.command && ["c", "x", "v"].contains(i.key) || ["cut:", "copy:"].contains(i.id) || i.id.hasPrefix("paste") { return clipboard(path) }
        if i.chord("o") || i.id.hasPrefix("opendocument") { return refuse(path, why: documents) }
        // 197 r1 second-S3: the Versions browser takes the screen; Move To and Rename move the document out of the handoff folder.
        if i.id == "browsedocumentversions:" || i.name.hasPrefix("browse all versions") { return refuse(path, why: windows) }
        if ["movedocument:", "renamedocument:"].contains(i.id) { return refuse(path, why: documents) }
        // 197 r1 first-F3: Use Selection for Find (cmd+e) puts the selection on the find text every app shares. Only this
        // way in is closed: a search typed into a find bar writes it too (205 r1 first-F3).
        if i.chord("e") || i.id.contains("selectionforfind") || i.name.hasPrefix("use selection for find") { return refuse(path, why: findText) }
        if i.submenu && (i.id.contains("recent") || i.name.contains("open recent")) { return refuse(path, why: documents) }
        if i.cmdChar == nil, ["cut", "copy", "paste"].contains(where: { i.name.hasPrefix($0) }) { return clipboard(path) }
        if leavesTheApp(i) { return refuse(path, why: outside) }
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

    /// AppKit's own Edit items (AutoFill, Start Dictation, Writing Tools, Emoji & Symbols) are appended after the app's,
    /// in any language and with or without an identifier (192 r1 first-F3). So past Select All's group (cmd+a or
    /// selectAll:, from the first separator after it), an item is used only when the app gave it a command key
    /// equivalent, or it is a submenu one of whose items has one (Find, Spelling and Grammar). Identifiers don't count:
    /// AppKit's items carry them too. With no Select All, the rule has nothing to anchor on and other rules decide.
    /// `inside`: the submenu's items, from the next step or, when the path stops at it, from the listing (197 r1 second-S4).
    static func appended(_ items: [MenuItem], at: Int, inside: [MenuItem]?) -> Bool {
        guard let all = items.firstIndex(where: { $0.chord("a") || $0.id == "selectall:" }),
              let tail = items[all...].firstIndex(where: { $0.title.isEmpty }), at > tail else { return false }
        let i = items[at]
        if i.command { return false }
        guard i.submenu, let inside else { return true }
        return !inside.contains { $0.command }
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
    static let findText = "Use Selection for Find puts the selection on the find text every app shares"

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

    /// The panel to cancel: a sheet before the window that holds it, since the window's read holds the sheet too and has
    /// no Cancel button of its own (192 r1 second-F7).
    /// `old`: per window, it was a panel before the press, so it is not the command's (197 r1 second-S1).
    public static func panel(_ windows: [AXNodeInfo], old: [Bool] = []) -> Int? {
        let found = panels(windows).filter { !(old.indices.contains($0) && old[$0]) }
        return found.first { !holdsPanel(windows[$0]) } ?? found.first
    }

    static func holdsPanel(_ n: AXNodeInfo) -> Bool { n.children.contains { ($0.role == "AXSheet" && PanelDetector.windowIsOffLimits($0)) || holdsPanel($0) } }

    /// The window numbers of panels that are windows of their own. A sheet carries its parent's number, and a window is
    /// off limits too while it holds a panel sheet, so neither counts: that window is the document's (217 r1 first-F2).
    public static func panelWindows(_ windows: [AXNodeInfo], sheet: [Bool], ids: [UInt32?]) -> Set<UInt32> {
        Set(panels(windows).filter { !sheet[$0] && !holdsPanel(windows[$0]) }.compactMap { ids[$0] })
    }

    /// Undo's order: the panel first, since a window holding a sheet can't close while the sheet runs, then the tied windows,
    /// tried again for a moment while a cancelled sheet is still going away (246 r1 first-F1).
    public static func undoing(panel: Bool, cancel: () -> HandsError?, close: () -> Bool, tries: Int = 5, pause: () -> Void = {}) -> (panel: HandsError?, closed: Bool) {
        let error = panel ? cancel() : nil
        let tries = panel ? max(1, tries) : 1
        for n in 1...tries {
            if close() { return (error, true) }
            if n < tries { pause() }
        }
        return (error, false)
    }

    /// The app's other windows, for `refusal`: a panel window is cancelled before the press, so it isn't one (217 r1 first-F3).
    public static func otherWindows(_ mapped: [(id: UInt32, minimized: Bool)], unmapped: Int, window: UInt32, panels: Set<UInt32>) -> Int {
        mapped.filter { $0.id != window && !$0.minimized && !panels.contains($0.id) }.count + unmapped
    }

    /// A path that stops at a submenu of the Edit menu (Edit > Find) has that submenu listed, for `appended`, its only
    /// reader. Any other submenu is not read (217 r1 first-F4).
    public static func listsOpens(_ steps: [Step]) -> Bool {
        steps.count == 2 && steps[1].items.indices.contains(steps[1].at) && steps[1].chosen.submenu && isEditMenu(steps[1].items, title: steps[0].chosen.name)
    }

    /// A panel left up by an earlier command, cancelled one at a time just before the press (`cancelOne`: nil when none
    /// is left, else whether the cancel went through). A cancel that fails stops the call (217 r1 first-F1), but only
    /// once a new read after a pause still finds a panel it can't cancel: a sheet cancelled a moment ago is still read
    /// while it goes away, and its window counts in `count` too (246 r1 first-F3). A panel gone by the retry, after a cancel
    /// that answered false, was cancelled: Polycarp's Cancel was pressed, and the bar is read again (258 r1 second-S1).
    public enum Earlier: Equatable, Sendable { case none, cancelled, stuck(afterCancelling: Bool) }
    /// `retry`: whether another try can help. Not after a check failed under the cancel or the call ran out (258 r1 first-F3).
    public static func cancelEarlier(count: Int, tries: Int = 3, pause: () -> Void = {}, retry: () -> Bool = { true }, cancelOne: () -> Bool?) -> Earlier {
        // `tried`: a cancel ran. Its read of the panel replaced the evidence store's, so the bar must be read again before the
        // press even when the panel is gone by the retry (258 r1 second-S1).
        var done = false, tried = false
        for _ in 0..<count {
            var r = cancelOne()
            if r != nil { tried = true }
            for _ in 1..<max(1, tries) where r == false && retry() { pause(); r = cancelOne() }
            switch r {
            case nil: return done || tried ? .cancelled : .none
            case false?: return .stuck(afterCancelling: done)
            case true?: done = true
            }
        }
        return done ? .cancelled : .none
    }
    public static func earlierStuck(_ app: String, afterCancelling: Bool = false) -> HandsError {
        let first = afterCancelling ? "; one before it was cancelled" : ""
        return HandsError(.notSupported, "an Open or Save panel was already up in \(app) and couldn't be cancelled, so nothing was pressed\(first)",
                          suggestion: "Close your window with `close`, then `open` the app again.", retry: .never, nextCall: .null)
    }
    /// A stuck cancel's answer. `engine`: why the cancel's own engine call failed. A check that failed under it (the window
    /// left scope, the app is in use, the call ran out of time) is that call's answer, with its own code and next call,
    /// not a panel that won't cancel (246 r1 second-S2).
    public static func earlierError(_ app: String, afterCancelling: Bool, engine: HandsError?) -> HandsError {
        if let engine, checkFailures.union([.windowNotFound]).contains(engine.code) { return engine }
        return earlierStuck(app, afterCancelling: afterCancelling)
    }
    /// A check that failed under a cancel: trying the same cancel again fails the same way. A window not found is the
    /// panel going away, which a retry can see through.
    static let checkFailures: Set<HandsErrorCode> = [.outsideAgentWorkspace, .agentWorkspaceOff, .needsLend, .needsSandbox, .inUse, .timeout, .notRunning, .permissionDenied]
    public static func retries(after e: HandsError?, cancelled: Bool) -> Bool { !cancelled && !(e.map { checkFailures.contains($0.code) } ?? false) }
    public static let earlierNote = "; an Open or Save panel left by an earlier command was cancelled first"

    /// `gone`: the panel was seen, but closed before Polycarp could cancel it (192 r1 first-F4).
    public static func panelRefusal(_ app: String, cancelled: Bool, gone: Bool = false) -> HandsError {
        let after = gone ? "it closed before Polycarp cancelled it" : cancelled ? "it was cancelled" : "it could not be cancelled, so it is still open"
        return HandsError(.notSupported, "the command opened an Open or Save panel in \(app); agents never get one, and \(after)",
                   suggestion: "Work with files through the agent handoff folder: `open` the app with a file from it, and save to that document.", retry: .never, nextCall: .null)
    }

    /// A window the window server lists. `visible`: on screen, not clear, and inside a display (a parked window is not).
    /// `workspace`: Polycarp's workspace for it, nil when it tracks none. `bundle` and `parent` (its process's bundle id
    /// and parent pid) are filled in for new windows only.
    public struct Listed: Equatable, Sendable {
        public var id: UInt32, pid: Int32, owner: String, visible: Bool, workspace: Int?
        public var bounds: CGRect, bundle: String?, parent: Int32?
        public init(id: UInt32, pid: Int32, owner: String, visible: Bool, workspace: Int?, bounds: CGRect = .zero, bundle: String? = nil, parent: Int32? = nil) {
            self.id = id; self.pid = pid; self.owner = owner; self.visible = visible; self.workspace = workspace
            self.bounds = bounds; self.bundle = bundle; self.parent = parent
        }
    }

    /// What the watch saw over all its looks: a new panel, and new windows outside the agent workspace.
    public struct Seen: Equatable, Sendable {
        public var panel: Bool, escapes: [Escape]
        public init(panel: Bool = false, escapes: [Escape] = []) { self.panel = panel; self.escapes = escapes }
        /// Every look as one: a panel in any, each window once, tied only when every look that saw it tied it
        /// (197 r1 first-F2: the first sighting no longer ends the watch).
        /// The escapes whose windows the window server still lists, and those that closed on their own since (205 r1 second-S2).
        public func split(listed: Set<UInt32>) -> (open: [Escape], gone: [Escape]) {
            (escapes.filter { listed.contains($0.window.id) }, escapes.filter { !listed.contains($0.window.id) })
        }
        /// On every window the window server still lists, seen or not: one Polycarp tracks still exists ordered out, parked
        /// off the displays or minimized, so it is closed (246 r1 second-S1). One it doesn't track closes only by its own
        /// close button, which `host.close` can't reach, so hidden it is gone, not "still open" (258 r1 first-F1).
        public func split(_ all: [Listed]) -> (open: [Escape], gone: [Escape]) { split(listed: Set(all.filter { $0.visible || $0.workspace != nil }.map(\.id))) }
        public static func merged(_ looks: [Seen]) -> Seen {
            var out = Seen()
            for l in looks {
                out.panel = out.panel || l.panel
                for e in l.escapes {
                    if let i = out.escapes.firstIndex(where: { $0.window.id == e.window.id }) { out.escapes[i].tied = out.escapes[i].tied && e.tied } else { out.escapes.append(e) }
                }
            }
            return out
        }
    }

    /// Whether input from Donovan may have opened a helper's window: input since a watch's length before the press, since
    /// a helper takes a moment to put its window up after his keystroke or click (197 r1 first-F1).
    public static func userInput(idle: TimeInterval, sincePress: TimeInterval) -> Bool { idle < sincePress + watch }

    /// The bundle id of the app, XPC service or extension a process runs from, read from its executable's path: an XPC
    /// service isn't an app LaunchServices knows, so NSRunningApplication has none for it (197 r1 second-S2).
    public static func processBundle(pid: Int32) -> String? {
        var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buf, UInt32(buf.count)) > 0, let path = bundlePath(executable: String(cString: buf)) else { return nil }
        return Bundle(path: path)?.bundleIdentifier
    }

    /// The innermost .app, .xpc or .appex that holds `executable`.
    public static func bundlePath(executable: String) -> String? {
        let parts = executable.split(separator: "/", omittingEmptySubsequences: false)
        guard let i = parts.lastIndex(where: { [".app", ".xpc", ".appex"].contains(where: $0.hasSuffix) }) else { return nil }
        return parts[...i].joined(separator: "/")
    }

    /// A new window after the press. `tied`: the press provably raised it, so Polycarp may close it.
    public struct Escape: Equatable, Sendable {
        public var window: Listed, tied: Bool
        public init(_ window: Listed, tied: Bool) { self.window = window; self.tied = tied }
    }

    /// How long after the press windows are watched.
    public static let watch: TimeInterval = 1
    /// System processes a menu command can bring up, by exact bundle id (read from each app's Info.plist on macOS 27):
    /// the Character Viewer, Tips (Help Viewer's id), the screenshot UI and Screenshot, dictation, Writing Tools, the
    /// share sheet, Passwords (AutoFill), adding a printer and the print queue (PrinterProxy, not checked on disk).
    /// Passwords' id is split and last, so GitGuardian's generic password detector finds no value after it.
    static let helperBundles: Set<String> = ["com.apple.CharacterPaletteIM", "com.apple.helpviewer", "com.apple.screencaptureui", "com.apple.screenshot.launcher",
                                             "com.apple.inputmethod.ironwood", "com.apple.WritingTools.xpc.WritingToolsViewService", "com.apple.sharing.ShareSheetUI",
                                             "com.apple.print.add", "com.apple.print.PrinterProxy", "com.apple." + "Passwords"]

    /// After the press: windows new since `before`, visible and not on the agent workspace, that may be the press's
    /// (192 r1 first-F2, second-F8):
    /// - The app's own, once `settled` (Polycarp has had the watch to place it): tied. One untracked and lying on
    ///   `parent` (the target window's frame) is a sheet or alert on the agent's window, not an escape.
    /// - Another process's: tied when its parent is the app; a helper bundle's is tied only when no input from
    ///   Donovan came in the watch (`userInput`), else it is reported untied: he may have opened it himself.
    /// Any other process's window is his and is never listed.
    public static func escaped(before: Set<UInt32>, now: [Listed], pid: Int32, agentWorkspace: Int?, settled: Bool, parent: CGRect?, userInput: Bool) -> [Escape] {
        now.compactMap { w in
            guard !before.contains(w.id), w.visible, w.workspace == nil || w.workspace != agentWorkspace else { return nil }
            if w.pid == pid {
                if w.workspace == nil, let parent, onTop(w.bounds, of: parent) { return nil }
                return settled ? Escape(w, tied: true) : nil
            }
            if w.parent == pid { return Escape(w, tied: true) }
            guard let b = w.bundle, helperBundles.contains(b) else { return nil }
            return Escape(w, tied: !userInput)
        }
    }

    /// Most of `w` lies on `parent`, as a sheet or an alert does on its window.
    static func onTop(_ w: CGRect, of parent: CGRect) -> Bool {
        let cut = w.intersection(parent)
        return !cut.isNull && w.width > 0 && w.height > 0 && cut.width * cut.height >= 0.5 * w.width * w.height
    }

    /// `closed`: every tied window was closed (Polycarp closes only windows it tracks). Untied windows are never closed.
    /// `gone`: windows a look saw that closed on their own before the undo (205 r1 second-S2).
    public static func escapeRefusal(_ path: String, found: [Escape], gone: [Escape] = [], closed: Bool, window: Int) -> HandsError {
        func names(_ l: [Escape]) -> String { l.map { "a window of \($0.window.owner)" }.joined(separator: ", ") }
        let tied = found.filter(\.tied), went = gone.filter(\.tied), untied = (found + gone).filter { !$0.tied }
        let other = untied.isEmpty ? "" : "; \(names(untied)) also appeared, which Polycarp couldn't tie to the command (Donovan may have opened it), so it was left alone"
        let closedItself = went.isEmpty ? "" : "\(tied.isEmpty ? "" : "; ")\(names(went)) closed again on its own"
        guard tied.isEmpty && went.isEmpty else {
            let state = tied.isEmpty ? "" : closed ? "it was closed" : "Polycarp couldn't close it, so it is still open"
            return HandsError(.outsideAgentWorkspace, "\(path) opened \(names(tied + went)) outside the agent workspace, where Donovan would see it; \(state)\(closedItself)\(other)",
                              suggestion: "Don't use \(path) again: do it in the app's own window with click, type or set-value.", retry: .never, nextCall: .null)
        }
        return HandsError(.outsideAgentWorkspace, "while \(path) ran, \(names(untied)) appeared outside the agent workspace; Polycarp couldn't tie it to the command (Donovan may have opened it), so it closed nothing",
                          suggestion: "Snapshot the window to see whether the command did what you wanted.", retry: .afterSnapshot, nextCall: HandsError.call("snapshot", ["window": .int(window)]))
    }

    /// New windows a person could see, other than the app's own Open and Save panels (`panels`, by window number), which
    /// the watch cancels as panels (205 r1 second-S1).
    public static func fresh(_ all: [Listed], before: Set<UInt32>, panels: Set<UInt32>) -> [Listed] {
        all.filter { !before.contains($0.id) && $0.visible && !panels.contains($0.id) }
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

extension MenuWatch.Outcome: Equatable where Found: Equatable {}

/// Item C layer 2: a watch that starts with the press and runs until `MenuPath.watch` after the press ended. `step`
/// looks once (settled: the watch is over, judge the app's own new windows too) and answers what it saw. It only looks:
/// what it saw is undone through the engine once the press is back, since agents never act on AX directly.
public final class MenuWatch<Found: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var started = false, ended: Date?, found: [Found] = []
    private let done = DispatchSemaphore(value: 0)
    private let every: TimeInterval, watch: TimeInterval, margin: TimeInterval
    /// `margin`: how long past the watch `finish` waits for a look that hangs (a hung app), before it answers unknown.
    public init(every: TimeInterval = 0.05, watch: TimeInterval = MenuPath.watch, margin: TimeInterval = 2) {
        self.every = every; self.watch = watch; self.margin = margin
    }

    /// Nothing seen, what every look saw, or unknown: the watch didn't finish in time (192 r1 first-F1).
    public enum Outcome { case quiet, seen([Found]), unknown }

    public func start(_ step: @escaping @Sendable (_ settled: Bool) -> Found?) {
        lock.lock(); started = true; lock.unlock()
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            defer { done.signal() }
            while true {
                lock.lock(); let end = ended; lock.unlock()
                let settled = end.map { Date() >= $0.addingTimeInterval(watch) } ?? false
                // Every look runs to the end of the watch: a later one may see a panel or window an earlier one didn't (197 r1 first-F2).
                if let e = step(settled) { lock.lock(); found.append(e); lock.unlock() }
                if settled { return }
                Thread.sleep(forTimeInterval: every)
            }
        }
    }

    /// The press ended: waits out the watch, at most `watch` plus `margin`, and answers what it found. Quiet at once
    /// when no press started.
    public func finish() -> Outcome {
        lock.lock(); let was = started; if ended == nil { ended = Date() }; lock.unlock()
        guard was else { return .quiet }
        let timedOut = done.wait(timeout: .now() + watch + margin) == .timedOut
        lock.lock(); defer { lock.unlock() }
        if !found.isEmpty { return .seen(found) }
        return timedOut ? .unknown : .quiet
    }

    /// The call's error when the watch couldn't finish: the command may have opened something, so it never answers ok.
    public static func unknownRefusal(_ path: String, window: Int) -> HandsError {
        HandsError(.engineError, "\(path) was sent, but the app didn't answer in time for Polycarp to check what it opened",
                   suggestion: "Snapshot the window to see what the command did before anything else.", retry: .afterSnapshot, nextCall: HandsError.call("snapshot", ["window": .int(window)]))
    }
}
