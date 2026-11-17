import Foundation

/// When a switch hands focus away, macOS picks an app to put in front on its own. That isn't the
/// person picking it, so `Spaces.followFocus` must not follow it to its workspace (#11).
///
/// Going to an empty workspace leaves nothing to focus and hides the app that was in front; hiding
/// the app in front makes macOS activate the next one in line (Finder, Ghostty), often one Spaces
/// had just hidden or parked. Following it pulled you back off the workspace you had just gone to.
/// Only parked apps were ignored before #11.
public enum HandOff {
    /// How long after a hand-off an app coming forward on its own is still macOS's pick.
    public static let window: TimeInterval = 0.5

    /// Whether a switch handed focus away: it moves focus and hides the app in front, leaves a parked
    /// app in front, or has no window to focus (an empty workspace).
    public static func handsOff(movesFocus: Bool, hidesFrontApp: Bool, leavesParkedFront: Bool, hasWindowToFocus: Bool) -> Bool {
        movesFocus && (hidesFrontApp || leavesParkedFront || !hasWindowToFocus)
    }

    /// An app with no window here came forward `sinceHandOff` seconds after the last hand-off (or the
    /// front app leaving). It's macOS's pick, not yours, when Spaces put it away: parked, or hidden by Spaces.
    public static func cameForwardOnItsOwn(parked: Bool, hiddenByUs: Bool, sinceHandOff: TimeInterval) -> Bool {
        (parked || hiddenByUs) && sinceHandOff < window
    }
}

/// An app open on another workspace, opened again here (its New Window key, the Dock, the launcher),
/// comes forward before its new window exists: Ghostty activated 54 ms before its window showed
/// (measured 10-13). `Spaces.followFocus` waits this long for a new window of the app before it takes
/// you to the app's old workspace; one that shows in time stays here and you stay with it (#11).
public enum NewWindowGrace {
    /// Long enough for Ghostty's 54 ms with room for a loaded Mac, short enough that a Dock click on
    /// an app elsewhere still feels immediate.
    public static let seconds: TimeInterval = 0.2
}
