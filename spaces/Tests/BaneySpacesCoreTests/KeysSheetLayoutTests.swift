import BaneySpacesCore
import XCTest

final class KeysSheetLayoutTests: XCTestCase {
    private func row(_ id: String, _ keys: [String], _ group: KeyBinding.Group) -> KeyBinding {
        KeyBinding(id: id, keys: keys, title: id, group: group, scope: .global)
    }

    private func ids(_ columns: [[KeysSheetLayout.Piece]]) -> [String] { columns.flatMap { $0.flatMap { $0.rows.map(\.id) } } }

    /// The keymap with tiling on: 74 rows, 30 of them in Windows, which was taller than a screen in one column.
    private var tilingOn: [KeyBinding] {
        var s = Surfaces.defaults
        s.tiling.enabled = true
        return Keymap.rows(s)
    }

    func testEveryRowLandsOnceInKeymapOrder() {
        for count in 1...5 {
            let columns = KeysSheetLayout.pieces(tilingOn, count: count)
            let order = KeyBinding.Group.allCases.flatMap { g in tilingOn.filter { $0.group == g }.map(\.id) }
            XCTAssertEqual(ids(columns), order, "count \(count)")
            XCTAssertLessThanOrEqual(columns.count, count)
        }
    }

    func testALongGroupGoesOnInTheNextColumnUnderItsHeading() {
        let columns = KeysSheetLayout.pieces(tilingOn, count: 3)
        let windows = columns.flatMap { $0 }.filter { $0.group == .windows }
        XCTAssertGreaterThan(windows.count, 1, "30 rows don't fit in a third of the sheet")
        XCTAssertEqual(windows.map(\.continued), [false] + Array(repeating: true, count: windows.count - 1))
        XCTAssertFalse(windows.contains { $0.rows.isEmpty }, "no heading alone")
    }

    /// No column is more than a tenth taller than an even share, and with five columns the tallest is well under the
    /// Windows group alone, which before set the sheet's height whatever the column count.
    func testColumnsComeOutAboutTheSameHeight() {
        func height(_ c: [KeysSheetLayout.Piece]) -> Double {
            c.reduce(0) { $0 + KeysSheetLayout.headingWeight + $1.rows.reduce(0) { $0 + KeysSheetLayout.weight($1) } }
        }
        for count in 3...5 {
            let columns = KeysSheetLayout.pieces(tilingOn, count: count)
            let total = columns.reduce(0) { $0 + height($1) }
            XCTAssertEqual(columns.count, count)
            for c in columns { XCTAssertLessThanOrEqual(height(c), total / Double(count) * 1.1, "count \(count)") }
        }
        let windows = height([KeysSheetLayout.Piece(group: .windows, rows: tilingOn.filter { $0.group == .windows }, continued: false)])
        let tallest = KeysSheetLayout.pieces(tilingOn, count: 5).map(height).max() ?? 0
        XCTAssertLessThan(tallest, windows * 0.75)
    }

    /// A title too long for what the caps leave of the column wraps, so it counts as more lines: the columns it lands in
    /// would otherwise come out taller than the rest and set the sheet's height.
    func testAWrappedTitleWeighsMore() {
        let short = KeyBinding(id: "s", keys: ["mod", "M"], title: "Fill", group: .windows, scope: .global)
        let long = KeyBinding(id: "l", keys: ["mod", "shift", "cmd", "arrows"],
                              title: "Move the window into the tile that way, or out of its group", group: .windows, scope: .global)
        XCTAssertEqual(KeysSheetLayout.weight(short), 1)
        XCTAssertGreaterThanOrEqual(KeysSheetLayout.weight(long), 3)
        let tiling = KeyBinding(id: "t", keys: ["mod", "M"], title: "Fill", group: .windows, scope: .launcher)
        XCTAssertEqual(KeysSheetLayout.weight(tiling), 1.6, accuracy: 0.001, "one short line under it")
    }

    func testAGroupThatFitsAColumnIsNeverSplit() {
        let rows = (0..<8).map { row("l\($0)", ["K"], .launcher) }
            + (0..<2).map { row("w\($0)", ["K"], .workspaces) }
            + (0..<2).map { row("t\($0)", ["K"], .terminal) }
            + (0..<3).map { row("a\($0)", ["K"], .agents) }
        let columns = KeysSheetLayout.pieces(rows, count: 2)
        XCTAssertEqual(columns.map { $0.map(\.group) }, [[.launcher], [.workspaces, .terminal, .agents]])
        XCTAssertFalse(columns.flatMap { $0 }.contains { $0.continued })
    }

    func testOneColumnHoldsEverything() {
        let columns = KeysSheetLayout.pieces(tilingOn, count: 1)
        XCTAssertEqual(columns.count, 1)
        XCTAssertFalse(columns[0].contains { $0.continued })
    }

    func testTheCountThatShrinksTheSheetLeastWinsAndTiesGoToFewerColumns() {
        let area = CGSize(width: 1512, height: 900)
        func best(_ sizes: [(Int, CGFloat, CGFloat)]) -> Int {
            KeysSheetLayout.bestCount(sizes.map { (count: $0.0, size: CGSize(width: $0.1, height: $0.2)) }, in: area)
        }
        // Three columns too tall, four fit: four.
        XCTAssertEqual(best([(3, 856, 1300), (4, 1136, 868), (5, 1416, 700)]), 4)
        // Every count fits: the fewest.
        XCTAssertEqual(best([(3, 856, 600), (4, 1136, 500), (5, 1416, 420)]), 3)
        // None fits: the one shrunk least.
        XCTAssertEqual(best([(3, 856, 2000), (4, 1136, 1600), (5, 1416, 1300)]), 5)
        // Five is too wide for this screen, so four wins.
        XCTAssertEqual(best([(3, 856, 1300), (4, 1136, 1000), (5, 1800, 840)]), 4)
        XCTAssertEqual(best([]), 3)
    }

    func testCapsSplitModifiersAndKeepKeyNames() {
        XCTAssertEqual(KeysSheetLayout.caps(row("a", ["ctrl", "cmd", "K"], .launcher), modifier: "⌘"), ["⌃", "⌘", "K"])
        XCTAssertEqual(KeysSheetLayout.caps(row("b", ["mod", "shift", "1...9"], .workspaces), modifier: "⌃⌥"),
                       ["⌃", "⌥", "⇧", "1...9"])
        XCTAssertEqual(KeysSheetLayout.caps(row("c", ["hold mod"], .launcher), modifier: "⌥"), ["hold", "⌥"])
        XCTAssertEqual(KeysSheetLayout.caps(row("d", ["Return"], .launcher), modifier: "⌘"), ["Return"])
    }

    /// The sheet is about 856 points wide: on a display narrower or shorter than that it shrinks to fit with a margin,
    /// and it never grows.
    func testTheSheetShrinksToFitASmallDisplay() {
        XCTAssertEqual(KeysSheetLayout.fitScale(CGSize(width: 856, height: 600), in: CGSize(width: 800, height: 900), margin: 16),
                       (800 - 32) / 856, accuracy: 0.0001)
        XCTAssertEqual(KeysSheetLayout.fitScale(CGSize(width: 856, height: 800), in: CGSize(width: 1440, height: 700), margin: 16),
                       (700 - 32) / 800, accuracy: 0.0001)
        XCTAssertEqual(KeysSheetLayout.fitScale(CGSize(width: 856, height: 600), in: CGSize(width: 1440, height: 900)), 1)
        XCTAssertGreaterThan(KeysSheetLayout.fitScale(CGSize(width: 856, height: 600), in: CGSize(width: 10, height: 10)), 0)
    }
}
