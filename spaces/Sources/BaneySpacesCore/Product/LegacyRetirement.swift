import Foundation

/// A person who arrived by the disk image never ran install.sh, so BaneySpaces, if it is installed, is still there. Once
/// Polycarp is running and its settings have been copied, BaneySpaces goes to the Trash: recoverable, only from
/// ~/Applications or /Applications, only once, never while it runs. Its settings folder stays. The decision is here; the
/// move and the launch agent are the app's.
public enum LegacyRetirement {
    public static let doneMarker = "legacy-retired"
    /// Set in the defaults for the welcome window's one line; cleared when the welcome window finishes.
    public static let noteKey = "legacyRetiredNote"
    public static let welcomeNote = "BaneySpaces moved to the Trash. Your settings came with you."
    public static let watchdogLabel = "com.baney.baneyspaces.mc-watchdog"

    public static func watchdogPlist(home: URL) -> URL {
        home.appendingPathComponent("Library/LaunchAgents/\(watchdogLabel).plist")
    }

    /// The settings are copied once the import has written its marker, or when BaneySpaces never had any.
    public static func settingsCopied(supportDir: URL, legacySupportDir: URL) -> Bool {
        let fm = FileManager.default
        if fm.fileExists(atPath: supportDir.appendingPathComponent(Product.importedMarker).path) { return true }
        return SettingsImport.pending(in: supportDir) == nil && !fm.fileExists(atPath: legacySupportDir.path)
    }

    public static func shouldRetire(legacyApp: URL?, running: Bool, settingsCopied: Bool, alreadyDone: Bool) -> Bool {
        legacyApp != nil && !running && settingsCopied && !alreadyDone
    }

    public static func alreadyDone(supportDir: URL) -> Bool {
        FileManager.default.fileExists(atPath: supportDir.appendingPathComponent(doneMarker).path)
    }

    public struct Report: Equatable {
        public var trashed: URL?
        public var watchdogRemoved = false
        public var failure: String?
    }

    /// Stops the Mission Control watchdog's launch agent from running for an app that is going (`unload` is the app's launchctl
    /// call), then moves BaneySpaces to the Trash. The marker is written only when the app moved; a failure is tried again
    /// next launch. BaneySpaces' own data is never touched.
    public static func retire(app: URL, home: URL, supportDir: URL, unload: () -> Void, trash: (URL) throws -> URL?) -> Report {
        var report = Report()
        let fm = FileManager.default
        let plist = watchdogPlist(home: home)
        if fm.fileExists(atPath: plist.path) {
            unload()
            report.watchdogRemoved = (try? fm.removeItem(at: plist)) != nil
        }
        do {
            report.trashed = try trash(app) ?? app
            try? fm.createDirectory(at: supportDir, withIntermediateDirectories: true)
            try? Data("moved \(app.path) to the Trash\n".utf8).write(to: supportDir.appendingPathComponent(doneMarker))
        } catch {
            report.failure = "\(app.lastPathComponent) couldn't be moved to the Trash: \(error.localizedDescription)"
        }
        return report
    }
}
