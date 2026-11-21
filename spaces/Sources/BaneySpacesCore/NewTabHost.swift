import Darwin
import Foundation

/// The new tab page's native messaging host (docs/newtab.md). The page, a small Chrome extension, asks Polycarp what to
/// show with `chrome.runtime.sendNativeMessage`; Chrome starts `polycarp-spaces` with the page's origin as its first
/// argument, writes one framed request on stdin and reads one framed reply on stdout. Everything here is pure or takes
/// its inputs (`Source`, file descriptors, a home folder), so tests need no app and no browser.
public enum NewTabHost {
    /// The host's name, as the page and the manifest say it.
    public static let name = "com.polycarp.newtab"
    /// The page's extension ID, fixed by the `key` in its manifest.
    public static let extensionID = "kdaddaaobomjfjcgjeabgbenfddkcfcl"
    /// The one caller the manifest allows, and the first argument Chrome starts the host with.
    public static let origin = "chrome-extension://\(extensionID)/"
    public static let manifestFile = "\(name).json"
    /// The explicit command, for trying the host by hand.
    public static let command = "newtab-host"
    /// The largest request read. The page's requests are a few dozen bytes; this only keeps a bad length from
    /// allocating gigabytes. Chrome caps a host's reply at 1 MB, and ours are far under it.
    public static let maxMessage = 1 << 20

    /// Whether the command line is Chrome starting the host: its first argument is a `chrome-extension://` origin.
    public static func startedByBrowser(_ arguments: [String]) -> Bool {
        arguments.dropFirst().first?.hasPrefix("chrome-extension://") ?? false
    }

    // MARK: Framing

    /// One message as Chrome frames it: a 4-byte native-endian (little-endian on a Mac) length, then the bytes.
    public static func encode(_ message: Data) -> Data {
        var n = UInt32(message.count).littleEndian
        var out = Data(bytes: &n, count: 4)
        out.append(message)
        return out
    }

    /// The first message in `data`, or nil when the bytes stop short of the length or the length is over `maxMessage`.
    public static func decode(_ data: Data) -> Data? {
        guard data.count >= 4 else { return nil }
        let start = data.startIndex
        let n = data[start..<start + 4].enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
        guard Int(n) <= maxMessage, data.count - 4 >= Int(n) else { return nil }
        return Data(data[start + 4..<start + 4 + Int(n)])
    }

    /// Reads one framed message from `fd`. Nil when the input ends early or the length is over `maxMessage`.
    public static func readMessage(fd: Int32) -> Data? {
        guard let header = readExactly(fd, 4) else { return nil }
        let n = header.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
        guard Int(n) <= maxMessage else { return nil }
        if n == 0 { return Data() }
        return readExactly(fd, Int(n))
    }

    private static func readExactly(_ fd: Int32, _ count: Int) -> Data? {
        var out = Data(capacity: count)
        var buf = [UInt8](repeating: 0, count: min(count, 65536))
        while out.count < count {
            let n = read(fd, &buf, min(buf.count, count - out.count))
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { return nil }
            out.append(contentsOf: buf[0..<n])
        }
        return out
    }

    /// Reads one request from `input`, answers it on `output`, and says whether it did. Writes nothing else.
    @discardableResult
    public static func serve(input: Int32, output: Int32, source: Source) -> Bool {
        guard let request = readMessage(fd: input) else { return false }
        return Wire.writeAll(output, encode(answer(request, source: source)))
    }

    // MARK: Requests

    /// What a request needs from the world: surfaces.json, the running app's purposes, and the time.
    public struct Source {
        /// surfaces.json as it is now (defaults when it is missing or invalid).
        public var surfaces: () -> Surfaces
        /// One purpose request to the running app (`Wire.Request.Op.purpose`): the subcommand and its arguments, as
        /// `polycarp-spaces purpose` sends them. Nil when the app isn't running or didn't answer.
        public var purpose: (_ text: String, _ args: [String]) -> Wire.Reply?
        public var now: () -> Date
        public var timeZone: TimeZone
        /// Opens a `polycarp://` link, which the app runs (`switch/N`); whether it was handed over.
        public var open: (URL) -> Bool

        public init(surfaces: @escaping () -> Surfaces, purpose: @escaping (String, [String]) -> Wire.Reply?,
                    now: @escaping () -> Date = Date.init, timeZone: TimeZone = .current,
                    open: @escaping (URL) -> Bool = { _ in false }) {
            self.surfaces = surfaces; self.purpose = purpose; self.now = now; self.timeZone = timeZone; self.open = open
        }

        /// The real one: surfaces.json from disk the way `polycarp-spaces surfaces get` reads it (the app need not be
        /// running), and the app's socket the way `polycarp-spaces purpose` reaches it.
        public static func live(timeout: Double = 2) -> Source {
            Source(surfaces: {
                if case .document(let d) = SurfacesFile.load(path: SurfacesFile.path()) { return d.surfaces }
                return Surfaces.defaults
            }, purpose: { text, args in
                Wire.call(Wire.Request(op: .purpose, text: text, args: args, caller: "newtab"), timeout: timeout)
            }, open: { url in
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                p.arguments = ["-g", url.absoluteString]
                p.standardOutput = FileHandle.nullDevice
                p.standardError = FileHandle.nullDevice
                guard (try? p.run()) != nil else { return false }
                p.waitUntilExit()
                return p.terminationStatus == 0
            })
        }
    }

    public static let notRunning = "Polycarp isn't running, so it can't name this workspace"
    public static let noSwitch = "Polycarp couldn't switch workspaces"

    /// The reply to one request, as the JSON bytes that go back to the page.
    public static func answer(_ request: Data, source: Source) -> Data {
        guard let object = (try? JSONSerialization.jsonObject(with: request)) as? [String: Any] else {
            return failure("the request isn't a JSON object")
        }
        switch object["op"] as? String {
        case "page": return page(source)
        case "name":
            guard let text = object["text"] as? String else { return failure("name needs text") }
            return name(text, source)
        case "go":
            // The same link the shortcuts' scripts use (`AppDelegate.runURL`); the app does the switch.
            guard let n = object["workspace"] as? Int, Workspaces.range.contains(n) else {
                return failure("go needs a workspace from \(Workspaces.range.lowerBound) to \(Workspaces.range.upperBound)")
            }
            guard let url = switchURL(n), source.open(url) else { return failure(noSwitch) }
            return json(["ok": true, "workspace": n])
        case let op?: return failure("there is no request called \(op)")
        case nil: return failure("the request has no op")
        }
    }

    private static func page(_ source: Source) -> Data {
        let s = source.surfaces().newtab
        let listing = source.purpose("list", []).flatMap(PurposeAPI.decodeListing)
        var reply: [String: Any] = ["ok": true, "question": s.question, "searchURL": s.searchURL]
        if s.verse, let v = Verses.pick(.daily, at: source.now(), timeZone: source.timeZone) {
            reply["verse"] = ["text": v.text, "ref": v.ref]
        } else {
            reply["verse"] = NSNull()
        }
        reply["workspace"] = listing.map { $0.current as Any } ?? NSNull()
        reply["purpose"] = listing.flatMap { l in l.workspaces.first { $0.workspace == l.current }?.purpose } ?? NSNull()
        reply["oneThing"] = listing?.one?.text ?? NSNull()
        let named = (listing?.workspaces ?? []).filter { $0.purpose != nil }.sorted { $0.workspace < $1.workspace }
        reply["chips"] = s.chips ? named.map { ["workspace": $0.workspace, "purpose": $0.purpose ?? ""] as [String: Any] } : []
        return json(reply)
    }

    private static func name(_ text: String, _ source: Source) -> Data {
        guard Purposes.clean(text, limit: .max) != nil else { return failure("type a few words to name this workspace") }
        guard let list = source.purpose("list", []) else { return failure(notRunning) }
        guard let current = PurposeAPI.decodeListing(list)?.current else { return failure(list.error ?? "Polycarp didn't say which workspace you are on") }
        guard let set = source.purpose("set", ["\(current)", text]) else { return failure(notRunning) }
        guard set.ok else { return failure(set.error ?? "Polycarp couldn't name this workspace") }
        let purpose = PurposeAPI.decodeListing(set)?.workspaces.first { $0.workspace == current }?.purpose
            ?? Purposes.clean(text, limit: .max) ?? text
        return json(["ok": true, "workspace": current, "purpose": purpose])
    }

    /// The link that switches Polycarp to workspace `n`.
    public static func switchURL(_ n: Int) -> URL? { URL(string: "polycarp://switch/\(n)") }

    public static func failure(_ error: String) -> Data { json(["ok": false, "error": error]) }

    static func json(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]))
            ?? Data(#"{"ok":false,"error":"the reply couldn't be written"}"#.utf8)
    }

    // MARK: Registration

    /// The browsers' own folders, under the home folder, in the order they are written: Helium, Chrome, Chromium.
    public static let browserFolders = [
        "Library/Application Support/net.imput.helium",
        "Library/Application Support/Google/Chrome",
        "Library/Application Support/Chromium",
    ]

    /// The browsers' names for a log line, by folder.
    public static func browserName(_ folder: String) -> String {
        switch (folder as NSString).lastPathComponent {
        case "net.imput.helium": "Helium"
        case "Chrome": "Chrome"
        default: "Chromium"
        }
    }

    /// The host manifest for the command at `path`.
    public static func manifest(path: String) -> Data {
        let object: [String: Any] = ["name": name, "description": "Polycarp's new tab page", "path": path, "type": "stdio",
                                     "allowed_origins": [origin]]
        var data = (try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])) ?? Data()
        data.append(0x0A)
        return data
    }

    /// Where the manifest goes: `<browser folder>/NativeMessagingHosts/com.polycarp.newtab.json` for each browser folder in
    /// `existing` (absolute paths), Helium first. A browser whose own folder isn't there is left alone.
    public static func targets(home: URL, existing: Set<String>) -> [URL] {
        browserFolders.map { home.appendingPathComponent($0, isDirectory: true) }
            .filter { existing.contains($0.path) }
            .map { $0.appendingPathComponent("NativeMessagingHosts", isDirectory: true).appendingPathComponent(manifestFile) }
    }

    /// What `register` did, for one log line.
    public struct Registration: Equatable, Sendable {
        public var written: [String] = []
        public var current: [String] = []
        public var failed: [String] = []

        public var line: String {
            if written.isEmpty && current.isEmpty && failed.isEmpty { return "newtab host: no Helium, Chrome or Chromium folder, nothing registered" }
            var parts: [String] = []
            if !written.isEmpty { parts.append("written for \(written.joined(separator: ", "))") }
            if !current.isEmpty { parts.append("already current for \(current.joined(separator: ", "))") }
            if !failed.isEmpty { parts.append("failed for \(failed.joined(separator: ", "))") }
            return "newtab host: manifest " + parts.joined(separator: "; ")
        }
    }

    /// Writes the manifest for the command at `cliPath` into each browser folder under `home` that exists, only where
    /// the file's content differs. Makes `NativeMessagingHosts` when missing, never a browser's own folder.
    public static func register(cliPath: String, home: URL, fileManager fm: FileManager = .default) -> Registration {
        var isDir: ObjCBool = false
        let existing = Set(browserFolders.map { home.appendingPathComponent($0, isDirectory: true).path }.filter {
            fm.fileExists(atPath: $0, isDirectory: &isDir) && isDir.boolValue
        })
        let content = manifest(path: cliPath)
        var result = Registration()
        for target in targets(home: home, existing: existing) {
            let browser = browserName(target.deletingLastPathComponent().deletingLastPathComponent().path)
            if fm.contents(atPath: target.path) == content { result.current.append(browser); continue }
            do {
                let hosts = target.deletingLastPathComponent()
                if !fm.fileExists(atPath: hosts.path) { try fm.createDirectory(at: hosts, withIntermediateDirectories: false) }
                try content.write(to: target, options: .atomic)
                result.written.append(browser)
            } catch {
                result.failed.append(browser)
            }
        }
        return result
    }
}
