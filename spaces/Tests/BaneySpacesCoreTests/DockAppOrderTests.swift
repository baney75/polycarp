import XCTest
@testable import BaneySpacesCore

final class DockAppOrderTests: XCTestCase {
    /// Workspace 1 on 2026-11-01, 4:15 PM, in its windows' order.
    private let space1 = ["word", "obsidian", "t3", "silas", "grok"]

    func testTheAppUsedLastComesFirst() {
        var used = AppActivations()
        used.note("obsidian", on: 1, at: 10)
        used.note("grok", on: 1, at: 30)
        used.note("word", on: 1, at: 20)
        XCTAssertEqual(DockAppOrder.sort(space1, activatedAt: used.on(1)), ["grok", "word", "obsidian", "t3", "silas"])
    }

    func testTheOrderChangesWhenAnotherAppComesForward() {
        var used = AppActivations()
        used.note("grok", on: 1, at: 30)
        used.note("silas", on: 1, at: 20)
        XCTAssertEqual(DockAppOrder.sort(space1, activatedAt: used.on(1)).prefix(2), ["grok", "silas"])
        used.note("silas", on: 1, at: 40)
        XCTAssertEqual(DockAppOrder.sort(space1, activatedAt: used.on(1)).prefix(2), ["silas", "grok"])
        // Coming forward again, Grok Bot takes the front back.
        used.note("grok", on: 1, at: 50)
        XCTAssertEqual(DockAppOrder.sort(space1, activatedAt: used.on(1)).prefix(2), ["grok", "silas"])
    }

    /// Apps never used on the workspace keep their windows' order, after the ones that were.
    func testAppsNeverUsedThereKeepTheirWindowOrder() {
        XCTAssertEqual(DockAppOrder.sort(space1, activatedAt: [:]), space1)
        var used = AppActivations()
        used.note("t3", on: 1, at: 5)
        XCTAssertEqual(DockAppOrder.sort(space1, activatedAt: used.on(1)), ["t3", "word", "obsidian", "silas", "grok"])
        // Two used at the same moment keep their windows' order too.
        XCTAssertEqual(DockAppOrder.sort(space1, activatedAt: ["grok": 5, "obsidian": 5]), ["obsidian", "grok", "word", "t3", "silas"])
    }

    func testUsingAnAppOnOneWorkspaceLeavesAnotherAlone() {
        var used = AppActivations()
        used.note("ghostty", on: 2, at: 1)
        used.note("helium", on: 2, at: 2)
        used.note("ghostty", on: 1, at: 3)
        XCTAssertEqual(DockAppOrder.sort(["helium", "ghostty"], activatedAt: used.on(1)), ["ghostty", "helium"])
        XCTAssertEqual(DockAppOrder.sort(["ghostty", "helium"], activatedAt: used.on(2)), ["helium", "ghostty"])
    }

    func testAnAppThatQuitLosesItsPlace() {
        var used = AppActivations()
        used.note("4242", on: 1, at: 9)
        used.note("4242", on: 3, at: 9)
        used.forget("4242")
        XCTAssertTrue(used.on(1).isEmpty)
        XCTAssertTrue(used.on(3).isEmpty)
    }
}

/// ⌘Tab's workspace cards sort by `Spaces.activations`.
final class DockAppOrderWiringTests: XCTestCase {
    func testTheSwitcherSortsByUse() throws {
        let switcher = try Repo.code("Sources/BaneySpaces/WorkspaceSwitcher.swift")
        XCTAssertTrue(switcher.contains("DockAppOrder.sort(keys, activatedAt: spaces.activations.on(n))"), "⌘Tab's cards still put the app used last first")
        let spaces = try Repo.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(spaces.contains("activations.note("), "focus must stamp the app")
    }
}
