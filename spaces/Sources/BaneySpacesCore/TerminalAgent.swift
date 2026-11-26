import Foundation

/// A coding agent that runs in a terminal, offered by the launcher when its name is typed:
/// "claude" opens Claude Code in your terminal, "codex" opens Codex, "eukhe" opens Local Studio's own
/// agent, which runs a local model. Only agents found on this Mac are offered.
public struct TerminalAgent: Equatable, Sendable {
    public let name: String
    /// The program to run. Fixed here, never typed, so nothing from the search reaches a shell.
    public let command: String

    public static let all = [TerminalAgent(name: "Claude Code", command: "claude"), TerminalAgent(name: "Codex", command: "codex"),
                             TerminalAgent(name: "Eukhe", command: "eukhe")]

    /// Where the installers put them, for a check that doesn't need a shell. Eukhe ships inside
    /// Local Studio's app and is not on PATH, so the app's own folder is listed too.
    public static let folders = ["~/.local/bin", "~/.claude/local", "/opt/homebrew/bin", "/usr/local/bin",
                                 "~/.npm-global/bin", "~/.bun/bin", "~/.volta/bin",
                                 "/Applications/Local Studio Nightly.app/Contents/MacOS",
                                 "/Applications/Local Studio.app/Contents/MacOS"]

    /// The installed agents that answer `query`: by the start of a word in the name or the
    /// command ("cl", "code", "codex"), not by letters scattered through it.
    public static func matches(_ query: String, installed: some Collection<String>) -> [TerminalAgent] {
        all.filter { installed.contains($0.command) }
            .compactMap { a -> (TerminalAgent, Int)? in
                let s = max(Fuzzy.score(query, a.name) ?? -1, Fuzzy.score(query, a.command) ?? -1)
                return s >= 600 ? (a, s) : nil
            }
            .sorted { $0.1 > $1.1 }
            .map(\.0)
    }
}

/// A command Ghostty runs itself (its `command` setting, through `/bin/sh -c`): zsh running the script file, the path
/// single-quoted. A window made this way never shows Ghostty's "Allow Ghostty to execute …?", which only its
/// open-a-file path asks.
public enum GhosttyRun {
    public static func command(script path: String) -> String {
        "/bin/zsh '" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

/// The terminal every Mac has. It opens programs on a new Mac, so that is nobody's choice of it.
public enum TerminalChoice {
    public static let terminal = "com.apple.Terminal"
}
