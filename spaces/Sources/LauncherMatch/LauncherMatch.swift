import Foundation

/// The launcher's matcher. Every typed letter must appear in the name in order, and the score
/// says how well, in the manner fzf describes its own: a letter at the start of a word, after a
/// lowercase letter in camelCase or right after the last matched letter counts more, and a gap
/// between letters costs. So "vsc" finds Visual Studio Code and "gst" Ghostty Settings. Words
/// typed apart ("sys set") each match on their own. A word of four letters or more with one
/// letter wrong, missing, extra or swapped still finds a word of the name ("safaru", "chorme"),
/// scored below a clean match of the same length.
///
/// Names are prepared once (`Match.Name`): folded, with each letter's bonus worked out, so a
/// keystroke only walks small integer arrays. Preparing is the costly part; do it when the list
/// changes, never per keystroke.
public enum Match {
    static let letter: Int32 = 16
    static let gapStart: Int32 = 3
    static let gapExtend: Int32 = 1
    static let afterSpace: Int8 = 10
    static let afterDelimiter: Int8 = 9
    static let afterOther: Int8 = 8
    static let camel: Int8 = 7
    static let consecutive: Int8 = 4
    /// The letter a match starts on counts its bonus twice: where it starts matters most.
    static let firstMultiplier: Int32 = 2
    /// A typed word must be this long before a typo in it is forgiven.
    public static let typoMinimum = 4
    static let none = Int32.min / 4

    /// A name ready to be matched.
    public struct Name: Sendable {
        let chars: [UInt32]
        let bonus: [Int8]
        /// Where each word starts, for typos.
        let wordStarts: [Int32]
        let mask: UInt64
        public init(_ text: String) {
            var chars: [UInt32] = []
            var bonus: [Int8] = []
            var starts: [Int32] = []
            chars.reserveCapacity(text.utf8.count)
            bonus.reserveCapacity(text.utf8.count)
            var prev = Kind.space
            var mask: UInt64 = 0
            for ch in text {
                let kind = Kind(ch)
                let b = Match.bonus(kind, after: prev)
                if kind.isWord, b >= Match.camel { starts.append(Int32(chars.count)) }
                var first = true
                Match.fold(ch) { v in
                    chars.append(v)
                    bonus.append(first ? b : (kind.isWord ? 0 : b))
                    mask |= Match.bit(v)
                    first = false
                }
                prev = kind
            }
            self.chars = chars
            self.bonus = bonus
            self.wordStarts = starts
            self.mask = mask
        }

        func withView<R>(_ body: (NameView) -> R) -> R {
            chars.withUnsafeBufferPointer { c in
                bonus.withUnsafeBufferPointer { b in
                    wordStarts.withUnsafeBufferPointer { st in body(NameView(chars: c, bonus: b, starts: st, mask: mask)) }
                }
            }
        }
    }

    /// What was typed, split into words and folded the same way.
    public struct Query: Sendable {
        let words: [[UInt32]]
        let masks: [UInt64]
        public var isEmpty: Bool { words.isEmpty }
        public init(_ text: String) {
            var words: [[UInt32]] = []
            for part in text.split(whereSeparator: \.isWhitespace) {
                var w: [UInt32] = []
                for ch in part { Match.fold(ch) { w.append($0) } }
                if !w.isEmpty { words.append(w) }
            }
            self.words = words
            masks = words.map { $0.reduce(0) { $0 | Match.bit($1) } }
            letters = Array(words.joined())
            var at = 0
            bounds = [0] + words.map { at += $0.count; return at }
        }
        /// Every word's letters back to back, and where each word starts and ends in them.
        let letters: [UInt32]
        let bounds: [Int]

        /// The query through pointers, valid only inside `body`.
        func withView<R>(_ body: (View) -> R) -> R {
            letters.withUnsafeBufferPointer { l in
                bounds.withUnsafeBufferPointer { b in
                    masks.withUnsafeBufferPointer { m in body(View(letters: l, bounds: b, masks: m)) }
                }
            }
        }
        struct View {
            let letters: UnsafeBufferPointer<UInt32>
            let bounds: UnsafeBufferPointer<Int>
            let masks: UnsafeBufferPointer<UInt64>
            var count: Int { masks.count }
            func word(_ i: Int) -> UnsafeBufferPointer<UInt32> {
                UnsafeBufferPointer(rebasing: letters[bounds[i]..<bounds[i + 1]])
            }
        }
    }

    /// Higher is better; nil is no match. An empty query matches everything with 0.
    public static func score(_ query: String, _ name: String) -> Int? { score(Query(query), Name(name)) }

    public static func score(_ q: Query, _ n: Name) -> Int? {
        n.withView { name in
            q.withView { query in
                let s = score(query, name)
                return s > none ? Int(s) : nil
            }
        }
    }

    /// A prepared name through pointers: a keystroke scores thousands of these, and in a debug
    /// build every array touched per name costs a retain and a release.
    struct NameView {
        let chars: UnsafeBufferPointer<UInt32>
        let bonus: UnsafeBufferPointer<Int8>
        let starts: UnsafeBufferPointer<Int32>
        let mask: UInt64
    }

    /// The name's score, or `none` when it doesn't match.
    static func score(_ q: Query.View, _ n: NameView) -> Int32 {
        let words = q.count
        guard words > 0 else { return 0 }
        var total: Int32 = 0
        for i in 0..<words {
            let w = q.word(i)
            let missing = q.masks[i] & ~n.mask
            var s = none
            if missing == 0 { s = word(w, n) }
            if s == none {
                guard w.count >= typoMinimum, missing.nonzeroBitCount <= 1, typo(w, n) else { return none }
                s = Int32(w.count - 1) * letter - 8
            }
            total += s
        }
        // The whole name typed: above anything that only starts it.
        if n.chars.count == q.letters.count + words - 1 {
            var same = true
            var at = 0
            for i in 0..<words where same {
                if i > 0 { same = n.chars[at] == 32; at += 1 }
                for c in q.word(i) where same { same = n.chars[at] == c; at += 1 }
            }
            if same { total += 40 }
        }
        // Of two names matched as well, the shorter one is the likelier.
        total -= Int32(min(n.chars.count, 40) / 2)
        return total
    }

    /// The best placement of one typed word in the name, or `none` if its letters aren't there in order.
    static func word(_ q: UnsafeBufferPointer<UInt32>, _ n: NameView) -> Int32 {
        let m = q.count, len = n.chars.count
        guard m <= len else { return none }
        let name = n.chars, bonus = n.bonus
        // Letters in order at all? Also finds the first column the match can start in.
        var at = 0, first = -1
        for c in q {
            while at < len, name[at] != c { at += 1 }
            if at == len { return none }
            if first < 0 { first = at }
            at += 1
        }
        return withUnsafeTemporaryAllocation(of: Int32.self, capacity: len * 2) { h in
            withUnsafeTemporaryAllocation(of: Int8.self, capacity: len * 2) { run in
                var prev = 0, cur = len
                // First letter: anywhere it appears, its bonus doubled, a little less the later it starts.
                for j in 0..<len {
                    if j >= first, name[j] == q[0] {
                        h[j] = letter + Int32(bonus[j]) * firstMultiplier - Int32(min(j, 16) / 4)
                        run[j] = bonus[j]
                    } else {
                        h[j] = none
                    }
                }
                for i in 1..<m {
                    let c = q[i]
                    // The best match of the last letter that leaves a gap before column j.
                    var open = none
                    for j in 0..<len {
                        if j >= 2 { open = max(open - gapExtend, h[prev + j - 2] - gapStart) }
                        guard name[j] == c, j >= i else { h[cur + j] = none; continue }
                        var best = none
                        var carried: Int8 = 0
                        let b = bonus[j]
                        let diag = h[prev + j - 1]
                        if diag > none {
                            // Right after the last letter: the run keeps the bonus it started with.
                            carried = max(run[prev + j - 1], b)
                            best = diag + letter + Int32(max(carried, consecutive))
                        }
                        if open > none / 2 {
                            let g = open + letter + Int32(b)
                            if g > best { best = g; carried = b }
                        }
                        h[cur + j] = best
                        run[cur + j] = carried
                    }
                    swap(&prev, &cur)
                }
                var best = none
                for j in 0..<len where h[prev + j] > best { best = h[prev + j] }
                return best > none / 2 ? best : none
            }
        }
    }

    /// One letter wrong, missing, extra or two swapped, against the start of some word of the
    /// name (optimal string alignment distance of at most 1 to a prefix of that word).
    static func typo(_ q: UnsafeBufferPointer<UInt32>, _ n: NameView) -> Bool {
        let m = q.count
        let wide = m + 2
        let chars = n.chars
        return withUnsafeTemporaryAllocation(of: Int32.self, capacity: wide * 3) { rows in
            for start in n.starts {
                let s = Int(start)
                // One edit leaves one of the first two typed letters at the word's first or second letter.
                let w0 = chars[s], w1 = s + 1 < chars.count ? chars[s + 1] : 0
                guard q[0] == w0 || q[1] == w1 || q[1] == w0 || q[0] == w1 else { continue }
                // The word's letters from `start`, up to one more than was typed.
                let k = min(chars.count - s, m + 1)
                guard k >= m - 1 else { continue }
                // rows: two back, one back, this one; each m + 1 wide over the typed letters.
                var r2 = 0, r1 = wide, r0 = wide * 2
                for i in 0...m { rows[r1 + i] = Int32(i) }
                var best = Int32.max
                for j in 1...k {
                    let c = chars[s + j - 1]
                    rows[r0] = Int32(j)
                    for i in 1...m {
                        let cost: Int32 = q[i - 1] == c ? 0 : 1
                        var d = min(rows[r1 + i] + 1, rows[r0 + i - 1] + 1, rows[r1 + i - 1] + cost)
                        if i > 1, j > 1, q[i - 1] == chars[s + j - 2], q[i - 2] == c { d = min(d, rows[r2 + i - 2] + 1) }
                        rows[r0 + i] = d
                    }
                    if j >= m - 1 { best = min(best, rows[r0 + m]) }
                    (r2, r1, r0) = (r1, r0, r2)
                }
                if best <= 1 { return true }
            }
            return false
        }
    }

    // MARK: Letters

    enum Kind {
        case space, delimiter, other, lower, upper, digit
        init(_ ch: Character) {
            if ch.isWhitespace { self = .space }
            else if ch.isNumber { self = .digit }
            else if ch.isLetter { self = ch.isUppercase ? .upper : .lower }
            else if "/-_.:,;|\\+&".contains(ch) { self = .delimiter }
            else { self = .other }
        }
        var isWord: Bool { self == .lower || self == .upper || self == .digit }
    }

    static func bonus(_ kind: Kind, after prev: Kind) -> Int8 {
        guard kind.isWord else { return afterOther }
        switch prev {
        case .space: return afterSpace
        case .delimiter: return afterDelimiter
        case .other: return afterOther
        case .lower: return kind == .upper || kind == .digit ? camel : 0
        case .upper: return kind == .digit ? camel : 0
        case .digit: return kind == .digit ? 0 : camel
        }
    }

    /// Lowercase with accents dropped, ASCII without a trip through Foundation.
    static func fold(_ ch: Character, _ emit: (UInt32) -> Void) {
        if let a = ch.asciiValue {
            emit(UInt32(a >= 65 && a <= 90 ? a + 32 : a))
            return
        }
        for s in String(ch).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).unicodeScalars {
            emit(s.value)
        }
    }

    /// One bit per letter or digit, the rest sharing the top bits: a name lacking a typed letter
    /// is passed over without a look at its letters.
    static func bit(_ v: UInt32) -> UInt64 {
        switch v {
        case 97...122: return 1 << UInt64(v - 97)
        case 48...57: return 1 << UInt64(v - 48 + 26)
        default: return 1 << UInt64(36 + v % 28)
        }
    }
}

/// Everything the launcher can find without asking the disk: apps, commands, workspaces, menus
/// and windows, each with the names it answers to, prepared once. A keystroke scores every
/// entry against what was typed and keeps the best.
public struct LauncherIndex: Sendable {
    public enum Kind: Int, Sendable, Comparable {
        /// In the order the launcher shows its sections, which is also how ties go.
        case app, window, workspace, command, menu
        public static func < (a: Kind, b: Kind) -> Bool { a.rawValue < b.rawValue }
    }

    /// One thing to find, under any of its names. A name with a cost answers less well than
    /// the entry's own name: a workspace found by an app on it ranks below the app.
    public struct Entry: Sendable {
        public let id: String
        public let kind: Kind
        let names: [(Match.Name, Int)]
        public init(id: String, kind: Kind, names: [(String, Int)]) {
            self.init(id: id, kind: kind, prepared: names.map { (Match.Name($0.0), $0.1) })
        }
        public init(id: String, kind: Kind, prepared: [(Match.Name, Int)]) {
            self.id = id
            self.kind = kind
            names = prepared
        }
        public init(id: String, kind: Kind, name: String) { self.init(id: id, kind: kind, names: [(name, 0)]) }

        /// What a workspace found by an app on it gives up against the app itself.
        public static let byAppOnIt = 25
        /// What a window found by its detail line (a path, a command) gives up against its title.
        public static let byDetail = 20

        public static func app(id: String, name: String) -> Entry { Entry(id: id, kind: .app, name: name) }
        public static func app(id: String, prepared: Match.Name) -> Entry { Entry(id: id, kind: .app, prepared: [(prepared, 0)]) }
        public static func command(id: String, title: String) -> Entry { Entry(id: id, kind: .command, name: title) }
        public static func menu(id: String, title: String) -> Entry { Entry(id: id, kind: .menu, name: title) }
        /// "Workspace 3", found by "3", "ws 3" or the name of an app on it.
        public static func workspace(id: String, number: Int, apps: [String]) -> Entry {
            Entry(id: id, kind: .workspace,
                  names: [("Workspace \(number)", 0), ("\(number)", 0)] + apps.map { ($0, byAppOnIt) })
        }
        /// A window, tab or terminal: by its title, its app and title together, or its detail.
        public static func window(id: String, title: String, app: String, detail: String = "") -> Entry {
            Entry(id: id, kind: .window,
                  names: [(title, 0), ("\(app) \(title)", 0)] + (detail.isEmpty ? [] : [(detail, byDetail)]))
        }
    }

    public struct Hit: Equatable, Sendable {
        public let id: String
        public let kind: Kind
        public let score: Int
    }

    public private(set) var entries: [Entry]
    /// Every entry's names back to back in flat arrays, so a keystroke walks a few buffers and
    /// retains nothing per name. Name k's letters are `chars[charAt[k]..<charAt[k + 1]]`.
    private var chars: [UInt32] = []
    private var bonus: [Int8] = []
    private var charAt: [Int] = [0]
    private var starts: [Int32] = []
    private var startAt: [Int] = [0]
    private var masks: [UInt64] = []
    private var costs: [Int32] = []
    private var owners: [Int] = []
    private var nameKinds: [Int] = []

    public init(_ entries: [Entry] = []) {
        self.entries = []
        append(contentsOf: entries)
    }

    public mutating func append(contentsOf more: [Entry]) {
        for e in more {
            let i = entries.count
            entries.append(e)
            for (name, cost) in e.names {
                chars += name.chars
                bonus += name.bonus
                charAt.append(chars.count)
                starts += name.wordStarts
                startAt.append(starts.count)
                masks.append(name.mask)
                costs.append(Int32(cost))
                owners.append(i)
                nameKinds.append(e.kind.rawValue)
            }
        }
    }

    /// The best `limit` entries for what was typed, best first; `boost` adds to an entry's score
    /// (what you pick often). Ties go by kind (apps first), then by place in the index.
    public func search(_ text: String, kinds: Set<Kind>? = nil, limit: Int = .max, boost: (String) -> Int = { _ in 0 }) -> [Hit] {
        let q = Match.Query(text)
        // A name missing more typed letters than there are words long enough for a typo can't match.
        let all = q.masks.reduce(0, |)
        let forgiven = q.words.filter { $0.count >= Match.typoMinimum }.count
        var allowed = [Bool](repeating: true, count: 5)
        if let kinds { for k in 0..<5 { allowed[k] = kinds.contains(Kind(rawValue: k)!) } }
        var best = [Int32](repeating: Match.none, count: entries.count)
        q.withView { query in
            chars.withUnsafeBufferPointer { chars in
            bonus.withUnsafeBufferPointer { bonus in
            charAt.withUnsafeBufferPointer { charAt in
            starts.withUnsafeBufferPointer { starts in
            startAt.withUnsafeBufferPointer { startAt in
            masks.withUnsafeBufferPointer { masks in
            costs.withUnsafeBufferPointer { costs in
            owners.withUnsafeBufferPointer { owners in
            nameKinds.withUnsafeBufferPointer { nameKinds in
            allowed.withUnsafeBufferPointer { allowed in
            best.withUnsafeMutableBufferPointer { best in
                for k in 0..<masks.count {
                    guard allowed[nameKinds[k]], (all & ~masks[k]).nonzeroBitCount <= forgiven else { continue }
                    let name = Match.NameView(chars: UnsafeBufferPointer(rebasing: chars[charAt[k]..<charAt[k + 1]]),
                                              bonus: UnsafeBufferPointer(rebasing: bonus[charAt[k]..<charAt[k + 1]]),
                                              starts: UnsafeBufferPointer(rebasing: starts[startAt[k]..<startAt[k + 1]]),
                                              mask: masks[k])
                    let s = Match.score(query, name)
                    guard s > Match.none else { continue }
                    let v = s - costs[k]
                    if v > best[owners[k]] { best[owners[k]] = v }
                }
            }}}}}}}}}}}
        }
        // One sortable key per hit: score, then kind (apps first), then place in the index.
        var keys: [Int64] = []
        for (i, b) in best.enumerated() where b > Match.none {
            let e = entries[i]
            let score = Int64(b) + Int64(q.isEmpty ? 0 : boost(e.id))
            keys.append((score + (1 << 30)) << 32 | Int64(7 - e.kind.rawValue) << 24 | Int64(0xFF_FFFF - i))
        }
        keys.sort(by: >)
        return keys.prefix(limit).map { key in
            let i = 0xFF_FFFF - Int(key & 0xFF_FFFF)
            return Hit(id: entries[i].id, kind: entries[i].kind, score: Int((key >> 32) - (1 << 30)))
        }
    }
}
