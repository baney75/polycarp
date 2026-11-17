import AppKit
import BaneySpacesCore

/// What the agent API's queries read (`AgentAPI.Facts`), gathered on the main thread in one pass: the model, one
/// window-server read, the displays, the look and the saved layouts. Scope is applied later, by the hands router.
extension Spaces {
    /// Saved layouts (`layout save`) live here, one JSON file each.
    static let layoutsFolder = folder.appendingPathComponent("layouts", isDirectory: true)

    static func savedLayoutNames() -> [String] {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: layoutsFolder.path)) ?? []
        return files.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
    }

    func agentFacts() -> AgentAPI.Facts {
        let displays = Windows.displays().map { d -> AgentAPI.DisplayFacts in
            let screen = Windows.screen(for: d.key)
            return AgentAPI.DisplayFacts(id: d.key, name: screen?.localizedName ?? "Display", frame: d.frame, visible: d.visible,
                                         scale: Double(screen?.backingScaleFactor ?? 1))
        }
        let look = Appearance.shared
        let polycarp = look.polycarp.map { (name: $0.name, title: $0.title, mode: $0.mode.rawValue) }
        return AgentAPI.Facts(windows: apiWindows(), current: model.current, shown: model.shown, focusedDisplay: model.focusedDisplay,
                              focusedWindow: model.lastFocused[model.current], agentWorkspace: Spaces.agentWorkspace,
                              displays: displays,
                              theme: AgentAPI.ThemeFacts(theme: look.settings.theme.rawValue, palette: look.settings.colorPalette, polycarp: polycarp),
                              savedLayouts: Self.savedLayoutNames())
    }
}
