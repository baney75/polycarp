@testable import BaneySpacesCore
import XCTest

/// spec/overview.md, "Checks every platform runs": no overlap, nothing lost, every workspace reachable, at every load.
final class OverviewLayoutTests: XCTestCase {
    private let area = CGRect(x: 48, y: 48, width: 1416, height: 800)

    private func assertSound(_ plan: OverviewLayout.Plan, in area: CGRect? = nil, file: StaticString = #filePath, line: UInt = #line) {
        let area = area ?? self.area
        let all = plan.all
        XCTAssertEqual(Set(all.keys), Set(1...9), "every workspace is reachable", file: file, line: line)
        let rects = Array(all.values)
        for (i, a) in rects.enumerated() {
            XCTAssertTrue(area.insetBy(dx: -0.5, dy: -0.5).contains(a), "\(a) stays on screen", file: file, line: line)
            XCTAssertGreaterThan(a.width, 40, file: file, line: line)
            XCTAssertGreaterThan(a.height, 40, file: file, line: line)
            for b in rects[(i + 1)...] {
                XCTAssertFalse(a.insetBy(dx: 0.5, dy: 0.5).intersects(b), "\(a) overlaps \(b)", file: file, line: line)
            }
        }
    }

    func testDonovansLoadGivesTheBusyWorkspaceTheScreen() {
        // His report: workspace 1 holding seven windows, the rest empty.
        let plan = OverviewLayout.plan(windows: [1: 7], current: 1, in: area)
        assertSound(plan)
        XCTAssertEqual(Set(plan.tiles.keys), [1])
        XCTAssertEqual(Set(plan.slots.keys), Set(2...9), "eight empty workspaces no longer take the screen")
        let tile = plan.tiles[1]!
        XCTAssertEqual(tile.width, area.width, accuracy: 0.5)
        XCTAssertGreaterThan(tile.height, area.height * 0.85)
    }

    func testEmptySlotsAreSmallAndInARow() {
        let plan = OverviewLayout.plan(windows: [1: 2], current: 1, in: area)
        let slots = plan.slots.values
        XCTAssertEqual(Set(slots.map(\.minY)).count, 1)
        for s in slots { XCTAssertEqual(s.width, OverviewLayout.slotSize) }
    }

    func testTheCurrentWorkspaceIsATileEvenWhenEmpty() {
        let plan = OverviewLayout.plan(windows: [2: 3], current: 5, in: area)
        XCTAssertNotNil(plan.tiles[5])
        XCTAssertNotNil(plan.tiles[2])
        assertSound(plan)
    }

    func testOneWindowGetsAtLeastAQuarterOfWhatSevenGets() {
        let plan = OverviewLayout.plan(windows: [1: 7, 2: 1], current: 1, in: area)
        let busy = plan.tiles[1]!, quiet = plan.tiles[2]!
        XCTAssertGreaterThan(busy.width, quiet.width)
        XCTAssertGreaterThanOrEqual(quiet.width * quiet.height, busy.width * busy.height / 4 - 1)
    }

    func testAQuietWorkspaceKeepsItsShareAcrossRows() {
        // Review, round 1: a floor that only held inside a row let tile 1 fall under a quarter of tile 3.
        let loads: [[Int: Int]] = [
            [1: 1, 2: 15, 3: 7, 4: 7],
            [1: 1, 2: 60, 3: 60],
            [1: 1, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 7, 8: 7],
            [1: 1, 2: 60, 3: 60, 4: 60, 5: 60, 6: 60, 7: 60, 8: 60, 9: 60],
        ]
        for load in loads {
            let plan = OverviewLayout.plan(windows: load, current: 1, in: area)
            assertSound(plan)
            let sizes = plan.tiles.values.map { $0.width * $0.height }
            XCTAssertGreaterThanOrEqual(sizes.min()!, sizes.max()! / 4 - 1, "\(load)")
        }
    }

    func testNoSpaceAtAllDrawsNothingRatherThanANegativeSize() {
        var windows: [Int: Int] = [:]
        for n in 1...9 { windows[n] = 2 }
        for tile in OverviewLayout.plan(windows: windows, current: 1, in: .zero).tiles.values {
            XCTAssertGreaterThanOrEqual(tile.width, 0)
            XCTAssertGreaterThanOrEqual(tile.height, 0)
        }
    }

    func testEveryLoadStaysSound() {
        for perWorkspace in [0, 1, 7, 24, 60] {
            for occupied in 0...9 {
                var windows: [Int: Int] = [:]
                for n in 1...9 where n <= occupied { windows[n] = perWorkspace }
                assertSound(OverviewLayout.plan(windows: windows, current: 1, in: area))
            }
        }
    }

    func testCardsFillTheTileAndNothingIsCutOff() {
        let tile = CGSize(width: 1400, height: 700)
        for count in [1, 2, 3, 7, 24, 60] {
            let grid = OverviewLayout.cards(count, in: tile)
            XCTAssertGreaterThanOrEqual(grid.columns * grid.rows, count, "\(count) all have a place")
            let usedWidth = CGFloat(grid.columns) * grid.cardSize.width + CGFloat(grid.columns - 1) * OverviewLayout.cardGap
            let usedHeight = CGFloat(grid.rows) * grid.cardSize.height + CGFloat(grid.rows - 1) * OverviewLayout.cardGap
            XCTAssertLessThanOrEqual(usedWidth, tile.width + 0.5)
            XCTAssertLessThanOrEqual(usedHeight, tile.height + 0.5)
        }
    }

    func testSevenWindowsOnAWideTileIsAGridNotAList() {
        let grid = OverviewLayout.cards(7, in: CGSize(width: 1400, height: 700))
        XCTAssertGreaterThan(grid.columns, 1)
        XCTAssertGreaterThan(grid.cardSize.height, 150, "room for a big icon and a title")
    }

    func testNoWindowsNoCards() {
        XCTAssertEqual(OverviewLayout.cards(0, in: CGSize(width: 100, height: 100)).rows, 0)
    }

    func testASmallScreenStaysSound() {
        let small = CGRect(x: 0, y: 0, width: 1024, height: 640)
        for occupied in 0...9 {
            var windows: [Int: Int] = [:]
            for n in 1...9 where n <= occupied { windows[n] = 3 }
            assertSound(OverviewLayout.plan(windows: windows, current: 1, in: small), in: small)
        }
    }
}
