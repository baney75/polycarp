import Foundation

/// The default apps in the launcher: a job by its name, "terminal here", "set default browser", and "> fix the build" for
/// your agent. Pure; the launcher draws the rows and carries them out.
public enum RoleSearch {
    public enum Action: Equatable, Sendable {
        case open(AppRole)
        /// A new window of the terminal where you were working.
        case terminalHere
        /// Settings, where it is chosen.
        case choose(AppRole)
        case ask(String)
    }

    public struct Row: Equatable, Sendable {
        public let id: String
        public let title: String
        public let subtitle: String
        public let action: Action
        public let app: DefaultCandidate?

        /// The job the row is about.
        public var role: AppRole {
            switch action {
            case .open(let r), .choose(let r): r
            case .terminalHere: .terminal
            case .ask: .agent
            }
        }
    }

    /// What people call a job, beside its own name.
    static let names: [AppRole: [String]] = [
        .agent: ["agent", "ai"], .browser: ["browser", "web"], .terminal: ["terminal", "shell"], .editor: ["editor", "code"],
        .files: ["files", "file manager"], .mail: ["mail", "email"], .messages: ["messages", "texts"], .calendar: ["calendar"],
        .notes: ["notes"], .music: ["music"], .passwords: ["passwords", "password manager"],
    ]

    /// "> fix the build" or "> agent fix the build". A ">" alone is the Do room's mark (`Room.mark`), so it needs words.
    public static func prompt(_ typed: String) -> String? {
        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix(">") else { return nil }
        var words = t.dropFirst().drop(while: \.isWhitespace)
        if words.lowercased().hasPrefix("agent"), words.dropFirst(5).first?.isWhitespace == true {
            words = words.dropFirst(5).drop(while: \.isWhitespace)
        }
        return words.isEmpty ? nil : String(words)
    }

    /// The row for a prompt: Return sends it, nothing before that does.
    public static func ask(_ prompt: String, _ agent: ResolvedDefault?) -> Row {
        let name = agent?.app?.name
        return Row(id: "role:ask", title: "Ask \(name ?? "your agent") “\(prompt)”",
                   subtitle: name == nil ? "Asks which agent first" : "Opens it where you are working, with this as the first message",
                   action: .ask(prompt), app: agent?.app)
    }

    /// `folder` is where you were working, as it is shown.
    public static func rows(_ typed: String, _ resolved: [AppRole: ResolvedDefault], folder: String?) -> [Row] {
        let q = typed.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard let first = q.first, q.joined().count >= 3 else { return [] }
        var out: [Row] = []
        let setting = "set".hasPrefix(first) && q.count > 1 || "default".hasPrefix(first) && first.count > 2 || first == "choose"
        for role in AppRole.allCases {
            let called = names[role] ?? [role.rawValue], r = resolved[role]
            if !setting, r?.app != nil || role.asksWhenUnset, called.contains(where: { starts($0, q) || q.count > 1 && starts("open " + $0, q) }) {
                out.append(Row(id: "role:\(role.rawValue)", title: r?.app?.name ?? role.title,
                               subtitle: "Your \(role == .agent ? role.title : role.title.lowercased()) · \(r?.app == nil ? "asks which first" : r!.said)",
                               action: .open(role), app: r?.app))
            }
            if setting, called.contains(where: { starts("set default " + $0, q) || starts("default " + $0, q) || starts("choose " + $0, q) || starts("set " + $0, q) }) {
                out.append(Row(id: "role-set:\(role.rawValue)", title: "Set default \(role == .agent ? role.title : role.title.lowercased())…",
                               subtitle: r?.app.map { "Now \($0.name)" } ?? "None chosen", action: .choose(role), app: r?.app))
            }
        }
        if let t = resolved[.terminal]?.app, q.count > 1, ["open terminal here", "terminal here"].contains(where: { starts($0, q) }) {
            out.append(Row(id: "role:terminal-here", title: "Open terminal here", subtitle: "\(t.name) · \(folder ?? "~")", action: .terminalHere, app: t))
        }
        return out
    }

    /// Whether the words typed so far are the start of `name`: whole words, then the start of one.
    private static func starts(_ name: String, _ typed: [String]) -> Bool {
        let words = name.split(separator: " ").map(String.init)
        guard typed.count <= words.count, let last = typed.last else { return false }
        return zip(typed.dropLast(), words).allSatisfy { $0 == $1 } && words[typed.count - 1].hasPrefix(last)
    }

    /// The web agent a "?" question goes to when none was picked: the one your agent is, where it has a page that takes one.
    public static func webAgent(_ app: DefaultApp?) -> String? {
        switch app {
        case .command("claude"), .app("com.anthropic.claudefordesktop"): "claude"
        case .command("codex"), .app("com.openai.chat"), .app("com.openai.codex"): "chatgpt"
        case .command("grok"): "grok"
        case .command("copilot"): "copilot"
        default: nil
        }
    }
}
