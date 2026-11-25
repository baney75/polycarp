import XCTest
@testable import BaneySpacesCore

/// Settings > Appearance > Looks: the commands it runs and how it reads their answers. The last test
/// runs the real `polycarp` and skips where it isn't built.
final class LooksTests: XCTestCase {
    func testEachButtonIsOneCommandAPersonCouldRun() {
        XCTAssertEqual(LookCommands.list, ["look", "list", "--json"])
        XCTAssertEqual(LookCommands.apply("desk"), ["look", "apply", "desk", "--json"])
        XCTAssertEqual(LookCommands.undo, ["look", "undo", "--json"])
        XCTAssertEqual(LookCommands.save("desk", title: "Desk", replace: false), ["look", "save", "desk", "--title", "Desk", "--json"])
        XCTAssertEqual(LookCommands.save("desk", title: "Desk", replace: true), ["look", "save", "desk", "--title", "Desk", "--force", "--json"])
        XCTAssertEqual(LookCommands.importFile("/a b.polycarp-look", replace: false), ["look", "import", "/a b.polycarp-look", "--json"])
        XCTAssertEqual(LookCommands.importFile("/a.polycarp-look", replace: true), ["look", "import", "/a.polycarp-look", "--force", "--json"])
        XCTAssertEqual(LookCommands.export("desk", to: "/d.polycarp-look"), ["look", "export", "desk", "/d.polycarp-look", "--force", "--json"])
    }

    func testATypedTitleBecomesANameTheCommandTakes() {
        for (title, name) in [("Evening desk", "evening-desk"), ("  Olive & Gold! ", "olive-gold"), ("Été", "ete"), ("2026", "2026"),
                              ("a/../b", "a-b"), ("--force", "force"), ("My Polycarp", "my-polycarp")] {
            XCTAssertEqual(LookCommands.name(for: title), name)
        }
        for none in ["", "   ", "!!", "../..", "日本", "Polycarp", " polycarp "] { XCTAssertNil(LookCommands.name(for: none), none) }
        let long = LookCommands.name(for: String(repeating: "ab ", count: 40))!
        XCTAssertLessThanOrEqual(long.count, 48)
        XCTAssertFalse(long.hasSuffix("-"))
    }

    func testTheListIsReadWithEachLooksColorsAndProblems() {
        let page = ##"{"background": "#ffffff", "surface": "#eeeeee", "foreground": "#111111", "accent": "#225588"}"##
        let reply = ThemeCommandReply(stdout: Data("""
        {"ok": true, "data": {"can_undo": true, "looks": [
          {"name": "polycarp", "title": "Polycarp", "source": "shipped", "current": false, "colors": {"light": \(page), "dark": \(page)}, "problems": []},
          {"name": "desk", "title": "Desk", "source": "saved", "current": true, "colors": {"light": \(page), "dark": \(page)}, "problems": []},
          {"name": "bad", "title": "Bad", "source": "saved", "current": false, "colors": null, "problems": ["schema: must be 1"]},
          {"name": "gone", "source": "saved", "colors": null}
        ], "notes": ["left out bar.modules: custom:me"]}}
        """.utf8), status: 0)
        XCTAssertEqual(reply.looks.map(\.name), ["polycarp", "desk", "bad", "gone"])
        XCTAssertEqual(reply.looks.map(\.shipped), [true, false, false, false])
        XCTAssertEqual(reply.looks.map(\.current), [false, true, false, false])
        XCTAssertEqual(reply.looks[1].light.map(\.hex), ["#FFFFFF", "#EEEEEE", "#111111", "#225588"])
        XCTAssertEqual(reply.looks.map(\.problem), [nil, nil, "schema: must be 1", "This look can't be used."])
        XCTAssertTrue(reply.looks[2].dark.isEmpty)
        XCTAssertTrue(reply.canUndoLook)
        XCTAssertEqual(reply.notes, ["left out bar.modules: custom:me"])
        let refused = ThemeCommandReply(stdout: Data(#"{"ok": false, "error": {"code": "exists", "message": "you already have a look named \"desk\""}}"#.utf8), status: 1)
        XCTAssertTrue(refused.looks.isEmpty)
        XCTAssertFalse(refused.canUndoLook)
        XCTAssertEqual(refused.notes, [])
    }

    // MARK: The real command

    func testTheButtonsRunTheRealCommand() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("looks-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let bin = try binary()
        // A home, config folder and path of its own, and no polycarp-spaces: nothing on this Mac is read or changed.
        func run(_ args: [String]) throws -> ThemeCommandReply {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: bin)
            p.arguments = args
            p.currentDirectoryURL = URL(fileURLWithPath: "/")
            p.environment = ["HOME": dir.path, "POLYCARP_CONFIG_DIR": dir.appendingPathComponent("cfg").path, "PATH": dir.path,
                             "POLYCARP_NO_SYSTEM_SPOTS": "1", "POLYCARP_SPACES_BIN": dir.appendingPathComponent("none").path]
            let out = Pipe(), err = Pipe()
            p.standardOutput = out; p.standardError = err; p.standardInput = FileHandle.nullDevice
            try p.run()
            let o = out.fileHandleForReading.readDataToEndOfFile(), e = err.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return ThemeCommandReply(stdout: o, stderr: e, status: p.terminationStatus)
        }
        let help = try run(["look", "list", "--json"])
        guard help.ok else { throw XCTSkip("this polycarp has no look command: \(help.message)") }
        XCTAssertEqual(help.looks.map(\.name), [LookCommands.shipped])
        XCTAssertEqual(help.looks.first?.light.count, 4)
        XCTAssertFalse(help.canUndoLook)

        let name = try XCTUnwrap(LookCommands.name(for: "Evening desk"))
        let saved = try run(LookCommands.save(name, title: "Evening desk", replace: false))
        XCTAssertTrue(saved.ok, saved.message)
        XCTAssertFalse(saved.notes.isEmpty, "without polycarp-spaces it says the look holds the theme alone")
        XCTAssertEqual(try run(LookCommands.save(name, title: "Evening desk", replace: false)).code, "exists")
        XCTAssertTrue(try run(LookCommands.save(name, title: "Evening desk", replace: true)).ok)
        XCTAssertEqual(try run(LookCommands.list).looks.first { $0.name == name }?.title, "Evening desk")

        let file = dir.appendingPathComponent("desk.\(LookCommands.fileExtension)")
        XCTAssertTrue(try run(LookCommands.export(name, to: file.path)).ok)
        XCTAssertTrue(try run(LookCommands.export(name, to: file.path)).ok, "the save panel has asked already")
        XCTAssertEqual(try run(LookCommands.importFile(file.path, replace: false)).code, "exists")
        XCTAssertTrue(try run(LookCommands.importFile(file.path, replace: true)).ok)

        XCTAssertTrue(try run(["theme", "set", "evening", "--json"]).ok)
        let applied = try run(LookCommands.apply(name))
        XCTAssertTrue(applied.ok, applied.message)
        XCTAssertEqual(applied.data["changed"] as? Bool, true)
        XCTAssertTrue(try run(LookCommands.list).canUndoLook)
        XCTAssertTrue(try run(LookCommands.undo).ok)
        XCTAssertEqual(try run(["theme", "current", "--json"]).data["theme"] as? String, "evening")
        XCTAssertTrue(try run(LookCommands.apply("gone")).message.contains("gone"))

        // A damaged look is in the list with the command's own words for why.
        try Data("{".utf8).write(to: dir.appendingPathComponent("cfg/looks/bad.\(LookCommands.fileExtension)"))
        let bad = try XCTUnwrap(run(LookCommands.list).looks.first { $0.name == "bad" }?.problem)
        XCTAssertTrue(bad.contains("not a look file"), bad)
    }

    private func binary() throws -> String {
        if let b = ProcessInfo.processInfo.environment["POLYCARP_BIN"], !b.isEmpty { return b }
        let cli = Repo.root.deletingLastPathComponent().appendingPathComponent("cli/target")
        for p in ["debug", "release"] {
            let c = cli.appendingPathComponent(p).appendingPathComponent("polycarp").path
            if FileManager.default.isExecutableFile(atPath: c) { return c }
        }
        throw XCTSkip("the polycarp binary is not built: set POLYCARP_BIN or run `cargo build --manifest-path cli/Cargo.toml`.")
    }
}
