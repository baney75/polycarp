import XCTest
@testable import BaneySpacesCore

/// PR 20 second-S3: `polycarp-spaces state` read the old app's session.json whenever Polycarp had none of its own, even
/// long after BaneySpaces quit, and the app wrote its own state into that old folder too.
final class StatePathTests: XCTestCase {
    func testTheOldAppsStateCountsOnlyWhileItIsRunning() throws {
        // Short: a Unix socket path holds about 100 bytes.
        let root = URL(fileURLWithPath: "/tmp/sp-\(UInt32.random(in: 0...UInt32.max))")
        let mine = root.appendingPathComponent("new"), old = root.appendingPathComponent("old")
        defer { try? FileManager.default.removeItem(at: root) }
        for d in [mine, old] { try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }
        try Data("{}".utf8).write(to: old.appendingPathComponent("session.json"))
        let ownPath = mine.appendingPathComponent("session.json").path

        XCTAssertEqual(Wire.statePath(dir: mine, legacyDir: old), ownPath, "BaneySpaces quit: its file is stale")

        let sock = old.appendingPathComponent(Product.Legacy.socketNames[0]).path
        var addr = try XCTUnwrap(Wire.address(path: sock))
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        defer { close(fd) }
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(Darwin.listen(fd, 4), 0)
        XCTAssertEqual(Wire.statePath(dir: mine, legacyDir: old), old.appendingPathComponent("session.json").path, "a running BaneySpaces' state")

        try Data("{}".utf8).write(to: URL(fileURLWithPath: ownPath))
        XCTAssertEqual(Wire.statePath(dir: mine, legacyDir: old), ownPath, "the app's own file wins")
    }

    func testTheAppWritesItsStateIntoItsOwnFolder() throws {
        let session = try String(contentsOf: SourceText.root.appendingPathComponent("Sources/BaneySpaces/Session/SessionController.swift"), encoding: .utf8)
        XCTAssertTrue(session.contains("URL(fileURLWithPath: Wire.ownStatePath)"))
        XCTAssertFalse(session.contains("URL(fileURLWithPath: Wire.statePath)"), "never into the old app's folder")
    }
}
