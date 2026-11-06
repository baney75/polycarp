import Foundation

/// Silas stays until the person says it can go. Nothing here runs on its own.
///
/// After Polycarp's first dictation that really typed text, one notification says dictation is working. While voice is on
/// and Silas is installed in /Applications or ~/Applications, Settings > Silas shows "The Silas app is still installed." and a
/// button; a click moves the app to the Trash, removes Silas's login item only after that move succeeded, and a failure is
/// shown in the tab. Silas's data stays. Silas off: nothing is offered.
public enum SilasRetirement {
    public static let notice = "Dictation is working. \(LegacyHandover.sentence(Product.Silas.phrase)) can go when you're ready."
    public static let stillInstalled = "The Silas app is still installed."
    public static let button = "Move the Silas app to the Trash"
    public static let notifiedMarker = "silas-notified"
    public static let recordFolder = "silas-retired-record"

    /// tauri-plugin-autostart with MacosLauncher::LaunchAgent (the auto-launch crate) writes
    /// ~/Library/LaunchAgents/<app name>.plist, and Silas's app name is its productName. The file is Silas's only if its
    /// program is inside a Silas.app.
    public static func loginItem(home: URL) -> URL {
        home.appendingPathComponent("Library/LaunchAgents/\(Product.Silas.name).plist")
    }

    /// Silas.app in /Applications or ~/Applications, confirmed by its bundle ID.
    public static func locate(home: URL, systemApplications: URL = URL(fileURLWithPath: "/Applications", isDirectory: true)) -> URL? {
        let folders = [systemApplications, home.appendingPathComponent("Applications", isDirectory: true)]
        for dir in folders {
            let app = dir.appendingPathComponent(Product.Silas.appName, isDirectory: true)
            guard let data = try? Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
                  let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                  info["CFBundleIdentifier"] as? String == Product.Silas.bundleID else { continue }
            return app
        }
        return nil
    }

    /// The one notification: after a dictation that typed, once, with voice on and Silas there.
    public static func shouldNotify(voiceOn: Bool, typedText: Bool, alreadyNotified: Bool, silas: URL?) -> Bool {
        voiceOn && typedText && !alreadyNotified && silas != nil
    }

    /// Whether Settings > Silas offers the button: voice on, Silas there, and not running (a running Silas can't be moved).
    public static func offers(voiceOn: Bool, silas: URL?, silasRunning: Bool) -> Bool {
        voiceOn && silas != nil && !silasRunning
    }

    public static func alreadyNotified(voiceDir: URL) -> Bool {
        FileManager.default.fileExists(atPath: voiceDir.appendingPathComponent(notifiedMarker).path)
    }

    public static func markNotified(voiceDir: URL) {
        try? FileManager.default.createDirectory(at: voiceDir, withIntermediateDirectories: true)
        try? Data(Date().description.utf8).write(to: voiceDir.appendingPathComponent(notifiedMarker))
    }

    public struct Report: Equatable {
        public var trashed: URL?
        public var loginItemRemoved = false
        /// What to show in the tab when something didn't work; nil when it all did.
        public var failure: String?
    }

    /// Moves Silas to the Trash. Only if that worked is its login item removed (a copy is kept in the record folder so it can
    /// be put back), so a failed move leaves Silas exactly as it was. `trash` is injected so a test moves into a temp folder;
    /// the app passes `FileManager.trashItem`.
    public static func moveToTrash(silas: URL, home: URL, voiceDir: URL, trash: (URL) throws -> URL?) -> Report {
        var report = Report()
        do {
            let landed = try trash(silas)
            report.trashed = landed ?? silas
        } catch {
            report.failure = "Couldn't move \(Product.Silas.phrase) to the Trash: \(error.localizedDescription). Drag \(silas.path) to the Trash yourself."
            return report
        }
        let fm = FileManager.default
        let item = loginItem(home: home)
        if let data = try? Data(contentsOf: item),
           let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
           let program = (plist["ProgramArguments"] as? [String])?.first ?? plist["Program"] as? String,
           program.contains("/\(Product.Silas.appName)/") {
            let record = voiceDir.appendingPathComponent(recordFolder, isDirectory: true)
            do {
                try fm.createDirectory(at: record, withIntermediateDirectories: true)
                try data.write(to: record.appendingPathComponent(item.lastPathComponent))
                try fm.removeItem(at: item)
                report.loginItemRemoved = true
            } catch {
                report.failure = "The Silas app is in the Trash, but its login item couldn't be removed (\(error.localizedDescription)). Remove \(item.path) yourself."
            }
        }
        try? Data("moved \(silas.path) to \(report.trashed?.path ?? "?")\nlogin item removed: \(report.loginItemRemoved)\n".utf8)
            .write(to: voiceDir.appendingPathComponent(recordFolder + ".txt"))
        return report
    }
}
