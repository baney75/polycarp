import XCTest
@testable import BaneySpacesCore

/// The Baney Extended System's rooms (Rooms.swift, docs/rooms.md): names, marks, filing with bes's clash rule, and a
/// journal `bes undo` reads. Every test works in its own temp folder; none touches a real home folder.
final class RoomsTests: XCTestCase {
    private var tmp: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        tmp = fm.temporaryDirectory.appendingPathComponent("rooms-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? fm.removeItem(at: tmp) }

    // MARK: Helpers

    /// A root with the five rooms and `.bes/`, as `bes init` makes it.
    private func makeRoot(_ name: String = "BES", rooms: [Room] = Room.allCases) throws -> Rooms {
        let r = Rooms(root: tmp.appendingPathComponent(name, isDirectory: true))
        try fm.createDirectory(at: r.root.appendingPathComponent(".bes"), withIntermediateDirectories: true)
        for room in rooms { try fm.createDirectory(at: r.url(room), withIntermediateDirectories: true) }
        return r
    }

    @discardableResult
    private func write(_ text: String, _ path: URL) throws -> URL {
        try fm.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: path)
        return path
    }

    private func read(_ url: URL) -> String? { (try? Data(contentsOf: url)).flatMap { String(data: $0, encoding: .utf8) } }

    private func journalLines(_ r: Rooms) -> [String] {
        (read(r.journal) ?? "").split(separator: "\n").map(String.init)
    }

    private func names(_ dir: URL) -> [String] { ((try? fm.contentsOfDirectory(atPath: dir.path)) ?? []).filter { !$0.hasPrefix(".") }.sorted() }

    /// Fixed ids, so journal lines can be compared whole.
    private func ids() -> () -> String {
        var n = 0
        return { n += 1; return String(format: "id%010d", n) }
    }

    // MARK: Rooms and their names

    func testTheFiveRoomsAreBesFoldersWithTheirMarks() {
        XCTAssertEqual(Room.allCases.map(\.folder), ["0 Inbox", "1 Do", "2 Keep", "3 Know", "4 Let Go"])
        XCTAssertEqual(Room.allCases.map(\.mark), [nil, ">", "<", "=", "x"])
        XCTAssertEqual(Room.allCases.map(\.id), ["inbox", "do", "keep", "know", "letgo"])
    }

    func testARoomIsNamedByNameFolderOrMarkButNeverByABareNumber() {
        for (typed, room) in [("know", Room.know), ("Know", .know), (" KNOW ", .know), ("=", .know), (">", .do), ("do", .do),
                              ("<", .keep), ("keep", .keep), ("x", .letGo), ("X", .letGo), ("let go", .letGo), ("letgo", .letGo),
                              ("Let-Go", .letGo), ("inbox", .inbox), ("3 know", .know), ("0 Inbox", .inbox)] {
            XCTAssertEqual(Room.named(typed), room, typed)
        }
        for typed in ["", "3", "0", "kno", "doo", "k", "xc", "==", "know it"] {
            XCTAssertNil(Room.named(typed), typed)
        }
        XCTAssertEqual(Room.named("kn", prefix: true), .know)
        XCTAssertEqual(Room.named("l", prefix: true), .letGo)
        XCTAssertNil(Room.named("k", prefix: true), "Keep or Know")
    }

    func testTheRootComesFromSurfacesWithTildeAtHome() {
        XCTAssertEqual(Rooms(path: "~/BES", home: "/Users/me").root.path, "/Users/me/BES")
        XCTAssertEqual(Rooms(path: "~", home: "/Users/me").root.path, "/Users/me")
        XCTAssertEqual(Rooms(path: "/Volumes/Drive/BES/", home: "/Users/me").root.path, "/Volumes/Drive/BES")
        XCTAssertEqual(Rooms(path: "/Volumes/Drive/BES", home: "/Users/me").url(.letGo).path, "/Volumes/Drive/BES/4 Let Go")
        XCTAssertEqual(Rooms(path: "~/BES", home: "/Users/me").shown(.know, home: "/Users/me"), "~/BES/3 Know")
        XCTAssertEqual(Surfaces.defaults.rooms.root, "~/BES")
        XCTAssertTrue(Surfaces.defaults.rooms.menu)
    }

    func testARootIsSetUpOnlyWithItsMachineFolderOrAnInbox() throws {
        let none = Rooms(root: tmp.appendingPathComponent("Nothing"))
        XCTAssertFalse(none.exists())
        try fm.createDirectory(at: none.root, withIntermediateDirectories: true)
        XCTAssertFalse(none.exists(), "an empty folder isn't a root")
        try fm.createDirectory(at: none.url(.inbox), withIntermediateDirectories: true)
        XCTAssertTrue(none.exists())
        XCTAssertTrue(try makeRoot("Other", rooms: []).exists(), ".bes alone, as bes checks")
    }

    func testTheInboxCountLeavesHiddenFilesOut() throws {
        let r = try makeRoot()
        try write("a", r.url(.inbox).appendingPathComponent("a.pdf"))
        try write("b", r.url(.inbox).appendingPathComponent("b.txt"))
        try write("", r.url(.inbox).appendingPathComponent(".DS_Store"))
        try fm.createDirectory(at: r.url(.inbox).appendingPathComponent("Scans"), withIntermediateDirectories: true)
        XCTAssertEqual(r.count(.inbox), 3)
        XCTAssertEqual(r.count(.know), 0)
    }

    // MARK: Filing

    func testFilingMovesKeepsTheNameAndWritesOneBatch() throws {
        let r = try makeRoot()
        let a = try write("tax", tmp.appendingPathComponent("Downloads/2025 Tax Return.pdf"))
        let b = try write("syllabus", r.url(.inbox).appendingPathComponent("Syllabus.pdf"))
        let filing = r.file([a, b], into: .keep)
        XCTAssertEqual(filing.failed, [])
        XCTAssertEqual(filing.moved.count, 2)
        XCTAssertFalse(fm.fileExists(atPath: a.path))
        XCTAssertFalse(fm.fileExists(atPath: b.path))
        XCTAssertEqual(names(r.url(.keep)), ["2025 Tax Return.pdf", "Syllabus.pdf"])
        XCTAssertEqual(read(r.url(.keep).appendingPathComponent("2025 Tax Return.pdf")), "tax")
        let entries = try journalLines(r).map { try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]) }
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(Set(entries.map { $0["batch"] as? String }), [filing.batch], "one drop, one batch: bes undo reverses it whole")
        XCTAssertEqual(entries.map { $0["op"] as? String }, ["move", "move"])
        XCTAssertEqual(entries.map { $0["rule"] as? String }, ["polycarp:keep", "polycarp:keep"])
        XCTAssertEqual(entries[1]["from"] as? String, "0 Inbox/Syllabus.pdf", "inside the root: relative, so the drive can mount anywhere")
        XCTAssertEqual(entries[1]["to"] as? String, "2 Keep/Syllabus.pdf")
        XCTAssertTrue((entries[0]["from"] as? String)?.hasPrefix("/") ?? false, "outside the root: absolute")
        XCTAssertTrue((entries[0]["from"] as? String)?.hasSuffix("/Downloads/2025 Tax Return.pdf") ?? false)
        XCTAssertEqual(filing.summary(.keep), "Filed 2 in Keep")
    }

    func testAJournalLineIsWrittenAsBesWritesIt() throws {
        let r = try makeRoot("BES", rooms: [.inbox])
        let a = try write("x", tmp.appendingPathComponent("In/Café \"notes\".md"))
        let when = Date(timeIntervalSince1970: 1_795_000_000)
        let filing = r.file([a], into: .know, now: { when }, newID: ids())
        XCTAssertEqual(filing.batch, "id0000000001")
        let src = Rooms.resolved(a).path
        let ts = JournalEntry.time(when)
        XCTAssertEqual(journalLines(r), [
            "{\"id\": \"id0000000002\", \"batch\": \"id0000000001\", \"ts\": \"\(ts)\", \"op\": \"move\", "
                + "\"from\": \"\(src.replacingOccurrences(of: "\"", with: "\\\""))\", \"to\": \"3 Know/Café \\\"notes\\\".md\", "
                + "\"rule\": \"polycarp:know\", \"made_dirs\": [\"3 Know\"]}",
        ], "the Know folder didn't exist, so it is made and recorded for undo")
    }

    func testTimesAndStringsMatchPythonsEncoder() {
        let when = Date(timeIntervalSince1970: 1_795_000_000) // 2026-11-18 11:06:40 UTC
        XCTAssertEqual(JournalEntry.time(when, zone: TimeZone(identifier: "UTC")!), "2026-11-18T11:06:40+00:00", "+00:00, never Z, as isoformat")
        XCTAssertEqual(JournalEntry.time(when, zone: TimeZone(identifier: "America/Chicago")!), "2026-11-18T05:06:40-06:00")
        XCTAssertEqual(JournalEntry.quote("a\"b\\c"), "\"a\\\"b\\\\c\"")
        XCTAssertEqual(JournalEntry.quote("é/\u{2028}\u{7f}"), "\"é/\u{2028}\u{7f}\"", "ensure_ascii=False: only quote, backslash and controls escape")
        XCTAssertEqual(JournalEntry.quote("\n\r\t\u{08}\u{0C}\u{01}"), "\"\\n\\r\\t\\b\\f\\u0001\"")
        XCTAssertEqual(Rooms.newID().count, 12)
        XCTAssertTrue(Rooms.newID().allSatisfy { "0123456789abcdef".contains($0) })
    }

    func testANameClashGetsANumberAndNothingIsOverwritten() throws {
        let r = try makeRoot()
        try write("old", r.url(.know).appendingPathComponent("Paper.pdf"))
        try write("older", r.url(.know).appendingPathComponent("Paper (2).pdf"))
        let a = try write("new", tmp.appendingPathComponent("A/Paper.pdf"))
        let b = try write("newer", tmp.appendingPathComponent("B/Paper.pdf"))
        let filing = r.file([a, b], into: .know)
        XCTAssertEqual(filing.moved.map(\.to.lastPathComponent), ["Paper (3).pdf", "Paper (4).pdf"])
        XCTAssertEqual(read(r.url(.know).appendingPathComponent("Paper.pdf")), "old")
        XCTAssertEqual(read(r.url(.know).appendingPathComponent("Paper (2).pdf")), "older")
        XCTAssertEqual(read(r.url(.know).appendingPathComponent("Paper (3).pdf")), "new")
        XCTAssertEqual(read(r.url(.know).appendingPathComponent("Paper (4).pdf")), "newer")
    }

    func testTheClashRuleIsBesUniquePath() throws {
        let dir = tmp.appendingPathComponent("Room", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        func unique(_ name: String) -> String { Rooms.uniquePath(dir.appendingPathComponent(name), fm: fm).lastPathComponent }
        XCTAssertEqual(unique("free.txt"), "free.txt")
        try write("", dir.appendingPathComponent("a.tar.gz"))
        XCTAssertEqual(unique("a.tar.gz"), "a.tar (2).gz", "the last extension only, as pathlib")
        try write("", dir.appendingPathComponent("x (2).pdf"))
        XCTAssertEqual(unique("x (2).pdf"), "x (2) (2).pdf", "a counter in the name is part of the stem")
        try write("", dir.appendingPathComponent(".bashrc"))
        XCTAssertEqual(unique(".bashrc"), ".bashrc (2)")
        try fm.createDirectory(at: dir.appendingPathComponent("Project"), withIntermediateDirectories: true)
        XCTAssertEqual(unique("Project"), "Project (2)")
        try fm.createDirectory(at: dir.appendingPathComponent("Six Actual.v2"), withIntermediateDirectories: true)
        XCTAssertEqual(unique("Six Actual.v2"), "Six Actual (2).v2", "a folder with an extension splits like a file, as bes does")
        try fm.createSymbolicLink(atPath: dir.appendingPathComponent("gone.txt").path, withDestinationPath: "/nonexistent/target")
        XCTAssertEqual(unique("gone.txt"), "gone (2).txt", "a broken link still holds its name")
        XCTAssertEqual(Rooms.uniquePath(dir.appendingPathComponent("free.txt"), reserved: [dir.appendingPathComponent("free.txt").path], fm: fm)
                        .lastPathComponent, "free (2).txt", "a name this batch already gave is taken")
        for (name, stem, suffix) in [("a.tar.gz", "a.tar", ".gz"), ("notes", "notes", ""), (".bashrc", ".bashrc", ""), ("..bar", "..bar", ""),
                                     (".a.b", ".a", ".b"), ("a..b", "a.", ".b"), ("foo.", "foo", "."), ("...", "...", "")] {
            XCTAssertTrue(Rooms.split(name) == (stem, suffix), "\(name): \(Rooms.split(name))")
        }
    }

    func testFoldersMoveWholeAndAMissingRoomIsMadeAndRecorded() throws {
        let r = try makeRoot("BES", rooms: [.inbox])
        let folder = tmp.appendingPathComponent("Six Actual", isDirectory: true)
        try write("ch1", folder.appendingPathComponent("Chapter 1.md"))
        let filing = r.file([folder], into: .do)
        XCTAssertEqual(filing.moved.count, 1)
        XCTAssertEqual(read(r.url(.do).appendingPathComponent("Six Actual/Chapter 1.md")), "ch1")
        XCTAssertTrue(journalLines(r)[0].hasSuffix("\"made_dirs\": [\"1 Do\"]}"))
    }

    func testWhatIsAlreadyInTheRoomOrIsARoomStaysPut() throws {
        let r = try makeRoot()
        let here = try write("k", r.url(.keep).appendingPathComponent("Letter.pdf"))
        let filing = r.file([here, r.url(.do), r.root, tmp.appendingPathComponent("missing.pdf")], into: .keep)
        XCTAssertEqual(filing.moved, [])
        XCTAssertEqual(filing.skipped, [here])
        XCTAssertEqual(filing.failed.map(\.reason), ["it is a room or holds the rooms", "it is a room or holds the rooms", "it is no longer there"])
        XCTAssertTrue(fm.fileExists(atPath: here.path))
        XCTAssertTrue(fm.fileExists(atPath: r.url(.do).path))
        XCTAssertEqual(journalLines(r), [], "nothing moved, nothing journaled")
        XCTAssertEqual(filing.summary(.keep), "Nothing filed in Keep, 1 already there, 3 could not move")
    }

    func testAJournalThatCannotBeWrittenMovesNothing() throws {
        let root = tmp.appendingPathComponent("Locked", isDirectory: true)
        try fm.createDirectory(at: root.appendingPathComponent("0 Inbox"), withIntermediateDirectories: true)
        try write("not a folder", root.appendingPathComponent(".bes"))
        let a = try write("a", tmp.appendingPathComponent("a.txt"))
        let filing = Rooms(root: root).file([a], into: .know)
        XCTAssertEqual(filing.moved, [])
        XCTAssertEqual(filing.failed.count, 1)
        XCTAssertTrue(fm.fileExists(atPath: a.path), "never moved where bes undo couldn't see it")
    }

    /// bes never deletes, and neither does filing: the only removal is of an empty folder it made itself.
    func testFilingNeverDeletes() throws {
        let code = try SourceText.code("Sources/BaneySpacesCore/Rooms.swift")
        for call in ["removeItem", "trashItem", "unlink(", "remove("] {
            XCTAssertFalse(code.contains(call), "Rooms.swift calls \(call)")
        }
        let full = tmp.appendingPathComponent("Full", isDirectory: true)
        try write("keep me", full.appendingPathComponent("a.txt"))
        Rooms.removeIfEmpty(full)
        XCTAssertEqual(read(full.appendingPathComponent("a.txt")), "keep me")
        let empty = tmp.appendingPathComponent("Empty", isDirectory: true)
        try fm.createDirectory(at: empty, withIntermediateDirectories: true)
        Rooms.removeIfEmpty(empty)
        XCTAssertFalse(fm.fileExists(atPath: empty.path))
    }

    // MARK: bes undo reads Polycarp's journal

    /// The real `bes` (github.com/baney75/baney-extended-system) undoes a Polycarp drop. It runs from `$BES_REPO`, or
    /// ~/Projects/baney-extended-system; without either it is skipped and says so.
    func testBesUndoReversesAPolycarpDrop() throws {
        let env = ProcessInfo.processInfo.environment
        let repo = env["BES_REPO"] ?? NSHomeDirectory() + "/Projects/baney-extended-system"
        guard fm.fileExists(atPath: repo + "/bes/undo.py") else {
            throw XCTSkip("no bes checkout at \(repo); set BES_REPO to run the back-check")
        }
        let r = try makeRoot("BES", rooms: [.inbox, .keep])
        // An earlier batch that must survive the undo of the last one.
        let early = try write("early", tmp.appendingPathComponent("Downloads/early.txt"))
        XCTAssertEqual(r.file([early], into: .keep).moved.count, 1)
        try write("old", r.url(.know).appendingPathComponent("Paper.pdf"))
        let paper = try write("new", tmp.appendingPathComponent("Downloads/Paper.pdf"))
        let scan = try write("scan", r.url(.inbox).appendingPathComponent("Scan 1650.pdf"))
        let folder = tmp.appendingPathComponent("Downloads/Six Actual", isDirectory: true)
        try write("ch1", folder.appendingPathComponent("Chapter 1.md"))
        let odd = try write("odd", tmp.appendingPathComponent("Downloads/Café \"quoted\" ünïcode.txt"))
        let know = r.file([paper, scan, odd], into: .know)
        let drop = r.file([folder], into: .do)
        XCTAssertEqual(know.moved.count, 3)
        XCTAssertEqual(drop.moved.count, 1)

        func bes(_ args: [String]) throws -> (Int32, String) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["python3", "-m", "bes"] + args
            p.currentDirectoryURL = URL(fileURLWithPath: repo)
            var e = env
            e["PYTHONDONTWRITEBYTECODE"] = "1"
            e["BES_CONFIG"] = tmp.appendingPathComponent("no-config.toml").path
            p.environment = e
            let out = Pipe()
            p.standardOutput = out
            p.standardError = out
            try p.run()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return (p.terminationStatus, String(decoding: data, as: UTF8.self))
        }

        // No count: the last batch, the folder dropped on Do, and the Do folder the drop made.
        var (status, said) = try bes(["undo", r.root.path])
        XCTAssertEqual(status, 0, said)
        XCTAssertTrue(said.contains("Undid 1 moves."), said)
        XCTAssertEqual(read(folder.appendingPathComponent("Chapter 1.md")), "ch1")
        XCTAssertFalse(fm.fileExists(atPath: r.url(.do).path), "bes removed the empty room folder the drop made")

        (status, said) = try bes(["undo", r.root.path, "--last", "3"])
        XCTAssertEqual(status, 0, said)
        XCTAssertTrue(said.contains("Undid 3 moves."), said)
        XCTAssertEqual(read(paper), "new")
        XCTAssertEqual(read(scan), "scan", "back in the Inbox, by its path relative to the root")
        XCTAssertEqual(read(odd), "odd")
        XCTAssertEqual(read(r.url(.know).appendingPathComponent("Paper.pdf")), "old", "the clash's original is untouched")
        XCTAssertEqual(names(r.url(.know)), ["Paper.pdf"])
        XCTAssertEqual(names(r.url(.keep)), ["early.txt"], "the earlier batch stays")
        let undos = journalLines(r).filter { $0.contains("\"op\": \"undo\"") }
        XCTAssertEqual(undos.count, 4, "bes journals each undo in the same file")
    }
}
