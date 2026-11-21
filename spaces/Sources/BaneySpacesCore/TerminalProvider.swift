import Foundation

/// The launcher's rows for the built-in terminal: a shell, Claude Code or Codex in a Polycarp terminal window, the quick
/// terminal, and "ssh <device>" (or "term <device>") for a shell on a tailnet device. From memory, no I/O.
public final class TerminalProvider: LauncherProvider {
    public let name = "terminal"
    public init() {}

    private struct Row {
        let id: String, words: [String], title: String, subtitle: String, symbol: String, launch: TerminalLaunch
    }

    private static let rows: [Row] = [
        Row(id: "shell", words: ["terminal", "shell", "polycarp terminal"], title: "Polycarp Terminal",
            subtitle: "A new terminal window, Ghostty's engine inside Polycarp", symbol: "terminal", launch: .init()),
        Row(id: "quick", words: ["quick terminal", "terminal", "drop down"], title: "Quick Terminal",
            subtitle: "Drops down from the top of the screen (⌃`)", symbol: "rectangle.topthird.inset.filled",
            launch: .init(quick: true)),
        Row(id: "claude", words: ["claude", "claude code"], title: "Claude Code in Polycarp Terminal",
            subtitle: "Runs claude in a new terminal window", symbol: "sparkle", launch: .init(preset: .claude)),
        Row(id: "codex", words: ["codex"], title: "Codex in Polycarp Terminal",
            subtitle: "Runs codex in a new terminal window", symbol: "chevron.left.forwardslash.chevron.right",
            launch: .init(preset: .codex)),
    ]

    public func results(for query: String) -> [LauncherResult] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard q.count >= 2 else { return [] }
        // "ssh parish1", "term chapel1": a shell on that device, when the name is one a tailnet can have.
        for verb in ["ssh ", "term "] where q.hasPrefix(verb) {
            let host = String(query.trimmingCharacters(in: .whitespaces).dropFirst(verb.count)).trimmingCharacters(in: .whitespaces)
            guard TerminalLaunch.validHost(host) else { return [] }
            return [LauncherResult(id: "terminal:host:\(host)", section: "Terminal", title: "Terminal on \(host)",
                                   subtitle: "A shell there over Tailscale, in a Polycarp terminal", symbol: "network",
                                   placement: .top, action: .terminal(.init(host: host)))]
        }
        return Self.rows.filter { r in r.words.contains { $0.hasPrefix(q) } }.map { r in
            LauncherResult(id: "terminal:\(r.id)", section: "Terminal", title: r.title, subtitle: r.subtitle,
                           symbol: r.symbol, action: .terminal(r.launch))
        }
    }
}
