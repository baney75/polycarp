import BaneySpacesCore
import CoreGraphics
import Foundation
import XCTest

/// Donovan, 2026-11-10: Word, lent with its document on the agent workspace, raised a modal dialog the agent could not see or
/// answer. These hold the rule that lets an agent answer a dialog of its own app, and refuses the ones that may be his.
final class ChildWindowRuleTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 2_000_000)
    func placed(_ id: UInt32, ws: Int, pid: Int32 = 100, app: String = "Word") -> HandsWindow {
        HandsWindow(id: id, pid: pid, app: app, bundle: "com.microsoft.Word", workspace: ws)
    }
    func dialog(_ id: UInt32 = 50, pid: Int32 = 100, subrole: String? = "AXDialog", role: String? = "AXWindow", modal: Bool? = true,
                parent: UInt32? = nil, panel: Bool = false, bundle: String = "com.microsoft.Word", process: String = "Microsoft Word") -> ChildWindowFacts {
        ChildWindowFacts(id: id, pid: pid, app: "Word", bundle: bundle, processName: process, title: "Microsoft Word", role: role, subrole: subrole,
                         modal: modal, parent: parent, panel: panel)
    }
    func decided(_ ws: [HandsWindow], agent: Int = 9, lends: LendBook = LendBook(), mode: AgentAccessMode = .standard) -> [(window: HandsWindow, scope: ScopeDecision)] {
        ws.map { ($0, ScopeGuard.check($0, agentWorkspace: agent, lends: lends, now: now, mode: mode)) }
    }

    func testKinds() {
        XCTAssertEqual(ChildWindowRule.kind(role: "AXWindow", subrole: "AXDialog", modal: nil), .dialog)
        XCTAssertEqual(ChildWindowRule.kind(role: "AXWindow", subrole: "AXSystemDialog", modal: nil), .alert)
        XCTAssertEqual(ChildWindowRule.kind(role: "AXSheet", subrole: nil, modal: nil), .sheet)
        XCTAssertEqual(ChildWindowRule.kind(role: "AXWindow", subrole: "AXFloatingWindow", modal: false), .floating)
        XCTAssertEqual(ChildWindowRule.kind(role: "AXWindow", subrole: "AXUnknown", modal: true), .dialog, "anything modal")
        XCTAssertNil(ChildWindowRule.kind(role: "AXWindow", subrole: "AXStandardWindow", modal: true), "a document window is placed, never a child")
        XCTAssertNil(ChildWindowRule.kind(role: "AXMenu", subrole: nil, modal: nil), "never a menu")
        XCTAssertNil(ChildWindowRule.kind(role: "AXWindow", subrole: "AXUnknown", modal: false))
    }

    /// The same meaning as #99's `WaitingWindow.asks`: modal, or a dialog or alert by subrole.
    func testWaitingMatchesTheDockRule() {
        XCTAssertTrue(ChildWindowRule.waits(subrole: "AXStandardWindow", modal: true))
        XCTAssertTrue(ChildWindowRule.waits(subrole: "AXDialog", modal: nil))
        XCTAssertTrue(ChildWindowRule.waits(subrole: "AXSystemDialog", modal: false))
        XCTAssertFalse(ChildWindowRule.waits(subrole: "AXFloatingWindow", modal: false))
        XCTAssertFalse(ChildWindowRule.waits(subrole: "AXStandardWindow", modal: nil))
        XCTAssertTrue(dialog(subrole: nil, role: "AXSheet", modal: false).waiting, "a sheet blocks its window")
    }

    /// The incident: every window of Word is the agent's (lent, or on the agent workspace), so its dialog is too.
    func testADialogOfAnAppWhoseWindowsAreAllTheAgentsIsUsable() {
        var b = LendBook()
        b.lend(app: "Word", bundle: "com.microsoft.Word", pid: 100, windows: [7], session: "s", now: now, for: 600)
        for (ws, book, scope) in [([placed(7, ws: 9)], LendBook(), ScopeDecision.onAgentWorkspace), ([placed(7, ws: 2)], b, .lent)] {
            let d = ChildWindowRule.decide(dialog(), placed: decided(ws, lends: book), attributed: false)
            XCTAssertEqual(d, .usable(scope: scope, parent: nil, ownership: "all_windows_usable"))
        }
        let full = ChildWindowRule.decide(dialog(), placed: decided([placed(7, ws: 2)], mode: .full), attributed: false)
        XCTAssertEqual(full.scope, .fullAccess)
    }

    /// Negative: Word with one window on the agent workspace and one on Donovan's raises a dialog nobody's action raised.
    func testHisDialogOnASplitAppIsRefused() throws {
        let split = decided([placed(7, ws: 9), placed(8, ws: 2)])
        guard case .refused(let rule, let e) = ChildWindowRule.decide(dialog(), placed: split, attributed: false) else { return XCTFail() }
        XCTAssertEqual(rule, .ownership)
        XCTAssertEqual(e.code, .outsideAgentWorkspace)
        XCTAssertEqual(e.retry, .never)
        XCTAssertTrue(e.message.contains("rule 2"))
        XCTAssertTrue(e.suggestion.contains("Leave it for Donovan"))
        XCTAssertEqual(ChildWindowRule.decide(dialog(), placed: split, attributed: true), .usable(scope: .onAgentWorkspace, parent: nil, ownership: "after_your_action"))
    }

    func testTheParentsScopeIsTakenWhenKnown() {
        var b = LendBook()
        b.lend(app: "Word", bundle: "com.microsoft.Word", pid: 100, windows: [8], session: "s", now: now, for: 600)
        let both = decided([placed(7, ws: 9), placed(8, ws: 2)], lends: b)
        XCTAssertEqual(ChildWindowRule.decide(dialog(parent: 8), placed: both, attributed: false).scope, .lent)
        XCTAssertEqual(ChildWindowRule.decide(dialog(parent: 7), placed: both, attributed: false).scope, .onAgentWorkspace)
    }

    /// Negative: an Open panel keeps its old refusal, word for word, in every mode.
    func testAnOpenPanelIsRefusedWithTheExistingMessage() {
        for mode in AgentAccessMode.allCases {
            guard case .refused(let rule, let e) = ChildWindowRule.decide(dialog(panel: true), placed: decided([placed(7, ws: 9)], mode: mode), attributed: true) else { return XCTFail() }
            XCTAssertEqual(rule, .panel)
            XCTAssertEqual(e, PanelDetector.refusal(window: 50, app: "Word"))
            XCTAssertEqual(e.message, "window 50 of Word is or holds an Open or Save panel")
            XCTAssertEqual(e.code, .needsSandbox)
        }
    }

    /// Negative: a prompt from another process (SecurityAgent, coreauthd, UserNotificationCenter, TCC) is never an agent's,
    /// even if every rule above would let it through.
    func testAnotherProcesssPromptIsRefused() {
        let usable = decided([placed(7, ws: 9, pid: 300)])
        for (bundle, process) in [("com.apple.SecurityAgent", "SecurityAgent"), ("com.apple.coreauthd", "coreauthd"),
                                  ("com.apple.UserNotificationCenter", "UserNotificationCenter"), ("com.apple.tccd", "tccd"), ("", "SecurityAgent")] {
            guard case .refused(let rule, let e) = ChildWindowRule.decide(dialog(pid: 300, bundle: bundle, process: process), placed: usable, attributed: true) else { return XCTFail(process) }
            XCTAssertEqual(rule, .systemPrompt, process)
            XCTAssertEqual(e.code, .permissionDenied)
            XCTAssertEqual(e.retry, .never)
        }
        // And by pid alone: a prompt of a process with no window the agent may use is refused under rule 1.
        guard case .refused(let rule, _) = ChildWindowRule.decide(dialog(pid: 301, bundle: "com.example.other", process: "Other"), placed: usable, attributed: true) else { return XCTFail() }
        XCTAssertEqual(rule, .noUsableWindow)
    }

    func testAStandardWindowAMenuOrPolycarpsOwnIsRefused() {
        let usable = decided([placed(7, ws: 9)])
        guard case .refused(let r1, _) = ChildWindowRule.decide(dialog(subrole: "AXStandardWindow", modal: true), placed: usable, attributed: true) else { return XCTFail() }
        XCTAssertEqual(r1, .notAChild)
        guard case .refused(let r2, _) = ChildWindowRule.decide(dialog(subrole: nil, role: "AXMenu", modal: nil), placed: usable, attributed: true) else { return XCTFail() }
        XCTAssertEqual(r2, .notAChild)
        guard case .refused(let r3, _) = ChildWindowRule.decide(dialog(), placed: usable, attributed: true, selfPid: 100) else { return XCTFail() }
        XCTAssertEqual(r3, .ownWindow)
    }

    func testNoUsableWindowOfThatAppMeansNoDialog() {
        guard case .refused(let rule, let e) = ChildWindowRule.decide(dialog(), placed: decided([placed(7, ws: 2)]), attributed: true) else { return XCTFail() }
        XCTAssertEqual(rule, .noUsableWindow)
        XCTAssertTrue(e.message.contains("rule 1"))
    }
}

final class ChildAttributionTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 3_000_000)

    func testADialogWithinTenSecondsOfThisSessionsActionIsItsOwn() {
        var a = ChildAttribution()
        a.acted(session: "s1", pid: 100, at: t0, existing: [])
        a.observed([50], pid: 100, at: t0.addingTimeInterval(9.5))
        XCTAssertTrue(a.attributed(50, pid: 100, session: "s1"))
        XCTAssertFalse(a.attributed(50, pid: 100, session: "s2"), "another session's action")
        XCTAssertFalse(a.attributed(50, pid: 101, session: "s1"), "another process")
    }

    /// Negative: a dialog first seen 11 s after the action is nobody's, and stays nobody's after a later action.
    func testADialogThatAppearedElevenSecondsAfterIsNotAttributed() {
        var a = ChildAttribution()
        a.acted(session: "s1", pid: 100, at: t0, existing: [])
        a.observed([50], pid: 100, at: t0.addingTimeInterval(11))
        XCTAssertFalse(a.attributed(50, pid: 100, session: "s1"))
        a.acted(session: "s1", pid: 100, at: t0.addingTimeInterval(12), existing: [50])
        a.observed([50], pid: 100, at: t0.addingTimeInterval(12.5))
        XCTAssertFalse(a.attributed(50, pid: 100, session: "s1"), "seen once outside the window: never later")
    }

    func testADialogThatWasThereBeforeTheActionIsNotTheActions() {
        var a = ChildAttribution()
        a.acted(session: "s1", pid: 100, at: t0, existing: [50])
        a.observed([50], pid: 100, at: t0.addingTimeInterval(1))
        XCTAssertFalse(a.attributed(50, pid: 100, session: "s1"))
        var b = ChildAttribution()
        b.observed([51], pid: 100, at: t0)
        b.acted(session: "s1", pid: 100, at: t0.addingTimeInterval(1), existing: [])
        b.observed([51], pid: 100, at: t0.addingTimeInterval(2))
        XCTAssertFalse(b.attributed(51, pid: 100, session: "s1"), "seen before any action")
        XCTAssertFalse(b.attributed(51, pid: 100, session: ""))
        XCTAssertTrue(b.watching(pid: 100, now: t0.addingTimeInterval(10)))
        XCTAssertFalse(b.watching(pid: 100, now: t0.addingTimeInterval(12)))
    }
}

/// The sheet rule changed on 2026-11-10: a sheet alone no longer locks its window; an Open or Save panel still does.
final class PanelSheetTests: XCTestCase {
    func window(_ children: [AXNodeInfo]) -> AXNodeInfo { AXNodeInfo(role: "AXWindow", subrole: "AXStandardWindow", title: "Untitled", children: children) }
    let button = { (t: String) in AXNodeInfo(role: "AXButton", title: t) }

    func testASaveChangesSheetLeavesTheWindowUsable() {
        let sheet = AXNodeInfo(role: "AXSheet", children: [AXNodeInfo(role: "AXStaticText", value: "Do you want to keep this new document?"),
                                                           button("Delete"), button("Cancel"), button("Save…")])
        XCTAssertFalse(PanelDetector.windowIsOffLimits(window([AXNodeInfo(role: "AXScrollArea"), sheet])))
    }

    func testASaveSheetStillLocksTheWindow() {
        let save = AXNodeInfo(role: "AXSheet", children: [AXNodeInfo(role: "AXStaticText", value: "Save As:"), AXNodeInfo(role: "AXTextField"),
                                                          AXNodeInfo(role: "AXStaticText", value: "Where:"), AXNodeInfo(role: "AXPopUpButton"), button("Save")])
        XCTAssertTrue(PanelDetector.windowIsOffLimits(window([save])))
        XCTAssertTrue(PanelDetector.windowIsOffLimits(window([AXNodeInfo(role: "AXSheet", title: "Save")])), "a panel title")
        XCTAssertTrue(PanelDetector.windowIsOffLimits(window([AXNodeInfo(role: "AXSheet", children: [AXNodeInfo(role: "AXBrowser")])])), "a file browser")
        XCTAssertTrue(PanelDetector.windowIsOffLimits(window([AXNodeInfo(role: "AXSheet", children: [AXNodeInfo(role: "AXSplitGroup", children: [AXNodeInfo(role: "AXOutline")])])])), "a sidebar outline")
        XCTAssertTrue(PanelDetector.windowIsOffLimits(window([AXNodeInfo(role: "AXSheet", readable: false)])), "unreadable fails closed")
        XCTAssertTrue(PanelDetector.windowIsOffLimits(window([AXNodeInfo(role: "AXGroup", identifier: "save-panel")])), "a panel descendant")
    }

    func testAPanelWindowItselfIsOffLimits() {
        XCTAssertTrue(PanelDetector.windowIsOffLimits(AXNodeInfo(role: "AXWindow", subrole: "AXDialog", identifier: "open-panel", title: "Open")))
        XCTAssertTrue(PanelDetector.windowIsOffLimits(AXNodeInfo(role: "AXWindow", subrole: "AXDialog", title: "Choose")))
        XCTAssertFalse(PanelDetector.windowIsOffLimits(AXNodeInfo(role: "AXWindow", subrole: "AXFloatingWindow", title: "Fonts")))
        XCTAssertFalse(PanelDetector.windowIsOffLimits(AXNodeInfo(role: "AXWindow", subrole: "AXDialog", title: "Microsoft Word",
                                                                  children: [AXNodeInfo(role: "AXStaticText", value: "Word found unreadable content."), AXNodeInfo(role: "AXButton", title: "Yes")])))
    }

    func testSnapshotsMarkTheSheet() {
        let tree: JSONValue = .object(["role": "window", "children": .array([
            .object(["role": "textarea"]),
            .object(["role": "sheet", "children": .array([.object(["role": "button", "name": "Don't Save"])])]),
        ])])
        let (marked, n) = SheetMark.mark(tree)
        XCTAssertEqual(n, 1)
        XCTAssertNil(marked["children"]?.array?[0]["in_sheet"])
        XCTAssertEqual(marked["children"]?.array?[1]["sheet"]?.bool, true)
        XCTAssertEqual(marked["children"]?.array?[1]["children"]?.array?[0]["in_sheet"]?.bool, true)
    }
}

final class WorkspaceVerbTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 4_000_000)
    func w(_ ws: Int?, id: UInt32 = 7, pid: Int32 = 100) -> HandsWindow { HandsWindow(id: id, pid: pid, app: "TextEdit", workspace: ws) }

    func testTheNewToolsExistActAndAreRefusedUnderReadOnly() throws {
        for v in ["arrange", "move", "close"] {
            let t = try XCTUnwrap(HandsTools.tool(verb: v))
            XCTAssertTrue(t.acts, v)
            XCTAssertEqual(AgentAccessGate.refusal(verb: v, mode: .readOnly)?.code, .permissionDenied, v)
            XCTAssertNotNil(WorkspaceVerbs.connectorRefusal(verb: v), "a connector never \(v)s")
        }
        let ws = try XCTUnwrap(HandsTools.tool(verb: "workspaces"))
        XCTAssertFalse(ws.acts)
        XCTAssertNil(AgentAccessGate.refusal(verb: "workspaces", mode: .readOnly))
        XCTAssertNil(WorkspaceVerbs.connectorRefusal(verb: "workspaces"), "connectors may read workspaces")
        XCTAssertNil(WorkspaceVerbs.connectorRefusal(verb: "open"), "the existing cap already lets a connector open")
        XCTAssertEqual(InUseRule.decide(verb: "workspaces", state: .front, onAgentWorkspace: false, isFocusedWindow: true, isMainWindow: true, delivery: .headlessAX), .proceed)
        for v in ["arrange", "move", "close"] {
            XCTAssertEqual(InUseRule.decide(verb: v, state: .front, onAgentWorkspace: true, isFocusedWindow: false, isMainWindow: false, delivery: .headlessAX), .wait, "\(v) waits while he uses the app")
        }
    }

    func testArgumentsAreChecked() {
        guard case .success(let a) = HandsParse.command(["arrange", "grid", "4211", "4212"]) else { return XCTFail() }
        XCTAssertEqual(a.args["windows"], .array(["4211", "4212"]))
        guard case .success = HandsParse.command(["arrange", "frames", "4211=0,0,800,600"]) else { return XCTFail() }
        for bad in [["arrange", "tiles"], ["arrange", "frames"], ["arrange", "frames", "4211=0,0,800"], ["arrange", "grid", "abc"], ["move", "--window", "1", "--frame", "1,2"]] {
            guard case .failure(let e) = HandsParse.command(bad) else { return XCTFail("\(bad)") }
            XCTAssertEqual(e.code, .badArguments)
        }
        guard case .success(let o) = HandsParse.call(name: "open", arguments: ["app": "TextEdit", "new_window": .bool(false)]) else { return XCTFail() }
        XCTAssertEqual(o.args["new_window"], .bool(false))
        guard case .success(let m) = HandsParse.call(name: "move", arguments: ["window": .int(5), "frame": "0,0,640,480"]) else { return XCTFail() }
        XCTAssertEqual(m.int("window"), 5)
    }

    func testMoveGoesOnlyOntoTheAgentWorkspaceAndNeverWhileHeLooksAtIt() {
        XCTAssertNil(WorkspaceVerbs.moveRefusal(window: w(9), scope: .onAgentWorkspace, agentWorkspace: 9, agentShown: true), "reframing on the agent workspace")
        XCTAssertNil(WorkspaceVerbs.moveRefusal(window: w(2), scope: .lent, agentWorkspace: 9, agentShown: false))
        XCTAssertNil(WorkspaceVerbs.moveRefusal(window: w(2), scope: .fullAccess, agentWorkspace: 9, agentShown: false))
        XCTAssertEqual(WorkspaceVerbs.moveRefusal(window: w(2), scope: .lent, agentWorkspace: 9, agentShown: true)?.code, .inUse, "never onto a workspace he is looking at")
        let his = ScopeGuard.check(w(2), agentWorkspace: 9, lends: LendBook(), now: now)
        XCTAssertEqual(WorkspaceVerbs.moveRefusal(window: w(2), scope: his, agentWorkspace: 9, agentShown: false)?.code, .outsideAgentWorkspace, "his unlent window")
        XCTAssertEqual(WorkspaceVerbs.moveRefusal(window: w(nil), scope: .onAgentWorkspace, agentWorkspace: 9, agentShown: false)?.code, .notSupported, "a dialog")
        XCTAssertEqual(WorkspaceVerbs.moveRefusal(window: w(2), scope: .lent, agentWorkspace: nil, agentShown: false)?.code, .agentWorkspaceOff)
    }

    func testCloseClosesOnlyWhatThisSessionOpened() {
        var s = SessionWindows()
        s.record(session: "a", window: 7, pid: 100)
        XCTAssertNil(WorkspaceVerbs.closeRefusal(window: w(9), session: "a", opened: s))
        XCTAssertEqual(WorkspaceVerbs.closeRefusal(window: w(9), session: "b", opened: s)?.code, .permissionDenied, "another session's")
        XCTAssertNotNil(WorkspaceVerbs.closeRefusal(window: w(9, pid: 101), session: "a", opened: s), "the same id in another process")
        XCTAssertNotNil(WorkspaceVerbs.closeRefusal(window: w(9, id: 8), session: "a", opened: s), "a window it didn't open")
        XCTAssertNotNil(WorkspaceVerbs.closeRefusal(window: w(9), session: "", opened: s))
        s.forget(window: 7)
        XCTAssertNotNil(WorkspaceVerbs.closeRefusal(window: w(9), session: "a", opened: s))
    }

    func testLayouts() {
        let area = CGRect(x: 0, y: 25, width: 1200, height: 800)
        XCTAssertEqual(AgentArrange.frames(.full, count: 2, area: area), [area, area])
        XCTAssertEqual(AgentArrange.frames(.halves, count: 3, area: area).map(\.minX), [0, 600, 0])
        XCTAssertEqual(AgentArrange.frames(.thirds, count: 3, area: area).map(\.width), [400, 400, 400])
        let grid = AgentArrange.frames(.grid, count: 5, area: area)
        XCTAssertEqual(grid.count, 5)
        XCTAssertEqual(grid[3], CGRect(x: 0, y: 425, width: 400, height: 400))
        for f in grid { XCTAssertTrue(area.contains(f)) }
        XCTAssertTrue(AgentArrange.frames(.grid, count: 0, area: area).isEmpty)
        let p = AgentArrange.parseFrame("42=10,20,300,200")
        XCTAssertEqual(p?.window, 42)
        XCTAssertEqual(AgentArrange.place(p!.frame, in: area), CGRect(x: 10, y: 45, width: 300, height: 200))
        XCTAssertEqual(AgentArrange.place(CGRect(x: 5000, y: -50, width: 10, height: 10), in: area), CGRect(x: 960, y: 25, width: 240, height: 160), "kept inside, at least the minimum")
    }

    func testWorkspacesListsCountsAndTheAgentWorkspaceButNoTitles() {
        let rows = [WorkspaceRow(number: 1, name: "Mail", shown: true, current: true, windows: 3), WorkspaceRow(number: 9, shown: false, current: false, windows: 1)]
        let mine = HandsWindow(id: 7, pid: 100, app: "TextEdit", title: "secret", workspace: 9)
        let j = WorkspaceList.json(rows: rows, agentWorkspace: 9, access: .standard, usable: [(mine, .onAgentWorkspace)])
        XCTAssertEqual(j["agent_workspace"]?.int, 9)
        XCTAssertEqual(j["agent_workspace_shown"]?.bool, false)
        XCTAssertEqual(j["workspaces"]?.array?.first?["name"]?.string, "Mail")
        XCTAssertEqual(j["workspaces"]?.array?.last?["agent"]?.bool, true)
        XCTAssertEqual(j["your_windows"]?.array?.first?["workspace"]?.int, 9)
        XCTAssertFalse(j.text.contains("secret"))
    }

    func testARefusedChildIsListedWithoutItsTitle() {
        let c = ChildWindowFacts(id: 50, pid: 100, app: "Word", title: "Donovan's letter", role: "AXWindow", subrole: "AXDialog", modal: true)
        let refused = ChildWindowList.entry(c, decision: .refused(.ownership, HandsError(.outsideAgentWorkspace, "x", suggestion: "y")), inUse: .free)
        XCTAssertFalse(refused.text.contains("letter"))
        XCTAssertEqual(refused["usable"]?.bool, false)
        XCTAssertEqual(refused["rule"]?.string, "rule2_ownership")
        XCTAssertEqual(refused["waiting"]?.bool, true)
        let ok = ChildWindowList.entry(c, decision: .usable(scope: .lent, parent: 7, ownership: "all_windows_usable"), inUse: .front)
        XCTAssertEqual(ok["kind"]?.string, "dialog")
        XCTAssertEqual(ok["scope"]?.string, "lent")
        XCTAssertEqual(ok["in_use"]?.bool, true)
        XCTAssertEqual(ChildWindowList.opened(c)["kind"]?.string, "dialog")
    }
}

/// The router sends every window BaneySpaces does not place through `ChildWindowRule`, refuses a system prompt before it
/// reads a single attribute of it, and refuses the managing verbs to connectors before anything else.
final class ChildWindowSourceTests: XCTestCase {
    func testUnplacedWindowsGoThroughTheChildRule() throws {
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let decide = try XCTUnwrap(HandsSourceTests.block(after: "func decide(_ w: HandsWindow, _ agent: Int?, session: String = \"\")", in: router))
        XCTAssertTrue(decide.contains("if w.workspace == nil { return childDecision(w.id, pid: w.pid, agent: agent, session: session)?.decision.scope ?? ScopeGuard.check("))
        XCTAssertTrue(router.contains("if remote, let e = WorkspaceVerbs.connectorRefusal(verb: req.verb) { return .failure(e) }"))
        let ws = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        let child = try XCTUnwrap(HandsSourceTests.block(after: "func childDecision(", in: ws))
        let prompt = try XCTUnwrap(child.range(of: "ChildWindowRule.isSystemPrompt(bundle: bundle, processName: process)"))
        let read = try XCTUnwrap(child.range(of: "readChildren(pid: pid, all: all)"))
        XCTAssertLessThan(prompt.lowerBound, read.lowerBound, "a system prompt is never read")
        XCTAssertTrue(ws.contains("ChildWindowRule.decide(c, placed: placed, attributed: attributed, selfPid: getpid())"))
    }
}
