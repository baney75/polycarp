import BaneySpacesCore
import XCTest

/// Finder answers slowly right after the launcher opens it and is benched for 5 s. A switch in that time left its new
/// window with no workspace: it rode along to the next workspace and joined it (2026-11-22 21:16, window 118609 dragged
/// back from 1 to 2 by hand), or, when Finder also had a window elsewhere, the switch hid Finder with the new window and
/// nothing showed it again.
final class UnansweredWindowsTests: XCTestCase {
    private let finder: Int32 = 93590, helium: Int32 = 84848

    func testAWindowOfAnAppThatDidNotAnswerIsHeld() {
        let held = UnansweredWindows.held(onScreen: [118609: finder, 5: helium], placed: [5], waiting: [], notWindows: [],
                                          unsure: [finder])
        XCTAssertEqual(held, [118609: finder])
    }

    func testOnlyUnansweredAppsPlacedNowhereAreHeld() {
        // Helium answered: an on-screen window it didn't list (an overlay) is left alone, as before.
        XCTAssertEqual(UnansweredWindows.held(onScreen: [7: helium], placed: [], waiting: [], notWindows: [], unsure: [finder]), [:])
        // Already on a workspace, already waiting, or a sheet the app listed: nothing to hold.
        XCTAssertEqual(UnansweredWindows.held(onScreen: [1: finder, 2: finder, 3: finder], placed: [1], waiting: [2], notWindows: [3],
                                              unsure: [finder]), [:])
    }

    func testAHeldWindowsAppHidesWithTheWorkspaceItWasSeenOn() {
        // Going from 2 to 1: Finder has no tracked window anywhere; its held window is on 2.
        let plan = SwitchPlan(hide: [11], show: [21], focus: 21)
        let how = Concealment(plan: plan, owner: [11: 1, 21: 2], alsoHidden: [finder])
        XCTAssertTrue(how.hideApps.contains(finder), "the new Finder window leaves with workspace 2 instead of staying in sight on 1")
        XCTAssertFalse(how.showApps.contains(finder))
    }

    func testAnAppKeptForAWindowHereIsNotHiddenForAHeldOne() {
        let plan = SwitchPlan(hide: [], show: [30], focus: 30)
        let how = Concealment(plan: plan, owner: [30: finder], alsoHidden: [finder])
        XCTAssertFalse(how.hideApps.contains(finder))
        let parked = Concealment(plan: SwitchPlan(hide: [], show: [], focus: nil), owner: [:], neverHidden: [finder], alsoHidden: [finder])
        XCTAssertFalse(parked.hideApps.contains(finder), "an app that's never hidden whole stays so")
    }

    func testAWindowLandingWhereYouAreWhileItsAppIsHiddenAppliesAgain() {
        // Finder had a window on 1, so the switch hid it whole; its new window lands on 2, where you are.
        XCTAssertTrue(UnansweredWindows.appliesAgain(workspaceShown: true, appHiddenByUs: true))
        // Landing out of sight, its app goes out of sight with it.
        XCTAssertTrue(UnansweredWindows.appliesAgain(workspaceShown: false, appHiddenByUs: false))
        XCTAssertFalse(UnansweredWindows.appliesAgain(workspaceShown: true, appHiddenByUs: false))
    }
}

/// Source checks for the wiring: they compile on any build, so they fail on one without it.
final class UnansweredWindowsWiringTests: XCTestCase {
    private func spaces() throws -> String { try SourceText.code("Sources/BaneySpaces/Spaces.swift") }

    func testASwitchHoldsUnansweredWindowsBeforeItPlans() throws {
        let plan = try XCTUnwrap(SourceText.block(after: "private func plan(_ n: Int, moveFocus: Bool)", in: spaces()))
        let hold = try XCTUnwrap(plan.range(of: "holdUnanswered()"), "a switch must hold the windows whose app didn't answer")
        let make = try XCTUnwrap(plan.range(of: "model.switchTo(n)"))
        XCTAssertLessThan(hold.lowerBound, make.lowerBound, "held before the plan is made, on the workspace being left")
        let body = try XCTUnwrap(SourceText.block(after: "private func holdUnanswered()", in: spaces()))
        XCTAssertTrue(body.contains("pendingLayout[id]"), "a held window waits in pendingLayout like a saved one")
    }

    func testTheSwitchHidesTheAppOfAWindowHeldElsewhere() throws {
        let apply = try XCTUnwrap(SourceText.block(after: "private func apply(_ plan: SwitchPlan, moveFocus: Bool = true)", in: spaces()))
        XCTAssertTrue(apply.contains("alsoHidden:"), "Concealment must hide the app of a window held for a workspace not shown")
    }

    func testAWaitingWindowThatLandsWhereYouAreBringsItsHiddenAppBack() throws {
        let scan = try XCTUnwrap(SourceText.block(after: "private func applyScan(_ plan: ScanStart", in: spaces()))
        XCTAssertTrue(scan.contains("UnansweredWindows.appliesAgain("),
                      "a waiting window landing on a shown workspace while its app is hidden must apply the workspace again")
    }
}
