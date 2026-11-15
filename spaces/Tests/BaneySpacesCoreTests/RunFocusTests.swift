import XCTest
@testable import BaneySpacesCore

/// PR 20 sol-F4: `agent run` starting Terminal watched its keyboard only once the new pid came back, so Terminal could take
/// the keyboard first. The watch by bundle now starts before the launch, as `agent open`'s does.
final class RunFocusTests: XCTestCase {
    func testAgentRunWatchesTerminalBeforeItLaunches() throws {
        let engine = try String(contentsOf: HandsSourceTests.root.appendingPathComponent("Sources/BaneySpaces/Session/Engine.swift"), encoding: .utf8)
        let run = try XCTUnwrap(engine.range(of: "func newAgentTerminal("))
        let watch = try XCTUnwrap(engine.range(of: "AgentLaunchFocus.shared.watch(bundle: TerminalChoice.terminal, excluding: [], for: 10)", range: run.upperBound..<engine.endIndex))
        let open = try XCTUnwrap(engine.range(of: "NSWorkspace.shared.open([script]", range: run.upperBound..<engine.endIndex))
        XCTAssertLessThan(watch.lowerBound, open.lowerBound, "watched before Terminal starts")
        XCTAssertTrue(engine[run.upperBound..<watch.lowerBound].contains("if running == nil {"), "your running Terminal isn't watched")

        // The watch it starts: a Terminal that wasn't running and comes forward gives the keyboard back.
        var focus = FocusReturn()
        let now = Date()
        focus.seed(front: 5, agentOwned: false)
        focus.watch(bundle: "com.apple.Terminal", excluding: [], now: now, until: now.addingTimeInterval(10))
        XCTAssertEqual(focus.activated(pid: 9, bundle: "com.apple.Terminal", agentOwned: false, frontNow: 9, now: now), .returnTo(5))
    }
}
