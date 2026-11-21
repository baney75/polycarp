import Foundation

// Calling and messaging people from the launcher and the command (docs/contacts.md). Plain data and rules, no
// Contacts framework: the app reads macOS Contacts (`ContactsLibrary`) and hands the people here, so the command
// (Foundation only) never links Contacts and every rule is tested with made-up people. Polycarp never sends a
// message: the message action opens Messages with the draft and the owner presses Send.

/// One way to reach a person: a phone number or an email address, with the label Contacts gives it.
public struct ContactHandle: Codable, Equatable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable { case phone, email }
    public var kind: Kind
    /// "mobile", "iPhone", "home", "work", or "" when Contacts has none.
    public var label: String
    public var value: String

    public init(_ kind: Kind, _ value: String, label: String = "") {
        self.kind = kind
        self.value = value
        self.label = label
    }

    /// A phone Contacts marks as a mobile one.
    public var isMobile: Bool { kind == .phone && ["mobile", "iphone", "cell"].contains(label.lowercased()) }

    /// The number as a URL takes it: a leading plus and the digits, nothing else. Email is the address, trimmed.
    public var dialable: String {
        guard kind == .phone else { return value.trimmingCharacters(in: .whitespaces) }
        var out = ""
        for ch in value.unicodeScalars {
            if ch == "+" && out.isEmpty { out.append("+") } else if ("0"..."9").contains(ch) { out.unicodeScalars.append(ch) }
        }
        return out == "+" ? "" : out
    }

    /// A short stamp for the recents file, so it never holds a number or an address: FNV-1a over the kind and the
    /// dialable value, as hex.
    public var fingerprint: String {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in (kind.rawValue + ":" + dialable.lowercased()).utf8 {
            h ^= UInt64(b)
            h = h &* 0x0000_0100_0000_01b3
        }
        return String(h, radix: 16)
    }

    /// "phone (mobile)", "email": what the command says instead of the number.
    public var kindLine: String { label.isEmpty ? kind.rawValue : "\(kind.rawValue) (\(label))" }
}

/// One person as the launcher knows them.
public struct ContactRecord: Equatable, Sendable {
    /// Contacts' own identifier.
    public var id: String
    /// The full name, or the company for a company card.
    public var name: String
    public var nickname: String
    public var organization: String
    public var phones: [ContactHandle]
    public var emails: [ContactHandle]
    /// Contacts' small picture (JPEG or PNG), when there is one.
    public var thumbnail: Data?

    public init(id: String, name: String, nickname: String = "", organization: String = "",
                phones: [ContactHandle] = [], emails: [ContactHandle] = [], thumbnail: Data? = nil) {
        self.id = id
        self.name = name.isEmpty ? organization : name
        self.nickname = nickname
        self.organization = organization
        self.phones = phones
        self.emails = emails
        self.thumbnail = thumbnail
    }

    /// What can be done for this person, the default first: Call for anyone with a phone number, else Email.
    public var verbs: [ContactVerb] {
        if !phones.isEmpty { return emails.isEmpty ? [.call, .facetime, .message] : [.call, .facetime, .message, .email] }
        if !emails.isEmpty { return [.email, .message, .facetime, .call] }
        return []
    }

    /// The handles `verb` can use, in the order a pick falls back through. A call goes to a phone when there is one
    /// (FaceTime audio to an address otherwise); FaceTime and Messages take either, phones first; email only addresses.
    public func handles(for verb: ContactVerb) -> [ContactHandle] {
        switch verb {
        case .call: phones.isEmpty ? emails : phones
        case .facetime, .message: phones + emails
        case .email: emails
        }
    }
}

/// What the owner can do for a person.
public enum ContactVerb: String, CaseIterable, Codable, Sendable {
    case call, facetime, message, email

    public var title: String {
        switch self {
        case .call: "Call"
        case .facetime: "FaceTime"
        case .message: "Message"
        case .email: "Email"
        }
    }

    public var symbol: String {
        switch self {
        case .call: "phone.fill"
        case .facetime: "video.fill"
        case .message: "message.fill"
        case .email: "envelope.fill"
        }
    }

    /// The words that start a launcher query for this verb ("call anna", "text anna running late").
    public var words: [String] {
        switch self {
        case .call: ["call", "phone"]
        case .facetime: ["facetime"]
        case .message: ["message", "msg", "text", "imessage", "sms"]
        case .email: ["email", "mail"]
        }
    }

    public static func word(_ w: String) -> ContactVerb? {
        let f = Fuzzy.fold(w)
        return allCases.first { $0.words.contains(f) }
    }

    /// Whether text typed after the name goes with it (a message's draft, an email's body).
    public var takesText: Bool { self == .message || self == .email }
}

// MARK: Handles and links

public enum ContactLinks {
    /// The handle to use for `verb`: the one the owner used last for this person, else a mobile number, else the first.
    public static func pick(_ verb: ContactVerb, for person: ContactRecord, lastUsed: String? = nil) -> ContactHandle? {
        let usable = person.handles(for: verb).filter { !$0.dialable.isEmpty }
        if let lastUsed, let h = usable.first(where: { $0.fingerprint == lastUsed }) { return h }
        return usable.first(where: \.isMobile) ?? usable.first
    }

    /// The link that does `verb` with `handle`. Call: `tel:` (the Phone app, or FaceTime audio through the iPhone), or
    /// `facetime-audio:` for an address. FaceTime: `facetime:`. Message: Messages' `sms://open?addresses=` with the
    /// draft as `body`, which Messages puts in the box unsent. Email: `mailto:` with the text as the body.
    public static func url(_ verb: ContactVerb, _ handle: ContactHandle, text: String = "") -> URL? {
        let to = handle.dialable
        guard !to.isEmpty else { return nil }
        let draft = text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch verb {
        case .call:
            return URL(string: handle.kind == .phone ? "tel:" + to : "facetime-audio:" + escape(to, keep: "@+"))
        case .facetime:
            return URL(string: "facetime:" + escape(to, keep: "@+"))
        case .message:
            let body = draft.isEmpty ? "" : "&body=" + escape(draft)
            return URL(string: "sms://open?addresses=" + escape(to, keep: "@") + body)
        case .email:
            guard handle.kind == .email else { return nil }
            return URL(string: "mailto:" + escape(to, keep: "@+") + (draft.isEmpty ? "" : "?body=" + escape(draft)))
        }
    }

    /// Percent-escapes everything but ASCII letters, digits, `-._~` and `keep`, so a space, a plus sign, `&`, `#`,
    /// accented letters and emoji all reach the other app as typed. A plus is escaped unless kept: some readers take a
    /// bare one in a query for a space.
    public static func escape(_ s: String, keep: String = "") -> String {
        var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        allowed.insert(charactersIn: keep)
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
}

/// A launcher row's or the command's action, ready to open: the app opens `url` and notes the use in the recents.
public struct ContactLaunch: Equatable, Sendable {
    public var id: String
    public var name: String
    public var verb: ContactVerb
    public var handle: ContactHandle
    public var url: URL
    /// The draft or body that went into the link, so the app can say Messages has it. Never written to disk.
    public var text: String

    public init?(_ person: ContactRecord, _ verb: ContactVerb, lastUsed: String? = nil, text: String = "") {
        guard let h = ContactLinks.pick(verb, for: person, lastUsed: lastUsed),
              let url = ContactLinks.url(verb, h, text: verb.takesText ? text : "") else { return nil }
        id = person.id
        name = person.name
        self.verb = verb
        handle = h
        self.url = url
        self.text = verb.takesText ? text.trimmingCharacters(in: .whitespacesAndNewlines) : ""
    }
}

// MARK: Recents

/// Who the owner called, FaceTimed, messaged or emailed from Polycarp, and when: the person's identifier, the verb, a
/// fingerprint of the handle (`ContactHandle.fingerprint`, never the number) and the time. No message text. It ranks
/// people in the launcher and picks the handle used last. Kept in `contacts-recents.json` in Polycarp's folder.
public struct ContactRecents: Codable, Equatable, Sendable {
    public struct Use: Codable, Equatable, Sendable {
        public var id: String
        public var verb: ContactVerb
        public var handle: String
        public var at: Double
    }

    /// Oldest first.
    public private(set) var uses: [Use]
    public static let limit = 200
    public static let fileName = "contacts-recents.json"

    public init(_ uses: [Use] = []) { self.uses = Array(uses.suffix(Self.limit)) }

    public mutating func note(_ launch: ContactLaunch, at: Double) {
        uses.append(Use(id: launch.id, verb: launch.verb, handle: launch.handle.fingerprint, at: at))
        if uses.count > Self.limit { uses.removeFirst(uses.count - Self.limit) }
    }

    /// The fingerprint of the handle used last for this person.
    public func lastHandle(_ id: String) -> String? { uses.last { $0.id == id }?.handle }

    /// People by their last use, the newest first.
    public var order: [String] {
        var seen = Set<String>()
        return uses.reversed().compactMap { seen.insert($0.id).inserted ? $0.id : nil }
    }

    public static func decode(_ data: Data?) -> ContactRecents {
        guard let data, let r = try? JSONDecoder().decode(ContactRecents.self, from: data) else { return ContactRecents() }
        return ContactRecents(r.uses)
    }

    public func encoded() -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        return (try? enc.encode(self)) ?? Data()
    }
}
