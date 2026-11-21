import ContactsMatch
import Foundation

/// Whether Polycarp may read Contacts, as the launcher and the command need to know it.
public enum ContactsAccess: Equatable, Sendable {
    /// macOS hasn't asked yet. Polycarp asks only when the owner first uses a contact feature in the launcher.
    case notAsked
    /// Turned off (or restricted): only System Settings turns it back on.
    case denied
    /// Allowed, and the people are being read.
    case loading
    case allowed
    /// Allowed, but reading Contacts failed after every retry (`ContactsReadRetry`). The next launcher open tries again.
    case failed

    public init(_ state: PermissionState, loaded: Bool) {
        switch state {
        case .granted: self = loaded ? .allowed : .loading
        case .denied: self = .denied
        case .notAsked, .unknown: self = .notAsked
        }
    }

    /// The one plain sentence that says why, on the launcher's row that asks.
    public static let why = "Polycarp reads your contacts on this Mac so you can call, FaceTime, message and email people from the launcher. It never sends a message for you."
}

/// When to read Contacts again after a read failed: after 1, 5, then 30 seconds, and after that not until the launcher
/// opens again, so a damaged store never keeps the contacts queue busy or fills trace.log.
public struct ContactsReadRetry: Equatable, Sendable {
    public static let delays: [Double] = [1, 5, 30]
    /// Failed reads since the last good one or the last launcher open.
    public private(set) var failures = 0

    public init() {}

    /// A read failed: how long to wait before the next one, or nil to stop.
    public mutating func failed() -> Double? {
        failures += 1
        return failures <= Self.delays.count ? Self.delays[failures - 1] : nil
    }

    /// Every retry failed: nothing reads again until `reset`.
    public var gaveUp: Bool { failures > Self.delays.count }

    /// A good read, or the launcher opened: start over.
    public mutating func reset() { failures = 0 }
}

/// What was typed, read as a contact query: "anna", "call anna", "message anna running late".
public struct ContactQuery: Equatable, Sendable {
    public var verb: ContactVerb?
    public var name: String
    /// The draft after the name, for a message or an email.
    public var text: String

    public init(verb: ContactVerb?, name: String, text: String = "") {
        self.verb = verb
        self.name = name
        self.text = text
    }

    /// A verb first takes the rest as the person. For a message or an email the name is the longest run of words
    /// (up to four) whose every word starts a word of someone's name, and the rest, as typed, is the draft. `matches` says whether a name
    /// answers; without it (no people yet) the whole rest is the name.
    public static func parse(_ typed: String, matches: ((String) -> Bool)? = nil) -> ContactQuery {
        let words = Self.words(typed)
        guard let first = words.first else { return ContactQuery(verb: nil, name: "") }
        let verbWord = String(typed[first])
        guard let verb = ContactVerb.word(verbWord), typed[first.upperBound...].first?.isWhitespace == true else {
            return ContactQuery(verb: nil, name: typed.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        let rest = Array(words.dropFirst())
        guard let start = rest.first else { return ContactQuery(verb: verb, name: "") }
        let whole = String(typed[start.lowerBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard verb.takesText, rest.count > 1, let matches else { return ContactQuery(verb: verb, name: whole) }
        for n in stride(from: min(rest.count, 4), through: 1, by: -1) {
            let name = String(typed[start.lowerBound..<rest[n - 1].upperBound])
            if matches(name) {
                let text = String(typed[rest[n - 1].upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                return ContactQuery(verb: verb, name: name, text: text)
            }
        }
        return ContactQuery(verb: verb, name: whole)
    }

    private static func words(_ s: String) -> [Range<String.Index>] {
        var out: [Range<String.Index>] = []
        var start: String.Index?
        var i = s.startIndex
        while i < s.endIndex {
            if s[i].isWhitespace {
                if let st = start { out.append(st..<i); start = nil }
            } else if start == nil { start = i }
            i = s.index(after: i)
        }
        if let st = start { out.append(st..<s.endIndex) }
        return out
    }
}

/// The launcher's rows for people. From memory: the index is built off the main thread and swapped in whole.
public final class ContactsProvider: LauncherProvider {
    public let name = "contacts"
    public private(set) var index = ContactsIndex([])
    public private(set) var recents = ContactRecents()
    public var access: ContactsAccess = .notAsked
    private var ranks: [UInt16] = []
    private var apps = SquashedNames([])

    public init() {}

    /// New people from Contacts.
    public func use(_ index: ContactsIndex) {
        self.index = index
        ranks = index.ranks(recents)
    }

    /// The launcher's app names, when its list is read. A query an app's name holds is never a contact verb.
    public func useApps(_ names: [String]) {
        apps = SquashedNames(names.map(Fuzzy.fold))
    }

    /// The recents changed (a use, or the file read at start).
    public func use(_ recents: ContactRecents) {
        self.recents = recents
        ranks = index.ranks(recents)
    }

    public func results(for query: String) -> [LauncherResult] {
        let typed = query.trimmingCharacters(in: .whitespaces)
        var q = ContactQuery.parse(query, matches: access == .allowed ? { [index] in index.hasWordMatch($0) } : nil)
        // "text edit" is TextEdit and "phone mirroring" iPhone Mirroring, not a message or a call: a verb never claims
        // a query an app's name holds. The words are then a plain name, which waits below the apps.
        if q.verb != nil, apps.holds(Fuzzy.fold(typed)) { q = ContactQuery(verb: nil, name: typed) }
        let asked = q.verb != nil || ["contacts", "contact", "people"].contains(Fuzzy.fold(typed))
        // Without the people, no row claims the top: these wait below whatever else matched.
        switch access {
        case .notAsked: return asked ? [Self.askRow] : []
        case .denied: return asked ? [Self.deniedRow] : []
        case .failed: return asked ? [Self.failedRow] : []
        case .loading: return []
        case .allowed: break
        }
        // A plain name needs two letters, so one letter doesn't fill the list with people.
        guard q.verb != nil || q.name.count >= 2 else { return [] }
        let found: [ContactMatch]
        if q.name.isEmpty {
            // "call " with no name yet: the people called lately.
            found = recents.order.prefix(5).compactMap { id in index.index(of: id).map { ContactMatch(index: $0, tier: 3, recent: true) } }
        } else if q.verb != nil {
            // After a verb only real name matches count: letters found inside or scattered through a name ("edit" in
            // Meredith) never turn a word into a call.
            found = index.search(q.name, ranks: ranks, limit: 6).filter { $0.tier >= 2 }
        } else {
            found = index.search(q.name, ranks: ranks, limit: 3)
        }
        return found.compactMap { row($0, q) }
    }

    /// The row for one person: Return does the default (or the typed verb), Command-Return the next one.
    func row(_ m: ContactMatch, _ q: ContactQuery) -> LauncherResult? {
        let person = index.records[m.index]
        var verbs = person.verbs
        if let v = q.verb {
            guard verbs.contains(v) else { return nil }
            verbs = [v] + verbs.filter { $0 != v }
        }
        let last = recents.lastHandle(person.id)
        let launches = verbs.compactMap { ContactLaunch(person, $0, lastUsed: last, text: q.text) }
        guard let first = launches.first else { return nil }
        let second = launches.dropFirst().first
        var sub = [first.verb.title, first.handle.label, first.handle.value].filter { !$0.isEmpty }.joined(separator: " ")
        if !first.text.isEmpty { sub += ": “\(first.text)”, you press Send" }
        if let second { sub += " · ⌘↩ \(second.verb.title)" }
        return LauncherResult(id: "contacts:\(person.id)", section: "People", title: person.name, subtitle: sub,
                              symbol: first.verb.symbol, badge: first.verb.title,
                              placement: Self.claims(m, q) ? .top : .normal, action: .contact(first),
                              second: second.map { .contact($0) }, secondTitle: second?.verb.title ?? "",
                              image: person.thumbnail)
    }

    /// A row goes above apps only for a verb whose name answers well: every typed word starts a word of the person's.
    static func claims(_ m: ContactMatch, _ q: ContactQuery) -> Bool { q.verb != nil && m.tier >= 3 }

    public static let askRow = LauncherResult(
        id: "contacts:ask", section: "People", title: "Allow Contacts to call and message people",
        subtitle: ContactsAccess.why, symbol: "person.crop.circle.badge.questionmark", badge: "Allow",
        action: .contactsAccess)

    public static let deniedRow = LauncherResult(
        id: "contacts:denied", section: "People", title: "Contacts access is off",
        subtitle: "Turn on Polycarp in System Settings, Privacy & Security, Contacts, to call and message people from here.",
        symbol: "person.crop.circle.badge.xmark", badge: "Open Settings", action: .contactsAccess)

    public static let failedRow = LauncherResult(
        id: "contacts:failed", section: "People", title: "Couldn't read Contacts",
        subtitle: "Polycarp tried three more times and stopped. It reads them again the next time the launcher opens.",
        symbol: "person.crop.circle.badge.exclamationmark", action: .none)
}

// MARK: The command

/// `polycarp-spaces contacts …`, answered by the app from the same index and links the launcher uses. Names and the
/// kinds of handles only, unless `--full`. It opens Messages with a draft and never sends one.
public enum ContactsCommand {
    public static let verbs = ["find"] + ContactVerb.allCases.map(\.rawValue)

    /// The request the command sends: `text` is the verb, `target` the query, `args` the flags.
    public static func request(_ args: [String]) -> Result<Wire.Request, ContactsProblem> {
        let usage = "usage: polycarp-spaces contacts find <query> [--json] [--full]\n       polycarp-spaces contacts call|facetime|message|email <query> [--text TEXT]"
        guard let sub = args.first, verbs.contains(sub) else { return .failure(ContactsProblem(usage)) }
        var words: [String] = []
        var flags: [String] = []
        var i = 1
        while i < args.count {
            switch args[i] {
            case "--text":
                guard i + 1 < args.count else { return .failure(ContactsProblem("--text needs the draft after it")) }
                flags += ["--text", args[i + 1]]
                i += 2
                continue
            case "--full": flags.append("--full")
            case "--json": break
            default: words.append(args[i])
            }
            i += 1
        }
        let query = words.joined(separator: " ").trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return .failure(ContactsProblem(usage)) }
        if flags.contains("--text"), !(ContactVerb(rawValue: sub)?.takesText ?? false) {
            return .failure(ContactsProblem("--text goes with message or email"))
        }
        return .success(Wire.Request(op: .contacts, target: query, text: sub, args: flags))
    }

    /// What the app answers, and the link to open when the request was an action.
    public static func answer(_ r: Wire.Request, access: ContactsAccess, index: ContactsIndex,
                              recents: ContactRecents) -> (reply: Wire.Reply, open: ContactLaunch?) {
        switch access {
        case .notAsked:
            return (.init(ok: false, error: "Contacts access isn't set up. The owner turns it on by typing \"call\" and a name in the launcher, or in Settings > Permissions; a command never asks macOS for it."), nil)
        case .denied:
            return (.init(ok: false, error: "Contacts access is off. Turn on Polycarp in System Settings > Privacy & Security > Contacts."), nil)
        case .loading:
            return (.init(ok: false, error: "Polycarp is still reading your contacts; try again in a moment."), nil)
        case .failed:
            return (.init(ok: false, error: "Couldn't read Contacts. Polycarp stopped retrying; it reads them again the next time the launcher opens."), nil)
        case .allowed: break
        }
        let query = (r.target ?? "").trimmingCharacters(in: .whitespaces)
        let args = r.args ?? []
        let full = args.contains("--full")
        let ranks = index.ranks(recents)
        guard r.text != "find" else {
            let found = index.search(query, ranks: ranks, limit: 10).filter { $0.tier >= 1 }
            return (.init(ok: true, contacts: found.map { ContactSummary(index.records[$0.index], full: full) }), nil)
        }
        guard let verb = ContactVerb(rawValue: r.text ?? "") else {
            return (.init(ok: false, error: "contacts takes find, call, facetime, message or email"), nil)
        }
        let text = args.firstIndex(of: "--text").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil } ?? ""
        switch pickOne(query, index: index) {
        case .failure(let why): return (.init(ok: false, error: why.message), nil)
        case .success(let i):
            let person = index.records[i]
            guard person.verbs.contains(verb),
                  let launch = ContactLaunch(person, verb, lastUsed: recents.lastHandle(person.id), text: text) else {
                return (.init(ok: false, error: "\(person.name) has no \(verb == .email ? "email address" : "number or address") for \(verb.title)"), nil)
            }
            var info = ["name": person.name, "verb": verb.rawValue, "handle": launch.handle.kindLine]
            if full { info["value"] = launch.handle.value }
            if verb == .message { info["note"] = "Messages is open with the draft. Polycarp never sends it; the owner presses Send." }
            return (.init(ok: true, info: info), launch)
        }
    }

    /// The one person a command acts on: the only good match, or a whole-name match ahead of the rest. More than one
    /// as good is refused with their names, so an agent never calls the wrong Anna.
    public static func pickOne(_ query: String, index: ContactsIndex) -> Result<Int, ContactsProblem> {
        let found = index.search(query, limit: 6).filter { $0.tier >= 2 }
        guard let top = found.first else { return .failure(ContactsProblem("no one in Contacts matches \"\(query)\"")) }
        let rivals = found.dropFirst().filter { $0.tier == top.tier }
        if rivals.isEmpty { return .success(top.index) }
        let names = ([top] + rivals).map { index.records[$0.index].name }
        return .failure(ContactsProblem("more than one person matches \"\(query)\": \(names.joined(separator: ", ")). Say more of the name."))
    }
}

/// Why a contacts command was refused, in one line for the person or agent that ran it.
public struct ContactsProblem: Error, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

/// One person as the command prints them.
public struct ContactSummary: Codable, Equatable, Sendable {
    public struct Handle: Codable, Equatable, Sendable {
        public var kind: String
        public var label: String
        /// Only with `--full`.
        public var value: String?
    }

    public var name: String
    public var nickname: String?
    public var organization: String?
    public var handles: [Handle]

    public init(_ r: ContactRecord, full: Bool) {
        name = r.name
        nickname = r.nickname.isEmpty ? nil : r.nickname
        organization = r.organization.isEmpty || r.organization == r.name ? nil : r.organization
        handles = (r.phones + r.emails).map { Handle(kind: $0.kind.rawValue, label: $0.label, value: full ? $0.value : nil) }
    }

    /// One line: "Anna Smith (Annie, Acme)  phone (mobile), email (work)".
    public var line: String {
        let extra = [nickname, organization].compactMap { $0 }
        let head = extra.isEmpty ? name : "\(name) (\(extra.joined(separator: ", ")))"
        let hs = handles.map { h in
            let kind = h.label.isEmpty ? h.kind : "\(h.kind) (\(h.label))"
            return h.value.map { "\(kind) \($0)" } ?? kind
        }
        return hs.isEmpty ? head : "\(head)\t\(hs.joined(separator: ", "))"
    }
}
