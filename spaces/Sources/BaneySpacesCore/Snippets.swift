import Foundation

/// Text you type often, kept in `snippets.toml` in the Polycarp config folder. Typing a snippet's
/// keyword in the launcher puts it first; Return pastes it into the app you were in. No keystroke
/// monitor: snippets expand only through the launcher.
public struct Snippet: Equatable, Sendable {
    public let keyword: String
    public let name: String
    public let text: String

    public init(keyword: String, name: String, text: String) {
        self.keyword = keyword
        self.name = name
        self.text = text
    }

    /// The text with `{date}`, `{time}`, `{datetime}`, `{weekday}` and `{year}` filled in for `now`.
    /// Anything else in braces stays as written.
    public func expanded(now: Date = Date(), calendar: Calendar = .current) -> String {
        guard text.contains("{") else { return text }
        func f(_ pattern: String) -> String {
            let d = DateFormatter()
            d.calendar = calendar
            d.timeZone = calendar.timeZone
            d.locale = Locale(identifier: "en_US_POSIX")
            d.dateFormat = pattern
            return d.string(from: now)
        }
        return text
            .replacingOccurrences(of: "{datetime}", with: f("yyyy-MM-dd HH:mm"))
            .replacingOccurrences(of: "{date}", with: f("yyyy-MM-dd"))
            .replacingOccurrences(of: "{time}", with: f("HH:mm"))
            .replacingOccurrences(of: "{weekday}", with: f("EEEE"))
            .replacingOccurrences(of: "{year}", with: f("yyyy"))
    }
}

public enum SnippetFile {
    public static let name = "snippets.toml"

    /// What a new file starts with: the format, by example.
    public static let starter = """
    # Polycarp snippets. Type a keyword in the launcher; Return pastes the text into the app you were in.
    # {date}, {time}, {datetime}, {weekday} and {year} are filled in when it pastes.

    [[snippet]]
    keyword = ";date"
    name = "Today's date"
    text = "{date}"

    [[snippet]]
    keyword = ";shrug"
    name = "Shrug"
    text = '¯\\_(ツ)_/¯'

    """

    /// Every snippet in the file's text, and a line per problem (a bad entry is skipped, not fatal).
    public static func parse(_ text: String) -> (snippets: [Snippet], problems: [String]) {
        let doc: [String: LauncherTOML.Value]
        do { doc = try LauncherTOML.parse(text) } catch { return ([], ["\(name) \(error)"]) }
        var out: [Snippet] = []
        var problems: [String] = []
        var seen = Set<String>()
        for (n, v) in (doc["snippet"]?.array ?? []).enumerated() {
            guard let t = v.table, let keyword = t["keyword"]?.string?.trimmingCharacters(in: .whitespaces), !keyword.isEmpty,
                  let body = t["text"]?.string else {
                problems.append("snippet \(n + 1) needs a keyword and a text")
                continue
            }
            guard !keyword.contains(" ") else { problems.append("snippet \(n + 1): a keyword can't hold a space"); continue }
            guard seen.insert(keyword.lowercased()).inserted else { problems.append("snippet \(n + 1): \(keyword) is used twice"); continue }
            out.append(Snippet(keyword: keyword, name: t["name"]?.string ?? keyword, text: body))
        }
        return (out, problems)
    }
}

/// The snippets file, read again only when it changed on disk.
public final class SnippetStore {
    public let file: URL
    private var stamp: Date?
    private var size: Int?
    public private(set) var snippets: [Snippet] = []
    public private(set) var problems: [String] = []

    public init(file: URL) { self.file = file }

    /// The file in the config folder (`polycarp theme` rules), or nil when there is no home.
    public static func defaultFile(env: [String: String] = ProcessInfo.processInfo.environment) -> URL? {
        PolycarpThemeFile.configDir(env: { env[$0] }, home: env["HOME"] ?? NSHomeDirectory())
            .map { URL(fileURLWithPath: $0).appendingPathComponent(SnippetFile.name) }
    }

    /// One stat; a parse only when the file's date or size moved.
    public func refresh() {
        let a = try? FileManager.default.attributesOfItem(atPath: file.path)
        let d = a?[.modificationDate] as? Date
        let s = (a?[.size] as? NSNumber)?.intValue
        guard d != stamp || s != size else { return }
        stamp = d
        size = s
        guard d != nil, let text = try? String(contentsOf: file, encoding: .utf8) else {
            snippets = []
            problems = []
            return
        }
        (snippets, problems) = SnippetFile.parse(text)
    }

    /// Makes the file with the starter text when it doesn't exist yet. True when it exists after.
    @discardableResult
    public func createIfMissing() -> Bool {
        let fm = FileManager.default
        if fm.fileExists(atPath: file.path) { return true }
        try? fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        return fm.createFile(atPath: file.path, contents: Data(SnippetFile.starter.utf8))
    }
}

/// Snippets in the launcher: a typed keyword is the first row; a name or keyword that matches comes
/// after the apps. In its own menu, every snippet and a row to edit the file.
public final class SnippetProvider: LauncherMenuProvider {
    public let name = "snippets"
    public let menu = "snippets"
    let store: SnippetStore
    private let now: () -> Date

    public init(store: SnippetStore, now: @escaping () -> Date = Date.init) {
        self.store = store
        self.now = now
    }

    public func opened() { store.refresh() }

    public func results(for query: String) -> [LauncherResult] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return [] }
        store.refresh()
        return store.snippets.compactMap { s in
            if s.keyword.caseInsensitiveCompare(q) == .orderedSame { return row(s, placement: .top) }
            guard q.count >= 2, max(Fuzzy.score(q, s.name) ?? 0, Fuzzy.score(q, s.keyword) ?? 0) >= 500 else { return nil }
            return row(s, placement: .normal)
        }
    }

    public func listing(_ query: String) -> [LauncherResult] {
        store.refresh()
        let q = query.trimmingCharacters(in: .whitespaces)
        let rows = store.snippets
            .filter { q.isEmpty || Fuzzy.score(q, $0.name) != nil || Fuzzy.score(q, $0.keyword) != nil }
            .map { row($0, placement: .normal) }
        let problems = store.problems.enumerated().map { n, p in
            LauncherResult(id: "snippet-problem:\(n)", section: "Problems", title: p, subtitle: store.file.path,
                           symbol: "exclamationmark.triangle", action: .none)
        }
        let edit = LauncherResult(id: "snippet-edit", section: "Your snippets", title: "Edit Snippets File…",
                                  subtitle: store.file.path, symbol: "square.and.pencil",
                                  action: .command(provider: name, id: "edit"))
        return rows + problems + [edit]
    }

    public func perform(_ command: String) -> LauncherAction? {
        guard command == "edit", store.createIfMissing() else { return nil }
        return .open(store.file)
    }

    private func row(_ s: Snippet, placement: LauncherResult.Placement) -> LauncherResult {
        let text = s.expanded(now: now())
        let preview = text.replacingOccurrences(of: "\n", with: " ⏎ ")
        return LauncherResult(id: "snippet:\(s.keyword)", section: "Snippets", title: s.name,
                              subtitle: "\(s.keyword) · \(preview.count > 60 ? String(preview.prefix(60)) + "…" : preview)",
                              symbol: "text.quote", badge: "Paste", placement: placement, action: .paste(text))
    }
}
