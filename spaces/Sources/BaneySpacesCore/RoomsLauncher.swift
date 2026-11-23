import Foundation

/// "room:know tax" in the launcher: the files search narrowed to one room. The filter is one word anywhere in what
/// was typed, `room:` and the room by name, a unique start of its name, or its mark ("room:kn", "room:="); the other
/// words are what the files search looks for.
public struct RoomFilter: Equatable, Sendable {
    public static let prefix = "room:"

    public let room: Room
    /// What was typed without the filter word, for the files search.
    public let words: String

    /// The filter in what was typed, or nil when there is none or its room is unknown or not yet unique.
    public static func parse(_ typed: String) -> RoomFilter? {
        guard let (asked, rest) = split(typed), let room = Room.named(asked, prefix: true) else { return nil }
        return RoomFilter(room: room, words: rest)
    }

    /// The rooms a filter word still being typed could mean ("room:" all five, "room:k" Keep and Know), so the
    /// launcher can offer them. Empty once there is no filter word.
    public static func candidates(_ typed: String) -> [Room] {
        guard let (asked, _) = split(typed) else { return [] }
        if let exact = Room.named(asked, prefix: true) { return [exact] }
        let t = asked.lowercased().replacingOccurrences(of: "-", with: "")
        return Room.allCases.filter { $0.id.hasPrefix(t) }
    }

    /// The filter word's room part and the rest of what was typed. Cheap: one pass over the words.
    private static func split(_ typed: String) -> (asked: String, rest: String)? {
        guard typed.range(of: prefix, options: .caseInsensitive) != nil else { return nil }
        var asked: String?
        var rest: [Substring] = []
        for w in typed.split(whereSeparator: \.isWhitespace) {
            if asked == nil, w.count >= prefix.count, w.prefix(prefix.count).lowercased() == prefix {
                asked = String(w.dropFirst(prefix.count))
            } else {
                rest.append(w)
            }
        }
        return asked.map { ($0, rest.joined(separator: " ")) }
    }
}

/// The launcher's rooms: typing a room's name or mark ("know", "=", "let go", "x", "inbox") puts that room first, and
/// Return opens it in Finder. A filter ("room:know tax") puts its room first too, above the files it narrows.
/// It answers from what `refresh` read when the launcher opened, never the disk, and shows nothing while the root
/// isn't set up: Polycarp offers the rooms, it never asks to make them.
public final class RoomsProvider: LauncherProvider {
    public static let shared = RoomsProvider()
    public let name = "rooms"

    /// The root, when it is set up.
    public private(set) var rooms: Rooms?
    /// Items waiting in the Inbox when the launcher opened.
    public private(set) var inbox = 0
    private let home: String

    public init(home: String = NSHomeDirectory()) { self.home = home }

    /// Reads the root and the Inbox count: one look at the root and one directory listing, when the launcher opens.
    public func refresh(_ rooms: Rooms = .configured, fm: FileManager = .default) {
        let set = rooms.exists(fm: fm)
        self.rooms = set ? rooms : nil
        inbox = set ? rooms.count(.inbox, fm: fm) : 0
    }

    /// The filter in what was typed, only while there are rooms to narrow to.
    public func filter(_ typed: String) -> RoomFilter? { rooms == nil ? nil : RoomFilter.parse(typed) }

    public func results(for query: String) -> [LauncherResult] {
        guard let rooms else { return [] }
        let candidates = RoomFilter.candidates(query)
        if !candidates.isEmpty { return candidates.map { row($0, rooms, filtering: RoomFilter.parse(query)?.words) } }
        guard let room = Room.named(query) else { return [] }
        return [row(room, rooms, filtering: nil)]
    }

    private func row(_ room: Room, _ rooms: Rooms, filtering words: String?) -> LauncherResult {
        var subtitle = rooms.shown(room, home: home)
        if let mark = room.mark { subtitle += " · \(mark)" }
        if room == .inbox { subtitle += " · \(inbox == 1 ? "1 item waits" : "\(inbox) items wait")" }
        if let words {
            subtitle += words.isEmpty ? " · type words to find files in it" : " · files below are in this room"
        } else {
            subtitle += " · Return opens it in Finder"
        }
        return LauncherResult(id: "room:\(room.id)", section: "Rooms", title: room.name, subtitle: subtitle, symbol: room.symbol,
                              placement: .top, action: .open(rooms.url(room)))
    }
}
