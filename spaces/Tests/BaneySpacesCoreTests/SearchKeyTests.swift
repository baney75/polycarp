import XCTest
@testable import BaneySpacesCore

/// The launcher scores every app on each key press. Names are folded once, when the list is read.
final class SearchKeyTests: XCTestCase {
    private let names = ["Safari", "Visual Studio Code", "Code", "Café Menu", "Microsoft Word", "Ghostty", "System Settings",
                         "1Password 7", "TextEdit", "Xcode-beta", "Adobe Photoshop 2026", "Activity Monitor"]
    private let queries = ["", "s", "sa", "co", "vsc", "cafe", "CAFE", "word", "gh", "sfr", "ss", "1p", "xc", "ps", "zzz", "am", " code"]

    /// What the reference scorer said before the key existed, kept here so a change to either side shows.
    private func reference(_ query: String, _ name: String) -> Int? {
        let q = Fuzzy.fold(query)
        guard !q.isEmpty else { return 0 }
        let n = Fuzzy.fold(name)
        if n == q { return 1000 }
        if n.hasPrefix(q) { return 900 - min(n.count, 99) }
        let words = n.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        if words.contains(where: { $0.hasPrefix(q) }) { return 700 - min(n.count, 99) }
        let initials = String(words.compactMap(\.first))
        if initials.hasPrefix(q) { return 600 - min(n.count, 99) }
        if n.contains(q) { return 500 - min(n.count, 99) }
        var gaps = 0
        var i = n.startIndex
        var last: String.Index?
        for ch in q where ch != " " {
            guard let at = n[i...].firstIndex(of: ch) else { return nil }
            if let last { gaps += n.distance(from: last, to: at) - 1 }
            last = at
            i = n.index(after: at)
        }
        return max(1, 300 - gaps * 10 - min(n.count, 99))
    }

    func testAPrecomputedKeyScoresLikeTheName() {
        for name in names {
            let key = SearchKey(name)
            for q in queries {
                XCTAssertEqual(Fuzzy.score(folded: Fuzzy.fold(q), key: key), reference(q, name), "\(q) in \(name)")
                XCTAssertEqual(Fuzzy.score(q, name), reference(q, name), "\(q) in \(name)")
            }
        }
    }

    /// A key press compares precomputed keys. Over 1000 apps in a debug build it took 2 to 5 ms, against 14 to 59 ms
    /// when every name was folded again on each key press. Both are timed side by side, so a busy test run slows both.
    func testAKeyPressComparesPrecomputedKeys() {
        let all = (0..<1000).map { "\(names[$0 % names.count]) \($0)" }
        let keys = all.map(SearchKey.init)
        // Best of five: a test run on a busy Mac can be preempted for longer than the work takes.
        func best(_ work: () -> Void) -> Double {
            (0..<5).map { _ in
                let t0 = ProcessInfo.processInfo.systemUptime
                work()
                return ProcessInfo.processInfo.systemUptime - t0
            }.min()!
        }
        var indexed = 0.0, folding = 0.0
        for q in ["s", "sa", "saf", "vsc", "code", "zzz", "sfr"] {
            let one = best {
                let folded = Fuzzy.fold(q)
                _ = keys.compactMap { Fuzzy.score(folded: folded, key: $0) }
            }
            indexed += one
            folding += best { _ = all.compactMap { reference(q, $0) } }
            XCTAssertLessThan(one, 0.016, "\(q): a key press over 1000 apps took \(Int(one * 1000)) ms")
        }
        XCTAssertLessThan(indexed * 3, folding, "indexed \(Int(indexed * 1000)) ms, folding \(Int(folding * 1000)) ms")
    }
}
