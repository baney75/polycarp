import Foundation

/// A global shortcut a person can choose, written as `ctrl+opt+T`: modifiers, then one key, joined with `+`.
public struct KeyChord: Hashable, Sendable {
    public enum Modifier: String, CaseIterable, Sendable {
        case ctrl, opt, shift, cmd
        static let other = ["control": Modifier.ctrl, "option": .opt, "alt": .opt, "command": .cmd]
    }

    public let modifiers: Set<Modifier>
    /// The key as this file writes it: `T`, `F5`, `Left`, `Return`, `]`.
    public let key: String

    /// Every key a chord takes, with its virtual key code (the ANSI layout's, as every shortcut of Polycarp's).
    public static let keyCodes: [String: Int] = {
        var m = ["A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
                 "Y": 16, "T": 17, "O": 31, "U": 32, "I": 34, "P": 35, "L": 37, "J": 38, "K": 40, "N": 45, "M": 46, "0": 29,
                 "=": 24, "-": 27, "]": 30, "[": 33, "'": 39, ";": 41, "\\": 42, ",": 43, "/": 44, ".": 47, "`": 50,
                 "Return": 36, "Tab": 48, "Space": 49, "Delete": 51, "Home": 115, "PageUp": 116, "End": 119, "PageDown": 121,
                 "Left": 123, "Right": 124, "Down": 125, "Up": 126]
        for (i, code) in [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90].enumerated() { m["F\(i + 1)"] = code }
        return m
    }()

    public var keyCode: Int { Self.keyCodes[key]! }

    /// Keys that are Polycarp's own whatever the settings say.
    static let own: [KeyChord: String] = [
        KeyChord([.ctrl, .cmd], "K"): "opens the launcher", KeyChord([.ctrl, .cmd], "U"): "goes to the agent that finished",
    ]

    private init(_ modifiers: Set<Modifier>, _ key: String) { self.modifiers = modifiers; self.key = key }

    public struct Problem: Error, Equatable { public let message: String }

    /// Reads a chord, or says what is wrong with it.
    public static func read(_ text: String) -> Result<KeyChord, Problem> {
        func no(_ why: String) -> Result<KeyChord, Problem> { .failure(Problem(message: why)) }
        let parts = text.split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let last = parts.last, !last.isEmpty else { return no("\"\(text)\" has no key; write one as ctrl+opt+T") }
        var mods = Set<Modifier>()
        for p in parts.dropLast() {
            guard let m = Modifier(rawValue: p.lowercased()) ?? Modifier.other[p.lowercased()] else {
                return no("\"\(p)\" is not a modifier; use ctrl, opt, shift or cmd")
            }
            guard mods.insert(m).inserted else { return no("\"\(text)\" names \(m.rawValue) twice") }
        }
        if let n = Int(last), (1...9).contains(n) { return no("1 to 9 are the workspaces'") }
        guard let key = keyCodes.keys.first(where: { $0.lowercased() == last.lowercased() }) else {
            return no("\"\(last)\" is not a key a shortcut takes; use a letter, F1 to F20, an arrow (Left, Right, Up, Down), Return, Space, Tab, Delete, Home, End, PageUp, PageDown or one of 0 - = [ ] ; ' , . / \\ `")
        }
        let chord = KeyChord(mods, key)
        // The rest are the front app's (Command-Shift-P, F5) or type a character (Option-Shift-E).
        guard mods.count >= 2, mods.contains(.ctrl) || mods.isSuperset(of: [.cmd, .opt]) else {
            return no("\"\(text)\" needs ctrl and another modifier, or cmd and opt, so it takes no key from the app in front")
        }
        if let use = own[chord] { return no("\(chord.symbols) already \(use)") }
        return .success(chord)
    }

    /// The chord a key press is, or what is wrong with it as one.
    public static func read(keyCode: Int, ctrl: Bool, opt: Bool, shift: Bool, cmd: Bool) -> Result<KeyChord, Problem> {
        guard let key = keyCodes.first(where: { $0.value == keyCode })?.key ?? (digits.firstIndex(of: keyCode).map { String($0 + 1) }) else {
            return .failure(Problem(message: "that key can't be a shortcut"))
        }
        var parts: [String] = []
        if ctrl { parts.append("ctrl") }
        if opt { parts.append("opt") }
        if shift { parts.append("shift") }
        if cmd { parts.append("cmd") }
        return read((parts + [key]).joined(separator: "+"))
    }

    /// The key codes of 1 to 9, which are the workspaces'.
    private static let digits = [18, 19, 20, 21, 23, 22, 26, 28, 25]

    public init?(_ text: String) {
        guard case .success(let c) = Self.read(text) else { return nil }
        self = c
    }

    /// How settings store it, one spelling for each chord.
    public var text: String { (Modifier.allCases.filter(modifiers.contains).map(\.rawValue) + [key]).joined(separator: "+") }

    /// The parts a `KeyBinding` shows.
    public var parts: [String] {
        Modifier.allCases.filter(modifiers.contains).map(\.rawValue) + [["Left": "\u{2190}", "Right": "\u{2192}", "Up": "\u{2191}", "Down": "\u{2193}"][key] ?? key]
    }

    /// As macOS writes it: "⌃⌥T".
    public var symbols: String { parts.map { KeyBinding.modifierSymbols[$0] ?? $0 }.joined() }
}

public extension KeyChord {
    /// The modifiers as Carbon's hotkeys take them.
    var carbon: Int { modifiers.reduce(0) { $0 | [.cmd: 0x100, .shift: 0x200, .opt: 0x800, .ctrl: 0x1000][$1]! } }
}

/// Every tiling command a key can have, with the key it has until a person picks another ("" is none).
public enum TilingKeys {
    public static let all: [(name: String, title: String, key: String)] = {
        var rows: [(name: String, title: String, key: String)] = []
        func add(_ name: String, _ title: String, _ key: String) { rows.append((name: name, title: title, key: key)) }
        let sides: [(name: String, phrase: String, key: String)] = [
            ("left", "to the left", "Left"), ("right", "to the right", "Right"), ("up", "above", "Up"), ("down", "below", "Down"),
        ]
        add("toggle", "Tile this workspace, or stop", "ctrl+opt+T")
        for d in sides { add("focus-" + d.name, "Focus the window " + d.phrase, "ctrl+opt+" + d.key) }
        add("focus-next", "Focus the next tiled window", "ctrl+opt+]")
        add("focus-previous", "Focus the previous tiled window", "ctrl+opt+[")
        for d in sides { add("move-" + d.name, "Move the tiled window " + d.name, "ctrl+opt+shift+" + d.key) }
        for d in sides { add("grow-" + d.name, "Move the tiled window's edge " + d.name, "ctrl+opt+cmd+" + d.key) }
        add("balance", "Even out every split", "ctrl+opt+B")
        add("flip", "Turn the window's split", "ctrl+opt+R")
        add("style", "Next layout: dwindle, columns, main, scrolling, floating", "ctrl+opt+S")
        add("promote", "Make the window the main one", "ctrl+opt+Return")
        add("float", "Float the window, or tile it again", "ctrl+opt+F")
        add("full", "Give the window the whole area, or put it back", "ctrl+opt+M")
        add("group", "Make the tile a group of tabs, or take it apart", "ctrl+opt+G")
        for d in sides { add("group-" + d.name, "Move the window into the tile " + d.phrase + ", or out of its group", "ctrl+opt+shift+cmd+" + d.key) }
        add("group-next", "Focus the next window of the group", "ctrl+opt+Tab")
        add("group-previous", "Focus the previous window of the group", "ctrl+opt+shift+Tab")
        add("next-display", "Send the window to the next display", "ctrl+opt+N")
        add("scratchpad", "Show the scratchpad, or put it away", "ctrl+opt+-")
        add("scratchpad-send", "Send the window to the scratchpad, or take it out", "ctrl+opt+shift+-")
        for style in ["dwindle", "columns", "main", "scrolling", "floating"] { add("style-" + style, "Tile in the " + style + " style", "") }
        return rows
    }()
}
