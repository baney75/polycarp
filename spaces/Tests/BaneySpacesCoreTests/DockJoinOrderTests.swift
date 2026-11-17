import XCTest
@testable import BaneySpacesCore

/// Donovan, 2026-11-16 (donovan-bar-reorder-2026-11-16.mp4): workspace 1's tile read T3 Code,
/// Helium, Claude; he clicked Helium and it read Helium, T3 Code, Claude, so his next click on the
/// second icon opened T3 Code instead of Helium.
final class DockJoinOrderTests: XCTestCase {
    private let space1 = ["t3", "helium", "claude", "helium"]

    private func tile(_ joined: DockJoinOrder, _ windows: [Int: [String]], on n: Int = 1) -> [String] {
        DockTiles.make(current: n, windows: windows, joined: joined).first { $0.workspace == n }!.apps.map(\.key)
    }

    func testActivatingAppsInAnotherOrderNeverMovesTheTile() {
        var joined = DockJoinOrder()
        joined.update([1: space1])
        let first = tile(joined, [1: space1])
        XCTAssertEqual(first, ["t3", "helium", "claude"])
        // He clicks Helium, then Claude, then T3 Code; each switch reloads the dock, and the
        // focused app's window may now come first in the window list.
        for front in ["helium", "claude", "t3"] {
            let windows = [1: [front] + space1.filter { $0 != front }]
            joined.update(windows)
            XCTAssertEqual(tile(joined, windows), first, "after \(front) came forward")
        }
    }

    func testANewAppJoinsAtTheEndAndOneThatLeftDropsOut() {
        var joined = DockJoinOrder()
        joined.update([1: ["t3", "helium"]])
        joined.update([1: ["ghostty", "helium", "t3"]])
        XCTAssertEqual(joined.on(1), ["t3", "helium", "ghostty"])
        joined.update([1: ["ghostty", "t3"]])
        XCTAssertEqual(joined.on(1), ["t3", "ghostty"])
        // Helium comes back: it joins again, at the end.
        joined.update([1: ["helium", "ghostty", "t3"]])
        XCTAssertEqual(joined.on(1), ["t3", "ghostty", "helium"])
    }

    func testEachWorkspaceKeepsItsOwnOrder() {
        var joined = DockJoinOrder()
        joined.update([1: ["helium", "ghostty"], 2: ["ghostty", "helium"]])
        joined.update([1: ["ghostty", "helium"], 2: ["helium", "ghostty"]])
        XCTAssertEqual(joined.on(1), ["helium", "ghostty"])
        XCTAssertEqual(joined.on(2), ["ghostty", "helium"])
        // An app moved to workspace 2 joins its end there.
        joined.update([1: ["ghostty"], 2: ["ghostty", "helium", "claude"]])
        XCTAssertEqual(joined.on(2), ["ghostty", "helium", "claude"])
        // A workspace left empty forgets its order.
        joined.update([2: ["helium"]])
        XCTAssertEqual(joined.on(1), [])
    }

    func testAppsNotSeenYetFollowInWindowOrder() {
        var joined = DockJoinOrder()
        joined.update([1: ["b", "a"]])
        XCTAssertEqual(joined.arrange(["c", "a", "b"], on: 1), ["b", "a", "c"])
        XCTAssertEqual(DockJoinOrder().arrange(["c", "a"], on: 1), ["c", "a"])
    }

    /// The tile, its "+N" list and the label read one order, and an agent's app still moves into view.
    func testTheTileAndItsPlusNListShareTheJoinOrder() {
        let windows = [1: ["word", "obsidian", "t3", "silas", "grok", "grok"]]
        var joined = DockJoinOrder()
        joined.update(windows)
        let tile = DockTiles.make(current: 1, windows: windows, joined: joined)[0]
        let keys = tile.apps.map(\.key)
        XCTAssertEqual(keys, ["word", "obsidian", "t3", "silas", "grok"])
        XCTAssertEqual(tile.apps.last, .init(key: "grok", windows: 2))
        XCTAssertEqual(DockLabel.hidden(keys.count, shown: 3), 2)
        XCTAssertEqual(DockTiles.agentsInView(keys, flagged: ["grok"], shown: 3), ["word", "obsidian", "grok", "t3", "silas"])
    }
}
