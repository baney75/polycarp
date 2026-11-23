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
        XCTAssertTrue(kinds.isSuperset(of: ["switch", "parked", "launcher", "overview", "settings", "settings-pane"]), "\(kinds)")
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
        XCTAssertLessThanOrEqual(try XCTUnwrap(b["launcher"]?["p99"] as? Int), 150)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(try timing()["minSamples"] as? Int), 5)
    }

    // MARK: speed-report.sh on a fixture

    private func report(timing: [String], trace: [String] = []) throws -> (status: Int32, out: String) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("speed-report-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try (timing.joined(separator: "\n") + "\n").write(to: dir.appendingPathComponent("timing.log"), atomically: true, encoding: .utf8)
        try (trace.joined(separator: "\n") + "\n").write(to: dir.appendingPathComponent("trace.log"), atomically: true, encoding: .utf8)
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
            "\(now - 60 * i) open overview=40",
            "\(now - 60 * i) open launcher=40",
        ] }
    }

    func testADayInBudgetPasses() throws {
        let r = try report(timing: fast() + ["\(now - 90_000) open launcher=5000"], // older than a day
                           trace: ["\(now - 10).5 cmdTab opened on ⌘Tab"])
        XCTAssertEqual(r.status, 0, r.out)
        XCTAssertTrue(r.out.contains("speed-report: pass"), r.out)
    }

    func testASlowTailFails() throws {
        let slow = (0..<3).map { "\(now - $0) open launcher=400" }
        let r = try report(timing: fast() + slow)
        XCTAssertEqual(r.status, 1, r.out)
        XCTAssertTrue(r.out.contains("launcher p99 400 ms over"), r.out)
    }

    func testAKindWithNoBudgetFails() throws {
        let r = try report(timing: fast() + ["\(now) open newthing=5"])
        XCTAssertEqual(r.status, 1, r.out)
        XCTAssertTrue(r.out.contains("newthing: no budget"), r.out)
    }

    func testAWrongSwitcherFails() throws {
        for line in ["cmdTab panel not on screen; rebuilding it",
                     "cmdTab landed wrong: highlighted Ghostty pid 12, front pid 34"] {
            let r = try report(timing: fast(), trace: ["\(now - 5).25 \(line)"])
            XCTAssertEqual(r.status, 1, "\(line)\n\(r.out)")
            XCTAssertTrue(r.out.contains("1 lines in trace.log  MISS"), r.out)
        }
    }
}
