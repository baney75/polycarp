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
        XCTAssertEqual(DockTiles.make(current: 1, windows: [1: space1]).first?.apps.map(\.key), space1)
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

    func testWhileHoveringTheHeldOrderStaysAndAReplayIsOwed() {
        let held = DockAppOrder.held(proposed: ["b", "a", "c"], previous: ["a", "b", "c"], hovering: true)
        XCTAssertEqual(held.order, ["a", "b", "c"])
        XCTAssertTrue(held.replayOwed)
        XCTAssertFalse(DockAppOrder.held(proposed: ["a", "b"], previous: ["a", "b"], hovering: true).replayOwed)
    }

    func testWhenHoveringEndsTheProposedOrderIsUsed() {
        let shown = DockAppOrder.held(proposed: ["b", "a", "c"], previous: ["a", "b", "c"], hovering: false)
        XCTAssertEqual(shown.order, ["b", "a", "c"])
        XCTAssertFalse(shown.replayOwed)
    }

    func testAChangedSetOfAppsIsNeverHeld() {
        let shown = DockAppOrder.held(proposed: ["b", "a", "d"], previous: ["a", "b", "c"], hovering: true)
        XCTAssertEqual(shown.order, ["b", "a", "d"])
        XCTAssertFalse(shown.replayOwed)
        XCTAssertEqual(DockAppOrder.held(proposed: ["a"], previous: nil, hovering: true).order, ["a"])
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

/// ⌘Tab's workspace cards sort by `Spaces.activations`; the dock's tiles don't.
final class DockAppOrderWiringTests: XCTestCase {
    func testTheSwitcherSortsByUseAndTheDockByJoinOrder() throws {
        let dock = try Repo.code("Sources/BaneySpaces/WorkspaceDock.swift")
        // Donovan, 2026-11-16: the tile re-sorted after each switch, so his next click hit another app.
        XCTAssertFalse(dock.contains("activations"), "focus must not reorder the dock's tiles")
        XCTAssertTrue(dock.contains("joinOrder.update("), "the dock must keep each workspace's join order")
        XCTAssertTrue(dock.contains("joined: joinOrder"), "the dock's tiles must follow the join order")
        let switcher = try Repo.code("Sources/BaneySpaces/WorkspaceSwitcher.swift")
        XCTAssertTrue(switcher.contains("DockAppOrder.sort(keys, activatedAt: spaces.activations.on(n))"), "⌘Tab's cards still put the app used last first")
        let spaces = try Repo.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(spaces.contains("activations.note("), "focus must stamp the app")
        XCTAssertTrue(dock.contains("DockAppOrder.held("), "the dock must take its hold-still decision from the Core helper")
        XCTAssertTrue(dock.contains("onReplayOrder()"), "the pointer leaving a held tile must replay the order")
        XCTAssertTrue(dock.contains("model.onReplayOrder = { [weak self] in self?.reload() }"), "the replay must reload the dock")
    }
}
