import Foundation
import XCTest

/// Every kind of line Spaces writes to timing.log has a speed budget in spec/speed.json, and
/// scripts/speed-report.sh holds a day of real use to them (gaps P3, P4, P5 and G8).
final class SpeedBudgetTests: XCTestCase {
    private func timing() throws -> [String: Any] {
        let data = try Data(contentsOf: Repo.root.appendingPathComponent("spec/speed.json"))
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(json["spacesTiming"] as? [String: Any], "spec/speed.json has no spacesTiming")
    }

    private func budgets() throws -> [String: [String: Any]] {
        try XCTUnwrap(try timing()["kinds"] as? [String: [String: Any]])
    }

    private static let literal = try! NSRegularExpression(pattern: #""([^"\\]*)"(\s*\+)?"#)

    /// The kinds the app's code can log: switch and parked from `SwitchClock`, and one per
    /// `OpenClock` name. A name built as `"settings-" + pane` is the kind `settings-pane`.
    private func loggedKinds() throws -> Set<String> {
        let folder = Repo.root.appendingPathComponent("Sources/BaneySpaces")
        var kinds: Set<String> = []
        var appends = 0
        for name in try FileManager.default.contentsOfDirectory(atPath: folder.path) where name.hasSuffix(".swift") {
            let code = try Repo.code("Sources/BaneySpaces/\(name)")
            appends += code.components(separatedBy: "TimingLog.append(").count - 1
            if code.contains("struct SwitchClock") {
                XCTAssertTrue(code.contains("done") && code.contains("parked"), "the switch line's marks")
                kinds.formUnion(["switch", "parked"])
            }
            for line in code.split(separator: "\n") where line.contains("OpenClock(") && !line.contains("struct OpenClock") {
                let call = String(line[line.range(of: "OpenClock(")!.upperBound...])
                let ns = call as NSString
                let literals = Self.literal.matches(in: call, range: NSRange(location: 0, length: ns.length))
                XCTAssertFalse(literals.isEmpty, "OpenClock with no literal name: \(line)")
                for m in literals {
                    let text = ns.substring(with: m.range(at: 1))
                    // A literal joined to more with + is a prefix: "settings-" + pane.
                    kinds.insert(m.range(at: 2).location != NSNotFound ? text + "pane" : text)
                }
            }
        }
        // Two writers: the switch line and the open line. A third kind of line needs a kind here.
        XCTAssertEqual(appends, 2, "a new timing.log writer needs its kind in loggedKinds and a budget")
        return kinds
    }

    func testEveryLoggedKindHasABudget() throws {
        let kinds = try loggedKinds()
        XCTAssertTrue(kinds.isSuperset(of: ["switch", "parked", "dock", "launcher", "overview", "settings", "settings-pane"]), "\(kinds)")
        let budgets = try budgets()
        for kind in kinds.sorted() {
            let b = try XCTUnwrap(budgets[kind], "timing.log kind \(kind) has no budget in spec/speed.json spacesTiming")
            let p50 = try XCTUnwrap(b["p50"] as? Int), p90 = try XCTUnwrap(b["p90"] as? Int), p99 = try XCTUnwrap(b["p99"] as? Int)
            XCTAssertTrue(0 < p50 && p50 <= p90 && p90 <= p99, "\(kind): \(p50)/\(p90)/\(p99)")
        }
    }

    /// The budgets can't be loosened past the targets in the gap list.
    func testTheBudgetsMeetTheGapTargets() throws {
        let b = try budgets()
        XCTAssertLessThanOrEqual(try XCTUnwrap(b["switch"]?["p50"] as? Int), 50)
        XCTAssertLessThanOrEqual(try XCTUnwrap(b["switch"]?["p90"] as? Int), 100)
        XCTAssertLessThanOrEqual(try XCTUnwrap(b["parked"]?["p90"] as? Int), 150)
        XCTAssertLessThanOrEqual(try XCTUnwrap(b["dock"]?["p99"] as? Int), 150)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(try timing()["minSamples"] as? Int), 5)
    }

    // MARK: speed-report.sh on a fixture

    /// `trace: nil` writes no trace.log; `rotated` is written as trace.log.1.
    private func report(timing: [String], trace: [String]? = [], rotated: [String]? = nil) throws -> (status: Int32, out: String) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("speed-report-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try (timing.joined(separator: "\n") + "\n").write(to: dir.appendingPathComponent("timing.log"), atomically: true, encoding: .utf8)
        for (name, lines) in [("trace.log", trace), ("trace.log.1", rotated)] {
            guard let lines else { continue }
            try (lines.joined(separator: "\n") + "\n").write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [Repo.root.appendingPathComponent("scripts/speed-report.sh").path]
        p.environment = ["POLYCARP_SUPPORT_DIR": dir.path, "PATH": "/usr/bin:/bin"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        try p.run()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        p.waitUntilExit()
        return (p.terminationStatus, out)
    }

    private let now = Int(Date().timeIntervalSince1970)
    private func fast() -> [String] {
        (0..<20).flatMap { i in [
            "\(now - 60 * i) ws=2 from=1 scan=skip snap=3 done=30 parked=80",
            "\(now - 60 * i) ws=1 from=1 scan=skip done=500 parked=900", // a no-op switch: not counted
            "\(now - 60 * i) open dock=40",
            "\(now - 60 * i) open launcher=40",
        ] }
    }

    func testADayInBudgetPasses() throws {
        let r = try report(timing: fast() + ["\(now - 90_000) open dock=5000"], // older than a day
                           trace: ["\(now - 10).5 dock held 2s off the bar by more: pointer 1,1 bar 0,0 10x10"])
        XCTAssertEqual(r.status, 0, r.out)
        XCTAssertTrue(r.out.contains("speed-report: pass"), r.out)
    }

    private func docks(_ n: Int, ms: Int = 40) -> [String] { (0..<n).map { "\(now - 30 * $0) open dock=\(ms)" } }

    func testASlowTailFails() throws {
        let slow = (0..<3).map { "\(now - $0) open dock=400" }
        let r = try report(timing: fast() + docks(100) + slow, trace: ["\(now - 10) a line"])
        XCTAssertEqual(r.status, 1, r.out)
        XCTAssertTrue(r.out.contains("dock p99 400 ms over"), r.out)
    }

    /// #470 review second-F8: below 100 lines nearest-rank p99 is the slowest one, so one stall isn't a p99 miss.
    func testP99IsJudgedOnlyAtAHundredLines() throws {
        let stall = ["\(now - 5) open dock=627"]
        let few = try report(timing: fast() + docks(30) + stall, trace: ["\(now - 10) a line"])
        XCTAssertEqual(few.status, 0, few.out)
        XCTAssertTrue(few.out.contains("p99 n<100, not judged"), few.out)
        let many = try report(timing: fast() + docks(120) + stall + stall, trace: ["\(now - 10) a line"])
        XCTAssertEqual(many.status, 1, many.out)
        XCTAssertTrue(many.out.contains("dock p99 627 ms over"), many.out)
    }

    /// #470 review first-F1: no trace.log is no evidence, not a clean day.
    func testNoTraceLogLeavesTheGlitchCountsUntested() throws {
        for trace in [nil, ["\(now - 90_000) older than the window"]] as [[String]?] {
            let r = try report(timing: fast(), trace: trace)
            XCTAssertEqual(r.status, 3, r.out)
            XCTAssertEqual(r.out.components(separatedBy: "untested: no trace.log").count - 1, 2, r.out)
            XCTAssertFalse(r.out.contains("lines in trace.log  ok"), r.out)
            XCTAssertFalse(r.out.contains("speed-report: pass"), r.out)
        }
    }

    /// #470 review first-F2: the rotations hold about 600 KB, which a busy day can outrun.
    func testTheReportSaysWhatSpanTheTraceCovers() throws {
        let r = try report(timing: fast(), trace: ["\(now - 3600) b"], rotated: ["\(now - 3 * 3600) a"])
        XCTAssertEqual(r.status, 0, r.out)
        XCTAssertTrue(r.out.contains("(2.0 h), not all 24 h: older lines rotated out"), r.out)
        let all = try report(timing: fast(), trace: ["\(now - 3600) b"], rotated: ["\(now - 30 * 3600) a", "\(now - 3 * 3600) a"])
        XCTAssertTrue(all.out.contains("trace.log covers"), all.out)
        XCTAssertFalse(all.out.contains("not all"), all.out)
    }

    /// #470 review first-F3: each glitch pattern must match a line the app can log, or a reworded line reads 0 for good.
    func testEveryGlitchPatternMatchesALineTheAppLogs() throws {
        let script = try Repo.text("scripts/speed-report.sh")
        let block = try XCTUnwrap(script.range(of: "glitches = {").flatMap { s in
            script.range(of: "\n}", range: s.upperBound..<script.endIndex).map { script[s.upperBound..<$0.lowerBound] } })
        let patterns = block.components(separatedBy: "r\"^").dropFirst().map { String($0.prefix { $0 != "\"" }) }
        XCTAssertGreaterThanOrEqual(patterns.count, 5, String(block))
        var logged: [String] = []
        for target in ["Sources/BaneySpaces", "Sources/BaneySpacesCore"] {
            for name in try FileManager.default.contentsOfDirectory(atPath: Repo.root.appendingPathComponent(target).path)
            where name.hasSuffix(".swift") {
                let code = try Repo.code("\(target)/\(name)") as NSString
                for m in Self.anyLiteral.matches(in: code as String, range: NSRange(location: 0, length: code.length)) {
                    logged.append(code.substring(with: m.range(at: 1)))
                }
            }
        }
        for pattern in patterns {
            XCTAssertNil(pattern.rangeOfCharacter(from: CharacterSet(charactersIn: "\\.*+?[](){}|$")),
                         "keep glitch patterns plain text so this check can read them: \(pattern)")
            XCTAssertTrue(logged.contains { Self.canStart($0, with: pattern) },
                          "speed-report.sh counts \"\(pattern)\" but no string in Sources logs a line that starts with it")
        }
    }

    private static let anyLiteral = try! NSRegularExpression(pattern: #""((?:[^"\\\n]|\\.)*)""#)

    /// Can a line logged from this Swift literal start with `prefix`? Each `\(...)` stands for any text.
    private static func canStart(_ literal: String, with prefix: String) -> Bool {
        let head = literal.components(separatedBy: "\\(")[0]
        guard !head.isEmpty else { return false } // "\(line)" could be anything; a logged line starts with fixed text
        let pieces = literal.components(separatedBy: "\\(").enumerated().map { i, piece -> String in
            guard i > 0, let close = piece.firstIndex(of: ")") else { return NSRegularExpression.escapedPattern(for: piece) }
            return ".*" + NSRegularExpression.escapedPattern(for: String(piece[piece.index(after: close)...]))
        }
        let whole = "^" + pieces.joined() + "$"
        if (try? NSRegularExpression(pattern: whole))?.firstMatch(in: prefix, range: NSRange(location: 0, length: (prefix as NSString).length)) != nil {
            return true // the pattern is a line the literal logs, its interpolations filled in
        }
        return head.hasPrefix(prefix) // the pattern is a prefix of the literal's fixed start
    }

    func testAKindWithNoBudgetFails() throws {
        let r = try report(timing: fast() + ["\(now) open newthing=5"])
        XCTAssertEqual(r.status, 1, r.out)
        XCTAssertTrue(r.out.contains("newthing: no budget"), r.out)
    }

    func testAStuckDockOrAWrongSwitcherFails() throws {
        for line in ["dock stray: the dock panel was still on screen 3.0s after the dock went down; ordered out",
                     "dock held 2s with the bar unmeasured, so the whole panel counts: pointer 1,1",
                     "cmdTab panel not on screen; rebuilding it",
                     "cmdTab passed to macOS started=true viewerOpen=false"] {
            let r = try report(timing: fast(), trace: ["\(now - 5).25 \(line)"])
            XCTAssertEqual(r.status, 1, "\(line)\n\(r.out)")
            XCTAssertTrue(r.out.contains("1 lines in trace.log  MISS"), r.out)
        }
    }
}
