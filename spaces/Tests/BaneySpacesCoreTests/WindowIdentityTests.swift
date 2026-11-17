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

    // MARK: The book

    /// The app quit: when it starts again, its restored windows go home.
    func testARelaunchedAppGetsItsWindowsBack() {
        var book = PlacementBook()
        book.quit(bundle: "com.apple.TextEdit", records: [record("com.apple.TextEdit", "notes.txt", order: 0, workspace: 4, at: 1000)])
        let got = book.claim([LiveWindow(id: 77, bundle: "com.apple.TextEdit", title: "notes.txt", order: 0)], started: [77: 1010])
        XCTAssertEqual(got.map(\.record.workspace), [4])
        XCTAssertTrue(book.gone.isEmpty, "a record is used once")
    }

    /// A process that was running when the record was written didn't restore anything: its new window
    /// is new, and joins the workspace you are on (ledger: "an app opened again here takes you to its old workspace").
    func testAProcessOlderThanTheRecordIsNeverMatched() {
        var book = PlacementBook(gone: [record("com.mitchellh.ghostty", "zsh", order: 0, workspace: 6, at: 1000)])
        XCTAssertTrue(book.claim([LiveWindow(id: 5, bundle: "com.mitchellh.ghostty", title: "zsh", order: 0)], started: [5: 900]).isEmpty)
        XCTAssertEqual(book.gone.count, 1)
    }

    /// Ghostty quit with one window on workspace 6 and opens a fresh one where you start it again: no title in
    /// common, so it stays with you. Order fills in only for an app that is restoring by title.
    func testARelaunchedAppsNewWindowIsNotTakenForItsOldOne() {
        var book = PlacementBook(gone: [record("com.mitchellh.ghostty", "~/Projects", order: 0, workspace: 6, at: 1000)])
        let fresh = [LiveWindow(id: 5, bundle: "com.mitchellh.ghostty", title: "~", order: 0)]
        XCTAssertTrue(book.claim(fresh, started: [5: 1100], orderNeedsTitle: true).isEmpty)
        // A browser that brought back one window by title fills in its other by order.
        book = PlacementBook(gone: [record("com.example.browser", "GitHub", order: 0, workspace: 1, at: 1000),
                                    record("com.example.browser", "Docs", order: 1, workspace: 4, at: 1000)])
        let both = [LiveWindow(id: 8, bundle: "com.example.browser", title: "GitHub", order: 0),
                    LiveWindow(id: 9, bundle: "com.example.browser", title: "New Tab", order: 1)]
        XCTAssertEqual(book.claim(both, started: [8: 1100, 9: 1100], orderNeedsTitle: true).map(\.record.workspace).sorted(), [1, 4])
    }

    func testAQuitReplacesTheAppsOlderRecordsButNoRecordsKeepThem() {
        var book = PlacementBook(gone: [record("a", "x", order: 0, workspace: 1, at: 1), record("b", "y", order: 0, workspace: 2, at: 1)])
        book.quit(bundle: "a", records: [record("a", "z", order: 0, workspace: 3, at: 5)])
        XCTAssertEqual(book.gone.map(\.title).sorted(), ["y", "z"])
        book.quit(bundle: "b", records: [])
        XCTAssertEqual(book.gone.map(\.title).sorted(), ["y", "z"], "no snapshot of it: keep what we had")
    }

    /// Polycarp restarted (an update): windows still in the same process kept their numbers and need no
    /// matching; the rest (a restart of the Mac) wait for their apps.
    func testOnStartTheLastRunsRecordsWaitUnlessTheirWindowIsStillHere() {
        var book = PlacementBook(live: [record("a", "kept", order: 0, workspace: 2, window: 40, pid: 400, at: 5000),
                                        record("a", "closed", order: 1, workspace: 3, window: 41, pid: 400, at: 5000),
                                        record("b", "rebooted", order: 0, workspace: 4, window: 50, pid: 500, at: 5000)],
                                 gone: [record("a", "old", order: 0, workspace: 9, at: 10), record("c", "waits", order: 0, workspace: 8, at: 4000)])
        book.started(alive: [40: 400, 50: 999], now: 6000)
        XCTAssertTrue(book.live.isEmpty)
        XCTAssertEqual(book.gone.map(\.title).sorted(), ["closed", "rebooted", "waits"], "a's newer records replace its old one")
    }

    func testRecordsOlderThanAWeekAreDropped() {
        var book = PlacementBook(gone: [record("a", "x", order: 0, workspace: 1, at: 0)])
        book.expire(now: PlacementBook.keepFor - 1)
        XCTAssertEqual(book.gone.count, 1)
        book.expire(now: PlacementBook.keepFor + 1)
        XCTAssertTrue(book.gone.isEmpty)
    }

    func testTheBookRoundTripsThroughItsFile() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("placements-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let book = PlacementBook(live: [record("a", "x", order: 0, workspace: 1)], gone: [record("b", "y", order: 2, workspace: 7)])
        book.save(to: url)
        XCTAssertEqual(PlacementBook.load(from: url), book)
        XCTAssertEqual(PlacementBook.load(from: url.appendingPathExtension("missing")), PlacementBook())
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
        let f = try XCTUnwrap(r.place(on: [laptop], fallback: "laptop"))
        XCTAssertTrue(laptop.visible.contains(f), "\(f) is inside the laptop's usable area")
        XCTAssertEqual(f.size, CGSize(width: 1512, height: 949), "shrunk to fit")
    }

    func testAWindowOnNoDisplayKeepsItsGlobalFrame() {
        let off = CGRect(x: 9000, y: 9000, width: 10, height: 10)
        let r = record("a", "x", order: 0, workspace: 1, frame: off)
        XCTAssertNil(r.display)
        XCTAssertEqual(r.place(on: [laptop]), off)
    }
}
