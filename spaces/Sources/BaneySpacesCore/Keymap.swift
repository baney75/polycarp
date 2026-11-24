import Foundation

/// One Polycarp shortcut: the keys, what they do and where they work. `Keymap.all` holds every one.
///
/// `keys` are display parts, in the order they're held. The token "mod" is the Polycarp modifier the person picked in
/// Settings (⌘ unless they changed it); "cmd", "ctrl", "opt" and "shift" are those keys whatever the setting. Any
/// other token is a key name shown as written ("K", "1...9", "Return", "↑"), and a token of several words keeps its
/// words ("hold mod").
public struct KeyBinding: Equatable {
    public enum Group: String, CaseIterable {
        case launcher, workspaces, windows, terminal, agents, player, bar

        /// The heading a cheat sheet puts over the group.
        public var title: String {
            switch self {
            case .launcher: "Launcher"
            case .workspaces: "Workspaces"
            case .windows: "Windows"
            case .terminal: "Terminal"
            case .agents: "Agents"
            case .player: "Player"
            case .bar: "Bar"
            }
        }
    }

    public enum Scope: String, CaseIterable {
        case global, launcher, terminal, newTab, overview, switcher, player, menu

        /// Where the keys work, as a cheat sheet says it.
        public var title: String {
            switch self {
            case .global: "Anywhere"
            case .launcher: "In the launcher"
            case .terminal: "While a terminal app is in front"
            case .newTab: "On the browser's new tab page"
            case .overview: "In the overview"
            case .switcher: "While the ⌘Tab switcher is up"
            case .player: "In the player"
            case .menu: "In the Polycarp menu"
            }
        }
    }

    public let id: String
    public let keys: [String]
    public let title: String
    public let group: Group
    public let scope: Scope
    /// When the keys work beyond their scope, if they don't always: "When Settings has it on". Nil when they always do.
    public let note: String?

    public init(id: String, keys: [String], title: String, group: Group, scope: Scope, note: String? = nil) {
        self.id = id
        self.keys = keys
        self.title = title
        self.group = group
        self.scope = scope
        self.note = note
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

/// Every Polycarp shortcut, in one table. `polycarp-spaces keys`, the `keys_list` MCP tool and docs/keys.md all read
/// it. `KeymapTests` fails when the code takes a key that has no row here, a row outlives its
/// key, or docs/keys.md says something else.
public enum Keymap {
    public static let all: [KeyBinding] = [
        // Launcher
        KeyBinding(id: "launcher.cmdSpace", keys: ["cmd", "Space"], title: "Open the launcher", group: .launcher, scope: .global,
                   note: "When Settings puts the launcher on ⌘Space and Spotlight doesn't hold it"),
        KeyBinding(id: "launcher.open", keys: ["ctrl", "cmd", "K"], title: "Open the launcher", group: .launcher, scope: .global),
        KeyBinding(id: "launcher.down", keys: ["↓"], title: "Select the next result", group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.up", keys: ["↑"], title: "Select the previous result", group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.run", keys: ["Return"], title: "Open the selected result", group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.reveal", keys: ["cmd", "Return"], title: "The selected result's other action, or show where it lives",
                   group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.tab", keys: ["Tab"], title: "Open the selected menu, or finish an Install or a bang",
                   group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.escape", keys: ["Esc"], title: "Clear the search, then go back a menu, then close",
                   group: .launcher, scope: .launcher),
        KeyBinding(id: "launcher.back", keys: ["Delete"], title: "Go back a menu", group: .launcher, scope: .launcher,
                   note: "When the search is empty"),
        KeyBinding(id: "newtab.go", keys: ["Return"], title: "Search, or go to the address typed", group: .launcher, scope: .newTab),
        KeyBinding(id: "newtab.down", keys: ["↓"], title: "Select the next result", group: .launcher, scope: .newTab),
        KeyBinding(id: "newtab.down.ctrl", keys: ["ctrl", "N"], title: "Select the next result", group: .launcher, scope: .newTab),
        KeyBinding(id: "newtab.up", keys: ["↑"], title: "Select the previous result", group: .launcher, scope: .newTab),
        KeyBinding(id: "newtab.up.ctrl", keys: ["ctrl", "P"], title: "Select the previous result", group: .launcher, scope: .newTab),
        KeyBinding(id: "newtab.tab", keys: ["Tab"], title: "Finish a bang", group: .launcher, scope: .newTab),
        KeyBinding(id: "newtab.clear", keys: ["Esc"], title: "Clear the search", group: .launcher, scope: .newTab,
                   note: "When the search has text"),
        // Workspaces
        KeyBinding(id: "workspace.switch", keys: ["mod", "1...9"], title: "Go to workspace 1 to 9", group: .workspaces, scope: .global),
        KeyBinding(id: "workspace.overview", keys: ["F3"], title: "Show every workspace (the Mission Control key)",
                   group: .workspaces, scope: .global, note: "When Settings uses Polycarp's overview instead of Mission Control"),
        KeyBinding(id: "workspace.overview.controlUp", keys: ["ctrl", "↑"], title: "Show every workspace", group: .workspaces, scope: .global,
                   note: "When Settings uses Polycarp's overview and macOS has ⌃↑ for Mission Control"),
        KeyBinding(id: "overview.pick", keys: ["1...9"], title: "Go to that workspace", group: .workspaces, scope: .overview),
        KeyBinding(id: "overview.move", keys: ["←→↑↓"], title: "Move the highlight from workspace to workspace",
                   group: .workspaces, scope: .overview),
        KeyBinding(id: "overview.go", keys: ["Return"], title: "Go to the highlighted workspace", group: .workspaces, scope: .overview),
        KeyBinding(id: "overview.close", keys: ["Esc"], title: "Close the overview", group: .workspaces, scope: .overview),
        KeyBinding(id: "menu.workspace", keys: ["mod", "1...9"], title: "Go to that workspace", group: .workspaces, scope: .menu),
        // Windows
        KeyBinding(id: "window.move", keys: ["mod", "shift", "1...9"], title: "Move the window in front to workspace 1 to 9",
                   group: .windows, scope: .global),
        KeyBinding(id: "switcher.next", keys: ["cmd", "Tab"], title: "Switch apps or workspaces", group: .windows, scope: .global,
                   note: "When Settings has ⌘Tab switch apps or workspaces"),
        KeyBinding(id: "switcher.back", keys: ["cmd", "shift", "Tab"], title: "Step back in the ⌘Tab switcher", group: .windows, scope: .global,
                   note: "When Settings has ⌘Tab switch apps or workspaces"),
        KeyBinding(id: "switcher.arrows", keys: ["←→↑↓"], title: "Step through the switcher: → and ↓ forward, ← and ↑ back",
                   group: .windows, scope: .switcher),
        KeyBinding(id: "switcher.cancel", keys: ["Esc"], title: "Close the switcher without switching", group: .windows, scope: .switcher),
        // Terminal
        KeyBinding(id: "terminal.quick", keys: ["ctrl", "`"], title: "Drop down the quick terminal", group: .terminal, scope: .global,
                   note: "When Settings has it on, in builds with the terminal"),
        // Agents
        KeyBinding(id: "agents.finished", keys: ["ctrl", "cmd", "U"], title: "Go to the agent that finished", group: .agents, scope: .global),
        KeyBinding(id: "agents.finished.terminal", keys: ["cmd", "shift", "U"], title: "Go to the agent that finished",
                   group: .agents, scope: .terminal),
        // Player
        KeyBinding(id: "player.play", keys: ["Space"], title: "Play or pause", group: .player, scope: .player, note: "Songs and videos"),
        KeyBinding(id: "player.seek", keys: ["←→"], title: "Back or forward 5 seconds", group: .player, scope: .player,
                   note: "Songs and videos; on a photo, the previous or next file"),
        KeyBinding(id: "player.longSeek", keys: ["shift", "←→"], title: "Back or forward 30 seconds", group: .player, scope: .player,
                   note: "Songs and videos"),
        KeyBinding(id: "player.volume", keys: ["↑↓"], title: "Volume up or down", group: .player, scope: .player, note: "Songs and videos"),
        KeyBinding(id: "player.step", keys: ["cmd", "←→"], title: "The previous or next file in the folder", group: .player, scope: .player),
        KeyBinding(id: "player.fill", keys: ["F"], title: "Fill the screen, or come back", group: .player, scope: .player),
        KeyBinding(id: "player.info", keys: ["cmd", "I"], title: "Show or hide the file's details", group: .player, scope: .player),
        KeyBinding(id: "player.close", keys: ["Esc"], title: "Close the player", group: .player, scope: .player),
        KeyBinding(id: "player.closeCmd", keys: ["cmd", "W"], title: "Close the player", group: .player, scope: .player),
        // Bar
        KeyBinding(id: "menu.settings", keys: ["cmd", ","], title: "Open Settings", group: .bar, scope: .menu),
        KeyBinding(id: "menu.quit", keys: ["cmd", "Q"], title: "Quit Polycarp", group: .bar, scope: .menu),
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
        let scopeWidth = all.map(\.scope.title.count).max() ?? 0
        func pad(_ s: String, _ n: Int) -> String { s + String(repeating: " ", count: max(0, n - s.count)) }
        var lines = ["Polycarp shortcuts. Your modifier is \(modifierSymbol) (Settings > Keys); docs/keys.md has the same list."]
        for (g, rows) in grouped {
            lines.append("")
            lines.append(g.title)
            for r in rows {
                let line = "  " + pad(r.display(modifierSymbol: modifierSymbol), keyWidth) + "  " + pad(r.title, titleWidth) + "  "
                lines.append(r.note.map { line + pad(r.scope.title, scopeWidth) + "  " + $0 } ?? line + r.scope.title)
            }
        }
        return lines.joined(separator: "\n")
    }

    /// `polycarp-spaces keys --json`: an array of {id, keys, display, title, group, scope, note}, in table order; note
    /// is null when the keys always work in their scope.
    public static func json(modifierSymbol: String) -> String {
        let rows: [[String: Any]] = all.map { r in
            ["id": r.id, "keys": r.keys, "display": r.display(modifierSymbol: modifierSymbol), "title": r.title,
             "group": r.group.rawValue, "scope": r.scope.rawValue, "note": r.note.map { $0 as Any } ?? NSNull()]
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
            lines.append("| Keys | What it does | Where it works | When |")
            lines.append("| --- | --- | --- | --- |")
            for r in rows {
                lines.append("| \(r.display(modifierSymbol: "⌘")) | \(r.title) | \(r.scope.title) | \(r.note ?? "Always") |")
            }
        }
        return lines.joined(separator: "\n")
    }
}
