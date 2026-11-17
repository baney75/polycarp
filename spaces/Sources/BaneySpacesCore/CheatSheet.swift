/// The cheat sheet (K3): every live binding, from the keymap Polycarp registered, grouped, plus the keys Polycarp
/// answers outside the keymap. Nothing is typed in by hand, so a binding the file adds shows up and one it removes goes.
public enum CheatSheet {
    public struct Row: Equatable, Sendable {
        public let keys: String
        public let does: String
        /// macOS or another app holds the chord, so it does nothing in Polycarp now.
        public let taken: Bool
    }

    public struct Section: Equatable, Sendable {
        public let title: String
        public let rows: [Row]
    }

    /// Keys Polycarp answers that aren't in the keymap: the event taps' keys as Settings has them now, and the recovery
    /// chord. `cmdTab` is what ⌘⇥ steps through ("apps", "workspaces"), or nil while macOS keeps it.
    public static func fixed(overview: Bool, cmdTab: String?, fill: Bool) -> [Row] {
        var rows: [Row] = []
        if let cmdTab { rows.append(Row(keys: "⌘⇥", does: "Step through \(cmdTab): hold ⌘, press ⇥", taken: false)) }
        if overview { rows.append(Row(keys: "⌃↑ or F3", does: "Show the overview", taken: false)) }
        if fill { rows.append(Row(keys: "⌃⌘F", does: "Fill the screen on this workspace (again: put it back)", taken: false)) }
        rows.append(Row(keys: Chord.recovery.symbol + " (hold 2 s)", does: "Default keys, if spaces.toml left you stuck", taken: false))
        return rows
    }

    /// Workspaces, windows, focus and swap, then the rest. A chord in `taken` is marked; workspace numbers fold into one
    /// row when they run 1 to 9 on one modifier, as the defaults do.
    public static func sections(_ keymap: Keymap, taken: Set<Chord> = [], fixed: [Row]) -> [Section] {
        func row(_ b: KeyBinding) -> Row { Row(keys: b.chord.symbol, does: b.action.title, taken: taken.contains(b.chord)) }
        var workspaces: [Row] = [], windows: [Row] = [], focus: [Row] = [], other: [Row] = []
        for (kind, make) in [("switch", { KeyAction.switchTo($0) }), ("move", { KeyAction.move($0) })] as [(String, (Int) -> KeyAction)] {
            let all = (1...9).map { n in keymap.chords(for: make(n)) }
            // One chord each, the same modifiers, the keys 1 to 9: one row.
            if all.allSatisfy({ $0.count == 1 }), Set(all.map { $0[0].mods }).count == 1,
               all.enumerated().allSatisfy({ $0.element[0].key == "\($0.offset + 1)" }), let first = all.first?.first {
                let keys = first.mods.sorted().map(\.symbol).joined() + "1…9"
                let does = kind == "switch" ? "Go to workspace 1 to 9" : "Send the window to workspace 1 to 9"
                workspaces.append(Row(keys: keys, does: does, taken: all.contains { taken.contains($0[0]) }))
            } else {
                for n in 1...9 { for c in keymap.chords(for: make(n)) { workspaces.append(row(KeyBinding(chord: c, action: make(n)))) } }
            }
        }
        for b in keymap.bindings {
            switch b.action {
            case .switchTo, .move: continue
            case let .window(a):
                switch a {
                case .focus, .swap: focus.append(row(b))
                default: windows.append(row(b))
                }
            default: other.append(row(b))
            }
        }
        return [Section(title: "Workspaces", rows: workspaces), Section(title: "Windows", rows: windows),
                Section(title: "Focus and swap", rows: focus), Section(title: "Polycarp", rows: other + fixed)]
            .filter { !$0.rows.isEmpty }
    }
}
