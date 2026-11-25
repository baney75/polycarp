import XCTest
@testable import BaneySpacesCore

final class BarAgentsTests: XCTestCase {
    private func item(_ id: String, _ activity: Activity, notice: String = "", workspace: Int = 0) -> Item {
        var i = Item(id: id, bundleID: "com.apple.Terminal", appName: "Terminal", role: .terminal, kind: .terminal, group: id,
                     title: "Work \(id)", detail: "~/code", activity: activity)
        i.notice = notice
        i.workspace = workspace
        return i
    }

    func testTheOnesThatNeedYouComeFirstInTheOrderTheyAsked() {
        let a = BarAgents(items: [item("1", .working), item("2", .waiting, notice: "Asks to run a command", workspace: 4),
                                  item("3", .shell), item("4", .waiting)], unseen: ["4", "2"])
        XCTAssertEqual(a.rows.map(\.id), ["4", "2", "1"])
        XCTAssertEqual(a.rows.map(\.needsYou), [true, true, false])
        XCTAssertEqual(a.rows.map(\.detail), ["Terminal · ~/code", "Asks to run a command", "Terminal · ~/code"])
        XCTAssertEqual(a.rows[1].workspace, 4)
        XCTAssertEqual(a.label, "2 agents need you, 1 working")
    }

    /// Flagged while its title still says it works (`polycarp-spaces notify`), it is counted once, as needing you.
    func testAnAgentIsCountedOnce() {
        let a = BarAgents(items: [item("1", .working)], unseen: ["1"])
        XCTAssertEqual(a.needYou, 1)
        XCTAssertEqual(a.working, 0)
        XCTAssertEqual(a.label, "1 agent needs you")
    }

    /// A session that closed before you looked has no row to go to.
    func testAClosedSessionIsNotCounted() {
        XCTAssertEqual(BarAgents(items: [], unseen: ["gone"]), BarAgents())
        XCTAssertEqual(BarAgents().label, "No agents working")
        XCTAssertEqual(BarAgents(items: [item("1", .working)]).label, "1 agent working")
    }
}
