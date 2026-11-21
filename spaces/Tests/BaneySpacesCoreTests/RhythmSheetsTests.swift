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

    func testACardBelongsToItsPromptAndDay() {
        let today = PurposeDay(year: 2026, month: 11, day: 21), yesterday = PurposeDay(year: 2026, month: 11, day: 20)
        typealias S = RhythmSheets
        XCTAssertEqual(S.step(due: .morningQuestion, showing: nil, shownOn: nil, today: today), .show(.morningQuestion))
        XCTAssertEqual(S.step(due: nil, showing: nil, shownOn: nil, today: today), .stay)
        // The morning card left alone all day gives way to the examen.
        XCTAssertEqual(S.step(due: .eveningExamen, showing: .morningQuestion, shownOn: today, today: today), .show(.eveningExamen))
        // Last night's examen goes at the new day, and the morning takes its place once it is due.
        XCTAssertEqual(S.step(due: nil, showing: .eveningExamen, shownOn: yesterday, today: today), .close)
        XCTAssertEqual(S.step(due: .morningQuestion, showing: .eveningExamen, shownOn: yesterday, today: today), .show(.morningQuestion))
        // One opened from the menu stays while nothing else is due.
        XCTAssertEqual(S.step(due: nil, showing: .eveningExamen, shownOn: today, today: today), .stay)
        XCTAssertEqual(S.step(due: .eveningExamen, showing: .eveningExamen, shownOn: today, today: today), .stay)
    }

    func testBothPromptsDueAtOnceShowOneAfterTheOther() {
        // The Mac opened at 7 pm: the morning comes first; once it is given, the examen is what is due.
        let today = PurposeDay(year: 2026, month: 11, day: 21)
        var showing: Rhythm.Prompt?
        for due in [Rhythm.Prompt.morningQuestion, .eveningExamen] {
            if case .show(let p) = RhythmSheets.step(due: due, showing: showing, shownOn: today, today: today) { showing = p }
            XCTAssertEqual(showing, due)
            showing = nil // given and closed
        }
    }

    func testReturnNeverKeepsACard() throws {
        let sheet = try SourceText.code("Sources/BaneySpaces/RhythmSheet.swift")
        XCTAssertFalse(sheet.contains(".defaultAction"), "Return moves down the card; the main button takes ⌘Return")
        XCTAssertEqual(sheet.components(separatedBy: ".keyboardShortcut(RhythmKeys.keep)").count, 3, "Begin and Keep")
        XCTAssertEqual(sheet.components(separatedBy: "close()\n        PurposeKeeper.shared.given(.morningQuestion)").count, 2,
                       "the card closes before `given` posts the next one")
    }
}
