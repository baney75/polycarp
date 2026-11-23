import Foundation

/// One search: the launcher, the browser's new tab page (extension/newtab/logic.js, which mirrors this) and
/// `polycarp-spaces search` answer what was typed the same way. One engine (`search.engine` in surfaces.json), one bang
/// table (`Bangs`), one address rule, one ranking of the session engine's rows. docs/newtab.md has the page's side.
public enum OneSearch {
    /// The most rows the new tab's finder and `polycarp-spaces search` give.
    public static let limit = 7
    /// How well a session row must match to be offered: the words inside its name, or better. Letters scattered through
    /// a tab's title would otherwise put a switch above the search that was meant.
    public static let sessionFloor = 500

    // MARK: The engine

    /// The engine `setting` (`Surfaces.search.engine`) names, as a bang: one of `bangs`, an https template with
    /// `{query}`, or a trigger only DuckDuckGo knows. Anything else is Google, the default.
    public static func engine(_ setting: String, bangs: [Bang]) -> Bang {
        let s = setting.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("https://"), s.contains("{query}") {
            let host = URL(string: s.replacingOccurrences(of: "{query}", with: "q"))?.host ?? s
            return Bang(trigger: "", name: host.hasPrefix("www.") ? String(host.dropFirst(4)) : host,
                        url: s.replacingOccurrences(of: "{query}", with: "{q}"))
        }
        if let b = Bangs.find(s, in: bangs) { return b }
        if SurfaceCheck.matches(s, SurfaceCheck.triggerPattern) {
            return Bang(trigger: s, name: "!" + s, url: "https://duckduckgo.com/?q=%21\(s)%20{q}")
        }
        return Bangs.find("g", in: Bangs.builtIn)!
    }

    /// The engine as a template with `{query}`, the form `newtab.searchURL` and older pages take.
    public static func template(_ engine: Bang) -> String { engine.url.replacingOccurrences(of: "{q}", with: "{query}") }

    // MARK: What Return does

    /// An address someone typed, as logic.js reads one: an http(s) URL, localhost or an IP (http), or a dotted host with
    /// no spaces (https). Other schemes are never opened; they are words.
    public static func address(_ typed: String) -> URL? {
        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        func m(_ p: String) -> Bool { t.range(of: p, options: [.regularExpression, .caseInsensitive]) != nil }
        if m(#"^[a-z][a-z0-9+.-]*://\S+$"#) { return m("^https?:") ? URL(string: t) : nil }
        if m(#"^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(/\S*)?$"#) || m(#"^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?(/\S*)?$"#) {
            return URL(string: "http://" + t)
        }
        if m(#"^([a-z0-9-]+\.)+[a-z]{2,63}(:\d{1,5})?(/\S*)?$"#) { return URL(string: "https://" + t) }
        return nil
    }

    /// One ranked answer. Sessions carry `id`; everything else carries `url`.
    public struct Result: Equatable, Sendable, Encodable {
        /// `tab`, `terminal`, `window` or `device` for a session row; `bang` (a completion), `search` or `open`.
        public var kind: String
        public var title: String
        public var url: String?
        public var id: String?
        public var app: String?
        /// A session row's folder or host.
        public var detail: String?
        /// The workspace a session row is on, when it isn't the one in front.
        public var workspace: Int?
        /// A completion's trigger, without "!".
        public var trigger: String?
        /// The search goes to an AI agent: a new chat with the question asked.
        public var agent: Bool?

        public init(kind: String, title: String, url: String? = nil, id: String? = nil, app: String? = nil, detail: String? = nil,
                    workspace: Int? = nil, trigger: String? = nil, agent: Bool? = nil) {
            self.kind = kind; self.title = title; self.url = url; self.id = id; self.app = app; self.detail = detail
            self.workspace = workspace; self.trigger = trigger; self.agent = agent
        }

        /// One line of JSON, keys sorted, slashes as typed.
        public var jsonLine: String {
            let enc = JSONEncoder()
            enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            return (try? enc.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        }
    }

    /// The launcher's title for a bang row, word for word.
    public static func title(_ b: Bang, _ terms: String) -> String {
        if terms.isEmpty { return "Open \(b.name)" }
        return b.isAgent ? "Ask \(b.name) \u{201C}\(terms)\u{201D}" : "Search \(b.name) for \u{201C}\(terms)\u{201D}"
    }

    /// What Return on the typed text does with no row picked: a bang ("!yt cats", "cats !yt"), an address, or the
    /// engine. Nil for nothing typed or a bang address that isn't safe.
    public static func action(_ typed: String, engine: Bang, bangs: [Bang]) -> Result? {
        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        if let p = Bangs.parse(t) {
            if let b = Bangs.find(p.trigger, in: bangs) {
                return b.address(for: p.terms).map { Result(kind: "search", title: title(b, p.terms), url: $0.absoluteString, agent: b.isAgent ? true : nil) }
            }
            let words = p.terms.isEmpty ? "" : " for \u{201C}\(p.terms)\u{201D}"
            return Bangs.fallbackAddress(trigger: p.trigger, terms: p.terms).map { Result(kind: "search", title: "Search with !\(p.trigger)\(words)", url: $0.absoluteString) }
        }
        if let u = address(t) { return Result(kind: "open", title: "Open \(t)", url: u.absoluteString) }
        return engine.address(for: t).map { Result(kind: "search", title: title(engine, t), url: $0.absoluteString, agent: engine.isAgent ? true : nil) }
    }

    // MARK: Rows

    /// Bangs offered while the trigger is still being typed ("!", "!yo"): Tab fills one in.
    public static func completions(_ typed: String, bangs: [Bang], limit: Int = OneSearch.limit) -> [Bang] {
        let t = typed.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("!"), !t.contains(" "), limit > 0 else { return [] }
        return Bangs.suggest(String(t.dropFirst()), in: bangs, limit: limit)
    }

    /// The session rows (tabs, terminals, windows) that answer `typed`, best first, each matching at least
    /// `sessionFloor`. A bang is for the web, so it finds none.
    public static func sessions(_ typed: String, in items: [Item], limit: Int = OneSearch.limit) -> [Item] {
        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard findsSessions(t), limit > 0 else { return [] }
        let q = Fuzzy.fold(t)
        return items.enumerated()
            .compactMap { i, item -> (Int, Item, Int)? in
                let best = [item.label, "\(item.appName) \(item.label)", item.detail].compactMap { Fuzzy.score(folded: q, key: SearchKey($0)) }.max()
                guard let best, best >= sessionFloor else { return nil }
                return (i, item, best)
            }
            .sorted { $0.2 != $1.2 ? $0.2 > $1.2 : $0.0 < $1.0 }
            .prefix(limit)
            .map(\.1)
    }

    /// Whether `typed` can match a session row at all: not empty, not a bang, not a "?" question.
    public static func findsSessions(_ typed: String) -> Bool {
        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && !t.hasPrefix("!") && !t.hasPrefix("?") && Bangs.parse(t) == nil
    }

    /// A session row as a result.
    public static func result(_ item: Item) -> Result {
        Result(kind: item.kind.rawValue, title: item.label, id: item.id, app: item.appName,
               detail: item.detail.isEmpty ? nil : item.detail, workspace: item.workspace > 0 ? item.workspace : nil)
    }

    /// Everything, in the finder's order and at most `limit`: open tabs and windows that match, then bang completions,
    /// then what Return does with the text (always last, always there for text).
    public static func results(_ typed: String, items: [Item], engine: Bang, bangs: [Bang], limit: Int = OneSearch.limit) -> [Result] {
        let last = action(typed, engine: engine, bangs: bangs)
        var room = limit - (last == nil ? 0 : 1)
        var out = sessions(typed, in: items, limit: room).map(result)
        room -= out.count
        out += completions(typed, bangs: bangs, limit: room).map {
            Result(kind: "bang", title: $0.name, url: $0.address(for: "")?.absoluteString, trigger: $0.trigger, agent: $0.isAgent ? true : nil)
        }
        if let last { out.append(last) }
        return out
    }

    // MARK: polycarp-spaces search

    /// `polycarp-spaces search`'s arguments. Before `--`, `--json` and `--open` are flags wherever they stand; after it,
    /// everything is text (`polycarp mcp` sends its query that way, so a query can't become a flag or a help request).
    public struct Arguments: Equatable, Sendable {
        public var json = false
        public var open = false
        public var words: [String] = []
        /// Whether a `--` came before the words.
        public var separated = false

        public init(_ args: [String]) {
            var rest = args[...]
            while let a = rest.popFirst() {
                if a == "--" { separated = true; words += rest; break }
                if a == "--json" { json = true } else if a == "--open" { open = true } else { words.append(a) }
            }
        }

        public var text: String { words.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines) }
        /// `help`, `-h` or `--help` asks for the usage only when it is the one word typed and not after `--`.
        public var asksHelp: Bool { !separated && words.count == 1 && ["help", "--help", "-h"].contains(words[0]) }
    }

    /// The result `--open` performs: the first that Return would act on. A bang completion only fills in its bang in
    /// the launcher and the finder, so it is passed over.
    public static func toOpen(_ results: [Result]) -> Result? { results.first { $0.kind != "bang" } }

    // MARK: The launcher's engine from before search.engine

    /// What to do with the engine the launcher kept in its own defaults before `search.engine`.
    public enum OldEngineMove: Equatable, Sendable {
        /// Nothing to move, or the file can't be read now: keep the old key for next time.
        case keep
        /// The file already says where searches go (a value the person chose), or it is the old value: drop the old key.
        case forget
        /// Write this into `search.engine`, then drop the old key once that worked.
        case write(String)
    }

    /// Decides the one-time move of the launcher's old engine (`old`) into surfaces.json, given what the file holds.
    /// The old choice gives way only to a choice in the file: `search.engine`, or a `newtab.searchURL` that isn't its
    /// compiled-in default (a full file from `surfaces get` carries the default, which nobody chose). Otherwise the old
    /// choice goes into `search.engine` unless it is already the engine in force.
    public static func moveOldEngine(_ old: String?, file: SurfacesFile.Loaded) -> OldEngineMove {
        guard let old, !old.isEmpty else { return .keep }
        let tree: SurfaceValue
        let inForce: String
        switch file {
        case .missing:
            return old == Surfaces.defaults.search.engine ? .forget : .write(old)
        case .document(let d):
            tree = d.tree
            inForce = d.surfaces.search.engine
        case .invalid, .rejected, .failed:
            return .keep
        }
        if tree.at(["search", "engine"]) != nil { return .forget }
        let legacyDefault = SurfaceField.byPath["newtab.searchURL"]?.defaultValue
        if let legacy = tree.at(["newtab", "searchURL"]), legacy != legacyDefault { return .forget }
        return old == inForce ? .forget : .write(old)
    }
}
