import Foundation

/// One Polycarp shortcut: the keys, what they do and where they work. `Keymap.all` holds every one.
///
/// `keys` are display parts, in the order they're held. The token "mod" is the Polycarp modifier the person picked in
/// Settings (⌘ unless they changed it); "cmd", "ctrl", "opt" and "shift" are those keys whatever the setting. Any
/// other token is a key name shown as written ("K", "1...9", "Return", "↑"), and a token of several words keeps its
/// words ("hold mod").
public struct KeyBinding: Equatable {
    public enum Group: String, CaseIterable {
        case launcher, workspaces, windows, terminal, agents, bar

        /// The heading a cheat sheet puts over the group.
        public var title: String {
            switch self {
            case .launcher: "Launcher"
            case .workspaces: "Workspaces"
            case .windows: "Windows"
            case .terminal: "Terminal"
            case .agents: "Agents"
            case .bar: "Bar"
            }
        }
    }

    public enum Scope: String, CaseIterable {
        case global, launcher, terminal, newTab

        /// Where the keys work, as a cheat sheet says it.
        public var title: String {
            switch self {
            case .global: "Anywhere"
            case .launcher: "In the launcher"
            case .terminal: "While a terminal app is in front"
            case .newTab: "On the browser's new tab page"
            }
        }
    }

    public let id: String
    public let keys: [String]
    public let title: String
    public let group: Group
    public let scope: Scope

    public init(id: String, keys: [String], title: String, group: Group, scope: Scope) {
        self.id = id
        self.keys = keys
        self.title = title
        self.group = group
        self.scope = scope
    }

    /// The fixed modifier tokens and the symbol macOS shows for each.
    public static let modifierSymbols: [String: String] = ["cmd": "⌘", "ctrl": "⌃", "opt": "⌥", "shift": "⇧"]

    /// The keys as macOS writes them: "⌃⌘K", with "mod" as `modifierSymbol` ("⌘1...9", "hold ⌘").
    public func display(modifierSymbol: String) -> String {
        keys.map { token in
            if token == "mod" { return modifierSymbol }
            if let symbol = Self.modifierSymbols[token] { return symbol }
            guard token.contains(" ") else { return token }
            return token.split(separator: " ").map { $0 == "mod" ? modifierSymbol : String($0) }.joined(separator: " ")
        }.joined()
    }
}

/// Every Polycarp shortcut, in one table: the app's registrations, the launcher's own keys and the new tab page read
/// the same rows, and so do `polycarp-spaces keys`, the `keys_list` MCP tool and docs/keys.md. `KeymapTests` fails when
/// the code takes a key that has no row here, or docs/keys.md says something else.
public enum Keymap {
    public static let all: [KeyBinding] = [
        // Launcher
        KeyBinding(id: "launcher.cmdSpace", keys: ["cmd", "Space"], title: "Open the launcher, when Settings puts it on ⌘Space",
                   group: .launcher, scope: .global),
        KeyBinding(id: "launcher.open", keys: ["ctrl", "cmd", "K"], title: "Open the launcher", group: .launcher, scope: .global),
        KeyBinding(id: "keys.hold", keys: ["hold mod"], title: "Show every shortcut", group: .launcher, scope: .global),
        KeyBinding(id: "keys.launcher", keys: ["cmd", "K"], title: "Show every shortcut", group: .launcher, scope: .launcher),
        KeyBinding(id: "keys.launcher.question", keys: ["?"], title: "Show every shortcut", group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.down", keys: ["↓"], title: "Select the next result", group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.up", keys: ["↑"], title: "Select the previous result", group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.run", keys: ["Return"], title: "Open the selected result", group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.reveal", keys: ["cmd", "Return"], title: "The selected result's other action, or show where it lives",
                   group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.tab", keys: ["Tab"], title: "Open the selected menu, or finish an Install or a bang",
                   group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.escape", keys: ["Esc"], title: "Clear the search, then go back a menu, then close",
                   group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.back", keys: ["Delete"], title: "Go back a menu when the search is empty",
                   group: .launcher, scope: .launcher),
        KeyBinding(id: "newtab.go", keys: ["Return"], title: "Search, or go to the address typed", group: .launcher, scope: .newTab),
        // Workspaces
        KeyBinding(id: "workspace.switch", keys: ["mod", "1...9"], title: "Go to workspace 1 to 9", group: .workspaces, scope: .global),
        KeyBinding(id: "workspace.overview", keys: ["F3"], title: "Show every workspace (the Mission Control key), when Settings has it on",
                   group: .workspaces, scope: .global),
        KeyBinding(id: "workspace.overview.controlUp", keys: ["ctrl", "↑"], title: "Show every workspace, while macOS has ⌃↑ for Mission Control",
                   group: .workspaces, scope: .global),
        // Windows
        KeyBinding(id: "window.move", keys: ["mod", "shift", "1...9"], title: "Move the window in front to workspace 1 to 9",
                   group: .windows, scope: .global),
        KeyBinding(id: "switcher.next", keys: ["cmd", "Tab"], title: "Switch apps or workspaces, when Settings has ⌘Tab on",
                   group: .windows, scope: .global),
        KeyBinding(id: "switcher.back", keys: ["cmd", "shift", "Tab"], title: "Step back in the ⌘Tab switcher",
                   group: .windows, scope: .global),
        // Terminal
        KeyBinding(id: "terminal.quick", keys: ["ctrl", "`"], title: "Drop down the quick terminal, when Settings has it on",
                   group: .terminal, scope: .global),
        // Agents
        KeyBinding(id: "agents.finished", keys: ["ctrl", "cmd", "U"], title: "Go to the agent that finished", group: .agents, scope: .global),
        KeyBinding(id: "agents.finished.terminal", keys: ["cmd", "shift", "U"], title: "Go to the agent that finished",
                   group: .agents, scope: .terminal),
    ]

    /// The row with this id.
    public static func binding(_ id: String) -> KeyBinding? { all.first { $0.id == id } }

    /// The symbol for the app's "modifier" setting (`Modifier` in the app: command, control, option, controlOption).
    /// Anything else, or no setting, is ⌘, as in the app.
    public static func modifierSymbol(setting: String?) -> String {
        switch setting {
        case "control": "⌃"
        case "option": "⌥"
        case "controlOption": "⌃⌥"
        default: "⌘"
        }
    }

    /// The groups in sheet order, each with its rows in table order. Empty groups are left out.
    public static var grouped: [(group: KeyBinding.Group, rows: [KeyBinding])] {
        KeyBinding.Group.allCases.compactMap { g in
            let rows = all.filter { $0.group == g }
            return rows.isEmpty ? nil : (g, rows)
        }
    }

    /// `polycarp-spaces keys`: a cheat sheet, grouped, with the keys in macOS symbols.
    public static func cheatSheet(modifierSymbol: String) -> String {
        let keyWidth = all.map { $0.display(modifierSymbol: modifierSymbol).count }.max() ?? 0
        let titleWidth = all.map(\.title.count).max() ?? 0
        func pad(_ s: String, _ n: Int) -> String { s + String(repeating: " ", count: max(0, n - s.count)) }
        var lines = ["Polycarp shortcuts. Your modifier is \(modifierSymbol) (Settings > Keys); docs/keys.md has the same list."]
        for (g, rows) in grouped {
            lines.append("")
            lines.append(g.title)
            for r in rows {
                lines.append("  " + pad(r.display(modifierSymbol: modifierSymbol), keyWidth) + "  " + pad(r.title, titleWidth) + "  " + r.scope.title)
            }
        }
        return lines.joined(separator: "\n")
    }

    /// `polycarp-spaces keys --json`: an array of {id, keys, display, title, group, scope}, in table order.
    public static func json(modifierSymbol: String) -> String {
        let rows: [[String: Any]] = all.map { r in
            ["id": r.id, "keys": r.keys, "display": r.display(modifierSymbol: modifierSymbol), "title": r.title,
             "group": r.group.rawValue, "scope": r.scope.rawValue]
        }
        let data = (try? JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])) ?? Data("[]".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// The tables docs/keys.md holds between its `keys:begin` and `keys:end` markers, with the default modifier ⌘.
    /// `polycarp-spaces keys --markdown` prints it.
    public static func markdown() -> String {
        var lines: [String] = []
        for (g, rows) in grouped {
            if !lines.isEmpty { lines.append("") }
            lines.append("## \(g.title)")
            lines.append("")
            lines.append("| Keys | What it does | Where it works |")
            lines.append("| --- | --- | --- |")
            for r in rows {
                lines.append("| \(r.display(modifierSymbol: "⌘")) | \(r.title) | \(r.scope.title) |")
            }
        }
        return lines.joined(separator: "\n")
    }
}
