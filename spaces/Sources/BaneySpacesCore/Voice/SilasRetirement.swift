import Foundation

/// Silas goes to the Trash by itself, once, after Polycarp's dictation has really worked.
///
/// Dictation is what Donovan relies on and Polycarp's voice had never run live when this was written, so the installer
/// leaves Silas where it is. Polycarp moves it to the Trash after the first dictation that actually typed text, removes
/// the login item Silas registered, and says so once. Never when voice is off (Silas is the way back then), never twice,
/// never for a Silas that is somewhere other than /Applications or ~/Applications, never while it runs. Silas's data stays.
public enum SilasRetirement {
    public static let notice = "Dictation works here, so Silas went to the Trash."
    public static let markerName = "silas-retired"
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

    public static func shouldRetire(voiceOn: Bool, typedText: Bool, alreadyRetired: Bool, silas: URL?, silasRunning: Bool) -> Bool {
        voiceOn && typedText && !alreadyRetired && silas != nil && !silasRunning
    }

    public struct Report: Equatable {
        public var trashed: URL?
        public var loginItemRemoved = false
        public var failed: [String] = []
    }

    /// Moves Silas to the Trash and removes its login item; writes down what it did. `trash` is injected so a test
    /// moves into a temp folder; the app passes `FileManager.trashItem`.
    public static func retire(silas: URL, home: URL, voiceDir: URL, trash: (URL) throws -> URL?) -> Report {
        let fm = FileManager.default
        var report = Report()
        try? fm.createDirectory(at: voiceDir, withIntermediateDirectories: true)
        let record = voiceDir.appendingPathComponent(recordFolder, isDirectory: true)
        try? fm.createDirectory(at: record, withIntermediateDirectories: true)

        // The login item first, while Silas.app is still where its plist says. Only the one Silas registered.
        let item = loginItem(home: home)
        if let data = try? Data(contentsOf: item),
           let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
           let program = (plist["ProgramArguments"] as? [String])?.first ?? plist["Program"] as? String,
           program.contains("/\(Product.Silas.appName)/") {
            do {
                try data.write(to: record.appendingPathComponent(item.lastPathComponent))   // a copy, so it can be put back
                try fm.removeItem(at: item)
                report.loginItemRemoved = true
            } catch { report.failed.append("login item") }
        }

        do {
            let landed = try trash(silas)
            report.trashed = landed ?? silas
            try? Data("moved \(silas.path) to the Trash at \(landed?.path ?? "?")\nlogin item removed: \(report.loginItemRemoved)\n".utf8)
                .write(to: record.appendingPathComponent("what-was-done.txt"))
        } catch { report.failed.append("app") }
        // Written only when the app itself moved; a failed move is tried again at the next dictation.
        if report.trashed != nil {
            try? Data(Date().description.utf8).write(to: voiceDir.appendingPathComponent(markerName))
        }
        return report
    }

    public static func alreadyRetired(voiceDir: URL) -> Bool {
        FileManager.default.fileExists(atPath: voiceDir.appendingPathComponent(markerName).path)
    }
}
