import BaneySpacesCore
import Foundation
import XCTest

/// A connector is never more than Default. That rests on one thing: the hands read access from the router's capped `access`,
/// so a new read of the global setting would quietly hand a connector Full Access. This fails on that read.
final class HandsRouterAccessTests: XCTestCase {
    private var hands: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/BaneySpaces/Hands")
    }

    func testTheHandsReadAccessThroughTheCapOnly() throws {
        for name in ["HandsRouter.swift", "HandsRouter+Background.swift"] {
            let lines = try String(contentsOf: hands.appendingPathComponent(name), encoding: .utf8).components(separatedBy: .newlines)
            let reads = lines.filter { $0.contains("AgentAccess.shared.current") }
            let allowed = name == "HandsRouter.swift" ? ["var access: AgentAccessMode { cap(AgentAccess.shared.current) }"] : []
            XCTAssertEqual(reads.map { $0.trimmingCharacters(in: .whitespaces) }, allowed, name)
        }
    }

    func testNoAgentDrivesAPanelOnAnyWindowInAnyMode() {
        let handoff = URL(fileURLWithPath: "/tmp/handoff")
        for full in [true, false] {
            for owned in [true, false] {
                XCTAssertEqual(WindowInspection.decide(full: full, agentOwned: owned, panel: true, document: nil, handoff: handoff), .panel, "full \(full) owned \(owned)")
            }
        }
    }

    /// #124 first-F3: an agent presses cmd+P in its own TextEdit. The Print sheet has a Copies field and a Printer menu, so
    /// it is refused as a panel while it is up, and the window is usable again once it closes, not refused for the run.
    func testAPanelRefusesTheWindowOnlyWhileItIsUp() {
        let handoff = URL(fileURLWithPath: "/tmp/handoff")
        let print = AXNodeInfo(role: "AXWindow", subrole: "AXStandardWindow", title: "Untitled", children: [
            AXNodeInfo(role: "AXSheet", children: [
                AXNodeInfo(role: "AXTextField", title: "Copies"), AXNodeInfo(role: "AXPopUpButton", title: "Printer"),
                AXNodeInfo(role: "AXButton", title: "Print"), AXNodeInfo(role: "AXButton", title: "Cancel"),
            ]),
        ])
        XCTAssertTrue(PanelDetector.windowIsOffLimits(print), "refused while the sheet is up")
        let up = WindowInspection.decide(full: false, agentOwned: true, panel: true, document: nil, handoff: handoff)
        XCTAssertEqual(up, .panel)
        XCTAssertFalse(up.remembered, "the next look, with the sheet gone, decides again")
        XCTAssertTrue(WindowInspection.decide(full: false, agentOwned: true, panel: false, document: "/Users/d/secret.txt", handoff: handoff).remembered,
                      "a document of Donovan's stays refused")
        XCTAssertFalse(WindowInspection.usable.remembered)
    }

    func testADocumentIsCheckedOnlyOnAnAgentsOwnProcess() {
        let handoff = URL(fileURLWithPath: "/tmp/handoff")
        let outside = "/Users/someone/taxes.pdf"
        XCTAssertEqual(WindowInspection.decide(full: false, agentOwned: true, panel: false, document: outside, handoff: handoff), .outsideDocument)
        XCTAssertEqual(WindowInspection.decide(full: false, agentOwned: true, panel: false, document: "/tmp/handoff/a.txt", handoff: handoff), .usable)
        XCTAssertEqual(WindowInspection.decide(full: false, agentOwned: false, panel: false, document: outside, handoff: handoff), .usable, "a lent app is lent with what it shows")
        XCTAssertEqual(WindowInspection.decide(full: true, agentOwned: true, panel: false, document: outside, handoff: handoff), .usable)
    }

    func testAConnectorServerAnswersWithItsOwnName() {
        var server = HandsMCP(version: "1", session: "s", perform: { _ in .failure(HandsError(.badArguments, "no", suggestion: "", retry: .never)) })
        XCTAssertTrue(server.handle(#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)?.contains(#""baneyspaces""#) == true)
        server.name = HandsCaller.connectorServerName
        XCTAssertTrue(server.handle(#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)?.contains(#""polycarp-connector""#) == true)
    }

    func testAConnectorIsRemoteAndNeverGetsFullAccess() {
        XCTAssertTrue(HandsCaller.isRemote(HandsCaller.connector))
        XCTAssertFalse(HandsCaller.isRemote(nil))
        XCTAssertFalse(HandsCaller.isRemote("claude"))
        XCTAssertEqual(AgentAccessMode.full.forRemote, .standard)
        XCTAssertEqual(AgentAccessMode.readOnly.forRemote, .readOnly)
    }
}
