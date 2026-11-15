import BaneySpacesCore
import Foundation
import XCTest

/// #124 round 1 second-S3: a move took a lent or Full Access window off the workspace Donovan was looking at, because
/// `moveRefusal` checked only whether the agent workspace was shown; and a returning window was sent back off the agent
/// workspace while he was looking at it.
final class MoveSourceShownTests: XCTestCase {
    let w = HandsWindow(id: 8, pid: 100, app: "Word", workspace: 2)

    func testAMoveNeverTakesAWindowFromUnderHim() {
        for scope in [ScopeDecision.lent, .fullAccess] {
            let e = WorkspaceVerbs.moveRefusal(window: w, scope: scope, agentWorkspace: 9, agentShown: false, sourceShown: true)
            XCTAssertEqual(e?.code, .inUse, "he is looking at workspace 2")
            XCTAssertEqual(e?.retry, .safe)
            XCTAssertNil(WorkspaceVerbs.moveRefusal(window: w, scope: scope, agentWorkspace: 9, agentShown: false, sourceShown: false))
        }
        var there = w; there.workspace = 9
        XCTAssertNil(WorkspaceVerbs.moveRefusal(window: there, scope: .onAgentWorkspace, agentWorkspace: 9, agentShown: true, sourceShown: true), "a reframe in place moves nothing off")
    }

    func testTheStateAfterTheWaitDecidesOnItsSourceToo() {
        let before = MoveState(agentWorkspace: 9, window: w, scope: .lent, agentShown: false, sourceShown: false)
        let after = MoveState(agentWorkspace: 9, window: w, scope: .lent, agentShown: false, sourceShown: true)
        guard case .failure(let e) = MoveDecision.decide(before: before, after: after) else { return XCTFail("he switched to it during the wait") }
        XCTAssertEqual(e.code, .inUse)
    }

    func testAReturningWindowWaitsWhileHeLooksAtTheWorkspaceItIsOn() {
        let e = MovedInWindows.Entry(window: 8, pid: 100, origin: .lent, from: 2, to: 9, returning: true)
        XCTAssertFalse(MovedInWindows.mayGoBack(e, shown: [9]), "not from under him")
        XCTAssertFalse(MovedInWindows.mayGoBack(e, shown: [1, 9]))
        XCTAssertTrue(MovedInWindows.mayGoBack(e, shown: [2]), "back onto the workspace it came from, in front of him, is his window coming home")
        XCTAssertTrue(MovedInWindows.mayGoBack(e, shown: []))
    }

    func testTheAppReadsBothWorkspacesAndTheSendBackWaits() throws {
        let ws = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        XCTAssertTrue(ws.contains("agentShown: workspaceShown(agent), sourceShown: workspaceShown(w.workspace))"), "before the wait")
        XCTAssertTrue(ws.contains("agentShown: workspaceShown(agent), sourceShown: workspaceShown(live?.workspace))"), "after it, in the gate's pass")
        XCTAssertTrue(ws.contains("agentShown: before.agentShown, sourceShown: before.sourceShown)"))
        let app = try HandsSourceTests.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("guard MovedInWindows.mayGoBack(e, shown: shown) else { continue }"))
        XCTAssertTrue(app.contains("shown = Set(rows.filter(\\.shown).map(\\.number))"))
    }
}
