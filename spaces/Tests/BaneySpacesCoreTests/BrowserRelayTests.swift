import Darwin
import XCTest
@testable import BaneySpacesCore

/// The extension's long line to the app (docs/newtab.md, "The port that stays open"): a fake extension on pipes, the real
/// relay, and the real server on a socket in a scratch folder. No browser and no running app.
final class BrowserRelayTests: XCTestCase {
    private var folder: URL!
    private var path: String { folder.appendingPathComponent("b.sock").path }

    override func setUp() {
        // Short: a Unix socket's path holds 103 bytes.
        folder = URL(fileURLWithPath: "/tmp/pbr-\(UInt32.random(in: 0...UInt32.max))", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    override func tearDown() { try? FileManager.default.removeItem(at: folder) }

    /// The extension's side of a port.
    private final class Port {
        private var toHost: [Int32] = [0, 0], fromHost: [Int32] = [0, 0]
        let ended = XCTestExpectation(description: "the host ended")
        init(_ path: String, retry: TimeInterval = 0.05) {
            pipe(&toHost); pipe(&fromHost)
            let (i, o) = (toHost[0], fromHost[1])
            Thread.detachNewThread { [ended] in
                BrowserRelay.serve(input: i, output: o, path: path, retry: retry)
                ended.fulfill()
            }
        }
        func send(_ o: [String: Any]) { _ = Wire.writeAll(toHost[1], NewTabHost.encode(try! JSONSerialization.data(withJSONObject: o))) }
        func sendRaw(_ s: String) { _ = Wire.writeAll(toHost[1], NewTabHost.encode(Data(s.utf8))) }
        /// The next message, as its op; nil after 3 s.
        func next() -> [String: Any]? {
            var p = pollfd(fd: fromHost[0], events: Int16(POLLIN), revents: 0)
            guard poll(&p, 1, 3000) > 0, let m = NewTabHost.readMessage(fd: fromHost[0]) else { return nil }
            return (try? JSONSerialization.jsonObject(with: m)) as? [String: Any]
        }
        func close() { Darwin.close(toHost[1]) }
    }

    private func server(_ bundle: String? = "org.example.browser") -> (BrowserServer, Box) {
        let box = Box()
        let s = BrowserServer(path: path, identify: { _ in bundle })
        s.joined = { box.links.append($0); $0.send(["op": "browser.want", "sources": ["tabs"]]) }
        s.message = { m, link in box.book.take(m, from: link.peer); box.count += 1 }
        s.gone = { link in box.book.forget(link.peer); box.links.removeAll { $0 === link }; box.gone += 1 }
        return (s, box)
    }
    private final class Box { var links: [BrowserServer.Link] = []; let book = BrowserBook(); var count = 0; var gone = 0 }

    private func until(_ what: String, _ done: () -> Bool) {
        let end = Date().addingTimeInterval(5)
        while !done(), Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        XCTAssertTrue(done(), what)
    }
    private func ask(_ port: Port) -> [String: Any]? {
        var got: [String: Any]?
        let done = XCTestExpectation(description: "a message")
        Thread.detachNewThread { got = port.next(); done.fulfill() }
        wait(for: [done], timeout: 5)
        return got
    }
    private func tabs(_ title: String) -> [String: Any] {
        ["op": "browser.rows", "source": "tabs", "first": true, "last": true,
         "rows": [["id": 4, "window": 2, "title": title, "url": "https://a.example/", "incognito": false]]]
    }

    func testMessagesGoBothWaysAndTheRecordGoesWithThePort() {
        let (s, box) = server()
        XCTAssertTrue(s.start())
        defer { s.stop() }
        let port = Port(path)
        XCTAssertEqual(ask(port)?["op"] as? String, "browser.want", "the app says what it wants first")
        port.send(tabs("Knitting"))
        until("the tab came") { box.book.search("knitting").count == 1 }
        XCTAssertEqual(box.book.search("knitting")[0].peer, BrowserPeer("org.example.browser", 1))
        box.links[0].send(["op": "browser.go", "tab": 4])
        XCTAssertEqual(ask(port)?["tab"] as? Int, 4)
        port.close()
        wait(for: [port.ended], timeout: 5)
        until("the record went") { box.gone == 1 && box.book.rows(.tabs).isEmpty }
    }

    func testTheAppComingAndGoingIsTold() {
        let port = Port(path)
        XCTAssertEqual(ask(port)?["op"] as? String, "browser.away", "a browser that starts first hears so")
        port.send(tabs("Dropped"))
        Thread.sleep(forTimeInterval: 0.2)
        let (one, box) = server()
        XCTAssertTrue(one.start())
        XCTAssertEqual(ask(port)?["op"] as? String, "browser.want")
        XCTAssertEqual(box.count, 0, "what was sent while the app was away isn't kept")
        one.stop()
        XCTAssertEqual(ask(port)?["op"] as? String, "browser.away")
        until("gone") { box.gone == 1 }
        let (two, again) = server()
        XCTAssertTrue(two.start())
        XCTAssertEqual(ask(port)?["op"] as? String, "browser.want")
        port.send(tabs("Back"))
        until("back") { again.book.search("back").count == 1 }
        port.close()
        wait(for: [port.ended], timeout: 5)
        two.stop()
    }

    func testTwoProfilesAreTwoPeersAndNothingMalformedGetsThrough() {
        let (s, box) = server()
        XCTAssertTrue(s.start())
        defer { s.stop() }
        let a = Port(path), b = Port(path)
        XCTAssertNotNil(ask(a)); XCTAssertNotNil(ask(b))
        a.sendRaw("{\n\"op\": \"browser.rows\",\n\"source\": \"tabs\", \"first\": true, \"last\": true, \"rows\": [{\"id\": 1, \"window\": 1, \"title\": \"Split\", \"incognito\": false}]}")
        b.sendRaw("not json")
        b.send(["op": "focus", "id": "x"])
        b.send(tabs("Second"))
        until("both") { box.book.rows(.tabs).count == 2 }
        XCTAssertEqual(box.count, 2)
        XCTAssertEqual(Set(box.book.rows(.tabs).map(\.peer)).count, 2)
        a.close(); b.close()
        wait(for: [a.ended, b.ended], timeout: 5)
        until("both gone") { box.gone == 2 }
    }

    func testALineWithNoEndAndAStrangerAreCutOff() {
        let (s, box) = server()
        XCTAssertTrue(s.start())
        let fd = BrowserRelay.connect(path)
        XCTAssertGreaterThanOrEqual(fd, 0)
        until("joined") { box.links.count == 1 }
        Thread.detachNewThread { _ = Wire.writeAll(fd, Data(repeating: 0x41, count: 3 << 20)) }
        until("cut off") { box.gone == 1 }
        close(fd)
        s.stop()
        let (strict, none) = server(nil)
        XCTAssertTrue(strict.start())
        defer { strict.stop() }
        let who = BrowserRelay.connect(path)
        var byte: UInt8 = 0
        var p = pollfd(fd: who, events: Int16(POLLIN), revents: 0)
        XCTAssertEqual(poll(&p, 1, 3000) > 0 ? read(who, &byte, 1) : -1, 0, "a process that is no browser's host is hung up on")
        close(who)
        XCTAssertTrue(none.links.isEmpty)
    }

    func testNoMoreThanTwelveProfilesAtOnce() {
        let (s, box) = server()
        XCTAssertTrue(s.start())
        defer { s.stop() }
        let ports = (0..<(BrowserServer.most + 1)).map { _ in Port(path, retry: 10) }
        until("twelve joined") { box.links.count == BrowserServer.most }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(box.links.count, BrowserServer.most, "the next is turned away")
        ports.forEach { $0.close() }
        wait(for: ports.map(\.ended), timeout: 5)
    }

    func testAnEmptyLineFromTheAppNeverReachesTheBrowser() {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = Wire.address(path: path)!
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        Darwin.listen(fd, 1)
        defer { close(fd) }
        let port = Port(path)
        Thread.detachNewThread {
            let app = accept(fd, nil, nil)
            _ = Wire.writeAll(app, Data("\n\n{\"op\":\"browser.want\"}\n".utf8))
        }
        XCTAssertEqual(ask(port)?["op"] as? String, "browser.want", "the blank lines are dropped, not sent as empty messages")
        port.close()
        wait(for: [port.ended], timeout: 5)
    }

    func testTheSocketIsThePersonsAlone() throws {
        let (s, _) = server()
        XCTAssertTrue(s.start())
        let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
        XCTAssertFalse(BrowserServer(path: path).start(), "a socket someone answers isn't taken")
        for id in ["com.baney.polycarp.browser", "com.google.Chrome", "com.brave.Browser", "org.chromium.Chromium"] { XCTAssertTrue(BrowserServer.isBrowser(id), id) }
        for id in ["com.apple.Terminal", "com.apple.Safari", "com.mitchellh.ghostty", ""] { XCTAssertFalse(BrowserServer.isBrowser(id), id) }
        // The real lookup, on this test's own socket: its runner is an app (Xcode's), and not a browser.
        var pair: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
        defer { Darwin.close(pair[0]); Darwin.close(pair[1]) }
        if NewTabHost.appBundleID(of: getppid()) != nil { XCTAssertNil(BrowserServer.browser(pair[0])) }
        s.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testOnlyJoinKeepsThePortOpen() {
        XCTAssertTrue(BrowserRelay.isJoin(Data(#"{"op":"browser.join"}"#.utf8)))
        XCTAssertFalse(BrowserRelay.isJoin(Data(#"{"op":"page"}"#.utf8)))
        XCTAssertFalse(BrowserRelay.isJoin(Data("[]".utf8)))
        XCTAssertNil(BrowserServer.browser(-1))
        for (message, relayed) in [(#"{"op":"browser.join"}"#, true), (#"{"op":"nonsense"}"#, false)] {
            var request: [Int32] = [0, 0], reply: [Int32] = [0, 0], got = false
            pipe(&request); pipe(&reply)
            _ = Wire.writeAll(request[1], NewTabHost.encode(Data(message.utf8)))
            close(request[1])
            XCTAssertTrue(NewTabHost.serve(input: request[0], output: reply[1], source: .init(surfaces: { .defaults }), relay: { i, o in got = i == request[0] && o == reply[1] }))
            close(reply[1])
            XCTAssertEqual(got, relayed)
            XCTAssertEqual(NewTabHost.readMessage(fd: reply[0]) == nil, relayed, "a join gets no reply of its own")
            close(request[0]); close(reply[0])
        }
    }
}
