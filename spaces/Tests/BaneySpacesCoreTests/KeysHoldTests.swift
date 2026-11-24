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

    /// ⌘-hover deep-select, ⌥-hover to measure, a ⌘-drag: moving the pointer while the modifier is down is work, not a
    /// look at the sheet. A sheet already up stays up, since it never takes the mouse.
    func testMovingThePointerDuringTheWaitCancelsIt() {
        var h = hold()
        _ = h.flags([.command], at: 0)
        XCTAssertEqual(h.move(), .none)
        XCTAssertFalse(h.waiting, "⌘-hover")
        XCTAssertEqual(h.tick(at: 1), .none)
        XCTAssertEqual(h.flags([.command], at: 1.1), .none)
        XCTAssertEqual(h.tick(at: 3), .none, "still the same press")

        h = hold()
        _ = h.flags([.command], at: 0)
        _ = h.tick(at: 1)
        XCTAssertEqual(h.move(), .none, "a shown sheet stays up")
        XCTAssertTrue(h.shown)

        h = hold()
        XCTAssertEqual(h.move(), .none, "moving with nothing held")
        _ = h.flags([.command], at: 0)
        XCTAssertEqual(h.tick(at: 1), .show)
    }

    /// With Secure Event Input on (a password field, Secure Keyboard Entry, 1Password) the app sees the modifier but no
    /// keys, so a ⌘A then ⌘V would look like a lone hold.
    func testSecureInputNeverShowsIt() {
        var h = hold()
        XCTAssertEqual(h.flags([.command], at: 0, secure: true), .none)
        XCTAssertFalse(h.waiting, "secure when the hold starts")
        XCTAssertEqual(h.tick(at: 1), .none)

        h = hold()
        _ = h.flags([.command], at: 0)
        XCTAssertTrue(h.waiting)
        XCTAssertEqual(h.tick(at: 1, secure: true), .none, "secure when the timer fires")
        XCTAssertFalse(h.shown)
        XCTAssertEqual(h.tick(at: 2), .none, "and that press is spent")

        _ = h.flags([], at: 3)
        _ = h.flags([.command], at: 4)
        XCTAssertEqual(h.tick(at: 5), .show, "the next press, out of secure input, shows it")
    }

    /// ⌃C with ⌃⌥ as the modifier, C let go, then ⌥ added: the press already made a shortcut, so the full modifier
    /// starts no wait until every key is let go.
    func testAKeyDuringAPartialPressSpendsTheWholePress() {
        var h = hold([.control, .option])
        _ = h.flags([.control], at: 0)
        XCTAssertEqual(h.key(), .none, "⌃C")
        XCTAssertEqual(h.flags([.control, .option], at: 0.2), .none)
        XCTAssertFalse(h.waiting)
        XCTAssertEqual(h.tick(at: 2), .none)

        h = hold([.control, .option])
        _ = h.flags([.control], at: 0)
        XCTAssertEqual(h.mouse(), .none, "⌃-click")
        _ = h.flags([.control, .option], at: 0.2)
        XCTAssertFalse(h.waiting)

        // Everything let go, then a clean press: it counts again.
        _ = h.flags([], at: 1)
        _ = h.flags([.control], at: 1.1)
        _ = h.flags([.control, .option], at: 1.2)
        XCTAssertTrue(h.waiting)
        XCTAssertEqual(h.tick(at: 2.2), .show)
    }

    /// ⇧ then ⇧ let go on the way to ⌃⌥ is a chord, not a clean build-up.
    func testAnotherModifierOnTheWaySpendsThePress() {
        var h = hold([.control, .option])
        _ = h.flags([.control, .shift], at: 0)
        _ = h.flags([.control], at: 0.1)
        _ = h.flags([.control, .option], at: 0.2)
        XCTAssertFalse(h.waiting)
        XCTAssertEqual(h.tick(at: 2), .none)
    }

    /// Fn (Globe) held before the modifier, pressed during the wait, or pressed with the sheet up.
    func testFnCancelsOrHides() {
        XCTAssertEqual(KeysHold.mods([.maskCommand, .maskSecondaryFn]), [.command, .function])
        XCTAssertEqual(KeysHold.mods([.maskCommand, .maskAlphaShift, .maskNumericPad]), [.command], "Caps Lock is not a key held")

        var h = hold()
        _ = h.flags(KeysHold.mods(.maskSecondaryFn), at: 0)
        _ = h.flags(KeysHold.mods([.maskSecondaryFn, .maskCommand]), at: 0.1)
        _ = h.flags(KeysHold.mods(.maskCommand), at: 0.2)
        XCTAssertFalse(h.waiting, "fn held first")
        XCTAssertEqual(h.tick(at: 2), .none)

        h = hold()
        _ = h.flags(KeysHold.mods(.maskCommand), at: 0)
        XCTAssertTrue(h.waiting)
        _ = h.flags(KeysHold.mods([.maskCommand, .maskSecondaryFn]), at: 0.3)
        XCTAssertFalse(h.waiting, "fn during the wait")
        XCTAssertEqual(h.tick(at: 2), .none)

        h = hold()
        _ = h.flags(KeysHold.mods(.maskCommand), at: 0)
        XCTAssertEqual(h.tick(at: 1), .show)
        XCTAssertEqual(h.flags(KeysHold.mods([.maskCommand, .maskSecondaryFn]), at: 1.5), .hide, "fn with the sheet up")
    }

    /// The launcher or the overview took the screen with the modifier still down: no wait starts again until every
    /// key is let go, even when a two-key modifier is let go of in part and pressed again.
    func testDismissedWhileHeldSpendsThePress() {
        var h = hold([.control, .option])
        _ = h.flags([.control, .option], at: 0)
        _ = h.tick(at: 1)
        h.dismissed()
        _ = h.flags([.control], at: 1.5)
        _ = h.flags([.control, .option], at: 1.6)
        XCTAssertFalse(h.waiting)
        XCTAssertEqual(h.tick(at: 3), .none)
    }

    /// ⌘K in the launcher: Caps Lock, the keypad and fn flags don't matter; ⇧, ⌃ and ⌥ do.
    func testLauncherCommandKIgnoresCapsLockAndNonModifierFlags() {
        XCTAssertTrue(KeysHold.commandOnly(.maskCommand))
        XCTAssertTrue(KeysHold.commandOnly([.maskCommand, .maskAlphaShift]), "Caps Lock on")
        XCTAssertTrue(KeysHold.commandOnly([.maskCommand, .maskNumericPad, .maskSecondaryFn, .maskHelp]))
        XCTAssertFalse(KeysHold.commandOnly([.maskCommand, .maskShift]))
        XCTAssertFalse(KeysHold.commandOnly([.maskCommand, .maskControl]))
        XCTAssertFalse(KeysHold.commandOnly([.maskCommand, .maskAlternate]))
        XCTAssertFalse(KeysHold.commandOnly([]))
        XCTAssertFalse(KeysHold.commandOnly(.maskAlphaShift))
    }
}
