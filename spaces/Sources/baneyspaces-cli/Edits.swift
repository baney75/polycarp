import BaneySpacesCore
import Darwin
import Foundation

/// `polycarp-spaces edits …`: the page edits Polycarp's browser extension applies (`EditsOps`, docs/edits.md). It edits
/// edits.json directly, so the app need not run. `--json` prints the `{ok, data}` envelope `surfaces` uses, and
/// `polycarp mcp` passes it on as is.
enum EditsCommand {
    static let usage = """
    usage: polycarp-spaces edits <command> [--json]

      ls                  every edit
      set '<json edit>'   add an edit, or replace the one with its id (`set -` reads it from standard input)
      on <id> | off <id>  turn one on or off and keep it
      rm <id>             remove one
      reset               remove every edit

    An edit: {"id": "quiet-news", "name": "Quiet news", "enabled": true, "sites": ["news.example.com"],
    "paths": ["/story/*"], "changes": [...], "css": "..."}. id is 1 to 64 of a-z, 0-9 and -; sites names at least one
    host, which covers its subdomains; paths empty means the whole site, and * is anything. It needs a change or css.

    A change names where it acts (at, a CSS selector) and what it does:
      {"do": "hide", "at": ".promo"}
      {"do": "style", "at": "article", "style": {"font-size": "18px"}}
      {"do": "text", "at": "h1", "text": "New words"}, or with "find" to replace only those words
      {"do": "attr", "at": "img", "name": "alt", "value": "A map"}   (\(Edits.attributes.joined(separator: ", ")); null removes it)
      {"do": "move", "at": "#toc", "to": "article", "where": "before"}   (\(Edits.wheres.joined(separator: ", ")))
      {"do": "insert", "at": "main", "where": "first", "blocks": [{"kind": "heading", "text": "Notes"},
       {"kind": "text", "text": "..."}, {"kind": "list", "items": ["..."]}, {"kind": "link", "text": "Docs", "url": "https://..."}]}

    An edit changes how a page looks and reads in this browser and nothing else: it can't click, type, submit, load
    anything or run a script, so css may not hold a backslash, url(...), image(...) or an @-rule but @media, @supports,
    @container, @keyframes, @layer and @starting-style. Form fields stay as they are. At most \(Edits.maxEdits) edits of
    \(Edits.maxChanges) changes. Open pages pick a change up within 30 seconds, new pages at once, and the page says once that
    an agent edited it, with Undo.
    """

    static func run(_ args: [String], remote: Bool) -> Never {
        let json = args.contains("--json")
        if remote { finish(.failure(failure("edits changes this Mac's file; run it on the other machine")), json: json) }
        var rest = args.filter { $0 != "--json" }
        let sub = rest.isEmpty ? "help" : rest.removeFirst()
        let file = Edits.path()
        switch (sub, rest.count) {
        case ("ls", 0), ("list", 0): finish(EditsOps.list(file: file), json: json)
        case ("set", 1): finish(EditsOps.set(rest[0] == "-" ? standardInput() : rest[0], file: file), json: json)
        case ("on", 1), ("off", 1): finish(EditsOps.turn(rest[0], on: sub == "on", file: file), json: json)
        case ("rm", 1), ("remove", 1): finish(EditsOps.remove(rest[0], file: file), json: json)
        case ("reset", 0): finish(EditsOps.reset(file: file), json: json)
        case ("help", _), ("-h", _), ("--help", _): print(usage); exit(0)
        default: finish(.failure(failure("usage: polycarp-spaces edits ls | set '<json edit>' | on <id> | off <id> | rm <id> | reset [--json]")), json: json)
        }
    }

    /// One byte past the limit at most: `set` refuses that much as not an edit.
    private static func standardInput() -> String {
        String(decoding: (try? FileHandle.standardInput.read(upToCount: Edits.maxBytes + 1)) ?? Data(), as: UTF8.self)
    }

    private static func failure(_ message: String) -> SurfacesFailure {
        SurfacesFailure("invalid_args", message, suggestion: "Run `polycarp-spaces edits help` for the usage.", exit: 2)
    }

    /// One line an edit: `quiet-news (off): news.example.com/story/*; 2 changes, css`.
    static func line(_ e: SurfaceValue) -> String {
        let o = e.object ?? [:]
        func list(_ key: String) -> [String] { (o[key]?.array ?? []).compactMap(\.string) }
        let count = o["changes"]?.array?.count ?? 0
        var parts = count == 0 ? [] : ["\(count) change\(count == 1 ? "" : "s")"]
        if o["css"]?.string?.isEmpty == false { parts.append("css") }
        let on = o["enabled"] == .bool(false) ? " (off)" : ""
        let name = o["name"]?.string ?? ""
        return "\(o["id"]?.string ?? "?")\(on): \(name.isEmpty ? "" : name + "; ")\((list("sites") + list("paths")).joined(separator: ", ")); \(parts.joined(separator: ", "))"
    }

    private static func text(_ d: SurfaceValue) -> String {
        if let edit = d.object?["edit"] { return (d.object?["replaced"] == .bool(true) ? "replaced " : "added ") + line(edit) }
        let edits = d.object?["edits"]?.array ?? []
        return edits.isEmpty ? "no edits" : edits.map(line).joined(separator: "\n")
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
                FileHandle.standardError.write(([f.message] + [f.suggestion].compactMap { $0 }).joined(separator: "\n").data(using: .utf8)! + Data("\n".utf8))
            }
            exit(f.exit)
        }
    }
}
