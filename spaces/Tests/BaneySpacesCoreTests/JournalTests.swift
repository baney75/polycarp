import XCTest
@testable import BaneySpacesCore

/// The examen kept as Markdown, one file a day, with the day's time at the end.
final class JournalTests: XCTestCase {
    private let day = PurposeFixture.day("2026-11-21")
    private let answers = [
        Journal.Answer(question: Rhythm.examenQuestions[0], text: "  The walk at noon.\n"),
        Journal.Answer(question: Rhythm.examenQuestions[1], text: ""),
    ]

    func testThePageHasTheAnswersAndTheDay() {
        let page = Journal.markdown(day: day, answers: answers, oneThing: "Finish the core", seconds: [3: 1500, 1: 7500, 2: 0],
                                    purposes: [1: "Write | edit", 3: "Mail"], clock: PurposeFixture.chicago)
        XCTAssertEqual(page, """
        # Examen, Saturday 2026-11-21

        The one thing: Finish the core

        ## What am I thankful for today?

        The walk at noon.

        ## Where did I will the one thing?

        _No answer._

        ## The day

        | Workspace | Purpose | Time |
        | --- | --- | --- |
        | 1 | Write \\| edit | 2 h 05 min |
        | 3 | Mail | 25 min |
        | Total | | 2 h 30 min |

        """)
    }

    func testADayWithNoTimeSaysSo() {
        let page = Journal.markdown(day: day, answers: [], oneThing: nil, seconds: [:], purposes: [:], clock: PurposeFixture.chicago)
        XCTAssertTrue(page.hasSuffix("## The day\n\nNo time recorded.\n"), page)
        XCTAssertFalse(page.contains("The one thing"))
    }

    func testDurations() {
        XCTAssertEqual(Journal.duration(59), "under a minute")
        XCTAssertEqual(Journal.duration(60), "1 min")
        XCTAssertEqual(Journal.duration(3599), "59 min")
        XCTAssertEqual(Journal.duration(3600), "1 h 00 min")
        XCTAssertEqual(Journal.duration(36000 + 300), "10 h 05 min")
    }

    func testOneFilePerDayInTheJournalFolder() throws {
        let support = PurposeFixture.folder()
        defer { try? FileManager.default.removeItem(at: support) }
        let url = try Journal.save(day: day, answers: answers, oneThing: nil, seconds: [1: 60], purposes: [:],
                                   clock: PurposeFixture.chicago, support: support)
        XCTAssertEqual(url.path, support.appendingPathComponent("Journal/2026-11-21.md").path)
        // Kept again the same evening: the page is rewritten, not doubled.
        try Journal.save(day: day, answers: [Journal.Answer(question: "Q", text: "Second")], oneThing: nil, seconds: [1: 120],
                         purposes: [:], clock: PurposeFixture.chicago, support: support)
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(text.contains("Second"))
        XCTAssertFalse(text.contains("The walk at noon"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: Journal.folder(in: support).path), ["2026-11-21.md"])
    }
}
