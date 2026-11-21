import Foundation

/// A `--render` run keeps its files out of the person's own Application Support folder. Every builder's renders
/// used to share one crash ledger there (`crash-ledger-render.json`), so three crashes in anyone's renders refused
/// everyone's for five minutes (11-17), and each render wrote its lines into the real `trace.log`.
///
/// `main.swift` sets `current` before anything reads a path, and `Product.supportDir(home:)` answers with it, so the
/// ledger, `trace.log` and every other file the run writes land there.
public enum RunFolder {
    /// The folder a render run uses instead of the person's own (absolute; created on first write).
    public static let environmentKey = "POLYCARP_SUPPORT_DIR"

    /// Set once, at the top of `main.swift`. Nil for every run but `--render`.
    public nonisolated(unsafe) static var current: URL?

    /// The folder for a run, or nil when the run uses the person's own. A `--render` run takes
    /// `POLYCARP_SUPPORT_DIR` when it is an absolute path outside the person's own folder, and otherwise
    /// `temp`, a new folder for this run alone.
    public static func resolve(arguments: [String], environment: [String: String], home: URL, temp: () -> URL) -> URL? {
        guard arguments.dropFirst().contains("--render") else { return nil }
        let own = home.appendingPathComponent("Library/Application Support/" + Product.supportFolder, isDirectory: true)
        if let path = environment[environmentKey], path.hasPrefix("/") {
            let url = URL(fileURLWithPath: path, isDirectory: true)
            if !inside(url, own) { return url }
        }
        return temp()
    }

    /// A new, empty folder under the temporary directory, for one run.
    public static func newTemp(fileManager: FileManager = .default) -> URL {
        fileManager.temporaryDirectory.appendingPathComponent("polycarp-render-\(UUID().uuidString)", isDirectory: true)
    }

    /// A folder `newTemp` made, which the run may remove when it is done. Never one `POLYCARP_SUPPORT_DIR` named.
    public static func isTemporary(_ url: URL, fileManager: FileManager = .default) -> Bool {
        url.lastPathComponent.hasPrefix("polycarp-render-") && real(url.deletingLastPathComponent()) == real(fileManager.temporaryDirectory)
    }

    /// Whether `url` is `folder` or inside it, after symlinks and `..` resolve.
    public static func inside(_ url: URL, _ folder: URL) -> Bool {
        let a = real(url), b = real(folder)
        return a == b || a.hasPrefix(b + "/")
    }

    private static func real(_ url: URL) -> String {
        let p = url.standardizedFileURL.resolvingSymlinksInPath().path
        return p.count > 1 && p.hasSuffix("/") ? String(p.dropLast()) : p
    }
}
