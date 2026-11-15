import BaneySpacesCore
import Foundation
import XCTest

/// #124 round 1 first-F1: under Full Access, `windows` decides every child of every app with a usable window, and each
/// decision inspected every placed window of that app (a deep accessibility read on the main thread). An app with five
/// children and four windows cost twenty reads.
final class ChildSweepCostTests: XCTestCase {
    func child(_ id: UInt32, pid: Int32) -> ChildWindowFacts { ChildWindowFacts(id: id, pid: pid, app: "TextEdit") }

    func testEachProcessIsInspectedOnceForAllItsChildren() {
        var reads: [Int32] = []
        let kids = [child(11, pid: 1), child(12, pid: 1), child(21, pid: 2), child(13, pid: 1)]
        let rows = ChildWindowRule.decideEach(kids, placed: { pid in
            reads.append(pid)
            return [(window: HandsWindow(id: UInt32(pid), pid: pid, app: "TextEdit", workspace: 9), scope: .fullAccess)]
        }, decide: { c, placed in
            .usable(scope: placed[0].scope, parent: placed[0].window.id, ownership: "all_windows_usable")
        })
        XCTAssertEqual(reads, [1, 2], "one inspection per process, not per child")
        XCTAssertEqual(rows.map(\.facts.id), [11, 12, 21, 13], "every child decided, in order")
        let parents: [UInt32?] = rows.map { if case .usable(_, let p, _) = $0.decision { return p } else { return nil } }
        XCTAssertEqual(parents, [1, 1, 2, 1],
                       "each child decided with its own process's windows")
    }

    func testTheRouterDecidesThroughIt() throws {
        let ws = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        XCTAssertTrue(ws.contains("ChildWindowRule.decideEach(cs, placed: { pid in"))
        XCTAssertTrue(ws.contains("return (decideChildren(facts, all: all, agent: agent, session: session), readings"), "the `windows` sweep")
        XCTAssertTrue(ws.contains("let usable = decideChildren(new, all: all, agent: agent, session: session).filter(\\.decision.allowed)"), "openedChildren")
        XCTAssertFalse(ws.contains("facts.map { ($0, decideChild($0,"), "no per-child inspection left")
    }
}
