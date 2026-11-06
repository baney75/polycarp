import Foundation

/// Before Settings > Browser > Connect runs the helper's `install --force`, what is there is written down: the native host
/// manifest of each Chromium browser and the launchers in ~/.config/tabkyra that a standalone Tabkyra made. `uninstall.sh`
/// puts them back, or removes the ones Polycarp made where there was nothing. Recorded once; a file that already points into
/// Polycarp.app is never recorded as "previous". This only reads and copies: nothing of the browsers is changed or removed.
public enum BrowserPrevious {
    public static let hostName = "ai.tabkyra.bridge"
    public static let indexName = "index.tsv"

    /// Every file `install --force` may write on a Mac (the list is `browserDirs()` in browser/cli/src/install.ts).
    public static func paths(home: URL) -> [URL] {
        let support = home.appendingPathComponent("Library/Application Support", isDirectory: true)
        let browsers = ["net.imput.helium", "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium",
                        "BraveSoftware/Brave-Browser", "Microsoft Edge", "Arc/User Data", "Vivaldi", "com.operasoftware.Opera"]
        let config = home.appendingPathComponent(".config/tabkyra", isDirectory: true)
        return [config.appendingPathComponent("host"), config.appendingPathComponent("tabkyra")]
            + browsers.map { support.appendingPathComponent($0).appendingPathComponent("NativeMessagingHosts/\(hostName).json") }
    }

    /// Writes down the current state of each path under `store`. Does nothing if it was done before.
    @discardableResult
    public static func record(home: URL, store: URL) -> Bool {
        let fm = FileManager.default
        let index = store.appendingPathComponent(indexName)
        if fm.fileExists(atPath: index.path) { return false }
        let files = store.appendingPathComponent("files", isDirectory: true)
        try? fm.createDirectory(at: files, withIntermediateDirectories: true)
        var lines: [String] = []
        for (n, path) in paths(home: home).enumerated() {
            // A browser that isn't installed has no folder; the helper skips it too, so nothing is recorded.
            let isManifest = path.lastPathComponent.hasSuffix(".json")
            if isManifest, !fm.fileExists(atPath: path.deletingLastPathComponent().deletingLastPathComponent().path) { continue }
            if let data = fm.contents(atPath: path.path) {
                if String(decoding: data, as: UTF8.self).contains("Polycarp.app") { continue }   // ours already
                let saved = files.appendingPathComponent("\(n)")
                guard (try? data.write(to: saved)) != nil else { continue }
                lines.append("\(path.path)\t\(saved.path)")
            } else {
                lines.append("\(path.path)\t-")
            }
        }
        return (try? Data((lines.joined(separator: "\n") + "\n").utf8).write(to: index, options: .atomic)) != nil
    }
}
