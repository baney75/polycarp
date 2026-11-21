import Darwin
import XCTest
@testable import BaneySpacesCore

/// The new tab page's native messaging host (docs/newtab.md): framing, the three requests, the manifest and where it goes.
final class NewTabHostTests: XCTestCase {
    private var folder: URL!
    private var purposes: PurposeStore!
    private var ledger: DayLedgerStore!
    private let now = PurposeFixture.Now(PurposeFixture.at(2026, 11, 21, 9))
    private var current = 2

    override func setUp() {
        folder = PurposeFixture.folder()
        purposes = PurposeStore(folder: folder, clock: PurposeFixture.chicago, now: { [now] in now.date }, center: NotificationCenter())
        ledger = DayLedgerStore(folder: folder, clock: PurposeFixture.chicago, center: NotificationCenter())
    }

    override func tearDown() {
        purposes.flush()
        ledger.flush()
        try? FileManager.default.removeItem(at: folder)
    }

    /// The app as the socket would answer: the same parse and answer `PurposeKeeper` runs.
    private func source(_ surfaces: Surfaces = .defaults, running: Bool = true) -> NewTabHost.Source {
        NewTabHost.Source(surfaces: { surfaces }, purpose: { [self] text, args in
            guard running else { return nil }
            return PurposeAPI.answer(PurposeAPI.ask(text: text, args: args), purposes: purposes, ledger: ledger, current: current,
                                     now: now.date)
        }, now: { [now] in now.date }, timeZone: PurposeFixture.chicago.timeZone)
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

    func testPageWithVerseAndChips() throws {
        try purposes.setPurpose("Write the book", for: 3)
        try purposes.setPurpose("Pray", for: 2)
        try purposes.setOneThing("Finish chapter one", workspace: 2)
        var chipsOn = Surfaces.defaults
        chipsOn.newtab.chips = true
        let r = try ask(#"{"op":"page"}"#, source(chipsOn))
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["question"] as? String, Surfaces.defaults.newtab.question)
        XCTAssertEqual(r["searchURL"] as? String, "https://duckduckgo.com/?q={query}")
        let day = try XCTUnwrap(Verses.pick(.daily, at: now.date, timeZone: PurposeFixture.chicago.timeZone))
        let verse = try XCTUnwrap(r["verse"] as? [String: String])
        XCTAssertEqual(verse, ["text": day.text, "ref": day.ref])
        XCTAssertEqual(r["workspace"] as? Int, 2)
        XCTAssertEqual(r["purpose"] as? String, "Pray")
        XCTAssertEqual(r["oneThing"] as? String, "Finish chapter one")
        let chips = try XCTUnwrap(r["chips"] as? [[String: Any]])
        XCTAssertEqual(chips.map { $0["workspace"] as? Int }, [2, 3], "in number order")
        XCTAssertEqual(chips.map { $0["purpose"] as? String }, ["Pray", "Write the book"])
    }

    func testPageWithVerseAndChipsOff() throws {
        try purposes.setPurpose("Pray", for: 2)
        var s = Surfaces.defaults
        s.newtab.verse = false
        s.newtab.chips = false
        s.newtab.question = "What matters now?"
        s.newtab.searchURL = "https://search.example/?q={query}"
        let reply = NewTabHost.answer(Data(#"{"op":"page"}"#.utf8), source: source(s))
        let text = String(decoding: reply, as: UTF8.self)
        XCTAssertTrue(text.contains(#""verse":null"#), "a verse switched off is null, not missing: \(text)")
        let r = try ask(#"{"op":"page"}"#, source(s))
        XCTAssertTrue(r["verse"] is NSNull)
        XCTAssertEqual((r["chips"] as? [Any])?.count, 0)
        XCTAssertEqual(r["question"] as? String, "What matters now?")
        XCTAssertEqual(r["searchURL"] as? String, "https://search.example/?q={query}")
        XCTAssertEqual(r["purpose"] as? String, "Pray")
        XCTAssertTrue(r["oneThing"] is NSNull)
    }

    func testPageWithTheAppUnreachable() throws {
        try purposes.setPurpose("Pray", for: 2)
        let r = try ask(#"{"op":"page"}"#, source(running: false))
        XCTAssertEqual(r["ok"] as? Bool, true)
        for key in ["workspace", "purpose", "oneThing"] { XCTAssertTrue(r[key] is NSNull, "\(key) is null") }
        XCTAssertNotNil(r["verse"] as? [String: String], "surfaces.json and the verse need no app")
        XCTAssertEqual((r["chips"] as? [Any])?.count, 0)
    }

    // MARK: name

    func testNameSetsTheWorkspaceYouAreOn() throws {
        current = 4
        let r = try ask(#"{"op":"name","text":"  Read   slowly "}"#, source())
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["workspace"] as? Int, 4)
        XCTAssertEqual(r["purpose"] as? String, "Read slowly")
        XCTAssertEqual(purposes.snapshot.purpose(of: 4), "Read slowly")
    }

    func testNameOverSixtyCharactersIsRefused() throws {
        let long = String(repeating: "a", count: 61)
        let r = try ask(#"{"op":"name","text":"\#(long)"}"#, source())
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertEqual(r["error"] as? String, "that is 61 characters; keep it to 60")
        XCTAssertNil(purposes.snapshot.purpose(of: current))
    }

    func testNameRefusesBlankTextMissingTextAndNoApp() throws {
        XCTAssertEqual(try ask(#"{"op":"name","text":"   "}"#, source())["ok"] as? Bool, false)
        XCTAssertEqual(try ask(#"{"op":"name"}"#, source())["ok"] as? Bool, false)
        let r = try ask(#"{"op":"name","text":"Pray"}"#, source(running: false))
        XCTAssertEqual(r["error"] as? String, NewTabHost.notRunning)
    }

    // MARK: go, unknown, bad JSON

    func testGoOpensTheSwitchLinkForThatWorkspace() throws {
        var opened: [URL] = []
        var s = source()
        s.open = { opened.append($0); return true }
        let r = try ask(#"{"op":"go","workspace":3}"#, s)
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["workspace"] as? Int, 3)
        XCTAssertEqual(opened.map(\.absoluteString), ["polycarp://switch/3"])
        for bad in [#"{"op":"go","workspace":0}"#, #"{"op":"go","workspace":10}"#, #"{"op":"go"}"#] {
            XCTAssertEqual(try ask(bad, s)["ok"] as? Bool, false, bad)
        }
        XCTAssertEqual(opened.count, 1, "a bad workspace opens nothing")
        s.open = { _ in false }
        XCTAssertEqual(try ask(#"{"op":"go","workspace":3}"#, s)["error"] as? String, NewTabHost.noSwitch)
    }

    func testUnknownOpAndBadJSON() throws {
        for request in [#"{"op":"fly"}"#, #"{"text":"x"}"#, "not json", "[1,2]", ""] {
            let r = try ask(request, source())
            XCTAssertEqual(r["ok"] as? Bool, false, request)
            XCTAssertFalse((r["error"] as? String ?? "").isEmpty, request)
        }
    }

    func testErrorsHaveNoDashes() {
        let texts = [NewTabHost.notRunning, NewTabHost.noSwitch, "type a few words to name this workspace"]
        for t in texts { XCTAssertFalse(t.contains("\u{2014}") || t.contains("\u{2013}") || t.contains(" - "), t) }
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
        XCTAssertTrue(bundle.contains(#"cp -R extension/newtab "$APP/Contents/Resources/newtab-extension""#))
        XCTAssertTrue(bundle.contains("[ -d extension/newtab ]"))
    }
}
