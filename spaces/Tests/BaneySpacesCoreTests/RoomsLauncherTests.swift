import XCTest
@testable import BaneySpacesCore

/// The launcher's rooms (RoomsLauncher.swift): a room's name or mark puts it first, "room:know" narrows the files
/// search, and none of it costs a keystroke anything you could feel. The menu's Rooms section is here too.
final class RoomsLauncherTests: XCTestCase {
    private var tmp: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        tmp = fm.temporaryDirectory.appendingPathComponent("rooms-launcher-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? fm.removeItem(at: tmp) }

    /// A provider over a temp root with every room and `inbox` items waiting.
    private func provider(inbox: Int = 3) throws -> (RoomsProvider, Rooms) {
        let r = Rooms(root: tmp.appendingPathComponent("BES", isDirectory: true))
        try fm.createDirectory(at: r.root.appendingPathComponent(".bes"), withIntermediateDirectories: true)
        for room in Room.allCases { try fm.createDirectory(at: r.url(room), withIntermediateDirectories: true) }
        for i in 0..<inbox { try Data("\(i)".utf8).write(to: r.url(.inbox).appendingPathComponent("item \(i).pdf")) }
        let p = RoomsProvider(home: tmp.path)
        p.refresh(r)
        return (p, r)
    }

    // MARK: Names and marks

    func testARoomsNameOrMarkListsThatRoomFirstAndOpensIt() throws {
        let (p, r) = try provider()
        for (typed, room) in [("inbox", Room.inbox), ("do", .do), (">", .do), ("keep", .keep), ("<", .keep), ("know", .know),
                              ("=", .know), ("let go", .letGo), ("x", .letGo), ("Know", .know)] {
            let rows = p.results(for: typed)
            XCTAssertEqual(rows.map(\.title), [room.name], typed)
            XCTAssertEqual(rows.first?.placement, .top, "\(typed): above apps that start the same")
            XCTAssertEqual(rows.first?.action, .open(r.url(room)), "\(typed): Return opens the room in Finder")
            XCTAssertEqual(rows.first?.section, "Rooms")
        }
        XCTAssertEqual(p.results(for: "know").first?.subtitle, "~/BES/3 Know · = · Return opens it in Finder")
        XCTAssertEqual(p.results(for: "inbox").first?.subtitle, "~/BES/0 Inbox · 3 items wait · Return opens it in Finder")
    }

    func testOtherWordsAndNumbersAreNotRooms() throws {
        let (p, _) = try provider()
        for typed in ["", "kno", "xcode", "doc", "3", "1", "keeps", "== 2", "12*7"] {
            XCTAssertEqual(p.results(for: typed), [], typed)
        }
    }

    func testTheProviderStaysQuietUntilTheRootIsSetUp() throws {
        let p = RoomsProvider(home: tmp.path)
        p.refresh(Rooms(root: tmp.appendingPathComponent("NoBES")))
        XCTAssertNil(p.rooms)
        XCTAssertEqual(p.results(for: "know"), [])
        XCTAssertEqual(p.results(for: "room:know tax"), [])
        XCTAssertNil(p.filter("room:know tax"), "no filter without rooms: the search runs as typed")
    }

    func testTheOneInboxItemIsSingular() throws {
        let (p, _) = try provider(inbox: 1)
        XCTAssertEqual(p.inbox, 1)
        XCTAssertTrue(p.results(for: "inbox")[0].subtitle.contains("1 item waits"))
    }

    // MARK: room: filters

    func testARoomFilterNarrowsTheFilesSearch() {
        XCTAssertEqual(RoomFilter.parse("room:know tax"), RoomFilter(room: .know, words: "tax"))
        XCTAssertEqual(RoomFilter.parse("tax room:know 2025"), RoomFilter(room: .know, words: "tax 2025"))
        XCTAssertEqual(RoomFilter.parse("Room:Kn syllabus"), RoomFilter(room: .know, words: "syllabus"))
        XCTAssertEqual(RoomFilter.parse("room:= syllabus"), RoomFilter(room: .know, words: "syllabus"))
        XCTAssertEqual(RoomFilter.parse("room:x"), RoomFilter(room: .letGo, words: ""))
        XCTAssertEqual(RoomFilter.parse("room:letgo old"), RoomFilter(room: .letGo, words: "old"))
        XCTAssertEqual(RoomFilter.parse("room:let-go old"), RoomFilter(room: .letGo, words: "old"))
        XCTAssertEqual(RoomFilter.parse("room:inbox scan"), RoomFilter(room: .inbox, words: "scan"))
        XCTAssertEqual(RoomFilter.parse("room:> form"), RoomFilter(room: .do, words: "form"))
        for typed in ["tax", "room:", "room:k tax", "room:foo tax", "bedroom:know", "room", "room :know"] {
            XCTAssertNil(RoomFilter.parse(typed), typed)
        }
    }

    func testAFilterStillBeingTypedOffersTheRoomsItCouldMean() throws {
        XCTAssertEqual(RoomFilter.candidates("room:"), Room.allCases)
        XCTAssertEqual(RoomFilter.candidates("room:k"), [.keep, .know])
        XCTAssertEqual(RoomFilter.candidates("room:kn tax"), [.know])
        XCTAssertEqual(RoomFilter.candidates("room:foo"), [])
        XCTAssertEqual(RoomFilter.candidates("know"), [])
        let (p, r) = try provider()
        XCTAssertEqual(p.results(for: "room:k").map(\.title), ["Keep", "Know"])
        let row = try XCTUnwrap(p.results(for: "room:know tax").first)
        XCTAssertEqual(row.action, .open(r.url(.know)))
        XCTAssertTrue(row.subtitle.hasSuffix("files below are in this room"), row.subtitle)
        XCTAssertTrue(try XCTUnwrap(p.results(for: "room:know").first).subtitle.hasSuffix("type words to find files in it"))
        XCTAssertEqual(p.filter("room:know tax"), RoomFilter(room: .know, words: "tax"))
    }

    // MARK: The app's wiring, read from its source

    func testTheLauncherAsksTheRoomsFirstAndNarrowsFilesToTheRoom() throws {
        let launcher = try SourceText.code("Sources/BaneySpaces/Launcher.swift")
        XCTAssertTrue(launcher.contains("[RoomsProvider.shared] + LauncherProviders.standard(terminal: TerminalFeature.built)"))
        XCTAssertTrue(launcher.contains("RoomsProvider.shared.refresh()"), "read once when the launcher opens")
        XCTAssertTrue(launcher.contains("FileFinder.find(words, limit: inScope == .files || within != nil ? 60 : 5, search: search, within: within)"))
        XCTAssertTrue(launcher.contains("let places = within.map { [$0] } ?? scopes(home)"))
        let app = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("rooms: roomsInbox(),"))
        XCTAssertTrue(app.contains("case .room(let room, let waiting):"))
    }

    // MARK: Speed

    /// A keystroke may take 16 ms for every row (KeyPressCheck); the rooms get a sliver of it. 2,000 queries of the
    /// kinds people type, through the provider and the filter as `rebuild` and `searchFiles` call them, p90 under
    /// `budgetMs` (spec/speed.json `launcherRooms`). Not optimized in debug, so this is the slow case.
    static let budgetMs = 0.2

    func testRoomsCostAKeystrokeAlmostNothing() throws {
        let (p, _) = try provider(inbox: 50)
        let typed = ["k", "kn", "kno", "know", "=", "x", "xc", "xcode", "room:", "room:k", "room:know", "room:know t",
                     "room:know tax 2025", "let go", "inbox", "safari", "visual studio code", "12*7", "!yt cats", "? why"]
        let queries = (0..<2_000).map { typed[$0 % typed.count] }
        for q in queries.prefix(100) { _ = p.results(for: q); _ = p.filter(q) }
        var ms: [Double] = []
        for q in queries {
            let start = DispatchTime.now().uptimeNanoseconds
            _ = p.results(for: q)
            _ = p.filter(q)
            ms.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }
        ms.sort()
        let p50 = ms[ms.count / 2], p90 = ms[Int(Double(ms.count) * 0.9) - 1]
        print(String(format: "rooms launcher: p50 %.4f ms, p90 %.4f ms, max %.4f ms over %d queries", p50, p90, ms.last!, ms.count))
        XCTAssertLessThan(p90, Self.budgetMs, "p90 \(p90) ms over \(Self.budgetMs) ms")
    }

    /// Opening the launcher reads the root and lists the Inbox once. With 500 items waiting that stays far inside
    /// the launcher's open budget (spec/speed.json `spacesTiming.kinds.launcher`, p50 60 ms).
    func testReadingTheRoomsWhenTheLauncherOpensIsCheap() throws {
        let (p, r) = try provider(inbox: 500)
        var ms: [Double] = []
        for _ in 0..<20 {
            let start = DispatchTime.now().uptimeNanoseconds
            p.refresh(r)
            ms.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }
        ms.sort()
        print(String(format: "rooms refresh: p50 %.3f ms, max %.3f ms, 500 items in the Inbox", ms[ms.count / 2], ms.last!))
        XCTAssertEqual(p.inbox, 500)
        XCTAssertLessThan(ms[ms.count / 2], 6, "a tenth of the launcher's 60 ms open budget")
    }

    func testTheBudgetIsTheOneTheSpecRecords() throws {
        let data = try Data(contentsOf: SourceText.root.appendingPathComponent("spec/speed.json"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rooms = try XCTUnwrap(json["launcherRooms"] as? [String: Any], "spec/speed.json has no launcherRooms")
        XCTAssertEqual(rooms["p90BudgetMs"] as? Double, Self.budgetMs)
    }

    // MARK: The menu

    func testTheMenuHasAShortRoomsSectionOnlyWhenThereAreRooms() {
        let rows = MenuLayout.rows(current: 1, apps: [1: ["Ghostty"]])
        let without = MenuLayout.entries(rows: rows, finished: 0, update: .check)
        XCTAssertFalse(without.contains { if case .room = $0 { true } else { false } })
        let with = MenuLayout.entries(rows: rows, rooms: 4, finished: 0, update: .check)
        XCTAssertEqual(Array(with.dropFirst(rows.count)), [.separator, .showAll, .find, .separator,
                                                          .room(.inbox, waiting: 4), .room(.do, waiting: nil), .room(.keep, waiting: nil),
                                                          .room(.know, waiting: nil), .room(.letGo, waiting: nil), .separator,
                                                          .update(.check), .settings, .quit])
        XCTAssertEqual(MenuLayout.roomTitle(.inbox, waiting: 4), "Inbox (4)")
        XCTAssertEqual(MenuLayout.roomTitle(.inbox, waiting: 0), "Inbox")
        XCTAssertEqual(MenuLayout.roomTitle(.letGo, waiting: nil), "Let Go")
    }

    /// Polycarp offers; it never asks. The rooms' code has no alert, sheet, prompt or question in it.
    func testTheRoomsNeverAskAQuestion() throws {
        for path in ["Sources/BaneySpacesCore/Rooms.swift", "Sources/BaneySpacesCore/RoomsLauncher.swift"] {
            let text = try SourceText.code(path)
            for asks in ["NSAlert", "runModal", "MenuHead.ask", "beginSheet", "?\""] {
                XCTAssertFalse(text.contains(asks), "\(path) contains \(asks)")
            }
        }
        let app = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        let start = try XCTUnwrap(app.range(of: "private func roomsInbox()"))
        let body = app[start.lowerBound...].prefix(900)
        XCTAssertFalse(body.contains("NSAlert") || body.contains("MenuHead.ask"))
    }
}
