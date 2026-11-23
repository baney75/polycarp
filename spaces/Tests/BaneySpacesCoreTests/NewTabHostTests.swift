import Darwin
import XCTest
@testable import BaneySpacesCore

/// The new tab page's native messaging host (docs/newtab.md): framing, the one request, the manifest and where it goes.
final class NewTabHostTests: XCTestCase {
    private var folder: URL!
    private let chicago = TimeZone(identifier: "America/Chicago")!
    private var now: Date {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = chicago
        return c.date(from: DateComponents(year: 2026, month: 11, day: 21, hour: 9))!
    }

    override func setUp() {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("newtab-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: folder)
    }

    private func source(_ surfaces: Surfaces = .defaults) -> NewTabHost.Source {
        NewTabHost.Source(surfaces: { surfaces }, now: { [now] in now }, timeZone: chicago)
    }

    private func ask(_ json: String, _ source: NewTabHost.Source) throws -> [String: Any] {
        let reply = NewTabHost.answer(Data(json.utf8), source: source)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: reply) as? [String: Any], String(decoding: reply, as: UTF8.self))
    }

    // MARK: Framing

    func testFramingRoundTrip() throws {
        let small = Data(#"{"op":"page"}"#.utf8)
        let framed = NewTabHost.encode(small)
        XCTAssertEqual(Array(framed.prefix(4)), [13, 0, 0, 0], "little-endian length first")
        XCTAssertEqual(NewTabHost.decode(framed), small)

        let big = Data(("{\"op\":\"name\",\"text\":\"" + String(repeating: "x", count: 70_000) + "\"}").utf8)
        XCTAssertGreaterThan(big.count, 64 * 1024)
        XCTAssertEqual(NewTabHost.decode(NewTabHost.encode(big)), big)
        XCTAssertEqual(NewTabHost.decode(NewTabHost.encode(Data())), Data())
    }

    func testAShortReadIsNil() throws {
        XCTAssertNil(NewTabHost.decode(Data()))
        XCTAssertNil(NewTabHost.decode(Data([5, 0])))
        XCTAssertNil(NewTabHost.decode(NewTabHost.encode(Data("hello".utf8)).dropLast()))
        XCTAssertNil(NewTabHost.decode(Data([0xFF, 0xFF, 0xFF, 0x7F, 1, 2])), "a length over the cap")

        // Over a pipe, as Chrome hands it: a length of 100 and only 10 bytes, then the end.
        var fds: [Int32] = [0, 0]
        XCTAssertEqual(pipe(&fds), 0)
        let partial = Data([100, 0, 0, 0]) + Data(repeating: 0x41, count: 10)
        XCTAssertTrue(Wire.writeAll(fds[1], partial))
        close(fds[1])
        XCTAssertNil(NewTabHost.readMessage(fd: fds[0]))
        close(fds[0])
    }

    func testServeReadsOneRequestAndWritesOneReply() throws {
        let big = Data(("{\"op\":\"nope\",\"pad\":\"" + String(repeating: "y", count: 70_000) + "\"}").utf8)
        var input: [Int32] = [0, 0], output: [Int32] = [0, 0]
        XCTAssertEqual(pipe(&input), 0)
        XCTAssertEqual(pipe(&output), 0)
        // The writer runs beside the reader: 70 KB is more than a pipe holds.
        let writer = Thread { [input] in _ = Wire.writeAll(input[1], NewTabHost.encode(big)); close(input[1]) }
        writer.start()
        XCTAssertTrue(NewTabHost.serve(input: input[0], output: output[1], source: source()))
        close(output[1]); close(input[0])
        var got = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while true { let n = read(output[0], &buf, buf.count); if n <= 0 { break }; got.append(contentsOf: buf[0..<n]) }
        close(output[0])
        let reply = try XCTUnwrap(NewTabHost.decode(got))
        XCTAssertEqual(got.count, reply.count + 4, "one framed reply and nothing else")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: reply) as? [String: Any])
        XCTAssertEqual(object["ok"] as? Bool, false)
    }

    // MARK: page

    func testPageWithTheVerse() throws {
        let r = try ask(#"{"op":"page"}"#, source())
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["question"] as? String, Surfaces.defaults.newtab.question)
        XCTAssertEqual(r["searchURL"] as? String, "https://duckduckgo.com/?q={query}")
        let day = try XCTUnwrap(Verses.pick(.daily, at: now, timeZone: chicago))
        let verse = try XCTUnwrap(r["verse"] as? [String: String])
        XCTAssertEqual(verse, ["text": day.text, "ref": day.ref])
    }

    func testPageWithTheVerseOff() throws {
        var s = Surfaces.defaults
        s.newtab.verse = false
        s.newtab.question = "Find it"
        s.newtab.searchURL = "https://search.example/?q={query}"
        let reply = NewTabHost.answer(Data(#"{"op":"page"}"#.utf8), source: source(s))
        let text = String(decoding: reply, as: UTF8.self)
        XCTAssertTrue(text.contains(#""verse":null"#), "a verse switched off is null, not missing: \(text)")
        let r = try ask(#"{"op":"page"}"#, source(s))
        XCTAssertTrue(r["verse"] is NSNull)
        XCTAssertEqual(r["question"] as? String, "Find it")
        XCTAssertEqual(r["searchURL"] as? String, "https://search.example/?q={query}")
    }

    /// 2026-11-22: the page never asks what the hour is for. It names no workspace, shows no purpose or daily focus, and
    /// a page from an older build that still sends `name` or `go` gets a plain refusal.
    func testThePageNamesNothingAndShowsNoPurpose() throws {
        let r = try ask(#"{"op":"page"}"#, source())
        XCTAssertEqual(Set(r.keys), ["ok", "question", "searchURL", "verse"])
        for old in [#"{"op":"name","text":"Pray"}"#, #"{"op":"go","workspace":3}"#] {
            XCTAssertEqual(try ask(old, source())["ok"] as? Bool, false, old)
        }
    }

    func testUnknownOpAndBadJSON() throws {
        for request in [#"{"op":"fly"}"#, #"{"text":"x"}"#, "not json", "[1,2]", ""] {
            let r = try ask(request, source())
            XCTAssertEqual(r["ok"] as? Bool, false, request)
            XCTAssertFalse((r["error"] as? String ?? "").isEmpty, request)
        }
    }

    // MARK: Manifest and where it goes

    func testManifest() throws {
        let path = "/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces"
        let m = try XCTUnwrap(JSONSerialization.jsonObject(with: NewTabHost.manifest(path: path)) as? [String: Any])
        XCTAssertEqual(m["name"] as? String, "com.polycarp.newtab")
        XCTAssertEqual(m["type"] as? String, "stdio")
        XCTAssertEqual(m["path"] as? String, path)
        XCTAssertEqual(m["allowed_origins"] as? [String], ["chrome-extension://kdaddaaobomjfjcgjeabgbenfddkcfcl/"])
        XCTAssertEqual(m["description"] as? String, "Polycarp's new tab page")
        XCTAssertEqual(Set(m.keys), ["name", "description", "path", "type", "allowed_origins"])
    }

    func testTargetsAreOnlyFoldersThatExistHeliumFirst() {
        let home = URL(fileURLWithPath: "/Users/someone", isDirectory: true)
        let support = "/Users/someone/Library/Application Support"
        let all: Set<String> = ["\(support)/Chromium", "\(support)/Google/Chrome", "\(support)/net.imput.helium"]
        XCTAssertEqual(NewTabHost.targets(home: home, existing: all).map(\.path), [
            "\(support)/net.imput.helium/NativeMessagingHosts/com.polycarp.newtab.json",
            "\(support)/Google/Chrome/NativeMessagingHosts/com.polycarp.newtab.json",
            "\(support)/Chromium/NativeMessagingHosts/com.polycarp.newtab.json",
        ])
        XCTAssertEqual(NewTabHost.targets(home: home, existing: ["\(support)/Chromium", "\(support)/Firefox"]).map(\.path),
                       ["\(support)/Chromium/NativeMessagingHosts/com.polycarp.newtab.json"])
        XCTAssertEqual(NewTabHost.targets(home: home, existing: []), [])
    }

    func testRegisterWritesOnlyIntoBrowsersThatExistAndOnlyWhenChanged() throws {
        let home = folder.appendingPathComponent("home", isDirectory: true)
        let helium = home.appendingPathComponent("Library/Application Support/net.imput.helium", isDirectory: true)
        try FileManager.default.createDirectory(at: helium, withIntermediateDirectories: true)
        let first = NewTabHost.register(cliPath: "/x/polycarp-spaces", home: home)
        XCTAssertEqual(first, NewTabHost.Registration(written: ["Helium"]))
        let file = helium.appendingPathComponent("NativeMessagingHosts/com.polycarp.newtab.json")
        XCTAssertEqual(FileManager.default.contents(atPath: file.path), NewTabHost.manifest(path: "/x/polycarp-spaces"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Application Support/Google").path),
                       "never makes a browser's own folder")
        XCTAssertEqual(NewTabHost.register(cliPath: "/x/polycarp-spaces", home: home), NewTabHost.Registration(current: ["Helium"]))
        XCTAssertEqual(NewTabHost.register(cliPath: "/y/polycarp-spaces", home: home), NewTabHost.Registration(written: ["Helium"]))
        XCTAssertFalse(NewTabHost.Registration().line.contains("\u{2014}"))
    }

    // MARK: Wiring

    func testTheCommandHandsABrowserOriginToTheHost() throws {
        XCTAssertTrue(NewTabHost.startedByBrowser(["polycarp-spaces", "chrome-extension://kdaddaaobomjfjcgjeabgbenfddkcfcl/"]))
        XCTAssertFalse(NewTabHost.startedByBrowser(["polycarp-spaces", "ls"]))
        XCTAssertFalse(NewTabHost.startedByBrowser(["polycarp-spaces"]))

        let cli = try SourceText.code("Sources/baneyspaces-cli/main.swift")
        let first = try XCTUnwrap(cli.range(of: "if NewTabHost.startedByBrowser(CommandLine.arguments) {"))
        let parse = try XCTUnwrap(cli.range(of: "var argv = Array(CommandLine.arguments.dropFirst())"))
        let helper = try XCTUnwrap(cli.range(of: "DockRestartHelper.run("))
        XCTAssertLessThan(first.lowerBound, parse.lowerBound, "before any other parsing")
        XCTAssertLessThan(first.lowerBound, helper.lowerBound)
        let block = try XCTUnwrap(SourceText.block(after: "if NewTabHost.startedByBrowser(CommandLine.arguments)", in: cli))
        XCTAssertTrue(block.contains("NewTabHost.serve(input: STDIN_FILENO, output: STDOUT_FILENO, source: .live())"))
        XCTAssertTrue(block.contains("exit("))
        XCTAssertTrue(cli.contains("case NewTabHost.command:"))
        XCTAssertTrue(cli.contains("  newtab-host "), "listed in the usage text")
        XCTAssertEqual(NewTabHost.command, "newtab-host")
    }

    func testTheAppRegistersAndTheBundleCarriesThePage() throws {
        let app = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("NewTabRegistration.start()"))
        let reg = try SourceText.code("Sources/BaneySpaces/NewTabRegistration.swift")
        XCTAssertTrue(reg.contains("bundle.pathExtension == \"app\""), "a debug build registers nothing")
        XCTAssertTrue(reg.contains("DispatchQueue.global"), "off the main thread")
        let bundle = try String(contentsOf: SourceText.root.appendingPathComponent("scripts/bundle.sh"), encoding: .utf8)
        // The page ships inside the one Polycarp extension, staged with the app's full version so it updates with it.
        XCTAssertTrue(bundle.contains(#"sh extension/scripts/stage.sh "$APP/Contents/Resources/extension" "$FULL_VERSION""#))
        XCTAssertFalse(bundle.contains("newtab-extension"), "no second copy of the page")
        let stage = try XCTUnwrap(bundle.range(of: "extension/scripts/stage.sh")).lowerBound
        let version = try XCTUnwrap(bundle.range(of: "FULL_VERSION=")).lowerBound
        let sign = try XCTUnwrap(bundle.range(of: "codesign --force")).lowerBound
        XCTAssertTrue(version < stage && stage < sign, "staged after the version is known and before signing")
    }
}
