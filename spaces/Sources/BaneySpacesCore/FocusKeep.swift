import Foundation

/// R-F5: Polycarp applying the workspace you are on again (a rescan, a window coming back) must not hide or take focus
/// from a browser you just brought forward to follow it elsewhere. A link clicked in T3 Code brought Helium forward,
/// a rescan's re-apply hid Helium again, macOS handed focus back to T3 Code, and the follow to Helium's workspace never happened.
public enum FocusKeep {
    /// How long after an activation it still counts as just brought forward.
    public static let window: TimeInterval = 1.0

    /// Whether Polycarp's own re-apply of the workspace you are on leaves the app in front in front and unhidden, so
    /// it can be followed once the switch is done.
    /// - reapply: Polycarp applying the workspace you are on again on its own, never a switch you asked for.
    /// - frontIsBrowser: the app in front is a browser (R-F4): brought forward by a link you clicked, your choice.
    ///   Any other app that came forward on its own keeps R-F2: your window here is put back.
    /// - frontIsOurs: the app in front is Polycarp, or one Polycarp's own switch brought forward.
    /// - frontIsAgents: the app has a window on the agent workspace: an agent may have brought it forward (R-A1).
    /// - decided: Polycarp already decided where this activation goes (stay, put away, follow): the re-apply carries
    ///   that decision, as hiding an app macOS handed focus to does.
    /// - sinceActivation: seconds since the app in front came forward.
    /// - frontHasWindowHere: the app in front has a window on that workspace (then focusing it here is right).
    public static func keepsFront(reapply: Bool, frontIsBrowser: Bool, frontIsOurs: Bool, frontIsAgents: Bool,
                                  decided: Bool, sinceActivation: TimeInterval, frontHasWindowHere: Bool) -> Bool {
        reapply && frontIsBrowser && !frontIsOurs && !frontIsAgents && !decided && !frontHasWindowHere
            && sinceActivation >= 0 && sinceActivation < window
    }

    /// The apps a switch hides at once: every app with nothing here, except the one in front it hides last
    /// (`deferred`) and a browser it keeps in front (`kept`, R-F5). Hiding the kept one hands focus back to the app
    /// you clicked in.
    public static func hiddenNow(_ hideApps: Set<Int32>, deferred: Set<Int32>, kept: Set<Int32>) -> Set<Int32> {
        hideApps.subtracting(deferred).subtracting(kept)
    }
}
