@testable import BaneySpacesCore
import XCTest

/// The cheat sheet (K3) is made from the live keymap: every binding is on it, under the chord macOS has.
final class CheatSheetTests: XCTestCase {
    /// The rows that stand for `b`: its own row, or the one row a run of workspace keys 1 to 9 folds into.
    func shows(_ b: KeyBinding, _ rows: [CheatSheet.Row]) -> Bool {
        if rows.contains(where: { $0.keys == b.chord.symbol && $0.does == b.action.title }) { return true }
        let does: String
        switch b.action {
        case .switchTo: does = "Go to workspace 1 to 9"
        case .move: does = "Send the window to workspace 1 to 9"
        default: return false
        }
        let mods = b.chord.mods.sorted().map(\.symbol).joined()
        return rows.contains { $0.keys == mods + "1…9" && $0.does == does }
    }

    func testEveryLiveBindingIsOnTheSheet() throws {
        let custom = try XCTUnwrap(Keymap.load("""
        [keys.bindings]
        "ctrl+alt+1" = "switch 3"
        "ctrl+alt+left" = "none"
        "ctrl+alt+h" = "window left-half"
        "cmd+space" = "search"
        """, settingsMod: [.cmd]).keymap)
        for keymap in [Keymap.defaults(mod: [.cmd]), Keymap.defaults(mod: [.ctrl, .alt]), custom] {
            let rows = CheatSheet.sections(keymap, fixed: CheatSheet.fixed(overview: true, cmdTab: "apps", fill: true)).flatMap(\.rows)
            for b in keymap.bindings { XCTAssertTrue(shows(b, rows), "\(b.chord) \(b.action.spelling) is missing from the sheet") }
            XCTAssertTrue(rows.contains { $0.keys.hasPrefix(Chord.recovery.symbol) }, "the recovery chord is on it")
        }
        let rows = CheatSheet.sections(custom, fixed: []).flatMap(\.rows)
        XCTAssertFalse(rows.contains { $0.keys == "⌃⌥←" }, "a key the file took away is gone")
        XCTAssertTrue(rows.contains { $0.keys == "⌃⌥1" && $0.does == "Go to workspace 3" }, "a run the file broke is shown key by key")
        XCTAssertTrue(rows.contains { $0.keys == "⌃⌥H" })
    }

    func testTheDefaultsFoldTheWorkspaceKeysAndGroupTheRest() {
        let s = CheatSheet.sections(.defaults(mod: [.cmd]), fixed: [])
        XCTAssertEqual(s.map(\.title), ["Workspaces", "Windows", "Focus and swap", "Polycarp"])
        XCTAssertEqual(s[0].rows.map(\.keys), ["⌘1…9", "⇧⌘1…9"])
        XCTAssertTrue(s[2].rows.allSatisfy { $0.does.hasPrefix("Focus") || $0.does.hasPrefix("Swap") })
    }

    func testAChordAnotherAppHoldsIsMarked() {
        let sheet = CheatSheet.sections(.defaults(mod: [.cmd]), taken: [Chord([.cmd], "space")], fixed: []).flatMap(\.rows)
        XCTAssertEqual(sheet.first { $0.keys == Chord([.cmd], "space").symbol }?.taken, true)
        XCTAssertEqual(sheet.filter(\.taken).count, 1)
    }
}
