import Foundation

// The Baney Extended System's rooms (github.com/baney75/baney-extended-system): five folders under one root, sorted by
// what a thing asks of you. Polycarp files into them the way the `bes` command does: it moves, never deletes, never
// overwrites, and writes every move to the root's `.bes/journal.jsonl` in bes's own format, so `bes undo` reverses
// Polycarp's moves as it reverses its own. docs/rooms.md says what the owner sees.

/// One of the five rooms. The raw value is the number its folder starts with.
public enum Room: Int, CaseIterable, Sendable, Hashable {
    case inbox = 0, `do`, keep, know, letGo

    /// The folder under the root: "0 Inbox", "1 Do", "2 Keep", "3 Know", "4 Let Go" (bes `layout.ROOMS`).
    public var folder: String { "\(rawValue) \(name)" }

    public var name: String {
        switch self {
        case .inbox: "Inbox"
        case .do: "Do"
        case .keep: "Keep"
        case .know: "Know"
        case .letGo: "Let Go"
        }
    }

    /// The paper mark: `>` Do, `<` Keep, `=` Know, `x` Let Go. The Inbox has none.
    public var mark: String? {
        switch self {
        case .inbox: nil
        case .do: ">"
        case .keep: "<"
        case .know: "="
        case .letGo: "x"
        }
    }

    /// The name in one lowercase word, as filters and journal rules spell it: inbox, do, keep, know, letgo.
    public var id: String { name.lowercased().replacingOccurrences(of: " ", with: "") }

    /// What the room is for, in the words of bes's README.
    public var blurb: String {
        switch self {
        case .inbox: "Only what the machine could not decide"
        case .do: "Anything that asks something of you"
        case .keep: "Your story and your records"
        case .know: "The world's knowledge you gathered"
        case .letGo: "Everything else, held until you empty it"
        }
    }

    /// The SF Symbol the launcher and menu draw for it.
    public var symbol: String {
        switch self {
        case .inbox: "tray"
        case .do: "chevron.right.circle"
        case .keep: "archivebox"
        case .know: "books.vertical"
        case .letGo: "xmark.bin"
        }
    }

    /// The room a typed word names, or nil: its name ("know", "let go", "letgo", "let-go"), its folder ("3 know") or
    /// its mark (">"). A bare number is never a room: in the launcher "3" is workspace 3. Case never matters. With `prefix`, a unique start of a name counts too
    /// ("kn" is Know; "k" is Keep or Know, so nothing).
    public static func named(_ text: String, prefix: Bool = false) -> Room? {
        let t = text.trimmingCharacters(in: .whitespaces).lowercased()
        guard !t.isEmpty else { return nil }
        if let r = allCases.first(where: { $0.mark == t }) { return r }
        let squeezed = t.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "-", with: "")
        if let r = allCases.first(where: { $0.id == squeezed || $0.folder.lowercased() == t }) { return r }
        guard prefix else { return nil }
        let starts = allCases.filter { $0.id.hasPrefix(squeezed) }
        return starts.count == 1 ? starts[0] : nil
    }
}

/// A BES root: the folder that holds the five rooms and `.bes/`.
public struct Rooms: Equatable, Sendable {
    /// The default root, as bes's README sets it up (`bes init ~/BES`).
    public static let defaultRoot = "~/BES"

    public let root: URL

    public init(root: URL) { self.root = root.standardizedFileURL }

    /// The root as `surfaces.json` writes it (`rooms.root`): "~" and "~/" start at `home`; anything else is a path.
    public init(path: String, home: String = NSHomeDirectory()) {
        let p = path.trimmingCharacters(in: .whitespaces)
        let full = p == "~" ? home : p.hasPrefix("~/") ? home + "/" + p.dropFirst(2) : p
        self.init(root: URL(fileURLWithPath: full.isEmpty ? home + "/BES" : full, isDirectory: true))
    }

    /// The root `surfaces.json` names now (`rooms.root`).
    public static var configured: Rooms { Rooms(path: SurfacesStore.shared.current.rooms.root) }

    public func url(_ room: Room) -> URL { root.appendingPathComponent(room.folder, isDirectory: true) }

    public var journal: URL { root.appendingPathComponent(".bes/journal.jsonl") }

    /// Whether the root is set up: it holds `.bes/` (what `bes` itself checks) or an Inbox folder. Polycarp shows the
    /// rooms only then, and never makes them on its own.
    public func exists(fm: FileManager = .default) -> Bool {
        var dir: ObjCBool = false
        for p in [root.appendingPathComponent(".bes").path, url(.inbox).path] where fm.fileExists(atPath: p, isDirectory: &dir) && dir.boolValue {
            return true
        }
        return false
    }

    /// Things waiting in a room: what sits at its top level, hidden files (".DS_Store") left out.
    public func count(_ room: Room, fm: FileManager = .default) -> Int {
        ((try? fm.contentsOfDirectory(atPath: url(room).path)) ?? []).filter { !$0.hasPrefix(".") }.count
    }

    /// The room a path is in, or nil when it isn't inside one of this root's rooms.
    public func room(of path: URL) -> Room? {
        let rootParts = root.standardizedFileURL.pathComponents
        let parts = path.standardizedFileURL.pathComponents
        guard parts.count > rootParts.count, Array(parts.prefix(rootParts.count)) == rootParts else { return nil }
        return Room.allCases.first { $0.folder == parts[rootParts.count] }
    }

    /// Where the launcher and menu say a room is: "~/BES/3 Know".
    public func shown(_ room: Room, home: String = NSHomeDirectory()) -> String {
        let p = url(room).path
        return p.hasPrefix(home + "/") ? "~/" + p.dropFirst(home.count + 1) : p
    }
}

// MARK: Filing

extension Rooms {
    /// One item filed: where it was and where it is now.
    public struct Moved: Equatable, Sendable {
        public let from: URL
        public let to: URL
    }

    /// One item that stayed where it was, and why.
    public struct Failed: Equatable, Sendable {
        public let url: URL
        public let reason: String
    }

    /// What `file` did. `skipped` were already in the room; `failed` stayed where they were, with why.
    public struct Filing: Equatable, Sendable {
        public var batch: String
        public var moved: [Moved] = []
        public var skipped: [URL] = []
        public var failed: [Failed] = []

        /// A short line for a toast or trace.log: "Filed 3 in Know", "Filed 2 in Keep, 1 could not move".
        public func summary(_ room: Room) -> String {
            var s = moved.isEmpty ? "Nothing filed in \(room.name)" : "Filed \(moved.count) in \(room.name)"
            if !skipped.isEmpty { s += ", \(skipped.count) already there" }
            if !failed.isEmpty { s += ", \(failed.count) could not move" }
            return s
        }
    }

    /// Moves `urls` into `room`, keeping each name, as one batch, so `bes undo` with no count reverses the whole
    /// drop. A name the room already holds gets " (2)", " (3)" … (bes `journal.unique_path`); nothing is overwritten
    /// and nothing is deleted. A missing room folder is made, and recorded so an undo removes it again once empty.
    /// Every move is written to the journal before the next one starts; when the journal can't be written to,
    /// nothing moves. An item already at the top of the room is skipped. `now` and `newID` are for tests.
    public func file(_ urls: [URL], into room: Room, fm: FileManager = .default,
                     now: () -> Date = Date.init, newID: () -> String = Rooms.newID) -> Filing {
        var out = Filing(batch: newID())
        let rootDir = Self.resolved(root)
        let roomDir = rootDir.appendingPathComponent(room.folder, isDirectory: true)
        do {
            try fm.createDirectory(at: rootDir.appendingPathComponent(".bes", isDirectory: true), withIntermediateDirectories: true)
        } catch {
            out.failed = urls.map { Failed(url: $0, reason: "the journal can't be written: \(error.localizedDescription)") }
            return out
        }
        var reserved = Set<String>()
        for (i, original) in urls.enumerated() {
            let src = Self.resolved(original)
            guard fm.fileExists(atPath: src.path) || Self.isSymlink(src.path, fm: fm) else {
                out.failed.append(Failed(url: original, reason: "it is no longer there")); continue
            }
            if src.deletingLastPathComponent().path == roomDir.path { out.skipped.append(original); continue }
            if rootDir.path == src.path || rootDir.path.hasPrefix(src.path + "/")
                || src.deletingLastPathComponent().path == rootDir.path && Room.allCases.contains(where: { $0.folder == src.lastPathComponent }) {
                out.failed.append(Failed(url: original, reason: "it is a room or holds the rooms")); continue
            }
            let dest = Self.uniquePath(roomDir.appendingPathComponent(src.lastPathComponent), reserved: reserved, fm: fm)
            reserved.insert(dest.path)
            do {
                let made = try Self.move(src, to: dest, fm: fm)
                let entry = JournalEntry(id: newID(), batch: out.batch, ts: now(), from: Self.rel(rootDir, src), to: Self.rel(rootDir, dest),
                                         rule: "polycarp:\(room.id)", madeDirs: made.map { Self.rel(rootDir, $0) })
                do {
                    try Self.append(entry.line, to: rootDir.appendingPathComponent(".bes/journal.jsonl"))
                } catch {
                    // Put it back rather than leave a move `bes undo` can't see. Folders the move made go only if
                    // empty (rmdir), so a put-back that failed never takes the file with it.
                    try? fm.moveItem(at: dest, to: src)
                    for d in made.reversed() { Self.removeIfEmpty(d) }
                    let why = "the journal can't be written: \(error.localizedDescription)"
                    out.failed += urls[i...].map { Failed(url: $0, reason: why) }
                    break
                }
                out.moved.append(Moved(from: src, to: dest))
            } catch {
                out.failed.append(Failed(url: original, reason: error.localizedDescription))
            }
        }
        return out
    }

    /// bes's id: 12 hex digits of a random UUID (`uuid.uuid4().hex[:12]`).
    public static func newID() -> String {
        String(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(12))
    }

    /// `path`, or `path` with " (2)", " (3)" … before its extension, whichever is free first: bes
    /// `journal.unique_path`. A folder with no extension takes the number at the end of its whole name; a name
    /// already ending in " (2)" gets another (" (2) (2)"), as bes does.
    static func uniquePath(_ dest: URL, reserved: Set<String> = [], fm: FileManager) -> URL {
        func free(_ u: URL) -> Bool { !reserved.contains(u.path) && !fm.fileExists(atPath: u.path) && !isSymlink(u.path, fm: fm) }
        if free(dest) { return dest }
        var isDir: ObjCBool = false
        let dir = fm.fileExists(atPath: dest.path, isDirectory: &isDir) && isDir.boolValue
        let (stem, suffix) = split(dest.lastPathComponent)
        let (s, x) = dir && suffix.isEmpty ? (dest.lastPathComponent, "") : (stem, suffix)
        var n = 2
        while true {
            let candidate = dest.deletingLastPathComponent().appendingPathComponent("\(s) (\(n))\(x)")
            if free(candidate) { return candidate }
            n += 1
        }
    }

    /// A name's stem and last extension as Python's `pathlib` splits them (3.14): leading dots are part of the
    /// stem, then the last dot starts the extension. "a.tar.gz" is "a.tar" and ".gz", "notes." is "notes" and ".";
    /// ".bashrc" and "notes" have none.
    static func split(_ name: String) -> (stem: String, suffix: String) {
        let body = name.drop(while: { $0 == "." })
        guard let dot = body.lastIndex(of: ".") else { return (name, "") }
        let suffix = String(body[dot...])
        return (String(name.dropLast(suffix.count)), suffix)
    }

    /// Moves without overwriting (bes `journal.move`): makes any missing folders above `dest` and returns them, top
    /// first. FileManager refuses a destination that exists, so a name taken since `uniquePath` looked is an error,
    /// never an overwrite; across drives it copies, then removes the source, as `shutil.move` does.
    static func move(_ src: URL, to dest: URL, fm: FileManager) throws -> [URL] {
        var missing: [URL] = []
        var parent = dest.deletingLastPathComponent()
        while !fm.fileExists(atPath: parent.path), parent.path != "/" {
            missing.append(parent)
            parent = parent.deletingLastPathComponent()
        }
        var made: [URL] = []
        for d in missing.reversed() {
            try fm.createDirectory(at: d, withIntermediateDirectories: false)
            made.append(d)
        }
        do {
            try fm.moveItem(at: src, to: dest)
        } catch {
            for d in made.reversed() { removeIfEmpty(d) }
            throw error
        }
        return made
    }

    /// Removes a folder only when it is empty, as bes's undo does (`rmdir`): never a way to delete what's inside.
    static func removeIfEmpty(_ dir: URL) { _ = rmdir(dir.path) }

    /// A path inside the root relative to it, anything else absolute (bes `journal.rel`), so a drive keeps a working
    /// journal wherever it mounts.
    static func rel(_ root: URL, _ path: URL) -> String {
        let r = root.path, p = path.path
        return p.hasPrefix(r + "/") ? String(p.dropFirst(r.count + 1)) : p
    }

    /// The URL with its folder's symlinks resolved, the item itself left alone (a dropped link moves as a link), so
    /// a path inside the root reads as inside it however it was reached (/var against /private/var).
    static func resolved(_ url: URL) -> URL {
        let u = url.standardizedFileURL
        let parent = u.deletingLastPathComponent()
        let real = parent.path.withCString { p -> String? in
            guard let r = realpath(p, nil) else { return nil }
            defer { free(r) }
            return String(cString: r)
        }
        guard let real else { return u }
        return URL(fileURLWithPath: real, isDirectory: true).appendingPathComponent(u.lastPathComponent)
    }

    static func isSymlink(_ path: String, fm: FileManager) -> Bool {
        (try? fm.attributesOfItem(atPath: path)[.type] as? FileAttributeType) == .typeSymbolicLink
    }

    /// One line onto the journal, opened for appending so a bes sort writing at the same time never loses a line.
    static func append(_ line: String, to journal: URL) throws {
        let fd = open(journal.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(fd) }
        let bytes = Array((line + "\n").utf8)
        let wrote = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        guard wrote == bytes.count else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
}

// MARK: The journal

/// One move in `.bes/journal.jsonl`, written as bes's `json.dumps(entry, ensure_ascii=False)` writes it: the same keys
/// in the same order, the same spacing, the same escapes, so the file reads as one program's.
public struct JournalEntry: Equatable, Sendable {
    public var id: String
    public var batch: String
    public var ts: Date
    public var from: String
    public var to: String
    public var rule: String
    public var madeDirs: [String]

    public init(id: String, batch: String, ts: Date, from: String, to: String, rule: String, madeDirs: [String]) {
        self.id = id; self.batch = batch; self.ts = ts; self.from = from; self.to = to; self.rule = rule; self.madeDirs = madeDirs
    }

    public var line: String {
        let dirs = madeDirs.map(Self.quote).joined(separator: ", ")
        return "{\"id\": \(Self.quote(id)), \"batch\": \(Self.quote(batch)), \"ts\": \(Self.quote(Self.time(ts))), \"op\": \"move\", "
            + "\"from\": \(Self.quote(from)), \"to\": \(Self.quote(to)), \"rule\": \(Self.quote(rule)), \"made_dirs\": [\(dirs)]}"
    }

    /// Local time to the second with its offset, "2026-11-22T21:04:05-06:00" (bes `now_iso`).
    public static func time(_ date: Date, zone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = zone
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssxxx"
        return f.string(from: date)
    }

    /// A JSON string as Python's encoder writes it with `ensure_ascii=False`: quote, backslash and control characters
    /// escaped, everything else as is.
    public static func quote(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case _ where u.value < 0x20: out += String(format: "\\u%04x", u.value)
            default: out.unicodeScalars.append(u)
            }
        }
        return out + "\""
    }
}
