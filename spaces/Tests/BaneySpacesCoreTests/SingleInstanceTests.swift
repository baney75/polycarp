import XCTest
@testable import BaneySpacesCore

/// Only one copy runs (the `--version` incident, 2026-11-05). Nothing here starts the app.
final class SingleInstanceTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        // Short: a Unix socket path holds about 100 bytes.
        dir = URL(fileURLWithPath: "/tmp/pc-\(UInt32.random(in: 0...UInt32.max))")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    // MARK: the lock

    func testASecondProcessCannotTakeTheLockAndLearnsWhoHasIt() throws {
        let url = dir.appendingPathComponent("polycarp.lock")
        guard case .acquired(let first) = SingleInstance.Lock.acquire(at: url, pid: 4242) else { return XCTFail("first takes it") }
        // flock belongs to the open file, so a second open in this process stands in for another process.
        guard case .busy(let holder) = SingleInstance.Lock.acquire(at: url, pid: 99) else { return XCTFail("second must be refused") }
        XCTAssertEqual(holder, 4242)
        first.release()
        guard case .acquired = SingleInstance.Lock.acquire(at: url, pid: 99) else { return XCTFail("free again once the first is gone") }
    }

    func testTheLockDescriptorIsCloseOnExec() throws {
        // A helper the app starts must not inherit it, or the lock would outlive the app.
        guard case .acquired(let lock) = SingleInstance.Lock.acquire(at: dir.appendingPathComponent("l")) else { return XCTFail() }
        XCTAssertNotEqual(fcntl(lock.fdForTest, F_GETFD) & FD_CLOEXEC, 0)
    }

    // MARK: the decision

    func testAnotherCopyByBundleIDHandsOverEvenWithNoLockFile() {
        let url = dir.appendingPathComponent("polycarp.lock")
        guard case .yield(let to) = SingleInstance.claim(runningPids: [500], lockURL: url, me: 1) else { return XCTFail() }
        XCTAssertEqual(to, 500)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "it decided before touching any file")
    }

    func testTheLockCatchesACopyThatTheBundleCheckMisses() {
        // A copy run from another path (or renamed): no matching bundle ID, but it holds the lock.
        let url = dir.appendingPathComponent("polycarp.lock")
        guard case .mine = SingleInstance.claim(runningPids: [], lockURL: url, me: 7) else { return XCTFail("first runs") }
        guard case .yield(let to) = SingleInstance.claim(runningPids: [], lockURL: url, me: 8) else { return XCTFail("second must yield") }
        XCTAssertEqual(to, 7)
    }

    func testOurOwnPidDoesNotCount() {
        let url = dir.appendingPathComponent("polycarp.lock")
        guard case .mine = SingleInstance.claim(runningPids: [7], lockURL: url, me: 7) else { return XCTFail() }
    }

    func testMainDecidesBeforeAnythingElse() throws {
        let main = try Repo.code("Sources/BaneySpaces/main.swift")
        let at = { (s: String) in try XCTUnwrap(main.range(of: s)?.lowerBound, s) }
        let version = try at("EntryPoint.immediate")
        let claim = try at("SingleInstance.claim")
        for later in ["NSApplication.shared", "CrashLoop.", "SettingsImport.run", "Launcher.commandLine", "AppDelegate()"] {
            XCTAssertLessThan(claim, try at(later), "the one-copy check must come before \(later)")
        }
        XCTAssertLessThan(version, claim, "--version answers before even the lock is looked at")
        XCTAssertLessThan(try at("SingleInstance.claim"), try at("SettingsImport.run"))
    }

    // MARK: --version and --help

    func testVersionAndHelpPrintAndStopTheStart() throws {
        let info: [String: Any] = ["CFBundleShortVersionString": "0.4.0", "PolycarpCommit": "abcdef1234567"]
        let v = try XCTUnwrap(EntryPoint.immediate(arguments: ["Polycarp", "--version"], info: info))
        XCTAssertEqual(v, EntryPoint.Immediate(text: "Polycarp 0.4.0 (abcdef1)", code: 0))
        let h = try XCTUnwrap(EntryPoint.immediate(arguments: ["Polycarp", "--help"], info: info, binary: "Polycarp"))
        XCTAssertTrue(h.text.contains("usage: Polycarp"))
        XCTAssertNil(EntryPoint.immediate(arguments: ["Polycarp"], info: info), "a plain start carries on")
        XCTAssertNil(EntryPoint.immediate(arguments: ["Polycarp", "--setup"], info: info))
    }

    func testOnlyRenderAndBangsRunBesideAnotherCopy() {
        XCTAssertFalse(EntryPoint.needsExclusiveCopy(arguments: ["Polycarp", "--bangs", "list"]))
        XCTAssertFalse(EntryPoint.needsExclusiveCopy(arguments: ["Polycarp", "--render", "/tmp/x"]))
        XCTAssertTrue(EntryPoint.needsExclusiveCopy(arguments: ["Polycarp"]))
        XCTAssertTrue(EntryPoint.needsExclusiveCopy(arguments: ["Polycarp", "--restore-dock"]))
    }

    // MARK: sockets

    private func listen(_ path: String) -> Int32 {
        var addr = Wire.address(path: path)!
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(Darwin.listen(fd, 4), 0)
        return fd
    }

    func testALiveSocketIsNeverRemoved() {
        let path = dir.appendingPathComponent("p.sock").path
        let fd = listen(path); defer { close(fd) }
        XCTAssertEqual(SocketClaim.prepare(path: path), .live)
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "the running process keeps its socket")
        XCTAssertTrue(SocketClaim.isLive(path: path))
    }

    func testALeftoverSocketFileIsRemoved() {
        let path = dir.appendingPathComponent("p.sock").path
        close(listen(path))   // the process is gone, the file stays
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        XCTAssertEqual(SocketClaim.prepare(path: path), .removedStale)
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        XCTAssertEqual(SocketClaim.prepare(path: path), .free)
    }

    func testTheServerAsksBeforeItUnlinks() throws {
        let server = try Repo.code("Sources/BaneySpaces/Session/Server.swift")
        let listenFn = try XCTUnwrap(server.range(of: "private func listen(on path: String)")?.lowerBound)
        let tail = server[listenFn...]
        XCTAssertLessThan(try XCTUnwrap(tail.range(of: "SocketClaim.prepare")?.lowerBound),
                          try XCTUnwrap(tail.range(of: "socket(AF_UNIX")?.lowerBound))
        XCTAssertFalse(tail.prefix(400).contains("unlink(path)"), "listen(on:) must not unlink by itself")
    }
}
