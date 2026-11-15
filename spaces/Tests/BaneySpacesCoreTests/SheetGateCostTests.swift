import BaneySpacesCore
import Foundation
import XCTest

/// #124 round 1 first-F2, round 2 first-F2: the gate's sheet check listed and inspected every window of the app (on the main
/// thread) and read all its children before it knew the target window held any sheet, on every gate and retry.
final class SheetGateCostTests: XCTestCase {
    func testOnlyAWindowKnownToHoldNoSheetSkipsTheRead() {
        XCTAssertTrue(ChildWindowRule.noSheetToCheck(sheets: 0))
        XCTAssertFalse(ChildWindowRule.noSheetToCheck(sheets: 1), "a sheet: the full check")
        XCTAssertFalse(ChildWindowRule.noSheetToCheck(sheets: nil), "unsure: the full check, never fail open")
    }

    func testTheCheckStopsFirstAndTheCountFailsClosed() throws {
        let ws = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        let body = try XCTUnwrap(HandsSourceTests.block(after: "func sheetProblem(_ w: HandsWindow, agent: Int?, session: String) -> HandsError? ", in: ws))
        let skip = try XCTUnwrap(body.range(of: "if ChildWindowRule.noSheetToCheck(sheets: BackgroundAX.sheetCount(pid: w.pid, window: w.id)) { return nil }"))
        for later in ["listWindows().windows", "ChildWindowRule.inspected(", "readChildren(pid: w.pid"] {
            let r = try XCTUnwrap(body.range(of: later), later)
            XCTAssertLessThan(skip.lowerBound, r.lowerBound, "\(later) comes after the skip")
        }
        let ax = try HandsSourceTests.code("Sources/BaneySpaces/Hands/BackgroundAX.swift")
        XCTAssertTrue(ax.contains("guard list.unmapped == 0, !list.mapped.contains(where: { HandsAXTree.role($0.element) == \"AXSheet\" }),"),
                      "a sheet listed as a window of its own, or a window with no number, means unsure")
        XCTAssertTrue(ax.contains("guard kids.readable else { return nil }"), "children that didn't answer mean unsure")
    }
}
