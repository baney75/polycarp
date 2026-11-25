import BaneySpacesCore
import Foundation
import XCTest

/// edits.json: the page edits Polycarp's browser extension applies, checked and normalized here and written whole.
final class EditsTests: XCTestCase {
    private var dir: URL!
    private var file: String { dir.appendingPathComponent(Edits.name).path }

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("edits-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func json(_ s: String) -> SurfaceValue {
        guard case .success(let v) = SurfaceValue.parse(Data(s.utf8)) else { fatalError("bad test JSON: \(s)") }
        return v
    }

    /// spec/edits.json, which the extension's tests run too.
    func testTheSharedCases() throws {
        let cases = try XCTUnwrap(json(Repo.text("spec/edits.json")).object)
        let accept = try XCTUnwrap(cases["accept"]?.array), refuse = try XCTUnwrap(cases["refuse"]?.array)
        XCTAssertEqual(cases["rules"]?.object?["never"]?.array?.compactMap(\.string), Edits.never)
        XCTAssertGreaterThan(accept.count, 10)
        XCTAssertGreaterThan(refuse.count, 35)
        for c in accept.compactMap(\.object) {
            let name = c["case"]?.string ?? "?"
            switch Edits.edit(c["edit"]!) {
            case .failure(let i): XCTFail("\(name) refused: \(i)")
            // What comes out goes back in unchanged, so a saved file loads.
            case .success(let e):
                XCTAssertEqual(try Edits.edit(e).get(), e, name)
                if let sites = c["sites"] { XCTAssertEqual(e.object?["sites"], sites, name) }
            }
        }
        for c in refuse.compactMap(\.object) {
            let name = c["case"]?.string ?? "?"
            switch Edits.edit(c["edit"]!) {
            case .success(let e): XCTFail("\(name) accepted: \(e.json())")
            case .failure(let i): XCTAssertEqual(i.path, c["path"]?.string, "\(name): \(i)")
            }
        }
    }

    func testAnEditIsNormalizedWithEveryKey() throws {
        let e = try Edits.edit(json(#"{"id":"a","sites":["https://X.com/home","x.com"],"changes":[{"do":"hide","at":" #a "}]}"#)).get()
        XCTAssertEqual(e, json(##"{"id":"a","name":"","enabled":true,"sites":["x.com"],"paths":[],"css":"","changes":[{"do":"hide","at":"#a"}]}"##))
    }

    func testLimits() {
        func refused(_ s: String) -> String? { if case .failure(let i) = Edits.edit(json(s)) { i.path } else { nil } }
        let hides = Array(repeating: #"{"do":"hide","at":"a"}"#, count: Edits.maxChanges + 1).joined(separator: ",")
        XCTAssertEqual(refused(#"{"id":"a","sites":["x.com"],"changes":[\#(hides)]}"#), "changes")
        XCTAssertEqual(refused(#"{"id":"a","sites":["x.com"],"css":"\#(String(repeating: "a", count: Edits.maxCSS + 1))"}"#), "css")
        XCTAssertEqual(refused(#"{"id":"a","sites":["x.com"],"changes":[{"do":"hide","at":"\#(String(repeating: "a", count: Edits.maxSelector + 1))"}]}"#), "changes[0].at")
        XCTAssertEqual(refused(#"{"id":"\#(String(repeating: "a", count: 65))","sites":["x.com"],"css":"a{}"}"#), "id")
    }

    func testTheFileIsCheckedWholeAndARefusalWritesNothing() throws {
        XCTAssertEqual(try Edits.load(path: file).get(), [])
        let a = json(#"{"id":"a","sites":["x.com"],"css":"a{color:red}"}"#)
        try Edits.save([a], to: file)
        XCTAssertEqual(try Edits.load(path: file).get().count, 1)
        let before = try Data(contentsOf: URL(fileURLWithPath: file))
        XCTAssertThrowsError(try Edits.save([a, a], to: file)) { XCTAssertEqual(($0 as? SurfacesIssue)?.path, "edits[1].id") }
        XCTAssertThrowsError(try Edits.save([a, json(#"{"id":"b","sites":[],"css":"a{}"}"#)], to: file))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: file)), before)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [Edits.name])
        for bad in ["[]", #"{"version":2,"edits":[]}"#, #"{"version":1}"#, #"{"version":1,"edits":[],"x":1}"#, "nonsense"] {
            try Data(bad.utf8).write(to: URL(fileURLWithPath: file))
            if case .success = Edits.load(path: file) { XCTFail("loaded \(bad)") }
        }
    }
}
