import BaneySpacesCore
import Foundation
import XCTest

/// #124 second-S4 (round 1) and second-S1 (round 2): moving one of Donovan's windows onto the agent workspace grants
/// nothing the lend or Full Access didn't. It keeps that scope, and actions on it wait while he uses its app.
final class MovedInScopeTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 5_000_000)
    func word(_ ws: Int, id: UInt32 = 8) -> HandsWindow { HandsWindow(id: id, pid: 100, app: "Word", bundle: "com.microsoft.Word", workspace: ws) }

    func moved(origin: MovedInWindows.Origin) -> MovedInWindows {
        var book = MovedInWindows()
        book.record(window: 8, pid: 100, origin: origin, from: 2, to: 9)
        return book
    }

    func testALentWindowMovedInIsStillLent() {
        var lends = LendBook()
        lends.lend(app: "Word", bundle: "com.microsoft.Word", pid: 100, windows: [8], session: "s", now: now, for: 600)
        XCTAssertEqual(moved(origin: .lent).decide(word(9), base: .onAgentWorkspace, lends: lends, now: now, mode: .standard), .lent)
    }

    func testAFullAccessWindowMovedInIsStillFullAccess() {
        XCTAssertEqual(moved(origin: .fullAccess).decide(word(9), base: .onAgentWorkspace, lends: LendBook(), now: now, mode: .full), .fullAccess)
    }

    func testAnAgentsOwnWindowThereIsUnchanged() {
        XCTAssertEqual(moved(origin: .lent).decide(word(9, id: 77), base: .onAgentWorkspace, lends: LendBook(), now: now, mode: .standard), .onAgentWorkspace)
    }

    /// He is typing in another Word window: a click on the moved one waits, as it did before the move. One of the
    /// agent's own windows there, neither focused nor main, still goes ahead under the other-window rule.
    func testAMovedInWindowWaitsWhileDonovanUsesItsApp() {
        let book = moved(origin: .lent)
        func verdict(_ w: HandsWindow) -> InUseRule.Verdict {
            InUseRule.decide(verb: "click", state: .front, onAgentWorkspace: book.onAgentsOwnWorkspace(w, agentWorkspace: 9),
                             isFocusedWindow: false, isMainWindow: false, delivery: .headlessAX)
        }
        XCTAssertEqual(verdict(word(9)), .wait)
        XCTAssertEqual(verdict(word(9, id: 77)), .otherWindow)
        XCTAssertFalse(book.onAgentsOwnWorkspace(word(2, id: 77), agentWorkspace: 9))
        XCTAssertFalse(book.onAgentsOwnWorkspace(word(9, id: 77), agentWorkspace: nil))
    }
}
