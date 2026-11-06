import Foundation

/// The themes Settings offers, and the `polycarp theme` command each pick runs. The command owns the files; the app's watcher
/// sees the change and redraws. A test pins this list to the files in `themes/`.
public enum ThemeChoice {
    public struct Theme: Equatable, Sendable { public let name: String; public let title: String }
    public static let builtIn: [Theme] = [
        Theme(name: "polycarp", title: "Polycarp"),
        Theme(name: "still-water", title: "Still Water"),
        Theme(name: "evening", title: "Evening"),
        Theme(name: "parchment", title: "Parchment"),
        Theme(name: "blocks", title: "Blocks"),
        Theme(name: "calm", title: "Calm"),
    ]
    /// The picker's value for no Polycarp theme: the person's own colors, below it in Settings.
    public static let ownColors = ""

    /// What to run for a pick. Own colors turns the theme off, which keeps it for later; a theme with no mode keeps its own.
    public static func arguments(name: String, mode: PolycarpTheme.Mode? = nil) -> [String] {
        if name == ownColors { return ["theme", "off"] }
        return ["theme", "set", name] + (mode.map { ["--mode", $0.rawValue] } ?? [])
    }
}
