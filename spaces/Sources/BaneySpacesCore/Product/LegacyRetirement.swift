import Foundation

/// A person who arrived by the disk image never ran install.sh, so BaneySpaces, if it is installed, is still there. Once
/// Polycarp is running and its settings have been copied, BaneySpaces goes to the Trash: recoverable, only from
/// ~/Applications or /Applications, only once, never while it runs. Its settings folder stays. The decision is here; the
/// move and the launch agent are the app's.
public enum LegacyRetirement {
    public static let doneMarker = "legacy-retired"
    /// Set in the defaults for the welcome window's one line; cleared when the welcome window finishes.
    public static let noteKey = "legacyRetiredNote"
    public static let welcomeNote = "\(Product.Legacy.name) moved to the Trash. Your settings came with you."
    public static let watchdogLabel = "\(Product.Legacy.bundleID).mc-watchdog"

    public static func watchdogPlist(home: URL) -> URL {
        home.appendingPathComponent("Library/LaunchAgents/\(watchdogLabel).plist")
    }

    /// The settings are copied once the import has written its marker, or when BaneySpaces never had any.
    public static func settingsCopied(supportDir: URL, legacySupportDir: URL) -> Bool {
        let fm = FileManager.default
        if fm.fileExists(atPath: supportDir.appendingPathComponent(Product.importedMarker).path) { return true }
        return SettingsImport.pending(in: supportDir) == nil && !fm.fileExists(atPath: legacySupportDir.path)
    }

    /// Every BaneySpaces in the two Applications folders (a person can have one in each).
    public static func copies(home: URL) -> [URL] {
        LegacyApp.searchFolders(home: home).compactMap { LegacyApp.installed(in: [$0]) }
    }

    /// Only while the welcome window hasn't been finished: that is a new arrival, and the window tells them. A person who
    /// finished it before keeps their BaneySpaces; it never disappears silently.
    /// Also only when this Polycarp is itself installed (in an Applications folder), so a copy run from the Desktop, a build
    /// folder or the disk image never removes BaneySpaces, and only once the settings import has really finished.
    public static func shouldRetire(legacyApps: [URL], running: Bool, settingsCopied: Bool, alreadyDone: Bool, welcomeFinished: Bool,
                                    polycarpInstalled: Bool) -> Bool {
        !legacyApps.isEmpty && !running && settingsCopied && !alreadyDone && !welcomeFinished && polycarpInstalled
    }

    /// Everything but the import is in place and only the import is unfinished: try again shortly.
    public static func shouldWaitForImport(legacyApps: [URL], running: Bool, settingsCopied: Bool, alreadyDone: Bool, welcomeFinished: Bool,
                                           polycarpInstalled: Bool) -> Bool {
        !settingsCopied && shouldRetire(legacyApps: legacyApps, running: running, settingsCopied: true, alreadyDone: alreadyDone,
                                        welcomeFinished: welcomeFinished, polycarpInstalled: polycarpInstalled)
    }

    public static func alreadyDone(supportDir: URL) -> Bool {
        FileManager.default.fileExists(atPath: supportDir.appendingPathComponent(doneMarker).path)
    }

    public struct Report: Equatable {
        public var trashed: [URL] = []
        public var watchdogRemoved = false
        public var failure: String?
    }

    /// Moves every BaneySpaces to the Trash first. Only when that worked is the Mission Control watchdog's launch agent stopped
    /// (`unload` is the app's launchctl call), so a copy that stays keeps its watchdog. The marker is written only when no copy
    /// is left; otherwise it is tried again next launch. BaneySpaces' own data is never touched.
    public static func retire(apps: [URL], home: URL, supportDir: URL, unload: () -> Void, trash: (URL) throws -> URL?) -> Report {
        var report = Report()
        let fm = FileManager.default
        var failures: [String] = []
        for app in apps {
            do { report.trashed.append(try trash(app) ?? app) }
            catch { failures.append("\(app.path): \(error.localizedDescription)") }
        }
        if !failures.isEmpty { report.failure = "\(Product.Legacy.appName) couldn't be moved to the Trash (\(failures.joined(separator: "; ")))." }
        guard failures.isEmpty else { return report }
        let plist = watchdogPlist(home: home)
        if fm.fileExists(atPath: plist.path) {
            unload()
            report.watchdogRemoved = (try? fm.removeItem(at: plist)) != nil
        }
        try? fm.createDirectory(at: supportDir, withIntermediateDirectories: true)
        try? Data("moved \(report.trashed.count) to the Trash\n".utf8).write(to: supportDir.appendingPathComponent(doneMarker))
        return report
    }
}
