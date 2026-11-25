import BaneySpacesCore
import Foundation
import XCTest

/// `polycarp-spaces edits` (EditsOps) and the new tab host's `edits` op.
final class EditsOpsTests: XCTestCase {
    private var dir: URL!
    private var file: String { dir.appendingPathComponent(Edits.name).path }
    private let one = #"{"id":"one","sites":["example.com"],"css":"a{color:red}"}"#

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("edits-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func ids() throws -> [String] { try Edits.load(path: file).get().compactMap { $0.object?["id"]?.string } }
    private func code(_ r: SurfacesOps.Result) -> String? { if case .failure(let f) = r { f.code } else { nil } }

    func testSetUpsertsTurnsAndRemovesById() throws {
        XCTAssertEqual(try EditsOps.set(one, file: file).get().object?["replaced"], .bool(false))
        _ = try EditsOps.set(#"{"id":"two","sites":["b.com"],"changes":[{"do":"hide","at":"a"}]}"#, file: file).get()
        XCTAssertEqual(try EditsOps.set(one, file: file).get().object?["replaced"], .bool(true))
        XCTAssertEqual(try ids(), ["one", "two"])
        let off = try EditsOps.turn("one", on: false, file: file).get()
        XCTAssertEqual(off.object?["edit"]?.object?["enabled"], .bool(false))
        XCTAssertEqual(off.object?["edit"]?.object?["css"], .string("a{color:red}"), "the rest of it is kept")
        XCTAssertEqual(try EditsOps.remove("one", file: file).get().object?["edits"]?.array?.count, 1)
        // Only the file: no temp file is left beside it.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [Edits.name])
        _ = try EditsOps.reset(file: file).get()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file))
    }

    func testARefusalWritesNothing() throws {
        _ = try EditsOps.set(one, file: file).get()
        let before = try Data(contentsOf: URL(fileURLWithPath: file))
        XCTAssertEqual(code(EditsOps.set("not json", file: file)), "invalid_edit")
        XCTAssertEqual(code(EditsOps.set(#"{"id":"one","sites":["example.com"],"css":"a{background:url(x)}"}"#, file: file)), "invalid_edit")
        XCTAssertEqual(code(EditsOps.remove("nope", file: file)), "not_found")
        XCTAssertEqual(code(EditsOps.turn("nope", on: true, file: file)), "not_found")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: file)), before)
        try Edits.save((0..<Edits.maxEdits).map { i in SurfaceValue.object(["id": .string("e\(i)"), "sites": .array([.string("x.com")]), "css": .string("a{}")]) }, to: file)
        XCTAssertEqual(code(EditsOps.set(one, file: file)), "too_many")
        try Data("{oops".utf8).write(to: URL(fileURLWithPath: file))
        XCTAssertEqual(code(EditsOps.set(one, file: file)), "invalid_file")
        XCTAssertEqual(try String(contentsOfFile: file, encoding: .utf8), "{oops")
    }

    // MARK: The page a person shares

    private var shared: String { dir.appendingPathComponent(SharedPage.name).path }
    private let page = #"{"url":"https://example.com/inbox?token=s3cret#t","title":"In\u001bbox","parts":[{"at":"main > h1","is":"Heading","words":"Hello\nthere"},{"at":"p.a\u200db","is":"Part"},{"at":"li.row","is":"List item","count":12}],"edits":[{"id":"one","hits":[3,0]}]}"#

    private func share(_ page: String) throws -> [String: Any] {
        let source = NewTabHost.Source(surfaces: { .defaults }, sharePage: { SharedPage.share($0, to: self.shared) })
        let reply = NewTabHost.answer(Data(#"{"op":"sharePage","page":\#(page)}"#.utf8), source: source)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: reply) as? [String: Any])
    }

    func testASharedPageIsReadForAnHourAndHoldsNoQuery() throws {
        XCTAssertEqual(code(EditsOps.page(file: shared)), "not_shared")
        XCTAssertEqual(try share(page)["ok"] as? Bool, true)
        let got = try EditsOps.page(file: shared).get().object?["page"]?.object
        XCTAssertEqual(got?["url"], .string("https://example.com/inbox"), "a query can hold a secret")
        XCTAssertEqual(got?["title"], .string("In box"), "no control character reaches a terminal")
        XCTAssertEqual(got?["parts"]?.array?.count, 2, "a selector is never rewritten")
        XCTAssertEqual(got?["parts"]?.array?.first?.object?["words"], .string("Hello there"))
        XCTAssertEqual(got?["parts"]?.array?.last?.object?["count"], .number(12))
        XCTAssertEqual(got?["edits"]?.array?.first?.object?["hits"], .array([.number(3), .number(0)]))
        let mode = try FileManager.default.attributesOfItem(atPath: shared)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600, "only this account reads it")
        XCTAssertNotNil(SharedPage.load(path: shared, now: Date() + 3500))
        XCTAssertEqual(code(EditsOps.page(file: shared, now: Date() + 3700)), "not_shared")
        XCTAssertFalse(FileManager.default.fileExists(atPath: shared), "an old one is removed")
        _ = try share(page)
        XCTAssertNil(SharedPage.load(path: shared, now: Date() - 7200), "nor does a clock set back keep it")
    }

    func testStopSharingRemovesThePageAndABadOneLeavesIt() throws {
        _ = try share(page)
        for bad in [#"{"url":"file:///etc/passwd","title":"","parts":[]}"#, #"{"url":"https://me:secret@a.com/","title":"","parts":[]}"#, #"{"url":"https://a.com","title":"","parts":[{"at":""}]}"#, "3",
                    #"{"url":"https://a.com","title":"","parts":[\#((0...SharedPage.maxParts).map { _ in #"{"at":"a","is":"b"}"# }.joined(separator: ","))]}"#] {
            XCTAssertEqual(try share(bad)["ok"] as? Bool, false, bad)
        }
        XCTAssertNotNil(SharedPage.load(path: shared), "a refused page changes nothing")
        XCTAssertEqual(try share("null")["ok"] as? Bool, true)
        XCTAssertEqual(code(EditsOps.page(file: shared)), "not_shared")
        XCTAssertEqual(try share("null")["ok"] as? Bool, true, "twice is fine")
    }

    func testTheHostAnswersTheEditsOrSaysWhyNot() throws {
        func ask() throws -> [String: Any] {
            let reply = NewTabHost.answer(Data(#"{"op":"edits"}"#.utf8), source: .init(surfaces: { .defaults }, edits: { Edits.load(path: self.file) }))
            return try XCTUnwrap(JSONSerialization.jsonObject(with: reply) as? [String: Any])
        }
        XCTAssertEqual((try ask()["edits"] as? [Any])?.count, 0, "a missing file is no edits")
        _ = try EditsOps.set(one, file: file).get()
        let edit = try XCTUnwrap((try ask()["edits"] as? [[String: Any]])?.first)
        XCTAssertEqual(edit["id"] as? String, "one")
        XCTAssertEqual(edit["enabled"] as? Bool, true)
        try Data(#"{"version":1,"edits":[{"id":"a","css":"a{}"}]}"#.utf8).write(to: URL(fileURLWithPath: file))
        let bad = try ask()
        XCTAssertEqual(bad["ok"] as? Bool, false)
        XCTAssertTrue(try XCTUnwrap(bad["error"] as? String).contains("edits[0].sites"))
    }
}
