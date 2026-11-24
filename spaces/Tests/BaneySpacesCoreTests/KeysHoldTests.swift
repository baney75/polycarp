import BaneySpacesCore
import XCTest

final class KeysHoldTests: XCTestCase {
    private func hold(_ mods: Set<KeysHold.Mod> = [.command]) -> KeysHold { KeysHold(modifier: mods, delay: 0.9) }

    func testHoldingTheModifierAloneShowsTheSheetAndLettingGoHidesIt() {
        var h = hold()
        XCTAssertEqual(h.flags([.command], at: 0), .none)
        XCTAssertTrue(h.waiting)
        XCTAssertEqual(h.tick(at: 0.5), .none, "too soon")
        XCTAssertEqual(h.tick(at: 0.9), .show)
        XCTAssertTrue(h.shown)
        XCTAssertEqual(h.tick(at: 2), .none, "once")
        XCTAssertEqual(h.flags([], at: 3), .hide)
        XCTAssertFalse(h.shown)
    }

    func testAShortcutOrAClickBeforeTheDelayNeverShowsIt() {
        var h = hold()
        _ = h.flags([.command], at: 0)
        XCTAssertEqual(h.key(), .none, "⌘C")
        XCTAssertEqual(h.tick(at: 1), .none)

        h = hold()
        _ = h.flags([.command], at: 0)
        XCTAssertEqual(h.mouse(), .none, "⌘-click")
        XCTAssertEqual(h.tick(at: 1), .none)
    }

    func testAKeyOrAClickWhileShownHidesIt() {
        var h = hold()
        _ = h.flags([.command], at: 0)
        XCTAssertEqual(h.tick(at: 1), .show)
        XCTAssertEqual(h.key(), .hide, "⌘Tab after a long pause")
        XCTAssertEqual(h.flags([.command], at: 1.1), .none)
        XCTAssertEqual(h.tick(at: 3), .none, "the same press never shows it twice")

        h = hold()
        _ = h.flags([.command], at: 0)
        _ = h.tick(at: 1)
        XCTAssertEqual(h.mouse(), .hide)
    }

    func testAnotherModifierCancelsOrHides() {
        var h = hold()
        _ = h.flags([.command], at: 0)
        XCTAssertEqual(h.flags([.command, .shift], at: 0.3), .none)
        XCTAssertEqual(h.tick(at: 1), .none, "⌘⇧ is a chord")
        // Letting go of ⇧ leaves ⌘ alone, but that is the end of a chord, not a new press.
        XCTAssertEqual(h.flags([.command], at: 1.2), .none)
        XCTAssertFalse(h.waiting)
        XCTAssertEqual(h.tick(at: 3), .none)

        h = hold()
        _ = h.flags([.command], at: 0)
        _ = h.tick(at: 1)
        XCTAssertEqual(h.flags([.command, .option], at: 1.5), .hide)
    }

    func testATwoKeyModifierCountsWhenItsKeysGoDownOneByOne() {
        var h = hold([.control, .option])
        XCTAssertEqual(h.flags([.control], at: 0), .none)
        XCTAssertFalse(h.waiting, "half the modifier")
        XCTAssertEqual(h.flags([.control, .option], at: 0.1), .none)
        XCTAssertTrue(h.waiting)
        XCTAssertEqual(h.tick(at: 1.0), .show)
        XCTAssertEqual(h.flags([.control], at: 2), .hide)
    }

    func testTheWrongModifierNeverShowsIt() {
        var h = hold([.option])
        _ = h.flags([.command], at: 0)
        XCTAssertFalse(h.waiting)
        XCTAssertEqual(h.tick(at: 5), .none)
    }

    func testDismissedLetsTheNextPressShowItAgain() {
        var h = hold()
        _ = h.flags([.command], at: 0)
        _ = h.tick(at: 1)
        h.dismissed()
        XCTAssertFalse(h.shown)
        _ = h.flags([], at: 2)
        _ = h.flags([.command], at: 3)
        XCTAssertEqual(h.tick(at: 4), .show)
    }
}
