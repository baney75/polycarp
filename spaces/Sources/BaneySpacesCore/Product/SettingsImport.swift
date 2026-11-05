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
    /// Files in the support folder that are the person's settings or layout.
    public static let files = ["bangs.json", "layout.json", "state.json"]

    public struct Report: Equatable {
        public var copiedFiles: [String] = []
        /// Files that were there and could not be read or written. Everything else still copied.
        public var failedFiles: [String] = []
        public var copiedPreferences = 0
    }

    public enum Outcome: Equatable {
        /// There is no BaneySpaces data. Nothing was written, not even the marker.
        case nothingToImport
        /// The marker is there: this already ran.
        case alreadyImported
        case imported(Report)
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

        let oldPrefs = legacyDefaults.persistentDomain(forName: legacyDomain) ?? [:]
        var present: [String] = []
        for name in files where fm.fileExists(atPath: legacyDir.appendingPathComponent(name).path) { present.append(name) }
        if oldPrefs.isEmpty && present.isEmpty { return .nothingToImport }

        var report = Report()
        try? fm.createDirectory(at: newDir, withIntermediateDirectories: true)
        for name in present {
            let from = legacyDir.appendingPathComponent(name)
            let to = newDir.appendingPathComponent(name)
            // A file Polycarp already wrote is newer than anything BaneySpaces had.
            if fm.fileExists(atPath: to.path) { continue }
            if copyWhole(from, to) { report.copiedFiles.append(name) } else { report.failedFiles.append(name) }
        }
        for (key, value) in oldPrefs where newDefaults.object(forKey: key) == nil {
            newDefaults.set(value, forKey: key)
            report.copiedPreferences += 1
        }
        newDefaults.synchronize()

        let note = "imported from \(legacyDir.path)\n"
            + "files: \(report.copiedFiles.joined(separator: ", "))\n"
            + (report.failedFiles.isEmpty ? "" : "not copied: \(report.failedFiles.joined(separator: ", "))\n")
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
