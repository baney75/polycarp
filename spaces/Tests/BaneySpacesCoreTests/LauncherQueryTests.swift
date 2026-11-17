import Darwin
import XCTest
@testable import BaneySpacesCore

final class LauncherQueryTests: XCTestCase {
    func testArguments() {
        XCTAssertEqual(LauncherQuery.parse(["lck"]), .init(query: "lck", json: false, limit: 10))
        XCTAssertEqual(LauncherQuery.parse(["vs", "code", "--json", "--limit", "3"]), .init(query: "vs code", json: true, limit: 3))
        XCTAssertEqual(LauncherQuery.parse(["--", "--json"]), .init(query: "--json", json: false, limit: 10))
        for bad in [[], ["  "], ["--json"], ["x", "--limit"], ["x", "--limit", "0"], ["x", "--limit", "51"], ["x", "--limit", "y"], ["x", "--bogus"]] {
            XCTAssertNil(LauncherQuery.parse(bad), "\(bad)")
        }
        XCTAssertEqual(LauncherQuery.limit(["3"]), 3)
        XCTAssertEqual(LauncherQuery.limit(["900"]), 50)
        XCTAssertEqual(LauncherQuery.limit(nil), 10)
    }

    func testKindsComeFromThePanelsRowIds() {
        let cases = ["app:/Applications/Slack.app": "app", "app:/Applications/Slack.app:3": "app", "file:/Users/a/x.pdf": "file",
                     "ws:3": "workspace", "cmd:Lock Screen": "command", "scope:files": "menu", "session:ghostty:1": "session",
                     "agent:claude": "agent", "bang:g:Web": "web", "bang-pick:yt": "web", "bang-ddg:zz": "web",
                     "find-install": "install", "provider:calc": "calc", "provider:snippet:sig": "snippet", "mystery": "other"]
        for (id, kind) in cases { XCTAssertEqual(LauncherQuery.kind(id: id), kind, id) }
    }

    func testJSONIsAnArrayOfRowsWithFiveKeys() throws {
        let rows = [LauncherQueryRow(id: "ws:3", kind: "workspace", title: "Workspace 3", subtitle: "Slack", section: "Workspaces")]
        let any = try JSONSerialization.jsonObject(with: Data(LauncherQuery.json(rows).utf8)) as? [[String: String]]
        XCTAssertEqual(any?.first.map { Set($0.keys) }, ["id", "kind", "title", "subtitle", "section"])
        XCTAssertEqual(try JSONDecoder().decode([LauncherQueryRow].self, from: Data(LauncherQuery.json(rows).utf8)), rows)
        XCTAssertEqual(try JSONDecoder().decode([LauncherQueryRow].self, from: Data(LauncherQuery.json([]).utf8)), [])
        XCTAssertEqual(LauncherQuery.text(rows), "Workspace 3\tworkspace\tws:3")
    }

    func testTheTimingLineIsATimeAndACount() {
        XCTAssertEqual(LauncherQuery.timingLine(at: Date(timeIntervalSince1970: 1_700_000_000), ms: 3.6, rows: 7),
                       "1700000000 launcher query=4 rows=7")
    }

    /// Local callers only, like `focus`; this user's own processes may ask.
    func testOnlyThisMacMayAsk() {
        let r = Wire.Request(op: .launcher, target: "lck", text: "query", args: ["5"])
        XCTAssertFalse(Remote.allows(r))
        XCTAssertNil(SocketPolicy.refusal(for: r))
    }

    /// What's typed travels in `target`. No trace line on the socket path prints `target`, and the app's handler logs nothing.
    func testWhatsTypedNeverReachesTheTrace() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let server = try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/Session/Server.swift"), encoding: .utf8)
        for line in server.split(separator: "\n") where line.contains("Trace.log(") { XCTAssertFalse(line.contains("target"), String(line)) }
        let controller = try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/Session/SessionController.swift"), encoding: .utf8)
        let handler = try XCTUnwrap(controller.range(of: "case .launcher:")).upperBound
        let body = String(controller[handler...]).components(separatedBy: "case .update:")[0]
        XCTAssertFalse(body.contains("Trace"), body)
        let launcher = try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/Launcher.swift"), encoding: .utf8)
        let answer = try XCTUnwrap(launcher.components(separatedBy: "enum LauncherQueryAnswer").dropFirst().first?.components(separatedBy: "\n}\n").first)
        XCTAssertFalse(answer.contains("Trace"), answer)
        XCTAssertTrue(answer.contains("LauncherQuery.timingLine("), answer)
    }

    // MARK: The built command

    private func cli() throws -> URL {
        let bin = Bundle(for: Self.self).bundleURL.deletingLastPathComponent().appendingPathComponent("baneyspaces-cli")
        guard FileManager.default.isExecutableFile(atPath: bin.path) else { throw XCTSkip("baneyspaces-cli isn't built next to the tests") }
        return bin
    }

    private func run(_ args: [String], home: String) throws -> (code: Int32, out: String) {
        let p = Process()
        p.executableURL = try cli()
        p.arguments = args
        // CoreFoundation's own home override: the command looks for Polycarp's socket under this folder, never the real one.
        p.environment = ["HOME": home, "CFFIXED_USER_HOME": home, "PATH": "/usr/bin:/bin"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        try p.run()
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        return (p.terminationStatus, out)
    }

    /// Nothing to search is a usage error, before anything is sent.
    func testNoQueryExitsTwo() throws {
        for args in [["launcher", "query"], ["launcher", "query", "  "], ["launcher"], ["launcher", "find", "x"], ["launcher", "query", "x", "--limit", "0"]] {
            XCTAssertEqual(try run(args, home: "/nonexistent-polycarp-home").code, 2, "\(args)")
        }
    }

    /// `--json` against a stand-in for the app on a socket in a throwaway home: the request carries the query and the
    /// limit, and the command prints the rows as a JSON array and exits 0.
    func testJSONFromTheAppExitsZero() throws {
        _ = try cli()
        // A short path: a Unix socket's path must fit in 104 bytes.
        let home = "/tmp/pcq-\(UUID().uuidString.prefix(8))"
        defer { try? FileManager.default.removeItem(atPath: home) }
        let dir = Product.supportDir(home: URL(fileURLWithPath: home))
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = try XCTUnwrap(Wire.listenPaths(dir: dir).first)
        let rows = [LauncherQueryRow(id: "app:/fixture/Slack.app", kind: "app", title: "Slack", subtitle: "Applications", section: "Apps"),
                    LauncherQueryRow(id: "cmd:Lock Screen", kind: "command", title: "Lock Screen", subtitle: "", section: "System")]
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        defer { close(fd) }
        var addr = try XCTUnwrap(Wire.address(path: path))
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(listen(fd, 1), 0)
        var asked: Wire.Request?
        let served = expectation(description: "served")
        DispatchQueue.global().async {
            defer { served.fulfill() }
            var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&p, 1, 10_000) == 1 else { return }
            let c = accept(fd, nil, nil)
            guard c >= 0 else { return }
            defer { close(c) }
            guard let line = Wire.readLine(c, deadline: Date().addingTimeInterval(5)) else { return }
            asked = try? JSONDecoder().decode(Wire.Request.self, from: line)
            var reply = try! JSONEncoder().encode(Wire.Reply(ok: true, rows: rows))
            reply.append(0x0A)
            _ = Wire.writeAll(c, reply)
        }
        let r = try run(["launcher", "query", "lck", "--json", "--limit", "2"], home: home)
        wait(for: [served], timeout: 15)
        XCTAssertEqual(r.code, 0, r.out)
        XCTAssertEqual(asked, Wire.Request(op: .launcher, target: "lck", text: "query", args: ["2"]))
        XCTAssertEqual(try JSONDecoder().decode([LauncherQueryRow].self, from: Data(r.out.utf8)), rows)
    }
}
