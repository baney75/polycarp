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
        if let e = Self.sessionRefusal(session) { return e }
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
        if let e = Self.sessionRefusal(session) { return .failure(e) }
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

    /// No session, or the "default" every caller without a terminal shares: no clipboard, so two agents never share one
    /// (198 r1 first-F3). An entry is keyed on the session id the caller gives, and that id is trusted as given: MCP gives
    /// each connection its own, but a CLI caller that sets BANEYSPACES_SESSION to another agent's id (or its tty name)
    /// reads what that agent copied. Nothing here keeps apart two agents of the same user that choose ids (198 r2 second-S3).
    static func sessionRefusal(_ session: String) -> HandsError? {
        guard session.isEmpty || session == "default" else { return nil }
        return HandsError(.badArguments, "the agent clipboard needs a session of its own, and this call has none",
                          suggestion: "Use the MCP server, which gives each connection its own session, or set BANEYSPACES_SESSION to a name only this agent uses.",
                          retry: .never, nextCall: .null)
    }

    public mutating func end(session: String) { entries[session] = nil }

    public mutating func expire(now: Date) { entries = entries.filter { now.timeIntervalSince($0.value.at) < Self.idle } }

    public var sessions: Int { entries.count }

    /// The answer for anything that would reach the general pasteboard: a key, or a menu or context-menu item.
    public static func pasteboardRefusal(_ what: String) -> HandsError {
        HandsError(.notSupported, "\(what) uses the Mac's clipboard, which is Donovan's, so Polycarp doesn't send it",
                   suggestion: #"Use the agent clipboard: {"ref":"5","copy":true} on computer_get, then {"ref":"7","paste":true} on computer_type. To delete a selection, press Delete."#,
                   retry: .never, nextCall: .null)
    }

    /// Cut, copy and paste chords: command with c, x or v, whatever else is held (cmd+shift+v and cmd+opt+shift+v paste
    /// and match style; cmd+opt+v moves in Finder). By ANSI key code, and by `characters`: what the key types in the
    /// Mac's current layouts, since an app reads cmd+c by its character (cmd+i is copy on Dvorak).
    public static let pasteboardKeyCodes: Set<UInt16> = [7, 8, 9]   // x, c, v on the ANSI layout

    /// `characters` is read only for a chord with command held: reading the layout costs a hop to the main thread (198 r2 first-F4).
    public static func usesPasteboard(_ c: KeyChord, characters: @autoclosure () -> [Character] = []) -> Bool {
        guard c.flags & KeyChord.command != 0 else { return false }
        return pasteboardKeyCodes.contains(c.keyCode) || characters().contains { ["c", "x", "v"].contains($0.lowercased()) }
    }

    /// Cut, copy and paste items, by the action AppKit names an item by (its AX identifier, in any language), and by
    /// English title only for a menu item that has no identifier (198 r1 first-F2, r2 first-F3).
    public static let pasteboardActions: Set<String> = ["cut:", "copy:", "paste:", "pasteasplaintext:", "pasteandmatchstyle:", "pasteasrichtext:"]
    public static let pasteboardTitles: Set<String> = ["cut", "copy", "paste", "paste and match style", "paste as plain text"]

    /// Whether an element is a cut, copy or paste item. A button an app titles Copy, or an item titled Copy that AppKit
    /// wires to another action, is the app's own and not caught.
    public static func isPasteboardItem(role: String, name: String, identifier: String) -> Bool {
        let id = identifier.trimmingCharacters(in: .whitespaces)
        if !id.isEmpty { return pasteboardActions.contains(id.lowercased()) }
        return role == "menuitem" && pasteboardTitles.contains(name.lowercased())
    }

    /// The title of the cut, copy or paste item a `click` on row `number`, or a `select` of `option` under it, would
    /// press, or nil. The option is matched ignoring case, at least as loosely as the engine matches it (198 r2
    /// second-S1). A closed popup's items are in no read; the engine refuses those after the popup opens (`engineRefusal`).
    public static func pasteboardItem(rows: [SnapshotRows.Row], number: Int, option: String?) -> String? {
        guard let i = rows.firstIndex(where: { $0.number == number }) else { return nil }
        func hit(_ r: SnapshotRows.Row) -> Bool { isPasteboardItem(role: r.role, name: r.name, identifier: r.identifier) }
        guard let option else { return hit(rows[i]) ? rows[i].name : nil }
        let want = option.lowercased()
        return rows.first { r in r.name.lowercased() == want && hit(r) && SnapshotRows.descends(rows, r, from: i) }?.name
    }

    /// `@e12` -> title for each cut, copy or paste item in a snapshot's `refmap.json`, read once when the snapshot is
    /// taken and held as long as its refs resolve, so a click on one is refused however many reads came after (198 r2
    /// first-F1). Empty when the file isn't the expected shape.
    public static func pasteboardRefs(refmap data: Data) -> [String: String] {
        guard let inner = JSONValue.parse(data)?["inner"]?.object else { return [:] }
        var out: [String: String] = [:]
        for (key, e) in inner {
            let id = e["native_id"]?["kind"]?.string == "ax_identifier" ? e["native_id"]?["value"]?.string ?? "" : ""
            let name = e["name"]?.string ?? ""
            if isPasteboardItem(role: e["role"]?.string ?? "", name: name, identifier: id) { out[key] = name.isEmpty ? id : name }
        }
        return out
    }

    /// The engine's refusal of a cut, copy or paste item it found in an opened popup or menu, before pressing it
    /// (engine/patches/0003), as Polycarp's own answer. Nil for any other engine error.
    public static func engineRefusal(_ err: JSONValue) -> HandsError? {
        guard err["details"]?["kind"]?.string == "pasteboard_item" else { return nil }
        let title = err["details"]?["title"]?.string ?? "", id = err["details"]?["identifier"]?.string ?? ""
        return pasteboardRefusal(title.isEmpty ? (id.isEmpty ? "that menu item" : id) : title)
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
