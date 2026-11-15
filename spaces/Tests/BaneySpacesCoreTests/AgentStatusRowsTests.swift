import XCTest
@testable import BaneySpacesCore

/// #311, live on 833ad1f: `agent status` listed window 68007 of TextEdit pid 16828 after the copy quit.
final class AgentStatusRowsTests: XCTestCase {
    func testAWindowOfAnExitedProcessIsDropped() {
        let rows: [(id: UInt32, pid: Int32?)] = [(68007, 16828), (66083, 69154), (5, nil)]
        let kept = AgentStatusRows.live(rows, pid: { $0.pid }, alive: { $0 == 69154 })
        XCTAssertEqual(kept.map(\.id), [66083], "the quit copy's window and one with no process are gone")
    }

    func testThisProcessIsAliveAndAnExitedOneIsNot() throws {
        XCTAssertTrue(AgentStatusRows.processAlive(getpid()))
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try p.run()
        p.waitUntilExit()
        XCTAssertFalse(AgentStatusRows.processAlive(p.processIdentifier), "reaped, so no process has that pid")
        XCTAssertFalse(AgentStatusRows.processAlive(0))
    }

    func testStatusReadsOnlyLiveRows() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let spaces = try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/Spaces.swift"), encoding: .utf8)
        let body = try XCTUnwrap(spaces.range(of: "func agentWindows() -> [(id: WindowID, app: String, title: String)] {")).upperBound
        XCTAssertTrue(String(spaces[body...].prefix(600)).contains("return AgentStatusRows.live(rows, pid: { $0.pid })"))
    }
}
