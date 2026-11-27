import XCTest
@testable import BaneySpacesCore

/// spec/tiling-speed.md R-TS1 and R-TS2, cases 1 to 10 and 64 to 67.
final class TileCausesTests: XCTestCase {
    private typealias C = TileCauses.Cause
    private func wrote(_ pid: Int32, _ workspace: Int, new: Bool = false) -> TileCauses.Wrote { .init(pid: pid, workspace: workspace, new: new) }

    func testCase1TheLineHasEveryMarkFromTheCause() {
        XCTAssertEqual(TileCauses.line(epoch: 1795726000, C(.key, at: 10), looked: 10.004, asked: 10.021, landed: 10.140, moves: 3),
                       "1795726000 tile=key looked=4 asked=21 landed=140 moves=3")
    }

    func testCase2ASupersededSettleHasNoLanded() {
        XCTAssertEqual(TileCauses.line(epoch: 1, C(.key, at: 10), looked: 10.004, asked: 10.021, landed: nil, moves: 3),
                       "1 tile=key looked=4 asked=21 landed=- moves=3")
    }

    func testCase3AFocusAloneMovesNothing() {
        var c = TileCauses()
        c.add(C(.key, at: 10))
        let a = c.answer(now: 10.006, wrote: [], focus: true)
        XCTAssertEqual(a, [C(.key, at: 10)])
        XCTAssertEqual(TileCauses.line(epoch: 1, a[0], looked: 10.006, asked: 10.006, landed: nil, moves: 0),
                       "1 tile=key looked=6 asked=6 landed=- moves=0")
        XCTAssertTrue(c.pending.isEmpty)
    }

    func testCase4And5ANewWindowIsAnsweredWithinThreeSeconds() {
        var c = TileCauses()
        c.add(C(.new, at: 10, pid: 7))
        var late = c
        XCTAssertEqual(c.answer(now: 12.9, wrote: [wrote(7, 1, new: true)]), [C(.new, at: 10, pid: 7)])
        XCTAssertEqual(late.answer(now: 13.1, wrote: [wrote(7, 1, new: true)]), [])
        XCTAssertTrue(late.pending.isEmpty, "dropped")
    }

    func testCase6AnotherAppsWindowDoesNotAnswerANewOne() {
        var c = TileCauses()
        c.add(C(.new, at: 10, pid: 7))
        XCTAssertEqual(c.answer(now: 10.1, wrote: [wrote(8, 1)]), [])
        XCTAssertEqual(c.answer(now: 10.1, wrote: [wrote(7, 1)]), [], "a window of pid 7 the engine had")
        XCTAssertEqual(c.pending.count, 1)
    }

    func testCase7And8ACloseIsAnsweredOnItsWorkspace() {
        var c = TileCauses()
        c.add(C(.close, at: 10, workspace: 2))
        XCTAssertEqual(c.answer(now: 10.1, wrote: [wrote(8, 3)]), [])
        XCTAssertEqual(c.answer(now: 10.2, wrote: [wrote(8, 2)]), [C(.close, at: 10, workspace: 2)])
    }

    func testCase9ASwitchWaitsOneSecond() {
        var c = TileCauses()
        c.add(C(.switch, at: 10))
        XCTAssertEqual(c.answer(now: 11.2, wrote: [wrote(8, 3)]), [])
        XCTAssertTrue(c.pending.isEmpty)
        c.add(C(.switch, at: 20))
        XCTAssertEqual(c.answer(now: 20.5, wrote: [wrote(8, 3)]), [C(.switch, at: 20)])
    }

    func testCase10OneLookAnswersSeveral() {
        var c = TileCauses()
        c.add(C(.new, at: 10, pid: 7))
        c.add(C(.close, at: 10.1, workspace: 2))
        XCTAssertEqual(c.answer(now: 10.2, wrote: [wrote(7, 2, new: true)]).count, 2)
    }

    /// Review of #859 (first-F1): switches with nothing tiling leave nothing behind.
    func testStaleCausesLeaveAsNewOnesCome() {
        var c = TileCauses()
        for i in 0..<100 { c.add(C(.switch, at: Double(i) * 2)) }
        XCTAssertEqual(c.pending.count, 1)
    }

    /// Donovan's timing.log, 2026-11-26: a switch whose look had nothing to write was answered by a close's write 0.6 s
    /// later, and by the next switch's write, so slow switch lines were someone else's.
    func testCase64ASwitchIsAnsweredOnlyOnItsWorkspace() {
        var c = TileCauses()
        c.add(C(.switch, at: 10, workspace: 3))
        XCTAssertEqual(c.answer(now: 10.1, wrote: [wrote(8, 2)]), [])
        XCTAssertEqual(c.answer(now: 10.2, wrote: [wrote(8, 3)]), [C(.switch, at: 10, workspace: 3)])
    }

    func testCase65ANewerSwitchReplacesAnEarlierOne() {
        var c = TileCauses()
        c.add(C(.switch, at: 10, workspace: 2))
        c.add(C(.switch, at: 10.4, workspace: 3))
        XCTAssertEqual(c.answer(now: 10.5, wrote: [wrote(8, 3)]), [C(.switch, at: 10.4, workspace: 3)])
        XCTAssertTrue(c.pending.isEmpty)
    }

    func testCase66ASwitchWhoseLookWroteNothingThereLeaves() {
        var c = TileCauses()
        c.add(C(.switch, at: 10, workspace: 3))
        c.add(C(.close, at: 10.05, workspace: 3))
        c.looked(shown: [3], wrote: [])
        XCTAssertEqual(c.pending, [C(.close, at: 10.05, workspace: 3)], "the close still waits for its look")
        XCTAssertEqual(c.answer(now: 10.6, wrote: [wrote(8, 3)]), [C(.close, at: 10.05, workspace: 3)])
    }

    func testCase67ALookWithTheWorkspaceOutOfSightKeepsTheSwitch() {
        var c = TileCauses()
        c.add(C(.switch, at: 10, workspace: 3))
        c.looked(shown: [1], wrote: [])
        c.looked(shown: [3], wrote: [wrote(8, 3)])
        XCTAssertEqual(c.answer(now: 10.1, wrote: [wrote(8, 3)]), [C(.switch, at: 10, workspace: 3)])
    }
}
