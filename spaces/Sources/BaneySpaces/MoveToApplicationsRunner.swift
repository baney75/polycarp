import AppKit
import BaneySpacesCore

/// Opened from the disk image, Downloads or a temporary read-only place, Polycarp asks once to move itself to Applications
/// (`MoveToApplications` decides and words it). It runs before anything else starts, and it ends this process: either the
/// copy opens, or the person chose Quit, or a plain alert said it couldn't. Never run twice (the copy carries `--after-move`).
enum MoveToApplicationsRunner {
    static func runIfNeeded(home: URL) {
        let bundle = Bundle.main.bundleURL
        guard MoveToApplications.shouldAsk(arguments: CommandLine.arguments, bundle: bundle, home: home) else { return }
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        NSApp.activate(ignoringOtherApps: true)
        guard alert(MoveToApplications.askTitle, MoveToApplications.askDetail, buttons: [MoveToApplications.moveButton, MoveToApplications.quitButton]) else { exit(0) }

        let fm = FileManager.default
        let plan = MoveToApplications.plan(bundle: bundle, home: home, canWrite: { fm.isWritableFile(atPath: $0.path) })
        try? fm.createDirectory(at: plan.destination.deletingLastPathComponent(), withIntermediateDirectories: true)

        // A copy already there is replaced only after it has quit.
        if plan.replacesExisting {
            let running = NSRunningApplication.runningApplications(withBundleIdentifier: Product.bundleID)
                .filter { !$0.isTerminated && $0.bundleURL?.standardizedFileURL == plan.destination.standardizedFileURL }
            running.forEach { $0.terminate() }
            let deadline = Date().addingTimeInterval(MoveToApplications.waitForQuit)
            while running.contains(where: { !$0.isTerminated }) && Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
            if running.contains(where: { !$0.isTerminated }) {
                _ = alert(MoveToApplications.stillOpenTitle, MoveToApplications.stillOpenDetail, buttons: ["OK"])
                exit(0)
            }
        }

        // Copy beside the final place under another name, then swap, so a copy cut short never looks like the app.
        let temp = plan.destination.deletingLastPathComponent().appendingPathComponent(".\(Product.name)-moving.app")
        do {
            try? fm.removeItem(at: temp)
            try fm.copyItem(at: plan.source, to: temp)
            MoveToApplications.clearDownloadMark(at: temp)
            if plan.replacesExisting { try fm.trashItem(at: plan.destination, resultingItemURL: nil) }
            try fm.moveItem(at: temp, to: plan.destination)
        } catch {
            try? fm.removeItem(at: temp)
            _ = alert(MoveToApplications.failedTitle, MoveToApplications.failedDetail, buttons: ["OK"])
            exit(1)
        }

        // Open the copy, then let go of the disk image (from a process that outlives this one), then leave.
        let open = Process()
        open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        open.arguments = ["-n", plan.destination.path, "--args", MoveToApplications.movedFlag]
        try? open.run(); open.waitUntilExit()
        if let volume = plan.eject {
            let cmd = MoveToApplications.ejectCommand(volume: volume)
            let eject = Process()
            eject.executableURL = URL(fileURLWithPath: cmd[0])
            eject.arguments = Array(cmd.dropFirst())
            eject.standardOutput = FileHandle.nullDevice; eject.standardError = FileHandle.nullDevice
            try? eject.run()
        }
        exit(0)
    }

    /// True when the first button was pressed.
    private static func alert(_ title: String, _ detail: String, buttons: [String]) -> Bool {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = detail
        buttons.forEach { a.addButton(withTitle: $0) }
        return a.runModal() == .alertFirstButtonReturn
    }
}
