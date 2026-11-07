import AppKit
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
    /// `polycarp-spaces --restart-when-safe Dock,...` waits for the gate, restarts those, and exits. A quit starts it, so a
    /// restart owed when the app quits still happens once it's safe. It has to be the command-line tool: a process running the
    /// app's own executable makes macOS answer `open` with error -600 for as long as it lives, so Polycarp couldn't be started
    /// again while one waited (2026-11-06; reproduced in a throwaway bundle: the app's executable fails, a tool in
    /// Contents/Resources/bin doesn't).
    public static let argument = "--restart-when-safe"

    /// Where the tool is, from the app's bundle.
    public static func tool(inBundle bundle: URL) -> URL {
        bundle.appendingPathComponent("Contents/Resources/bin/polycarp-spaces")
    }

    /// Whether the front window fills a display the way a full-screen one does. `frames` are in window-list coordinates. The
    /// tool can't ask Accessibility, so this is what it has.
    public static func looksFullScreen(top: CGRect?, frames: [CGRect]) -> Bool {
        guard let top else { return false }
        return frames.contains { abs($0.minX - top.minX) < 1 && abs($0.minY - top.minY) < 1 && abs($0.width - top.width) < 1 && abs($0.height - top.height) < 1 }
    }

    /// Every display's whole frame, and on a display with a notch the part below it, where a full-screen window sits.
    private static func fullScreenFrames() -> [CGRect] {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSScreen.screens.flatMap { screen -> [CGRect] in
            let f = CGRect(x: screen.frame.minX, y: primaryHeight - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
            let notch = screen.safeAreaInsets.top
            return notch > 0 ? [f, CGRect(x: f.minX, y: f.minY + notch, width: f.width, height: f.height - notch)] : [f]
        }
    }

    private static func dockPid() -> Int32? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        p.arguments = ["-x", "Dock"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8)?.split(separator: "\n").first.flatMap { Int32($0) }
    }

    /// The tool's whole life: wait for the gate, restart, exit. It waits as long as it takes, since someone can stay in a
    /// full-screen app for hours and a late setting beats a frozen screen. It can't hear about a Space changing, so any change
    /// in what's on screen counts as one. That only ever makes it wait longer.
    public static func run(names: Set<String>) -> Never {
        var seen: [Int] = []
        var lastChange = Date()
        while true {
            let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
                .filter { ($0[kCGWindowLayer as String] as? Int) == 0 }
            let ids = windows.compactMap { $0[kCGWindowNumber as String] as? Int }
            if ids != seen { seen = ids; lastChange = Date() }
            let top = (windows.first?[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }
            let dock = dockPid()
            let uptime = DockRestartGate.uptime(dockRunning: dock != nil, started: dock.flatMap { DockRestartGate.processStart(pid: $0) }, lastKill: nil)
            let decision = DockRestartGate.decide(onFullScreenSpace: looksFullScreen(top: top, frames: fullScreenFrames()), switching: false, dockUptime: uptime, sinceSpaceChange: Date().timeIntervalSince(lastChange))
            if decision == .restartNow {
                let kill = Process()
                kill.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
                kill.arguments = names.sorted()
                kill.standardError = FileHandle.nullDevice
                try? kill.run()
                kill.waitUntilExit()
                exit(0)
            }
            Thread.sleep(forTimeInterval: 1)
        }
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
