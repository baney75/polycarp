import Foundation

/// The folder playlist (spec/player.md, R-P2): every file the player opens in the opened file's folder, in name
/// order as Finder sorts it (numbers by value, case ignored), hidden files left out. Pure: the caller lists the folder.
public struct PlayerPlaylist: Equatable, Sendable {
    /// Full paths, in order.
    public private(set) var items: [String]
    /// The one showing.
    public var index: Int

    public var current: String { items[index] }

    /// A playlist of the one file, before its folder has been read.
    public init(single path: String) {
        items = [path]
        index = 0
    }

    public init(items: [String], index: Int) {
        precondition(!items.isEmpty && items.indices.contains(index))
        self.items = items
        self.index = index
    }

    /// The playlist for `opened`, from the names in its folder. The opened file is always in it, even when its name
    /// would be skipped (a hidden file opened by path).
    public static func make(opened: String, names: [String]) -> PlayerPlaylist {
        let folder = (opened as NSString).deletingLastPathComponent
        let mine = (opened as NSString).lastPathComponent
        var keep = names.filter { name in
            name == mine || (!name.hasPrefix(".") && PlayerMedia.kind(of: name) != nil)
        }
        if !keep.contains(mine) { keep.append(mine) }
        let sorted = Array(Set(keep)).sorted(by: NameOrder.less)
        let paths = sorted.map { (folder as NSString).appendingPathComponent($0) }
        return PlayerPlaylist(items: paths, index: sorted.firstIndex(of: mine) ?? 0)
    }

    /// The index `step` away from the current one, or nil past either end (it never wraps). With `kinds`, items of
    /// other kinds are passed over: a song that ends goes to the next song, not to the cover photo beside it.
    public func neighbor(_ step: Int, kinds: Set<MediaKind>? = nil) -> Int? {
        guard step != 0 else { return index }
        let dir = step > 0 ? 1 : -1
        var left = abs(step)
        var i = index
        while true {
            i += dir
            guard items.indices.contains(i) else { return nil }
            if let kinds, let k = PlayerMedia.kind(of: items[i]), !kinds.contains(k) { continue }
            left -= 1
            if left == 0 { return i }
        }
    }

    /// The photos either side of the current item, to decode before they are asked for (R-P4). Next first.
    public var prefetch: [String] {
        [index + 1, index - 1].filter { items.indices.contains($0) && PlayerMedia.kind(of: items[$0]) == .photo }.map { items[$0] }
    }

    /// "3 of 40".
    public var position: String { "\(index + 1) of \(items.count)" }
}

/// Finder's name order without Foundation's locale machinery, so every platform sorts alike: runs of digits compare
/// by value ("2" before "10"), letters case-insensitively, and an exact tie falls back to the plain names.
public enum NameOrder {
    enum Run: Equatable { case text(String), number(String) }

    static func runs(_ s: String) -> [Run] {
        var out: [Run] = []
        var buf = ""
        var digits = false
        for ch in s.lowercased() {
            let d = ch.isASCII && ch.isNumber
            if !buf.isEmpty && d != digits {
                out.append(digits ? .number(buf) : .text(buf))
                buf = ""
            }
            digits = d
            buf.append(ch)
        }
        if !buf.isEmpty { out.append(digits ? .number(buf) : .text(buf)) }
        return out
    }

    /// Compares digit strings by value: leading zeros dropped, then length, then digits.
    static func compareNumbers(_ a: String, _ b: String) -> Int {
        let x = a.drop { $0 == "0" }, y = b.drop { $0 == "0" }
        if x.count != y.count { return x.count < y.count ? -1 : 1 }
        if x != y { return x < y ? -1 : 1 }
        return 0
    }

    public static func less(_ a: String, _ b: String) -> Bool {
        let ra = runs(a), rb = runs(b)
        for (x, y) in zip(ra, rb) {
            switch (x, y) {
            case let (.number(p), .number(q)):
                let c = compareNumbers(p, q)
                if c != 0 { return c < 0 }
            case let (.text(p), .text(q)):
                if p != q { return p < q }
            case (.number, .text): return true
            case (.text, .number): return false
            }
        }
        if ra.count != rb.count { return ra.count < rb.count }
        return a < b
    }
}

/// The photos still worth decoding (R-P4), read by the decode queues before each decode. A held arrow key queues a
/// decode for every photo it passes; the ones already passed are skipped instead of decoded into 48 MB each.
public final class PhotoWants: @unchecked Sendable {
    private let lock = NSLock()
    private var keys: Set<String> = []
    public init() {}
    public func set(_ new: Set<String>) { lock.lock(); keys = new; lock.unlock() }
    public func contains(_ key: String) -> Bool { lock.lock(); defer { lock.unlock() }; return keys.contains(key) }
}

/// What `application(_:open:)` was handed: the first file the player opens, and any Polycarp link. A link that starts
/// Polycarp arrives there, before the app's own link handler is installed, so it must not be dropped.
public enum PlayerOpen {
    public static let schemes: Set<String> = ["polycarp", "baneyspaces"]
    public static func route(_ urls: [URL]) -> (media: URL?, links: [URL]) {
        (urls.first { $0.isFileURL && PlayerMedia.kind(of: $0.path) != nil },
         urls.filter { !$0.isFileURL && schemes.contains($0.scheme ?? "") })
    }
}
