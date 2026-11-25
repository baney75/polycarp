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
