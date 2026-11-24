import Foundation

/// When holding the Polycarp modifier means "show every shortcut": the modifier and nothing else, pressed from nothing,
/// held for `delay` with no key and no mouse button in between. Letting go, any other modifier, a key or a click puts
/// the sheet away. Pure, so the rules are tested without a keyboard; the app feeds it events and a timer.
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

    public init(modifier: Set<Mod>, delay: TimeInterval = 0.9) {
        self.modifier = modifier
        self.delay = delay
    }

    /// The modifier keys held now. Only a press that builds up to exactly the modifier from fewer keys counts, so
    /// letting go of ⇧ in ⌘⇧ (the tail of a chord) never starts the wait.
    public mutating func flags(_ now: Set<Mod>, at t: TimeInterval) -> Change {
        let before = held
        held = now
        if now == modifier, !modifier.isEmpty {
            if since == nil, !shown, before.isSubset(of: modifier), before != modifier { since = t }
            return .none
        }
        since = nil
        return hideIfShown()
    }

    /// Any key went down. With the modifier held that is a shortcut, not a look at the sheet.
    public mutating func key() -> Change {
        since = nil
        return hideIfShown()
    }

    /// A mouse button went down: a ⌘-click or a drag, never a look at the sheet.
    public mutating func mouse() -> Change {
        since = nil
        return hideIfShown()
    }

    /// The timer the app set for `delay` after the modifier went down came due.
    public mutating func tick(at t: TimeInterval) -> Change {
        guard !shown, let s = since, t - s >= delay, held == modifier else { return .none }
        since = nil
        shown = true
        return .show
    }

    /// The sheet went away on its own (another app took the screen, the launcher opened).
    public mutating func dismissed() {
        shown = false
        since = nil
    }

    /// Whether a wait is running, so the app knows to set its timer.
    public var waiting: Bool { since != nil }

    private mutating func hideIfShown() -> Change {
        guard shown else { return .none }
        shown = false
        return .hide
    }
}
