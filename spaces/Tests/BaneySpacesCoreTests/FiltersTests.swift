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
        XCTAssertThrowsError(try Filters.save(eight, to: file))
        let many = (0...Filters.maxRules).map { i -> FilterRule in var r = one; r.id = "r\(i)"; return r }
        XCTAssertThrowsError(try Filters.save(many, to: file))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: file)), saved)
        // Only the file: no temp file is left beside it.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [Filters.name])
    }
}
