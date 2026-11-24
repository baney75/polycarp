import BaneySpacesCore
import XCTest

final class KeysSheetLayoutTests: XCTestCase {
    private func row(_ id: String, _ keys: [String], _ group: KeyBinding.Group) -> KeyBinding {
        KeyBinding(id: id, keys: keys, title: id, group: group, scope: .global)
    }

    func testEveryGroupWithRowsLandsInExactlyOneColumn() {
        let columns = KeysSheetLayout.columns(Keymap.all, count: 3)
        let placed = columns.flatMap { $0 }
        let used = KeyBinding.Group.allCases.filter { g in Keymap.all.contains { $0.group == g } }
        XCTAssertEqual(Set(placed), Set(used))
        XCTAssertEqual(placed.count, used.count, "no group twice")
        XCTAssertLessThanOrEqual(columns.count, 3)
    }

    func testColumnsBalanceByRows() {
        let rows = (0..<8).map { row("l\($0)", ["K"], .launcher) }
            + (0..<2).map { row("w\($0)", ["K"], .workspaces) }
            + (0..<2).map { row("t\($0)", ["K"], .terminal) }
            + (0..<3).map { row("a\($0)", ["K"], .agents) }
        let columns = KeysSheetLayout.columns(rows, count: 2)
        XCTAssertEqual(columns, [[.launcher], [.workspaces, .terminal, .agents]])
    }

    func testCapsSplitModifiersAndKeepKeyNames() {
        XCTAssertEqual(KeysSheetLayout.caps(row("a", ["ctrl", "cmd", "K"], .launcher), modifier: "⌘"), ["⌃", "⌘", "K"])
        XCTAssertEqual(KeysSheetLayout.caps(row("b", ["mod", "shift", "1...9"], .workspaces), modifier: "⌃⌥"),
                       ["⌃", "⌥", "⇧", "1...9"])
        XCTAssertEqual(KeysSheetLayout.caps(row("c", ["hold mod"], .launcher), modifier: "⌥"), ["hold", "⌥"])
        XCTAssertEqual(KeysSheetLayout.caps(row("d", ["Return"], .launcher), modifier: "⌘"), ["Return"])
    }
}
