import CoreGraphics
import Foundation

/// When holding the Polycarp modifier means "show every shortcut": the modifier and nothing else, built up from nothing,
/// held for `delay` with no key, no mouse button and no pointer movement in between, and not while Secure Event Input
/// hides the keys. Letting go, any other modifier (fn too), a key or a click puts the sheet away. Pure, so the rules
/// are tested without a keyboard; the app feeds it events and a timer.
public struct KeysHold {
    public enum Mod: Hashable, CaseIterable { case command, control, option, shift, function }

    public enum Change: Equatable { case none, show, hide }

    /// The modifier keys that make up the Polycarp modifier (⌘, or ⌃⌥, and so on).
    public let modifier: Set<Mod>
    /// How long the modifier is held alone before the sheet shows. Long enough that a pause before ⌘C or ⌘Tab
    /// doesn't open it.
    public let delay: TimeInterval
    public private(set) var shown = false

    /// When the modifier came to be held alone, if it still is and nothing else happened since.
    private var since: TimeInterval?
    private var held: Set<Mod> = []
    /// Something other than building up the modifier happened during this press (a key, a click, a move, another
    /// modifier, secure input): no wait starts again until every modifier key is let go.
    private var spent = false

    public init(modifier: Set<Mod>, delay: TimeInterval = 0.9) {
        self.modifier = modifier
        self.delay = delay
    }

    /// The modifier keys held now. Only a clean press counts: one that builds up to exactly the modifier from nothing,
    /// with no other modifier on the way, so letting go of ⇧ in ⌘⇧ (the tail of a chord) never starts the wait.
    /// `secure`: Secure Event Input is on, so keys pressed now never reach the app and the hold can't be told from a
    /// shortcut.
    public mutating func flags(_ now: Set<Mod>, at t: TimeInterval, secure: Bool = false) -> Change {
        let before = held
        held = now
        if now.isEmpty { spent = false }
        if !now.isSubset(of: modifier) { spent = true }
        if now == modifier, !modifier.isEmpty {
            if since == nil, !shown, !spent, !secure, before.isSubset(of: modifier), before != modifier { since = t }
            return .none
        }
        since = nil
        return hideIfShown()
    }

    /// Any key went down. With the modifier held, even part of it, that is a shortcut, not a look at the sheet.
    public mutating func key() -> Change {
        spendPress()
        return hideIfShown()
    }

    /// A mouse button went down: a ⌘-click or a drag, never a look at the sheet.
    public mutating func mouse() -> Change {
        spendPress()
        return hideIfShown()
    }

    /// The pointer moved: ⌘-hover, ⌥-hover to measure, a ⌘-drag. The wait ends; a sheet already up stays, since it
    /// never takes the mouse.
    public mutating func move() -> Change {
        spendPress()
        return .none
    }

    /// The timer the app set for `delay` after the modifier went down came due. With `secure` on, the press is spent
    /// instead: keys typed in a password field or a Secure Keyboard Entry terminal never reach the app.
    public mutating func tick(at t: TimeInterval, secure: Bool = false) -> Change {
        guard !shown, let s = since, t - s >= delay, held == modifier else { return .none }
        since = nil
        if secure {
            spent = true
            return .none
        }
        shown = true
        return .show
    }

    /// The sheet went away on its own (another app took the screen, the launcher opened). This press is spent.
    public mutating func dismissed() {
        shown = false
        spendPress()
    }

    /// Whether a wait is running, so the app knows to set its timer.
    public var waiting: Bool { since != nil }

    private mutating func spendPress() {
        since = nil
        if !held.isEmpty { spent = true }
    }

    private mutating func hideIfShown() -> Change {
        guard shown else { return .none }
        shown = false
        return .hide
    }

    /// The modifier keys an event's flags say are held, fn (Globe) included. Caps Lock, the keypad and help flags
    /// are not keys held.
    public static func mods(_ f: CGEventFlags) -> Set<Mod> {
        var out: Set<Mod> = []
        if f.contains(.maskCommand) { out.insert(.command) }
        if f.contains(.maskControl) { out.insert(.control) }
        if f.contains(.maskAlternate) { out.insert(.option) }
        if f.contains(.maskShift) { out.insert(.shift) }
        if f.contains(.maskSecondaryFn) { out.insert(.function) }
        return out
    }

    /// ⌘ and none of ⇧, ⌃ or ⌥, whatever Caps Lock, fn and the keypad flag say: the launcher's ⌘K test. NSEvent's
    /// modifier flags use the same bits, so the launcher passes `CGEventFlags(rawValue: UInt64(flags.rawValue))`.
    public static func commandOnly(_ f: CGEventFlags) -> Bool {
        f.intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift]) == .maskCommand
    }
}
