import Foundation

/// A key's modifiers, spelled as in `spec/config.md`. Shown in Apple's order: ⌃⌥⇧⌘.
public enum KeyModifier: String, CaseIterable, Comparable, Sendable {
    case ctrl, alt, shift, cmd

    public var symbol: String {
        switch self {
        case .ctrl: "⌃"
        case .alt: "⌥"
        case .shift: "⇧"
        case .cmd: "⌘"
        }
    }

    /// Carbon's modifier bits for RegisterEventHotKey.
    public var carbon: Int {
        switch self {
        case .cmd: 0x100
        case .shift: 0x200
        case .alt: 0x800
        case .ctrl: 0x1000
        }
    }

    public static func < (a: Self, b: Self) -> Bool { allCases.firstIndex(of: a)! < allCases.firstIndex(of: b)! }
}

/// Modifiers plus one key, from a spelling like `ctrl+alt+left` or `mod+shift+1`.
public struct Chord: Hashable, Sendable, CustomStringConvertible {
    public let mods: Set<KeyModifier>
    public let key: String

    public init(_ mods: Set<KeyModifier>, _ key: String) {
        self.mods = mods
        self.key = key
    }

    /// `mod` is the workspace modifier in force (Settings, or `keys.mod`).
    public static func parse(_ text: String, mod: Set<KeyModifier>) throws -> Chord {
        let parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let key = parts.last, !key.isEmpty, KeyNames.code[key] != nil else {
            throw KeymapProblem.Reason("\(parts.last.map { "\"\($0)\"" } ?? "nothing") is not a key name (see key_names in spec/keys.json)")
        }
        var mods: Set<KeyModifier> = []
        for m in parts.dropLast() {
            if m == "mod" { mods.formUnion(mod); continue }
            if m == "super" || m == "win" { throw KeymapProblem.Reason("\(m) is not a macOS modifier; use cmd, ctrl, alt or shift") }
            guard let k = KeyModifier(rawValue: m) else { throw KeymapProblem.Reason("\"\(m)\" is not a modifier (mod, cmd, ctrl, alt, shift)") }
            mods.insert(k)
        }
        // A plain key or shift+key would be taken from every app.
        guard !mods.subtracting([.shift]).isEmpty || key.hasPrefix("f") && key.count > 1 else {
            throw KeymapProblem.Reason("needs cmd, ctrl or alt, or it would take the key from every app")
        }
        return Chord(mods, key)
    }

    public var keyCode: Int { KeyNames.code[key] ?? 0 }
    public var carbonModifiers: Int { mods.reduce(0) { $0 | $1.carbon } }
    /// `⌃⌥←`, the way macOS menus show keys.
    public var symbol: String { mods.sorted().map(\.symbol).joined() + KeyNames.symbol(key) }
    /// The spelling the file uses, modifiers in a fixed order.
    public var description: String { (mods.sorted().map(\.rawValue) + [key]).joined(separator: "+") }

    /// Hold ⌘⇧Esc for two seconds: the default keys come back. No file can bind or remove it (`spec/config.md`).
    public static let recovery = Chord([.cmd, .shift], "escape")
    public static let recoveryHoldSeconds = 2.0
}

/// Key names (`spec/keys.json` `key_names`) and their macOS virtual key codes.
public enum KeyNames {
    public static let code: [String: Int] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
        "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "equal": 24, "9": 25, "7": 26,
        "minus": 27, "8": 28, "0": 29, "rightbracket": 30, "o": 31, "u": 32, "leftbracket": 33, "i": 34, "p": 35,
        "return": 36, "l": 37, "j": 38, "quote": 39, "k": 40, "semicolon": 41, "backslash": 42, "comma": 43, "slash": 44,
        "n": 45, "m": 46, "period": 47, "tab": 48, "space": 49, "grave": 50, "delete": 51, "escape": 53,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
        "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
        "left": 123, "right": 124, "down": 125, "up": 126,
    ]

    private static let symbols: [String: String] = [
        "left": "←", "right": "→", "up": "↑", "down": "↓", "return": "↩", "delete": "⌫", "forwarddelete": "⌦",
        "escape": "⎋", "tab": "⇥", "space": "Space", "grave": "`", "minus": "-", "equal": "=", "leftbracket": "[",
        "rightbracket": "]", "backslash": "\\", "semicolon": ";", "quote": "'", "comma": ",", "period": ".", "slash": "/",
        "home": "↖", "end": "↘", "pageup": "⇞", "pagedown": "⇟",
    ]

    public static func symbol(_ key: String) -> String { symbols[key] ?? key.uppercased() }
}

/// What a chord does. Spelled in the file as a short command (`switch 3`, `launcher`).
public enum KeyAction: Hashable, Sendable {
    case switchTo(Int), move(Int), launcher, search, agentFinished, overview, none

    public static func parse(_ text: String) -> KeyAction? {
        let w = text.split(separator: " ").map(String.init)
        switch (w.first, w.count) {
        case ("switch", 2): return Int(w[1]).flatMap { (1...9).contains($0) ? .switchTo($0) : nil }
        case ("move", 2): return Int(w[1]).flatMap { (1...9).contains($0) ? .move($0) : nil }
        case ("launcher", 1): return .launcher
        case ("search", 1): return .search
        case ("agent", 2) where w[1] == "finished": return .agentFinished
        case ("overview", 1): return .overview
        case ("none", 1): return KeyAction.none
        default: return nil
        }
    }

    public var spelling: String {
        switch self {
        case let .switchTo(n): "switch \(n)"
        case let .move(n): "move \(n)"
        case .launcher: "launcher"
        case .search: "search"
        case .agentFinished: "agent finished"
        case .overview: "overview"
        case .none: "none"
        }
    }

    /// What the cheat sheet and messages say it does.
    public var title: String {
        switch self {
        case let .switchTo(n): "Go to workspace \(n)"
        case let .move(n): "Send the window to workspace \(n)"
        case .launcher: "Open or close the launcher"
        case .search: "Search from any app"
        case .agentFinished: "Go to the agent that finished"
        case .overview: "Show the overview"
        case .none: "Nothing"
        }
    }

    /// Moves windows, so it waits until Polycarp has Accessibility and has started.
    public var needsStart: Bool {
        switch self {
        case .launcher, .search, .agentFinished, .none: false
        default: true
        }
    }
}

public struct KeymapProblem: Equatable, Sendable, CustomStringConvertible {
    public let line: Int?
    public let path: String
    public let reason: String

    public var description: String { (line.map { "line \($0): " } ?? "") + (path.isEmpty ? "" : path + ": ") + reason }

    struct Reason: Error { let text: String; init(_ t: String) { text = t } }
}

public struct KeyBinding: Equatable, Sendable {
    public let chord: Chord
    public let action: KeyAction
}

/// Every chord and what it does: the defaults, with `spaces.toml`'s `[keys.bindings]` laid over them.
public struct Keymap: Equatable, Sendable {
    public private(set) var bindings: [KeyBinding]

    public init(_ bindings: [KeyBinding]) { self.bindings = bindings }

    public func action(for chord: Chord) -> KeyAction? { bindings.first { $0.chord == chord }?.action }
    public func chords(for action: KeyAction) -> [Chord] { bindings.filter { $0.action == action }.map(\.chord) }

    /// The keys Polycarp ships with. `mod` is the workspace modifier (Settings > Keys, ⌘ unless changed).
    public static func defaults(mod: Set<KeyModifier>) -> Keymap {
        var b: [KeyBinding] = []
        for n in 1...9 { b.append(.init(chord: Chord(mod, "\(n)"), action: .switchTo(n))) }
        for n in 1...9 { b.append(.init(chord: Chord(mod.union([.shift]), "\(n)"), action: .move(n))) }
        b.append(.init(chord: Chord([.cmd], "space"), action: .launcher))
        b.append(.init(chord: Chord([.ctrl, .cmd], "k"), action: .search))
        b.append(.init(chord: Chord([.ctrl, .cmd], "u"), action: .agentFinished))
        return Keymap(b)
    }

    /// Lays `table` (`[keys.bindings]`) over the defaults: a chord the file names does what the file says, and `none`
    /// takes it away. A default keeps its chord unless the file reuses or unbinds that chord.
    func overlaid(_ table: TOMLTable, mod: Set<KeyModifier>, problems: inout [KeymapProblem]) -> Keymap {
        var out = bindings
        var seen: [Chord: Int] = [:]
        for e in table.entries {
            let path = "keys.bindings.\"\(e.key)\""
            do {
                let chord = try Chord.parse(e.key, mod: mod)
                if chord == .recovery { throw KeymapProblem.Reason("\(Chord.recovery.symbol) is the recovery chord and can't be bound") }
                if let first = seen[chord] { throw KeymapProblem.Reason("\(chord.symbol) is already bound on line \(first)") }
                seen[chord] = e.line
                guard let text = e.value.string else { throw KeymapProblem.Reason("the action must be a string, like \"switch 1\"") }
                guard let action = KeyAction.parse(text) else { throw KeymapProblem.Reason("\"\(text)\" is not an action (see macos_actions in spec/keys.json)") }
                out.removeAll { $0.chord == chord }
                if action != .none { out.append(.init(chord: chord, action: action)) }
            } catch let r as KeymapProblem.Reason {
                problems.append(.init(line: e.line, path: path, reason: r.text))
            } catch {}
        }
        return Keymap(out)
    }

    /// Reads `spaces.toml`'s text. A file with any problem gives no keymap, only the problems: the keys in force stay.
    public static func load(_ text: String, settingsMod: Set<KeyModifier>) -> (keymap: Keymap?, problems: [KeymapProblem]) {
        let root: TOMLTable
        do { root = try MiniTOML.parse(text) } catch let e as TOMLError {
            return (nil, [.init(line: e.line, path: "", reason: e.reason)])
        } catch { return (nil, [.init(line: nil, path: "", reason: "\(error)")]) }
        var problems: [KeymapProblem] = []
        for e in root.entries where !SpacesFile.topLevel.contains(e.key) {
            problems.append(.init(line: e.line, path: e.key, reason: "unknown table (spaces.toml holds \(SpacesFile.topLevel.joined(separator: " and ")))"))
        }
        var mod = settingsMod
        var bindings = TOMLTable()
        if let keys = root["keys"] {
            guard let keys = keys.table else { return (nil, [.init(line: root.line(of: "keys"), path: "keys", reason: "must be a table")]) }
            for e in keys.entries {
                switch e.key {
                case "mod":
                    if let m = e.value.string.flatMap(Self.modifier) { mod = m } else {
                        problems.append(.init(line: e.line, path: "keys.mod", reason: "\(e.value.shown) is not one of \"cmd\", \"ctrl\", \"alt\", \"ctrl+alt\""))
                    }
                case "bindings":
                    if let t = e.value.table { bindings = t } else { problems.append(.init(line: e.line, path: "keys.bindings", reason: "must be a table")) }
                case "modes":
                    problems.append(.init(line: e.line, path: "keys.modes", reason: "modes are not on macOS yet"))
                default:
                    problems.append(.init(line: e.line, path: "keys.\(e.key)", reason: "unknown key"))
                }
            }
        }
        let keymap = defaults(mod: mod).overlaid(bindings, mod: mod, problems: &problems)
        // Every workspace stays reachable from the keyboard.
        let missing = (1...9).filter { keymap.chords(for: .switchTo($0)).isEmpty }
        if !missing.isEmpty {
            problems.append(.init(line: root.line(of: "keys"), path: "keys.bindings",
                                  reason: "no key goes to workspace \(missing.map(String.init).joined(separator: ", ")); every workspace needs one"))
        }
        return problems.isEmpty ? (keymap, []) : (nil, problems)
    }

    /// The workspace modifier Settings stored (`modifier` in the app's defaults), ⌘ when none.
    public static func settingsMod(stored: String?) -> Set<KeyModifier> {
        switch stored {
        case "control": [.ctrl]
        case "option": [.alt]
        case "controlOption": [.ctrl, .alt]
        default: [.cmd]
        }
    }

    static func modifier(_ s: String) -> Set<KeyModifier>? {
        switch s {
        case "cmd": [.cmd]
        case "ctrl": [.ctrl]
        case "alt": [.alt]
        case "ctrl+alt": [.ctrl, .alt]
        default: nil
        }
    }
}

/// `<config>/spaces.toml`: Spaces' keys (and, later, its window rules), beside the `polycarp` command's `config.toml`.
/// A file of its own, so a key typo never costs the theme and a theme command never rewrites the keys.
public enum SpacesFile {
    public static let name = "spaces.toml"
    public static let topLevel = ["keys"]

    public static func path(env: [String: String] = ProcessInfo.processInfo.environment,
                            home: String? = FileManager.default.homeDirectoryForCurrentUser.path) -> String? {
        PolycarpThemeFile.configDir(env: { env[$0] }, home: env["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? home)
            .map { $0 + "/" + name }
    }
}

/// The keys in force, as the file changes and the recovery chord is held. A bad file never takes keys away: the last
/// keys that loaded stay (the defaults, at launch).
public struct KeymapState: Equatable, Sendable {
    public enum Source: Equatable, Sendable { case defaults, file, recovered }

    public private(set) var keymap: Keymap
    public private(set) var source: Source = .defaults
    public private(set) var problems: [KeymapProblem] = []
    private var goodText: String?
    private var settingsMod: Set<KeyModifier>

    public init(settingsMod: Set<KeyModifier>) {
        self.settingsMod = settingsMod
        keymap = .defaults(mod: settingsMod)
    }

    /// The file now reads `text` (nil: there is none). Returns what to tell the person, or nil for nothing.
    @discardableResult
    public mutating func fileChanged(_ text: String?, quiet: Bool = false) -> String? {
        guard let text else {
            let had = source == .file
            keymap = .defaults(mod: settingsMod)
            source = .defaults
            problems = []
            goodText = nil
            return had && !quiet ? "\(SpacesFile.name) is gone: default keys" : nil
        }
        let (loaded, found) = Keymap.load(text, settingsMod: settingsMod)
        problems = found
        guard let loaded else {
            let kept = source == .file ? "your last good keys stay" : "default keys stay"
            return "\(SpacesFile.name) \(found[0])" + (found.count > 1 ? " (and \(found.count - 1) more)" : "") + ". \(kept)."
        }
        keymap = loaded
        source = .file
        goodText = text
        return quiet ? nil : "Keys reloaded from \(SpacesFile.name)"
    }

    /// The recovery chord: default keys until the file changes again. The file is left as it is.
    public mutating func recover() -> String {
        keymap = .defaults(mod: settingsMod)
        source = .recovered
        goodText = nil
        return "Default keys restored. \(SpacesFile.name) is unchanged; save it again to use it."
    }

    /// Settings > Keys picked another workspace modifier.
    public mutating func settingsModChanged(_ mod: Set<KeyModifier>) {
        settingsMod = mod
        if source == .file, let goodText, let k = Keymap.load(goodText, settingsMod: mod).keymap { keymap = k } else if source != .file {
            keymap = .defaults(mod: mod)
        }
    }
}
