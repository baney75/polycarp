import XCTest
@testable import BaneySpacesCore

final class TerminalPlanTests: XCTestCase {
    /// Words a shell or a terminal would read as more than words.
    static let nasty = ["two  words", "it's \"quoted\"", "line one\nline two\n", "-rf", "--dangerously-skip-permissions", "$(touch ran)", "`touch ran`",
                        "$HOME ~ * ? [a] {b,c}", "a; touch ran & | > x < y # z", "\\n \\ \\'", "", " ", "é 漢 🫒", "%s %d", "!!", "'; touch ran; '"]
    private var dir = ""
    private let runner = "/Applications/Poly Carp's.app/polycarp-spaces"

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory()).resolvingSymlinksInPath().path + "/jobs " + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(atPath: dir) }

    private var jobs: TerminalJobs { TerminalJobs(folder: dir + "/j") }

    func testEveryTerminalThatRunsCommandsIsToldTheSameWordsWhateverThePromptIs() throws {
        for word in Self.nasty {
            let job = try XCTUnwrap(TerminalJob(argv: ["/b/claude", "--", word], folder: "/h"))
            let (id, script) = try jobs.write(job, runner: runner)
            let text = try String(contentsOfFile: script, encoding: .utf8)
            XCTAssertEqual(text, "#!/bin/sh\nexec '/Applications/Poly Carp'\\''s.app/polycarp-spaces' 'run-job' '\(id)'\n")
            for bundle in DefaultAppCatalog.runsCommands {
                let plan = try XCTUnwrap(TerminalPlan.run(bundle, folder: "/h", runner: runner, id: id, script: script), bundle)
                switch plan {
                case .ghostty(folder: "/h", script: script): break
                case .openFile(let f): XCTAssertEqual(f, script)
                case .launch(let words):
                    XCTAssertEqual(words.suffix(3), [runner, "run-job", id], bundle)
                    XCTAssertTrue(words.contains("/h"), bundle)
                default: XCTFail("\(bundle) \(plan)")
                }
            }
            XCTAssertEqual(jobs.take(id), job, "the words come back as they went in")
        }
    }

    func testOnlyTheTerminalsThatCanAreGivenACommand() {
        for e in DefaultAppCatalog.entries(.terminal) {
            let can = TerminalPlan.run(e.app.id, folder: "/h", runner: runner, id: "i", script: "/s") != nil
            XCTAssertEqual(can, DefaultAppCatalog.runsCommands.contains(e.app.id), e.name)
            XCTAssertEqual(can, DefaultAppCatalog.note(e.app.id, for: .terminal) == nil, e.name)
        }
    }

    func testAWindowInAFolder() {
        XCTAssertEqual(TerminalPlan.shell("com.mitchellh.ghostty", folder: "/a b"), .ghostty(folder: "/a b", script: nil))
        XCTAssertEqual(TerminalPlan.shell("com.apple.Terminal", folder: "/a b"), .openFile("/a b"))
        XCTAssertEqual(TerminalPlan.shell("org.alacritty", folder: "/a b"), .launch(["--working-directory", "/a b"]))
        XCTAssertEqual(TerminalPlan.shell("net.kovidgoyal.kitty", folder: "/a b"), .launch(["--directory", "/a b"]))
        XCTAssertEqual(TerminalPlan.shell("com.github.wez.wezterm", folder: "/a b"), .launch(["start", "--cwd", "/a b"]))
        XCTAssertEqual(TerminalPlan.shell("com.raphaelamorim.rio", folder: "/a b"), .launch(["--working-dir", "/a b"]))
        XCTAssertEqual(TerminalPlan.shell("dev.warp.Warp-Stable", folder: "/a b&c"), .link("warp://action/new_window?path=/a%20b%26c"))
        XCTAssertEqual(TerminalPlan.shell("x.unknown", folder: "/a b"), .openFile("/a b"))
    }

    /// The real shell, as the runner starts it: a program that prints each word it got between NULs.
    func testEveryWordArrivesWhole() throws {
        let program = dir + "/print words"
        try "#!/bin/sh\nfor w in \"$@\"; do printf '%s\\0' \"$w\"; done > '\(dir)/got'\n".write(toFile: program, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: program)
        let job = try XCTUnwrap(TerminalJob(argv: [program] + Self.nasty, folder: dir))
        let p = Process()
        p.executableURL = URL(fileURLWithPath: job.exec[0])
        p.arguments = Array(job.exec.dropFirst())
        p.currentDirectoryURL = URL(fileURLWithPath: dir)
        // No profile of anyone's, and the shell left at the end is one that quits at once.
        p.environment = job.environment(["HOME": dir, "ZDOTDIR": dir, "SHELL": "/usr/bin/true", "PATH": "/usr/bin:/bin"])
        try p.run()
        p.waitUntilExit()
        let got = try Data(contentsOf: URL(fileURLWithPath: dir + "/got")).split(separator: 0, omittingEmptySubsequences: false).dropLast()
        XCTAssertEqual(got.map { String(decoding: $0, as: UTF8.self) }, Self.nasty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir + "/ran"))
        XCTAssertEqual(job.environment(["PATH": "/usr/bin"])["PATH"], dir + ":/usr/bin")
    }

    func testAJobIsPrivateAndReadOnce() throws {
        let job = try XCTUnwrap(TerminalJob(argv: ["/b/x", "secret"], folder: "/"))
        let (id, script) = try jobs.write(job, runner: runner)
        func mode(_ p: String) throws -> Int? { try FileManager.default.attributesOfItem(atPath: p)[.posixPermissions] as? Int }
        XCTAssertEqual(try mode(dir + "/j"), 0o700)
        XCTAssertEqual(try mode(dir + "/j/job-\(id).json"), 0o600)
        XCTAssertEqual(try mode(script), 0o700)
        XCTAssertEqual(jobs.take(id), job)
        XCTAssertNil(jobs.take(id))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir + "/j"), [])
        for bad in ["", "../x", id + "/../x", "job"] { XCTAssertNil(jobs.take(bad), bad) }
    }

    func testAJobNobodyTookIsDeleted() throws {
        let job = try XCTUnwrap(TerminalJob(argv: ["/b/x"], folder: "/"))
        let (id, _) = try jobs.write(job, runner: runner)
        jobs.clean(now: Date().addingTimeInterval(TerminalJobs.keep - 5))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir + "/j").count, 2)
        jobs.clean(now: Date().addingTimeInterval(TerminalJobs.keep + 5))
        XCTAssertNil(jobs.take(id))
    }

    func testWhatIsNoJob() {
        XCTAssertNil(TerminalJob(argv: [], folder: "/"))
        XCTAssertNil(TerminalJob(argv: ["claude"], folder: "/"), "a name is looked up by a shell; a path is not")
        XCTAssertNil(TerminalJob(argv: ["/b/x", "a\0b"], folder: "/"))
        XCTAssertNil(TerminalJob(argv: ["/b/x"], folder: "here"))
        XCTAssertNil(TerminalJob(argv: ["/b/x", String(repeating: "a", count: 200_001)], folder: "/"))
    }

    // MARK: Agents

    func testEveryAgentTakesAPromptAsOneWordOrNotAtAll() {
        for c in DefaultAppCatalog.commands(.agent) {
            XCTAssertNotNil(AgentLaunch.prompts[c.id], c.id)
            XCTAssertEqual(AgentLaunch.argv(c.id, at: "/b/x", prompt: nil).argv, ["/b/x"])
            for word in Self.nasty where !word.isEmpty {
                let (argv, clip) = AgentLaunch.argv(c.id, at: "/b/x", prompt: word)
                if let clip {
                    XCTAssertEqual(clip, word, c.id)
                    XCTAssertEqual(argv, ["/b/x"], c.id)
                } else {
                    let last = argv[argv.count - 1]
                    XCTAssertTrue(last == word || last.hasSuffix("=" + word), c.id)
                    if word.hasPrefix("-") {
                        XCTAssertTrue(argv[argv.count - 2] == "--" || last.hasPrefix("--") && last != word, "\(c.id): a dash is no option")
                    }
                }
            }
        }
        XCTAssertEqual(AgentLaunch.argv("pi", at: "/b/pi", prompt: "@file").clipboard, "@file")
        XCTAssertEqual(AgentLaunch.argv("claude", at: "/b/c", prompt: "fix the build").argv, ["/b/c", "--", "fix the build"])
        XCTAssertEqual(AgentLaunch.argv("pi", at: "/b/pi", prompt: "fix the build").argv, ["/b/pi", "fix the build"])
    }

    /// `claude -- update` runs its updater: a command's first word is read as one of its commands, `--` or not.
    func testOneWordIsNeverACommand() {
        for id in ["claude", "codex", "cursor-agent", "pi"] {
            for word in ["update", "mcp", "doctor", "login", "-rf"] {
                XCTAssertEqual(AgentLaunch.argv(id, at: "/b/x", prompt: word).argv, ["/b/x"], "\(id) \(word)")
                XCTAssertEqual(AgentLaunch.argv(id, at: "/b/x", prompt: word).clipboard, word)
            }
        }
        XCTAssertEqual(AgentLaunch.argv("opencode", at: "/b/o", prompt: "update").argv, ["/b/o", "--prompt=update"], "joined to its option")
    }

    func testNoAgentIsStartedWithItsQuestionsOff() {
        for c in DefaultAppCatalog.commands(.agent) {
            for word in AgentLaunch.argv(c.id, at: "/b/x", prompt: "fix it").argv {
                for flag in ["skip", "danger", "yolo", "bypass", "auto", "allow", "trust", "force", "approve", "sandbox", "-y"] {
                    XCTAssertFalse(word.lowercased().contains(flag), "\(c.id) \(word)")
                }
            }
        }
    }
}
