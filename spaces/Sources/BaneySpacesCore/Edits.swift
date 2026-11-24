import Foundation

// Page edits for Polycarp's browser extension (docs/edits.md). edits.json, beside filters.json, holds edits: what to
// hide, restyle, reword, move or add on the pages of named sites. An agent or a person sets them through
// `polycarp-spaces edits` and the MCP tools; the extension asks the new tab host for them and applies them. An edit only
// changes how a page looks and reads in this browser. It cannot click, type, submit, load anything from the network or
// run a script. The extension checks every edit again by the same rules: spec/edits.json holds the cases both must pass.

extension String {
    /// Whether these exact characters are in it. `contains` compares whole letters with their accents, so it misses
    /// "url(" when an accent follows the parenthesis; a CSS reader doesn't.
    func holds(_ s: String) -> Bool { Data(utf8).range(of: Data(s.utf8)) != nil }
}

public enum Edits {
    struct Why: Error { let message: String; init(_ m: String) { message = m } }

    public static let name = "edits.json"
    public static let maxBytes = 256 * 1024
    public static let maxEdits = 100
    public static let maxChanges = 50
    public static let maxSites = 50
    public static let maxPaths = 50
    public static let maxSelector = 500
    public static let maxText = 2000
    public static let maxCSS = 20_000
    public static let maxBlocks = 20
    public static let maxItems = 30
    public static let maxURL = 2000
    public static let maxName = 80
    public static let wheres = ["before", "after", "first", "last"]
    /// Attributes an edit may set: words a person reads, never a target, a source, a handler or a form's value.
    public static let attributes = ["alt", "aria-label", "dir", "lang", "open", "title"]

    public static func path(surfacesFile: String = SurfacesFile.path()) -> String {
        URL(fileURLWithPath: surfacesFile).deletingLastPathComponent().appendingPathComponent(name).path
    }

    // MARK: Checking

    /// One edit from JSON, checked and normalized, every key present. `at` prefixes each issue's path (`edits[2].`).
    public static func edit(_ v: SurfaceValue, at prefix: String = "") -> Result<SurfaceValue, SurfacesIssue> {
        let whole = prefix.isEmpty ? "$" : String(prefix.dropLast())
        do { return .success(try normalized(v, prefix, whole)) } catch let i as SurfacesIssue { return .failure(i) } catch {
            return .failure(SurfacesIssue(whole, "\(error)"))
        }
    }

    private static func normalized(_ v: SurfaceValue, _ prefix: String, _ whole: String) throws -> SurfaceValue {
        guard let o = v.object else { throw SurfacesIssue(whole, "an edit is a JSON object, not \(v.kind)") }
        try known(o, ["id", "name", "enabled", "sites", "paths", "changes", "css"], prefix, "an edit")
        let id = try string(o, "id", prefix, 64)
        guard !id.isEmpty, id.utf8.allSatisfy({ (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2d }) else {
            throw SurfacesIssue(prefix + "id", "must be 1 to 64 of a-z, 0-9 and -")
        }
        let name = o["name"] == nil ? "" : try string(o, "name", prefix, maxName)
        if let e = o["enabled"], e.bool == nil { throw SurfacesIssue(prefix + "enabled", "must be true or false, not \(e.kind)") }
        let sites = try strings(o, "sites", prefix, maxSites, 200) { s in
            switch Filters.site(s) { case .success(let t): return t; case .failure(let w): throw Why(w.message) }
        }
        guard !sites.isEmpty else { throw SurfacesIssue(prefix + "sites", "names at least one site, as [\"example.com\"]") }
        let paths = try strings(o, "paths", prefix, maxPaths, 200) { s in
            let t = s.trimmingCharacters(in: .whitespaces)
            guard t.hasPrefix("/"), !t.unicodeScalars.contains(where: "?# ".unicodeScalars.contains) else { throw Why("\"\(s)\" is not a path such as /home or /watch/*") }
            return t
        }
        guard let rawChanges = (o["changes"] ?? .array([])).array else { throw SurfacesIssue(prefix + "changes", "must be a list of changes") }
        guard rawChanges.count <= maxChanges else { throw SurfacesIssue(prefix + "changes", "has \(rawChanges.count) changes; at most \(maxChanges)") }
        let changes = try rawChanges.enumerated().map { try change($1, "\(prefix)changes[\($0)].") }
        var css = ""
        if o["css"] != nil {
            css = try string(o, "css", prefix, maxCSS).trimmingCharacters(in: .whitespacesAndNewlines)
            if let why = cssProblem(css) { throw SurfacesIssue(prefix + "css", why) }
        }
        guard !changes.isEmpty || !css.isEmpty else { throw SurfacesIssue(whole, "an edit needs at least one change, or css") }
        return .object(["id": .string(id), "name": .string(name), "enabled": .bool(o["enabled"]?.bool ?? true),
                        "sites": .array(sites.map(SurfaceValue.string)), "paths": .array(paths.map(SurfaceValue.string)),
                        "changes": .array(changes), "css": .string(css)])
    }

    private static func change(_ v: SurfaceValue, _ p: String) throws -> SurfaceValue {
        guard let o = v.object else { throw SurfacesIssue(String(p.dropLast()), "a change is a JSON object, not \(v.kind)") }
        let verb = o["do"]?.string ?? ""
        let fields = ["hide": [], "style": ["style"], "text": ["text", "find"], "attr": ["name", "value"],
                      "move": ["to", "where"], "insert": ["where", "blocks"]]
        guard let own = fields[verb] else { throw SurfacesIssue(p + "do", "must be hide, style, text, attr, move or insert") }
        try known(o, ["do", "at"] + own, p, "a \(verb) change")
        var out: [String: SurfaceValue] = ["do": .string(verb), "at": .string(try selector(o, "at", p))]
        switch verb {
        case "style":
            guard let s = o["style"]?.object, !s.isEmpty, s.count <= 40 else { throw SurfacesIssue(p + "style", "is 1 to 40 CSS properties, as {\"font-size\": \"18px\"}") }
            var style: [String: SurfaceValue] = [:]
            for (k, raw) in s.sorted(by: { $0.key < $1.key }) {
                let prop = k.lowercased()
                guard prop.count <= 60, prop.range(of: "^(--)?[a-z][a-z0-9-]*$", options: .regularExpression) != nil else { throw SurfacesIssue(p + "style.\(k)", "is not a CSS property") }
                guard let value = raw.string?.trimmingCharacters(in: .whitespaces), !value.isEmpty, value.count <= 300 else { throw SurfacesIssue(p + "style.\(k)", "must be a string of 1 to 300 characters") }
                if value.unicodeScalars.contains(where: "{};!@<".unicodeScalars.contains) || control(value) { throw SurfacesIssue(p + "style.\(k)", "may not hold { } ; ! @ < or a line break") }
                if let why = cssProblem(value) { throw SurfacesIssue(p + "style.\(k)", why) }
                style[prop] = .string(value)
            }
            out["style"] = .object(style)
        case "text":
            out["text"] = .string(try string(o, "text", p, maxText))
            let find = o["find"] == nil ? "" : try string(o, "find", p, maxText)
            out["find"] = .string(find)
        case "attr":
            let attr = try string(o, "name", p, 40).lowercased()
            guard attributes.contains(attr) else { throw SurfacesIssue(p + "name", "must be one of \(attributes.joined(separator: ", "))") }
            out["name"] = .string(attr)
            guard let value = o["value"], value == .null || value.string.map({ $0.count <= maxText }) == true else {
                throw SurfacesIssue(p + "value", "must be a string of at most \(maxText) characters, or null to take the attribute away")
            }
            out["value"] = value
        case "move":
            out["to"] = .string(try selector(o, "to", p))
            out["where"] = .string(try place(o, p))
        case "insert":
            out["where"] = .string(try place(o, p))
            guard let blocks = o["blocks"]?.array, (1...maxBlocks).contains(blocks.count) else { throw SurfacesIssue(p + "blocks", "is a list of 1 to \(maxBlocks) blocks") }
            out["blocks"] = .array(try blocks.enumerated().map { try block($1, "\(p)blocks[\($0)].") })
        default: break
        }
        return .object(out)
    }

    /// What an insert adds: plain words the extension draws in its own style, never HTML.
    private static func block(_ v: SurfaceValue, _ p: String) throws -> SurfaceValue {
        guard let o = v.object else { throw SurfacesIssue(String(p.dropLast()), "a block is a JSON object, not \(v.kind)") }
        let kind = o["kind"]?.string ?? ""
        switch kind {
        case "heading", "text":
            try known(o, ["kind", "text"], p, "a \(kind) block")
            return .object(["kind": .string(kind), "text": .string(try filled(o, "text", p))])
        case "list":
            try known(o, ["kind", "items"], p, "a list block")
            let items = try strings(o, "items", p, maxItems, maxText) { $0 }
            guard !items.isEmpty else { throw SurfacesIssue(p + "items", "holds at least one item") }
            return .object(["kind": .string(kind), "items": .array(items.map(SurfaceValue.string))])
        case "link":
            try known(o, ["kind", "text", "url"], p, "a link block")
            let url = try string(o, "url", p, maxURL)
            guard webURL(url) else { throw SurfacesIssue(p + "url", "must be a full https:// or http:// address with no user name in it") }
            return .object(["kind": .string(kind), "text": .string(try filled(o, "text", p)), "url": .string(url)])
        default: throw SurfacesIssue(p + "kind", "must be heading, text, list or link")
        }
    }

    private static func known(_ o: [String: SurfaceValue], _ keys: [String], _ p: String, _ what: String) throws {
        if let k = o.keys.sorted().first(where: { !keys.contains($0) }) {
            throw SurfacesIssue(p + k, "is not a field of \(what) (\(keys.joined(separator: ", ")))")
        }
    }

    private static func string(_ o: [String: SurfaceValue], _ key: String, _ p: String, _ max: Int) throws -> String {
        guard let s = o[key]?.string else { throw SurfacesIssue(p + key, o[key] == nil ? "is required" : "must be a string, not \(o[key]!.kind)") }
        guard s.utf16.count <= max else { throw SurfacesIssue(p + key, "is over \(max) characters") }
        return s
    }

    private static func filled(_ o: [String: SurfaceValue], _ key: String, _ p: String) throws -> String {
        let s = try string(o, key, p, maxText)
        guard !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw SurfacesIssue(p + key, "is empty") }
        return s
    }

    private static func strings(_ o: [String: SurfaceValue], _ key: String, _ p: String, _ most: Int, _ chars: Int, _ norm: (String) throws -> String) throws -> [String] {
        guard let raw = o[key] else { return [] }
        guard let list = raw.array else { throw SurfacesIssue(p + key, "must be a list of strings, not \(raw.kind)") }
        guard list.count <= most else { throw SurfacesIssue(p + key, "has \(list.count) entries; at most \(most)") }
        var out: [String] = []
        for (i, item) in list.enumerated() {
            let at = "\(p)\(key)[\(i)]"
            guard let s = item.string, s.utf16.count <= chars, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw SurfacesIssue(at, "must be a string of 1 to \(chars) characters") }
            do { let n = try norm(s); if !out.contains(n) { out.append(n) } } catch let w as Why { throw SurfacesIssue(at, w.message) }
        }
        return out
    }

    private static func selector(_ o: [String: SurfaceValue], _ key: String, _ p: String) throws -> String {
        let s = try string(o, key, p, maxSelector)
        switch Filters.selector(s) { case .success(let t): return t; case .failure(let w): throw SurfacesIssue(p + key, w.message) }
    }

    private static func place(_ o: [String: SurfaceValue], _ p: String) throws -> String {
        guard let w = o["where"]?.string, wheres.contains(w) else { throw SurfacesIssue(p + "where", "must be \(wheres.joined(separator: ", "))") }
        return w
    }

    private static func control(_ s: String) -> Bool { s.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) } }

    static func webURL(_ s: String) -> Bool {
        guard s.range(of: "^https?://[A-Za-z0-9.-]+(:[0-9]+)?([/?#][^\\s\\\\]*)?$", options: .regularExpression) != nil, !control(s) else { return false }
        return URLComponents(string: s)?.host?.isEmpty == false
    }

    /// Why a stylesheet or a value is refused, or nil. A stylesheet that can load something from the network can tell
    /// another site what is on the page (`input[value^=a]{background:url(...)}`), so nothing here may load: no backslash,
    /// which could spell `url(` another way, no function that fetches, and only at-rules that don't.
    static func cssProblem(_ css: String) -> String? {
        if css.holds("\\") { return "may not hold a backslash" }
        if css.holds("\0") { return "may not hold a null character" }
        let low = css.lowercased()
        for f in ["url(", "src(", "image(", "image-set(", "cross-fade(", "element(", "paint(", "expression("] where low.holds(f) {
            return "may not use \(f)...): an edit loads nothing from the network"
        }
        for word in ["-moz-binding", "behavior:", "</"] where low.holds(word) { return "may not hold \(word)" }
        let allowed: Set = ["media", "supports", "container", "keyframes", "layer", "starting-style"]
        for part in low.unicodeScalars.split(separator: "@", omittingEmptySubsequences: false).dropFirst() {
            let word = String(String.UnicodeScalarView(part.prefix { ("a"..."z").contains($0) || $0 == "-" }))
            guard allowed.contains(word) else { return "may not use @\(word); only \(allowed.sorted().map { "@" + $0 }.joined(separator: ", "))" }
        }
        return nil
    }

    // MARK: The file

    /// A whole file: `{"version":1,"edits":[edit...]}`.
    public static func parse(_ data: Data) -> Result<[SurfaceValue], SurfacesIssue> {
        guard data.count <= maxBytes else { return .failure(SurfacesIssue("$", "\(name) is over \(maxBytes) bytes")) }
        guard case .success(let tree) = SurfaceValue.parse(data), let o = tree.object else { return .failure(SurfacesIssue("$", "\(name) is not a JSON object")) }
        if let k = o.keys.sorted().first(where: { $0 != "version" && $0 != "edits" }) { return .failure(SurfacesIssue(k, "is not a field of \(name) (it holds version and edits)")) }
        guard o["version"]?.integer == 1 else { return .failure(SurfacesIssue("version", "must be 1")) }
        guard let list = o["edits"]?.array else { return .failure(SurfacesIssue("edits", "must be a list of edits")) }
        return checked(list)
    }

    static func checked(_ list: [SurfaceValue]) -> Result<[SurfaceValue], SurfacesIssue> {
        guard list.count <= maxEdits else { return .failure(SurfacesIssue("edits", "has \(list.count) edits; at most \(maxEdits)")) }
        var out: [SurfaceValue] = []
        for (i, v) in list.enumerated() {
            switch edit(v, at: "edits[\(i)].") {
            case .failure(let issue): return .failure(issue)
            case .success(let e):
                if let j = out.firstIndex(where: { $0.object?["id"] == e.object?["id"] }) { return .failure(SurfacesIssue("edits[\(i)].id", "is already the id of edits[\(j)]")) }
                out.append(e)
            }
        }
        let size = text(out).utf8.count
        guard size <= maxBytes else { return .failure(SurfacesIssue("edits", "would make \(name) \(size) bytes as written; at most \(maxBytes)")) }
        return .success(out)
    }

    /// The edits in the file at `path`: none when it is missing.
    public static func load(path: String) -> Result<[SurfaceValue], SurfacesIssue> {
        switch PolycarpThemeFile.bytes(path: path, limit: maxBytes) {
        case .missing: return .success([])
        case .rejected(let why), .failed(let why): return .failure(SurfacesIssue("$", "\(name) is \(why)"))
        case .data(let data): return parse(data)
        }
    }

    static func document(_ edits: [SurfaceValue]) -> SurfaceValue { .object(["version": .number(1), "edits": .array(edits)]) }
    static func text(_ edits: [SurfaceValue]) -> String { document(edits).json(pretty: true) + "\n" }

    /// Checks the edits and writes them as the whole file at once; a refusal throws the issue and writes nothing.
    @discardableResult
    public static func save(_ edits: [SurfaceValue], to path: String) throws -> [SurfaceValue] {
        let edits = try checked(edits).get()
        try SurfacesFile.write(document(edits), to: path, limit: maxBytes)
        return edits
    }
}
