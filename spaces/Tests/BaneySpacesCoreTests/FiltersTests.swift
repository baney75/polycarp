import BaneySpacesCore
import Foundation
import XCTest

/// filters.json: the rules Polycarp's browser extension applies, checked and normalized here, written whole, and
/// answered by the new tab host's `filters` op.
final class FiltersTests: XCTestCase {
    private var dir: URL!
    private var file: String { dir.appendingPathComponent(Filters.name).path }

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("filters-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func rule(_ json: String) -> Result<FilterRule, SurfacesIssue> {
        guard case .success(let v) = SurfaceValue.parse(Data(json.utf8)) else { fatalError("bad test JSON: \(json)") }
        return Filters.rule(v)
    }

    private func refused(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> SurfacesIssue? {
        switch rule(json) {
        case .success(let r): XCTFail("accepted \(r)", file: file, line: line); return nil
        case .failure(let i): return i
        }
    }

    private func list(_ n: Int, _ make: (Int) -> String) -> String {
        "[" + (0..<n).map { "\"\(make($0))\"" }.joined(separator: ",") + "]"
    }

    func testSitesAndAccountsAreNormalizedAndEveryKeyIsThere() throws {
        let r = try rule(#"{"id":"a","sites":["https://WWW.YouTube.com/feed?x=1"," x.com ","youtube.com"],"accounts":["@Foo","bar","@foo"],"kinds":["Shorts"]}"#).get()
        XCTAssertEqual(r.sites, ["youtube.com", "x.com"])
        XCTAssertEqual(r.accounts, ["foo", "bar"])
        XCTAssertEqual(r.kinds, ["shorts"])
        XCTAssertTrue(r.enabled)
        XCTAssertEqual(Set(r.value.object!.keys), ["id", "enabled", "sites", "words", "patterns", "accounts", "kinds", "hide"])
    }

    func testEachBadFieldIsNamed() {
        let cases: [(String, String)] = [
            (#"{"words":["x"]}"#, "id"),
            (#"{"id":"Upper","words":["x"]}"#, "id"),
            (#"{"id":"","words":["x"]}"#, "id"),
            (#"{"id":"a","enabled":"yes","words":["x"]}"#, "enabled"),
            (#"{"id":"a","words":"x"}"#, "words"),
            (#"{"id":"a","words":[3]}"#, "words[0]"),
            (#"{"id":"a","words":["  "]}"#, "words[0]"),
            (#"{"id":"a","patterns":[""]}"#, "patterns[0]"),
            (#"{"id":"a","words":["x"],"sites":["not a host"]}"#, "sites[0]"),
            (#"{"id":"a","accounts":["@"]}"#, "accounts[0]"),
            (#"{"id":"a","kinds":["ads"]}"#, "kinds[0]"),
            (#"{"id":"a","sites":["x.com"],"hide":["a { color: red"]}"#, "hide[0]"),
            (#"{"id":"a","sites":["x.com"],"hide":["a;b"]}"#, "hide[0]"),
            (#"{"id":"a","words":["x"],"colour":"red"}"#, "colour"),
            (#"{"id":"a","sites":["x.com"]}"#, "$"),
            (#"["not","a","rule"]"#, "$"),
        ]
        for (json, path) in cases {
            XCTAssertEqual(refused(json)?.path, path, json)
        }
    }

    func testHideNeedsSites() {
        let i = refused(##"{"id":"a","hide":["#sidebar"]}"##)
        XCTAssertEqual(i?.path, "hide")
        XCTAssertTrue(i?.message.contains("sites") ?? false)
        XCTAssertNoThrow(try rule(##"{"id":"a","sites":["x.com"],"hide":["#sidebar"]}"##).get())
    }

    func testEachLimit() {
        XCTAssertNoThrow(try rule(#"{"id":"\#(String(repeating: "a", count: 64))","words":["x"]}"#).get())
        XCTAssertEqual(refused(#"{"id":"\#(String(repeating: "a", count: 65))","words":["x"]}"#)?.path, "id")
        XCTAssertNoThrow(try rule(#"{"id":"a","words":\#(list(200) { "w\($0)" })}"#).get())
        XCTAssertEqual(refused(#"{"id":"a","words":\#(list(201) { "w\($0)" })}"#)?.path, "words")
        XCTAssertNoThrow(try rule(#"{"id":"a","patterns":["\#(String(repeating: "p", count: 200))"]}"#).get())
        XCTAssertEqual(refused(#"{"id":"a","patterns":["\#(String(repeating: "p", count: 201))"]}"#)?.path, "patterns[0]")

        func file(_ n: Int) -> Data {
            Data(#"{"version":1,"filters":[\#((0..<n).map { #"{"id":"r\#($0)","words":["x"]}"# }.joined(separator: ","))]}"#.utf8)
        }
        XCTAssertEqual(try Filters.parse(file(200)).get().count, 200)
        guard case .failure(let many) = Filters.parse(file(201)) else { return XCTFail("201 rules read") }
        XCTAssertEqual(many.path, "filters")
        var big = Data(#"{"version":1,"filters":[],"pad":""#.utf8)
        big.append(Data(repeating: 0x20, count: Filters.maxBytes))
        guard case .failure(let huge) = Filters.parse(big) else { return XCTFail("a file over 256 KiB read") }
        XCTAssertTrue(huge.message.contains("\(Filters.maxBytes)"))
    }

    func testAFileWithTwoRulesOfOneIdOrTheWrongVersionIsRefused() {
        guard case .failure(let dup) = Filters.parse(Data(#"{"version":1,"filters":[{"id":"a","words":["x"]},{"id":"a","words":["y"]}]}"#.utf8)) else {
            return XCTFail("duplicate ids read")
        }
        XCTAssertEqual(dup.path, "filters[1].id")
        guard case .failure(let v) = Filters.parse(Data(#"{"version":2,"filters":[]}"#.utf8)) else { return XCTFail("version 2 read") }
        XCTAssertEqual(v.path, "version")
        guard case .failure(let inner) = Filters.parse(Data(#"{"version":1,"filters":[{"id":"a","kinds":["ads"]}]}"#.utf8)) else {
            return XCTFail("a bad kind read")
        }
        XCTAssertEqual(inner.path, "filters[0].kinds[0]")
    }

    func testSaveWritesTheWholeFileAtOnceAndAFailedSaveLeavesTheOldOne() throws {
        var one = FilterRule(id: "one")
        one.words = ["a"]
        try Filters.save([one], to: file)
        XCTAssertEqual(try Filters.load(path: file).get(), [one])
        let saved = try Data(contentsOf: URL(fileURLWithPath: file))
        // Eight rules of 200 entries of about 195 characters: past 256 KiB, refused before anything is written.
        var huge = FilterRule(id: "huge")
        huge.words = (0..<Filters.maxEntries).map { "\($0)" + String(repeating: "w", count: 190) }
        let eight = (0..<8).map { i -> FilterRule in var r = huge; r.id = "huge\(i)"; return r }
        // A limit is a refusal that names the field, not a disk failure, so callers can tell the two apart.
        XCTAssertThrowsError(try Filters.save(eight, to: file)) { XCTAssertEqual(($0 as? SurfacesIssue)?.path, "filters") }
        let many = (0...Filters.maxRules).map { i -> FilterRule in var r = one; r.id = "r\(i)"; return r }
        XCTAssertThrowsError(try Filters.save(many, to: file)) { XCTAssertEqual(($0 as? SurfacesIssue)?.path, "filters") }
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: file)), saved)
    }

    func testASaveThatFailsAfterItsTempFileIsMadeRemovesIt() throws {
        // A folder where the file goes: the temp file is written, then the rename over the folder fails.
        try FileManager.default.createDirectory(atPath: file, withIntermediateDirectories: false)
        var one = FilterRule(id: "one")
        one.words = ["a"]
        XCTAssertThrowsError(try Filters.save([one], to: file)) { XCTAssertTrue($0 is SurfacesFile.WriteError, "\($0)") }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [Filters.name])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: file), [])
    }

    /// Rules built with `FilterRule`'s public init get the same checks as a file read from disk.
    func testSaveChecksRulesHoweverTheyWereBuilt() throws {
        var good = FilterRule(id: "good")
        good.words = ["x"]
        try Filters.save([good], to: file)
        let saved = try Data(contentsOf: URL(fileURLWithPath: file))

        var badID = FilterRule(id: "Bad Id")
        badID.words = ["x"]
        var twin = good
        twin.words = ["y"]
        var hideOnly = FilterRule(id: "hide-only")
        hideOnly.hide = ["#sidebar"]
        var badPattern = FilterRule(id: "slow")
        badPattern.patterns = ["(a+)+$"]
        let cases: [([FilterRule], String)] = [
            ([badID], "filters[0].id"),
            ([good, twin], "filters[1].id"),
            ([good, hideOnly], "filters[1].hide"),
            ([badPattern], "filters[0].patterns[0]"),
        ]
        for (rules, path) in cases {
            XCTAssertThrowsError(try Filters.save(rules, to: file), path) { XCTAssertEqual(($0 as? SurfacesIssue)?.path, path) }
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: file)), saved, path)
        }

        // What is saved is normalized, and loads back as it was returned.
        var loose = FilterRule(id: "loose")
        loose.sites = ["https://WWW.X.com/home", "x.com"]
        loose.accounts = ["@Foo"]
        let written = try Filters.save([loose], to: file)
        XCTAssertEqual(written.first?.sites, ["x.com"])
        XCTAssertEqual(written.first?.accounts, ["foo"])
        XCTAssertEqual(try Filters.load(path: file).get(), written)
    }

    /// Whatever loads can be saved again: a compact file under the limit that would pass it pretty-printed is refused
    /// on read, not on the next edit.
    func testAFileThatLoadsCanBeSavedAgain() {
        let words = (0..<Filters.maxEntries).map { "\"\($0)\(String(repeating: "w", count: 155))\"" }.joined(separator: ",")
        let compact = { (n: Int) in
            Data(#"{"version":1,"filters":[\#((0..<n).map { #"{"id":"r\#($0)","words":[\#(words)]}"# }.joined(separator: ","))]}"#.utf8)
        }
        // Eight rules: about 250 KiB compact, over 256 KiB pretty-printed.
        let data = compact(8)
        XCTAssertLessThanOrEqual(data.count, Filters.maxBytes)
        guard case .failure(let issue) = Filters.parse(data) else { return XCTFail("a file too big to write back read") }
        XCTAssertEqual(issue.path, "filters")
        XCTAssertTrue(issue.message.contains("as written"), issue.message)
        XCTAssertNoThrow(try Filters.parse(compact(7)).get())
    }

    func testIdsAreASCIIBytes() {
        XCTAssertEqual(refused(#"{"id":"a\u20dd","words":["x"]}"#)?.path, "id")
        XCTAssertEqual(refused(#"{"id":"caf\u00e9","words":["x"]}"#)?.path, "id")
        XCTAssertNoThrow(try rule(#"{"id":"no-shorts-2","words":["x"]}"#).get())
    }

    func testASitesPortIsDropped() throws {
        let r = try rule(#"{"id":"a","words":["x"],"sites":["https://x.com:443/home","localhost:3000","Example.org:8080"]}"#).get()
        XCTAssertEqual(r.sites, ["x.com", "localhost", "example.org"])
        XCTAssertEqual(refused(#"{"id":"a","words":["x"],"sites":["x.com:http"]}"#)?.path, "sites[0]")
    }

    private func pattern(_ p: String) -> Result<FilterRule, SurfacesIssue> {
        var r = FilterRule(id: "a")
        r.patterns = [p]
        return Filters.rule(r.value)
    }

    func testAPatternThatDoesNotCompileOrIsBlankIsRefused() {
        for p in ["(", "[a-", "a)", "*a", "  ", "\t"] {
            guard case .failure(let i) = pattern(p) else { XCTFail("accepted \(p)"); continue }
            XCTAssertEqual(i.path, "patterns[0]", p)
        }
        // Kept as written, spaces and all.
        XCTAssertEqual(try pattern(" vs ").get().patterns, [" vs "])
    }

    func testAPatternThatCanBacktrackForeverIsRefused() {
        let refusedPatterns: [(String, String)] = [
            // A repeated group that holds a quantifier, at any depth.
            ("(a+)+$", "quantifier"), ("(.*a){20}", "quantifier"), (#"(\d\d?)+$"#, "quantifier"), ("(a*)*", "quantifier"),
            ("((a+)b)+", "quantifier"), ("(?:x+y?)*z", "quantifier"), ("(a{2})+", "quantifier"), ("(a+?)+", "quantifier"),
            // A count over 20.
            ("a{21}", "20"), ("a{2,50}", "20"), ("(ab){21}", "20"), ("x{999}", "20"),
            // Backreferences and lookbehind.
            (#"(a)\1"#, "backreference"), (#"(?<n>a)\k<n>"#, "backreference"),
            ("(?<=@)\\w+", "lookbehind"), ("(?<!x)y", "lookbehind"),
        ]
        for (p, why) in refusedPatterns {
            guard case .failure(let i) = pattern(p) else { XCTFail("accepted \(p)"); continue }
            XCTAssertEqual(i.path, "patterns[0]", p)
            XCTAssertTrue(i.message.contains(why), "\(p): \(i.message)")
        }
        let accepted = [
            "(foo|bar)+", #"\bsponsored\b"#, "^(breaking|live):", "colou?r", "a{2,20}", "(ab){3}", "(a)?b+",
            "[(+*]+", #"\(a+\)+"#, "(?<tag>x)y+", "(?=a)b*", "elon|musk",
        ]
        for p in accepted { XCTAssertNoThrow(try pattern(p).get(), p) }
    }

    func testASelectorThatCouldReachPastItsOwnRuleIsRefused() {
        let bad = [
            "a /*", "a */", "a\\b", #"a[title="x"#, #"a[title="x]"#, "a[title='x]", "a[title=x", "a]", "div:not(.x", "div)", "a[x)",
            "@media x", "a<b", "a{", "a}", "a;b", "a\nb",
        ]
        for sel in bad {
            var r = FilterRule(id: "a")
            r.sites = ["x.com"]
            r.hide = [sel]
            guard case .failure(let i) = Filters.rule(r.value) else { XCTFail("accepted \(sel)"); continue }
            XCTAssertEqual(i.path, "hide[0]", sel)
        }
        let good = [
            "#sidebar", "[data-testid=trend]", #"a[title="x y"]"#, #"a[title="(x]"]"#, "a[title='\"']",
            "div:not(.promo) > a", "a[href^='https://']", "li:nth-child(2n+1)", "ytd-rich-shelf-renderer[is-shorts]",
        ]
        for sel in good {
            var r = FilterRule(id: "a")
            r.sites = ["x.com"]
            r.hide = [sel]
            XCTAssertNoThrow(try Filters.rule(r.value).get(), sel)
        }
    }
}
