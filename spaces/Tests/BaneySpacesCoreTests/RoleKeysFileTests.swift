import XCTest
@testable import BaneySpacesCore

/// Settings › Keys changing a job's key: the lines it writes, what it refuses, and the recorder's wiring.
final class RoleKeysFileTests: XCTestCase {
    private let cmd: Set<Chord.Mod> = [.cmd]
    private func edit(_ text: String, _ role: AppRole, _ change: RoleKeysFile.Change) throws -> String {
        try RoleKeysFile.edit(text, role: role, change, mod: cmd)
    }
    private func chord(_ s: String) -> Chord { Chord(s, mod: cmd)! }
    private func plan(_ text: String, owner: @escaping (Chord) -> String? = { _ in nil }) -> RoleKeys.Plan { RoleKeys.plan(text, mod: cmd, owner: owner) }

    func testAKeyOfYoursIsOneLine() throws {
        XCTAssertEqual(try edit("", .mail, .chord(chord("ctrl+cmd+e"))), "[keys.bindings]\n\"ctrl+cmd+e\" = \"open mail\"\n")
        XCTAssertEqual(try edit("# mine\n[defaults]\nmail = \"com.apple.mail\"\n", .terminal, .chord(chord("cmd+f6"))),
                       "# mine\n[defaults]\nmail = \"com.apple.mail\"\n\n[keys.bindings]\n\"cmd+f6\" = \"open terminal\"\n")
        XCTAssertEqual(try edit("[keys.bindings]\n", .mail, .chord(chord("cmd+f6"))), "[keys.bindings]\n\"cmd+f6\" = \"open mail\"\n")
    }

    func testMovingItKeepsEveryOtherLine() throws {
        let text = "[keys.bindings]\r\n# notes\r\n\"cmd+f6\" = \"open mail\"\r\n\"cmd+f7\" = \"open mail --new\"\r\n\r\n[other]\r\na = 1\r\n"
        XCTAssertEqual(try edit(text, .mail, .chord(chord("cmd+f8"))), text.replacingOccurrences(of: "\"cmd+f6\"", with: "\"cmd+f8\""))
        XCTAssertEqual(try edit(text, .notes, .chord(chord("cmd+f9"))),
                       text.replacingOccurrences(of: "--new\"\r\n", with: "--new\"\r\n\"cmd+f9\" = \"open notes\"\r\n"))
    }

    func testTakingItAway() throws {
        XCTAssertEqual(try edit("[keys.bindings]\n\"cmd+f6\" = \"open mail\"\n", .mail, .off), "[keys.bindings]\n")
        // The default one has to be said no to; its own chord moves in place.
        let off = try edit("", .agent, .off)
        XCTAssertEqual(off, "[keys.bindings]\n\"ctrl+shift+cmd+a\" = \"none\"\n")
        XCTAssertNil(RoleKeysText.key(.agent, plan(off)))
        XCTAssertEqual(try edit(off, .agent, .off), off)
        XCTAssertEqual(try edit(off, .agent, .standard), "[keys.bindings]\n")
        XCTAssertEqual(try edit(off, .agent, .chord(RoleKeys.suggested(.agent))), "[keys.bindings]\n", "what it comes with needs no line")
        XCTAssertEqual(try edit("[keys.bindings]\n\"cmd+f6\" = \"open agent\"\n", .agent, .standard), "[keys.bindings]\n")
    }

    func testAChordGivenToNothingCanBeUsedAndAnotherLinesCant() throws {
        XCTAssertEqual(try edit("[keys.bindings]\n\"cmd+f6\" = \"none\"\n", .mail, .chord(chord("cmd+f6"))), "[keys.bindings]\n\"cmd+f6\" = \"open mail\"\n")
        XCTAssertThrowsError(try edit("[keys.bindings]\n\"cmd+f6\" = \"open notes\"\n", .mail, .chord(chord("cmd+f6")))) {
            XCTAssertTrue("\($0)".contains("line 2"), "\($0)")
        }
    }

    /// What a line can't change is left alone, whole.
    func testAFileWrittenAnotherWayIsRefused() {
        for text in ["keys.bindings = { \"cmd+f6\" = \"open mail\" }\n", "[keys]\nbindings.\"cmd+f6\" = \"open mail\"\n"] where !RoleKeys.lines(text).isEmpty {
            XCTAssertThrowsError(try edit(text, .mail, .off), text)
        }
    }

    func testWritingKeepsTheRestAndTheFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/config.toml"
        try RoleKeysFile.set(.mail, .chord(chord("cmd+f6")), modifier: "cmd", path: path)
        try RoleKeysFile.set(.agent, .off, modifier: "cmd", path: path)
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8),
                       "[keys.bindings]\n\"cmd+f6\" = \"open mail\"\n\"ctrl+shift+cmd+a\" = \"none\"\n")
    }

    func testWhoHasItIsSaid() {
        let p = plan("")
        XCTAssertEqual(RoleKeysText.refusal(chord("ctrl+shift+cmd+b"), .mail, p) { _ in nil }, "⌃⇧⌘B is taken: Polycarp, for open browser.")
        XCTAssertNil(RoleKeysText.refusal(chord("ctrl+shift+cmd+b"), .browser, p) { _ in nil }, "its own")
        XCTAssertEqual(RoleKeysText.refusal(chord("cmd+f6"), .mail, p) { _ in "macOS" }, "⌘F6 is taken: macOS.")
        XCTAssertNil(RoleKeysText.refusal(chord("cmd+f6"), .mail, p) { _ in nil })
    }

    func testAPress() {
        XCTAssertEqual(RoleKeysText.press(keyCode: 53, mods: []), .cancel)
        XCTAssertEqual(RoleKeysText.press(keyCode: 51, mods: []), .clear)
        XCTAssertEqual(RoleKeysText.press(keyCode: 36, mods: [.cmd, .ctrl]), .chord(chord("ctrl+cmd+return")))
        for mods: Set<Chord.Mod> in [[], [.shift]] { XCTAssertEqual(RoleKeysText.press(keyCode: 11, mods: mods), .needsMore) }
        XCTAssertEqual(RoleKeysText.press(keyCode: 999, mods: [.cmd]), .needsMore)
    }

    func testTheRow() {
        let p = plan("[keys.bindings]\n\"cmd+f6\" = \"open mail\"\n") { $0.text == "ctrl+shift+cmd+b" ? "macOS" : nil }
        XCTAssertEqual(RoleKeysText.key(.mail, p), "⌘F6")
        XCTAssertEqual(RoleKeysText.line(.mail, p), "Goes to its window, or opens one. ⌥⌘F6 always opens one")
        XCTAssertEqual(RoleKeysText.key(.terminal, p), "⌃⌘Return")
        XCTAssertNil(RoleKeysText.key(.browser, p))
        XCTAssertEqual(RoleKeysText.line(.browser, p), "⌃⇧⌘B is taken: macOS")
        XCTAssertEqual(RoleKeysText.line(.notes, p), "No key")
        XCTAssertEqual(RoleKeysText.line(.agent, plan("[keys.bindings]\n\"ctrl+shift+cmd+a\" = \"none\"\n")), "No key")
        XCTAssertEqual(RoleKeysText.suggestion(.agent), .standard)
        XCTAssertEqual(RoleKeysText.suggestion(.mail), .chord(RoleKeys.suggested(.mail)))
    }

    /// While a key is recorded Polycarp's own are off, they come back however it ends, and a taken chord isn't written.
    func testTheRecorder() throws {
        let group = try SourceText.code("Sources/BaneySpaces/DefaultApps/RoleKeysGroup.swift")
        let start = try XCTUnwrap(SourceText.block(after: "private func start(_ role: AppRole) ", in: group))
        let stop = try XCTUnwrap(SourceText.block(after: "private func stop() ", in: group))
        XCTAssertTrue(start.contains("pauseKeys(true)"))
        XCTAssertTrue(stop.contains("pauseKeys(false)") && stop.contains("removeMonitor"))
        XCTAssertTrue(group.contains(".onDisappear(perform: stop)"))
        XCTAssertTrue(group.contains("NSWindow.didResignKeyNotification)) { _ in stop() }"))
        XCTAssertFalse(group.contains("addGlobalMonitor"), "only keys typed into Settings")
        let app = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        let keys = try XCTUnwrap(SourceText.block(after: "func registerShortcuts()", in: app))
        let pause = try XCTUnwrap(keys.range(of: "guard !keysPaused else { return }")), first = try XCTUnwrap(keys.range(of: "Launcher.onCmdSpace"))
        XCTAssertTrue(pause.lowerBound < first.lowerBound)
        let store = try SourceText.code("Sources/BaneySpaces/DefaultApps/DefaultAppsStore.swift")
        let set = try XCTUnwrap(SourceText.block(after: "func setKey(_ role: AppRole, _ change: RoleKeysFile.Change, done: @escaping (String?) -> Void) ", in: store))
        XCTAssertTrue(set.contains("queue.async {") && set.contains("RoleKeysText.refusal(") && set.contains("if problem == nil {"))
    }
}
