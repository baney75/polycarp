import BaneySpacesCore
import Foundation
import XCTest

/// Review round 2 of #106, one class per finding.

/// first-F1, sol-first-F1: moved-in records survive a relaunch and are settled before any agent request.
final class MovedInLaunchTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 6_000_000)
    func entry(_ origin: MovedInWindows.Origin, pid: Int32 = 100, started: Double? = 1000) -> MovedInWindows.Entry {
        .init(window: 8, pid: pid, startedAt: started, origin: origin, from: 2, to: 9)
    }

    func testAPersistedRecordWithNoLiveLendIsDeniedAndSentBack() {
        let saved = MovedInWindows.decode(MovedInWindows(entries: [entry(.lent)]).encoded())
        XCTAssertEqual(saved, [entry(.lent)], "saved with its start time, origin, from and to")
        let l = MovedInWindows.launch(saved, startTime: { _ in 1000 }, lends: LendBook(), now: now, mode: .full)
        XCTAssertEqual(l.sendBack.map(\.window), [8])
        XCTAssertTrue(l.keep.isEmpty)
        XCTAssertTrue(l.drop.isEmpty)
        var book = l.book
        let w = HandsWindow(id: 8, pid: 100, app: "Word", workspace: 9)
        XCTAssertFalse(book.decide(w, base: .onAgentWorkspace, lends: LendBook(), now: now, mode: .full).allowed, "denied from launch on")
        XCTAssertEqual(book.settle(lends: LendBook(), now: now, mode: .full).map(\.from), [2], "and sent back to where it came from")
        XCTAssertEqual(book.entries.count, 1, "dropped only after it is read back")
    }

    func testARecordWhoseProcessIsGoneIsDropped() {
        for start in [nil, Double(2000)] {
            let l = MovedInWindows.launch([entry(.fullAccess)], startTime: { _ in start }, lends: LendBook(), now: now, mode: .full)
            XCTAssertEqual(l.drop.map(\.window), [8], "start time \(String(describing: start))")
            XCTAssertTrue(l.book.entries.isEmpty)
        }
        XCTAssertEqual(MovedInWindows.launch([entry(.lent, started: nil)], startTime: { _ in 1000 }, lends: LendBook(), now: now, mode: .standard).drop.count, 1)
    }

    func testARecordWhoseOriginStillHoldsIsKept() {
        let l = MovedInWindows.launch([entry(.fullAccess)], startTime: { _ in 1000.2 }, lends: LendBook(), now: now, mode: .full)
        XCTAssertEqual(l.keep.map(\.window), [8])
        let w = HandsWindow(id: 8, pid: 100, app: "Word", workspace: 9)
        XCTAssertTrue(l.book.decide(w, base: .onAgentWorkspace, lends: LendBook(), now: now, mode: .full).allowed)
        XCTAssertFalse(l.book.decide(w, base: .onAgentWorkspace, lends: LendBook(), now: now, mode: .standard).allowed)
    }
}

/// first-F2: a dialog whose window is unknown, on a split app, is refused whatever attribution says.
final class ParentUnknownDialogTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 2_000_000)
    let modal = ChildWindowFacts(id: 70, pid: 100, app: "Word", title: "Print", role: "AXWindow", subrole: "AXUnknown", modal: true)
    func placed(_ ws: [Int]) -> [(window: HandsWindow, scope: ScopeDecision)] {
        ws.enumerated().map { i, n in
            let w = HandsWindow(id: UInt32(7 + i), pid: 100, app: "Word", workspace: n)
            return (w, ScopeGuard.check(w, agentWorkspace: 9, lends: LendBook(), now: now))
        }
    }

    func testAnAttributedModalDialogWithNoParentOnASplitAppIsRefused() {
        guard case .refused(let rule, _) = ChildWindowRule.decide(modal, placed: placed([9, 2]), attributed: true) else { return XCTFail("refused") }
        XCTAssertEqual(rule, .ownership)
        XCTAssertTrue(ChildWindowRule.decide(modal, placed: placed([9, 9]), attributed: false).allowed, "every window of the app is usable")
        XCTAssertTrue(ChildWindowRule.decide(modal, placed: placed([9, 9]), attributed: true).allowed)
    }

    func testTheParentIsTheOneFirstSeen() {
        var a = ChildAttribution()
        let t0 = Date(timeIntervalSince1970: 3_000_000)
        a.acted(session: "s", pid: 100, at: t0, existing: [])
        a.observed([70], pid: 100, at: t0.addingTimeInterval(1), parents: [70: 8])
        a.observed([70], pid: 100, at: t0.addingTimeInterval(2), parents: [70: 7])
        XCTAssertEqual(a.parent(of: 70, pid: 100), 8, "the main window when it appeared, not a later one")
        XCTAssertNil(a.parent(of: 70, pid: 101))

    }
}

/// sol-first-F2: parents are collected before children are built.
final class ChildCollectOrderTests: XCTestCase {
    func testASheetListedBeforeItsParentGetsThatParent() {
        let listed: [ChildCollect.Listed] = [.init(id: 60, placed: false), .init(id: 7, placed: true), .init(id: 8, placed: true, sheets: [60])]
        XCTAssertEqual(ChildCollect.assemble(listed), [.init(id: 60, parent: 8)])
        XCTAssertEqual(ChildCollect.assemble(listed.reversed()), [.init(id: 60, parent: 8)], "either order")
        let ax: [ChildCollect.Listed] = [.init(id: 70, placed: false, axParent: 7), .init(id: 7, placed: true), .init(id: 71, placed: false, axParent: 99)]
        XCTAssertEqual(ChildCollect.assemble(ax), [.init(id: 70, parent: 7), .init(id: 71, parent: nil)], "AXParent only when it is a placed window")
    }
}

/// sol-sol-F2: see `OpenRequestTests` (review round 3).

/// sol-sol-F4: every sheet, dialog or alert child gets the file-panel check, and a cut-off read refuses it.
final class ModalDialogPanelTests: XCTestCase {
    func testAModalDialogWithAnUnknownSubroleHoldingABrowserIsRefused() {
        let d = AXNodeInfo(role: "AXWindow", subrole: "AXUnknown", children: [AXNodeInfo(role: "AXGroup", children: [AXNodeInfo(role: "AXBrowser")])])
        let kind = ChildWindowRule.kind(role: d.role, subrole: d.subrole, modal: true)
        XCTAssertEqual(kind, .dialog)
        XCTAssertFalse(PanelDetector.windowIsOffLimits(d), "what the old check said")
        XCTAssertTrue(PanelDetector.childIsOffLimits(d, kind: kind))
        var cut = AXNodeInfo(role: "AXWindow", subrole: "AXUnknown", children: [AXNodeInfo(role: "AXButton", title: "OK")])
        cut.readable = false
        XCTAssertTrue(PanelDetector.childIsOffLimits(cut, kind: kind), "a cut-off read")
        let plain = AXNodeInfo(role: "AXWindow", subrole: "AXUnknown", children: [AXNodeInfo(role: "AXStaticText", value: "Replace?"), AXNodeInfo(role: "AXButton", title: "OK")])
        XCTAssertFalse(PanelDetector.childIsOffLimits(plain, kind: kind), "a plain dialog read whole")
        XCTAssertFalse(PanelDetector.childIsOffLimits(AXNodeInfo(role: "AXWindow", subrole: "AXFloatingWindow", title: "Fonts"), kind: .floating))
    }
}

/// sol-sol-F5: the managing verbs check the mode, scope and in use in the pass that changes things.
final class MutationGateTests: XCTestCase {
    let a = HandsWindow(id: 7, pid: 100, app: "TextEdit", workspace: 9)
    let b = HandsWindow(id: 8, pid: 100, app: "TextEdit", workspace: 9)
    func ok(_ w: HandsWindow) -> MutationTarget { MutationTarget(window: w, live: w, scope: .onAgentWorkspace, inUse: nil) }

    func testReadOnlyAtMutationTimeRefusesAndNothingMoves() {
        var moved = 0
        let r = MutationGate.run(mode: .readOnly, targets: [ok(a), ok(b)]) { () -> Result<Int, HandsError> in moved += 1; return .success(2) }
        guard case .failure(let e) = r else { return XCTFail("Read Only must refuse") }
        XCTAssertEqual(e, AgentAccessGate.actingRefusal(mode: .readOnly))
        XCTAssertEqual(moved, 0)
        XCTAssertEqual(try MutationGate.run(mode: .standard, targets: [ok(a), ok(b)]) { () -> Result<Int, HandsError> in moved += 1; return .success(2) }.get(), 2)
        XCTAssertEqual(moved, 1)
    }

    func testArrangeAppliesNoFrameUnlessEveryTargetPasses() {
        let denied = HandsError(.needsLend, "lend ended", suggestion: "")
        let busy = HandsError(.inUse, "in use", suggestion: "")
        var stale = ok(b); stale.live = HandsWindow(id: 8, pid: 101, app: "TextEdit", workspace: 9)
        for (bad, code) in [(MutationTarget(window: b, live: b, scope: .denied(denied), inUse: nil), HandsErrorCode.needsLend),
                            (MutationTarget(window: b, live: b, scope: .onAgentWorkspace, inUse: busy), .inUse),
                            (MutationTarget(window: b, live: nil, scope: .onAgentWorkspace, inUse: nil), .windowNotFound),
                            (stale, .staleRef)] {
            var applied = 0
            let r = MutationGate.run(mode: .full, targets: [ok(a), bad]) { () -> Result<Void, HandsError> in applied += 1; return .success(()) }
            guard case .failure(let e) = r else { return XCTFail("\(code)") }
            XCTAssertEqual(e.code, code)
            XCTAssertEqual(applied, 0, "nothing moved for \(code)")
        }
    }
}
