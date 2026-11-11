import BaneySpacesCore
import Darwin
import Foundation

/// `baneyspaces agent snapshot|find|get|click|type|set-value|press|scroll|select|toggle|shot|open|lend|return|windows`
/// and `baneyspaces mcp`. The command only parses and prints: every action runs inside the BaneySpaces
/// app (which holds Accessibility) and comes back as one JSON envelope.
enum HandsCLI {
    /// The session a request belongs to (`HandsParse.cliSession`): `$BANEYSPACES_SESSION`, else its terminal, the same
    /// default `event` uses, else "default".
    static func defaultSession() -> String {
        HandsParse.cliSession(environment: ProcessInfo.processInfo.environment, tty: controllingTTY())
    }

    /// Sends one request to the app and returns its envelope. Nothing here can fail without saying why.
    /// `timeout` defaults to 180 s plus the in-use wait the request asked for, so a long `wait` never looks like a lost answer.
    static func send(_ request: HandsRequest, timeout: Double? = nil, caller: String? = nil) -> HandsEnvelope {
        let timeout = timeout ?? 180 + (AgentAccessGate.changes.contains(request.verb) ? InUseRule.bound(request.int("wait")) : 0)
        guard remoteHost == nil else {
            return .failure(HandsError(.badArguments, "agent commands run on this Mac only", suggestion: "Run `polycarp-spaces agent …` on the machine whose apps you want to drive.", retry: .never))
        }
        guard let data = try? JSONEncoder().encode(request), let text = String(data: data, encoding: .utf8) else {
            return .failure(HandsError(.badArguments, "couldn't encode the request", suggestion: "Check the arguments.", retry: .never))
        }
        guard let reply = Wire.call(Wire.Request(op: .hands, text: text, caller: caller), timeout: timeout) else {
            // Something answered the connection but the reply didn't come in time: the action may have landed. A socket
            // file with nobody behind it (a crash leaves one) is not running.
            if SocketClaim.anyLive(Wire.socketCandidates()) {
                let acts = HandsTools.tool(verb: request.verb)?.acts ?? false
                return .failure(HandsError(.timeout, "Polycarp didn't answer in time", suggestion: acts
                    ? "The action may have landed: read the element back with `polycarp-spaces agent get` before trying again."
                    : "Try again in a moment.", retry: acts ? .never : .safe))
            }
            return .failure(HandsError(.notRunning, "Polycarp isn't running, or hasn't finished starting (it needs Accessibility)",
                                       suggestion: "Open Polycarp and run `polycarp-spaces doctor`.", retry: .safe))
        }
        if let line = reply.info?["envelope"], let env = HandsEnvelope.decode(line) { return env }
        return .failure(HandsError(.engineError, reply.error ?? "the app answered without a result", suggestion: "Update Polycarp and try again.", retry: .never))
    }

    /// `agent lend <app|pid> [--for 30m] [--session ID]`: asks. It sends a request to the app, which shows Donovan
    /// a sheet; only a real click on "Lend" in BaneySpaces lends anything, so running this (or an agent running
    /// it) lends nothing by itself. There is no terminal check: a program can fake one, and nothing here decides.
    /// `agent return` does not exist as a command: ask again to be offered "Take Back", or let the time run out.
    static func lendOrReturn(_ words: [String]) -> Never {
        var rest = Array(words.dropFirst())
        var duration: String?, session = ""
        if let i = rest.firstIndex(of: "--for"), i + 1 < rest.count { duration = rest[i + 1]; rest.removeSubrange(i...(i + 1)) }
        if let i = rest.firstIndex(of: "--session"), i + 1 < rest.count { session = rest[i + 1]; rest.removeSubrange(i...(i + 1)) }
        func finish(_ env: HandsEnvelope) -> Never { print(env.line); exit(env.ok ? 0 : 1) }
        guard words[0] == "lend" else {
            finish(.failure(HandsError(.needsLend, "returning an app is Donovan's, in Polycarp",
                                       suggestion: "Run `polycarp-spaces agent lend <app>` and choose Take Back in the sheet, or let the lend run out (30 minutes).", retry: .never)))
        }
        guard let app = rest.first else { finish(.failure(HandsError(.badArguments, "say which app", suggestion: "usage: polycarp-spaces agent lend <app|pid> [--for 30m]", retry: .safe))) }
        FileHandle.standardError.write(Data("Asking Donovan in Polycarp to let agents use \(app)…\n".utf8))
        guard let reply = Wire.call(Wire.Request(op: .agent, text: "lend-ask", args: [app, duration ?? "", session]), timeout: 90) else {
            finish(.failure(HandsError(.notRunning, "Polycarp isn't running, or didn't answer", suggestion: "Open Polycarp and run `polycarp-spaces doctor`.", retry: .safe)))
        }
        if let line = reply.info?["envelope"], let env = HandsEnvelope.decode(line) { finish(env) }
        finish(.failure(HandsError(.engineError, reply.error ?? "no answer", suggestion: "Update Polycarp and try again.", retry: .never)))
    }

    static func run(_ words: [String]) -> Never {
        switch HandsParse.command(words, session: defaultSession()) {
        case .failure(let e):
            print(HandsEnvelope.failure(e).line)
            exit(2)
        case .success(let req):
            let env = send(req)
            print(env.line)
            exit(env.ok ? 0 : 1)
        }
    }
}

/// `baneyspaces mcp`: a stdio MCP server, so `claude mcp add baneyspaces -- baneyspaces mcp` gives an agent
/// the same tools (no lend: that is Donovan's).
enum MCPCommand {
    /// Asks on every call, because the app can be replaced under a running session: an app that doesn't say it caps connectors never
    /// gets the call, since it would run it with whatever this Mac allows.
    private static func connectorSend(_ request: HandsRequest) -> HandsEnvelope {
        guard Wire.call(Wire.Request(op: .ping), timeout: 2)?.info?[HandsCaller.capKey] == HandsCaller.capValue else {
            return .failure(HandsError(.notRunning, "the Polycarp app here can't take connector calls: it isn't running, or it's older than this helper",
                                       suggestion: "Ask the person to open or update Polycarp on their Mac.", retry: .safe))
        }
        return HandsCLI.send(request, caller: HandsCaller.connector)
    }

    /// `connector`: this server belongs to one connector session (`polycarp browser serve`), so the app treats its calls as remote.
    static func run(connector: Bool = false) -> Never {
        let session = "\(connector ? "connector" : "mcp"):\(getpid())"
        let version = Wire.call(Wire.Request(op: .ping), timeout: 1)?.info?["version"] ?? "dev"
        var server = HandsMCP(version: version, session: session,
                              perform: { connector ? connectorSend($0) : HandsCLI.send($0) },
                              readImage: { FileManager.default.contents(atPath: $0) })
        if connector { server.name = HandsCaller.connectorServerName }
        setvbuf(stdout, nil, _IOLBF, 0)
        while let line = readLine(strippingNewline: true) {
            guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            if let reply = server.handle(line) { print(reply); fflush(stdout) }
        }
        exit(0)
    }
}
