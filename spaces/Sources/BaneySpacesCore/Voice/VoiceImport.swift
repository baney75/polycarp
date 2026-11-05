import Foundation

/// First launch of Polycarp on a Mac that ran Silas: copies the dictation data across. Like `SettingsImport`, it only
/// COPIES. Silas's folder is read and never written, moved or deleted, so Silas still works and its data stays after
/// the installer puts the app itself in the Trash.
///
/// Copied: settings, dictionary, history, the device benchmark report, and every downloaded model whose `.complete`
/// marker is there (a half download is not copied). Models are large, so they are copied with `copyItem`, which on
/// APFS clones the files and uses no extra space; nothing is downloaded again. Not copied: the cached device
/// registry (fetched again), `.bak`/`.broken` copies, temp files.
public enum VoiceImport {
    public static let files = ["settings.json", "dictionary.json", "history.json", "benchmark.json"]
    public static let modelsFolder = "models"
    public static let markerName = "silas-imported"
    public static let pendingName = "silas-import-pending"

    public struct Report: Equatable {
        public var copiedFiles: [String] = []
        public var copiedModels: [String] = []
        public var failed: [String] = []
    }

    public enum Outcome: Equatable {
        case nothingToImport
        case alreadyImported
        case imported(Report)
        case partial(Report)
    }

    public static func pending(in newDir: URL) -> [String]? {
        guard let t = try? String(contentsOf: newDir.appendingPathComponent(pendingName), encoding: .utf8) else { return nil }
        return t.split(separator: "\n").map(String.init)
    }

    @discardableResult
    public static func run(silasDir: URL, newDir: URL) -> Outcome {
        let fm = FileManager.default
        let marker = newDir.appendingPathComponent(markerName)
        if fm.fileExists(atPath: marker.path) { return .alreadyImported }

        let retry = pending(in: newDir)
        var names = (retry ?? files).filter { !$0.hasPrefix("models/") && fm.fileExists(atPath: silasDir.appendingPathComponent($0).path) }
        let modelsDir = silasDir.appendingPathComponent(modelsFolder, isDirectory: true)
        let models = ((try? fm.contentsOfDirectory(atPath: modelsDir.path)) ?? []).sorted().filter {
            fm.fileExists(atPath: modelsDir.appendingPathComponent($0).appendingPathComponent(".complete").path)
                && (retry == nil || retry!.contains("models/" + $0))
        }
        if retry == nil && names.isEmpty && models.isEmpty { return .nothingToImport }
        names = names.sorted()

        var report = Report()
        try? fm.createDirectory(at: newDir, withIntermediateDirectories: true)
        for name in names {
            let to = newDir.appendingPathComponent(name)
            // A file Polycarp already has was written since; it is newer than anything Silas had.
            if fm.fileExists(atPath: to.path) { continue }
            if copyWhole(silasDir.appendingPathComponent(name), to) { report.copiedFiles.append(name) } else { report.failed.append(name) }
        }
        let newModels = newDir.appendingPathComponent(modelsFolder, isDirectory: true)
        try? fm.createDirectory(at: newModels, withIntermediateDirectories: true)
        for m in models {
            let to = newModels.appendingPathComponent(m)
            if fm.fileExists(atPath: to.path) { continue }
            // Into a temp name first, then renamed: a copy cut short never looks complete.
            let temp = newModels.appendingPathComponent(m + ".copying")
            try? fm.removeItem(at: temp)
            do {
                try fm.copyItem(at: modelsDir.appendingPathComponent(m), to: temp)
                try fm.moveItem(at: temp, to: to)
                report.copiedModels.append(m)
            } catch {
                try? fm.removeItem(at: temp)
                report.failed.append("models/" + m)
            }
        }

        let pendingFile = newDir.appendingPathComponent(pendingName)
        if !report.failed.isEmpty {
            try? Data((report.failed.joined(separator: "\n") + "\n").utf8).write(to: pendingFile, options: .atomic)
            return .partial(report)
        }
        try? fm.removeItem(at: pendingFile)
        let note = "imported from \(silasDir.path)\nfiles: \(report.copiedFiles.joined(separator: ", "))\nmodels: \(report.copiedModels.joined(separator: ", "))\n"
        try? Data(note.utf8).write(to: marker, options: .atomic)
        return .imported(report)
    }

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
