import XCTest
@testable import BaneySpacesCore

final class RoleKeysTests: XCTestCase {
    private let cmd: Set<Chord.Mod> = [.cmd]
    private func plan(_ text: String = "", owner: @escaping (Chord) -> String? = { _ in nil }) -> RoleKeys.Plan { RoleKeys.plan(text, mod: cmd, owner: owner) }
    private func active(_ p: RoleKeys.Plan) -> [String: String] {
        Dictionary(p.active.map { ($0.chord.text, RoleKeys.action($0.role, new: $0.new)) }) { "\($0) and \($1)" }
    }

    func testSpelling() {
        XCTAssertEqual(Chord("Cmd+Ctrl+Shift+B", mod: [])?.text, "ctrl+shift+cmd+b")
        XCTAssertEqual(Chord("mod+return", mod: [.ctrl, .alt])?.text, "ctrl+alt+return")
        for bad in ["", "b", "shift+b", "cmd+", "cmd+nose", "hyper+b", "cmd++b"] { XCTAssertNil(Chord(bad, mod: cmd), bad) }
        XCTAssertEqual(Chord("f6", mod: [])?.keyCode, 97)
        XCTAssertEqual(Chord("ctrl+cmd+b", mod: [])?.carbon, 0x1100)
        XCTAssertEqual(Chord("ctrl+alt+slash", mod: [])?.tokens, ["ctrl", "opt", "/"])
        XCTAssertEqual(Chord(keyCode: 36, mods: [.cmd])?.text, "cmd+return")
        XCTAssertEqual(Set(Chord.codes.values).count, Chord.codes.count)
    }

    func testThreeJobsAreBoundAndOptionOpensAWindow() {
        XCTAssertEqual(active(plan()), [
            "ctrl+cmd+return": "open terminal", "ctrl+alt+cmd+return": "open terminal --new",
            "ctrl+shift+cmd+b": "open browser", "ctrl+alt+shift+cmd+b": "open browser --new",
            "ctrl+shift+cmd+a": "open agent", "ctrl+alt+shift+cmd+a": "open agent --new",
        ])
        XCTAssertEqual(Set(AppRole.allCases.map(RoleKeys.suggested)).count, AppRole.allCases.count)
        for role in AppRole.allCases {
            XCTAssertNil(RoleKeys.polycarpOwner(RoleKeys.suggested(role), mod: cmd), role.rawValue)
            XCTAssertNil(RoleKeys.systemOwner(RoleKeys.suggested(role), hotkeys: [:]), role.rawValue)
        }
    }

    func testYourFileMovesAKeyAddsOneAndTakesOneAway() {
        let p = plan("[keys.bindings]\n\"mod+alt+t\" = \"open terminal\"\n\"ctrl+cmd+shift+e\" = \"open mail\"\n\"ctrl+cmd+shift+a\" = \"none\"\n\"cmd+f6\" = \"open browser --new\"\n")
        XCTAssertEqual(active(p), [
            "alt+cmd+t": "open terminal", "ctrl+shift+cmd+e": "open mail", "ctrl+alt+shift+cmd+e": "open mail --new",
            "ctrl+shift+cmd+b": "open browser", "cmd+f6": "open browser --new",
        ], "a role with a chord of yours loses its default one, and only yours opens the window")
        XCTAssertEqual(p.of(.agent).map(\.taken), ["you, for nothing"])
        XCTAssertEqual(p.warnings, [])
    }

    func testATakenChordIsLeftToWhoHasIt() {
        let p = plan(owner: { $0.text == "ctrl+shift+cmd+b" ? "macOS" : nil })
        XCTAssertEqual(p.of(.browser).map(\.taken), ["macOS"])
        XCTAssertEqual(p.of(.browser, new: true), [], "nor the Option one, which would be half a pair")
        XCTAssertNotNil(active(p)["ctrl+cmd+return"])
        XCTAssertEqual(plan("[keys.bindings]\n\"cmd+1\" = \"open mail\"\n", owner: { RoleKeys.polycarpOwner($0, mod: [.cmd]) }).of(.mail).map(\.taken),
                       ["Polycarp, for go to workspace 1 to 9"], "yours too")
        XCTAssertEqual(plan("[keys.bindings]\n\"ctrl+cmd+return\" = \"exec ghostty\"\n").of(.terminal).map(\.taken), ["your own binding, exec ghostty"])
    }

    func testOneChordOpensOneThing() {
        let p = plan("[keys.bindings]\n\"ctrl+cmd+shift+b\" = \"open mail\"\n\"cmd+f5\" = \"open notes\"\n\"f5\" = \"open music\"\n\"mod+f5\" = \"open files\"\n")
        XCTAssertEqual(active(p)["ctrl+shift+cmd+b"], "open mail")
        XCTAssertEqual(p.of(.browser).map(\.taken), ["Polycarp, for open mail"])
        XCTAssertEqual(p.of(.files).map(\.taken), ["Polycarp, for open notes"])
    }

    func testWhatCantBeReadIsSaidAndTheRestStands() {
        let p = plan("broken\n[keys.bindings]\n\"cmd+nose\" = \"open mail\"\n\"cmd+f5\" = \"open agent --prompt hi\"\n\"cmd+f6\" = \"open mail\"\noops\n\"cmd+nose\" = \"switch 1\"\n[theme]\n\"cmd+f7\" = \"open mail\"\n")
        XCTAssertEqual(p.warnings.count, 2)
        XCTAssertTrue(p.warnings[0].hasPrefix("keys.bindings.\"cmd+nose\" (line 3)"))
        XCTAssertEqual(active(p)["cmd+f6"], "open mail")
        XCTAssertNil(active(p)["cmd+f7"])
        XCTAssertNil(active(p)["cmd+f5"], "a key types no prompt")
    }

    func testWhoHasAChord() {
        func own(_ s: String) -> String? { RoleKeys.polycarpOwner(Chord(s, mod: cmd)!, mod: cmd) }
        XCTAssertEqual(own("ctrl+cmd+k"), "Polycarp, for open the launcher")
        XCTAssertEqual(own("mod+shift+9"), "Polycarp, for move the window in front to workspace 1 to 9")
        XCTAssertEqual(own("ctrl+grave"), "Polycarp, for drop down the quick terminal")
        XCTAssertNil(own("ctrl+cmd+return"), "its own rows are no one else's")
        XCTAssertNil(own("cmd+i"), "a key of the player's window is free elsewhere")
        // As macOS writes it, with a bit that is no modifier.
        func entry(_ on: Bool) -> [String: Any] { ["9": ["enabled": on, "value": ["parameters": [98, 11, 1_441_792 | 0x800000], "type": "standard"]]] }
        XCTAssertNotNil(RoleKeys.systemOwner(Chord("ctrl+cmd+shift+b", mod: [])!, hotkeys: entry(true)))
        XCTAssertNil(RoleKeys.systemOwner(Chord("ctrl+cmd+shift+b", mod: [])!, hotkeys: entry(false)))
        XCTAssertNil(RoleKeys.systemOwner(Chord("ctrl+cmd+b", mod: [])!, hotkeys: entry(true)))
        XCTAssertEqual(RoleKeys.systemOwner(Chord("ctrl+cmd+q", mod: [])!, hotkeys: [:]), "macOS")
    }

    func testTheShortcutListShowsTheKeysYouHave() {
        func rows(_ p: RoleKeys.Plan) -> [KeyBinding] { Keymap.rows(p).filter { $0.id.hasPrefix(RoleKeys.rowPrefix) } }
        // As it comes, the list is the table, but for the note that says when.
        XCTAssertEqual(Keymap.rows(plan()).map(\.id).sorted(), Keymap.all.map(\.id).sorted())
        for r in rows(plan()) { XCTAssertEqual(r.keys, Keymap.binding(r.id)?.keys); XCTAssertEqual(r.title, Keymap.binding(r.id)?.title) }
        let p = plan("[keys.bindings]\n\"cmd+f5\" = \"open mail\"\n\"cmd+f6\" = \"open mail\"\n\"cmd+f7\" = \"open browser --new\"\n\"cmd+f8\" = \"open mail --new\"\n",
                     owner: { $0.text == "ctrl+cmd+return" ? "macOS" : nil })
        XCTAssertEqual(rows(p).map(\.id), ["role.mail", "role.mail.cmd+f6", "role.browser.new", "role.mail.new", "role.agent", "role.browser"])
        XCTAssertEqual(rows(p).first { $0.id == "role.browser" }?.note, nil, "Option doesn't open a window of it here")
        XCTAssertEqual(rows(p).first { $0.id == "role.agent" }?.note, "Add ⌥ for a new window")
        XCTAssertTrue(rows(p).allSatisfy { $0.scope == .global && $0.group == .apps })
    }

    func testAChordMacOSRefusesIsSomebodyElses() {
        let p = plan().leaving([Chord("ctrl+cmd+return", mod: [])!])
        XCTAssertEqual(p.of(.terminal).map(\.taken), ["another app"])
        XCTAssertFalse(Keymap.rows(p).contains { $0.id == "role.terminal" })
        XCTAssertNil(p.of(.browser).first?.taken)
    }

    /// A tiling key this person moved onto a job's chord keeps it: the plan reads their keys, not the ones Polycarp comes with.
    func testATilingKeyMovedOntoAJobsChordKeepsIt() throws {
        guard case .success(let v) = SurfaceValue.parse(Data(#"{"tiling":{"keys":{"toggle":"ctrl+shift+cmd+B"}}}"#.utf8)) else {
            return XCTFail("surfaces.json didn't parse")
        }
        let mine = Keymap.rows(try Surfaces.check(v).get().surfaces)
        let p = plan(owner: { RoleKeys.polycarpOwner($0, mod: [.cmd], in: mine) })
        XCTAssertEqual(p.of(.browser).map(\.taken), ["Polycarp, for tile this workspace, or stop"])
        XCTAssertNil(active(p)["ctrl+shift+cmd+b"])
        XCTAssertNotNil(active(p)["ctrl+cmd+return"])
        XCTAssertNil(RoleKeys.polycarpOwner(Chord("ctrl+shift+cmd+b", mod: [])!, mod: [.cmd]), "free among the keys Polycarp comes with")
    }

    func testTheAppTakesOnlyWhatThePlanGivesIt() throws {
        let app = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        let keys = try XCTUnwrap(SourceText.block(after: "func registerShortcuts()", in: app))
        let gate = try XCTUnwrap(keys.range(of: "guard started else { return }")), call = try XCTUnwrap(keys.range(of: "RoleHotkeys.register(hotkeys)"))
        XCTAssertLessThan(gate.lowerBound, call.lowerBound, "no key is taken before Polycarp works")
        let tiling = try XCTUnwrap(keys.range(of: "registerTilingKeys()"))
        XCTAssertLessThan(tiling.lowerBound, call.lowerBound, "a chord another Polycarp key has costs the job's key")
        let plan = try SourceText.code("Sources/BaneySpacesCore/RoleKeys.swift")
        XCTAssertTrue(plan.contains("let mine = Keymap.rows(surfaces())"))
        XCTAssertTrue(plan.contains("polycarpOwner($0, mod: mod, in: mine)"))
        let code = try SourceText.code("Sources/BaneySpaces/DefaultApps/RoleHotkeys.swift")
        XCTAssertTrue(code.contains("for b in store.now.keys.active {"))
        XCTAssertTrue(code.contains("if !given { store.refused.insert(b.chord) }"))
    }

    func testTheModifierIsTheAppsSetting() {
        XCTAssertEqual(RoleKeys.mod(setting: "controlOption"), [.ctrl, .alt])
        XCTAssertEqual(["command", "control", "option", nil].map { RoleKeys.mod(setting: $0) }, [[.cmd], [.ctrl], [.alt], [.cmd]])
    }
}
