import XCTest
@testable import BrowserMatch

/// The launcher's matcher for a browser's rows (R-B1, R-B2): what ranks where, and that a key press over 2,000 tabs and
/// 50,000 pages stays inside one frame. Every row is made up.
final class BrowserTableTests: XCTestCase {
    private func table(_ rows: [(String, String)], weight: Int = 0) -> BrowserTable {
        let t = BrowserTable()
        for (title, address) in rows { _ = t.add(title: title, address: address, weight: weight) }
        return t
    }
    private func slots(_ t: BrowserTable, _ q: String, limit: Int = 10) -> [Int] { t.search(q, limit: limit).map(\.slot) }
    private func score(_ title: String, _ address: String, _ q: String) -> Int? { table([(title, address)]).search(q, limit: 1).first?.score }

    func testEachPlaceHasItsScore() {
        // Less a point for each character of the title.
        XCTAssertEqual(score("park", "a.example", "park"), 1000 - 4)
        XCTAssertEqual(score("parks by county", "a.example", "park"), 900 - 15)
        XCTAssertEqual(score("saturday five", "parkrun.example", "park"), 880 - 13)
        XCTAssertEqual(score("national park", "a.example", "park"), 700 - 13)
        XCTAssertEqual(score("saturday five", "a.example/park", "park"), 650 - 13)
        XCTAssertEqual(score("unparked", "a.example", "park"), 500 - 8)
        XCTAssertEqual(score("saturday five", "a.example/unparked", "park"), 450 - 13)
        XCTAssertNil(score("pa rk", "a.example", "park"), "letters apart are no match")
        XCTAssertEqual(score("unparked park", "a.example", "park"), 700 - 13, "the best place in the row counts, not the first")
        XCTAssertEqual(score(String(repeating: "x", count: 300) + " park", "", "park"), 700 - 99, "a long title costs no more than 99")
        XCTAssertEqual(score("парк в лесу", "", "парк"), 900 - 11, "characters, not bytes")
        for before in ["a \u{201C}", "news\u{2014}", "a\u{A0}", "\u{300C}"] { XCTAssertEqual(score(before + "park", "", "park"), 700 - before.count - 4, before) }
        XCTAssertEqual(score("\u{43A}park", "", "park"), 500 - 5, "a letter of another script is a letter")
        XCTAssertNotNil(score("a", String(repeating: "x", count: 295) + "/park", "park"))
        XCTAssertNil(score("a", String(repeating: "x", count: 296) + "/park", "park"), "an address is matched 300 bytes far")
    }

    func testWordsApartMustAllBeThereAndRankAsTheWeakest() {
        XCTAssertEqual(score("park maps", "a.example", "maps park"), 600 - 9)
        XCTAssertEqual(score("park maps", "a.example", "maps ark"), 500 - 9)
        XCTAssertEqual(score("park maps", "a.example", "park maps"), 1000 - 9, "the phrase itself ranks whole")
        XCTAssertEqual(score("park  maps", "a.example", "  park   maps "), 600 - 10)
        XCTAssertNil(score("park maps", "a.example", "park zebra"))
        XCTAssertNil(score("park maps", "a.example", "   "))
        XCTAssertEqual(score("park maps", "a.example", "p a r m zebra"), 500 - 9, "a fifth word isn't looked for")
        let long = table([("how to train a dog", ""), ("how to train a dragon", "")])
        XCTAssertEqual(slots(long, "how to train a dragon"), [1, 0], "but a title typed whole is the whole title")
    }

    func testWeightAddsAndALateTieGoesFirst() {
        let t = BrowserTable()
        _ = t.add(title: "weather one", address: "", weight: 0)
        _ = t.add(title: "weather two", address: "", weight: 30)
        _ = t.add(title: "weather six", address: "", weight: 0)
        _ = t.add(title: "weather ten", address: "", weight: 900)
        XCTAssertEqual(slots(t, "weather"), [3, 1, 2, 0])
        XCTAssertEqual(t.search("weather", limit: 1)[0].score, 900 - 11 + 60, "at most 60")
        XCTAssertEqual(t.search("weather", limit: 0), [])
    }

    func testABetterRowIsFoundHoweverLateItComes() {
        // A full list passes over rows that can't rank above its last; one that can must still be walked.
        var rows = (0..<200).map { ("long walks number \($0) in a park", "a.example/\($0)") }
        rows.append(("park", "z.example"))
        rows.append(("saturday five", "parkrun.example"))
        let t = table(rows)
        XCTAssertEqual(slots(t, "park", limit: 2), [200, 201])
        XCTAssertEqual(slots(t, "park", limit: 3).count, 3)
        let heavy = table((0..<20).map { ("a park, number \($0)", "") })
        let last = heavy.add(title: "a very long title that has a park in it somewhere", address: "", weight: 60)
        XCTAssertEqual(slots(heavy, "park", limit: 1), [last], "weight can lift a longer title over the rest")
        XCTAssertEqual(slots(table([("xpark xrun", ""), ("run, then over a park", "")]), "park run", limit: 1), [1], "words apart, late")
        let phrase = table([("run, then a park", ""), ("park run, and a long list of what there was", "")])
        XCTAssertEqual(slots(phrase, "park run", limit: 1), [1], "the phrase, late")
    }

    func testARemovedRowAnswersNothingAndTheOthersStay() {
        let t = table([("garden one", "a.example"), ("garden two", "b.example")])
        t.remove(0)
        t.remove(0)
        t.remove(9)
        XCTAssertEqual(slots(t, "garden"), [1])
        XCTAssertEqual(slots(t, "a"), [1], "found by letters of its own only")
        XCTAssertEqual(Set(t.text(0)), [0], "its text is gone from memory")
        XCTAssertEqual([t.live, t.slots], [1, 2])
    }

    func testAKeyPressOver2000TabsAnd50000PagesIsInsideAFrame() {
        let words = ["garden", "recipe", "weather", "river", "school", "music", "history", "atlas", "engine", "letter", "market", "winter",
                     "bridge", "coffee", "planet", "silver", "travel", "window", "yellow", "orchard"]
        let t = BrowserTable()
        for i in 0..<52_000 {
            // Every eighth address is as long as one is matched.
            let key = i % 8 == 0 ? String(repeating: "k\(i % 977)e4rtqz\(i % 13)-", count: 24) : ""
            _ = t.add(title: "\(words[i % 20]) \(words[(i / 20) % 20]) \(words[(i / 400) % 20]) number \(i)",
                      address: "\(words[(i / 7) % 20])\(i % 97).example/\(words[(i / 3) % 20])/\(i)?page=\(i % 31)&\(key)", weight: i % 40)
        }
        // A word typed letter by letter, words apart, an address, letters that are everywhere and nothing like any row.
        let queries = ["g", "ga", "gar", "garden", "garden ri", "river garden number 4", "e", "er", "number", "example", "garden3.ex", "zzzz", "weather 1", "a e", "page=3"]
        var all: [Double] = [], worst = (query: "", ms: 0.0)
        for q in queries {
            var times: [Double] = []
            for _ in 0..<20 {
                let from = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) // not the time other work on this Mac takes
                _ = t.search(q, limit: 6)
                times.append(Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - from) / 1e6)
            }
            times.sort()
            if times[17] > worst.ms { worst = (q, times[17]) }
            all += times
        }
        all.sort()
        print("browser table: p50 \(all[all.count / 2]) ms, p90 \(all[all.count * 9 / 10]) ms; the slowest query's p90 \(worst.ms) ms")
        XCTAssertLessThan(worst.ms, 16, "a key press has one frame; \(worst.query) took the longest")
    }
}
