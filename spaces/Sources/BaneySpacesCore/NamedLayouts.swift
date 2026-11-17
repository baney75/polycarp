import CoreGraphics
import Foundation

/// A layout you saved by name (`polycarp-spaces layout save <name>`): every window's workspace, display and frame, and
/// what each display showed. `restore` puts the windows still open back, matched as `WindowPairing` does.
public struct NamedLayout: Codable, Equatable, Sendable {
    public var savedAt: Double
    public var current: Int
    /// The workspace on each display, by UUID.
    public var displays: [DisplayKey: Int]
    public var windows: [WindowRecord]
    /// Saved from one workspace only (`--workspace N`): restoring it places those windows and switches nothing.
    public var only: Int?

    public init(savedAt: Double, current: Int, displays: [DisplayKey: Int], windows: [WindowRecord], only: Int? = nil) {
        self.savedAt = savedAt; self.current = current; self.displays = displays; self.windows = windows; self.only = only
    }

    public struct Placement: Equatable, Sendable {
        public var window: WindowID
        public var workspace: Int
        public var frame: CGRect?
        public var rule: WindowPairing.Rule
    }

    /// Where each window open now goes. A window on a display that isn't connected goes to the display that showed its
    /// workspace if that one is here, else the main display. Windows the layout doesn't know stay as they are.
    public func plan(_ live: [LiveWindow], displays areas: [DisplayArea]) -> (placements: [Placement], missing: Int) {
        let pairs = WindowPairing.pair(live, with: windows)
        let placements = pairs.compactMap { p -> Placement? in
            let r = windows[p.record]
            guard Workspaces.range.contains(r.workspace) else { return nil }
            let fallback = displays.first { d in d.value == r.workspace && areas.contains { $0.key == d.key } }?.key
            return Placement(window: p.window, workspace: r.workspace, frame: r.place(on: areas, showing: fallback), rule: p.rule)
        }
        return (placements, windows.count - placements.count)
    }
}

/// Every named layout, in `named-layouts.json` in Polycarp's support folder.
public struct NamedLayouts: Codable, Equatable, Sendable {
    public var layouts: [String: NamedLayout] = [:]

    public init(layouts: [String: NamedLayout] = [:]) { self.layouts = layouts }

    /// A name is 1 to 64 letters, digits, spaces, dots, dashes or underscores, not starting with a dot or a space.
    public static func isValid(_ name: String) -> Bool {
        guard (1...64).contains(name.count), let first = name.first, first != ".", first != " " else { return false }
        return name.allSatisfy { $0.isLetter || $0.isNumber || " ._-".contains($0) }
    }

    public static func load(from url: URL) -> NamedLayouts {
        guard let data = try? Data(contentsOf: url),
              let all = try? JSONDecoder().decode(NamedLayouts.self, from: data) else { return NamedLayouts() }
        return all
    }

    public func save(to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        guard let data = try? enc.encode(self) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
