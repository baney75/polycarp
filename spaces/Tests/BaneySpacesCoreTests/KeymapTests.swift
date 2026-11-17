@testable import BaneySpacesCore
import Foundation
import XCTest

/// `spaces.toml`'s keys (`spec/config.md`, K1): a chord the file binds fires its action, a broken file never takes the keys
/// away, and the recovery chord always brings the defaults back.
final class KeymapTests: XCTestCase {
    let cmd: Set<KeyModifier> = [.cmd]

    func testAReboundChordFiresItsAction() throws {
        let text = """
        # mine
        [keys.bindings]
        "ctrl+alt+1" = "switch 3"
        "mod+shift+2" = "none"
        "cmd+space" = "search"
        """
        let (keymap, problems) = Keymap.load(text, settingsMod: cmd)
        XCTAssertEqual(problems, [])
        let k = try XCTUnwrap(keymap)
        // What the app registers with macOS: key code 18 (the 1 key) with ⌃⌥, and the action it runs.
        let fired = k.bindings.first { $0.chord.keyCode == 18 && $0.chord.carbonModifiers == 0x1000 | 0x800 }
        XCTAssertEqual(fired?.action, .switchTo(3))
        XCTAssertEqual(k.action(for: Chord([.cmd], "3")), .switchTo(3), "the default chord stays")
        XCTAssertNil(k.action(for: Chord([.cmd, .shift], "2")), "none takes a default away")
        XCTAssertEqual(k.action(for: Chord([.cmd], "space")), .search, "a chord the file names does what the file says")
        XCTAssertEqual(k.chords(for: .launcher), [])
    }

    func testModChangesEveryWorkspaceChord() throws {
        let k = try XCTUnwrap(Keymap.load("[keys]\nmod = \"ctrl+alt\"\n", settingsMod: cmd).keymap)
        XCTAssertEqual(k.action(for: Chord([.ctrl, .alt], "4")), .switchTo(4))
        XCTAssertEqual(k.action(for: Chord([.ctrl, .alt, .shift], "4")), .move(4))
        XCTAssertNil(k.action(for: Chord([.cmd], "4")))
    }

    func testABrokenFileGivesNoKeymapAndSaysWhereAndWhy() {
        let cases: [(String, String)] = [
            ("[keys.bindings]\n\"cmd+q\" = \"swtich 1\"\n", "line 2: keys.bindings.\"cmd+q\": \"swtich 1\" is not an action"),
            ("[keys.bindings]\n\"cmd+shift+escape\" = \"switch 1\"\n", "recovery chord"),
            ("[keys.bindings]\n\"ctrl+alt+banana\" = \"switch 1\"\n", "\"banana\" is not a key name"),
            ("[keys.bindings]\n\"j\" = \"switch 1\"\n", "needs cmd, ctrl or alt"),
            ("[keys.bindings]\n\"cmd+1\" = \"none\"\n", "no key goes to workspace 1"),
            ("[keys.bindings]\n\"cmd+1\" = \"switch 2\"\n\"mod+1\" = \"switch 1\"\n", "line 3: keys.bindings.\"mod+1\": ⌘1 is already bound on line 2"),
            ("[keys]\nmod = \"hyper\"\n", "keys.mod"),
            ("[keys\n", "line 1"),
            ("[key.bindings]\n\"cmd+1\" = \"switch 1\"\n", "key: unknown table"),
            ("[keys.bindings]\ncmd+1 = switch 1\n", "line 2"),
        ]
        for (text, want) in cases {
            let (keymap, problems) = Keymap.load(text, settingsMod: cmd)
            XCTAssertNil(keymap, text)
            XCTAssertTrue(problems.map(\.description).joined(separator: " | ").contains(want), "\(text): \(problems)")
        }
    }

    func testABrokenFileFallsBackToTheDefaultsAtLaunchAndToTheLastGoodKeysLive() {
        var s = KeymapState(settingsMod: cmd)
        let notice = s.fileChanged("[keys.bindings]\n\"cmd+q\" = \"swtich 1\"\n", quiet: true)
        XCTAssertEqual(s.keymap, .defaults(mod: cmd))
        XCTAssertEqual(s.source, .defaults)
        XCTAssertEqual(notice, "spaces.toml line 2: keys.bindings.\"cmd+q\": \"swtich 1\" is not an action (see macos_actions in spec/keys.json). default keys stay.")

        XCTAssertEqual(s.fileChanged("[keys.bindings]\n\"ctrl+alt+1\" = \"switch 3\"\n"), "Keys reloaded from spaces.toml")
        let good = s.keymap
        XCTAssertEqual(good.action(for: Chord([.ctrl, .alt], "1")), .switchTo(3))
        XCTAssertTrue(s.fileChanged("[keys\n")?.hasSuffix("your last good keys stay.") ?? false)
        XCTAssertEqual(s.keymap, good)
        XCTAssertEqual(s.problems.count, 1)
    }

    func testTheRecoveryChordRestoresTheDefaultsUntilTheFileIsSavedAgain() {
        var s = KeymapState(settingsMod: cmd)
        s.fileChanged("[keys.bindings]\n\"ctrl+alt+1\" = \"switch 3\"\n\"cmd+space\" = \"none\"\n")
        XCTAssertNotEqual(s.keymap, .defaults(mod: cmd))
        XCTAssertTrue(s.recover().hasPrefix("Default keys restored."))
        XCTAssertEqual(s.keymap, .defaults(mod: cmd))
        XCTAssertEqual(s.source, .recovered)
        s.settingsModChanged([.ctrl])
        XCTAssertEqual(s.keymap, .defaults(mod: [.ctrl]), "recovered keys follow Settings, not the file")
        s.fileChanged("[keys.bindings]\n\"ctrl+alt+1\" = \"switch 3\"\n")
        XCTAssertEqual(s.source, .file)
        XCTAssertEqual(Chord.recovery.symbol, "⇧⌘⎋")
    }

    func testTheDefaultsAreTodaysKeys() {
        let k = Keymap.defaults(mod: cmd)
        XCTAssertEqual(k.action(for: Chord([.cmd], "1")), .switchTo(1))
        XCTAssertEqual(k.action(for: Chord([.cmd, .shift], "9")), .move(9))
        XCTAssertEqual(k.action(for: Chord([.ctrl, .cmd], "k")), .search)
        XCTAssertEqual(k.action(for: Chord([.ctrl, .cmd], "u")), .agentFinished)
        XCTAssertEqual(Set(k.bindings.map(\.chord)).count, k.bindings.count, "no chord twice")
        XCTAssertNil(k.action(for: .recovery))
    }

    func testEveryActionSpellingReadsBack() {
        for a in Keymap.defaults(mod: cmd).bindings.map(\.action) + [.overview, KeyAction.none] {
            XCTAssertEqual(KeyAction.parse(a.spelling), a)
        }
    }

    /// The spec names the keys and actions every platform reads; the Mac knows each one.
    func testTheSpecsKeyNamesAndActionsAreTheMacs() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("spec/keys.json"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let names = try XCTUnwrap(json["key_names"] as? [String])
        XCTAssertEqual(Set(names), Set(KeyNames.code.keys))
        let spellings = try XCTUnwrap((json["macos_actions"] as? [String: Any])?.keys)
        let placements = try XCTUnwrap(json["window_placements"] as? [String])
        XCTAssertEqual(placements, Placement.allCases.map(\.rawValue))
        var named = Set<String>()
        for s in spellings {
            let each = s.contains("{placement}") ? placements.map { s.replacingOccurrences(of: "{placement}", with: $0) }
                : s.contains("{direction}") ? Direction.allCases.map { s.replacingOccurrences(of: "{direction}", with: $0.rawValue) }
                : [s.replacingOccurrences(of: "{n}", with: "1")]
            for e in each { XCTAssertNotNil(KeyAction.parse(e), e); named.insert(e) }
        }
        for a in WindowAction.all { XCTAssertTrue(named.contains(a.spelling), "\(a.spelling) is not in spec/keys.json") }
        let recovery = try XCTUnwrap((json["platforms"] as? [String: Any]).flatMap { $0["macos"] as? [String: Any] }?["recovery"] as? String)
        XCTAssertEqual(try Chord.parse(recovery, mod: cmd), .recovery)
    }
}
