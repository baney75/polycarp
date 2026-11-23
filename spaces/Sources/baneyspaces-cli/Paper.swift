import BaneySpacesCore
import Darwin
import Foundation

/// `polycarp-spaces paper …`: what lies behind the desktop, the new tab page and the idle screen, in one command
/// (`PaperOps`, docs/surfaces.md). It edits surfaces.json directly, so a running app shows it within 150 ms.
/// `--json` prints the `{ok, data}` envelope `surfaces` uses, and `polycarp mcp` passes it on as is.
enum PaperCommand {
    static let usage = """
    usage: polycarp-spaces paper <command> [--json]

      set <what> [--on desktop,newtab,idle|all]   the paper for those places (default all)
      get                                         each place's paper and where it comes from
      reset [--on desktop,newtab,idle|all]        those places back to what they showed before paper

    <what> is a picture (.png, .jpg, .heic or .webp), an https URL to one (fetched once, at most 25 MB),
    a color as #RRGGBB, or a scene: field, olive, water, parchment, solid (the theme's own).
    A picture is copied into Papers/ beside surfaces.json; you never name it yourself.
    A paper wins over the theme's wallpaper; reset brings the theme's back. Docs: docs/surfaces.md.
    """

    static func run(_ args: [String], remote: Bool) -> Never {
        let json = args.contains("--json")
        if remote { finish(.failure(failure("paper changes this Mac's file; run it on the other machine")), json: json) }
        var rest = args.filter { $0 != "--json" }
        let sub = rest.isEmpty ? "help" : rest.removeFirst()
        var places = Set(PaperPlace.allCases)
        if let i = rest.firstIndex(of: "--on") {
            guard i + 1 < rest.count, let p = PaperPlace.parse(rest[i + 1]) else {
                finish(.failure(failure("--on takes desktop, newtab, idle or all, joined with commas (--on desktop,newtab)")), json: json)
            }
            places = p
            rest.removeSubrange(i...i + 1)
        }
        let file = SurfacesFile.path()
        switch sub {
        case "set":
            guard rest.count == 1 else { finish(.failure(failure("usage: polycarp-spaces paper set <what> [--on desktop,newtab,idle|all] [--json]")), json: json) }
            finish(PaperOps.set(rest[0], on: places, file: file, cwd: FileManager.default.currentDirectoryPath), json: json, text: lines)
        case "get":
            guard rest.isEmpty, !args.contains("--on") else { finish(.failure(failure("usage: polycarp-spaces paper get [--json]")), json: json) }
            finish(PaperOps.get(file: file), json: json, text: lines)
        case "reset":
            guard rest.isEmpty else { finish(.failure(failure("usage: polycarp-spaces paper reset [--on desktop,newtab,idle|all] [--json]")), json: json) }
            finish(PaperOps.reset(on: places, file: file), json: json, text: lines)
        case "help", "-h", "--help":
            print(usage); exit(0)
        default:
            finish(.failure(failure("usage: polycarp-spaces paper set|get|reset (polycarp-spaces paper help)")), json: json)
        }
    }

    private static func failure(_ message: String) -> SurfacesFailure {
        SurfacesFailure("invalid_args", message, suggestion: "Run `polycarp-spaces paper help` for the usage.", exit: 2)
    }

    /// One line a place: `desktop: picture ~/.../paper-x.jpg (from paper)`, or `as before paper`.
    private static func lines(_ d: [String: SurfaceValue]) -> String {
        PaperPlace.allCases.map { place in
            let o = d[place.rawValue]?.object ?? [:]
            guard let v = o["value"]?.string else { return "\(place.rawValue): no paper (as before paper)" }
            let shown = o["picture"]?.string.map { "picture " + $0 + (o["missing"] == .bool(true) ? " (missing)" : "") } ?? v
            return "\(place.rawValue): \(shown) (from \(o["from"]?.string ?? "paper"))"
        }.joined(separator: "\n")
    }

    private static func finish(_ r: SurfacesOps.Result, json: Bool, text: ([String: SurfaceValue]) -> String = { _ in "" }) -> Never {
        switch r {
        case .success(let data):
            print(json ? SurfacesOps.ok(data).json(pretty: true) : text(data.object ?? [:]))
            exit(0)
        case .failure(let f):
            if json {
                print(f.envelope.json(pretty: true))
            } else {
                var out = [f.message]
                if f.issues.count > 1 { out += f.issues.map { "  \($0)" } }
                if let s = f.suggestion { out.append(s) }
                FileHandle.standardError.write((out.joined(separator: "\n") + "\n").data(using: .utf8)!)
            }
            exit(f.exit)
        }
    }
}
