import Foundation

/// The extensions folder: every `*/extension.toml` in it, read again when a manifest changes.
public final class LauncherExtensionStore {
    public let folder: URL
    public private(set) var extensions: [ScriptExtension] = []
    /// A line per folder that couldn't be read, and why.
    public private(set) var problems: [String] = []
    private var stamps: [String: Date] = [:]

    public init(folder: URL) { self.folder = folder }

    public static func defaultFolder(env: [String: String] = ProcessInfo.processInfo.environment) -> URL? {
        PolycarpThemeFile.configDir(env: { env[$0] }, home: env["HOME"] ?? NSHomeDirectory())
            .map { URL(fileURLWithPath: $0).appendingPathComponent("extensions", isDirectory: true) }
    }

    /// A stat per manifest; parses only when one is new, gone or changed.
    public func refresh() {
        let fm = FileManager.default
        let names = ((try? fm.contentsOfDirectory(atPath: folder.path)) ?? []).filter { !$0.hasPrefix(".") }.sorted()
        var now: [String: Date] = [:]
        for n in names {
            let m = folder.appendingPathComponent(n).appendingPathComponent(ScriptExtension.manifestName).path
            if let d = (try? fm.attributesOfItem(atPath: m))?[.modificationDate] as? Date { now[n] = d }
        }
        guard now != stamps else { return }
        stamps = now
        var exts: [ScriptExtension] = []
        var probs: [String] = []
        var keywords = Set<String>()
        for n in now.keys.sorted() {
            let dir = folder.appendingPathComponent(n, isDirectory: true)
            do {
                let text = try String(contentsOf: dir.appendingPathComponent(ScriptExtension.manifestName), encoding: .utf8)
                let e = try ScriptExtension.parse(text, id: n, folder: dir)
                guard keywords.insert(e.keyword.lowercased()).inserted else { throw ScriptExtension.Problem("keyword \(e.keyword) is taken") }
                exts.append(e)
            } catch {
                probs.append("\(n): \(error)")
            }
        }
        extensions = exts
        problems = probs
    }

    public func createFolder() -> Bool {
        (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)) != nil
    }
}

/// Extensions in the launcher. Typing a keyword and a space offers to run it with what follows; Return runs
/// it (never on a keystroke) and its output takes the top rows for as long as that text stays typed.
public final class ExtensionProvider: LauncherMenuProvider {
    public let name = "extensions"
    public let menu = "extensions"
    let store: LauncherExtensionStore
    /// The last run's rows, for the text it ran on.
    private var shown: (query: String, rows: [LauncherResult])?
    private var running: (query: String, id: String)?
    private var scanned: Date?
    private let now: () -> Date

    public init(store: LauncherExtensionStore, now: @escaping () -> Date = Date.init) {
        self.store = store
        self.now = now
    }

    public func opened() { rescan(force: true) }

    /// A folder listing and a stat per manifest, at most every two seconds while typing.
    private func rescan(force: Bool = false) {
        let t = now()
        if !force, let s = scanned, t.timeIntervalSince(s) < 2 { return }
        scanned = t
        store.refresh()
    }

    /// The extension a query calls, and what goes to it: "wc some words" is (wc, "some words").
    public func match(_ query: String) -> (ScriptExtension, String)? {
        let t = query.trimmingCharacters(in: .whitespaces)
        let word = t.split(separator: " ", maxSplits: 1).first.map(String.init) ?? ""
        guard let e = store.extensions.first(where: { $0.keyword.caseInsensitiveCompare(word) == .orderedSame }) else { return nil }
        return (e, String(t.dropFirst(word.count)).trimmingCharacters(in: .whitespaces))
    }

    /// The text a run is known by: the keyword, a space and the input, however it was spaced when typed.
    static func key(_ e: ScriptExtension, _ input: String) -> String { input.isEmpty ? e.keyword : "\(e.keyword) \(input)" }

    public func results(for query: String) -> [LauncherResult] {
        rescan()
        if let (e, input) = match(query) {
            let key = Self.key(e, input)
            if let s = shown, s.query == key { return s.rows }
            if let r = running, r.query == key {
                return [LauncherResult(id: "ext:\(e.id)", section: "Extensions", title: "\(e.title)…", subtitle: "Running",
                                       symbol: "hourglass", placement: .top, action: .none)]
            }
            return [runRow(e, input: input, placement: .top)]
        }
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { return [] }
        return store.extensions.filter { max(Fuzzy.score(q, $0.title) ?? 0, Fuzzy.score(q, $0.keyword) ?? 0) >= 500 }
            .map { runRow($0, input: "", placement: .normal) }
    }

    public func listing(_ query: String) -> [LauncherResult] {
        rescan(force: true)
        let q = query.trimmingCharacters(in: .whitespaces)
        let rows = store.extensions.filter { q.isEmpty || Fuzzy.score(q, $0.title) != nil || Fuzzy.score(q, $0.keyword) != nil }
            .map { e in
                LauncherResult(id: "ext-pick:\(e.id)", section: "Extensions", title: e.title,
                               subtitle: "\(e.keyword) · \(e.description.isEmpty ? e.folder.lastPathComponent : e.description)",
                               symbol: "puzzlepiece.extension", badge: "⇥", action: .fill("\(e.keyword) "))
            }
        let problems = store.problems.enumerated().map { n, p in
            LauncherResult(id: "ext-problem:\(n)", section: "Problems", title: p, subtitle: store.folder.path,
                           symbol: "exclamationmark.triangle", action: .none)
        }
        let open = LauncherResult(id: "ext-folder", section: "Your extensions", title: "Open Extensions Folder…",
                                  subtitle: "Each folder holds an extension.toml and its script", symbol: "folder",
                                  action: .command(provider: name, id: "folder"))
        return rows + problems + [open]
    }

    public func perform(_ command: String) -> LauncherAction? {
        guard command == "folder", store.createFolder() else { return nil }
        return .open(store.folder)
    }

    /// Runs the extension `query` calls, off the main thread; `done` comes back on main when its rows are in.
    public func run(_ query: String, done: @escaping () -> Void) {
        guard let (e, input) = match(query) else { return }
        let query = Self.key(e, input)
        running = (query, e.id)
        DispatchQueue.global(qos: .userInitiated).async {
            let result = ExtensionRunner.run(e, input: input)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.running = nil
                self.shown = (query, ExtensionOutput.rows(result, of: e))
                done()
            }
        }
    }

    private func runRow(_ e: ScriptExtension, input: String, placement: LauncherResult.Placement) -> LauncherResult {
        LauncherResult(id: "ext:\(e.id)", section: "Extensions", title: e.title,
                       subtitle: input.isEmpty ? "\(e.keyword) · Return runs it" : "Return runs it with “\(input)”",
                       symbol: "puzzlepiece.extension", badge: "Run", placement: placement,
                       action: .runExtension(query: Self.key(e, input)))
    }
}
