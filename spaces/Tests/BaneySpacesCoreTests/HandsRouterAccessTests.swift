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

    func testAConnectorIsRemoteAndNeverGetsFullAccess() {
        XCTAssertTrue(HandsCaller.isRemote(HandsCaller.connector))
        XCTAssertFalse(HandsCaller.isRemote(nil))
        XCTAssertFalse(HandsCaller.isRemote("claude"))
        XCTAssertEqual(AgentAccessMode.full.forRemote, .standard)
        XCTAssertEqual(AgentAccessMode.readOnly.forRemote, .readOnly)
    }
}
