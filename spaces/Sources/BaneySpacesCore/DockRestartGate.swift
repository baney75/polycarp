import CoreGraphics
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

    /// A process of this user: enough to find the Dock and a new Polycarp without starting a process every second.
    public struct Running: Equatable, Sendable {
        public var pid: Int32
        public var name: String
        public var started: Date?
        public init(pid: Int32, name: String, started: Date?) { self.pid = pid; self.name = name; self.started = started }
    }

    /// This user's processes, from the kernel. Another logged-in user's Dock isn't ours to age or restart.
    public static func runningProcesses() -> [Running] {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_UID, Int32(getuid())]
        var size = 0
        guard sysctl(&mib, 4, nil, &size, nil, 0) == 0, size > 0 else { return [] }
        // Room for processes that start between the two calls.
        size += 32 * MemoryLayout<kinfo_proc>.stride
        var list = [kinfo_proc](repeating: kinfo_proc(), count: size / MemoryLayout<kinfo_proc>.stride)
        guard sysctl(&mib, 4, &list, &size, nil, 0) == 0 else { return [] }
        return list.prefix(size / MemoryLayout<kinfo_proc>.stride).map { info in
            let name = withUnsafeBytes(of: info.kp_proc.p_comm) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
            let start = info.kp_proc.p_starttime
            return Running(pid: info.kp_proc.p_pid, name: name, started: start.tv_sec > 0 ? Date(timeIntervalSince1970: Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000) : nil)
        }
    }

    /// Whether a Polycarp other than the one that started this helper is running. It then owns the restart, through its own
    /// gate and its knowledge of workspace switches, and two restarts must not land together.
    public static func anotherAppOwnsIt(running: [Running], startedBy parent: Int32) -> Bool {
        running.contains { $0.name == "Polycarp" && $0.pid != parent }
    }

    /// The tool's whole life: wait for the gate, restart, exit. It waits as long as it takes, since someone can stay in a
    /// full-screen app for hours and a late setting beats a frozen screen.
    public static func run(names: Set<String>) -> Never {
        let parent = getppid()
        var seen: [Int] = []
        var lastChange = Date()
        while true {
            autoreleasepool {
                let running = runningProcesses()
                if anotherAppOwnsIt(running: running, startedBy: parent) { exit(0) }
                let spaces = DockSpaces.current()
                if spaces.ids != seen || spaces.animating { seen = spaces.ids; lastChange = Date() }
                let dock = running.first { $0.name == "Dock" }
                let uptime = DockRestartGate.uptime(dockRunning: dock != nil, started: dock?.started, lastKill: nil)
                let decision = DockRestartGate.decide(onFullScreenSpace: spaces.unsafe, switching: false, dockUptime: uptime, sinceSpaceChange: Date().timeIntervalSince(lastChange))
                if decision == .restartNow {
                    let kill = Process()
                    kill.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
                    kill.arguments = names.sorted()
                    kill.standardError = FileHandle.nullDevice
                    try? kill.run()
                    kill.waitUntilExit()
                    exit(0)
                }
            }
            Thread.sleep(forTimeInterval: 1)
        }
    }
}

/// What the window server says each display is showing, which needs no Accessibility and covers every display. Window sizes
/// can't answer this: a full-screen app behind a smaller window, on the other display or in Split View looks ordinary, and a
/// window maximized under the menu bar on a notched Mac looks full screen.
public enum DockSpaces {
    public struct State: Equatable, Sendable {
        /// A display is on anything but an ordinary desktop, or the window server didn't answer. Not knowing counts as unsafe.
        public var unsafe: Bool
        /// A display's Space is moving now.
        public var animating: Bool
        /// The Space each display shows. A change means a slide has happened.
        public var ids: [Int]
    }

    /// `displays` is `CGSCopyManagedDisplaySpaces`' answer. Type 0 is a desktop; 4 is full screen, Split View included.
    public static func parse(displays: [[String: Any]], isAnimating: (String) -> Bool) -> State {
        var state = State(unsafe: displays.isEmpty, animating: false, ids: [])
        for display in displays {
            guard let current = display["Current Space"] as? [String: Any], let type = current["type"] as? Int else {
                state.unsafe = true
                continue
            }
            if type != 0 { state.unsafe = true }
            state.ids.append(current["id64"] as? Int ?? current["ManagedSpaceID"] as? Int ?? -1)
            if let id = display["Display Identifier"] as? String, isAnimating(id) { state.animating = true }
        }
        return state
    }

    private typealias Connection = @convention(c) () -> Int32
    private typealias CopySpaces = @convention(c) (Int32) -> Unmanaged<CFArray>?
    private typealias IsAnimating = @convention(c) (Int32, CFString) -> Bool
    private static let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)

    public static func current() -> State {
        guard let skyLight, let c = dlsym(skyLight, "SLSMainConnectionID"), let copy = dlsym(skyLight, "SLSCopyManagedDisplaySpaces") else {
            return State(unsafe: true, animating: false, ids: [])
        }
        let connection = unsafeBitCast(c, to: Connection.self)()
        let animating = dlsym(skyLight, "SLSManagedDisplayIsAnimating").map { unsafeBitCast($0, to: IsAnimating.self) }
        let displays = unsafeBitCast(copy, to: CopySpaces.self)(connection)?.takeRetainedValue() as? [[String: Any]] ?? []
        return parse(displays: displays) { animating?(connection, $0 as CFString) ?? false }
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
