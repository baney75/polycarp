import AppKit
import BaneySpacesCore
import SwiftUI

/// `BANEYSPACES_RENDER_THEME_EDITOR=<user theme> Polycarp --render <folder>` draws the theme editor and the Appearance tab with
/// the app in light and in dark, offscreen, then stops. It needs `POLYCARP_BIN` (outside the app bundle) and runs every command
/// against `POLYCARP_CONFIG_DIR`, so point that at a scratch folder. Nothing is saved: edits stay in the draft.
@MainActor
enum ThemeEditorRender {
    static func run(_ name: String, save: (AnyView, String, CGSize) -> Bool) -> Int32 {
        let command = ThemeCommand.shared
        guard command.available else { NSLog("Polycarp: set POLYCARP_BIN to render the theme editor"); return 1 }
        guard case .success(let sections) = ThemeEditorSchema.parse(json(command.run(ThemeEditorCommands.schema))) else { return 1 }
        var values: [String: [String: Any]] = [:]
        for s in sections { values[s.name] = ThemeDraft.section(command.run(ThemeEditorCommands.section(s.name, of: name))) }
        let title = command.run(ThemeEditorCommands.list).themes.first { $0.name == name }?.title ?? name
        guard case .success(let draft) = ThemeDraft.load(name: name, title: title, sections: sections, values: values) else { return 1 }

        for mode in ["light", "dark"] {
            guard let theme = chrome(draft, mode: mode) else { return 1 }
            Appearance.shared.usePolycarp(theme)

            // An edit not saved yet: a bluer accent and squarer corners.
            let edited = ThemeEditorModel(draft: draft, sections: sections)
            edited.set("light.accent", .text("#2f5f8f"))
            edited.set("dark.accent", .text("#9cc3ea"))
            edited.set("shape.radius", .number(4))
            guard save(AnyView(ThemeEditorView(model: edited)), "theme-editor-\(mode).png", ThemeEditorView.size) else { return 1 }

            // A faint muted color: the warnings, and the warning mark beside each color in the pair.
            let faint = ThemeEditorModel(draft: draft, sections: sections)
            faint.set("light.muted", .text("#b9bdb0"))
            faint.set("dark.muted", .text("#5b5e54"))
            guard save(AnyView(ThemeEditorView(model: faint)), "theme-editor-warnings-\(mode).png", ThemeEditorView.size) else { return 1 }

            // A picture's colors offered, not yet used.
            let offered = ThemeEditorModel(draft: draft, sections: sections)
            let sample = (0..<600).map { _ in RGB(hex: "#d9e2e8")! } + (0..<300).map { _ in RGB(hex: "#c7b28f")! } + (0..<100).map { _ in RGB(hex: "#e2782c")! }
            offered.proposal = ThemeEditorPalette.propose(sample, light: draft.colors("light"), dark: draft.colors("dark"))
            guard save(AnyView(ThemeEditorView(model: offered)), "theme-editor-picture-\(mode).png", ThemeEditorView.size) else { return 1 }

            // Settings > Appearance with the shelf, once the library has read every theme.
            ThemeLibrary.shared.reload()
            let until = Date().addingTimeInterval(15)
            while ThemeLibrary.shared.tiles.isEmpty, Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
            let setup = SetupModel()
            setup.tab = .appearance
            guard save(AnyView(SetupView(model: setup, close: {}).background(Color(nsColor: .windowBackgroundColor))),
                       "theme-shelf-\(mode).png", SettingsSidebar.windowSize) else { return 1 }
        }
        return 0
    }

    private static func json(_ r: ThemeCommandReply) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["data": r.data])) ?? Data()
    }

    /// The draft as the theme in use, fixed to one mode, so the editor's own chrome draws light or dark.
    private static func chrome(_ draft: ThemeDraft, mode: String) -> PolycarpTheme? {
        guard var root = (try? JSONSerialization.jsonObject(with: draft.themeJSON())) as? [String: Any] else { return nil }
        root["mode"] = mode
        guard let data = try? JSONSerialization.data(withJSONObject: root), case .success(let t) = PolycarpTheme.parse(data) else { return nil }
        return t
    }
}
