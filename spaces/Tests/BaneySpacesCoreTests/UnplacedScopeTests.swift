import BaneySpacesCore
import Foundation
import XCTest

/// #124 round 2 second-S2: a window BaneySpaces doesn't place, whose child look missed it (a 0.25 s timeout, a busy app),
/// fell back to `ScopeGuard.check`. A lent window that has left placement (full screen) read as `lent` there, and the gate
/// skips panel checks for unplaced windows, so it was acted on unchecked. A missed look now refuses it.
final class UnplacedScopeTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 2_000_000)

    func testAMissedChildLookRefusesTheWindow() {
        var book = LendBook()
        book.lend(app: "Word", bundle: "com.microsoft.Word", pid: 100, windows: [7], session: "s", now: now, for: 600)
        let unplaced = HandsWindow(id: 7, pid: 100, app: "Word", workspace: nil)
        XCTAssertEqual(ScopeGuard.check(unplaced, agentWorkspace: 9, lends: book, now: now), .lent, "the fallback main used allows it")
        let d = ScopeGuard.unplaced(unplaced, child: nil)
        guard case .denied(let e) = d else { return XCTFail("a missed look must refuse, got \(d)") }
        XCTAssertEqual(e.code, .windowNotFound)
        XCTAssertEqual(e.retry, .afterSnapshot)
    }

    func testAChildDecisionStands() {
        let w = HandsWindow(id: 8, pid: 100, app: "Word", workspace: nil)
        XCTAssertEqual(ScopeGuard.unplaced(w, child: .lent), .lent)
        XCTAssertEqual(ScopeGuard.unplaced(w, child: .onAgentWorkspace), .onAgentWorkspace)
    }

    func testTheRouterDecidesUnplacedWindowsThisWay() throws {
        let src = try String(contentsOf: HandsSourceTests.root.appendingPathComponent("Sources/BaneySpaces/Hands/HandsRouter.swift"), encoding: .utf8)
        let line = try XCTUnwrap(src.components(separatedBy: "\n").first { $0.contains("if w.workspace == nil {") && $0.contains("childDecision(") })
        XCTAssertTrue(line.contains("ScopeGuard.unplaced("), line)
        XCTAssertFalse(line.contains("ScopeGuard.check("), "no fallback to the placed-window rule: \(line)")
    }
}
