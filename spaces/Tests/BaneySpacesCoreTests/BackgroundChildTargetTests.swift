import BaneySpacesCore
import Foundation
import XCTest

/// #124 round 1 sol-F2, round 2 sol-sol-F3: press, click-at and drag on a child dialog the agent may use answered
/// `window_not_found`, because the facts were read only from placed windows, and the scope was decided with no session,
/// so a dialog the session's own action raised would have been refused anyway.
final class BackgroundChildTargetTests: XCTestCase {
    let dialog = HandsWindow(id: 50, pid: 300, app: "TextEdit", workspace: nil)
    let doc = HandsWindow(id: 8, pid: 300, app: "TextEdit", workspace: 9)

    func testAChildDialogIsReadFromItsApp() {
        XCTAssertEqual(BackgroundTarget.live(dialog, placed: nil, child: { self.dialog }), dialog, "sol-F2: not window_not_found")
        XCTAssertNil(BackgroundTarget.live(dialog, placed: nil, child: { nil }), "closed")
        var other = dialog; other.pid = 301
        XCTAssertNil(BackgroundTarget.live(dialog, placed: nil, child: { other }), "the number belongs to another process now")
    }

    func testAPlacedWindowIsNeverLookedUpAsAChild() {
        var asked = false
        XCTAssertEqual(BackgroundTarget.live(doc, placed: doc, child: { asked = true; return nil }), doc)
        XCTAssertNil(BackgroundTarget.live(doc, placed: nil, child: { asked = true; return self.doc }), "a placed window that is gone stays gone")
        XCTAssertFalse(asked)
    }

    func testTheFactsUseTheChildAndTheSession() throws {
        let bg = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Background.swift")
        XCTAssertTrue(bg.contains("guard let live = BackgroundTarget.live(w, placed: placed, child: { childWindow(w.id) }),"))
        XCTAssertTrue(bg.contains("switch decide(live, agent, session: session) {"), "the child's attribution is this session's")
        XCTAssertTrue(bg.contains("gatherFacts(w, kind: kind, verifier: verifier, path: path, session: session)"))
        XCTAssertTrue(bg.contains("escapeKeys(w, verifier: verifier, session: session)"))
        let cr = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+ContextRef.swift")
        XCTAssertTrue(cr.contains("escapeKeys(w, session: session)"))
    }
}
