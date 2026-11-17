import XCTest
@testable import LauncherMatch

/// The launcher answers a keystroke from memory: 200 queries typed against an index of 2,000
/// entries, each timed from the query string to the ranked list. The budget is 8 ms at p90 in a
/// debug build (a release build is several times faster), half a 60 Hz frame. The old matcher,
/// which folded every name with Foundation per keystroke, took p90 48 ms on this corpus (abbey1,
/// 2026-11-17) against 2.5 ms for this one, so this fails if names stop being prepared ahead.
final class LatencyTests: XCTestCase {
    static let budgetMs = 8.0

    func testTwoHundredQueriesAgainstTwoThousandEntriesStayUnderBudgetAtP90() {
        let names = Self.names(2_000)
        let index = LauncherIndex(names.enumerated().map { i, n in
            i % 10 == 0 ? .command(id: "cmd:\(i)", title: n) : .app(id: "app:\(i)", name: n)
        })
        let queries = Self.queries(from: names, count: 200)
        XCTAssertEqual(index.entries.count, 2_000)
        XCTAssertEqual(queries.count, 200)
        // One pass to warm caches and the allocator, then the timed one.
        for q in queries.prefix(20) { _ = index.search(q, limit: 50) }
        var ms: [Double] = []
        var found = 0
        for q in queries {
            let start = DispatchTime.now().uptimeNanoseconds
            let hits = index.search(q, limit: 50)
            ms.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
            if !hits.isEmpty { found += 1 }
        }
        ms.sort()
        let p50 = ms[ms.count / 2], p90 = ms[Int(Double(ms.count) * 0.9) - 1], worst = ms.last!
        print(String(format: "launcher latency: p50 %.2f ms, p90 %.2f ms, max %.2f ms over %d queries, %d entries",
                     p50, p90, worst, ms.count, index.entries.count))
        // The queries come from the names, so nearly all of them find something.
        XCTAssertGreaterThan(found, 180)
        XCTAssertLessThan(p90, Self.budgetMs, "p90 \(p90) ms over \(Self.budgetMs) ms")
    }

    /// Names like a big Mac's: real app names, then made-up ones of two to four words.
    static func names(_ count: Int) -> [String] {
        let words = ["Adobe", "Photo", "Studio", "Code", "Pro", "Mail", "Proton", "Drive", "Music", "Video", "Player",
                     "Notes", "Google", "Chrome", "Microsoft", "Word", "Excel", "Power", "Point", "Team", "Viewer",
                     "Editor", "Manager", "Monitor", "Activity", "System", "Settings", "Font", "Book", "Book", "Image",
                     "Capture", "Screen", "Shot", "Terminal", "Ghost", "Visual", "Remote", "Desktop", "Cloud",
                     "Sync", "Backup", "Calendar", "Contacts", "Maps", "Weather", "Stocks", "Voice", "Memo", "Calc",
                     "Disk", "Utility", "Archive", "Unarchiver", "Transmit", "Paw", "Proxy", "Kit", "Lab", "Café",
                     "Über", "Résumé", "naïve", "XML", "JSON", "2025", "v3", "macOS", "iOS", "HD"]
        var rng = Lcg(seed: 42)
        var out = RankingTable.apps + RankingTable.commands
        while out.count < count {
            let n = 2 + rng.next(3)
            out.append((0..<n).map { _ in words[rng.next(words.count)] }.joined(separator: rng.next(5) == 0 ? "-" : " "))
        }
        return Array(out.prefix(count))
    }

    /// What people type: the start of a name one letter at a time, initials, words typed apart,
    /// and a word with a letter swapped.
    static func queries(from names: [String], count: Int) -> [String] {
        var rng = Lcg(seed: 7)
        var out: [String] = []
        while out.count < count {
            let name = names[rng.next(names.count)]
            let words = name.split(whereSeparator: { $0 == " " || $0 == "-" }).map(String.init)
            switch rng.next(4) {
            case 0: for n in 1...min(6, name.count) where out.count < count { out.append(String(name.prefix(n))) }
            case 1: out.append(String(words.compactMap(\.first)))
            case 2: out.append(words.map { String($0.prefix(3)) }.joined(separator: " "))
            default:
                var w = Array(words.max { $0.count < $1.count } ?? name)
                if w.count >= 5 { w.swapAt(2, 3) }
                out.append(String(w))
            }
        }
        return out
    }

    /// A tiny fixed generator, so every run times the same queries.
    struct Lcg {
        var state: UInt64
        init(seed: UInt64) { state = seed }
        mutating func next(_ bound: Int) -> Int {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Int((state >> 33) % UInt64(bound))
        }
    }
}
