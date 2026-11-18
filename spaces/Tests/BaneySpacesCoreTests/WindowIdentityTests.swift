import CoreGraphics
import XCTest
@testable import BaneySpacesCore

/// Windows keep their workspace and place after their app relaunches or the Mac restarts (gap G10).
/// Window numbers and process ids are new then, so `layout.json` (by number and pid) can't find them:
/// `PlacementBook` knows them by bundle id, title and creation order.
final class WindowIdentityTests: XCTestCase {
    let laptop = DisplayArea(key: "laptop", frame: CGRect(x: 0, y: 0, width: 1512, height: 982),
                             visible: CGRect(x: 0, y: 33, width: 1512, height: 949))
    let studio = DisplayArea(key: "studio", frame: CGRect(x: 1512, y: -300, width: 2560, height: 1440),
                             visible: CGRect(x: 1512, y: -267, width: 2560, height: 1407))

    private func record(_ bundle: String, _ title: String, order: Int, workspace: Int,
                        frame: CGRect = CGRect(x: 100, y: 100, width: 800, height: 600),
                        window: WindowID = 1, pid: Int32 = 10, at: Double = 1000) -> WindowRecord {
        WindowRecord(bundle: bundle, title: title, order: order, workspace: workspace, frame: frame,
                     displays: [laptop, studio], window: window, pid: pid, at: at)
    }

    func testAfterARestartEachWindowIsFoundByItsTitle() {
        let records = [record("com.apple.TextEdit", "notes.txt", order: 0, workspace: 2),
                       record("com.apple.TextEdit", "plan.txt", order: 1, workspace: 5)]
        // Reopened in the other order, with new numbers.
        let live = [LiveWindow(id: 900, bundle: "com.apple.TextEdit", title: "plan.txt", order: 0),
                    LiveWindow(id: 901, bundle: "com.apple.TextEdit", title: "notes.txt", order: 1)]
        let pairs = WindowPairing.pair(live, with: records)
        XCTAssertEqual(Set(pairs.map { "\($0.window)=\(records[$0.record].workspace) \($0.rule.rawValue)" }),
                       ["900=5 title", "901=2 title"])
    }

    func testATitleThatOnlyChangedItsMarksStillMatches() {
        let records = [record("dev.zed.Zed", "\u{25CF} main.swift \u{2014} Edited", order: 0, workspace: 3)]
        let live = [LiveWindow(id: 7, bundle: "dev.zed.Zed", title: "main.swift", order: 3)]
        XCTAssertEqual(WindowPairing.pair(live, with: records).map(\.rule), [.titleRule])
    }

    func testTitleRules() {
        XCTAssertEqual(TitleRules.key("(3) Inbox - Mail"), "inbox - mail")
        XCTAssertEqual(TitleRules.key("[12]  Inbox"), "inbox")
        XCTAssertEqual(TitleRules.key("\u{2022} Draft.md"), "draft.md")
        XCTAssertEqual(TitleRules.key("report.docx*"), "report.docx")
        XCTAssertEqual(TitleRules.key("Untitled 2 \u{2013} Edited"), "untitled 2")
        XCTAssertEqual(TitleRules.key("Notes (edited)"), "notes")
        XCTAssertEqual(TitleRules.key("(2024) Budget"), "budget", "a number in brackets in front is a count")
        XCTAssertEqual(TitleRules.key("Budget (2024)"), "budget (2024)", "at the end it is part of the name")
        XCTAssertEqual(TitleRules.key("  "), "")
    }

    /// A browser restores its windows with whatever tab is in front, so titles differ: creation order decides.
    func testWindowsWhoseTitlesChangedMatchByCreationOrder() {
        let records = [record("com.example.browser", "GitHub", order: 0, workspace: 1),
                       record("com.example.browser", "Docs", order: 1, workspace: 4)]
        let live = [LiveWindow(id: 51, bundle: "com.example.browser", title: "New Tab", order: 1),
                    LiveWindow(id: 50, bundle: "com.example.browser", title: "Inbox", order: 0)]
        let pairs = WindowPairing.pair(live, with: records)
        XCTAssertEqual(Set(pairs.map { "\($0.window)=\(records[$0.record].workspace)" }), ["50=1", "51=4"])
        XCTAssertEqual(Set(pairs.map(\.rule)), [.order])
    }

    func testATitleMatchWinsOverCreationOrder() {
        let records = [record("com.apple.TextEdit", "a.txt", order: 0, workspace: 1),
                       record("com.apple.TextEdit", "b.txt", order: 1, workspace: 2)]
        // b.txt came back first: order alone would put it on workspace 1.
        let live = [LiveWindow(id: 1, bundle: "com.apple.TextEdit", title: "b.txt", order: 0)]
        let pairs = WindowPairing.pair(live, with: records)
        XCTAssertEqual(pairs.map { records[$0.record].workspace }, [2])
    }

    func testAnotherAppsRecordNeverMatches() {
        let records = [record("com.mitchellh.ghostty", "zsh", order: 0, workspace: 6)]
        let live = [LiveWindow(id: 1, bundle: "com.apple.Terminal", title: "zsh", order: 0)]
        XCTAssertTrue(WindowPairing.pair(live, with: records).isEmpty)
    }

    func testEachRecordGoesToOneWindowTheClosestInOrder() {
        let records = [record("com.mitchellh.ghostty", "zsh", order: 0, workspace: 1),
                       record("com.mitchellh.ghostty", "zsh", order: 2, workspace: 3)]
        let live = [LiveWindow(id: 10, bundle: "com.mitchellh.ghostty", title: "zsh", order: 2),
                    LiveWindow(id: 11, bundle: "com.mitchellh.ghostty", title: "zsh", order: 3),
                    LiveWindow(id: 12, bundle: "com.mitchellh.ghostty", title: "zsh", order: 4)]
        let pairs = WindowPairing.pair(live, with: records)
        XCTAssertEqual(pairs.count, 2, "two records, two windows; the third is new")
        XCTAssertEqual(Set(pairs.map(\.record)).count, 2)
        XCTAssertEqual(pairs.first { $0.window == 10 }.map { records[$0.record].workspace }, 3, "order 2 takes the order 2 record")
    }

    /// first-F3: a window with no title yet pairs with nothing, not even by creation order.
    func testAnUntitledWindowPairsWithNothing() {
        let r = record("a", "", order: 0, workspace: 4)
        XCTAssertEqual(WindowPairing.pair([LiveWindow(id: 1, bundle: "a", title: "", order: 0)], with: [r]), [])
        XCTAssertEqual(WindowPairing.pair([LiveWindow(id: 1, bundle: "a", title: "New", order: 0)], with: [r]).map(\.rule), [.order],
                       "a titled window still pairs with an untitled record by order")
    }

    private func h(_ title: String) -> String { TitleHash.of(title, key: Data()) }

    /// second-F7: a window moved to another workspace or dragged just before its app quits hands over where it is now.
    func testAMovedRecordKeepsItsTitleAndTakesTheNewPlace() {
        let r = record("a", "x", order: 3, workspace: 1, frame: CGRect(x: 10, y: 10, width: 500, height: 400), window: 7, pid: 70)
        let m = r.moved(workspace: 3, frame: CGRect(x: 1612, y: -200, width: 500, height: 400), displays: [laptop, studio], at: 2000)
        XCTAssertEqual([m.titleHash, m.keyHash], [r.titleHash, r.keyHash])
        XCTAssertEqual(m.workspace, 3); XCTAssertEqual(m.display, "studio"); XCTAssertEqual(m.order, 3); XCTAssertEqual(m.window, 7)
        XCTAssertEqual(m.frame, CGRect(x: 100, y: 100, width: 500, height: 400))
        XCTAssertEqual(r.moved(workspace: 2, frame: nil, displays: [laptop, studio], at: 2000).frame, r.frame, "no frame read: it keeps the last")
    }

    /// second-F5: a record holds no window title, only keyed hashes, and files are written for you alone.
    func testARecordHoldsNoTitleTextAndPrivateFilesAreYoursAlone() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("records-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let key = TitleHash.key(at: folder.appendingPathComponent("title.key"))
        XCTAssertEqual(key.count, 32)
        XCTAssertEqual(TitleHash.key(at: folder.appendingPathComponent("title.key")), key, "made once")
        let secret = "Private Browsing - Statement for Account 4471-zz"
        let r = WindowRecord(bundle: "com.example.browser", title: secret, order: 0, workspace: 1, frame: nil, displays: [laptop],
                             window: 1, pid: 1, at: 1, key: key)
        let url = folder.appendingPathComponent("records.json")
        PrivateFile.write(try JSONEncoder().encode([r]), to: url)
        let text = try String(contentsOf: url, encoding: .utf8).lowercased()
        // A keyed hash is hex or base64, so a checked word made only of hex digits would match by chance (1 run in 100 for "4471").
        let words = ["private", "browsing", "statement", "account", "4471-zz"]
        for word in words { XCTAssertTrue(word.contains { !$0.isHexDigit }, "\(word) could appear in a hash") }
        for word in words { XCTAssertFalse(text.contains(word), word) }
        for file in [url, folder.appendingPathComponent("title.key")] {
            let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
            XCTAssertEqual(mode?.intValue, 0o600, file.lastPathComponent)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.appendingPathExtension("tmp").path), "no temp file left")
        let back = try JSONDecoder().decode([WindowRecord].self, from: Data(contentsOf: url))
        XCTAssertEqual(WindowPairing.pair([LiveWindow(id: 9, bundle: "com.example.browser", title: secret, order: 4, key: key)], with: back).map(\.rule), [.title])
        XCTAssertEqual(TitleHash.of("", key: key), "", "an empty title has no hash, so it pairs with nothing")
        XCTAssertNotEqual(TitleHash.of(secret, key: key), TitleHash.of(secret, key: Data()), "the hash depends on this Mac's key")
    }

    // MARK: Where it goes

    func testAWindowGoesBackToItsDisplayWhereverThatDisplayNowSits() {
        let r = record("a", "x", order: 0, workspace: 1, frame: CGRect(x: 1612, y: -200, width: 900, height: 700))
        XCTAssertEqual(r.display, "studio")
        XCTAssertEqual(r.frame, CGRect(x: 100, y: 100, width: 900, height: 700))
        var moved = studio
        moved.frame.origin = CGPoint(x: -2560, y: 0)
        moved.visible.origin = CGPoint(x: -2560, y: 33)
        XCTAssertEqual(r.place(on: [laptop, moved]), CGRect(x: -2460, y: 100, width: 900, height: 700))
    }

    func testAWindowWhoseDisplayIsGoneLandsInsideTheFallbackDisplay() throws {
        // Wholly on the studio display, and bigger than the laptop.
        let r = record("a", "x", order: 0, workspace: 1, frame: CGRect(x: 1512 + 600, y: -300 + 100, width: 1800, height: 1200))
        XCTAssertEqual(r.display, "studio")
        let f = try XCTUnwrap(r.place(on: [laptop], showing: "laptop"))
        XCTAssertTrue(laptop.visible.contains(f), "\(f) is inside the laptop's usable area")
        XCTAssertEqual(f.size, CGSize(width: 1512, height: 949), "shrunk to fit")
    }

    /// first-F4: workspace 3 was on the studio display when the record was written; now the laptop shows it. The window
    /// lands on the laptop among workspace 3's windows, not on the studio display among another workspace's. With
    /// workspace 3 hidden, its own display wins.
    func testTheDisplayShowingTheWorkspaceWinsOverTheRecordsDisplay() throws {
        let r = record("a", "x", order: 0, workspace: 3, frame: CGRect(x: 1612, y: -200, width: 900, height: 700))
        XCTAssertEqual(r.display, "studio")
        let f = try XCTUnwrap(r.place(on: [laptop, studio], showing: "laptop"))
        XCTAssertTrue(laptop.visible.contains(f), "\(f) is on the laptop")
        XCTAssertEqual(r.place(on: [laptop, studio], showing: "studio"), CGRect(x: 1612, y: -200, width: 900, height: 700))
        XCTAssertEqual(r.place(on: [laptop, studio]), CGRect(x: 1612, y: -200, width: 900, height: 700))
    }

    func testAWindowOnNoDisplayKeepsItsGlobalFrame() {
        let off = CGRect(x: 9000, y: 9000, width: 10, height: 10)
        let r = record("a", "x", order: 0, workspace: 1, frame: off)
        XCTAssertNil(r.display)
        XCTAssertEqual(r.place(on: [laptop]), off)
    }

    // MARK: Pairing speed

    /// The pairing rule written as plainly as it reads, every record for every window in each pass: what `pair` must
    /// match, pair for pair, however it is made faster.
    private func plainPair(_ live: [LiveWindow], _ records: [WindowRecord]) -> [WindowPairing.Pair] {
        var used = Set<Int>(), done = Set<WindowID>(), out: [WindowPairing.Pair] = []
        let windows = live.filter { !$0.titleHash.isEmpty }.sorted { ($0.bundle, $0.order, $0.id) < ($1.bundle, $1.order, $1.id) }
        func pass(_ rule: WindowPairing.Rule, _ fits: (LiveWindow, WindowRecord) -> Bool) {
            for w in windows where !done.contains(w.id) {
                let best = records.indices
                    .filter { !used.contains($0) && records[$0].bundle == w.bundle && fits(w, records[$0]) }
                    .min { (abs(records[$0].order - w.order), $0) < (abs(records[$1].order - w.order), $1) }
                guard let i = best else { continue }
                used.insert(i); done.insert(w.id)
                out.append(.init(window: w.id, record: i, rule: rule))
            }
        }
        pass(.title) { $0.titleHash == $1.titleHash }
        pass(.titleRule) { !$0.keyHash.isEmpty && $0.keyHash == $1.keyHash }
        pass(.order) { $0.order == $1.order }
        return out
    }

    /// 200 windows of 10 apps after a restart, against a full set of 200 records: a third by the same title, a third by
    /// the title rule (an unsaved mark), a third by creation order (a new title).
    private func twoHundred() -> (live: [LiveWindow], records: [WindowRecord]) {
        var live: [LiveWindow] = [], records: [WindowRecord] = []
        for i in 0..<200 {
            let bundle = "app\(i % 10)", order = i / 10
            records.append(record(bundle, "Document \(i)", order: order, workspace: i % 9 + 1))
            let title = [("Document \(i)"), ("\u{25CF} Document \(i)"), ("Untitled \(i)")][i % 3]
            live.append(LiveWindow(id: WindowID(5000 + i), bundle: bundle, title: title, order: order))
        }
        return (live, records)
    }

    /// Planning a restore must leave most of its 300 ms for moving windows. Measured best of five in a debug build at
    /// load 20: 3.4 ms here, 48.5 ms on 85b22797's matcher (every record of every app scanned for each window, both
    /// title keys worked out on each comparison). Budget 30 ms: room for a loaded CI runner, and a guard against a
    /// change that brings back the old scan. It does not show the speedup; the old matcher passes it too.
    func testTwoHundredWindowsPairInUnderThirtyMilliseconds() {
        let (live, records) = twoHundred()
        var best = Double.infinity
        var pairs: [WindowPairing.Pair] = []
        for _ in 0..<5 {
            let start = ProcessInfo.processInfo.systemUptime
            pairs = WindowPairing.pair(live, with: records)
            best = min(best, (ProcessInfo.processInfo.systemUptime - start) * 1000)
        }
        print("pairing 200 windows: best of 5 \(String(format: "%.1f", best)) ms")
        XCTAssertEqual(pairs.count, 200)
        XCTAssertEqual(Dictionary(grouping: pairs, by: \.rule).mapValues(\.count), [.title: 67, .titleRule: 67, .order: 66])
        XCTAssertLessThan(best, 30, "pairing 200 windows took \(best) ms")
    }

    /// The fast matcher pairs exactly as the plain rule does, ties included: generic titles shared by several windows,
    /// records closer and farther in creation order, windows with no record and records with no window.
    func testPairingMatchesThePlainRulePairForPair() {
        var seed: UInt64 = 0x9E3779B97F4A7C15
        func next(_ n: Int) -> Int { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Int((seed >> 33) % UInt64(n)) }
        let titles = ["~", "~", "Inbox", "(3) Inbox", "\u{25CF} notes.txt", "notes.txt", "", "plan.txt Edited", "plan.txt"]
        for round in 0..<40 {
            var records: [WindowRecord] = [], live: [LiveWindow] = []
            for _ in 0..<(5 + next(30)) {
                records.append(record("app\(next(3))", titles[next(titles.count)], order: next(6), workspace: 1 + next(9)))
            }
            for i in 0..<(5 + next(30)) {
                live.append(LiveWindow(id: WindowID(100 + i), bundle: "app\(next(3))", title: titles[next(titles.count)], order: next(6)))
            }
            XCTAssertEqual(WindowPairing.pair(live, with: records), plainPair(live, records), "round \(round)")
        }
        let (live, records) = twoHundred()
        XCTAssertEqual(WindowPairing.pair(live, with: records), plainPair(live, records))
    }
}
