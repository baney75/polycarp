import XCTest

/// scripts/focus-probe.swift presses keys and switches workspaces on Donovan's own Mac, so its safety is tested against
/// its fake Mac (`--self-test <scenario>`): the same probe code, with every read and effect going to a recorded fake.
/// Nothing here touches the real session. Review of #471, round 1.
final class FocusProbeSafetyTests: XCTestCase {
    static var binary: URL?

    /// Compiles the probe once. Refuses a probe without its fake Mac: run with `--self-test` it would drive the real one.
    func probe() throws -> URL {
        if let b = Self.binary { return b }
        let source = Repo.root.appendingPathComponent("scripts/focus-probe.swift")
        let text = try String(contentsOf: source, encoding: .utf8)
        guard text.contains("func fakeWorld("), text.contains("args.firstIndex(of: \"--self-test\")") else {
            XCTFail("focus-probe.swift has no fake Mac (--self-test), so its exits and cleanup can't be tested without the real one")
            throw XCTSkip("no fake Mac")
        }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("focus-probe-test-\(getpid())")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        p.arguments = ["swiftc", "-Onone", source.path, "-o", out.path]
        try p.run()
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, "focus-probe.swift doesn't compile")
        Self.binary = out
        return out
    }

    func run(_ mode: String, _ scenario: String, runs: Int? = nil) throws -> (code: Int32, out: String) {
        let p = Process(), pipe = Pipe()
        p.executableURL = try probe()
        p.arguments = [mode] + (runs.map { ["--runs", String($0)] } ?? []) + ["--self-test", scenario]
        p.standardOutput = pipe
        p.standardError = pipe
        try p.run()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        p.waitUntilExit()
        return (p.terminationStatus, out)
    }

    /// first-F2: ⌘ left down turns his next q or w into Quit or Close. Every way out lets go of both keys before any app quits.
    func testEveryWayOutLetsGoOfCommandAndTabBeforeAnyAppQuits() throws {
        for (scenario, code, line) in [("foreign-input", Int32(3), "untested live: input from you arrived mid-run"),
                                       ("signal", 3, "untested live: stopped by signal 15"),
                                       ("lands-wrong", 1, "focus-probe hold-tab: FAIL"),
                                       ("pass", 0, "focus-probe hold-tab: pass")] {
            let r = try run("hold-tab", scenario, runs: 2)
            XCTAssertEqual(r.code, code, "\(scenario): \(r.out)")
            XCTAssertTrue(r.out.contains(line), "\(scenario): \(r.out)")
            XCTAssertTrue(r.out.contains("fake: keys down at exit: none"), "\(scenario) left a key down: \(r.out)")
            XCTAssertTrue(r.out.contains("fake: an app quit while a key was down: no"), "\(scenario): \(r.out)")
        }
    }

    /// second-F5: after 10 idle minutes the screen is often locked; that is untested, never a FAIL.
    func testALockedScreenIsUntestedNotAFail() throws {
        for (mode, scenario) in [("empty-workspace", "locked-at-start"), ("empty-workspace", "locks-mid-run"),
                                 ("reopen-here", "locks-mid-run"), ("hold-tab", "locks-mid-run")] {
            let r = try run(mode, scenario)
            XCTAssertEqual(r.code, 3, "\(mode) \(scenario): \(r.out)")
            XCTAssertTrue(r.out.contains("untested live: the screen is locked"), "\(mode) \(scenario): \(r.out)")
            XCTAssertFalse(r.out.contains("FAIL"), "\(mode) \(scenario): \(r.out)")
        }
    }

    /// second-F5: a precondition the probe couldn't set up (another app in front) is untested, not a regression.
    func testAMissedPreconditionIsUntested() throws {
        for mode in ["hold-tab", "empty-workspace"] {
            let r = try run(mode, "front-elsewhere")
            XCTAssertEqual(r.code, 3, "\(mode): \(r.out)")
            XCTAssertFalse(r.out.contains("FAIL"), "\(mode): \(r.out)")
        }
    }

    /// second-F8: a probe app's pid that quit can be reused by any process of his; only a probe app is ever killed.
    func testOnlyAProbeAppIsEverKilled() throws {
        let r = try run("hold-tab", "reused-pid", runs: 1)
        XCTAssertTrue(r.out.contains("fake: terminated: com.baney.probe-window-app.ProbeA\n"), "the hung probe app is ended: \(r.out)")
        XCTAssertFalse(r.out.contains("com.example.notes"), "another app's process was killed: \(r.out)")
    }

    /// second-F6: no readable state means no way to tell his workspaces from empty ones.
    func testAnUnreadableStateIsUntested() throws {
        for scenario in ["no-state", "bad-state"] {
            let r = try run("reopen-here", scenario)
            XCTAssertEqual(r.code, 3, "\(scenario): \(r.out)")
            XCTAssertTrue(r.out.contains("untested live: can't read state.json"), "\(scenario): \(r.out)")
            XCTAssertTrue(r.out.contains("fake: probe apps left running: 0"), "\(scenario) launched an app: \(r.out)")
        }
    }

    /// first-F1: every run opens ProbeA again (or quits it) while its window is on its own workspace, so every run
    /// tests G6, not just the first.
    func testEveryReopenStartsFromTheAppsWindowOnItsOwnWorkspace() throws {
        let r = try run("reopen-here", "pass", runs: 6)
        XCTAssertEqual(r.code, 0, r.out)
        XCTAssertTrue(r.out.contains("focus-probe reopen-here: pass, 6 of 6 runs right"), r.out)
        XCTAssertTrue(r.out.contains("fake: reopens or quits without a window on the app's own workspace: 0"), r.out)
    }

    /// second-F7: trace.log rotating mid-run loses that run's lines; the run is done again, not failed.
    func testATraceRotationRedoesTheRun() throws {
        let r = try run("hold-tab", "rotation", runs: 3)
        XCTAssertEqual(r.code, 0, r.out)
        XCTAssertTrue(r.out.contains("trace.log rotated, run again"), r.out)
        XCTAssertTrue(r.out.contains("pass, 3 of 3 runs right"), r.out)
    }

    /// first-F3: no run would have launched the apps and then trapped before cleanup.
    func testRunsBelowOneIsAUsageError() throws {
        for n in [0, -1] {
            let r = try run("hold-tab", "pass", runs: n)
            XCTAssertEqual(r.code, 2, r.out)
            XCTAssertFalse(r.out.contains("fake:"), "it started: \(r.out)")
        }
    }

    /// first-F4: any input of his stops it, a modifier, a key let go, a right or other click and a drag included.
    func testTheInputWatchSeesEveryKindOfInput() throws {
        let code = try Repo.code("scripts/focus-probe.swift")
        for type in [".keyDown", ".keyUp", ".flagsChanged", ".leftMouseDown", ".rightMouseDown", ".otherMouseDown",
                     ".leftMouseDragged", ".rightMouseDragged", ".mouseMoved", ".scrollWheel"] {
            XCTAssertTrue(code.contains(type), "the event tap misses \(type)")
        }
    }
}
