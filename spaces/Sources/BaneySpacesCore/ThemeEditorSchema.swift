import Foundation

// The theme editor's fields, read from `polycarp theme schema --json` at run time. A field the CLI
// adds shows up in Settings with no change here: its JSON Schema type picks the control.

/// One value a theme sets, such as `light.accent` or `shape.radius`.
public struct ThemeField: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable {
        /// `#rrggbb`.
        case color
        case integer(min: Int, max: Int)
        case number(min: Double, max: Double)
        /// One of a fixed list, in the schema's order.
        case choice([String])
        case toggle
        /// Free text the CLI checks, such as a font stack or an easing.
        case text
    }

    public let section: String
    public let key: String
    public let kind: Kind
    /// The schema's description: what the value changes and what it must be.
    public let help: String

    public init(section: String, key: String, kind: Kind, help: String) {
        self.section = section; self.key = key; self.kind = kind; self.help = help
    }

    public var path: String { "\(section).\(key)" }
    public var id: String { path }

    /// "radius_small" reads "Radius small"; "on_accent" reads "On accent".
    public var label: String {
        let words = key.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}

/// A part of the theme with its fields in the order the editor shows them.
public struct ThemeFieldSection: Equatable, Sendable, Identifiable {
    public let name: String
    public let help: String
    public let fields: [ThemeField]
    public var id: String { name }

    public init(name: String, help: String, fields: [ThemeField]) { self.name = name; self.help = help; self.fields = fields }

    public var title: String {
        switch name {
        case "light": "Light colors"
        case "dark": "Dark colors"
        default: name.prefix(1).uppercased() + name.dropFirst()
        }
    }
}

public enum ThemeEditorSchema {
    /// Colors the way a person reads a theme: page, then text, then lines and fills, then status. A role the
    /// CLI adds later comes after these, by name.
    static let order = [
        "background", "surface", "sunken", "foreground", "strong", "muted", "border", "selection", "accent", "on_accent",
        "urgent", "working", "done",
        "radius_small", "radius", "radius_large", "border_width", "blur", "shadow", "density", "indicator",
        "ui", "display", "mono", "size", "weight", "line_height",
        "fast", "normal", "slow", "easing", "scale_from", "reduced",
    ]
    static let colorPattern = "^#[0-9a-fA-F]{6}$"

    /// Reads the schema, bare or inside the CLI's `{ok, data: {schema}}` envelope.
    public static func parse(_ data: Data) -> Result<[ThemeFieldSection], PolycarpThemeError> {
        guard let any = try? JSONSerialization.jsonObject(with: data), var root = any as? [String: Any] else {
            return .failure(.init("the schema is not a JSON object"))
        }
        if let d = root["data"] as? [String: Any], let s = d["schema"] as? [String: Any] { root = s }
        guard let props = root["properties"] as? [String: Any], let defs = root["$defs"] as? [String: Any] else {
            return .failure(.init("the schema has no properties"))
        }
        let names = ((root["x-paths"] as? [String: Any])?["sections"] as? [String]) ?? ["light", "dark", "shape", "type", "motion"]
        var out: [ThemeFieldSection] = []
        for name in names {
            guard let p = props[name] as? [String: Any] else { continue }
            let body: [String: Any]
            if let ref = p["$ref"] as? String, ref.hasPrefix("#/$defs/"), let d = defs[String(ref.dropFirst("#/$defs/".count))] as? [String: Any] {
                body = d
            } else {
                body = p
            }
            guard let fields = body["properties"] as? [String: Any] else { continue }
            let parsed = fields.compactMap { key, v -> ThemeField? in
                guard let f = v as? [String: Any] else { return nil }
                return ThemeField(section: name, key: key, kind: kind(f), help: (f["description"] as? String) ?? "")
            }
            out.append(ThemeFieldSection(name: name, help: (p["description"] as? String) ?? "", fields: sorted(parsed)))
        }
        return out.isEmpty ? .failure(.init("the schema lists no sections")) : .success(out)
    }

    static func kind(_ f: [String: Any]) -> ThemeField.Kind {
        func num(_ k: String) -> Double? { (f[k] as? NSNumber)?.doubleValue }
        switch f["type"] as? String {
        case "integer": return .integer(min: Int(num("minimum") ?? 0), max: Int(num("maximum") ?? 1000))
        case "number": return .number(min: num("minimum") ?? 0, max: num("maximum") ?? 1)
        case "boolean": return .toggle
        default:
            if let options = f["enum"] as? [String], !options.isEmpty { return .choice(options) }
            if f["pattern"] as? String == colorPattern { return .color }
            return .text
        }
    }

    static func sorted(_ fields: [ThemeField]) -> [ThemeField] {
        fields.sorted { a, b in
            let ia = order.firstIndex(of: a.key) ?? Int.max, ib = order.firstIndex(of: b.key) ?? Int.max
            return ia != ib ? ia < ib : a.key < b.key
        }
    }
}
