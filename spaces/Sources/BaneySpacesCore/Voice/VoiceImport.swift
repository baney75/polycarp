import Foundation

/// First launch of Polycarp on a Mac that ran Silas: copies the dictation data across. Like `SettingsImport`, it only
/// COPIES. Silas's folder is read and never written, moved or deleted, so Silas still works and its data stays after
/// Polycarp moves the app itself to the Trash (`SilasRetirement`), after its own dictation has typed text.
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
        /// Files Polycarp wrote while their import was pending: Silas's copy is kept next to them as `<name>.from-silas`.
        public var keptAside: [String] = []
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

    /// Whether the import is over: done (the marker), or never needed (nothing of Silas's to bring across and nothing
    /// pending). While part of it is still to come, voice does not start.
    public static func isFinished(silasDir: URL, newDir: URL) -> Bool {
        let fm = FileManager.default
        if fm.fileExists(atPath: newDir.appendingPathComponent(markerName).path) { return true }
        if pending(in: newDir) != nil { return false }
        let hasFiles = files.contains { fm.fileExists(atPath: silasDir.appendingPathComponent($0).path) }
        return !hasFiles && !GateModels.any(in: silasDir)
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
            let from = silasDir.appendingPathComponent(name)
            if fm.fileExists(atPath: to.path) {
                // A file Polycarp already has was written since; it is newer than anything Silas had. But one still pending
                // was written before Silas's copy came, so Silas's would be lost: a dictionary is merged, anything else kept aside.
                guard retry != nil else { continue }
                if name == "dictionary.json", let merged = mergedDictionary(mine: to, silas: from), copyWhole(data: merged, to) {
                    report.copiedFiles.append(name)
                } else if copyWhole(from, newDir.appendingPathComponent(name + ".from-silas")) {
                    report.keptAside.append(name)
                } else { report.failed.append(name) }
                continue
            }
            if copyWhole(from, to) { report.copiedFiles.append(name) } else { report.failed.append(name) }
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
        var note = "imported from \(silasDir.path)\nfiles: \(report.copiedFiles.joined(separator: ", "))\nmodels: \(report.copiedModels.joined(separator: ", "))\n"
        if !report.keptAside.isEmpty { note += "kept aside as <name>.from-silas: \(report.keptAside.joined(separator: ", "))\n" }
        try? Data(note.utf8).write(to: marker, options: .atomic)
        return .imported(report)
    }

    /// Polycarp's dictionary with Silas's terms and corrections added: an entry Polycarp has (same text, same `from`)
    /// stays as it is. Nil when either file isn't a dictionary.
    static func mergedDictionary(mine: URL, silas: URL) -> Data? {
        func object(_ url: URL) -> [String: Any]? { (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } }
        guard var out = object(mine), let theirs = object(silas) else { return nil }
        for (list, key) in [("terms", "text"), ("corrections", "from")] {
            var entries = out[list] as? [[String: Any]] ?? []
            var have = Set(entries.compactMap { ($0[key] as? String)?.lowercased() })
            for e in theirs[list] as? [[String: Any]] ?? [] {
                guard let k = (e[key] as? String)?.lowercased(), have.insert(k).inserted else { continue }
                entries.append(e)
            }
            out[list] = entries
        }
        return try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
    }

    private static func copyWhole(_ from: URL, _ to: URL) -> Bool {
        guard let data = try? Data(contentsOf: from) else { return false }
        return copyWhole(data: data, to)
    }

    private static func copyWhole(data: Data, _ to: URL) -> Bool {
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

enum GateModels {
    static func any(in dir: URL) -> Bool { VoiceGate.hasModel(in: [dir]) }
}
