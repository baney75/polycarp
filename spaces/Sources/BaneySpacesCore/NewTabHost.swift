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
    /// allocating gigabytes. Chrome caps a host's reply at 1 MB; a paper's picture is sent at most
    /// `PaperImage.newTabBytes`, so a reply stays under it.
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

    /// How long `find` waits for the session engine before it answers with what it has.
    public static let findBudget: TimeInterval = 0.15

    /// What a request needs from the world: surfaces.json, the bangs, the papers' pictures, the filters, the time, and
    /// the running app's session engine.
    public struct Source {
        /// surfaces.json as it is now (defaults when it is missing or invalid).
        public var surfaces: () -> Surfaces
        public var now: () -> Date
        public var timeZone: TimeZone
        /// Every bang in force: bangs.json's, then the built-ins.
        public var bangs: () -> [Bang]
        /// The session engine's rows, waiting at most the given seconds; nil when the app didn't answer in time.
        public var sessions: (TimeInterval) -> [Item]?
        /// Asks Polycarp to bring a row forward (`polycarp-spaces focus`): nil when it isn't running, else its error or nil.
        public var focus: (String) -> Result<String, FocusFailure>
        /// The bundle ID of the browser that started the host (its parent process), so the page can tell its own
        /// tabs from another browser's; nil when it can't be told.
        public var browser: () -> String?
        /// Papers/, where a paper's picture is; nil sends no picture.
        public var papers: PaperStore?
        /// filters.json's rules: none when it is missing, the issue when it doesn't read or check.
        public var filters: () -> Result<[FilterRule], SurfacesIssue>
        /// edits.json's edits, the same way.
        public var edits: () -> Result<[SurfaceValue], SurfacesIssue>

        public struct FocusFailure: Error, Equatable { public let message: String; public init(_ m: String) { message = m } }

        public init(surfaces: @escaping () -> Surfaces, now: @escaping () -> Date = Date.init, timeZone: TimeZone = .current,
                    bangs: @escaping () -> [Bang] = { Bangs.builtIn },
                    sessions: @escaping (TimeInterval) -> [Item]? = { _ in nil },
                    focus: @escaping (String) -> Result<String, FocusFailure> = { _ in .failure(.init("Polycarp isn't running")) },
                    browser: @escaping () -> String? = { nil },
                    papers: PaperStore? = nil,
                    filters: @escaping () -> Result<[FilterRule], SurfacesIssue> = { .success([]) },
                    edits: @escaping () -> Result<[SurfaceValue], SurfacesIssue> = { .success([]) }) {
            self.surfaces = surfaces; self.now = now; self.timeZone = timeZone
            self.bangs = bangs; self.sessions = sessions; self.focus = focus; self.browser = browser
            self.papers = papers; self.filters = filters; self.edits = edits
        }

        /// The real one: surfaces.json and bangs.json from disk the way `polycarp-spaces surfaces get` reads them (the app
        /// need not be running), and the session engine over the app's socket, the path `polycarp-spaces ls` and
        /// `focus` take.
        public static func live() -> Source {
            Source(surfaces: {
                if case .document(let d) = SurfacesFile.load(path: SurfacesFile.path()) { return d.surfaces }
                return Surfaces.defaults
            }, bangs: {
                Bangs.load(supportDir: Product.supportDir(home: FileManager.default.homeDirectoryForCurrentUser))
            }, sessions: { wait in
                guard let r = Wire.call(Wire.Request(op: .list), timeout: max(0.01, wait)), r.ok else { return nil }
                return r.items ?? []
            }, focus: { id in
                guard let r = Wire.call(Wire.Request(op: .focus, target: id), timeout: 2) else { return .failure(.init("Polycarp isn't running")) }
                return r.ok ? .success(r.info?["label"] ?? "") : .failure(.init(r.error ?? "nothing matches"))
            }, browser: { NewTabHost.appBundleID(of: getppid()) },
            papers: PaperStore.beside(surfacesFile: SurfacesFile.path()),
            filters: { Filters.load(path: Filters.path()) },
            edits: { Edits.load(path: Edits.path()) })
        }
    }

    /// The reply to one request, as the JSON bytes that go back to the page.
    public static func answer(_ request: Data, source: Source) -> Data {
        guard let object = (try? JSONSerialization.jsonObject(with: request)) as? [String: Any] else {
            return failure("the request isn't a JSON object")
        }
        switch object["op"] as? String {
        case "page": return page(source)
        case "find": return find(object["q"], source)
        case "focus": return focus(object["id"], source)
        case "filters": return filters(source)
        case "edits": return edits(source)
        case let op?: return failure("there is no request called \(op)")
        case nil: return failure("the request has no op")
        }
    }

    /// The most bangs a `page` reply carries: bangs.json has no size limit of its own, a reply does.
    public static let maxBangs = 500

    private static func page(_ source: Source) -> Data {
        let surfaces = source.surfaces()
        let s = surfaces.newtab
        let bangs = source.bangs()
        let engine = OneSearch.engine(surfaces.search.engine, bangs: bangs)
        // searchURL is the engine in force, so a page from before bangs searches where the launcher does.
        var reply: [String: Any] = ["ok": true, "question": s.question, "searchURL": OneSearch.template(engine),
                                    "engine": bangObject(engine)]
        // No paper, no key: the page clears the one it kept and looks as it did before paper.
        if let paper = surfaces.paper(on: .newtab)?.newTab(store: source.papers) {
            reply["paper"] = paper
        }
        if s.verse, let v = Verses.pick(.daily, at: source.now(), timeZone: source.timeZone) {
            reply["verse"] = ["text": v.text, "ref": v.ref]
        } else {
            reply["verse"] = NSNull()
        }
        reply["bangs"] = bangs.prefix(maxBangs).map(bangObject)
        let data = json(reply)
        if data.count <= maxMessage { return data }
        reply["bangs"] = Bangs.builtIn.map(bangObject)
        return json(reply)
    }

    /// A bang as the page reads it: trigger, name, url with {q}, home when it has one, agent.
    static func bangObject(_ b: Bang) -> [String: Any] {
        var o: [String: Any] = ["trigger": b.trigger, "name": b.name, "url": b.url, "agent": b.isAgent]
        if let home = b.home { o["home"] = home }
        return o
    }

    /// The longest query `find` takes; the field is one line.
    public static let maxQuery = 512

    /// `{"op":"find","q":"..."}`: the session engine's rows that match, best first (`OneSearch.sessions`), from the
    /// running app's list within `findBudget`. `partial` is true when the app didn't answer in time or isn't running.
    private static func find(_ q: Any?, _ source: Source) -> Data {
        guard let q = q as? String else { return failure("find needs q, the text typed") }
        guard q.count <= maxQuery else { return failure("q is over \(maxQuery) characters") }
        let text = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard OneSearch.findsSessions(text) else {
            // Nothing typed, or a bang: nothing to switch to, and no need to ask the app.
            return json(["ok": true, "items": [], "partial": false])
        }
        let items = source.sessions(findBudget)
        let rows = OneSearch.sessions(text, in: items ?? []).map(sessionObject)
        var reply: [String: Any] = ["ok": true, "items": rows, "partial": items == nil]
        if let b = source.browser() { reply["browser"] = b }
        return json(reply)
    }

    static func sessionObject(_ item: Item) -> [String: Any] {
        var o: [String: Any] = ["id": item.id, "kind": item.kind.rawValue, "title": item.label, "app": item.appName,
                                "bundleID": item.bundleID, "activity": "\(item.activity)"]
        if !item.detail.isEmpty { o["detail"] = item.detail }
        if item.workspace > 0 { o["workspace"] = item.workspace }
        return o
    }

    /// `{"op":"focus","id":"tab:..."}`: brings a row from `find` forward through Polycarp, as `polycarp-spaces focus` does.
    private static func focus(_ id: Any?, _ source: Source) -> Data {
        guard let id = id as? String, !id.isEmpty, id.count <= maxQuery else { return failure("focus needs id, a row's id from find") }
        switch source.focus(id) {
        case .success(let label): return json(["ok": true, "label": label])
        case .failure(let f): return failure(f.message)
        }
    }

    /// `{"op":"edits"}`: edits.json's page edits, normalized, for the extension to apply.
    private static func edits(_ source: Source) -> Data {
        switch source.edits() {
        case .success(let edits): return json(["ok": true, "edits": edits.map(\.any)])
        case .failure(let issue): return failure("\(Edits.name) is invalid: \(issue)")
        }
    }

    /// `{"op":"filters"}`: filters.json's rules, normalized, for the extension to hide matching posts and page parts.
    private static func filters(_ source: Source) -> Data {
        switch source.filters() {
        case .success(let rules): return json(["ok": true, "filters": rules.map { $0.value.any }])
        case .failure(let issue): return failure("\(Filters.name) is invalid: \(issue)")
        }
    }

    /// The bundle ID of the app a process belongs to: the outermost `.app` on its executable's path, so a browser's
    /// helper inside its own bundle still names the browser. nil when the path can't be read or holds no app.
    public static func appBundleID(of pid: pid_t) -> String? {
        var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 else { return nil }
        return appBundleID(executable: String(cString: buf))
    }

    static func appBundleID(executable path: String) -> String? {
        var url = URL(fileURLWithPath: path)
        var app: URL?
        while url.path != "/" && !url.path.isEmpty {
            if url.pathExtension == "app" { app = url }
            url.deleteLastPathComponent()
        }
        return app.flatMap { Bundle(url: $0)?.bundleIdentifier }
    }

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
