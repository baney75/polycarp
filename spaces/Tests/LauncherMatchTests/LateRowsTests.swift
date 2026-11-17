import XCTest
@testable import LauncherMatch

/// Files stream in under rows found from memory. A row at or above the one you moved to never
/// moves; rows below it may. Lists here are file names; the late rows start at row 3.
final class LateRowsTests: XCTestCase {
    func merge(_ shown: [String], selected: Int?, _ fresh: [String], limit: Int = 5) -> [String] {
        LateRows.merge(shown: shown, at: 3, selected: selected, fresh: fresh, limit: limit, id: { $0 })
    }

    func testWithTheSelectionAboveThemLateRowsTakeTheNewestRanking() {
        XCTAssertEqual(merge(["a", "b"], selected: 0, ["c", "a", "b"]), ["c", "a", "b"])
        XCTAssertEqual(merge(["a", "b"], selected: 2, ["c", "a", "b"]), ["c", "a", "b"])
    }

    func testANeverMovedSelectionHoldsNothing() {
        XCTAssertEqual(merge(["a", "b"], selected: nil, ["c", "a"]), ["c", "a"])
    }

    func testTheSelectedLateRowAndThoseAboveItStayPut() {
        // On "b", the second late row: "a" and "b" keep rows 3 and 4, though "c" now ranks first.
        XCTAssertEqual(merge(["a", "b", "x"], selected: 4, ["c", "b", "d", "a"]), ["a", "b", "c", "d"])
        // A held row the newest ranking dropped still stays: you may be about to pick it.
        XCTAssertEqual(merge(["a", "b"], selected: 3, ["c", "d"]), ["a", "c", "d"])
    }

    func testTheLimitCountsTheHeldRows() {
        XCTAssertEqual(merge(["a", "b"], selected: 4, ["c", "d", "e", "f"], limit: 3), ["a", "b", "c"])
        XCTAssertEqual(merge(["a", "b", "c"], selected: 5, ["d"], limit: 2), ["a", "b", "c"])
    }

    func testWithTheSelectionBelowThemNothingIsAddedOrDropped() {
        // On a web row after the files: adding a file above it would push it down.
        XCTAssertEqual(merge(["a", "b"], selected: 5, ["c", "d", "a"]), ["a", "b"])
        XCTAssertEqual(merge([], selected: 3, ["c"]), [])
    }
}
