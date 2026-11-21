import Foundation

/// Reading and writing the purpose layer's small JSON files (purposes.json, ledger.json). A file that can't be read is
/// moved aside and the layer starts empty: a bad file must never crash Polycarp or block it from starting, and moving
/// it keeps the text for a person to look at.
public enum PurposeFile {
    /// What `load` found.
    public enum Loaded<Value> {
        case missing
        case read(Value)
        /// The file was there and couldn't be read. `aside` is where it went (nil if the move failed too).
        case movedAside(aside: URL?, why: String)
    }

    /// Reads `url` as `Value`. A file that is there but isn't valid JSON for `Value`, or whose `version` is newer than
    /// `newest`, is renamed to `<name>.bad-<unix seconds>` next to it.
    public static func load<Value: Decodable>(_ type: Value.Type, from url: URL, newest: Int, now: Date = Date(),
                                              fileManager: FileManager = .default) -> Loaded<Value> {
        guard let data = fileManager.contents(atPath: url.path) else { return .missing }
        let why: String
        do {
            let version = try JSONDecoder().decode(Versioned.self, from: data).version ?? 0
            if version > newest {
                why = "schema \(version) is newer than this build reads (\(newest))"
            } else {
                return .read(try JSONDecoder().decode(Value.self, from: data))
            }
        } catch {
            why = "not readable JSON (\(data.count) bytes)"
        }
        let aside = url.deletingLastPathComponent()
            .appendingPathComponent("\(url.lastPathComponent).bad-\(Int(now.timeIntervalSince1970))")
        do {
            try? fileManager.removeItem(at: aside)
            try fileManager.moveItem(at: url, to: aside)
            return .movedAside(aside: aside, why: why)
        } catch {
            return .movedAside(aside: nil, why: why)
        }
    }

    /// The trace line for a file moved aside. File names only, never the home folder.
    public static func line(_ name: String, _ loaded: Loaded<some Any>) -> String? {
        guard case .movedAside(let aside, let why) = loaded else { return nil }
        guard let aside else { return "purpose: \(name) \(why), and it could not be moved aside; starting empty" }
        return "purpose: \(name) \(why), moved aside to \(aside.lastPathComponent); starting empty"
    }

    /// Writes `data` to `url` in one step: a reader sees the old file or the new one, never half of one.
    public static func write(_ data: Data, to url: URL, fileManager: FileManager = .default) throws {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    private struct Versioned: Decodable { var version: Int? }
}

/// Writes a file on a background queue, newest value only: a burst of sets costs one write, and the caller never waits
/// on the disk.
final class LatestWriter: @unchecked Sendable {
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var pending: (() -> Data?)?

    init(label: String) { queue = DispatchQueue(label: label, qos: .utility) }

    /// Queues `encode` to run off the caller's thread; only the last one queued before the write starts is used.
    func write(to url: URL, log: @escaping (String) -> Void, _ encode: @escaping () -> Data?) {
        lock.lock()
        let wasIdle = pending == nil
        pending = encode
        lock.unlock()
        guard wasIdle else { return }
        queue.async { [self] in
            lock.lock()
            let job = pending
            pending = nil
            lock.unlock()
            guard let data = job?() else { return }
            do { try PurposeFile.write(data, to: url) } catch { log("purpose: could not write \(url.lastPathComponent): \(error.localizedDescription)") }
        }
    }

    /// Waits for every queued write. For tests and quit, never the main thread's normal path.
    func flush() { queue.sync {} }
}
