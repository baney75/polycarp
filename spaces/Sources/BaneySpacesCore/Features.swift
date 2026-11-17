import Foundation

/// The parts of Polycarp. Both ship in the one app; a part that's off doesn't run, asks macOS for nothing and
/// downloads nothing. `<config>/features.toml` holds the choice, and `polycarp features` and Settings > General change it.
public enum Feature: String, CaseIterable, Sendable {
    case workspaces, voice

    public var title: String {
        switch self {
        case .workspaces: "Workspaces"
        case .voice: "Silas"
        }
    }

    public var summary: String {
        switch self {
        case .workspaces: "Nine workspaces, the dock, the overview and the launcher."
        case .voice: "Hold a key, speak and it types. Speech stays on this Mac."
        }
    }

    /// The Settings sections that belong to this part. Appearance, General and Updates belong to all of them.
    public var settingsTabs: Set<String> {
        switch self {
        case .workspaces: ["Keys", "Dock", "Launcher", "Agents", "Automation"]
        case .voice: ["Silas"]
        }
    }
}

public struct FeatureSet: Equatable, Sendable {
    public var on: Set<Feature>

    public init(_ on: Set<Feature>) { self.on = on }
    public static let all = FeatureSet(Set(Feature.allCases))

    public func contains(_ feature: Feature) -> Bool { on.contains(feature) }

    /// Reads the file's text. Anything missing counts as on, so a damaged line can't take away something that worked. A
    /// `browser` line from before the browser moved to Tychicus names no part here and is skipped.
    public static func parse(_ text: String) -> FeatureSet {
        var on = Set(Feature.allCases)
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
            let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2, let feature = Feature(rawValue: parts[0]), parts[1] == "false" else { continue }
            on.remove(feature)
        }
        return FeatureSet(on)
    }

    /// The file's text. `polycarp features` in cli/src/features.rs writes the same format.
    public var text: String {
        "# Which parts of Polycarp run. Change it in Settings > General or with `polycarp features`.\n"
            + Feature.allCases.map { "\($0.rawValue) = \(contains($0))\n" }.joined()
    }

    /// Whether a Settings section shows: it belongs to no part, or to a part that's on.
    public func showsSettingsTab(_ name: String) -> Bool {
        let owners = Feature.allCases.filter { $0.settingsTabs.contains(name) }
        return owners.isEmpty || owners.contains(where: contains)
    }
}

public enum FeatureFile {
    public static let name = "features.toml"

    public static func path(env: [String: String] = ProcessInfo.processInfo.environment,
                            home: String? = FileManager.default.homeDirectoryForCurrentUser.path) -> String? {
        PolycarpThemeFile.configDir(env: { env[$0] }, home: env["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? home)
            .map { $0 + "/" + name }
    }

    /// The saved choice, or nil when nobody has chosen yet. The welcome window asks then. An install from before this file
    /// has no choice saved either, and `FeatureSet.all` keeps it working as it did.
    public static func load(path: String?) -> FeatureSet? {
        guard let path, let data = FileManager.default.contents(atPath: path) else { return nil }
        return FeatureSet.parse(String(decoding: data, as: UTF8.self))
    }

    @discardableResult
    public static func save(_ set: FeatureSet, path: String?) -> Bool {
        guard let path else { return false }
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        return (try? Data(set.text.utf8).write(to: url, options: .atomic)) != nil
    }
}
