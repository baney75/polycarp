import Foundation

/// The `polycarp look` commands Settings runs, and how it reads their answers. A look is the theme, style.css, the surfaces'
/// looks and the paper as one thing (docs/looks.md). The CLI owns every file and every check: the app only asks it.
public enum LookCommands {
    /// The file a look is shared as.
    public static let fileExtension = "polycarp-look"

    public static let list = ["look", "list", "--json"]
    public static let undo = ["look", "undo", "--json"]
    public static func apply(_ name: String) -> [String] { ["look", "apply", name, "--json"] }

    /// `replace` only after the person said yes to it.
    public static func save(_ name: String, title: String, replace: Bool) -> [String] {
        ["look", "save", name, "--title", title] + (replace ? ["--force"] : []) + ["--json"]
    }

    /// The save panel has already asked before it returns a file that is there.
    public static func export(_ name: String, to path: String) -> [String] { ["look", "export", name, path, "--force", "--json"] }

    /// Checked and saved, not put on.
    public static func importFile(_ path: String, replace: Bool) -> [String] {
        ["look", "import", path] + (replace ? ["--force"] : []) + ["--json"]
    }

    /// The name a typed title is saved under: lowercase ASCII letters and digits with one hyphen between words, as the CLI
    /// asks. Nil when the title has none, or is the shipped look's name.
    public static func name(for title: String) -> String? {
        let plain = title.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
        let words = plain.split { !($0.isASCII && ($0.isLetter || $0.isNumber)) }
        var name = String(words.joined(separator: "-").prefix(48))
        while name.hasSuffix("-") { name.removeLast() }
        return name.isEmpty || name == shipped ? nil : name
    }

    public static let shipped = "polycarp"
}

extension ThemeCommandReply {
    /// One look from `look list`.
    public struct Look: Equatable, Sendable, Identifiable {
        public let name: String
        public let title: String
        public let shipped: Bool
        /// In force: how everything looks now is this look.
        public let current: Bool
        /// Page, surface, text and accent, light then dark; empty when the look can't be used.
        public let light: [RGB]
        public let dark: [RGB]
        /// The CLI's words for why it can't be used, or none.
        public let problem: String?
        public var id: String { name }

        public init(name: String, title: String, shipped: Bool, current: Bool, light: [RGB], dark: [RGB], problem: String?) {
            self.name = name; self.title = title; self.shipped = shipped; self.current = current
            self.light = light; self.dark = dark; self.problem = problem
        }
    }

    public var looks: [Look] {
        (data["looks"] as? [[String: Any]] ?? []).compactMap { l in
            guard let name = l["name"] as? String else { return nil }
            let colors = l["colors"] as? [String: Any]
            func of(_ mode: String) -> [RGB] {
                let c = colors?[mode] as? [String: Any] ?? [:]
                return ["background", "surface", "foreground", "accent"].compactMap { (c[$0] as? String).flatMap(RGB.init(hex:)) }
            }
            let problems = l["problems"] as? [String] ?? []
            return Look(name: name, title: l["title"] as? String ?? name, shipped: l["source"] as? String == "shipped",
                        current: l["current"] as? Bool ?? false, light: of("light"), dark: of("dark"),
                        problem: problems.isEmpty ? (colors == nil ? "This look can't be used." : nil) : problems.joined(separator: "\n"))
        }
    }

    /// Whether `look undo` has anything to go back to.
    public var canUndoLook: Bool { data["can_undo"] as? Bool ?? false }

    /// What a command that worked left out or left alone, in the CLI's words.
    public var notes: [String] { data["notes"] as? [String] ?? [] }
}
