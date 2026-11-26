import XCTest
@testable import BaneySpacesCore

final class TilingShortcutsTests: XCTestCase {
    private func settings(_ change: (inout Surfaces.Tiling) -> Void = { _ in }) -> Surfaces.Tiling {
        var t = Surfaces.defaults.tiling
        change(&t)
        return t
    }

    func testOnlyTheToggleIsTakenUntilSomethingTiles() {
        XCTAssertEqual(TilingShortcuts(settings(), voiceOver: false).keys, [.init(name: "toggle", chord: KeyChord("ctrl+opt+T")!)])
        let all = TilingShortcuts(settings { $0.on = [3] }, voiceOver: false).keys
        XCTAssertEqual(all.map(\.name), TilingKeys.all.filter { !$0.key.isEmpty }.map(\.name))
        XCTAssertEqual(TilingShortcuts(settings { $0.enabled = true }, voiceOver: false).keys, all)
        XCTAssertEqual(TilingShortcuts(settings { $0.keys["toggle"] = nil }, voiceOver: false).keys, [], "no key, none taken")
    }

    func testTheScratchpadsKeysStayWhileItHoldsAWindow() {
        let off = TilingShortcuts(settings(), voiceOver: false, keep: ["scratchpad", "scratchpad-send"])
        XCTAssertEqual(off.keys.map(\.name), ["toggle", "scratchpad", "scratchpad-send"])
        XCTAssertEqual(off.keys[1].chord, KeyChord("ctrl+opt+-"))
        XCTAssertEqual(TilingShortcuts(settings { $0.enabled = true }, voiceOver: false, keep: ["scratchpad", "pin"]),
                       TilingShortcuts(settings { $0.enabled = true }, voiceOver: false))
    }

    func testVoiceOverKeepsItsKeys() {
        let t = settings { $0.enabled = true; $0.keys["float"] = KeyChord("ctrl+shift+F") }
        let s = TilingShortcuts(t, voiceOver: true)
        XCTAssertEqual(s.keys.map(\.name), ["float"])
        XCTAssertEqual(Set(s.toVoiceOver), Set(t.keys.keys).subtracting(["float"]))
        XCTAssertEqual(TilingShortcuts(t, voiceOver: false).toVoiceOver, [])
    }

    func testCarbonModifiers() {
        XCTAssertEqual(KeyChord("ctrl+opt+T")!.carbon, 0x1800)
        XCTAssertEqual(KeyChord("ctrl+opt+shift+cmd+T")!.carbon, 0x1B00)
    }

    func testEveryCommandWithAKeyIsOneTheEngineRuns() {
        for k in TilingKeys.all { XCTAssertNotNil(TilingCommand(words: [k.name]), k.name) }
    }

    // MARK: The shortcut list

    func testTheListHasTheKeysThePersonHas() {
        func rows(_ t: Surfaces.Tiling) -> [String: String] {
            var s = Surfaces.defaults
            s.tiling = t
            let mine = Keymap.rows(s).filter { $0.id.hasPrefix("tile.") }
            return Dictionary(uniqueKeysWithValues: mine.map { ($0.id, $0.display(modifierSymbol: "⌘")) })
        }
        XCTAssertEqual(rows(settings()), ["tile.toggle": "⌃⌥T"])
        let on = rows(settings { $0.enabled = true })
        XCTAssertEqual(on["tile.focus"], "⌃⌥←→↑↓")
        XCTAssertEqual(on["tile.move"], "⌃⌥⇧←→↑↓")
        XCTAssertEqual(on["tile.grow"], "⌃⌥⌘←→↑↓")
        XCTAssertEqual(on["tile.focus-next"], "⌃⌥]")
        XCTAssertNil(on["tile.focus-left"])
        XCTAssertNil(on["tile.style-main"], "it comes with no key")
        XCTAssertEqual(on.count, 25)
        let changed = rows(settings { $0.enabled = true; $0.keys["focus-left"] = KeyChord("ctrl+opt+H"); $0.keys["balance"] = nil })
        XCTAssertNil(changed["tile.focus"], "the four no longer go together")
        XCTAssertEqual(changed["tile.focus-left"], "⌃⌥H")
        XCTAssertEqual(changed["tile.focus-right"], "⌃⌥→")
        XCTAssertNil(changed["tile.balance"])
        let mixed = rows(settings { $0.enabled = true; $0.keys["focus-left"] = KeyChord("ctrl+cmd+Left") })
        XCTAssertNil(mixed["tile.focus"], "the same arrows under other modifiers are no family")
        XCTAssertEqual(mixed["tile.focus-left"], "⌃⌘←")
    }

    func testTheTilingRowsComeWithTheWindowsRows() {
        let ids = Keymap.all.map(\.id)
        XCTAssertEqual(Keymap.all.filter { $0.id.hasPrefix("tile.") }.map(\.group).first, .windows)
        XCTAssertLessThan(ids.firstIndex(of: "switcher.cancel")!, ids.firstIndex(of: "tile.toggle")!)
        XCTAssertLessThan(ids.firstIndex(of: "tile.toggle")!, ids.firstIndex(of: "terminal.quick")!)
    }

    /// No default key is another of Polycarp's, whichever modifier Settings has.
    func testNoDefaultKeyIsAnotherShortcutOfPolycarps() {
        for setting in ["command", "control", "option", "controlOption"] {
            let symbol = Keymap.modifierSymbol(setting: setting)
            let taken = Set(Keymap.all.filter { $0.scope == .global && !$0.id.hasPrefix("tile.") }.map { $0.display(modifierSymbol: symbol) })
            for k in TilingKeys.all where !k.key.isEmpty { XCTAssertFalse(taken.contains(KeyChord(k.key)!.symbols), "\(k.name) with \(symbol)") }
        }
    }

    /// `surfaces get` shows the keys in force: a default another command was given is none.
    func testGetShowsATakenDefaultAsNone() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("keys-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        try Data(#"{"version": 1, "tiling": {"keys": {"float": "ctrl+opt+B"}}}"#.utf8).write(to: file)
        func get(_ path: String) -> SurfaceValue? {
            guard case .success(let v) = SurfacesOps.get(path, file: file.path) else { return nil }
            return v.at(["value"])
        }
        XCTAssertEqual(get("tiling.keys.float"), .string("ctrl+opt+B"))
        XCTAssertEqual(get("tiling.keys.balance"), .string(""))
        XCTAssertEqual(get("tiling.keys")?.at(["balance"]), .string(""))
        XCTAssertEqual(get("tiling.keys.flip"), .string("ctrl+opt+R"))
    }

    func testTheAppRegistersFromTheList() throws {
        let code = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(code.contains("for key in tilingShortcuts?.keys ?? [] {"))
        XCTAssertTrue(code.contains("hotkeys.register(keyCode: key.chord.keyCode, modifiers: key.chord.carbon)"))
        XCTAssertTrue(code.contains("guard let self, self.stillTrusted() else { return }\n                self.tiling.run(command, pressed: Hotkeys.pressedAt)"))
    }
}

final class KeyPressTests: XCTestCase {
    func testAPressReadsAsTheChordItIs() {
        func press(_ code: Int, ctrl: Bool = false, opt: Bool = false, shift: Bool = false, cmd: Bool = false) -> Result<KeyChord, KeyChord.Problem> {
            KeyChord.read(keyCode: code, ctrl: ctrl, opt: opt, shift: shift, cmd: cmd)
        }
        XCTAssertEqual(press(17, ctrl: true, opt: true), .success(KeyChord("ctrl+opt+T")!))
        XCTAssertEqual(press(17, ctrl: true, cmd: true), .success(KeyChord("ctrl+cmd+T")!))
        XCTAssertEqual(press(123, ctrl: true, shift: true), .success(KeyChord("ctrl+shift+Left")!))
        for (name, code) in KeyChord.keyCodes { XCTAssertEqual(press(code, ctrl: true, opt: true, shift: true), .success(KeyChord("ctrl+opt+shift+\(name)")!), name) }
        guard case .failure(let digit) = press(18, ctrl: true, opt: true) else { return XCTFail("1 is a workspace's") }
        XCTAssertEqual(digit.message, "1 to 9 are the workspaces'")
        guard case .failure = press(17, cmd: true) else { return XCTFail("Command-T is the app's") }
        guard case .failure(let odd) = press(200, ctrl: true, opt: true) else { return XCTFail("no such key") }
        XCTAssertEqual(odd.message, "that key can't be a shortcut")
    }
}

final class TilingKeyWritesTests: XCTestCase {
    /// Settings > Keys moves a key from one command to another; each write must leave a file `surfaces set` accepts.
    func testAKeyMovesToAnotherCommandInWritesTheFileTakes() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("surfaces.json").path
        func keys() -> [String: KeyChord] {
            if case .document(let d) = SurfacesFile.load(path: file) { return d.surfaces.tiling.keys }
            return Surfaces.defaults.tiling.keys
        }
        func give(_ name: String, _ text: String) {
            var now = Surfaces.defaults.tiling
            now.keys = keys()
            for w in now.keyWrites(giving: name, text) {
                guard case .success = SurfacesOps.set(w.path, w.value, file: file) else { return XCTFail("\(w.path) = \(w.value) was refused") }
            }
        }
        give("balance", "ctrl+opt+X")
        XCTAssertEqual(keys()["balance"], KeyChord("ctrl+opt+X"))
        give("flip", "ctrl+opt+X")
        XCTAssertEqual(keys()["flip"], KeyChord("ctrl+opt+X"), "the key moved")
        XCTAssertNil(keys()["balance"], "and the one that had it has none")
        give("balance", "ctrl+opt+T")
        XCTAssertEqual(keys()["balance"], KeyChord("ctrl+opt+T"), "a key Polycarp comes with moves too")
        XCTAssertNil(keys()["toggle"])
        XCTAssertEqual(Surfaces.defaults.tiling.keyWrites(giving: "flip", "ctrl+opt+Y").map(\.path), ["tiling.keys.flip"], "a free key is one write")
        XCTAssertEqual(Surfaces.defaults.tiling.keyWrites(giving: "flip", "").map(\.path), ["tiling.keys.flip"], "and so is none")
    }
}
