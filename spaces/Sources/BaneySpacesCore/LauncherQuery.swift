import Foundation

/// `polycarp-spaces launcher query <text>`: the rows the launcher's main search lists for what's typed, with no panel on
/// any screen, so an agent (or the live check) can see the ranking and use the launcher. The app answers from the panel's
/// own row builder (`LauncherModel.queryRows`). Read only: it records no pick, and what's typed goes into the reply and
/// nowhere else (the request carries it in `target`, which no trace line prints; the timing line has only a time and a count).
public struct LauncherQueryRow: Codable, Equatable, Sendable {
    /// The row's id in the panel: `app:<path>`, `ws:3`, `cmd:Lock Screen`, `session:<id>`, `file:<path>`, …
    public var id: String
    /// app, file, workspace, command, menu, session, agent, web, install, or a provider's name (calc).
    public var kind: String
    public var title: String
    public var subtitle: String
    public var section: String

    public init(id: String, kind: String, title: String, subtitle: String, section: String) {
        self.id = id; self.kind = kind; self.title = title; self.subtitle = subtitle; self.section = section
    }
}

public enum LauncherQuery {
    public static let usage = "usage: polycarp-spaces launcher query <text> [--json] [--limit N]"
    public static let defaultLimit = 10
    public static let maxLimit = 50

    public struct Args: Equatable, Sendable {
        public var query: String
        public var json: Bool
        public var limit: Int
    }

    /// The words after `launcher query`. Nil (a usage error) for nothing to search, an unknown flag or a bad limit.
    /// Words after `--` are the query even when they look like flags.
    public static func parse(_ args: [String]) -> Args? {
        var words: [String] = []
        var json = false
        var limit = defaultLimit
        var i = 0
        while i < args.count {
            let a = args[i]
            if a == "--" { words += args[(i + 1)...]; break }
            switch a {
            case "--json": json = true
            case "--limit":
                guard i + 1 < args.count, let n = Int(args[i + 1]), (1...maxLimit).contains(n) else { return nil }
                limit = n
                i += 1
            default:
                if a.hasPrefix("--") { return nil }
                words.append(a)
            }
            i += 1
        }
        let query = words.joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return query.isEmpty ? nil : Args(query: query, json: json, limit: limit)
    }

    /// The limit a request asked for (`args[0]`), kept within 1 to `maxLimit`.
    public static func limit(_ args: [String]?) -> Int {
        min(max(args?.first.flatMap(Int.init) ?? defaultLimit, 1), maxLimit)
    }

    /// What a row is, from its panel id.
    public static func kind(id: String) -> String {
        if id.hasPrefix("provider:") { return String(id.dropFirst("provider:".count).prefix { $0 != ":" }) }
        if id == "find-install" { return "install" }
        if id.hasPrefix("bang") { return "web" }
        let kinds = ["app": "app", "file": "file", "ws": "workspace", "cmd": "command", "scope": "menu",
                     "session": "session", "agent": "agent"]
        return id.firstIndex(of: ":").flatMap { kinds[String(id[..<$0])] } ?? "other"
    }

    /// One row a line: title, kind and id, tab separated.
    public static func text(_ rows: [LauncherQueryRow]) -> String {
        rows.map { "\($0.title)\t\($0.kind)\t\($0.id)" }.joined(separator: "\n")
    }

    public static func json(_ rows: [LauncherQueryRow]) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return String(decoding: (try? enc.encode(rows)) ?? Data("[]".utf8), as: UTF8.self)
    }

    /// The timing.log line: when, how long and how many rows. Never what was typed.
    public static func timingLine(at date: Date, ms: Double, rows: Int) -> String {
        "\(Int(date.timeIntervalSince1970)) launcher query=\(Int(ms.rounded())) rows=\(rows)"
    }
}
