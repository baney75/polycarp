// The launcher's matcher for a browser's tabs, bookmarks, history and downloads: no Foundation, no Apple frameworks.
// Optimized in debug builds too (Package.swift), so `swift test` times it as it ships (`BrowserTableTests`): a key press
// asks it on the main thread, over tens of thousands of rows.
//
// Titles and addresses come in folded (lowercased, accents dropped) and lie back to back in one byte buffer. Three masks
// a row, its letters, its pairs of letters and what its words start with, pass over nearly every row that lacks what
// was typed or can't rank above what was found; the rest are walked, once a word.
//
// Scores sit on the scale `Fuzzy` gives an app's name (1000 the whole name, 900 its start, 700 a word's start, 500 inside),
// so a row can be ranked against an app. A site's start ranks just under a title's. Words typed apart all have to be there.

/// Not for two threads at once: the one that owns it adds, removes and searches.
public final class BrowserTable {
    public struct Hit: Equatable, Sendable {
        public let slot: Int
        public let score: Int
    }

    private var bytes: [UInt8] = []
    /// Row `i`'s text is `bytes[starts[i]..<starts[i + 1]]`: the title, a separator, the address.
    private var starts: [Int] = [0]
    private var titleEnds: [Int] = []
    private var letters: [UInt64] = []
    private var pairs: [UInt64] = []
    private var heads: [UInt64] = []
    /// What a title's length costs: its characters, up to 99.
    private var costs: [UInt8] = []
    /// 0 to 60, added to the score: what is visited often or was just used. `gone` marks a removed row.
    private var weights: [UInt8] = []
    private static let gone = UInt8.max
    private static let separator: UInt8 = 0x1F
    /// Words past this many aren't looked for; nobody types them and each costs a walk.
    public static let words = 4
    /// An address is matched this far: past it are keys and tracking, and a row that fills the masks is never passed over.
    public static let addressBytes = 300

    public private(set) var live = 0
    /// Slots ever given out, removed ones too.
    public var slots: Int { weights.count }

    public init() {}

    /// Adds a row and returns its slot, which stays its own. The title and address come folded, and the address without
    /// its scheme and `www.`, so the site starts it. Space is never given back: the owner builds a new table once `slots` is
    /// far over `live`.
    public func add(title: String, address: String, weight: Int) -> Int {
        let from = bytes.count
        bytes.append(contentsOf: title.utf8)
        titleEnds.append(bytes.count)
        bytes.append(Self.separator)
        bytes.append(contentsOf: address.utf8.prefix(Self.addressBytes))
        starts.append(bytes.count)
        var l: UInt64 = 0, p: UInt64 = 0, h: UInt64 = 0
        var prev: UInt8 = Self.separator
        var characters = 0
        let title = titleEnds[titleEnds.count - 1]
        bytes.withUnsafeBufferPointer { bytes in
            for i in from..<bytes.count {
                let b = bytes[i]
                if i < title, b & 0xC0 != 0x80 { characters += 1 }
                l |= Self.letter(b)
                p |= Self.pair(prev, b)
                if i == from || Self.startsWord(bytes, i, from) { h |= Self.head(b, i + 1 < bytes.count ? bytes[i + 1] : nil) }
                prev = b
            }
        }
        letters.append(l)
        pairs.append(p)
        heads.append(h)
        costs.append(UInt8(min(characters, 99)))
        weights.append(UInt8(max(0, min(60, weight))))
        live += 1
        return weights.count - 1
    }

    /// Takes a row out: it answers nothing, and its text is overwritten.
    public func remove(_ slot: Int) {
        guard weights.indices.contains(slot), weights[slot] != Self.gone else { return }
        weights[slot] = Self.gone
        letters[slot] = 0
        pairs[slot] = 0
        heads[slot] = 0
        for i in starts[slot]..<starts[slot + 1] { bytes[i] = 0 }
        live -= 1
    }

    /// A row's bytes as they lie, for the tests.
    func text(_ slot: Int) -> [UInt8] { Array(bytes[starts[slot]..<starts[slot + 1]]) }

    /// The best `limit` rows for `folded`, best first; ties go to the row added last. Nothing typed finds nothing.
    public func search(_ folded: String, limit: Int) -> [Hit] {
        let typed = folded.utf8.split(separator: 0x20).map(Array.init)
        guard !typed.isEmpty, limit > 0 else { return [] }
        let whole = Array(typed.joined(separator: [0x20]))
        let phrase = typed.count > 1
        var parts = Array(typed.prefix(Self.words))
        // The longest word first: it is the one a row is likeliest to lack.
        parts.sort { $0.count > $1.count }
        var needL: UInt64 = 0, needP: UInt64 = 0, needH: UInt64 = 0, phraseP: UInt64 = 0
        for w in parts {
            needH |= Self.head(w[0], w.count > 1 ? w[1] : nil)
            for i in w.indices {
                needL |= Self.letter(w[i])
                if i > 0 { needP |= Self.pair(w[i - 1], w[i]) }
            }
        }
        for i in whole.indices.dropFirst() { phraseP |= Self.pair(whole[i - 1], whole[i]) }
        let head = Self.head(whole[0], whole.count > 1 ? whole[1] : nil)
        var best: [(score: Int, slot: Int)] = []
        var floor = Int.min
        bytes.withUnsafeBufferPointer { bytes in
        starts.withUnsafeBufferPointer { starts in
        titleEnds.withUnsafeBufferPointer { titleEnds in
        letters.withUnsafeBufferPointer { letters in
        pairs.withUnsafeBufferPointer { pairs in
        heads.withUnsafeBufferPointer { heads in
        costs.withUnsafeBufferPointer { costs in
        weights.withUnsafeBufferPointer { weights in
            for i in 0..<weights.count {
                // A removed row has no letters.
                guard needL & ~letters[i] == 0, needP & ~pairs[i] == 0 else { continue }
                let from = starts[i], title = titleEnds[i], to = starts[i + 1]
                let more = Int(weights[i]) - Int(costs[i])
                // The most this row could rank, so one that can't join a full list isn't walked: 1000 only where the first
                // letter starts the title or the site, 700 only where it starts a word.
                let start = bytes[from] == whole[0] || (title + 1 < to && bytes[title + 1] == whole[0])
                let together = start ? 1000 : head & ~heads[i] == 0 ? 700 : 500
                let hasPhrase = phrase && phraseP & ~pairs[i] == 0
                let apart = needH & ~heads[i] == 0 ? 600 : 500
                let most = !phrase ? together : hasPhrase ? max(apart, together) : apart
                guard most + more >= floor else { continue }
                var score = Int.max
                for w in parts {
                    let s = Self.rank(w, bytes, from, title, to)
                    if s < score { score = s }
                    if s == 0 { break }
                }
                guard score > 0 else { continue }
                if phrase {
                    // Words apart rank as their weakest, and no better than a word's start; the phrase itself ranks whole.
                    score = min(score, 600)
                    if hasPhrase { score = max(score, Self.rank(whole, bytes, from, title, to)) }
                }
                score += more
                guard score >= floor || best.count < limit else { continue }
                var at = best.count
                while at > 0, best[at - 1].score <= score { at -= 1 }
                best.insert((score, i), at: at)
                if best.count > limit { best.removeLast() }
                if best.count == limit { floor = best[limit - 1].score }
            }
        }}}}}}}}
        return best.map { Hit(slot: $0.slot, score: $0.score) }
    }

    /// How well one word (or phrase) answers a row; 0 when it isn't there.
    @inline(__always)
    private static func rank(_ w: [UInt8], _ bytes: UnsafeBufferPointer<UInt8>, _ from: Int, _ title: Int, _ to: Int) -> Int {
        let n = w.count
        return w.withUnsafeBufferPointer { w in
            let first = w[0]
            func lies(_ at: Int) -> Bool {
                var k = 0
                while k < n, bytes[at + k] == w[k] { k += 1 }
                return k == n
            }
            if from + n <= title, lies(from) { return from + n == title ? 1000 : 900 }
            if title + 1 + n <= to, lies(title + 1) { return 880 }
            // The first word's start found is as good as any after it: the title comes before the address.
            var inside = 0, at = from + 1
            while at + n <= title {
                if bytes[at] == first, lies(at) {
                    if startsWord(bytes, at, from) { return 700 }
                    inside = 500
                }
                at += 1
            }
            at = title + 2
            while at + n <= to {
                if bytes[at] == first, lies(at) {
                    if startsWord(bytes, at, from) { return 650 }
                    if inside == 0 { inside = 450 }
                }
                at += 1
            }
            return inside
        }
    }

    /// Whether a word starts at `at`: what comes before it is no letter or digit, in ASCII or past it (a curly quote, a dash
    /// or a no-break space: U+0080 to U+00BF, U+2000 to U+207F, U+3000 to U+303F).
    @inline(__always) private static func startsWord(_ bytes: UnsafeBufferPointer<UInt8>, _ at: Int, _ from: Int) -> Bool {
        let b = bytes[at - 1]
        if b < 0x80 { return !((b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39)) }
        if at - 2 >= from, bytes[at - 2] == 0xC2 { return true }
        guard at - 3 >= from else { return false }
        return bytes[at - 3] == 0xE2 && (bytes[at - 2] == 0x80 || bytes[at - 2] == 0x81) || bytes[at - 3] == 0xE3 && bytes[at - 2] == 0x80
    }
    @inline(__always) private static func letter(_ b: UInt8) -> UInt64 { 1 << UInt64(b & 63) }
    /// A word's first letter, and its first two: half a mask each.
    @inline(__always) private static func head(_ a: UInt8, _ b: UInt8?) -> UInt64 {
        let one: UInt64 = 1 << UInt64(a & 31)
        guard let b else { return one }
        return one | 1 << UInt64(32 + (Int(a) &* 31 &+ Int(b) &* 7) & 31)
    }
    @inline(__always) private static func pair(_ a: UInt8, _ b: UInt8) -> UInt64 { 1 << UInt64((Int(a) &* 31 &+ Int(b) &* 7) & 63) }
}
