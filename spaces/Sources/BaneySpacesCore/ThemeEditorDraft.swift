import Foundation

/// One value in a theme, as the CLI prints it in `export json`.
public enum ThemeValue: Equatable, Hashable, Sendable {
    case text(String)
    case number(Double)
    case flag(Bool)

    /// What `polycarp theme change <path> <value>` takes on its command line.
    public var argument: String {
        switch self {
        case .text(let s): s
        case .flag(let b): b ? "true" : "false"
        case .number(let v): v == v.rounded() && abs(v) < 1e15 ? String(Int(v)) : String(v)
        }
    }

    public var color: RGB? { if case .text(let s) = self { RGB(hex: s) } else { nil } }
    public var number: Double? { if case .number(let v) = self { v } else { nil } }

    init?(json: Any) {
        if let n = json as? NSNumber {
            self = CFGetTypeID(n) == CFBooleanGetTypeID() ? .flag(n.boolValue) : .number(n.doubleValue)
        } else if let s = json as? String {
            self = .text(s)
        } else {
            return nil
        }
    }

    var json: Any {
        switch self {
        case .text(let s): s
        case .number(let v): v
        case .flag(let b): b
        }
    }

    /// A color as the CLI writes it: `#rrggbb` in lower case.
    public static func color(_ c: RGB) -> ThemeValue { .text(c.hex.lowercased()) }
}

/// A theme being edited: its values by path, what they were when it was opened or last saved, and undo and redo.
/// Nothing here writes a file; Save sends `changes()` to `polycarp theme change`.
public struct ThemeDraft: Equatable, Sendable {
    /// Edits to one value this close together are one step of undo: a drag in a color well or on a slider.
    public static let gestureWindow: TimeInterval = 1.0

    public let name: String
    public let title: String
    public let mode: PolycarpTheme.Mode
    public let fields: [ThemeField]
    public private(set) var original: [String: ThemeValue]
    public private(set) var values: [String: ThemeValue]
    private var past: [[String: ThemeValue]] = []
    private var future: [[String: ThemeValue]] = []
    private var last: (path: String, at: TimeInterval)?

    public init(name: String, title: String, mode: PolycarpTheme.Mode, fields: [ThemeField], values: [String: ThemeValue]) {
        self.name = name; self.title = title; self.mode = mode; self.fields = fields
        self.original = values; self.values = values
    }

    /// Reads one table per section, as `polycarp theme get <section> <name> --json` prints each in `data.value`. These are the
    /// theme's own values, the ones `theme change` edits; `export` would show every duration as 0 while `reduced` is on.
    public static func load(name: String, title: String, sections: [ThemeFieldSection],
                            values: [String: [String: Any]]) -> Result<ThemeDraft, PolycarpThemeError> {
        let fields = sections.flatMap(\.fields)
        var out: [String: ThemeValue] = [:]
        for f in fields {
            guard let raw = values[f.section]?[f.key], let v = ThemeValue(json: raw) else {
                return .failure(.init("the theme has no \(f.path)"))
            }
            out[f.path] = v
        }
        return .success(ThemeDraft(name: name, title: title, mode: .auto, fields: fields, values: out))
    }

    /// The table in one `theme get <section>` reply.
    public static func section(_ reply: ThemeCommandReply) -> [String: Any]? { reply.data["value"] as? [String: Any] }

    public static func == (a: ThemeDraft, b: ThemeDraft) -> Bool {
        a.name == b.name && a.title == b.title && a.mode == b.mode && a.fields == b.fields && a.original == b.original
            && a.values == b.values && a.past == b.past && a.future == b.future
    }

    public subscript(path: String) -> ThemeValue? { values[path] }

    public var canUndo: Bool { !past.isEmpty }
    public var canRedo: Bool { !future.isEmpty }
    public var isEdited: Bool { values != original }

    /// Sets one value. A second edit to the same path within `gestureWindow` joins the first, so one undo takes back a whole drag.
    public mutating func set(_ path: String, _ value: ThemeValue, at time: TimeInterval) {
        guard values[path] != nil, values[path] != value else { return }
        if let l = last, l.path == path, time - l.at < Self.gestureWindow, !past.isEmpty {
            // Same gesture: the step already saved the values from before it began.
        } else {
            past.append(values)
        }
        future = []
        values[path] = value
        last = (path, time)
    }

    /// Several values as one step, such as a palette taken from an image. Unknown paths are left out.
    public mutating func set(_ changes: [String: ThemeValue]) {
        let known = changes.filter { values[$0.key] != nil && values[$0.key] != $0.value }
        guard !known.isEmpty else { return }
        past.append(values)
        future = []
        values.merge(known) { _, new in new }
        last = nil
    }

    public mutating func undo() {
        guard let prev = past.popLast() else { return }
        future.append(values)
        values = prev
        last = nil
    }

    public mutating func redo() {
        guard let next = future.popLast() else { return }
        past.append(values)
        values = next
        last = nil
    }

    /// Back to the theme as it was opened or last saved. Undo brings the edits back.
    public mutating func revert() {
        guard isEdited else { return }
        past.append(values)
        future = []
        values = original
        last = nil
    }

    /// What Save sends: each value that differs from the saved theme, in the editor's order.
    public func changes() -> [(path: String, value: ThemeValue)] {
        fields.compactMap { f in
            guard let v = values[f.path], v != original[f.path] else { return nil }
            return (f.path, v)
        }
    }

    /// After Save worked: what is on disk now. Undo history goes, since it would undo past the file.
    public mutating func saved() {
        original = values
        past = []; future = []; last = nil
    }

    /// One mode's colors by role, for contrast checks.
    public func colors(_ section: String) -> [String: RGB] {
        var out: [String: RGB] = [:]
        for f in fields where f.section == section && f.kind == .color {
            if let c = values[f.path]?.color { out[f.key] = c }
        }
        return out
    }

    /// The draft as `current/theme.json`, for the app's own reader, so the preview draws what Save would.
    public func themeJSON() -> Data {
        var spaces: [String: [String: Any]] = [:]
        for f in fields {
            guard let v = values[f.path] else { continue }
            spaces[f.section, default: [:]][f.key] = v.json
        }
        let root: [String: Any] = ["schema": PolycarpTheme.schema, "mode": mode.rawValue, "name": name, "title": title,
                                   "surfaces": ["spaces": spaces]]
        return (try? JSONSerialization.data(withJSONObject: root, options: [.sortedKeys])) ?? Data()
    }

    /// The draft as the app reads a theme, even while a pair is too faint (the warnings say so). nil if a value is out of range.
    public var preview: PolycarpTheme? {
        if case .success(let t) = PolycarpTheme.parse(themeJSON(), checkContrast: false) { t } else { nil }
    }
}
