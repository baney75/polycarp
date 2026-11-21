// The launcher's people matcher: no Foundation, no Apple frameworks. Optimized in debug builds too (Package.swift), so
// `swift test` times it as it ships (`ContactsSpeedTests`): a key press asks it on the main thread.
//
// Names, nicknames and companies come in already folded (lowercased, accents dropped) and go into one flat byte buffer
// with every word's start found ahead of time, so a query walks small integer arrays and no strings.
//
// How well a person answers, best first (`Hit.tier`): 5 the whole name, 4 the name starts with what was typed, 3 each
// typed word starts a word of the name, nickname or company ("an sm" is Anna Smith), 2 the initials ("as"), 1 the
// letters appear together ("nna"), 0 the letters appear in order ("asmth"). People the owner reached lately come first
// among the matches of tier 2 and up; the weak ones follow.

public final class ContactTable: @unchecked Sendable {
    /// One person found: their place in the table, how well they answered, and whether they were reached lately.
    public struct Hit: Equatable, Sendable {
        public let index: Int
        public let tier: Int
        public let recent: Bool
    }

    /// No recent use.
    public static let notRecent = UInt16.max

    private let bytes: [UInt8]
    /// Person `i`'s text is `bytes[starts[i]..<starts[i + 1]]`, the name first, up to `nameEnds[i]`.
    private let starts: [Int32]
    private let nameEnds: [Int32]
    /// Person `i`'s words start at `wordStarts[wordFrom[i]..<wordFrom[i + 1]]`; the first `nameWords[i]` are the name's.
    private let wordStarts: [Int32]
    private let wordFrom: [Int32]
    private let nameWords: [UInt8]
    /// The letters each person's text has, one bit each, to skip people quickly.
    private let masks: [UInt64]

    public var count: Int { masks.count }

    /// `fields[i]` is person `i`'s folded name, then nickname and company (empty ones skipped).
    public init(_ fields: [[String]]) {
        var bytes: [UInt8] = [], starts: [Int32] = [], nameEnds: [Int32] = [], wordStarts: [Int32] = [], wordFrom: [Int32] = []
        var nameWords: [UInt8] = [], masks: [UInt64] = []
        bytes.reserveCapacity(fields.count * 32)
        for person in fields {
            starts.append(Int32(bytes.count))
            wordFrom.append(Int32(wordStarts.count))
            var mask: UInt64 = 0
            var nameEnd = Int32(bytes.count)
            var inName: UInt8 = 0
            for (n, f) in person.enumerated() where !f.isEmpty {
                if bytes.count > Int(starts[starts.count - 1]) { bytes.append(0x1F) }
                var prev: UInt8 = 0x1F
                for b in f.utf8 {
                    if Self.isWord(b) {
                        if !Self.isWord(prev) {
                            wordStarts.append(Int32(bytes.count))
                            if n == 0, inName < 255 { inName += 1 }
                        }
                        mask |= Self.bit(b)
                    }
                    bytes.append(b)
                    prev = b
                }
                if n == 0 { nameEnd = Int32(bytes.count) }
            }
            nameEnds.append(nameEnd)
            nameWords.append(inName)
            masks.append(mask)
        }
        starts.append(Int32(bytes.count))
        wordFrom.append(Int32(wordStarts.count))
        self.bytes = bytes
        self.starts = starts
        self.nameEnds = nameEnds
        self.wordStarts = wordStarts
        self.wordFrom = wordFrom
        self.nameWords = nameWords
        self.masks = masks
    }

    @inline(__always) static func isWord(_ b: UInt8) -> Bool {
        b >= 0x80 || (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x7A) || (b >= 0x41 && b <= 0x5A)
    }

    @inline(__always) static func bit(_ b: UInt8) -> UInt64 {
        if b >= 0x61 && b <= 0x7A { return 1 << UInt64(b - 0x61) }
        if b >= 0x30 && b <= 0x39 { return 1 << UInt64(26 + b - 0x30) }
        return 1 << UInt64(36 + b % 28)
    }

    /// What was typed, already folded.
    struct Query {
        /// The query with each run of non-word characters as one space.
        var whole: [UInt8] = []
        /// Each typed word, as ranges of `whole`.
        var words: [Range<Int>] = []
        /// The letters alone, for letters in order.
        var letters: [UInt8] = []
        var mask: UInt64 = 0

        init?(_ folded: String) {
            var start = -1
            for b in folded.utf8 {
                if ContactTable.isWord(b) {
                    if start < 0 {
                        if !whole.isEmpty { whole.append(0x20) }
                        start = whole.count
                    }
                    whole.append(b)
                    letters.append(b)
                    mask |= ContactTable.bit(b)
                } else if start >= 0 {
                    words.append(start..<whole.count)
                    start = -1
                }
            }
            if start >= 0 { words.append(start..<whole.count) }
            if words.isEmpty { return nil }
        }
    }

    /// The people that answer `folded`, best first, at most `limit`. `ranks[i]` is person `i`'s place in the recents
    /// (0 the newest), `notRecent` for none.
    public func search(_ folded: String, ranks: [UInt16]? = nil, limit: Int = 8) -> [Hit] {
        guard limit > 0, let q = Query(folded) else { return [] }
        let ranked = ranks?.count == count ? ranks : nil
        var best: [UInt64] = []
        best.reserveCapacity(limit + 1)
        bytes.withUnsafeBufferPointer { b in
        wordStarts.withUnsafeBufferPointer { ws in
        starts.withUnsafeBufferPointer { st in
        nameEnds.withUnsafeBufferPointer { ne in
        wordFrom.withUnsafeBufferPointer { wf in
        nameWords.withUnsafeBufferPointer { nw in
        masks.withUnsafeBufferPointer { ms in
        q.whole.withUnsafeBufferPointer { whole in
        q.letters.withUnsafeBufferPointer { letters in
            let table = Buffers(b: b, ws: ws, starts: st, nameEnds: ne, wordFrom: wf, nameWords: nw)
            for i in 0..<ms.count {
                guard ms[i] & q.mask == q.mask, let tier = table.tier(i, whole, q.words, letters) else { continue }
                // Smaller sorts first: strong matches, then recents, then tier, then shorter names, then Contacts' order.
                let weak: UInt64 = tier >= 2 ? 0 : 1
                let recent = UInt64(tier >= 2 ? (ranked?[i] ?? Self.notRecent) : Self.notRecent)
                let length = UInt64(min(Int(ne[i] - st[i]), 255))
                let key = weak << 59 | recent << 43 | UInt64(5 - tier) << 40 | length << 32 | UInt64(i)
                if best.count == limit, key >= best[limit - 1] { continue }
                var at = best.count
                while at > 0, best[at - 1] > key { at -= 1 }
                best.insert(key, at: at)
                if best.count > limit { best.removeLast() }
            }
        }}}}}}}}}
        return best.map { key in
            Hit(index: Int(key & 0xFFFF_FFFF), tier: 5 - Int((key >> 40) & 0x7),
                recent: (key >> 43) & 0xFFFF != UInt64(Self.notRecent))
        }
    }

    private struct Buffers {
        let b: UnsafeBufferPointer<UInt8>
        let ws: UnsafeBufferPointer<Int32>
        let starts: UnsafeBufferPointer<Int32>
        let nameEnds: UnsafeBufferPointer<Int32>
        let wordFrom: UnsafeBufferPointer<Int32>
        let nameWords: UnsafeBufferPointer<UInt8>

        @inline(__always) func tier(_ i: Int, _ whole: UnsafeBufferPointer<UInt8>, _ words: [Range<Int>],
                                    _ letters: UnsafeBufferPointer<UInt8>) -> Int? {
            let s = Int(starts[i]), e = Int(starts[i + 1]), ne = Int(nameEnds[i])
            // The name compared with what was typed as one string. A run of punctuation or spaces in the name answers
            // the query's one space, so "mary jane" finds Mary-Jane.
            if whole.count <= ne - s, let end = matched(s, ne, whole) {
                var rest = end
                while rest < ne, !ContactTable.isWord(b[rest]) { rest += 1 }
                return rest == ne ? 5 : 4
            }
            let w0 = Int(wordFrom[i]), w1 = Int(wordFrom[i + 1])
            var all = true
            for word in words {
                var found = false
                var w = w0
                while w < w1 {
                    if startsWith(Int(ws[w]), e, whole, word) { found = true; break }
                    w += 1
                }
                if !found { all = false; break }
            }
            if all { return 3 }
            let count = whole.count
            if words.count == 1, count >= 2, count <= Int(nameWords[i]) {
                var k = 0
                while k < count, b[Int(ws[w0 + k])] == whole[k] { k += 1 }
                if k == count { return 2 }
            }
            if count >= 2, contains(s, e, whole) { return 1 }
            if letters.count >= 3 {
                var at = s
                for ch in letters {
                    while at < e, b[at] != ch { at += 1 }
                    if at == e { return nil }
                    at += 1
                }
                return 0
            }
            return nil
        }

        /// Where the name stopped matching when it starts with `q`; nil when it doesn't.
        @inline(__always) func matched(_ s: Int, _ ne: Int, _ q: UnsafeBufferPointer<UInt8>) -> Int? {
            var at = s
            for k in 0..<q.count {
                guard at < ne else { return nil }
                let want = q[k]
                if want == 0x20 {
                    guard !ContactTable.isWord(b[at]) else { return nil }
                    while at < ne, !ContactTable.isWord(b[at]) { at += 1 }
                    continue
                }
                guard b[at] == want else { return nil }
                at += 1
            }
            return at
        }

        @inline(__always) func startsWith(_ at: Int, _ end: Int, _ q: UnsafeBufferPointer<UInt8>, _ word: Range<Int>) -> Bool {
            guard at + word.count <= end else { return false }
            var k = 0
            for j in word {
                if b[at + k] != q[j] { return false }
                k += 1
            }
            return true
        }

        @inline(__always) func contains(_ s: Int, _ e: Int, _ q: UnsafeBufferPointer<UInt8>) -> Bool {
            let n = q.count
            guard n > 0, e - s >= n else { return false }
            let first = q[0]
            var at = s
            while at <= e - n {
                if b[at] == first {
                    var k = 1
                    while k < n, b[at + k] == q[k] { k += 1 }
                    if k == n { return true }
                }
                at += 1
            }
            return false
        }
    }
}
