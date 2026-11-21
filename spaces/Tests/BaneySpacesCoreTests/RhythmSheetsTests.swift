import XCTest
@testable import BaneySpacesCore

/// The morning sheet and the evening examen (`RhythmSheets`): Donovan's picks, 2026-11-21, A in the morning and C at night.
final class RhythmSheetsTests: XCTestCase {
    func testTheMorningAsksAboutWorkspacesInUseOrNamedAndTheCurrentOne() {
        XCTAssertEqual(RhythmSheets.morningRows(inUse: [1, 4], named: [2: "Write"], current: 6), [1, 2, 4, 6])
        XCTAssertEqual(RhythmSheets.morningRows(inUse: [], named: [:], current: 3), [3])
        XCTAssertEqual(RhythmSheets.morningRows(inUse: [0, 10], named: [:], current: 1), [1], "only workspaces 1 to 9")
    }

    func testTheMorningStaysOneCardAndKeepsTheCurrentWorkspace() {
        let rows = RhythmSheets.morningRows(inUse: Set(1...9), named: [:], current: 9)
        XCTAssertEqual(rows.count, RhythmSheets.mostRows)
        XCTAssertEqual(rows, [1, 2, 3, 4, 5, 9])
        XCTAssertEqual(RhythmSheets.morningRows(inUse: Set(1...9), named: [:], current: 2), [1, 2, 3, 4, 5, 6])
    }

    func testTheExamenShowsWhereTheDayWentLongestFirst() {
        let rows = RhythmSheets.timeRows(seconds: [1: 7500, 2: 3480, 3: 2220, 4: 30], named: [1: "Gannon letter", 3: ""])
        XCTAssertEqual(rows.map(\.label), ["Gannon letter", "Workspace 2", "Workspace 3"], "under a minute is left out")
        XCTAssertEqual(rows.map(\.time), ["2 h 05 min", "58 min", "37 min"])
        XCTAssertEqual(rows[0].share, 1)
        XCTAssertEqual(rows[1].share, 3480.0 / 7500, accuracy: 0.0001)
        XCTAssertTrue(RhythmSheets.timeRows(seconds: [:], named: [:]).isEmpty)
        XCTAssertEqual(RhythmSheets.timeRows(seconds: Dictionary(uniqueKeysWithValues: (1...9).map { ($0, 600 * $0) }), named: [:]).count, 5)
    }

    func testTheExamenKeepsEveryQuestionAndTomorrowLast() {
        let a = RhythmSheets.answers(["The light", "", "  ", "Patience"], tomorrow: " Write to Paul ")
        XCTAssertEqual(a.map(\.question), Rhythm.examenQuestions + [RhythmSheets.tomorrowQuestion])
        XCTAssertEqual(a.map(\.text), ["The light", "", "", "Patience", "Write to Paul"])
        XCTAssertEqual(RhythmSheets.answers(["", "", "", ""], tomorrow: "").count, 4)
    }
}
