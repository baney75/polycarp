import Foundation

/// The `polycarp theme` commands the editor runs, and how it reads their answers. The CLI owns every file: the app never
/// writes or checks theme TOML itself.
public enum ThemeEditorCommands {
    public static let schema = ["theme", "schema", "--json"]
    public static let list = ["theme", "list", "--json"]

    /// One section of the theme's own values, the ones `theme change` edits. The editor runs this for each section.
    public static func section(_ section: String, of name: String) -> [String] { ["theme", "get", section, name, "--json"] }

    /// Customize: a user theme that starts as `base` and changes nothing yet.
    public static func create(_ name: String, extends base: String) -> [String] { ["theme", "create", name, "--extends", base, "--json"] }

    /// Save: every change in one command, so one `polycarp theme undo` takes it all back and a refusal changes nothing.
    public static func save(_ name: String, _ changes: [(path: String, value: ThemeValue)]) -> [String] {
        ["theme", "change"] + changes.flatMap { [$0.path, $0.value.argument] } + ["--theme", name, "--json"]
    }

    /// Checks a theme sent on standard input, without the file-name rule a dropped file would fail.
    public static let validateInput = ["theme", "validate", "-", "--json"]

    /// Import: saved as a user theme, not put in use.
    public static func importFile(_ path: String) -> [String] { ["theme", "apply", path, "--no-activate", "--json"] }

    public static func exportTOML(_ name: String) -> [String] { ["theme", "export", "toml", name, "--json"] }
    public static func editPath(_ name: String) -> [String] { ["theme", "edit-path", name, "--json"] }

    /// A free name for a copy of `base`: `base-custom`, then `base-custom-2` and on, the way `theme change` names its copies.
    public static func copyName(_ base: String, taken: Set<String>) -> String {
        let first = "\(base)-custom"
        if !taken.contains(first) { return first }
        var n = 2
        while taken.contains("\(first)-\(n)") { n += 1 }
        return "\(first)-\(n)"
    }
}

/// The CLI's `--json` envelope: `{ok: true, data}` or `{ok: false, error: {code, message, data: {errors: [{message}]}}}`.
public struct ThemeCommandReply: @unchecked Sendable {
    public let ok: Bool
    public let data: [String: Any]
    public let code: String?
    /// The CLI's own words: its message, then each problem it named, one a line. Shown as they are.
    public let message: String

    public init(stdout: Data, stderr: Data = Data(), status: Int32) {
        let root = (try? JSONSerialization.jsonObject(with: stdout)) as? [String: Any]
        if let root, root["ok"] as? Bool == true {
            ok = true; data = root["data"] as? [String: Any] ?? [:]; code = nil; message = ""
            return
        }
        ok = false
        data = [:]
        if let e = root?["error"] as? [String: Any] {
            code = e["code"] as? String
            let head = e["message"] as? String ?? "the command failed"
            let problems = ((e["data"] as? [String: Any])?["errors"] as? [[String: Any]] ?? []).compactMap { $0["message"] as? String }
            message = ([head] + problems.filter { $0 != head }).joined(separator: "\n")
        } else {
            code = nil
            let err = String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            message = err.isEmpty ? "polycarp exited with status \(status)" : err
        }
    }

    /// One theme from `theme list`.
    public struct Listed: Equatable, Sendable, Identifiable {
        public let name: String
        public let title: String
        public let builtIn: Bool
        public let current: Bool
        public var id: String { name }
        public init(name: String, title: String, builtIn: Bool, current: Bool) {
            self.name = name; self.title = title; self.builtIn = builtIn; self.current = current
        }
    }

    public var themes: [Listed] {
        (data["themes"] as? [[String: Any]] ?? []).compactMap { t in
            guard let name = t["name"] as? String else { return nil }
            return Listed(name: name, title: t["title"] as? String ?? name, builtIn: t["source"] as? String == "built-in",
                          current: t["current"] as? Bool ?? false)
        }
    }
}

/// What to do with a theme file dropped on Settings, once the CLI has said it is valid and what it is called.
public enum ThemeImportDecision: Equatable, Sendable {
    /// A built-in has this name, and built-ins are never replaced.
    case refuse(String)
    /// A theme of the person's own has this name: replace it only if they say so.
    case ask(String)
    case save
}

public enum ThemeImport {
    public static func decide(name: String, themes: [ThemeCommandReply.Listed]) -> ThemeImportDecision {
        guard let same = themes.first(where: { $0.name == name }) else { return .save }
        if same.builtIn {
            return .refuse("\"\(name)\" is the name of a built-in theme, which can't be replaced. Change the name in the file, then drop it again.")
        }
        return .ask("You already have a theme named \"\(name)\". Replace it with the dropped file?")
    }

    /// Files the Appearance tab takes: theme files, and pictures for a palette.
    public enum Dropped: Equatable, Sendable { case theme, picture, other }

    public static func kind(_ path: String) -> Dropped {
        switch (path as NSString).pathExtension.lowercased() {
        case "toml": .theme
        case "png", "jpg", "jpeg", "heic", "gif", "tif", "tiff", "webp", "bmp": .picture
        default: .other
        }
    }
}
