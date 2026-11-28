import Foundation

/// R-F5: a switch that applies the workspace you are on again (a rescan, a window coming back) must not take focus
/// from an app you just brought forward to follow it elsewhere. A link clicked in T3 Code brought Helium forward,
/// a rescan's re-apply focused T3 Code again, and the follow to Helium's workspace never happened.
public enum FocusKeep {
    /// How long after an activation it still counts as just brought forward.
    public static let window: TimeInterval = 1.0

    /// Whether a switch to the workspace already shown leaves focus where it is, so the app in front can be followed.
    /// - reapply: the switch targets the workspace you are on.
    /// - frontIsBrowser: the app in front is a browser (R-F4): brought forward by a link you clicked, your choice.
    ///   Any other app that came forward on its own keeps R-F2: your window here is put back.
    /// - frontIsOurs: the app in front is Polycarp, or one Polycarp's own switch brought forward.
    /// - sinceActivation: seconds since the app in front came forward.
    /// - frontHasWindowHere: the app in front has a window on that workspace (then focusing it here is right).
    public static func keepsFront(reapply: Bool, frontIsBrowser: Bool, frontIsOurs: Bool, sinceActivation: TimeInterval,
                                  frontHasWindowHere: Bool) -> Bool {
        reapply && frontIsBrowser && !frontIsOurs && !frontHasWindowHere && sinceActivation >= 0 && sinceActivation < window
    }
}
