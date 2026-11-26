import AppKit
import BaneySpacesCore

/// How each workspace tiles, for what shows it: the bar. Published on the main thread, only when it changes.
final class TilingState: ObservableObject {
    static let shared = TilingState()
    /// The workspaces that tile and the style of each. One that isn't here doesn't tile.
    @Published private(set) var layouts: [Int: TileStyle] = [:]
    /// Runs a command on the workspace a screen shows: `.toggle` tiles it or stops, `.style(nil)` is its next style.
    var run: (TilingCommand, NSScreen) -> Void = { _, _ in }

    func set(_ now: [Int: TileStyle]) { if now != layouts { layouts = now } }
}
