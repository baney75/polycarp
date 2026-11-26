import Foundation

/// A key with the modifiers held for it, in config.toml's spelling: `ctrl+cmd+shift+b` (spec/config.md).
public struct Chord: Hashable, Sendable {
    public enum Mod: String, CaseIterable, Sendable {
        case ctrl, alt, shift, cmd

        /// RegisterEventHotKey's bits, and the ones macOS writes its own shortcuts with.
        var carbon: Int { switch self { case .cmd: 0x100; case .shift: 0x200; case .alt: 0x800; case .ctrl: 0x1000 } }
        var flags: Int { switch self { case .shift: 0x20000; case .ctrl: 0x40000; case .alt: 0x80000; case .cmd: 0x100000 } }
        /// The keymap's token.
        var token: String { self == .alt ? "opt" : rawValue }
    }

    public let mods: Set<Mod>
    public let key: String

    /// Nil for a key that isn't known, or one held with nothing but Shift, which types.
    public init?(_ mods: Set<Mod>, _ key: String) {
        guard Self.codes[key] != nil, !mods.subtracting([.shift]).isEmpty || Self.function.contains(key) else { return nil }
        self.mods = mods; self.key = key
    }

    /// `mod` in the text is the modifier picked in Settings.
    public init?(_ text: String, mod: Set<Mod>) {
        let parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard let key = parts.last else { return nil }
        var mods: Set<Mod> = []
        for p in parts.dropLast() {
            if p == "mod" { mods.formUnion(mod) } else if let m = Mod(rawValue: p) { mods.insert(m) } else { return nil }
        }
        self.init(mods, key)
    }

    public init?(keyCode: Int, mods: Set<Mod>) {
        guard let key = Self.codes.first(where: { $0.value == keyCode })?.key else { return nil }
        self.init(mods, key)
    }

    public var text: String { (Mod.allCases.filter(mods.contains).map(\.rawValue) + [key]).joined(separator: "+") }
    public var keyCode: Int { Self.codes[key] ?? 0 }
    public var carbon: Int { mods.reduce(0) { $0 | $1.carbon } }
    /// What the keymap and the shortcut sheet show.
    public var tokens: [String] { Mod.allCases.filter(mods.contains).map(\.token) + [Self.shown[key] ?? key.uppercased()] }
    /// As macOS writes it: ⌃⌘Return.
    public var display: String { tokens.map { KeyBinding.modifierSymbols[$0] ?? $0 }.joined() }
    /// The same with Option too: a new window. Nil when Option is in it already.
    public var withOption: Chord? { mods.contains(.alt) ? nil : Chord(mods.union([.alt]), key) }

    static let shown = ["return": "Return", "space": "Space", "tab": "Tab", "grave": "`", "slash": "/", "comma": ",", "period": ".",
                        "minus": "-", "equal": "=", "semicolon": ";", "quote": "'", "leftbracket": "[", "rightbracket": "]", "backslash": "\\"]
    static let function: Set<String> = Set((1...12).map { "f\($0)" })
    /// Key codes by position on the keyboard, as every registered shortcut is.
    static let codes: [String: Int] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "equal": 24, "9": 25, "7": 26, "minus": 27, "8": 28,
        "0": 29, "rightbracket": 30, "o": 31, "u": 32, "leftbracket": 33, "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "quote": 39,
        "k": 40, "semicolon": 41, "backslash": 42, "comma": 43, "slash": 44, "n": 45, "m": 46, "period": 47, "tab": 48, "space": 49,
        "grave": 50, "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101, "f11": 103, "f10": 109, "f12": 111, "f4": 118,
        "f2": 120, "f1": 122,
    ]
}

/// The keys that open a job's app: Polycarp's own, changed by `[keys.bindings]` lines whose action is `open <role>`.
/// Pure. A chord somebody has already is never taken from them (R-D12).
public enum RoleKeys {
    public struct Binding: Equatable, Sendable {
        public let chord: Chord
        public let role: AppRole
        public let new: Bool
        /// From your file, not Polycarp's own.
        public let yours: Bool
        /// Who has the chord already; then it is left to them and this does nothing.
        public let taken: String?
    }

    public struct Plan: Equatable, Sendable {
        public var bindings: [Binding] = []
        public var warnings: [String] = []
        public init() {}

        public var active: [Binding] { bindings.filter { $0.taken == nil } }
        /// The same without the chords macOS wouldn't give Polycarp: another app has them.
        public func leaving(_ refused: Set<Chord>) -> Plan {
            var p = self
            p.bindings = bindings.map {
                refused.contains($0.chord) && $0.taken == nil
                    ? Binding(chord: $0.chord, role: $0.role, new: $0.new, yours: $0.yours, taken: "another app") : $0
            }
            return p
        }
        public func of(_ role: AppRole, new: Bool = false) -> [Binding] { bindings.filter { $0.role == role && $0.new == new } }
    }

    /// Bound without asking. The other jobs only have a suggestion, which Settings offers.
    public static let boundByDefault: [AppRole] = [.terminal, .browser, .agent]

    public static func suggested(_ role: AppRole) -> Chord {
        let key = switch role {
        case .terminal: "return"
        case .browser: "b"
        case .agent: "a"
        case .files: "f"
        case .editor: "n"
        case .mail: "e"
        case .messages: "g"
        case .music: "m"
        case .video: "v"
        case .calendar: "c"
        case .notes: "o"
        case .passwords: "slash"
        }
        return Chord(role == .terminal ? [.ctrl, .cmd] : [.ctrl, .cmd, .shift], key)!
    }

    /// What has a chord your file gives to nothing.
    static let yoursForNothing = "you, for nothing"

    public static func action(_ role: AppRole, new: Bool) -> String { "open \(role.rawValue)" + (new ? " --new" : "") }

    /// `owner` says who else has a chord: macOS, or another Polycarp key.
    public static func plan(_ text: String, mod: Set<Chord.Mod>, owner: (Chord) -> String?) -> Plan {
        var plan = Plan(), used: [Chord: String] = [:]
        var mine: [(Chord, AppRole, Bool)] = []
        for (key, action, line) in lines(text) {
            let words = action.split(separator: " ").map(String.init)
            let opens = words.first == "open" ? try? RoleRequest.parse(Array(words.dropFirst()), cwd: "/")?.get() : nil
            guard let chord = Chord(key, mod: mod) else {
                if opens != nil { plan.warnings.append("keys.bindings.\"\(key)\" (line \(line)): no such chord; write it like ctrl+cmd+shift+b") }
                continue
            }
            if let r = opens, r.folder == nil, r.prompt == nil {
                mine.append((chord, r.role, r.new))
            } else if opens != nil {
                plan.warnings.append("keys.bindings.\"\(key)\" (line \(line)): a key opens a role with --new or nothing more")
            } else {
                // Yours for something else, or for nothing: no default takes it.
                used[chord] = action == "none" ? yoursForNothing : "your own binding, \(action)"
            }
        }
        func add(_ chord: Chord, _ role: AppRole, _ new: Bool, yours: Bool) {
            let taken = used[chord] ?? owner(chord)
            plan.bindings.append(Binding(chord: chord, role: role, new: new, yours: yours, taken: taken))
            if taken == nil { used[chord] = "Polycarp, for \(action(role, new: new))" }
        }
        for (chord, role, new) in mine { add(chord, role, new, yours: true) }
        for role in AppRole.allCases where boundByDefault.contains(role) && !mine.contains(where: { $0.1 == role && !$0.2 }) {
            add(suggested(role), role, false, yours: false)
        }
        for role in AppRole.allCases where !mine.contains(where: { $0.1 == role && $0.2 }) {
            for b in plan.of(role) where b.taken == nil { if let c = b.chord.withOption { add(c, role, true, yours: false) } }
        }
        return plan
    }

    /// Each line of `[keys.bindings]`, whatever is wrong elsewhere in the file.
    static func lines(_ text: String) -> [(key: String, action: String, line: Int)] {
        DefaultAppsFile.lines(of: "keys.bindings", in: text).compactMap { n, line in
            guard let e = (try? MiniTOML.parse(String(line)))?.entries.first, let action = e.value.string else { return nil }
            return (e.key, action.trimmingCharacters(in: .whitespaces), n)
        }
    }

    // MARK: This Mac

    /// Reads the file, this person's other Polycarp keys and macOS's shortcuts. `modifier` is the app's setting. Not for
    /// the main thread.
    public static func now(modifier: String?) -> Plan {
        let text = (try? DefaultAppsFile.text(at: DefaultAppsFile.path())) ?? ""
        let mod = self.mod(setting: modifier)
        return plan(text, mod: mod, owner: owners(mod))
    }

    /// Who else has a chord on this Mac now. Not for the main thread.
    public static func owner(modifier: String?) -> (Chord) -> String? { owners(mod(setting: modifier)) }

    private static func owners(_ mod: Set<Chord.Mod>) -> (Chord) -> String? {
        let domain = "com.apple.symbolichotkeys" as CFString
        CFPreferencesAppSynchronize(domain)
        let hotkeys = CFPreferencesCopyAppValue("AppleSymbolicHotKeys" as CFString, domain) as? [String: Any] ?? [:]
        let mine = Keymap.rows(surfaces())
        return { polycarpOwner($0, mod: mod, in: mine) ?? systemOwner($0, hotkeys: hotkeys) }
    }

    /// surfaces.json, which holds the tiling keys as this person has them; as Polycarp comes when there is none or it
    /// doesn't read, as the app does.
    static func surfaces() -> Surfaces {
        if case .document(let d) = SurfacesFile.load(path: SurfacesFile.path()) { return d.surfaces }
        return .defaults
    }

    /// `Keymap.modifierSymbol`'s setting as modifiers.
    static func mod(setting: String?) -> Set<Chord.Mod> {
        switch setting {
        case "control": [.ctrl]
        case "option": [.alt]
        case "controlOption": [.ctrl, .alt]
        default: [.cmd]
        }
    }

    // MARK: Who has a chord

    /// Polycarp's other keys that work anywhere. `table` is them as this person has them (`Keymap.rows(_ s: Surfaces)`):
    /// a tiling key moved onto a job's chord keeps it.
    public static func polycarpOwner(_ chord: Chord, mod: Set<Chord.Mod>, in table: [KeyBinding] = Keymap.all) -> String? {
        table.first { b in
            b.scope == .global && !b.id.hasPrefix(Self.rowPrefix) && chords(b.keys, mod: mod).contains(chord)
        }.map { "Polycarp, for \($0.title.prefix(1).lowercased() + $0.title.dropFirst())" }
    }

    public static let rowPrefix = "role."

    static func chords(_ tokens: [String], mod: Set<Chord.Mod>) -> [Chord] {
        var mods: Set<Chord.Mod> = []
        for t in tokens.dropLast() {
            if t == "mod" { mods.formUnion(mod) } else if let m = Chord.Mod.allCases.first(where: { $0.token == t }) { mods.insert(m) } else { return [] }
        }
        let last = tokens.last ?? ""
        let names = last == "1...9" ? (1...9).map(String.init) : [Chord.shown.first { $0.value == last }?.key ?? last.lowercased()]
        return names.compactMap { Chord(mods, $0) }
    }

    /// macOS's: the ones fixed in every app, and System Settings' keyboard shortcuts that are on, as macOS stores them.
    public static func systemOwner(_ chord: Chord, hotkeys: [String: Any]) -> String? {
        if fixed.contains(chord.text) { return "macOS" }
        let flags = chord.mods.reduce(0) { $0 | $1.flags }
        for case let entry as [String: Any] in hotkeys.values where (entry["enabled"] as? Bool) == true {
            let p = ((entry["value"] as? [String: Any])?["parameters"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.intValue }
            if p.count >= 3, p[1] == chord.keyCode, p[2] & 0x1E0000 == flags { return "macOS (System Settings > Keyboard)" }
        }
        return nil
    }

    private static let fixed: Set<String> = [
        "ctrl+cmd+space", "ctrl+cmd+q", "ctrl+cmd+f", "ctrl+cmd+d", "ctrl+shift+cmd+3", "ctrl+shift+cmd+4", "shift+cmd+3", "shift+cmd+4",
        "shift+cmd+5", "shift+cmd+q", "alt+shift+cmd+q", "alt+cmd+q", "cmd+tab", "shift+cmd+tab", "cmd+space", "alt+cmd+space", "cmd+grave",
    ]
}
