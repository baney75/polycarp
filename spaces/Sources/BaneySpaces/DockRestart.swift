import AppKit
import BaneySpacesCore

/// The one way to restart the Dock or another system process that applies a changed setting. See `DockRestartGate` for why
/// it can't just happen. A request waits for a safe moment; requests made while waiting become one restart.
enum DockRestart {
    /// A workspace switch is running.
    static var isSwitching: () -> Bool = { false }
    private static var pending = Set<String>()
    private static var timer: Timer?
    private static var lastReason: DockRestartGate.Reason?

    /// `processes` are names for killall, such as "Dock".
    static func request(_ processes: Set<String> = ["Dock"]) {
        guard Thread.isMainThread else { return DispatchQueue.main.async { request(processes) } }
        pending.formUnion(processes)
        try_()
        guard !pending.isEmpty, timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in try_() }
    }

    /// For a quit, when there's no later: only the settle check is waived by the caller's own timing, and the process ends
    /// right after. Everything else uses `request`.
    static func now(_ processes: Set<String> = ["Dock"]) {
        kill(processes)
    }

    private static func try_() {
        let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first
        let uptime = dock?.launchDate.map { Date().timeIntervalSince($0) }
        switch DockRestartGate.decide(onFullScreenSpace: Windows.onFullScreenSpace(), switching: isSwitching(), dockUptime: uptime) {
        case .wait(let reason):
            if reason != lastReason { Trace.log("dock restart: waiting, \(reason.rawValue)") }
            lastReason = reason
        case .restartNow:
            let names = pending
            pending = []
            lastReason = nil
            timer?.invalidate()
            timer = nil
            kill(names)
            Trace.log("dock restart: \(names.sorted().joined(separator: ", "))")
        }
    }

    private static func kill(_ names: Set<String>) {
        guard !names.isEmpty else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
        process.arguments = names.sorted()
        try? process.run()
    }
}
