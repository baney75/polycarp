import Foundation

/// `polycarp-spaces agent <verb> --help` (or `-h`): that verb's usage, exit 0, before anything reaches the app. Without it,
/// `agent move --help` searched for a window named "--help" and `agent lend --help` asked Donovan to lend an app of that
/// name. Weak models reach for --help first, so every verb answers it the same way.
public enum AgentHelp {
    public static let words: Set<String> = ["--help", "-h"]

    /// The session verbs' flags that take a value, so `--for -h` is a duration, not a request for help.
    static let valued: Set<String> = ["--for", "--session", "--window", "--frame", "--dir", "--on"]

    /// Whether `rest` (the words after `agent`) asks for help: `--help` or `-h` before any `--` (`agent run -- tool --help`
    /// is the tool's, and `agent type -- -h` types it), and not as the value of a flag that takes one (`agent find --name -h`).
    public static func asked(_ rest: [String]) -> Bool {
        guard let verb = rest.first else { return false }
        if words.contains(verb) { return true }
        var takes = valued
        if let tool = HandsTools.tool(verb: verb) {
            let flags: [String] = tool.params.filter { !$0.positional && $0.kind != .boolean }.map { "--" + $0.name }
            takes = Set(flags)
        }
        var previous: String?
        for word in rest.dropFirst() {
            if word == "--" { return false }
            let isValue = previous.map { takes.contains($0) } ?? false
            if words.contains(word), !isValue { return true }
            previous = word
        }
        return false
    }

    /// The help for `verb`: a hands verb's usage line, summary and options; a session verb's lines from `usage` (with
    /// their continuation lines); `agent move` has both. A verb with neither, or no verb, gets every `agent` line.
    public static func text(verb: String?, usage: String) -> String {
        let lines = usage.components(separatedBy: "\n")
        var agent: [String] = [], mine: [String] = []
        var inMine = false, inAgent = false
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let continuation = line.hasPrefix(String(repeating: " ", count: 30)) && !trimmed.isEmpty
            if continuation {
                if inAgent { agent.append(line) }
                if inMine { mine.append(line) }
                continue
            }
            inAgent = trimmed.hasPrefix("agent ")
            // The hands verbs' line lists every verb; a hands verb's help comes from its tool instead.
            inMine = inAgent && !trimmed.hasPrefix("agent " + HandsTools.verbLine) && verb.map { names(trimmed).contains($0) } == true
            if inAgent { agent.append(line) }
            if inMine { mine.append(line) }
        }
        var out: [String] = []
        if let verb, let tool = HandsTools.tool(verb: verb), !HandsTools.userOnly.contains(verb) {
            out.append("usage: " + HandsParse.usageLine(tool))
            out.append("  " + tool.summary)
            for p in tool.params {
                let name: String = p.positional ? "<\(p.name)>" : "--\(p.name)"
                out.append("  \(name): \(p.help)")
            }
            out.append("  Prints one JSON envelope.")
        }
        if !mine.isEmpty { out.append(contentsOf: (out.isEmpty ? ["usage:"] : ["", "also:"]) + mine) }
        return out.isEmpty ? (["usage:"] + agent).joined(separator: "\n") : out.joined(separator: "\n")
    }

    /// The verbs a usage line names: its first word's alternatives, and any written after an argument (`agent status|on
    /// [N]|off` names status, on and off; `agent cursor on|theme <name>|status` names only cursor).
    static func names(_ line: String) -> Set<String> {
        let command = line.dropFirst("agent ".count).components(separatedBy: "   ").first ?? ""
        let tokens = command.split(separator: " ")
        var verbs = Set((tokens.first ?? "").split(separator: "|").map(String.init))
        for token in tokens.dropFirst() {
            let alternatives = token.split(separator: "|")
            if alternatives.count > 1, alternatives[0].hasSuffix("]") { verbs.formUnion(alternatives.dropFirst().map(String.init)) }
        }
        return verbs
    }
}
