import BaneySpacesCore
import CoreGraphics
import Foundation
import XCTest

/// Review round 1 of #106: a window an agent moves onto the agent workspace keeps the scope that let it move (first-F1).
final class MovedInWindowTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 5_000_000)
    func word(_ ws: Int, id: UInt32 = 8, pid: Int32 = 100) -> HandsWindow { HandsWindow(id: id, pid: pid, app: "Word", bundle: "com.microsoft.Word", workspace: ws) }

    /// What `move` does: the scope before the move gives the origin, recorded with the workspace it came from.
    func moved(_ w: HandsWindow, scope: ScopeDecision, agentOwned: Bool = false) -> MovedInWindows {
        var book = MovedInWindows()
        book.record(window: w.id, pid: w.pid, origin: MovedInWindows.origin(scope: scope, agentOwned: agentOwned), from: w.workspace!, to: 9)
        return book
    }

    func testALentWindowMovedInIsDeniedOnceTheLendExpiresAndGoesBack() {
        var lends = LendBook()
        lends.lend(app: "Word", bundle: "com.microsoft.Word", pid: 100, windows: [8], session: "s", now: now, for: 600)
        let scope = ScopeGuard.check(word(2), agentWorkspace: 9, lends: lends, now: now)
        XCTAssertEqual(scope, .lent)
        var book = moved(word(2), scope: scope)
        let there = word(9)
        let base = ScopeGuard.check(there, agentWorkspace: 9, lends: lends, now: now)
        XCTAssertEqual(base, .onAgentWorkspace)
        XCTAssertEqual(book.decide(there, base: base, lends: lends, now: now, mode: .standard), .onAgentWorkspace, "usable while lent")
        let later = now.addingTimeInterval(601)
        guard case .denied(let e) = book.decide(there, base: ScopeGuard.check(there, agentWorkspace: 9, lends: lends, now: later), lends: lends, now: later, mode: .standard) else {
            return XCTFail("the agent workspace must grant nothing once the lend ended")
        }
        XCTAssertEqual(e.retry, .never)
        XCTAssertTrue(e.message.contains("lend has ended"))
        XCTAssertTrue(book.settle(lends: lends, now: now, mode: .standard).isEmpty, "nothing goes back while the lend holds")
        let ended = book.settle(lends: lends, now: later, mode: .standard)
        XCTAssertEqual(ended.map(\.window), [8])
        XCTAssertEqual(MovedInWindows.destination(ended[0], workspaces: Set(1...9), current: 4, agentWorkspace: 9), 2, "back where it came from")
        XCTAssertEqual(MovedInWindows.destination(ended[0], workspaces: [1, 4, 9], current: 4, agentWorkspace: 9), 4, "that workspace is gone: his current one")
        XCTAssertEqual(MovedInWindows.destination(ended[0], workspaces: Set(1...9), current: 4, agentWorkspace: 2), 4, "never onto the agent workspace")
        XCTAssertEqual(book.entries.count, 1, "kept, denied, until it is read back off the agent workspace")
        XCTAssertFalse(book.decide(there, base: .onAgentWorkspace, lends: lends, now: now, mode: .standard).allowed, "denied while it goes back, even if lent again")
        XCTAssertEqual(book.settle(lends: lends, now: later, mode: .standard).map(\.window), [8], "tried again until read back")
        book.returned(window: 8)
        XCTAssertTrue(book.entries.isEmpty)
    }

    func testTakenBackIsTheSameAsExpired() {
        var lends = LendBook()
        lends.lend(app: "Word", bundle: "com.microsoft.Word", pid: 100, windows: [8], session: "s", now: now, for: 600)
        let book = moved(word(2), scope: .lent)
        lends.giveBack("Word")
        XCTAssertFalse(book.decide(word(9), base: .onAgentWorkspace, lends: lends, now: now, mode: .standard).allowed)
        XCTAssertFalse(book.decide(word(9), base: .onAgentWorkspace, lends: lends, now: now, mode: .full).allowed, "a lent origin ends with the lend, Full Access or not")
    }

    func testAFullAccessMoveIsDeniedOnceNarrowed() {
        let scope = ScopeGuard.check(word(2), agentWorkspace: 9, lends: LendBook(), now: now, mode: .full)
        XCTAssertEqual(scope, .fullAccess)
        var book = moved(word(2), scope: scope)
        XCTAssertEqual(book.entries[8]?.origin, .fullAccess)
        XCTAssertEqual(book.decide(word(9), base: .onAgentWorkspace, lends: LendBook(), now: now, mode: .full), .onAgentWorkspace)
        for mode in [AgentAccessMode.standard, .readOnly] {
            XCTAssertFalse(book.decide(word(9), base: .onAgentWorkspace, lends: LendBook(), now: now, mode: mode).allowed, "narrowed to \(mode)")
        }
        var lends = LendBook()
        lends.lend(app: "Word", bundle: "com.microsoft.Word", pid: 100, windows: [8], session: "s", now: now, for: 600)
        XCTAssertTrue(book.decide(word(9), base: .onAgentWorkspace, lends: lends, now: now, mode: .standard).allowed, "lent later, it counts as lent")
        XCTAssertEqual(book.settle(lends: LendBook(), now: now, mode: .standard).map(\.from), [2])
    }

    func testWindowsTheAgentsOwnProcessOrDonovanPutThereAreUnaffected() {
        XCTAssertNil(MovedInWindows.origin(scope: .lent, agentOwned: true))
        XCTAssertNil(MovedInWindows.origin(scope: .fullAccess, agentOwned: true))
        XCTAssertNil(MovedInWindows.origin(scope: .onAgentWorkspace, agentOwned: false), "already there: nothing moved")
        let own = moved(word(2), scope: .fullAccess, agentOwned: true)
        XCTAssertTrue(own.entries.isEmpty)
        XCTAssertEqual(own.decide(word(9), base: .onAgentWorkspace, lends: LendBook(), now: now, mode: .standard), .onAgentWorkspace)
        let book = moved(word(2), scope: .lent)
        XCTAssertEqual(book.decide(word(9, id: 9), base: .onAgentWorkspace, lends: LendBook(), now: now, mode: .standard), .onAgentWorkspace, "another window")
        XCTAssertEqual(book.decide(word(9, pid: 101), base: .onAgentWorkspace, lends: LendBook(), now: now, mode: .standard), .onAgentWorkspace, "the same id in another process")
        let his = HandsError(.outsideAgentWorkspace, "x", suggestion: "y")
        XCTAssertEqual(book.decide(word(2), base: .denied(his), lends: LendBook(), now: now, mode: .standard), .denied(his), "off the agent workspace it changes nothing")
    }
}

/// first-F2: a sheet whose window is known and not usable is Donovan's, attributed or not.
final class ChildParentOwnershipTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 2_000_000)

    func testASheetOnHisWindowOfASplitAppIsRefusedEvenWhenAttributed() {
        let ws = [HandsWindow(id: 7, pid: 100, app: "Word", workspace: 9), HandsWindow(id: 8, pid: 100, app: "Word", workspace: 2)]
        let placed = ws.map { (window: $0, scope: ScopeGuard.check($0, agentWorkspace: 9, lends: LendBook(), now: now)) }
        let sheet = ChildWindowFacts(id: 60, pid: 100, app: "Word", title: "Save changes?", role: "AXSheet", parent: 8)
        guard case .refused(let rule, let e) = ChildWindowRule.decide(sheet, placed: placed, attributed: true) else { return XCTFail("his sheet must be refused") }
        XCTAssertEqual(rule, .ownership)
        XCTAssertEqual(e.retry, .never)
        var mine = sheet; mine.parent = 7
        XCTAssertEqual(ChildWindowRule.decide(mine, placed: placed, attributed: true).scope, .onAgentWorkspace, "a sheet on the agent's window, after its action")
        XCTAssertFalse(ChildWindowRule.decide(mine, placed: placed, attributed: false).allowed, "rule 2 still needs its action on a split app")
        var unknown = sheet; unknown.parent = nil
        XCTAssertFalse(ChildWindowRule.decide(unknown, placed: placed, attributed: true).allowed, "parent unknown on a split app: refused (round 2)")
        XCTAssertFalse(ChildWindowRule.decide(unknown, placed: placed, attributed: false).allowed)
    }
}

/// sol-F1: the bounded read marks any cut-off sheet or dialog unreadable, so it is refused.
final class AXTreeReadTests: XCTestCase {
    final class El {
        var a: [String: String]; var kids: [El]; var readable: Bool
        init(_ role: String, _ a: [String: String] = [:], kids: [El] = [], readable: Bool = true) {
            self.a = a.merging(["AXRole": role]) { x, _ in x }; self.kids = kids; self.readable = readable
        }
    }
    func read(_ e: El, depth: Int = 1) -> AXNodeInfo {
        AXTreeRead.node(e, depth: depth, string: { $0.a[$1] }, children: { ($0.readable ? $0.kids : [], $0.readable) })
    }
    func buttons(_ n: Int) -> [El] { (0..<n).map { El("AXButton", ["AXTitle": "B\($0)"]) } }

    func testASheetWithFortyOneChildrenAndThePanelPastFortyIsRefused() {
        let sheet = El("AXSheet", kids: buttons(40) + [El("AXBrowser")])
        let n = read(sheet)
        XCTAssertFalse(n.readable)
        XCTAssertTrue(PanelDetector.windowIsOffLimits(n), "a sheet the read did not see whole is refused")
        let window = El("AXWindow", ["AXSubrole": "AXStandardWindow"], kids: [El("AXScrollArea"), sheet])
        XCTAssertTrue(PanelDetector.windowIsOffLimits(read(window)), "and the window that holds it")
    }

    func testASheetSeenWholeIsJudgedOnWhatItHolds() {
        let plain = El("AXSheet", kids: buttons(40))
        XCTAssertTrue(read(plain).readable)
        XCTAssertFalse(PanelDetector.windowIsOffLimits(read(plain)), "forty buttons, nothing cut off")
        let saveChanges = El("AXSheet", kids: [El("AXStaticText", ["AXValue": "Do you want to keep this new document?"]), El("AXButton", ["AXTitle": "Delete"])])
        XCTAssertFalse(PanelDetector.windowIsOffLimits(read(El("AXWindow", ["AXSubrole": "AXStandardWindow"], kids: [saveChanges]))))
    }

    func testDepthCutOffIsUnreadable() {
        var deepest = El("AXGroup", kids: [El("AXBrowser")])
        for _ in 0..<5 { deepest = El("AXGroup", kids: [deepest]) }
        let sheet = El("AXSheet", kids: [deepest])
        XCTAssertFalse(read(sheet).readable)
        XCTAssertTrue(PanelDetector.windowIsOffLimits(read(sheet)))
        let dialog = El("AXWindow", ["AXSubrole": "AXDialog"], kids: [deepest])
        XCTAssertTrue(PanelDetector.windowIsOffLimits(read(dialog)), "a dialog too")
        let modal = El("AXWindow", ["AXSubrole": "AXUnknown"], kids: [deepest])
        XCTAssertFalse(AXTreeRead.node(modal, depth: 1, deep: true, string: { $0.a[$1] }, children: { ($0.kids, true) }).readable, "a modal dialog read as one")
        let shallow = El("AXSheet", kids: [El("AXGroup", kids: [El("AXButton")])])
        XCTAssertTrue(read(shallow).readable)
        XCTAssertFalse(read(El("AXSheet", kids: [El("AXGroup", readable: false)])).readable, "children that could not be read")
    }

    func testAPlainWindowIsStillReadShallow() {
        let window = El("AXWindow", ["AXSubrole": "AXStandardWindow"], kids: buttons(60))
        let n = read(window)
        XCTAssertTrue(n.readable)
        XCTAssertEqual(n.children.count, AXTreeRead.perLevel)
        XCTAssertFalse(PanelDetector.windowIsOffLimits(n))
    }
}

/// sol-F2: `open` claims its window exclusively.
final class OpenClaimTests: XCTestCase {
    func testTwoSessionsOneNewWindowExactlyOneGetsIt() {
        var s = SessionWindows()
        let new = [HandsWindow(id: 20, pid: 300, app: "TextEdit", workspace: 9)]
        XCTAssertEqual(s.claim(new, session: "a")?.id, 20)
        XCTAssertNil(s.claim(new, session: "b"), "the other session gets none")
        XCTAssertTrue(s.windows(of: "b").isEmpty, "and owns none")
        XCTAssertEqual(s.owner(of: 20), "a")
        XCTAssertNotNil(WorkspaceVerbs.closeRefusal(window: new[0], session: "b", opened: s))
        XCTAssertNil(WorkspaceVerbs.closeRefusal(window: new[0], session: "a", opened: s))
        XCTAssertEqual(s.claim(new, session: "a")?.id, 20, "its own window again")
        let two = new + [HandsWindow(id: 21, pid: 300, app: "TextEdit", workspace: 9)]
        XCTAssertEqual(s.claim(two, session: "b")?.id, 21, "the newest free one")
        XCTAssertEqual(s.owner(of: 20), "a")
    }
}

/// sol-F3: `move` decides on the state read after the wait.
final class MoveDecisionTests: XCTestCase {
    let w = HandsWindow(id: 8, pid: 100, app: "Word", workspace: 2)
    func state(_ agent: Int?, window: HandsWindow?, scope: ScopeDecision = .lent, shown: Bool = false) -> MoveState {
        MoveState(agentWorkspace: agent, window: window, scope: scope, agentShown: shown)
    }

    func testTheStateAfterTheWaitDecides() {
        let before = state(9, window: w)
        XCTAssertEqual(try MoveDecision.decide(before: before, after: before).get(), .init(to: 9, moves: true, changed: false))
        guard case .failure(let off) = MoveDecision.decide(before: before, after: state(nil, window: w)) else { return XCTFail("turned off during the wait") }
        XCTAssertEqual(off.code, .agentWorkspaceOff)
        XCTAssertEqual(try MoveDecision.decide(before: before, after: state(5, window: w)).get(), .init(to: 5, moves: true, changed: true), "the new agent workspace")
        guard case .failure(let looking) = MoveDecision.decide(before: before, after: state(9, window: w, shown: true)) else { return XCTFail() }
        XCTAssertEqual(looking.code, .inUse)
        let gone = HandsError(.needsLend, "lend ended", suggestion: "")
        guard case .failure(let e) = MoveDecision.decide(before: before, after: state(9, window: w, scope: .denied(gone))) else { return XCTFail() }
        XCTAssertEqual(e, gone)
        guard case .failure(let missing) = MoveDecision.decide(before: before, after: state(9, window: nil)) else { return XCTFail() }
        XCTAssertEqual(missing.code, .windowNotFound)
        var other = w; other.pid = 101
        guard case .failure(let stale) = MoveDecision.decide(before: before, after: state(9, window: other)) else { return XCTFail() }
        XCTAssertEqual(stale.code, .staleRef)
        var there = w; there.workspace = 5
        XCTAssertEqual(try MoveDecision.decide(before: before, after: state(5, window: there, scope: .onAgentWorkspace)).get().moves, false, "already on the new one")
    }
}
