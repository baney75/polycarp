import Foundation

/// When it's safe to restart the macOS Dock, which is how a changed Dock setting takes effect. The Dock runs Space
/// transitions, so killing it while one is showing can leave the screen frozen mid-slide: half of one desktop, a black gap,
/// no menu bar. That froze Donovan's Mac on 2026-11-06, when an install restarted the Dock twice in three seconds with a
/// full-screen app in front. So a restart waits for an ordinary desktop, an idle switch and a Dock that has settled.
public enum DockRestartGate {
    /// A Dock younger than this may still be finishing its own start.
    public static let settleSeconds: TimeInterval = 3
    /// A Space that changed this recently may still be sliding.
    public static let spaceQuietSeconds: TimeInterval = 2

    public enum Decision: Equatable {
        case restartNow
        case wait(Reason)
    }

    public enum Reason: String, Equatable {
        case fullScreenShowing, switching, dockJustStarted, spaceJustChanged
    }

    /// How long the Dock has been up, for `decide`. Nil only when no Dock is running. A running Dock of unknown age counts as
    /// settled: this wait must always be able to end. `started` comes from `processStart`, because launchd starts the Dock and
    /// `NSRunningApplication.launchDate` is nil for it. Using that left every restart waiting forever (2026-11-06).
    public static func uptime(dockRunning: Bool, started: Date?, lastKill: Date?, now: Date = Date()) -> TimeInterval? {
        guard dockRunning else { return nil }
        return [started, lastKill].compactMap { $0 }.map { now.timeIntervalSince($0) }.min() ?? .infinity
    }

    /// When a process started, from the kernel, which knows for every process.
    public static func processStart(pid: Int32) -> Date? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let start = info.kp_proc.p_starttime
        guard start.tv_sec > 0 else { return nil }
        return Date(timeIntervalSince1970: Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000)
    }

    /// `dockUptime` nil means no Dock is running yet: it's between restarts, so that counts as just started.
    public static func decide(onFullScreenSpace: Bool, switching: Bool, dockUptime: TimeInterval?, sinceSpaceChange: TimeInterval = .infinity) -> Decision {
        if onFullScreenSpace { return .wait(.fullScreenShowing) }
        if switching { return .wait(.switching) }
        if sinceSpaceChange < spaceQuietSeconds { return .wait(.spaceJustChanged) }
        guard let dockUptime, dockUptime >= settleSeconds else { return .wait(.dockJustStarted) }
        return .restartNow
    }
}

public enum DockRestartHelper {
    /// `Polycarp --restart-when-safe Dock,...` waits for the gate, restarts those, and exits. A quit starts it, so a restart
    /// the quit owes still goes through the gate after the app has gone.
    public static let argument = "--restart-when-safe"
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
