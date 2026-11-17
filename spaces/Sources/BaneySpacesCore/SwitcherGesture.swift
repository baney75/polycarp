/// What each key of a ⌘Tab gesture does to the highlight, after the ⌘Tab that shows the switcher.
///
/// Holding Tab must never move the highlight: it opens the window bar of the app that's highlighted,
/// and letting go lands on that app. Until #6 every Tab press stepped on key-down, so a hold first
/// jumped to the next app and landed on the wrong one. In apps mode a press now waits: it steps when
/// Tab (or ⌘) comes up, and only if it never became a hold. Workspaces have no window bar, so a press
/// there steps at once. `WorkspaceSwitcher` takes every step from here.
public struct SwitcherGesture: Sendable {
    public enum Mode: Sendable { case apps, workspaces }
    public enum Effect: Equatable, Sendable {
        case none
        /// Move the highlight one card (true is forward).
        case step(forward: Bool)
        /// Tab was held: open or close the highlighted app's window bar.
        case hold
    }

    private var tab = TabHold()

    public init() {}

    /// The ⌘Tab that shows the switcher. Its highlight comes from `SwitcherSelection.first`, so there
    /// is no step to give; a hold of this press still opens the window bar.
    public mutating func begin(at t: Double) {
        tab.press(at: t)
    }

    /// A later Tab key-down (not a repeat) while the switcher shows.
    public mutating func press(forward: Bool, at t: Double, mode: Mode) -> Effect {
        guard mode == .apps else { return .step(forward: forward) }
        tab.press(at: t, forward: forward, deferStep: true)
        return .none
    }

    /// Tab still down at `t`, seen through a key repeat or the hold check: `.hold` once per press,
    /// once it has been down `TabHold.threshold`, and only in apps mode. Never a step.
    public mutating func held(at t: Double, mode: Mode) -> Effect {
        mode == .apps && tab.repeated(at: t) ? .hold : .none
    }

    /// Tab let go, ⌘ let go or Esc: the step a tap still owes, given once.
    public mutating func release() -> Effect {
        tab.release().map { .step(forward: $0) } ?? .none
    }
}
