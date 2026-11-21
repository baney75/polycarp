import Foundation
import XCTest
@testable import BaneySpacesCore

/// 11-17: every builder's `--render` runs shared one crash ledger in the person's own Application Support folder, so
/// three crashes in anyone's renders refused everyone's, and each render wrote into the real `trace.log`. A render run
/// keeps its files in a folder of its own.
final class RenderFolderTests: XCTestCase {
    private let home = FileManager.default.homeDirectoryForCurrentUser
    private var own: URL { home.appendingPathComponent("Library/Application Support/Polycarp", isDirectory: true) }
    private let render = ["/Applications/Polycarp.app/Contents/MacOS/BaneySpaces", "--render", "/tmp/shots"]

    override func tearDown() { RunFolder.current = nil }

    /// The ledger a render run's guard reads and writes (`CrashLoop.ledger`: `Spaces.folder`, which is `Product.supportDir`).
    private func renderLedger(environment: [String: String]) -> URL {
        RunFolder.current = RunFolder.resolve(arguments: render, environment: environment, home: home, temp: { RunFolder.newTemp() })
        return Product.supportDir(home: home).appendingPathComponent(CrashLedgerFile.renderFileName)
    }

    func testARenderRunsLedgerIsNeverInTheRealFolder() {
        for env in [[:], ["POLYCARP_SUPPORT_DIR": own.path], ["POLYCARP_SUPPORT_DIR": own.path + "/sub"],
                    ["POLYCARP_SUPPORT_DIR": own.path + "/../Polycarp"], ["POLYCARP_SUPPORT_DIR": "relative/dir"]] {
            let ledger = renderLedger(environment: env)
            XCTAssertFalse(RunFolder.inside(ledger, own), "\(env): \(ledger.path)")
            XCTAssertTrue(RunFolder.isTemporary(ledger.deletingLastPathComponent()), "\(env) falls back to a temporary folder")
        }
    }

    func testTheOverrideIsUsedAndEachRunGetsItsOwnTemporaryFolder() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("render-here-\(UUID().uuidString)")
        XCTAssertEqual(renderLedger(environment: ["POLYCARP_SUPPORT_DIR": dir.path]).deletingLastPathComponent().path, dir.path)
        XCTAssertFalse(RunFolder.isTemporary(dir), "a folder the caller named is never removed")
        XCTAssertNotEqual(renderLedger(environment: [:]), renderLedger(environment: [:]))
    }

    func testOnlyARenderRunMoves() {
        for args in [["Polycarp"], ["Polycarp", "--setup"], ["Polycarp", "--bangs", "list"]] {
            XCTAssertNil(RunFolder.resolve(arguments: args, environment: ["POLYCARP_SUPPORT_DIR": "/tmp/x"], home: home, temp: { RunFolder.newTemp() }))
        }
        XCTAssertEqual(Product.supportDir(home: home).standardizedFileURL, own.standardizedFileURL)
    }

    /// The app sets the folder before anything reads a path, and every path it writes starts from `Product.supportDir`.
    func testTheAppSetsTheFolderFirstAndReadsItEverywhere() throws {
        let main = try Repo.code("Sources/BaneySpaces/main.swift")
        let set = try XCTUnwrap(main.range(of: "RunFolder.current = RunFolder.resolve(")?.lowerBound, "main.swift sets the run's folder")
        for first in ["CrashLoop.", "Product.supportDir(", "Spaces.", "MoveToApplications"] {
            if let use = main.range(of: first)?.lowerBound { XCTAssertLessThan(set, use, "set before \(first)") }
        }
        XCTAssertTrue(try Repo.code("Sources/BaneySpaces/Spaces.swift").contains("static let folder = Product.supportDir(home:"))
        XCTAssertTrue(try Repo.code("Sources/BaneySpaces/CrashLoop.swift").contains("Spaces.folder.appendingPathComponent(name)"))
        let app = Repo.root.appendingPathComponent("Sources/BaneySpaces")
        for case let url as URL in FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil)! where url.pathExtension == "swift" {
            let code = try Repo.code("Sources/BaneySpaces/" + url.path.dropFirst(app.path.count + 1))
            XCTAssertFalse(code.contains(".applicationSupportDirectory"), "\(url.lastPathComponent) finds Application Support itself")
        }
    }
}
