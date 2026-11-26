import BaneySpacesCore
import Darwin
import Foundation

/// `polycarp-spaces defaults …`: which app does each job (docs/default-apps.md). It reads and edits config.toml itself,
/// so the app need not run. `--json` prints the envelope `surfaces` uses, and `polycarp mcp` passes it on as is.
enum DefaultsCommand {
    static let usage = """
    usage: polycarp-spaces defaults [command] [--json]

      (nothing)           every role, the app that does it, and who decided
      get <role>          one role
      candidates <role>   the installed apps that can do it
      set <role> <app>    choose one: a bundle identifier, a program like claude, or the app's name
      reset <role>        back to macOS's default

    Roles: \(AppRole.allCases.map(\.rawValue).joined(separator: ", ")).
    The choices are [defaults] in ~/.config/baneyspaces/config.toml. This changes what Polycarp opens, never macOS's
    own defaults. Docs: spaces/docs/default-apps.md in the Polycarp repo.
    """

    static func run(_ args: [String], remote: Bool) -> Never {
        let json = args.contains("--json")
        if remote { finish(.failure(SurfacesFailure("invalid_args", "defaults edits this Mac's file; run it on the other machine", exit: 2)), json) { _ in "" } }
        let plain = args.filter { $0 != "--json" }
        let file = DefaultAppsFile.path(), installed = LaunchServicesApps()
        func usageFail(_ line: String) -> Never { finish(.failure(SurfacesFailure("invalid_args", "usage: polycarp-spaces defaults \(line)", exit: 2)), json) { _ in "" } }
        let rest = Array(plain.dropFirst())
        switch plain.first {
        case nil, "ls", "list":
            guard rest.isEmpty else { usageFail("[--json]") }
            finish(DefaultAppsOps.list(file: file, installed: installed), json) { d in
                ((d["defaults"]?.array ?? []).map { line($0.object ?? [:]) } + strings(d["warnings"])).joined(separator: "\n")
            }
        case "get":
            guard rest.count == 1 else { usageFail("get <role>") }
            finish(DefaultAppsOps.get(rest[0], file: file, installed: installed), json) { d in ([line(d)] + strings(d["warnings"])).joined(separator: "\n") }
        case "candidates":
            guard rest.count == 1 else { usageFail("candidates <role>") }
            finish(DefaultAppsOps.candidates(rest[0], file: file, installed: installed), json) { d in
                let list = d["candidates"]?.array ?? []
                return list.isEmpty ? "none installed" : list.map { c in
                    let o = c.object ?? [:]
                    return "\(o["current"] == .bool(true) ? "*" : " ") \(o["id"]?.string ?? "")  \(o["name"]?.string ?? "")" + (o["note"]?.string.map { "  (\($0))" } ?? "")
                }.joined(separator: "\n")
            }
        case "set":
            guard rest.count >= 2 else { usageFail("set <role> <app>") }
            finish(DefaultAppsOps.set(rest[0], rest[1...].joined(separator: " "), file: file, installed: installed), json) { d in
                ([line(d)] + (d["everywhere"]?.string.map { [$0] } ?? [])).joined(separator: "\n")
            }
        case "reset":
            guard rest.count == 1 else { usageFail("reset <role>") }
            finish(DefaultAppsOps.reset(rest[0], file: file, installed: installed), json) { line($0) }
        case "help", "-h", "--help":
            print(usage); exit(0)
        default:
            usageFail("[get|candidates|set|reset]; `polycarp-spaces defaults help` explains them")
        }
    }

    private static func line(_ d: [String: SurfaceValue]) -> String {
        let app = d["app"]?.object
        let role = (d["role"]?.string ?? "").padding(toLength: 10, withPad: " ", startingAt: 0)
        return "\(role) \(app.map { "\($0["name"]?.string ?? "") (\($0["id"]?.string ?? ""))" } ?? "none")  \(d["said"]?.string ?? "")"
    }

    private static func strings(_ v: SurfaceValue?) -> [String] { (v?.array ?? []).compactMap(\.string).map { "warning: \($0)" } }

    private static func finish(_ r: DefaultAppsOps.Result, _ json: Bool, _ text: ([String: SurfaceValue]) -> String) -> Never {
        switch r {
        case .success(let data):
            print(json ? SurfacesOps.ok(data).json(pretty: true) : text(data.object ?? [:]))
            exit(0)
        case .failure(let f):
            if json { print(f.envelope.json(pretty: true)) } else {
                FileHandle.standardError.write(([f.message] + (f.suggestion.map { [$0] } ?? [])).joined(separator: "\n").appending("\n").data(using: .utf8)!)
            }
            exit(f.exit)
        }
    }
}
