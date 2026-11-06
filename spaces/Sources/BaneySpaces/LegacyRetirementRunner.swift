import AppKit
import BaneySpacesCore

/// Once Polycarp is running and BaneySpaces' settings are copied, BaneySpaces goes to the Trash (`LegacyRetirement`), but only
/// for a new arrival (the welcome window not finished yet), which the window then tells. Every copy in both Applications
/// folders goes; the app is never started, only moved; its launch agent is stopped after the move worked.
enum LegacyRetirementRunner {
    /// `welcomeFinished` is read when Polycarp started, so a click on Start can't change the answer halfway. Returns true when
    /// there is nothing more to wait for; false while only the settings import is unfinished (the caller tries again shortly).
    @discardableResult
    static func runIfDue(welcomeFinished: Bool) -> Bool {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let support = Product.supportDir(home: home)
        let apps = LegacyRetirement.copies(home: home)
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: Product.Legacy.bundleID).contains { !$0.isTerminated }
        let installed = MoveToApplications.classify(bundle: Bundle.main.bundleURL, home: home) == .installed
        let copied = LegacyRetirement.settingsCopied(supportDir: support, legacySupportDir: Product.legacySupportDir(home: home))
        let done = LegacyRetirement.alreadyDone(supportDir: support)
        if LegacyRetirement.shouldWaitForImport(legacyApps: apps, running: running, settingsCopied: copied, alreadyDone: done,
                                                welcomeFinished: welcomeFinished, polycarpInstalled: installed) { return false }
        guard LegacyRetirement.shouldRetire(legacyApps: apps, running: running, settingsCopied: copied, alreadyDone: done,
                                            welcomeFinished: welcomeFinished, polycarpInstalled: installed) else { return true }
        let report = LegacyRetirement.retire(apps: apps, home: home, supportDir: support, unload: {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            p.arguments = ["bootout", "gui/\(getuid())/\(LegacyRetirement.watchdogLabel)"]
            p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
            try? p.run(); p.waitUntilExit()
        }, trash: { url in
            var landed: NSURL?
            try FileManager.default.trashItem(at: url, resultingItemURL: &landed)
            return landed as URL?
        })
        Trace.log("legacy: retired: \(report)")
        // The welcome window is still to be finished (that is the only time this runs), so it shows the note whenever it is up.
        if !report.trashed.isEmpty { UserDefaults.standard.set(true, forKey: LegacyRetirement.noteKey) }
        return true
    }
}
