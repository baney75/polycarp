import BaneySpacesCore
import Foundation
import XCTest

/// `polycarp-spaces filters` (FiltersOps) and the new tab host's `filters` op.
final class FiltersOpsTests: XCTestCase {
    private var dir: URL!
    private var file: String { dir.appendingPathComponent(Filters.name).path }

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("filters-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    func testSetUpsertsByIdAndWritesTheWholeFileAtOnce() throws {
        XCTAssertEqual(try Filters.load(path: file).get(), [])
        _ = try FiltersOps.set(#"{"id":"one","words":["a"]}"#, file: file).get()
        _ = try FiltersOps.set(#"{"id":"two","words":["b"]}"#, file: file).get()
        let again = try FiltersOps.set(#"{"id":"one","enabled":false,"words":["c"]}"#, file: file).get()
        XCTAssertEqual(again.object?["replaced"], .bool(true))
        let rules = try Filters.load(path: file).get()
        XCTAssertEqual(rules.map(\.id), ["one", "two"])
        XCTAssertEqual(rules[0].words, ["c"])
        XCTAssertFalse(rules[0].enabled)
        // Only the file: no temp file is left beside it.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [Filters.name])

        _ = try FiltersOps.remove("one", file: file).get()
        XCTAssertEqual(try Filters.load(path: file).get().map(\.id), ["two"])
        _ = try FiltersOps.reset(file: file).get()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file))
    }

    func testARefusalWritesNothing() throws {
        _ = try FiltersOps.set(#"{"id":"one","words":["a"]}"#, file: file).get()
        let before = try Data(contentsOf: URL(fileURLWithPath: file))
        for bad in [#"{"id":"one","hide":["x"]}"#, "not json", #"{"id":"one"}"#] {
            guard case .failure(let f) = FiltersOps.set(bad, file: file) else { return XCTFail("accepted \(bad)") }
            XCTAssertEqual(f.code, "invalid_filter")
        }
        guard case .failure(let gone) = FiltersOps.remove("nope", file: file) else { return XCTFail("removed nothing") }
        XCTAssertEqual(gone.code, "not_found")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: file)), before)

        // A full file takes no new rule.
        let full = (0..<Filters.maxRules).map { i -> FilterRule in var r = FilterRule(id: "r\(i)"); r.words = ["x"]; return r }
        try Filters.save(full, to: file)
        let saved = try Data(contentsOf: URL(fileURLWithPath: file))
        guard case .failure(let many) = FiltersOps.set(#"{"id":"new","words":["x"]}"#, file: file) else { return XCTFail("201st rule taken") }
        XCTAssertEqual(many.code, "too_many")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: file)), saved)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [Filters.name])
    }

    func testARuleThatWouldTakeTheFilePastItsSizeIsTooManyNotAnIOError() throws {
        // Six rules of 200 words of about 190 characters fit; a seventh takes the file past 256 KiB.
        let words = (0..<Filters.maxEntries).map { "\($0)" + String(repeating: "w", count: 186) }
        let big = (0..<6).map { i -> FilterRule in var r = FilterRule(id: "big\(i)"); r.words = words; return r }
        try Filters.save(big, to: file)
        let saved = try Data(contentsOf: URL(fileURLWithPath: file))
        let one = String(decoding: try JSONSerialization.data(withJSONObject: ["id": "big6", "words": words]), as: UTF8.self)
        guard case .failure(let f) = FiltersOps.set(one, file: file) else { return XCTFail("a rule past 256 KiB taken") }
        XCTAssertEqual(f.code, "too_many")
        XCTAssertEqual(f.issues.first?.path, "filters")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: file)), saved)
    }

    func testAnInvalidFileIsNeverWrittenOverBySet() throws {
        try Data("{oops".utf8).write(to: URL(fileURLWithPath: file))
        guard case .failure(let f) = FiltersOps.set(#"{"id":"one","words":["a"]}"#, file: file) else { return XCTFail("wrote over it") }
        XCTAssertEqual(f.code, "invalid_file")
        XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), "{oops")
        _ = try FiltersOps.reset(file: file).get()
        XCTAssertEqual(try FiltersOps.list(file: file).get().object?["filters"], .array([]))
    }

    // MARK: The host's `filters` op

    private func ask(_ filters: @escaping () -> Result<[FilterRule], SurfacesIssue>) throws -> [String: Any] {
        let reply = NewTabHost.answer(Data(#"{"op":"filters"}"#.utf8), source: .init(surfaces: { .defaults }, filters: filters))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: reply) as? [String: Any])
    }

    func testTheHostAnswersNoFiltersForAMissingFile() throws {
        let r = try ask { Filters.load(path: self.file) }
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual((r["filters"] as? [Any])?.count, 0)
        // The default source, with no file anywhere, answers the same.
        let d = try JSONSerialization.jsonObject(with: NewTabHost.answer(Data(#"{"op":"filters"}"#.utf8), source: .init(surfaces: { .defaults }))) as? [String: Any]
        XCTAssertEqual(d?["ok"] as? Bool, true)
    }

    func testTheHostAnswersTheNormalizedRules() throws {
        try Data(#"{"version":1,"filters":[{"id":"yt","sites":["WWW.youtube.com"],"kinds":["shorts"],"accounts":["@Spam"]}]}"#.utf8)
            .write(to: URL(fileURLWithPath: file))
        let r = try ask { Filters.load(path: self.file) }
        XCTAssertEqual(r["ok"] as? Bool, true)
        let rules = try XCTUnwrap(r["filters"] as? [[String: Any]])
        XCTAssertEqual(rules.count, 1)
        XCTAssertEqual(rules[0]["id"] as? String, "yt")
        XCTAssertEqual(rules[0]["sites"] as? [String], ["youtube.com"])
        XCTAssertEqual(rules[0]["accounts"] as? [String], ["spam"])
        XCTAssertEqual(rules[0]["enabled"] as? Bool, true)
        XCTAssertEqual(rules[0]["hide"] as? [String], [])
    }

    func testTheHostRefusesAnInvalidFile() throws {
        try Data(##"{"version":1,"filters":[{"id":"a","hide":["#x"]}]}"##.utf8).write(to: URL(fileURLWithPath: file))
        let r = try ask { Filters.load(path: self.file) }
        XCTAssertEqual(r["ok"] as? Bool, false)
        let error = try XCTUnwrap(r["error"] as? String)
        XCTAssertTrue(error.contains("filters[0].hide"), error)
        XCTAssertNil(r["filters"])
    }
}
