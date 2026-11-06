import AppKit
import Foundation

/// What Settings > Browser shows, read from the bundled helper's `doctor --json`. The helper owns every check (which browsers
/// are registered, whether the extension is connected, which agents have the MCP entry); this only reads its answer.
public struct BrowserStatus: Equatable {
    public struct Browser: Equatable, Identifiable {
        public var name: String
        /// The native host manifest is in place for this browser, so the extension can reach the helper.
        public var registered: Bool
        public var id: String { name }
    }
    public struct Agent: Equatable, Identifiable {
        public var id: String
        public var name: String
        public var connected: Bool
    }

    public var browsers: [Browser] = []
    public var extensionConnected = false
    public var extensionVersion: String?
    /// The extension's version in each browser that holds a connection, by browser name (the helper reads it from the host's
    /// parent process). Empty with an older helper or extension that gives no name.
    public var connections: [String: String] = [:]
    /// Connected, but no browser can be named: show one line for the connection, not a row.
    public var unattributed: Bool { extensionConnected && connections.isEmpty }
    public var agents: [Agent] = []

    public init() {}

    /// The helper's JSON. Nil when it isn't JSON of the shape `doctor --json` prints.
    public static func parse(_ data: Data) -> BrowserStatus? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let checks = root["checks"] as? [[String: Any]] else { return nil }
        var s = BrowserStatus()
        for check in checks {
            guard let id = check["id"] as? String else { continue }
            let ok = (check["status"] as? String) == "ok"
            let label = check["label"] as? String ?? ""
            if id.hasPrefix("host:") {
                s.browsers.append(Browser(name: String(id.dropFirst(5)), registered: ok))
            } else if id.hasPrefix("connected:"), ok || (check["status"] as? String) == "warn" {
                // "warn" is a live connection whose extension did not answer the version question: the browser still holds it.
                let name = String(id.dropFirst(10))
                var version = ""
                if let open = label.lastIndex(of: "("), let close = label.lastIndex(of: ")"), open < close {
                    version = String(label[label.index(after: open)..<close])
                }
                s.connections[name] = version == "unknown version" ? "" : version
            } else if id == "connected" {
                s.extensionConnected = ok
                if ok, let open = label.firstIndex(of: "("), let close = label.lastIndex(of: ")"), open < close {
                    let v = String(label[label.index(after: open)..<close])
                    s.extensionVersion = v == "unknown version" ? nil : v
                }
            } else if id.hasPrefix("mcp:") {
                let name = label.components(separatedBy: ":").first ?? String(id.dropFirst(4))
                s.agents.append(Agent(id: String(id.dropFirst(4)), name: name, connected: ok))
            }
        }
        return s
    }

    /// "Claude Code" and "Codex" are the two the one button wires up.
    public var addable: [Agent] { agents.filter { ($0.id == "claude" || $0.id == "codex") && !$0.connected } }
}

/// A copy of the extension where a file dialog can reach it: the bundled one is inside Polycarp.app, which "Load unpacked"
/// can't browse into. The copy is in the support folder, replaced whenever the app's version or the extension's changes (a
/// new copy is built beside it and swapped in, so a failed copy leaves the old one). The manifest's key is copied with
/// everything else, so the extension keeps its id.
public enum ExtensionCopy {
    public static let folderName = "Extension"
    public static let stampName = "Extension.stamp"

    public static func destination(supportDir: URL) -> URL { supportDir.appendingPathComponent(folderName, isDirectory: true) }

    /// The `version` in a folder's manifest.json.
    public static func manifestVersion(of folder: URL) -> String? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")),
              let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return m["version"] as? String
    }

    /// Every caller (the app at launch, the status poll, Connect) goes through `refresh`, and `refresh` runs one at a time: two
    /// runs can't copy into, delete or swap each other's folders.
    private static let refreshLock = NSLock()
    /// What a run's staging folder is called, before its unique suffix. A leftover of a run that died is swept at the next run.
    static let stagingPrefix = folderName + ".new-"

    /// Makes sure the copy matches `source` for `appVersion`. Returns the copy's folder, or nil if it could not be made.
    /// The copy is built in a folder of its own and swapped in whole; the previous complete copy stays where it is until the
    /// swap succeeds, so a failure at any point leaves a copy the browser can load.
    @discardableResult
    public static func refresh(source: URL, supportDir: URL, appVersion: String) -> URL? {
        refreshLock.lock(); defer { refreshLock.unlock() }
        let fm = FileManager.default
        let dest = destination(supportDir: supportDir)
        let stampFile = supportDir.appendingPathComponent(stampName)
        let stamp = "\(appVersion)|\(manifestVersion(of: source) ?? "?")"
        let complete = { fm.fileExists(atPath: dest.appendingPathComponent("manifest.json").path) }
        if complete(), (try? String(contentsOf: stampFile, encoding: .utf8)) == stamp { return dest }
        guard fm.fileExists(atPath: source.appendingPathComponent("manifest.json").path) else { return nil }
        let fresh = supportDir.appendingPathComponent(stagingPrefix + UUID().uuidString, isDirectory: true)
        do {
            try fm.createDirectory(at: supportDir, withIntermediateDirectories: true)
            // Staging folders from a run that never finished (the lock means none is running now).
            for name in (try? fm.contentsOfDirectory(atPath: supportDir.path)) ?? [] where name.hasPrefix(stagingPrefix) {
                try? fm.removeItem(at: supportDir.appendingPathComponent(name))
            }
            try fm.copyItem(at: source, to: fresh)
            guard fm.fileExists(atPath: fresh.appendingPathComponent("manifest.json").path) else { throw CocoaError(.fileReadCorruptFile) }
            if fm.fileExists(atPath: dest.path) {
                // One step that keeps the old folder until the new one is in place.
                _ = try fm.replaceItemAt(dest, withItemAt: fresh, backupItemName: nil, options: [])
            } else {
                try fm.moveItem(at: fresh, to: dest)
            }
            try stamp.write(to: stampFile, atomically: true, encoding: .utf8)
            return dest
        } catch {
            try? fm.removeItem(at: fresh)
            return complete() ? dest : nil
        }
    }
}

/// What the person drags onto the browser's extensions page: the Extension folder as a real file URL, the same item Finder
/// would drag.
public enum ExtensionDrag {
    public static func writer(for folder: URL) -> NSPasteboardWriting { folder as NSURL }
    public static let type = NSPasteboard.PasteboardType.fileURL
}

/// One browser's line in Settings and the welcome window.
public struct BrowserRow: Equatable, Identifiable {
    public enum State: Equatable { case connect, connected, reload(loaded: String, current: String) }
    public var name: String
    public var state: State
    public var id: String { name }
}

public enum BrowserRows {
    /// A version as its dot-separated numbers; anything else counts as zero.
    static func parts(_ v: String) -> [Int] { v.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 } }

    /// The loaded extension is older than the bundled one: a reload (or a fresh load from the Application Support copy) helps.
    /// A newer or different build, such as a standalone copy, is not stale: reloading it changes nothing.
    public static func stale(loaded: String?, current: String?) -> Bool {
        guard let loaded, let current, !loaded.isEmpty, !current.isEmpty else { return false }
        let a = parts(loaded), b = parts(current)
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
            if x != y { return x < y }
        }
        return false
    }

    /// One row per installed browser, from which browser really holds a connection.
    public static func rows(_ status: BrowserStatus, bundledVersion: String?) -> [BrowserRow] {
        status.browsers.map { b in
            guard let loaded = status.connections[b.name] else { return BrowserRow(name: b.name, state: .connect) }
            if stale(loaded: loaded, current: bundledVersion), let c = bundledVersion {
                return BrowserRow(name: b.name, state: .reload(loaded: loaded, current: c))
            }
            return BrowserRow(name: b.name, state: .connected)
        }
    }
}

/// The floating panel beside the browser: waiting for the drop, connected (then it closes by itself), or an older copy loaded.
public enum BrowserPanelState: Equatable {
    case waiting, connected, reload(loaded: String, current: String)
    public static let closeDelay: TimeInterval = 1.5

    /// The state for the browser the panel was opened for. Only a connection the helper attributes to that browser counts as
    /// connected: one it can't attribute (an older helper or extension) might be any browser, and never closes the panel.
    public static func next(_ status: BrowserStatus?, bundledVersion: String?, browser: String) -> BrowserPanelState {
        guard let status else { return .waiting }
        if let loaded = status.connections[browser] {
            if BrowserRows.stale(loaded: loaded, current: bundledVersion), let c = bundledVersion { return .reload(loaded: loaded, current: c) }
            return .connected
        }
        return .waiting
    }

    /// A line for a connection that can't be attributed to a browser: information beside the drag tile, not success.
    public static func unattributedNote(_ status: BrowserStatus?, browser: String) -> String? {
        guard let status, status.unattributed else { return nil }
        let version = status.extensionVersion.map { " (extension \($0))" } ?? ""
        return "Polycarp is connected in a browser\(version), but it can't say which. This closes when \(browser) connects."
    }
    /// Only a connected, current extension closes the panel.
    public var closesItself: Bool { self == .connected }
}

/// Where the floating panel goes, in Cocoa coordinates (origin at the bottom left): beside the browser's window to its right if
/// the screen has room, else to its left, else (a maximized window) at the window's bottom right corner, clear of the page's top
/// bar where the Developer mode switch is.
public enum BrowserPanelPlacement {
    public static func place(size: CGSize, window w: CGRect, in visible: CGRect) -> CGPoint {
        let gap: CGFloat = 12
        let y = min(max(w.maxY - size.height - 40, visible.minY + 8), visible.maxY - size.height - 8)
        if w.maxX + gap + size.width <= visible.maxX { return CGPoint(x: w.maxX + gap, y: y) }
        if w.minX - gap - size.width >= visible.minX { return CGPoint(x: w.minX - gap - size.width, y: y) }
        return CGPoint(x: min(w.maxX - size.width - 16, visible.maxX - size.width - 8), y: max(w.minY + 16, visible.minY + 8))
    }
}

/// Where the bundled pieces are, and how a browser is opened on its extensions page.
/// Where the Chrome Web Store has the extension. Nil until Google assigns the listing its id; the panel then offers
/// only the by-hand ways in.
public enum ExtensionStore {
    public static let id: String? = nil
    public static func url(id: String? = ExtensionStore.id) -> URL? {
        id.flatMap { URL(string: "https://chromewebstore.google.com/detail/\($0)") }
    }
}

public enum BrowserBundle {
    /// `Polycarp.app/Contents/Resources/browser` for a resources folder.
    public static func folder(resources: URL?) -> URL? { resources?.appendingPathComponent("browser", isDirectory: true) }
    public static func helper(resources: URL?) -> URL? { folder(resources: resources)?.appendingPathComponent("polycarp-browser") }
    public static func extensionFolder(resources: URL?) -> URL? { folder(resources: resources)?.appendingPathComponent("extension", isDirectory: true) }

    /// The app name for each browser the helper reports, as installed in /Applications.
    public static func appName(for browser: String) -> String {
        switch browser {
        case "Chrome": "Google Chrome"
        case "Chrome Beta": "Google Chrome Beta"
        case "Chrome Canary": "Google Chrome Canary"
        case "Brave": "Brave Browser"
        case "Opera": "Opera"
        default: browser
        }
    }

    /// Each browser's bundle identifier, for finding its app wherever it lives. The same ids the helper uses to tell whether a
    /// browser is installed (`MAC_BUNDLE_IDS` in browser/cli/src/install.ts); a helper test keeps the two lists equal.
    public static let bundleIDs: [String: String] = [
        "Helium": "net.imput.helium",
        "Chrome": "com.google.Chrome",
        "Chrome Beta": "com.google.Chrome.beta",
        "Chrome Canary": "com.google.Chrome.canary",
        "Chromium": "org.chromium.Chromium",
        "Brave": "com.brave.Browser",
        "Edge": "com.microsoft.edgemac",
        "Arc": "company.thebrowser.Browser",
        "Vivaldi": "com.vivaldi.Vivaldi",
        "Opera": "com.operasoftware.Opera",
    ]
    public static func bundleID(for browser: String) -> String? { bundleIDs[browser] }

    /// What to tell the person when the browser's app can't be found to open its page for them.
    public static func openYourselfMessage(for browser: String) -> String {
        "Open \(browser) and go to \(extensionsAddress(for: browser)) yourself, then drag the folder from the panel onto the page."
    }

    /// Every Chromium browser takes `chrome://extensions` as an address.
    public static let extensionsAddress = "chrome://extensions"

    /// The page's address in the browser's own scheme where it has one; every other Chromium browser takes chrome://.
    public static func extensionsAddress(for browser: String) -> String {
        switch browser {
        case "Brave": "brave://extensions"
        case "Edge": "edge://extensions"
        case "Vivaldi": "vivaldi://extensions"
        case "Opera": "opera://extensions"
        default: extensionsAddress
        }
    }

    /// The environment the helper runs in from the app: the person's own, plus nothing that points at a Node.
    public static func environment(base: [String: String], home: String = NSHomeDirectory(), loginPath: String? = nil) -> [String: String] {
        var env = base
        env["NO_COLOR"] = "1"
        env["PATH"] = path(base: base["PATH"], loginPath: loginPath, home: home)
        return env
    }

    /// The login shell's PATH, or nil if the shell fails or doesn't finish within `timeout` seconds. The deadline covers the
    /// read as well as the process: a login profile that leaves a background process holding the pipe open can't hang this.
    public static func readLoginPath(shell: URL, timeout: TimeInterval = 3) -> String? {
        let p = Process()
        p.executableURL = shell
        p.arguments = ["-l", "-c", "printf %s \"$PATH\""]
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = FileHandle.nullDevice; p.standardInput = FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in exited.signal() }
        do { try p.run() } catch { return nil }
        // Read off this thread; whatever has arrived by the deadline is all there is.
        let box = LoginPathBox()
        let reading = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            let d = pipe.fileHandleForReading.readDataToEndOfFile()
            box.set(d)
            reading.signal()
        }
        let deadline = DispatchTime.now() + timeout
        guard exited.wait(timeout: deadline) == .success else { p.terminate(); try? pipe.fileHandleForReading.close(); return nil }
        // The shell is done; its output is complete unless something it started still holds the pipe, so wait only to the deadline.
        guard reading.wait(timeout: deadline) == .success, p.terminationStatus == 0 else { try? pipe.fileHandleForReading.close(); return nil }
        return String(decoding: box.get(), as: UTF8.self)
    }

    private final class LoginPathBox: @unchecked Sendable {
        private let lock = NSLock(); private var data = Data()
        func set(_ d: Data) { lock.lock(); data = d; lock.unlock() }
        func get() -> Data { lock.lock(); defer { lock.unlock() }; return data }
    }

    /// An app started from Finder or at login has the bare GUI PATH, so `tabkyra`, node or npm folders are not found and an
    /// MCP entry with a bare command looks stale. The helper gets the person's login-shell PATH when it is known, then the
    /// usual per-user folders, then what the app has. Relative entries are dropped; each folder appears once.
    public static func path(base: String?, loginPath: String?, home: String) -> String {
        var seen = Set<String>(), out: [String] = []
        let extra = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        for dir in ((loginPath ?? "").split(separator: ":").map(String.init)) + extra + ((base ?? "").split(separator: ":").map(String.init))
        where dir.hasPrefix("/") && seen.insert(dir).inserted { out.append(dir) }
        return out.joined(separator: ":")
    }
}
