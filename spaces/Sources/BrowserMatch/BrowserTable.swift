// The launcher's matcher for a browser's tabs, bookmarks, history and downloads: no Foundation, no Apple frameworks.
// Optimized in debug builds too (Package.swift), so `swift test` times it as it ships (`BrowserTableTests`): a key press
// asks it on the main thread, over tens of thousands of rows.
//
// Titles and addresses come in folded (lowercased, accents dropped) and lie back to back in one byte buffer. Two masks a
// row, its letters and its pairs of letters, pass over nearly every row that lacks what was typed; the rest are walked once.
//
// Scores sit on the scale `Fuzzy` gives an app's name (1000 the whole name, 900 its start, 700 a word's start, 500 inside),
// so a row can be ranked against an app. A site's start ranks just under a title's. Words typed apart all have to be there.

public final class BrowserTable: @unchecked Sendable {
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
    /// 0 to 60, added to the score: what is visited often or was just used. `gone` marks a removed row.
    private var weights: [UInt8] = []
    private static let gone = UInt8.max
    private static let separator: UInt8 = 0x1F
    /// Words past this many aren't looked for; nobody types them and each costs a walk.
    public static let words = 4

    public private(set) var live = 0
    /// Slots ever given out, removed ones too.
    public var slots: Int { weights.count }

    public init() {}

    /// Adds a row and returns its slot, which stays its own.
    public func add(title: String, address: String, weight: Int) -> Int {
        let from = bytes.count
        bytes.append(contentsOf: title.utf8)
        titleEnds.append(bytes.count)
        bytes.append(Self.separator)
        bytes.append(contentsOf: address.utf8)
        starts.append(bytes.count)
        var l: UInt64 = 0, p: UInt64 = 0
        var prev: UInt8 = Self.separator
        for i in from..<bytes.count {
            let b = bytes[i]
            l |= Self.letter(b)
            p |= Self.pair(prev, b)
            prev = b
        }
        letters.append(l)
        pairs.append(p)
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
        for i in starts[slot]..<starts[slot + 1] { bytes[i] = 0 }
        live -= 1
    }

    /// The best `limit` rows for `folded`, best first; ties go to the row added last. Nothing typed finds nothing.
    public func search(_ folded: String, limit: Int) -> [Hit] {
        var parts = folded.utf8.split(separator: 0x20).prefix(Self.words).map(Array.init)
        guard !parts.isEmpty, limit > 0 else { return [] }
        let whole = Array(parts.joined(separator: [0x20]))
        let phrase = parts.count > 1
        // The longest word first: it is the one a row is likeliest to lack.
        parts.sort { $0.count > $1.count }
        var needL: UInt64 = 0, needP: UInt64 = 0
        for w in parts {
            for i in w.indices {
                needL |= Self.letter(w[i])
                if i > 0 { needP |= Self.pair(w[i - 1], w[i]) }
            }
        }
        var best: [(score: Int, slot: Int)] = []
        var floor = Int.min
        bytes.withUnsafeBufferPointer { bytes in
        starts.withUnsafeBufferPointer { starts in
        titleEnds.withUnsafeBufferPointer { titleEnds in
        letters.withUnsafeBufferPointer { letters in
        pairs.withUnsafeBufferPointer { pairs in
        weights.withUnsafeBufferPointer { weights in
            for i in 0..<weights.count {
                guard needL & ~letters[i] == 0, needP & ~pairs[i] == 0, weights[i] != Self.gone else { continue }
                let from = starts[i], title = titleEnds[i], to = starts[i + 1]
                let more = Int(weights[i]) - min(title - from, 99)
                // Only a row that starts with the first letter can rank over 700, so most need no walk once the list is full.
                let most = bytes[from] == whole[0] || (title + 1 < to && bytes[title + 1] == whole[0]) ? 1000 : 700
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
                    score = max(min(score, 600), Self.rank(whole, bytes, from, title, to))
                }
                score += more
                guard score >= floor || best.count < limit else { continue }
                var at = best.count
                while at > 0, best[at - 1].score <= score { at -= 1 }
                best.insert((score, i), at: at)
                if best.count > limit { best.removeLast() }
                if best.count == limit { floor = best[limit - 1].score }
            }
        }}}}}}
        return best.map { Hit(slot: $0.slot, score: $0.score) }
    }

    /// How well one word (or phrase) answers a row; 0 when it isn't there.
    @inline(__always)
    private static func rank(_ w: [UInt8], _ bytes: UnsafeBufferPointer<UInt8>, _ from: Int, _ title: Int, _ to: Int) -> Int {
        let n = w.count
        return w.withUnsafeBufferPointer { w in
            let first = w[0]
            var best = 0
            var at = from
            while at + n <= to {
                if bytes[at] == first {
                    var k = 1
                    while k < n, bytes[at + k] == w[k] { k += 1 }
                    if k == n {
                        let s: Int
                        if at == from { s = at + n == title ? 1000 : 900 }
                        else if at == title + 1 { s = 880 }
                        else if !isWord(bytes[at - 1]) { s = at < title ? 700 : 650 }
                        else { s = at < title ? 500 : 450 }
                        if s > best { best = s }
                        // Nothing further along ranks above the row's start, and a site's start is the last better place.
                        if s >= 880 { return best }
                    }
                }
                at += 1
            }
            return best
        }
    }

    @inline(__always) private static func isWord(_ b: UInt8) -> Bool {
        (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39) || b >= 0x80
    }
    @inline(__always) private static func letter(_ b: UInt8) -> UInt64 { 1 << UInt64(b & 63) }
    @inline(__always) private static func pair(_ a: UInt8, _ b: UInt8) -> UInt64 { 1 << UInt64((Int(a) &* 31 &+ Int(b) &* 7) & 63) }
}
