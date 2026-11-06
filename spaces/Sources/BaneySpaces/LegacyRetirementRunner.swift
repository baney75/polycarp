import AppKit
import BaneySpacesCore

/// Once Polycarp is running and BaneySpaces' settings are copied, BaneySpaces goes to the Trash (`LegacyRetirement`). The app
/// is never started, only moved; its launch agent is stopped first so it doesn't run for an app that is gone.
enum LegacyRetirementRunner {
    static func runIfDue() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let support = Product.supportDir(home: home)
        let app = LegacyApp.installed(in: LegacyApp.searchFolders(home: home))
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: Product.Legacy.bundleID).contains { !$0.isTerminated }
        guard LegacyRetirement.shouldRetire(legacyApp: app, running: running,
                                            settingsCopied: LegacyRetirement.settingsCopied(supportDir: support, legacySupportDir: Product.legacySupportDir(home: home)),
                                            alreadyDone: LegacyRetirement.alreadyDone(supportDir: support)),
              let app else { return }
        let report = LegacyRetirement.retire(app: app, home: home, supportDir: support, unload: {
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
        Trace.log("legacy: retired \(app.lastPathComponent): \(report)")
        if report.trashed != nil { UserDefaults.standard.set(true, forKey: LegacyRetirement.noteKey) }
    }
}
