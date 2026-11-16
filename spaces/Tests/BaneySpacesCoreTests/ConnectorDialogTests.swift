import XCTest
@testable import BaneySpacesCore

/// #124 first-F5 (Donovan, 2026-11-15): a remote connector may answer a native dialog under exactly a local agent's rules,
/// the agent workspace or apps he lent, and never more. Whatever Settings says, the connector's scope is capped first.
final class ConnectorDialogTests: XCTestCase {
    let agent = 9, now = Date()

    /// The connector's decision for a dialog of Notes, whose one placed window is `notes`, under Settings' `mode`.
    func connectorDecision(_ notes: HandsWindow, mode: AgentAccessMode, lends: LendBook = LendBook(), attributed: Bool = true, parent: UInt32? = nil) -> ChildWindowRule.Decision {
        let scope = ScopeGuard.check(notes, agentWorkspace: agent, lends: lends, now: now, mode: mode.forRemote)
        let dialog = ChildWindowFacts(id: 77, pid: notes.pid, app: "Notes", subrole: "AXDialog", parent: parent)
        return ChildWindowRule.decide(dialog, placed: [(window: notes, scope: scope)], attributed: attributed)
    }

    func testAConnectorNeverAnswersADialogOffTheAgentWorkspaceOrALend() {
        let mine = HandsWindow(id: 40, pid: 400, app: "Notes", workspace: 2)
        for mode in AgentAccessMode.allCases {
            for parent in [nil, UInt32(40)] {
                XCTAssertFalse(connectorDecision(mine, mode: mode, parent: parent).allowed, "\(mode), parent \(String(describing: parent))")
            }
        }
        // The same dialog is usable by a local agent under Full Access, so the refusal above is the connector's cap.
        let local = ChildWindowRule.decide(ChildWindowFacts(id: 77, pid: 400, app: "Notes", subrole: "AXDialog"),
                                           placed: [(window: mine, scope: ScopeGuard.check(mine, agentWorkspace: agent, lends: LendBook(), now: now, mode: .full))], attributed: true)
        XCTAssertTrue(local.allowed)
    }

    func testAConnectorAnswersADialogOnTheAgentWorkspaceOrALentApp() {
        let onAgent = HandsWindow(id: 41, pid: 401, app: "Notes", workspace: agent)
        XCTAssertTrue(connectorDecision(onAgent, mode: .full).allowed)
        XCTAssertTrue(connectorDecision(onAgent, mode: .standard).allowed)
        var lends = LendBook()
        let lent = HandsWindow(id: 42, pid: 402, app: "Notes", workspace: 2)
        lends.lend(app: "Notes", bundle: "", pid: 402, windows: [42], session: "s", now: now, for: 600)
        XCTAssertTrue(connectorDecision(lent, mode: .standard, lends: lends).allowed)
    }

    /// The router the connector uses decides every child window with that capped scope: no path skips the cap.
    func testTheConnectorsChildDecisionsUseTheCappedMode() throws {
        let session = try HandsSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertTrue(session.contains("HandsRouter(cap: { $0.forRemote }, remote: true)"))
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertTrue(router.contains("var access: AgentAccessMode { cap(AgentAccess.shared.current) }"))
        let decide = try XCTUnwrap(HandsSourceTests.block(after: "func decide(_ w: HandsWindow, _ agent: Int?, session: String = \"\") -> ScopeDecision", in: router))
        XCTAssertTrue(decide.contains("let mode = access"))
        XCTAssertTrue(decide.contains("ScopeGuard.check(w, agentWorkspace: agent, lends: book, now: Date(), mode: mode, selfPid: getpid())"))
        let children = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        let each = try XCTUnwrap(HandsSourceTests.block(after: "func decideChildren(", in: children))
        XCTAssertTrue(each.contains("scope: decide($0, agent, session: session)"))
    }

    func testSecurityDocStatesTheRule() throws {
        let doc = try String(contentsOf: HandsSourceTests.root.appendingPathComponent("SECURITY.md"), encoding: .utf8)
            .replacingOccurrences(of: "\n  ", with: " ")
        XCTAssertTrue(doc.contains("A connector may answer a dialog under exactly these rules, held to Default"))
        XCTAssertTrue(doc.contains("never through Full Access"))
        XCTAssertFalse(doc.contains("Connectors get none of these"))
    }
}
