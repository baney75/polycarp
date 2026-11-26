import BaneySpacesCore
import Foundation

/// `polycarp-spaces tile …`: windows side by side (docs/tiling.md), asked of the running app. `--json` is the `{ok, data}`
/// envelope `polycarp mcp` passes on. The settings (gaps, style, keys, per-app rules) are `surfaces set tiling.…`.
enum TileCommand {
    static var usage: String {
        let width = TilingRequest.forms.map(\.form.count).max()! + 2
        return "usage: polycarp-spaces tile <command> [--json]\n\n"
            + TilingRequest.forms.map { "  " + $0.form.padding(toLength: width, withPad: " ", startingAt: 0) + $0.title }.joined(separator: "\n")
            + "\n\nSettings: polycarp-spaces surfaces get tiling"
    }

    /// Who asks, for the app's trace.
    private static var caller: String {
        let agent = ProcessInfo.processInfo.environment["BANEYSPACES_AGENT"] ?? ""
        return agent.isEmpty ? (launchingApp.isEmpty ? "cli" : launchingApp) : agent
    }

    static func run(_ args: [String], remote: Bool) -> Never {
        let json = args.contains("--json"), words = args.filter { $0 != "--json" }
        if words == ["help"] || words == ["-h"] || words == ["--help"] { print(usage); exit(0) }
        if remote { refuse("invalid_args", "tile moves this Mac's windows; run it on the other machine", exit: 2, json: json) }
        guard TilingRequest(words: words) != nil else {
            let bad = words.isEmpty ? "no command" : "unknown command \"\(words.joined(separator: " "))\""
            refuse("invalid_args", json ? bad : "\(bad)\n\n\(usage)", exit: 2, json: json)
        }
        let asked = Wire.send(Wire.Request(op: .tile, args: words, caller: caller), timeout: 4)
        guard let reply = asked.reply else {
            refuse(asked.connected ? "timeout" : "not_running",
                   asked.connected ? "Polycarp didn't answer in time; `tile status` says what happened" : "Polycarp isn't running", json: json)
        }
        // A Polycarp from before tiling can't read the request.
        if reply.error == "bad request" { refuse("app_too_old", "this Polycarp has no tiling; update it (polycarp update)", json: json) }
        guard reply.ok, let status = TilingStatus(reply) else { refuse("refused", reply.error ?? "Polycarp didn't say how tiling stands", json: json) }
        print(json ? SurfacesOps.ok(status.value).json(pretty: true) : status.text)
        exit(0)
    }

    private static func refuse(_ code: String, _ message: String, exit status: Int32 = 1, json: Bool) -> Never {
        let next = switch code {
        case "invalid_args": "Run `polycarp-spaces tile help` for the commands."
        case "refused": "Run `polycarp-spaces tile status` to see how tiling stands."
        case "app_too_old": "Run `polycarp update`, then try again."
        default: "Open Polycarp, then try again."
        }
        let f = SurfacesFailure(code, message, suggestion: next, exit: status)
        if json { print(f.envelope.json(pretty: true)) } else { FileHandle.standardError.write(Data((message + "\n").utf8)) }
        exit(f.exit)
    }
}
