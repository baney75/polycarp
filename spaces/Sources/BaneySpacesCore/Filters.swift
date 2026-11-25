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
        // Bytes, not Characters: "a" with a combining mark is one Character that sorts between "a" and "z".
        guard (1...maxID).contains(id.utf8.count), id.utf8.allSatisfy({ (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2d }) else {
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

    /// A host: lowercased, any scheme, path and port dropped, then a leading "www." dropped.
    static func site(_ s: String) -> Result<String, Why> {
        host(s).map { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 }
    }

    static func host(_ s: String) -> Result<String, Why> {
        var t = s.trimmingCharacters(in: .whitespaces).lowercased()
        if let r = t.range(of: "://") { t = String(t[r.upperBound...]) }
        if let end = t.firstIndex(where: { "/?#".contains($0) }) { t = String(t[..<end]) }
        if let colon = t.lastIndex(of: ":"), t[t.index(after: colon)...].allSatisfy({ $0.isASCII && $0.isNumber }) {
            t = String(t[..<colon])
        }
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

    /// A JavaScript regular expression source, kept as written. Refused when it is empty or only spaces, when it does
    /// not compile, or when it could make matching one post take very long. That last rule, which the extension holds
    /// patterns to as well, refuses:
    /// - a group repeated by `*`, `+` or `{...}` that holds a quantifier (`*`, `+`, `?` or `{...}`), as `(a+)+$`,
    ///   `(.*a){20}` or `(\d\d?)+$`, at any depth;
    /// - a `{...}` count over 20, as `a{21}` or `a{2,50}`;
    /// - a backreference, `\1` to `\9` or `\k<name>`;
    /// - a lookbehind, `(?<=` or `(?<!`.
    static func pattern(_ s: String) -> Result<String, Why> {
        guard !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .failure(Why("is empty")) }
        // NSRegularExpression (ICU) is a syntax check only. The extension compiles each pattern with JavaScript's
        // RegExp, whose syntax differs at the edges (ICU takes `a++` and `(?>...)`, JavaScript doesn't), so it must
        // still skip a pattern that throws there.
        guard (try? NSRegularExpression(pattern: s)) != nil else {
            return .failure(Why("\"\(s)\" is not a regular expression"))
        }
        if let why = slow(s) { return .failure(Why("\"\(s)\" \(why), which can make matching a long post very slow")) }
        return .success(s)
    }

    static let maxRepeat = 20

    /// Why the pattern `s` breaks the rule in `pattern`, or nil. Expects a source that compiles.
    static func slow(_ s: String) -> String? {
        let c = s.unicodeScalars.map(Character.init)
        /// The `*`, `+`, `?` or `{n}`, `{n,}`, `{n,m}` at `at` (with a lazy `?` after it): where it ends, whether it
        /// repeats (all but `?`), and its largest count. Nil when there is none; a `{` that isn't a count is a literal.
        func quantifier(_ at: Int) -> (end: Int, repeats: Bool, most: Int)? {
            guard at < c.count else { return nil }
            var q: (end: Int, repeats: Bool, most: Int)
            switch c[at] {
            case "*", "+": q = (at + 1, true, 0)
            case "?": q = (at + 1, false, 0)
            case "{":
                guard let close = c[at...].firstIndex(of: "}") else { return nil }
                let parts = String(c[(at + 1)..<close]).split(separator: ",", omittingEmptySubsequences: false)
                guard (1...2).contains(parts.count), !parts[0].isEmpty,
                      parts.allSatisfy({ $0.allSatisfy { $0.isASCII && $0.isNumber } }) else { return nil }
                q = (close + 1, true, parts.compactMap { $0.isEmpty ? nil : Int($0) ?? Int.max }.max() ?? 0)
            default: return nil
            }
            if q.end < c.count && c[q.end] == "?" { q.end += 1 }
            return q
        }
        var held = [false]  // for each open group, the whole pattern first: whether it holds a quantifier
        var i = 0
        while i < c.count {
            switch c[i] {
            case "\\":
                let n = i + 1 < c.count ? c[i + 1] : " "
                if ("1"..."9").contains(n) || (n == "k" && i + 2 < c.count && c[i + 2] == "<") {
                    return "has a backreference"
                }
                i += 2
                // \u{...}, \p{...}, \P{...}, \x{...}: the braces belong to the escape, not a count.
                if "upPx".contains(n), i < c.count, c[i] == "{", let close = c[i...].firstIndex(of: "}") { i = close + 1 }
            case "[":
                var j = i + 1
                while j < c.count && c[j] != "]" { j += c[j] == "\\" ? 2 : 1 }
                i = j + 1
            case "(":
                i += 1
                held.append(false)
                if i < c.count && c[i] == "?" {
                    i += 1
                    if i + 1 < c.count && c[i] == "<" && (c[i + 1] == "=" || c[i + 1] == "!") { return "has a lookbehind" }
                    if i < c.count && c[i] == "<", let close = c[i...].firstIndex(of: ">") { i = close + 1 }
                    else if i < c.count && ":=!".contains(c[i]) { i += 1 }
                }
                continue
            case ")":
                let inner = held.count > 1 ? held.removeLast() : false
                i += 1
                if let q = quantifier(i) {
                    if q.most > maxRepeat { return "repeats more than \(maxRepeat) times" }
                    if q.repeats && inner { return "repeats a group that holds a quantifier" }
                    i = q.end
                    held[held.count - 1] = true
                }
                if inner { held[held.count - 1] = true }
                continue
            default:
                i += 1
            }
            if let q = quantifier(i) {
                if q.most > maxRepeat { return "repeats more than \(maxRepeat) times" }
                i = q.end
                held[held.count - 1] = true
            }
        }
        return nil
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

    /// A CSS selector, which the extension puts in a style rule of its own, so it may not end that rule or reach past
    /// it. Refused: `{`, `}`, `;`, `\`, `@`, `<`, a line break or other control character, `/*` or `*/`, and a quote,
    /// bracket or parenthesis left open or closed without being opened.
    static func selector(_ s: String) -> Result<String, Why> {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return .failure(Why("is empty")) }
        func refused(_ why: String) -> Result<String, Why> { .failure(Why("\"\(s)\" is not one CSS selector: \(why)")) }
        if let bad = t.unicodeScalars.first(where: { "{};\\@<".unicodeScalars.contains($0) || CharacterSet.controlCharacters.contains($0) }) {
            return refused(CharacterSet.controlCharacters.contains(bad) ? "it may not hold a line break" : "it may not hold \(bad)")
        }
        if t.holds("/*") || t.holds("*/") { return refused("it may not hold a comment mark, /* or */") }
        if let why = unbalanced(t) { return refused(why) }
        return .success(t)
    }

    /// Why the quotes, brackets and parentheses in it don't pair up, or nil.
    static func unbalanced(_ t: String) -> String? {
        var quote: Unicode.Scalar?
        var open: [Unicode.Scalar] = []
        for ch in t.unicodeScalars {
            if let q = quote { if ch == q { quote = nil }; continue }
            switch ch {
            case "\"", "'": quote = ch
            case "[", "(": open.append(ch)
            case "]", ")":
                guard open.popLast() == (ch == "]" ? "[" : "(") else { return "it closes \(ch) without opening it" }
            default: break
            }
        }
        if let q = quote { return "its \(q) is never closed" }
        if let o = open.last { return "its \(o) is never closed" }
        return nil
    }

    /// A whole file: `{"version":1,"filters":[rule...]}`, as `checked`.
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
        return checked(list)
    }

    /// The rules of a file: at most `maxRules`, each rule checked and normalized, ids unique, and the file they make no
    /// more than `maxBytes` as `save` writes it. `parse` and `save` both run this, so a file that loads can be saved
    /// again and a saved file loads, however its rules were built.
    static func checked(_ list: [SurfaceValue]) -> Result<[FilterRule], SurfacesIssue> {
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
        let size = text(rules).utf8.count
        guard size <= maxBytes else {
            return .failure(SurfacesIssue("filters", "would make \(name) \(size) bytes as written; at most \(maxBytes)"))
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

    /// The file as `save` writes it (`SurfacesFile.write`).
    static func text(_ rules: [FilterRule]) -> String { document(rules).json(pretty: true) + "\n" }

    /// Checks the rules as `parse` does and writes them, normalized, as the whole file at once (`SurfacesFile.write`:
    /// a temp file, flushed, renamed over it), returning what was written. A refusal throws the `SurfacesIssue`,
    /// which names the field (`filters[1].id`), and writes nothing; a disk failure throws `SurfacesFile.WriteError`.
    @discardableResult
    public static func save(_ rules: [FilterRule], to path: String) throws -> [FilterRule] {
        let rules = try checked(rules.map(\.value)).get()
        try SurfacesFile.write(document(rules), to: path, limit: maxBytes)
        return rules
    }
}
