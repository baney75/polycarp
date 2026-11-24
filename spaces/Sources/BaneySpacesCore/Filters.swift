import Foundation

// Feed filters and page edits for Polycarp's browser extension (docs/guide.md, "Filters"). filters.json, beside
// bangs.json, holds rules; the extension asks the new tab host for them (`{"op":"filters"}`) and hides the posts that
// match on X, YouTube, Reddit, Hacker News, Bluesky, LinkedIn and Mastodon behind a Show bar, and the page parts a
// rule's `hide` selectors name on its sites. `polycarp-spaces filters` and the MCP tools edit the file; every write is
// checked whole and goes in at once, so a refusal writes nothing.

/// One rule, normalized: sites lowercased with no scheme or leading "www.", accounts with no leading "@".
public struct FilterRule: Equatable, Sendable {
    public var id: String
    public var enabled = true
    /// Hosts; empty means every site.
    public var sites: [String] = []
    public var words: [String] = []
    /// JavaScript regular expression sources.
    public var patterns: [String] = []
    public var accounts: [String] = []
    /// A subset of `Filters.kinds`.
    public var kinds: [String] = []
    /// CSS selectors of page parts to hide on `sites`.
    public var hide: [String] = []

    public init(id: String) { self.id = id }

    /// Every key, so the extension never has to supply a default.
    public var value: SurfaceValue {
        func list(_ l: [String]) -> SurfaceValue { .array(l.map(SurfaceValue.string)) }
        return .object(["id": .string(id), "enabled": .bool(enabled), "sites": list(sites), "words": list(words),
                        "patterns": list(patterns), "accounts": list(accounts), "kinds": list(kinds), "hide": list(hide)])
    }
}

extension SurfacesIssue: Error {}

public enum Filters {
    /// Why one entry was refused; the caller adds where it is.
    struct Why: Error { let message: String; init(_ m: String) { message = m } }


    public static let name = "filters.json"
    public static let maxBytes = 256 * 1024
    public static let maxRules = 200
    public static let maxEntries = 200
    public static let maxChars = 200
    public static let maxID = 64
    public static let kinds = ["shorts", "promoted", "reposts"]
    static let ruleKeys: Set = ["id", "enabled", "sites", "words", "patterns", "accounts", "kinds", "hide"]

    /// filters.json in the support folder, beside bangs.json.
    public static func file(supportDir: URL) -> URL { supportDir.appendingPathComponent(name) }

    /// The file the command and the new tab host use: in the folder that holds surfaces.json, which is the support
    /// folder (`POLYCARP_SURFACES_FILE` moves both, for tests).
    public static func path(surfacesFile: String = SurfacesFile.path()) -> String {
        file(supportDir: URL(fileURLWithPath: surfacesFile).deletingLastPathComponent()).path
    }

    // MARK: Checking

    /// One rule from JSON, checked and normalized. `at` prefixes each issue's path (`filters[2].`).
    public static func rule(_ v: SurfaceValue, at prefix: String = "") -> Result<FilterRule, SurfacesIssue> {
        func bad(_ field: String, _ m: String) -> Result<FilterRule, SurfacesIssue> { .failure(SurfacesIssue(prefix + field, m)) }
        let whole = prefix.isEmpty ? "$" : String(prefix.dropLast())
        guard let o = v.object else { return .failure(SurfacesIssue(whole, "a rule is a JSON object, not \(v.kind)")) }
        if let k = o.keys.sorted().first(where: { !ruleKeys.contains($0) }) {
            return bad(k, "is not a rule field (they are id, enabled, sites, words, patterns, accounts, kinds, hide)")
        }
        guard let id = o["id"]?.string else { return bad("id", "is required: 1 to \(maxID) of a-z, 0-9 and -") }
        guard (1...maxID).contains(id.count), id.allSatisfy({ ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }) else {
            return bad("id", "\"\(id)\" must be 1 to \(maxID) of a-z, 0-9 and -")
        }
        var r = FilterRule(id: id)
        if let e = o["enabled"] {
            guard let b = e.bool else { return bad("enabled", "must be true or false, not \(e.kind)") }
            r.enabled = b
        }
        func list(_ key: String, _ norm: (String) -> Result<String, Why>) -> Result<[String], SurfacesIssue> {
            guard let raw = o[key] else { return .success([]) }
            guard let items = raw.array else { return .failure(SurfacesIssue(prefix + key, "must be a list of strings, not \(raw.kind)")) }
            guard items.count <= maxEntries else { return .failure(SurfacesIssue(prefix + key, "has \(items.count) entries; at most \(maxEntries)")) }
            var out: [String] = []
            for (i, item) in items.enumerated() {
                let at = prefix + "\(key)[\(i)]"
                guard let s = item.string else { return .failure(SurfacesIssue(at, "must be a string, not \(item.kind)")) }
                guard s.count <= maxChars else { return .failure(SurfacesIssue(at, "is \(s.count) characters; at most \(maxChars)")) }
                switch norm(s) {
                case .failure(let m): return .failure(SurfacesIssue(at, m.message))
                case .success(let n): if !out.contains(n) { out.append(n) }
                }
            }
            return .success(out)
        }
        let checks: [(String, (String) -> Result<String, Why>, WritableKeyPath<FilterRule, [String]>)] = [
            ("sites", site, \.sites), ("words", word, \.words), ("patterns", pattern, \.patterns),
            ("accounts", account, \.accounts), ("kinds", kind, \.kinds), ("hide", selector, \.hide),
        ]
        for (key, norm, path) in checks {
            switch list(key, norm) {
            case .failure(let issue): return .failure(issue)
            case .success(let l): r[keyPath: path] = l
            }
        }
        if r.words.isEmpty && r.patterns.isEmpty && r.accounts.isEmpty && r.kinds.isEmpty && r.hide.isEmpty {
            return .failure(SurfacesIssue(whole, "a rule needs at least one of words, patterns, accounts, kinds or hide"))
        }
        if !r.hide.isEmpty && r.sites.isEmpty {
            return bad("hide", "hides page parts only on named sites: give sites too")
        }
        return .success(r)
    }

    /// A host: lowercased, any scheme and path dropped, then a leading "www." dropped.
    static func site(_ s: String) -> Result<String, Why> {
        var t = s.trimmingCharacters(in: .whitespaces).lowercased()
        if let r = t.range(of: "://") { t = String(t[r.upperBound...]) }
        if let end = t.firstIndex(where: { "/?#".contains($0) }) { t = String(t[..<end]) }
        if t.hasPrefix("www.") { t = String(t.dropFirst(4)) }
        let labels = t.split(separator: ".", omittingEmptySubsequences: false)
        guard !t.isEmpty, labels.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") } }) else {
            return .failure(Why("\"\(s)\" is not a host such as x.com or youtube.com"))
        }
        return .success(t)
    }

    static func word(_ s: String) -> Result<String, Why> {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? .failure(Why("is empty")) : .success(t)
    }

    static func pattern(_ s: String) -> Result<String, Why> {
        s.isEmpty ? .failure(Why("is empty")) : .success(s)
    }

    /// A handle: a leading "@" dropped, lowercased.
    static func account(_ s: String) -> Result<String, Why> {
        var t = s.trimmingCharacters(in: .whitespaces).lowercased()
        if t.hasPrefix("@") { t.removeFirst() }
        guard !t.isEmpty, !t.contains(where: { $0.isWhitespace }) else { return .failure(Why("\"\(s)\" is not a handle such as @name")) }
        return .success(t)
    }

    static func kind(_ s: String) -> Result<String, Why> {
        let t = s.trimmingCharacters(in: .whitespaces).lowercased()
        return kinds.contains(t) ? .success(t) : .failure(Why("\"\(s)\" is not a kind; the kinds are \(kinds.joined(separator: ", "))"))
    }

    /// A CSS selector, which the extension puts in a style rule of its own: no braces, semicolons or line breaks.
    static func selector(_ s: String) -> Result<String, Why> {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return .failure(Why("is empty")) }
        guard !t.contains(where: { "{};".contains($0) || $0.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) } }) else {
            return .failure(Why("\"\(s)\" is not one CSS selector: it may not hold {, }, ; or a line break"))
        }
        return .success(t)
    }

    /// A whole file: `{"version":1,"filters":[rule...]}`, each rule checked, ids unique.
    public static func parse(_ data: Data) -> Result<[FilterRule], SurfacesIssue> {
        guard data.count <= maxBytes else { return .failure(SurfacesIssue("$", "\(name) is over \(maxBytes) bytes")) }
        guard case .success(let tree) = SurfaceValue.parse(data), let o = tree.object else {
            return .failure(SurfacesIssue("$", "\(name) is not a JSON object"))
        }
        if let k = o.keys.sorted().first(where: { $0 != "version" && $0 != "filters" }) {
            return .failure(SurfacesIssue(k, "is not a field of \(name) (it holds version and filters)"))
        }
        guard o["version"]?.integer == 1 else { return .failure(SurfacesIssue("version", "must be 1")) }
        guard let list = o["filters"]?.array else { return .failure(SurfacesIssue("filters", "must be a list of rules")) }
        guard list.count <= maxRules else { return .failure(SurfacesIssue("filters", "has \(list.count) rules; at most \(maxRules)")) }
        var rules: [FilterRule] = []
        for (i, v) in list.enumerated() {
            switch rule(v, at: "filters[\(i)].") {
            case .failure(let issue): return .failure(issue)
            case .success(let r):
                if let j = rules.firstIndex(where: { $0.id == r.id }) {
                    return .failure(SurfacesIssue("filters[\(i)].id", "\"\(r.id)\" is already the id of filters[\(j)]"))
                }
                rules.append(r)
            }
        }
        return .success(rules)
    }

    /// The rules in the file at `path`: none when it is missing.
    public static func load(path: String) -> Result<[FilterRule], SurfacesIssue> {
        switch PolycarpThemeFile.bytes(path: path, limit: maxBytes) {
        case .missing: return .success([])
        case .rejected(let why), .failed(let why): return .failure(SurfacesIssue("$", "\(name) is \(why)"))
        case .data(let data): return parse(data)
        }
    }

    public static func document(_ rules: [FilterRule]) -> SurfaceValue {
        .object(["version": .number(1), "filters": .array(rules.map(\.value))])
    }

    /// Writes the whole file at once (`SurfacesFile.write`: a temp file, flushed, renamed over it).
    public static func save(_ rules: [FilterRule], to path: String) throws {
        guard rules.count <= maxRules else { throw SurfacesFile.WriteError("\(rules.count) rules; at most \(maxRules)") }
        try SurfacesFile.write(document(rules), to: path, limit: maxBytes)
    }
}
