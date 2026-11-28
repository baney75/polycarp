import BaneySpacesCore
import XCTest

/// Donovan, 2026-11-24: "windows randomly disappear also like word on mac". A switch skips a parked window whose app
/// doesn't answer; the app answering a moment later brought nothing back.
final class LeftAwayTests: XCTestCase {
    private let screens = [CGRect(x: 0, y: 0, width: 1512, height: 982)]
    private let parked = CGRect(x: 1511, y: 981, width: 1512, height: 950)
    private let home = CGRect(x: 0, y: 32, width: 1512, height: 950)

    private func away(_ ids: Set<WindowID>, shown: Set<WindowID>, frames: [WindowID: CGRect], minimized: Set<WindowID> = [],
                      tries: [WindowID: Int] = [:]) -> Set<WindowID> {
        LeftAway.windows(parked: ids, shown: shown, frames: frames, screens: screens, minimized: minimized, tries: tries)
    }

    func testAParkedWindowOnTheWorkspaceInSightIsLeftAway() {
        XCTAssertEqual(away([1], shown: [1], frames: [1: parked]), [1])
    }

    func testAWindowThatBelongsElsewhereOrIsHomeOrGoneIsNot() {
        XCTAssertEqual(away([1], shown: [], frames: [1: parked]), [], "parked on purpose")
        XCTAssertEqual(away([1], shown: [1], frames: [1: home]), [], "already in sight")
        XCTAssertEqual(away([1], shown: [1], frames: [:]), [], "closed")
        XCTAssertEqual(away([], shown: [1], frames: [1: parked]), [], "no record: not Polycarp's doing")
        XCTAssertEqual(away([1], shown: [1], frames: [1: parked], minimized: [1]), [])
    }

    func testAnAppThatRefusesEveryMoveIsTriedThreeTimes() {
        var tries: [WindowID: Int] = [:]
        for _ in 0..<LeftAway.most {
            XCTAssertEqual(away([1], shown: [1], frames: [1: parked], tries: tries), [1])
            tries = LeftAway.counted(tries, tried: [1], waiting: [1])
        }
        XCTAssertEqual(away([1], shown: [1], frames: [1: parked], tries: tries), [])
        // Home, or you left for another workspace: the next visit starts over.
        XCTAssertEqual(away([1], shown: [1], frames: [1: parked], tries: LeftAway.counted(tries, tried: [], waiting: [])), [1])
    }

    func testOnlyAnAppThatAnsweredThisScanBringsItsWindowsHome() {
        let owner: [WindowID: Int32] = [1: 10, 2: 20, 3: 30]
        XCTAssertEqual(LeftAway.ready([1, 2, 3], owner: owner, fresh: [10: true, 20: false]), [1], "20 missed, 30 wasn't asked")
        XCTAssertEqual(LeftAway.ready([1, 4], owner: owner, fresh: [20: true]), [])
    }

    func testTheTraceLineNamesTheApps() {
        XCTAssertEqual(LeftAway.line(apps: ["Microsoft Word", "Helium"], windows: 2, workspaces: [2], again: true),
                       "left away: 2 window(s) of Helium, Microsoft Word on workspace 2; brought home when they answer")
        XCTAssertEqual(LeftAway.line(apps: ["Word"], windows: 1, workspaces: [3, 1], again: false),
                       "left away: 1 window(s) of Word on workspace 1,3; out of tries until the next visit")
    }
}

/// Source checks for the wiring: they compile on any build, so they fail on one without it.
final class LeftAwayWiringTests: XCTestCase {
    private func block(_ marker: String) throws -> String {
        try XCTUnwrap(SourceText.block(after: marker, in: SourceText.code("Sources/BaneySpaces/Spaces.swift")))
    }

    func testASwitchLooksForWindowsItLeftAway() throws {
        XCTAssertTrue(try block("private func apply(_ plan: SwitchPlan, moveFocus: Bool = true, keep: pid_t? = nil)").contains("noteLeftAway()"))
        XCTAssertTrue(try block("private func noteLeftAway()").contains("scheduleRetry()"), "their apps are asked again")
        XCTAssertTrue(try block("private func scheduleRetry()").contains("leftAway()"), "the retry asks their apps, not only the unread ones")
    }

    func testAnAppThatAnswersBringsItsWindowHome() throws {
        let scan = try block("private func applyScan(_ plan: ScanStart")
        XCTAssertTrue(scan.contains("LeftAway.ready(away"))
        XCTAssertTrue(scan.contains("if back.count < away.count { scheduleRetry() }"), "one not asked yet keeps its turn")
        XCTAssertTrue(scan.contains("returned = returned || !back.isEmpty"), "the workspace applies again")
        XCTAssertTrue(scan.contains("LeftAway.counted("), "and the try is counted")
    }
}
