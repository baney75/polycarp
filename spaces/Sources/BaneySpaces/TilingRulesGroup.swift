import AppKit
import BaneySpacesCore
import SwiftUI

/// Window rules (`tiling.rules`) in Settings: each with a Remove button, and new ones from the running apps.
struct TilingRulesGroup: View {
    @ObservedObject private var settings = TilingSettings.shared
    /// Words of a title the next rule matches; empty for every window of the app.
    @State private var words = ""

    private var rules: [String] { settings.tiling.rules }

    var body: some View {
        SettingsGroup("Rules") {
            ForEach(rules, id: \.self) { line in
                if let r = try? TileRule.read(line).get() {
                    SettingsRow(Self.describe(r)) {
                        Button("Remove") { set(rules.filter { $0 != line }) }.accessibilityLabel("Remove the rule \(Self.describe(r))")
                    }
                }
            }
            SettingsRow("Only titles with", help: "Leave it empty for every window of the app.") {
                TextField("Only titles with", text: $words).labelsHidden().textFieldStyle(.roundedBorder)
            }
            SettingsRow("Add a rule", help: "A new window of the app floats, tiles, is pinned on every workspace or goes to a workspace.") {
                Menu("Running Apps") {
                    ForEach(Self.running(), id: \.id) { app in
                        Menu(app.name) {
                            ForEach(Self.actions, id: \.word) { a in Button(a.title) { add(app.id, a.word) } }
                        }
                    }
                }
            }
            SettingsRow("Built in", help: "They float unless a rule tiles them.") {
                Text(TileRules.builtIn.map(WindowsPane.name(of:)).sorted().joined(separator: ", "))
            }
            LearnMore("The first float or tile rule that matches a window wins, and the first pin or workspace rule says where a new one goes. A rule never moves a window to or from the agent workspace, nor a window that waits on you. Titles stay on this Mac and are never written to a log.")
        }
    }

    private static let actions: [(word: String, title: String)] = {
        var a: [(word: String, title: String)] = [("float", "Float"), ("tile", "Tile"), ("pin", "Pin on Every Workspace")]
        for n in Workspaces.range { a.append((String(n), "Workspace \(n)")) }
        return a
    }()

    private func add(_ bundle: String, _ word: String) {
        let title = words.trimmingCharacters(in: .whitespacesAndNewlines)
        let line = title.isEmpty ? "\(bundle) \(word)" : "\(bundle) \(word) \(title)"
        guard (try? TileRule.read(line).get()) != nil, !rules.contains(line) else { return NSSound.beep() }
        set(rules + [line])
        words = ""
    }

    private func set(_ lines: [String]) {
        settings.set("rules", .array(lines.map { .string($0) })) { $0.rules = lines }
    }

    static func describe(_ r: TileRule) -> String {
        let app = WindowsPane.name(of: r.bundle)
        let what: String
        switch r.action {
        case .float: what = "floats"
        case .tile: what = "tiles"
        case .pin: what = "is pinned on every workspace"
        case .workspace(let n): what = "goes to workspace \(n)"
        }
        return r.title.map { "\(app) with “\($0)”: \(what)" } ?? "\(app): \(what)"
    }

    private static func running() -> [(id: String, name: String)] {
        NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap { app in
            guard let id = app.bundleIdentifier, id != Product.bundleID else { return nil }
            return (id, app.localizedName ?? id)
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}
