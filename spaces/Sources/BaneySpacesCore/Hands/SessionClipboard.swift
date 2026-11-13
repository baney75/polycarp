import Foundation

/// The agent's clipboard: text a session read with `get` (copy: true), typed into a ref with `type` (paste: true). It
/// lives in Polycarp's memory, one entry per agent session, and never reads or writes the general pasteboard, which is
/// Donovan's. An entry goes when its session ends, or after an hour unused (a client that never says it ended).
public struct SessionClipboard: Equatable, Sendable {
    public static let maxCharacters = 100_000
    public static let idle: TimeInterval = 3600
    /// At most this many sessions hold text; a new one pushes out the one unused longest.
    public static let maxSessions = 64

    struct Entry: Equatable, Sendable { var text: String; var at: Date }
    var entries: [String: Entry] = [:]

    public init() {}

    /// Holds `text` for `session`, replacing what it held. Fails when the text is too long to hold.
    public mutating func copy(_ text: String, session: String, now: Date) -> HandsError? {
        guard text.count <= Self.maxCharacters else {
            return HandsError(.badArguments, "the text is \(text.count) characters; the agent clipboard holds at most \(Self.maxCharacters)",
                              suggestion: "Copy a smaller element.", retry: .never, nextCall: .null)
        }
        expire(now: now)
        entries[session] = Entry(text: text, at: now)
        while entries.count > Self.maxSessions, let oldest = entries.min(by: { $0.value.at < $1.value.at })?.key { entries[oldest] = nil }
        return nil
    }

    /// What `session` copied, or the error that says how to copy first.
    public mutating func paste(session: String, now: Date) -> Result<String, HandsError> {
        expire(now: now)
        guard var e = entries[session] else {
            return .failure(HandsError(.badArguments, "nothing is on the agent clipboard for this session",
                                       suggestion: #"Copy first: {"ref":"5","copy":true} on computer_get, then {"ref":"7","paste":true} on computer_type."#,
                                       retry: .never, nextCall: .null))
        }
        e.at = now
        entries[session] = e
        return .success(e.text)
    }

    public mutating func end(session: String) { entries[session] = nil }

    public mutating func expire(now: Date) { entries = entries.filter { now.timeIntervalSince($0.value.at) < Self.idle } }

    public var sessions: Int { entries.count }

    /// The answer for anything that would reach the general pasteboard: a key, a menu item or a context-menu item.
    public static func pasteboardRefusal(_ what: String) -> HandsError {
        HandsError(.notSupported, "\(what) uses the Mac's clipboard, which is Donovan's, so Polycarp doesn't send it",
                   suggestion: #"Use the agent clipboard: {"ref":"5","copy":true} on computer_get, then {"ref":"7","paste":true} on computer_type. To delete a selection, press Delete."#,
                   retry: .never, nextCall: .null)
    }

    /// Cut, copy and paste chords: command with c, x or v, whatever else is held (cmd+shift+v and cmd+opt+shift+v paste
    /// and match style; cmd+opt+v moves in Finder). By ANSI key code, and by `characters`: what the key types in the
    /// Mac's current layouts, since an app reads cmd+c by its character (cmd+i is copy on Dvorak).
    public static let pasteboardKeyCodes: Set<UInt16> = [7, 8, 9]   // x, c, v on the ANSI layout

    public static func usesPasteboard(_ c: KeyChord, characters: [Character] = []) -> Bool {
        guard c.flags & KeyChord.command != 0 else { return false }
        return pasteboardKeyCodes.contains(c.keyCode) || characters.contains { ["c", "x", "v"].contains($0.lowercased()) }
    }

    /// `type`'s text: the `text` argument, or with paste what this session copied, never both.
    public static func typed(text: String?, paste: Bool, from board: () -> Result<String, HandsError>) -> Result<String, HandsError> {
        guard paste else {
            guard let text else { return .failure(HandsError(.badArguments, "text is missing", suggestion: #"Example: {"ref":"7","text":"hello"}, or {"ref":"7","paste":true} for what you copied."#, retry: .safe)) }
            return .success(text)
        }
        guard text == nil else { return .failure(HandsError(.badArguments, "pass text or paste: true, not both", suggestion: #"Example: {"ref":"7","paste":true}"#, retry: .safe, nextCall: .null)) }
        return board()
    }

    /// The text `get` with copy holds: its value when that is text (bounds and states are not).
    public static func copyable(_ value: JSONValue?) -> Result<String, HandsError> {
        guard let text = value?.string else {
            return .failure(HandsError(.badArguments, "that property has no text to copy", suggestion: #"Copy the value or text: {"ref":"5","property":"value","copy":true}"#, retry: .never, nextCall: .null))
        }
        return .success(text)
    }
}

/// The one agent clipboard the app holds, behind a lock: calls come from several threads.
public final class SessionClipboardBox: @unchecked Sendable {
    public static let shared = SessionClipboardBox()
    private let lock = NSLock()
    private var board = SessionClipboard()
    public init() {}
    public func copy(_ text: String, session: String, now: Date = Date()) -> HandsError? { lock.lock(); defer { lock.unlock() }; return board.copy(text, session: session, now: now) }
    public func paste(session: String, now: Date = Date()) -> Result<String, HandsError> { lock.lock(); defer { lock.unlock() }; return board.paste(session: session, now: now) }
    public func end(session: String) { lock.lock(); board.end(session: session); lock.unlock() }
}
