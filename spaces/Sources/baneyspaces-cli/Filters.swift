import BaneySpacesCore
import Darwin
import Foundation

/// `polycarp-spaces filters …`: the feed filters and page edits Polycarp's browser extension applies (`FiltersOps`,
/// docs/guide.md). It edits filters.json directly, so the app need not run. `--json` prints the `{ok, data}` envelope
/// `surfaces` uses, and `polycarp mcp` passes it on as is.
enum FiltersCommand {
    static let usage = """
    usage: polycarp-spaces filters <command> [--json]

      ls                  every rule
      set '<json rule>'   add a rule, or replace the one with its id
      rm <id>             remove a rule
      reset               remove every rule

    A rule: {"id": "no-shorts", "enabled": true, "sites": ["youtube.com"], "words": [...], "patterns": [...],
    "accounts": ["@name"], "kinds": ["shorts", "promoted", "reposts"], "hide": ["css selector"]}.
    id is 1 to 64 of a-z, 0-9 and -. sites empty means every site; hide needs sites. A rule needs at least one of
    words, patterns (JavaScript regex), accounts, kinds or hide. At most 200 rules, 200 entries a list, 200
    characters an entry. Matching posts on X, YouTube, Reddit, Hacker News, Bluesky, LinkedIn and Mastodon hide
    behind a Show bar; open pages pick a change up within 30 seconds, new pages at once.
    """

    static func run(_ args: [String], remote: Bool) -> Never {
        let json = args.contains("--json")
        if remote { finish(.failure(failure("filters changes this Mac's file; run it on the other machine")), json: json) }
        var rest = args.filter { $0 != "--json" }
        let sub = rest.isEmpty ? "help" : rest.removeFirst()
        let file = Filters.path()
        switch (sub, rest.count) {
        case ("ls", 0), ("list", 0): finish(FiltersOps.list(file: file), json: json)
        case ("set", 1): finish(FiltersOps.set(rest[0], file: file), json: json)
        case ("rm", 1), ("remove", 1): finish(FiltersOps.remove(rest[0], file: file), json: json)
        case ("reset", 0): finish(FiltersOps.reset(file: file), json: json)
        case ("help", _), ("-h", _), ("--help", _): print(usage); exit(0)
        default: finish(.failure(failure("usage: polycarp-spaces filters ls | set '<json rule>' | rm <id> | reset [--json]")), json: json)
        }
    }

    private static func failure(_ message: String) -> SurfacesFailure {
        SurfacesFailure("invalid_args", message, suggestion: "Run `polycarp-spaces filters help` for the usage.", exit: 2)
    }

    /// One line a rule: `no-shorts (off): youtube.com; kinds shorts`.
    static func line(_ r: SurfaceValue) -> String {
        let o = r.object ?? [:]
        var parts: [String] = []
        for key in ["words", "patterns", "accounts", "kinds", "hide"] {
            let l = (o[key]?.array ?? []).compactMap(\.string)
            if !l.isEmpty { parts.append("\(key) " + l.joined(separator: ", ")) }
        }
        let sites = (o["sites"]?.array ?? []).compactMap(\.string)
        let off = o["enabled"] == .bool(false) ? " (off)" : ""
        return "\(o["id"]?.string ?? "?")\(off): \(sites.isEmpty ? "every site" : sites.joined(separator: ", ")); "
            + parts.joined(separator: "; ")
    }

    private static func text(_ d: SurfaceValue) -> String {
        if let rule = d.object?["filter"] { return (d.object?["replaced"] == .bool(true) ? "replaced " : "added ") + line(rule) }
        let rules = d.object?["filters"]?.array ?? []
        return rules.isEmpty ? "no filters" : rules.map(line).joined(separator: "\n")
    }

    private static func finish(_ r: SurfacesOps.Result, json: Bool) -> Never {
        switch r {
        case .success(let data):
            print(json ? SurfacesOps.ok(data).json(pretty: true) : text(data))
            exit(0)
        case .failure(let f):
            if json {
                print(f.envelope.json(pretty: true))
            } else {
                var out = [f.message]
                if let s = f.suggestion { out.append(s) }
                FileHandle.standardError.write((out.joined(separator: "\n") + "\n").data(using: .utf8)!)
            }
            exit(f.exit)
        }
    }
}
