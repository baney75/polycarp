import XCTest
@testable import BaneySpacesCore

/// The case table in spec/bar.md "Moving modules" (R-BA1 to R-BA6).
final class BarArrangeTests: XCTestCase {
    private func bar(_ left: [String], _ center: [String], _ right: [String]) -> Surfaces.Bar {
        var b = Surfaces.defaults.bar
        b.left = left.compactMap(Surfaces.BarModule.init(id:))
        b.center = center.compactMap(Surfaces.BarModule.init(id:))
        b.right = right.compactMap(Surfaces.BarModule.init(id:))
        return b
    }

    private func ids(_ b: Surfaces.Bar) -> [[String]] { [b.left.map(\.id), b.center.map(\.id), b.right.map(\.id)] }

    private var start: Surfaces.Bar { bar(["mark", "workspaces"], ["clock"], ["status", "|", "notifications"]) }

    /// Every module once, splits counted: a move never drops or doubles one (R-BA4).
    private func union(_ b: Surfaces.Bar) -> [String] { (b.left + b.center + b.right).map(\.id).sorted() }

    func testTheClockMovesToTheStartOfTheRightLeavingTheCenterEmpty() {
        let out = BarArrange.move(start, from: BarSlot(.center, 0), to: BarSlot(.right, 0))
        XCTAssertEqual(ids(out), [["mark", "workspaces"], [], ["clock", "status", "|", "notifications"]])
        XCTAssertEqual(union(out), union(start))
    }

    func testWorkspacesMoveBeforeTheMarkInTheirOwnRow() {
        let out = BarArrange.move(start, from: BarSlot(.left, 1), to: BarSlot(.left, 0))
        XCTAssertEqual(ids(out), [["workspaces", "mark"], ["clock"], ["status", "|", "notifications"]])
    }

    func testAModuleDroppedOnItsOwnPlaceChangesNothing() {
        XCTAssertEqual(BarArrange.move(start, from: BarSlot(.center, 0), to: BarSlot(.center, 0)), start)
        // The gap just after it is its own place too.
        XCTAssertEqual(BarArrange.move(start, from: BarSlot(.center, 0), to: BarSlot(.center, 1)), start)
        XCTAssertEqual(BarArrange.move(start, from: BarSlot(.left, 0), to: BarSlot(.left, 1)), start)
    }

    func testTheSplitMovesLikeAnyModule() {
        let out = BarArrange.move(start, from: BarSlot(.right, 1), to: BarSlot(.left, 2))
        XCTAssertEqual(ids(out), [["mark", "workspaces", "|"], ["clock"], ["status", "notifications"]])
        XCTAssertEqual(union(out), union(start))
    }

    func testAModuleMovesIntoAnEmptyCenter() {
        let b = bar(["mark"], [], ["status"])
        XCTAssertEqual(ids(BarArrange.move(b, from: BarSlot(.right, 0), to: BarSlot(.center, 0))), [["mark"], ["status"], []])
    }

    func testAPlaceOutOfRangeChangesNothing() {
        XCTAssertEqual(BarArrange.move(start, from: BarSlot(.center, 1), to: BarSlot(.left, 0)), start)
        XCTAssertEqual(BarArrange.move(start, from: BarSlot(.left, -1), to: BarSlot(.right, 0)), start)
        XCTAssertEqual(BarArrange.move(start, from: BarSlot(.left, 0), to: BarSlot(.right, 4)), start)
        XCTAssertEqual(BarArrange.move(start, from: BarSlot(.left, 0), to: BarSlot(.right, -1)), start)
    }

    func testAMoveLaterInTheSameRowLandsInTheGapAsItWasSeen() {
        // Before the bell (gap 2 in status,|,notifications) means after the split once status is out.
        let out = BarArrange.move(start, from: BarSlot(.right, 0), to: BarSlot(.right, 2))
        XCTAssertEqual(ids(out)[2], ["|", "status", "notifications"])
        XCTAssertEqual(ids(BarArrange.move(start, from: BarSlot(.right, 0), to: BarSlot(.right, 3)))[2], ["|", "notifications", "status"])
    }

    func testCustomModulesKeepTheirPlaceBesideTheirNeighbours() {
        let b = bar(["mark", "custom:weather", "workspaces"], ["clock"], ["status"])
        let out = BarArrange.move(b, from: BarSlot(.left, 0), to: BarSlot(.right, 1))
        XCTAssertEqual(ids(out), [["custom:weather", "workspaces"], ["clock"], ["status", "mark"]])
    }

    // MARK: slots

    /// A flat bar 1000 wide: left 0...300 (mark 10-37, workspaces 40-100), center 300...700 (an empty placeholder),
    /// right 700...1000 (status 800-900, the split draws nothing, notifications 950-980).
    private let flat: [BarRowGeometry] = [
        BarRowGeometry(row: .left, minX: 0, maxX: 300, items: [.init(index: 0, minX: 10, maxX: 37), .init(index: 1, minX: 40, maxX: 100)], count: 2),
        BarRowGeometry(row: .center, minX: 300, maxX: 700, items: [], count: 0),
        BarRowGeometry(row: .right, minX: 700, maxX: 1000, items: [.init(index: 0, minX: 800, maxX: 900), .init(index: 2, minX: 950, maxX: 980)], count: 3),
    ]

    func testPastTheLastModuleOfTheRightIsTheRightsEnd() {
        XCTAssertEqual(BarArrange.slot(at: 990, rows: flat), BarSlot(.right, 3))
    }

    func testAnEmptyCenterTakesADropAnywhereInItsPlaceholder() {
        XCTAssertEqual(BarArrange.slot(at: 500, rows: flat), BarSlot(.center, 0))
    }

    func testADropGoesBeforeTheFirstModuleWhoseMiddleIsPastIt() {
        XCTAssertEqual(BarArrange.slot(at: 5, rows: flat), BarSlot(.left, 0))
        XCTAssertEqual(BarArrange.slot(at: 30, rows: flat), BarSlot(.left, 1))
        XCTAssertEqual(BarArrange.slot(at: 200, rows: flat), BarSlot(.left, 2))
        // Between status and the bell: before the bell's list index, so after the split that draws nothing.
        XCTAssertEqual(BarArrange.slot(at: 920, rows: flat), BarSlot(.right, 2))
    }

    func testTheNotchTakesNoDrop() {
        // A notched bar 1512 wide: the left beside the camera to 660, the center and right from 850.
        let notch = [
            BarRowGeometry(row: .left, minX: 0, maxX: 660, items: [.init(index: 0, minX: 10, maxX: 37)], count: 1),
            BarRowGeometry(row: .center, minX: 850, maxX: 1000, items: [.init(index: 0, minX: 860, maxX: 990)], count: 1),
            BarRowGeometry(row: .right, minX: 1000, maxX: 1512, items: [], count: 0),
        ]
        XCTAssertNil(BarArrange.slot(at: 700, rows: notch))
        XCTAssertNil(BarArrange.slot(at: 849.5, rows: notch))
        XCTAssertEqual(BarArrange.slot(at: 851, rows: notch), BarSlot(.center, 0))
        XCTAssertEqual(BarArrange.slot(at: 1200, rows: notch), BarSlot(.right, 0))
    }

    // MARK: VoiceOver steps

    func testStepsLeftAndRightPassModulesThatDrawNothingAndCrossRows() {
        let b = bar(["mark", "battery", "workspaces"], ["clock"], ["status"])
        let shown: (Surfaces.BarModule) -> Bool = { $0 != .battery }
        XCTAssertEqual(BarArrange.slot(for: .left, from: BarSlot(.left, 2), in: b, shown: shown), BarSlot(.left, 0))
        XCTAssertEqual(BarArrange.slot(for: .right, from: BarSlot(.left, 0), in: b, shown: shown), BarSlot(.left, 3))
        XCTAssertEqual(BarArrange.slot(for: .right, from: BarSlot(.left, 2), in: b, shown: shown), BarSlot(.center, 0))
        XCTAssertEqual(BarArrange.slot(for: .left, from: BarSlot(.center, 0), in: b), BarSlot(.left, 3))
        XCTAssertNil(BarArrange.slot(for: .left, from: BarSlot(.left, 0), in: b))
        XCTAssertNil(BarArrange.slot(for: .right, from: BarSlot(.right, 0), in: b))
        // The step's slot, moved, is the move the name says.
        let moved = BarArrange.move(b, from: BarSlot(.left, 0), to: BarArrange.slot(for: .right, from: BarSlot(.left, 0), in: b, shown: shown)!)
        XCTAssertEqual(ids(moved)[0], ["battery", "workspaces", "mark"])
    }

    func testASectionMoveGoesToTheEndNearestWhereItWas() {
        XCTAssertEqual(BarArrange.slot(for: .toRight, from: BarSlot(.left, 0), in: start), BarSlot(.right, 0))
        XCTAssertEqual(BarArrange.slot(for: .toLeft, from: BarSlot(.right, 0), in: start), BarSlot(.left, 2))
        XCTAssertEqual(BarArrange.slot(for: .toCenter, from: BarSlot(.left, 1), in: start), BarSlot(.center, 0))
        XCTAssertEqual(BarArrange.slot(for: .toCenter, from: BarSlot(.right, 2), in: start), BarSlot(.center, 1))
        XCTAssertNil(BarArrange.slot(for: .toCenter, from: BarSlot(.center, 0), in: start))
        XCTAssertNil(BarArrange.slot(for: .toLeft, from: BarSlot(.left, 5), in: start))
    }

    // MARK: the write

    private func tempFile(_ text: String?) throws -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bar-arrange-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("surfaces.json").path
        if let text { try text.write(toFile: path, atomically: true, encoding: .utf8) }
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return path
    }

    private func loaded(_ path: String) -> Surfaces? {
        if case .document(let d) = SurfacesFile.load(path: path) { return d.surfaces }
        return nil
    }

    func testAMoveIsWrittenInOneWriteAndReadsBackAsMoved() throws {
        let path = try tempFile(#"{"version":1,"bar":{"enabled":true,"height":30,"modules":{"left":["mark","custom:weather","workspaces"]}}}"#)
        guard let before = loaded(path)?.bar else { return XCTFail("the file didn't read") }
        let moved = BarArrange.move(before, from: BarSlot(.left, 0), to: BarSlot(.right, 0))
        XCTAssertNil(BarArrange.write(moved, file: path))
        let after = try XCTUnwrap(loaded(path)?.bar)
        XCTAssertEqual(after.left.map(\.id), ["custom:weather", "workspaces"])
        XCTAssertEqual(after.right.first, .mark)
        XCTAssertEqual(after.center, before.center)
        // The rest of the bar's settings stay as they were.
        XCTAssertEqual(after.height, 30)
        XCTAssertTrue(after.enabled)
    }

    func testAMoveOnAFileWithNoneWritesTheDefaultsMoved() throws {
        let path = try tempFile(nil)
        let moved = BarArrange.move(Surfaces.defaults.bar, from: BarSlot(.center, 0), to: BarSlot(.left, 0))
        XCTAssertNil(BarArrange.write(moved, file: path))
        XCTAssertEqual(loaded(path)?.bar.left.first, .clock)
        XCTAssertEqual(loaded(path)?.bar.center, [])
    }

    func testABrokenFileIsNotWrittenOver() throws {
        let text = #"{"version":1,"bar":{"height":"tall"}}"#
        let path = try tempFile(text)
        XCTAssertNotNil(BarArrange.write(Surfaces.defaults.bar, file: path))
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), text)
    }
}
