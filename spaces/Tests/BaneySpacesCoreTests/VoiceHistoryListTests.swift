import XCTest
@testable import BaneySpacesCore

final class VoiceHistoryListTests: XCTestCase {
    /// The old list stopped at 30 rows (and the engine asked for 200); now every item is reachable a page at a time.
    func testEveryItemIsReachableAPageAtATime() {
        XCTAssertEqual(VoiceHistoryList.shown(total: 10, pages: 1), 10)
        XCTAssertEqual(VoiceHistoryList.shown(total: 480, pages: 1), 50)
        XCTAssertEqual(VoiceHistoryList.more(total: 480, shown: 50), "Show 50 more")
        XCTAssertEqual(VoiceHistoryList.shown(total: 480, pages: 10), 480)
        XCTAssertEqual(VoiceHistoryList.more(total: 480, shown: 450), "Show 30 more")
        XCTAssertNil(VoiceHistoryList.more(total: 480, shown: 480))
        XCTAssertEqual(VoiceHistoryList.shown(total: 0, pages: 0), 0)
    }

    func testTheEngineLoadsAllOfHistory() throws {
        let engine = try Repo.code("Sources/BaneySpaces/Voice/VoiceEngine.swift")
        XCTAssertTrue(engine.contains("pc_history_get(core, 0)"))
        XCTAssertFalse(engine.contains("pc_history_get(core, 200)"))
        XCTAssertFalse(try Repo.code("Sources/BaneySpaces/Voice/VoiceSettingsView.swift").contains("prefix(30)"))
    }

    func testLongDictationsCanBeExpanded() {
        XCTAssertFalse(VoiceHistoryList.isLong("Short note."))
        XCTAssertTrue(VoiceHistoryList.isLong(String(repeating: "word ", count: 40)))
        XCTAssertTrue(VoiceHistoryList.isLong("Line one\nline two"))
    }

    func testClearAsksAndSaysHowMany() {
        XCTAssertEqual(VoiceHistoryList.clearTitle(count: 1), "Clear the 1 dictation in History?")
        XCTAssertEqual(VoiceHistoryList.clearTitle(count: 12), "Clear all 12 dictations in History?")
        XCTAssertTrue(VoiceHistoryList.clearMessage.contains("can't be undone"))
    }

    func testEachRowsButtonsSayWhichDictationTheyActOn() {
        XCTAssertEqual(VoiceHistoryList.removeLabel("Meet at the north door at noon tomorrow please"), "Remove \u{201C}Meet at the north door at\u{2026}\u{201D}")
        XCTAssertEqual(VoiceHistoryList.copyLabel("Thanks"), "Copy \u{201C}Thanks\u{201D}")
        let view = try? Repo.code("Sources/BaneySpaces/Voice/VoiceSettingsView.swift")
        XCTAssertTrue(view?.contains("VoiceHistoryList.removeLabel") == true)
        XCTAssertTrue(view?.contains(".textSelection(.enabled)") == true)
        XCTAssertTrue(view?.contains("confirmationDialog") == true)
    }
}
