import AppKit
import BaneySpacesCore

/// The one way to restart the Dock or another system process that applies a changed setting. See `DockRestartGate` for why
/// it can't just happen. A request waits for a safe moment; requests made while waiting become one restart.
enum DockRestart {
    /// A workspace switch is running.
    static var isSwitching: () -> Bool = { false }
    /// Set first thing in `applicationWillTerminate`.
    static var isQuitting = false
    private static var pending = Set<String>()
    private static var timer: Timer?
    private static var lastReason: DockRestartGate.Reason?
    private static var lastKill: Date?
    private static var lastSpaceChange: Date?
    private static var spaceObserver: NSObjectProtocol?

    /// `processes` are names for killall, such as "Dock".
    static func request(_ processes: Set<String> = ["Dock"]) {
        guard Thread.isMainThread else { return DispatchQueue.main.async { request(processes) } }
        watchSpaces()
        pending.formUnion(processes)
        // Quitting: only collect. `handOffBeforeQuit` takes them all as one.
        if isQuitting { return }
        try_()
        guard !pending.isEmpty, timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in try_() }
    }

    /// The app is quitting, so what's owed can't wait here: a small copy of this program takes it over, waits for the same
    /// gate and exits. Whatever else asks during the quit joins it.
    static func handOffBeforeQuit() {
        timer?.invalidate()
        timer = nil
        guard !pending.isEmpty, let exe = Bundle.main.executableURL else { return }
        let helper = Process()
        helper.executableURL = exe
        helper.arguments = [DockRestartHelper.argument, pending.sorted().joined(separator: ",")]
        helper.standardOutput = FileHandle.nullDevice
        helper.standardError = FileHandle.nullDevice
        do {
            try helper.run()
            pending = []
        } catch {
            // No helper: the settings are saved, and the Dock reads them next time it starts. A frozen screen is the worse risk.
            Trace.log("dock restart: couldn't start the helper, \(error)")
            pending = []
        }
    }

    /// The helper's whole life: wait for the gate, restart, exit.
    static func runHelper(_ names: Set<String>) -> Never {
        watchSpaces()
        // It can't know what the app saw just before quitting, so it starts by assuming a Space just changed. It waits as long
        // as it takes: someone can stay in a full-screen app for hours, and a late setting beats a frozen screen.
        lastSpaceChange = Date()
        pending = names
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            try_()
            if pending.isEmpty { exit(0) }
        }
        RunLoop.main.run()
        exit(0)
    }

    /// A Space that just changed may still be sliding.
    static func watchSpaces() {
        guard spaceObserver == nil else { return }
        spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in
            lastSpaceChange = Date()
        }
    }

    private static func try_() {
        let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first
        // Until the old Dock has actually gone, its start reads as settled, so our own last restart counts too.
        let uptime = DockRestartGate.uptime(dockRunning: dock != nil, started: dock.flatMap { DockRestartGate.processStart(pid: $0.processIdentifier) }, lastKill: lastKill)
        let quiet = lastSpaceChange.map { Date().timeIntervalSince($0) } ?? .infinity
        switch DockRestartGate.decide(onFullScreenSpace: Windows.onFullScreenSpace(), switching: isSwitching(), dockUptime: uptime, sinceSpaceChange: quiet) {
        case .wait(let reason):
            if reason != lastReason { Trace.log("dock restart: waiting, \(reason.rawValue)") }
            lastReason = reason
        case .restartNow:
            let names = pending
            pending = []
            lastReason = nil
            timer?.invalidate()
            timer = nil
            lastKill = Date()
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
