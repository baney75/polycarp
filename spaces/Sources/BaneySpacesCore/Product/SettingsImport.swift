import Foundation

/// First launch of Polycarp on a Mac that ran BaneySpaces: copies the person's settings across.
/// It only ever COPIES. The old app's folder and defaults are read and never written, moved or
/// deleted, so the old app still works and its own uninstaller still has what it needs.
///
/// What is copied: every preference in the old defaults domain (including the saved copies of
/// what the app changed in macOS, such as the Dock's autohide, so uninstalling puts back what the
/// person really had), and the settings and layout files named in `files`. What is not copied:
/// sockets, logs, the signing folder, heartbeat and crash-ledger files, caches, tokens and
/// anything else the old app rebuilds by itself. Naming what to copy, not what to skip, keeps a
/// file added later out until someone decides it belongs.
public enum SettingsImport {
    /// Files in the support folder that are the person's settings or layout, and the notes `install-app.sh` and the
    /// app keep so that uninstalling puts back what the person had: AeroSpace's start-at-login and login item, and
    /// the Mission Control record that survives a crash (`DurableRecord`).
    public static let files = ["bangs.json", "layout.json", "state.json", "frames.json",
                               "aerospace-start-at-login", "aerospace-login-item", DurableRecord.fileName]

    /// Preferences that describe the old app's own setup, not the person's choices. Copied, they'd tell Polycarp its
    /// login item was already handled, so nothing would start at login once the old app is gone.
    public static let notImported: Set<String> = ["loginItemOffered", "loginItemChosen", "setupShown"]

    /// Names that could not be copied last time, one per line. While it exists the import is not finished.
    public static let pendingName = "import-pending"

    public struct Report: Equatable {
        public var copiedFiles: [String] = []
        /// Files that were there and could not be read or written. Everything else still copied; these are
        /// tried again at the next launch.
        public var failedFiles: [String] = []
        public var copiedPreferences = 0
    }

    public enum Outcome: Equatable {
        /// There is no BaneySpaces data. Nothing was written, not even the marker.
        case nothingToImport
        /// The marker is there: this finished.
        case alreadyImported
        /// Everything was copied and the marker is written.
        case imported(Report)
        /// Something could not be copied. No marker: the next launch tries the failed names again.
        case partial(Report)
    }

    /// The names still to copy, or nil when no import is pending.
    public static func pending(in newDir: URL) -> [String]? {
        guard let text = try? String(contentsOf: newDir.appendingPathComponent(pendingName), encoding: .utf8) else { return nil }
        return text.split(separator: "\n").map(String.init)
    }

    /// - Parameters:
    ///   - legacyDir / newDir: the two support folders.
    ///   - legacyDefaults / legacyDomain: where the old preferences are read (never written).
    ///   - newDefaults: where they go. A key the new domain already has is kept, not overwritten.
    @discardableResult
    public static func run(legacyDir: URL, newDir: URL,
                           legacyDefaults: UserDefaults, legacyDomain: String,
                           newDefaults: UserDefaults) -> Outcome {
        let fm = FileManager.default
        let marker = newDir.appendingPathComponent(Product.importedMarker)
        if fm.fileExists(atPath: marker.path) { return .alreadyImported }

        // A retry copies only what failed, and never preferences again: the person may have changed them since.
        let retry = pending(in: newDir)
        let oldPrefs = retry == nil ? (legacyDefaults.persistentDomain(forName: legacyDomain) ?? [:]).filter { !notImported.contains($0.key) } : [:]
        var present: [String] = []
        for name in retry ?? files where fm.fileExists(atPath: legacyDir.appendingPathComponent(name).path) { present.append(name) }
        if retry == nil && oldPrefs.isEmpty && present.isEmpty { return .nothingToImport }

        var report = Report()
        try? fm.createDirectory(at: newDir, withIntermediateDirectories: true)
        for name in present {
            let from = legacyDir.appendingPathComponent(name)
            let to = newDir.appendingPathComponent(name)
            // A file Polycarp already has was imported or edited since; it is newer than anything BaneySpaces had.
            if fm.fileExists(atPath: to.path) { continue }
            if copyWhole(from, to) { report.copiedFiles.append(name) } else { report.failedFiles.append(name) }
        }
        for (key, value) in oldPrefs where newDefaults.object(forKey: key) == nil {
            newDefaults.set(value, forKey: key)
            report.copiedPreferences += 1
        }
        newDefaults.synchronize()

        let pendingFile = newDir.appendingPathComponent(pendingName)
        if !report.failedFiles.isEmpty {
            try? Data((report.failedFiles.joined(separator: "\n") + "\n").utf8).write(to: pendingFile, options: .atomic)
            return .partial(report)
        }
        try? fm.removeItem(at: pendingFile)
        let note = "imported from \(legacyDir.path)\n"
            + "files: \(report.copiedFiles.joined(separator: ", "))\n"
            + "preferences: \(report.copiedPreferences)\n"
        try? Data(note.utf8).write(to: marker, options: .atomic)
        return .imported(report)
    }

    /// Reads the whole file first, then writes it beside the target and renames it into place, so
    /// a read that fails halfway leaves nothing behind.
    private static func copyWhole(_ from: URL, _ to: URL) -> Bool {
        guard let data = try? Data(contentsOf: from) else { return false }
        let temp = to.appendingPathExtension("copying")
        do {
            try data.write(to: temp)
            try? FileManager.default.removeItem(at: to)
            try FileManager.default.moveItem(at: temp, to: to)
            return true
        } catch {
            try? FileManager.default.removeItem(at: temp)
            return false
        }
    }
}
