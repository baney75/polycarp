import Foundation

/// The settings `baneyspaces set` and `baneyspaces get` reach, by the names the spec gives them
/// (spec/themes.md, "Settings"). The same names are in Settings on every platform.
public enum SettingKey: String, CaseIterable, Sendable {
    case theme = "appearance.theme"
    case palette = "appearance.palette"

    /// Settings a Polycarp no longer has, each with why: asked for one, `set` and `get` say so instead of "no setting".
    public static let retired: [String: String] = [
        "dock.enabled": "dock.enabled is gone: the Workspace Dock was removed on 2026-11-23. Workspaces are on ⌘1-9 and the top bar, "
            + "the overview on the Mission Control key, and apps running with no window in the launcher (⌃⌘K).",
    ]

    public init?(name: String) { self.init(rawValue: name.trimmingCharacters(in: .whitespaces).lowercased()) }

    public var usage: String {
        switch self {
        case .theme: "\(rawValue) \(ThemeID.allCases.map(\.rawValue).joined(separator: "|"))"
        case .palette: "\(rawValue) auto|\(PaletteCatalog.shared.names.joined(separator: "|"))"
        }
    }

    /// The value as it is stored and shown, or nil when it isn't one this setting takes.
    public func normalized(_ text: String) -> String? {
        let v = text.trimmingCharacters(in: .whitespaces).lowercased()
        switch self {
        case .theme: return ThemeID(rawValue: v)?.rawValue
        case .palette: return v == AppearanceSettings.autoPalette || PaletteCatalog.shared.named(v) != nil ? v : nil
        }
    }

    /// What `set` adds to its answer while a Polycarp theme is in force: the value is stored, and not drawn.
    public func polycarpNote(inForce: Bool) -> String? {
        guard inForce, self == .theme || self == .palette else { return nil }
        return "saved, but not drawn until the Polycarp theme is removed (delete its theme.json)"
    }

    /// What a `set` or `get` was asked, from the request's fields.
    public enum Ask: Equatable {
        case get(SettingKey)
        case set(SettingKey, String)
        case list
        case refused(String)
    }

    public static func ask(target: String?, text: String?) -> Ask {
        // A name that is empty (an unset variable in a script) is a mistake, never "list everything"
        // when a value came with it.
        if text != nil, target?.isEmpty ?? true { return .refused("no setting name; the settings are \(allCases.map(\.rawValue).joined(separator: ", "))") }
        guard let target, !target.isEmpty else { return .list }
        if let why = retired[target.trimmingCharacters(in: .whitespaces).lowercased()] { return .refused(why) }
        guard let key = SettingKey(name: target) else {
            return .refused("no setting \(target); the settings are \(allCases.map(\.rawValue).joined(separator: ", "))")
        }
        guard let text else { return .get(key) }
        guard let value = key.normalized(text) else { return .refused("\(text) isn't a value for \(key.rawValue): use \(key.usage)") }
        return .set(key, value)
    }
}
