import Foundation

/// When it's safe to restart the macOS Dock, which is how a changed Dock setting takes effect. The Dock runs Space
/// transitions, so killing it while one is showing can leave the screen frozen mid-slide: half of one desktop, a black gap,
/// no menu bar. That froze Donovan's Mac on 2026-11-06, when an install restarted the Dock twice in three seconds with a
/// full-screen app in front. So a restart waits for an ordinary desktop, an idle switch and a Dock that has settled.
public enum DockRestartGate {
    /// A Dock younger than this may still be finishing its own start.
    public static let settleSeconds: TimeInterval = 3

    public enum Decision: Equatable {
        case restartNow
        case wait(Reason)
    }

    public enum Reason: String, Equatable {
        case fullScreenShowing, switching, dockJustStarted
    }

    public static func decide(onFullScreenSpace: Bool, switching: Bool, dockUptime: TimeInterval?) -> Decision {
        if onFullScreenSpace { return .wait(.fullScreenShowing) }
        if switching { return .wait(.switching) }
        if let dockUptime, dockUptime < settleSeconds { return .wait(.dockJustStarted) }
        return .restartNow
    }
}

/// How the next launch learns that this quit is only an install swapping the app. Nothing is restored then, so the Dock isn't
/// restarted at the quit and again at the launch.
public enum InstallHandoff {
    public static let key = "restartingForInstall"
    /// The longest a marker counts: one left behind by a failed install must not skip a real quit's restore later.
    public static let validSeconds: TimeInterval = 120

    public static func isCurrent(markedAt: TimeInterval?, now: TimeInterval) -> Bool {
        guard let markedAt else { return false }
        return now >= markedAt && now - markedAt < validSeconds
    }
}
