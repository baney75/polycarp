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
    /// The agent session that saved it (`BANEYSPACES_SESSION`), or nil for one Donovan saved.
    public var savedBy: String?

    public init(savedAt: Double, current: Int, displays: [DisplayKey: Int], windows: [WindowRecord], only: Int? = nil,
                savedBy: String? = nil) {
        self.savedAt = savedAt; self.current = current; self.displays = displays; self.windows = windows; self.only = only
        self.savedBy = savedBy
    }

    public struct Placement: Equatable, Sendable {
        public var window: WindowID
        public var workspace: Int
        public var frame: CGRect?
        public var rule: WindowPairing.Rule
    }

    /// Where each window open now goes: onto the display that showed its workspace when that one is here, else its own
    /// display, else the main one. Windows the layout doesn't know stay as they are.
    public func plan(_ live: [LiveWindow], displays areas: [DisplayArea]) -> (placements: [Placement], missing: Int) {
        let pairs = WindowPairing.pair(live, with: windows)
        let placements = pairs.compactMap { p -> Placement? in
            let r = windows[p.record]
            guard Workspaces.range.contains(r.workspace) else { return nil }
            let showing = displays.first { d in d.value == r.workspace && areas.contains { $0.key == d.key } }?.key
            return Placement(window: p.window, workspace: r.workspace, frame: r.place(on: areas, showing: showing), rule: p.rule)
        }
        return (placements, windows.count - placements.count)
    }
}

/// Who may do what with named layouts. A request that carries an agent session (`--session`, sent by the CLI when
/// `BANEYSPACES_SESSION` is set) may list, save and delete, but replace or delete only layouts that session saved, and
/// never restore: a restore changes what Donovan sees. Cooperative: a process that unsets the variable counts as him,
/// as with the switch URL.
public enum LayoutAccess {
    public static let restoreRefused = "Agents may change what you see is off: layout restore is Donovan's"

    /// The agent session a request names, if any.
    public static func session(in args: [String]?) -> String? {
        guard let a = args, let i = a.firstIndex(of: "--session"), i + 1 < a.count, !a[i + 1].isEmpty else { return nil }
        return a[i + 1]
    }

    /// Why this request is refused (`permission_denied`), or nil. `existing`: the layout of that name, if there is one.
    public static func refusal(verb: String, session: String?, existing: NamedLayout?) -> String? {
        guard let session else { return nil }
        switch verb {
        case "restore": return restoreRefused
        case "delete" where existing.map({ $0.savedBy != session }) == true:
            return "an agent session deletes only the layouts it saved"
        case "save" where existing.map({ $0.savedBy != session }) == true:
            return "an agent session replaces only the layouts it saved"
        default: return nil
        }
    }
}

/// Every named layout, in `named-layouts.json` in Polycarp's support folder (0600; titles only as hashes).
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
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        guard let data = try? enc.encode(self) else { return }
        PrivateFile.write(data, to: url)
    }
}
