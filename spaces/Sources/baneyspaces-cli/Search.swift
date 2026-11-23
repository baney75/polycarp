import BaneySpacesCore
import Darwin
import Foundation

/// `polycarp-spaces search [--open] [--json] <text>`: one search, ranked as the launcher and the new tab page rank it
/// (`OneSearch`): open tabs and windows from the session engine that match, bang completions, then what Return does
/// (a bang, an address, or `search.engine`). One JSON line per result; `--json` is the `{ok, data}` envelope
/// `polycarp mcp` passes on. `--open` performs the top result Return would act on (a bang completion only fills in a
/// bang, so it is passed over): a session row goes forward through Polycarp (as `focus` does), a web result opens in
/// the default browser. Everything after `--` is the text, never a flag (`polycarp mcp` sends its query that way).
enum SearchCommand {
    static let usage = "usage: polycarp-spaces search [--open] [--json] [--] <text>"
    /// How long the session engine gets to answer. Without it the results are the web ones alone.
    static let sessionWait: TimeInterval = 0.5

    static func run(_ args: [String], remote: Bool) -> Never {
        let a = OneSearch.Arguments(args)
        let json = a.json
        let open = a.open
        let text = a.text
        if remote { refuse(SurfacesFailure("invalid_args", "search runs on this Mac; run it on the other machine", exit: 2), json: json) }
        if text.isEmpty || a.asksHelp { refuse(SurfacesFailure("invalid_args", usage, exit: 2), json: json) }

        let surfaces: Surfaces
        if case .document(let d) = SurfacesFile.load(path: SurfacesFile.path()) { surfaces = d.surfaces } else { surfaces = .defaults }
        let bangs = Bangs.load(supportDir: Product.supportDir(home: FileManager.default.homeDirectoryForCurrentUser))
        let engine = OneSearch.engine(surfaces.search.engine, bangs: bangs)
        let reply = Wire.call(Wire.Request(op: .list), timeout: sessionWait)
        let items = reply?.ok == true ? reply?.items ?? [] : []
        let partial = reply?.ok != true
        let results = OneSearch.results(text, items: items, engine: engine, bangs: bangs)

        guard open else {
            if json {
                print(SurfacesOps.ok(.object(["query": .string(text), "results": .array(results.map(value)), "partial": .bool(partial)])).json(pretty: true))
            } else {
                results.forEach { print($0.jsonLine) }
            }
            exit(0)
        }
        guard let top = OneSearch.toOpen(results) else { refuse(SurfacesFailure("nothing_found", "nothing to open for \(text)"), json: json) }
        if let id = top.id {
            guard let r = Wire.call(Wire.Request(op: .focus, target: id), timeout: 2) else {
                refuse(SurfacesFailure("not_running", "Polycarp isn't running, so \(top.title) can't be brought forward"), json: json)
            }
            if !r.ok { refuse(SurfacesFailure("focus_failed", r.error ?? "nothing matches"), json: json) }
        } else if let url = top.url {
            // Only what a bang or the address rule made: http, https or Apple Maps, never a file or a script.
            guard let u = URL(string: url), let scheme = u.scheme?.lowercased(), ["http", "https", "maps"].contains(scheme) else {
                refuse(SurfacesFailure("invalid_url", "won't open \(url)"), json: json)
            }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            p.arguments = [u.absoluteString]
            do { try p.run(); p.waitUntilExit() } catch { refuse(SurfacesFailure("open_failed", "couldn't open \(url): \(error.localizedDescription)"), json: json) }
            if p.terminationStatus != 0 { refuse(SurfacesFailure("open_failed", "the default browser didn't open \(url)"), json: json) }
        }
        if json {
            print(SurfacesOps.ok(.object(["query": .string(text), "opened": value(top)])).json(pretty: true))
        } else {
            print(top.jsonLine)
        }
        exit(0)
    }

    private static func value(_ r: OneSearch.Result) -> SurfaceValue {
        if case .success(let v) = SurfaceValue.parse(Data(r.jsonLine.utf8)) { return v }
        return .object(["kind": .string(r.kind), "title": .string(r.title)])
    }

    private static func refuse(_ f: SurfacesFailure, json: Bool) -> Never {
        if json { print(f.envelope.json(pretty: true)) } else { FileHandle.standardError.write(Data((f.message + "\n").utf8)) }
        exit(f.exit)
    }
}
