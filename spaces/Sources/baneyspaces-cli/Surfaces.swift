import BaneySpacesCore
import Darwin
import Foundation

/// `polycarp-spaces surfaces …`: read and change surfaces.json, the one file every Polycarp surface reads
/// (docs/surfaces.md). It edits the file directly, so it works with the app running or not; a running app picks the
/// change up within 150 ms. `--json` prints `{ok, data}` or `{ok: false, error}`, the envelope `polycarp theme` uses,
/// and `polycarp mcp` passes it on as is.
enum SurfacesCommand {
    static let usage = """
    usage: polycarp-spaces surfaces <command> [--json]

      get [path]                  the value in force at path (the file over the defaults), or everything
      set <path> <json-value>     check, then write; a value that isn't JSON is taken as a string
      reset [path]                path back to its default, or the whole file
      schema                      the JSON Schema: every field, its default and what it takes
      validate [file]             check a file (default: the one in use) and list every error with its path

    Paths are keys joined with dots: bar.height, bar.modules.left, desktop.scene. The file is
    ~/Library/Application Support/Polycarp/surfaces.json. Docs: docs/surfaces.md in the Polycarp repo.
    """

    static func run(_ args: [String], remote: Bool) -> Never {
        if remote { finish(.failure(SurfacesFailure("invalid_args", "surfaces edits this Mac's file; run it on the other machine", exit: 2)), json: false) }
        let json = args.contains("--json")
        let args = args.filter { $0 != "--json" }
        let file = SurfacesFile.path()
        let sub = args.first ?? "help"
        let rest = Array(args.dropFirst())
        func usageFail(_ line: String) -> Never { finish(.failure(SurfacesFailure("invalid_args", "usage: polycarp-spaces surfaces \(line)", exit: 2)), json: json) }
        switch sub {
        case "get":
            guard rest.count <= 1 else { usageFail("get [path] [--json]") }
            finish(SurfacesOps.get(rest.first, file: file), json: json) { d in d["value"]?.json(pretty: true) ?? "null" }
        case "set":
            guard rest.count == 2 else { usageFail("set <path> <json-value> [--json]") }
            let value: SurfaceValue
            if case .success(let v) = SurfaceValue.parse(Data(rest[1].utf8)) { value = v } else { value = .string(rest[1]) }
            finish(SurfacesOps.set(rest[0], value, file: file), json: json) { d in
                let line = "\(rest[0]) = \(value.json(pretty: false))"
                return ([line] + warnings(d)).joined(separator: "\n")
            }
        case "reset":
            guard rest.count <= 1 else { usageFail("reset [path] [--json]") }
            finish(SurfacesOps.reset(rest.first, file: file), json: json) { d in
                let p = d["path"]?.string ?? "$"
                return p == "$" ? "every surface is back to its defaults" : "\(p) is back to its default: \(d["value"]?.json(pretty: false) ?? "null")"
            }
        case "schema":
            guard rest.isEmpty else { usageFail("schema [--json]") }
            finish(SurfacesOps.schema(), json: json) { _ in Surfaces.schema.json(pretty: true) }
        case "validate":
            guard rest.count <= 1 else { usageFail("validate [file] [--json]") }
            let target = rest.first.map { (($0 as NSString).expandingTildeInPath as NSString).standardizingPath } ?? file
            let absolute = target.hasPrefix("/") ? target : FileManager.default.currentDirectoryPath + "/" + target
            finish(SurfacesOps.validate(absolute), json: json) { d in
                (["valid: \(d["file"]?.string ?? absolute)"] + warnings(d)).joined(separator: "\n")
            }
        case "help", "-h", "--help":
            print(usage); exit(0)
        default:
            usageFail("get|set|reset|schema|validate (polycarp-spaces surfaces help)")
        }
    }

    private static func warnings(_ d: [String: SurfaceValue]) -> [String] {
        (d["warnings"]?.array ?? []).compactMap { w in
            guard let p = w.object?["path"]?.string, let m = w.object?["message"]?.string else { return nil }
            return "warning: \(p): \(m)"
        }
    }

    /// Prints the result and exits: the envelope with --json, else `text` on stdout or the refusal on stderr.
    private static func finish(_ r: SurfacesOps.Result, json: Bool, text: ([String: SurfaceValue]) -> String = { _ in "" }) -> Never {
        switch r {
        case .success(let data):
            print(json ? SurfacesOps.ok(data).json(pretty: true) : text(data.object ?? [:]))
            exit(0)
        case .failure(let f):
            if json {
                print(f.envelope.json(pretty: true))
            } else {
                var lines = [f.message]
                if f.issues.count > 1 || (f.issues.first.map { $0.path != "$" && !f.message.contains($0.message) } ?? false) {
                    lines += f.issues.map { "  \($0)" }
                }
                if let s = f.suggestion { lines.append(s) }
                FileHandle.standardError.write((lines.joined(separator: "\n") + "\n").data(using: .utf8)!)
            }
            exit(f.exit)
        }
    }
}
