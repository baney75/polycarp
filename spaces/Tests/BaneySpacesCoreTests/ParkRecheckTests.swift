@testable import BaneySpacesCore
import XCTest

final class ParkRecheckTests: XCTestCase {
    private let screen = [CGRect(x: 0, y: 0, width: 1512, height: 982)]

    func testAWindowThatCameBackAfterTheUnhideIsSeen() {
        // T3 Code, 2026-11-06: parked at the corner, then back at 0,34 on an empty workspace.
        let home = CGRect(x: 0, y: 34, width: 1512, height: 948)
        XCTAssertTrue(ParkRecheck.cameBack(home, screens: screen, wantedAway: true))
        XCTAssertFalse(ParkRecheck.cameBack(home, screens: screen, wantedAway: false), "you went to its workspace: it should be in sight")
    }

    func testTheCornerMacOSClampsAWindowToStillCountsAsParked() {
        // Moved in plain sight, macOS held T3 Code at 1511,950 rather than 1511,981.
        XCTAssertFalse(ParkRecheck.cameBack(CGRect(x: 1511, y: 950, width: 1512, height: 948), screens: screen, wantedAway: true))
        XCTAssertFalse(ParkRecheck.cameBack(CGRect(x: 1511, y: 981, width: 1512, height: 948), screens: screen, wantedAway: true))
    }

    func testTheRecheckRunsAfterTheUnhideAndAppsThatUndoAMoveAreMovedInSight() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let code = try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/Spaces.swift"), encoding: .utf8)
        let unhide = try XCTUnwrap(code.range(of: "let reshown = hid.subtracting(unparked)"))
        let recheck = try XCTUnwrap(code.range(of: "recheckParked(todo.filter { reshown.contains($0.pid) }"))
        XCTAssertLessThan(unhide.lowerBound, recheck.lowerBound)
        XCTAssertTrue(code.contains("guard !UnhideUndoesMoves.contains(w.pid) else { return false }"), "not hidden first, since the unhide is what undoes it")
    }
}
