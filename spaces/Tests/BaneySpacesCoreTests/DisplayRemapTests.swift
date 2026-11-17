import CoreGraphics
import XCTest
@testable import BaneySpacesCore

/// Undock and redock with a fake display set: a real unplug can't be scripted, so this is the harness seam. On
/// unplug every window of the lost display lands on one still here, keeping its workspace; on replug of the same
/// display (by UUID) it goes back to its exact frame there.
final class DisplayRemapTests: XCTestCase {
    let laptop = DisplayArea(key: "laptop", frame: CGRect(x: 0, y: 0, width: 1512, height: 982),
                             visible: CGRect(x: 0, y: 33, width: 1512, height: 949))
    let studio = DisplayArea(key: "studio", frame: CGRect(x: 1512, y: -300, width: 2560, height: 1440),
                             visible: CGRect(x: 1512, y: -267, width: 2560, height: 1407))
    let sidecar = DisplayArea(key: "sidecar", frame: CGRect(x: -1366, y: 0, width: 1366, height: 1024),
                              visible: CGRect(x: -1366, y: 24, width: 1366, height: 1000))

    /// Windows 1 and 2 on the studio display (workspaces 3 and 5), 3 on the laptop (workspace 1).
    let frames: [WindowID: CGRect] = [1: CGRect(x: 1600, y: -200, width: 1200, height: 900),
                                      2: CGRect(x: 3000, y: 500, width: 1000, height: 600),
                                      3: CGRect(x: 100, y: 100, width: 800, height: 600)]
    let workspace: [WindowID: Int] = [1: 3, 2: 5, 3: 1]

    private func onScreen(_ f: CGRect, _ displays: [DisplayArea]) -> Bool {
        displays.contains { $0.visible.contains(f) }
    }

    func testUnpluggedWindowsLandInsideADisplayStillHereAndKeepTheirWorkspace() {
        var stash = DisplayStash()
        let moves = DisplayRemap.unplug(lost: [studio], remaining: [laptop], frames: frames, workspace: workspace,
                                        showing: ["laptop": 1], stash: &stash, now: 0)
        XCTAssertEqual(moves.map(\.window), [1, 2], "the laptop's own window stays")
        for m in moves { XCTAssertTrue(onScreen(m.frame, [laptop]), "window \(m.window) at \(m.frame) is on the laptop") }
        XCTAssertEqual(stash.entries[1]?.workspace, 3)
        XCTAssertEqual(stash.entries[2]?.workspace, 5)
        XCTAssertEqual(stash.entries[1]?.frame, CGRect(x: 88, y: 100, width: 1200, height: 900), "relative to the studio's corner")
    }

    func testAnUnpluggedWindowGoesToTheDisplayShowingItsWorkspace() {
        var stash = DisplayStash()
        let moves = DisplayRemap.unplug(lost: [studio], remaining: [laptop, sidecar], frames: frames, workspace: workspace,
                                        showing: ["laptop": 1, "sidecar": 5], stash: &stash, now: 0)
        let by = Dictionary(uniqueKeysWithValues: moves.map { ($0.window, $0.frame) })
        XCTAssertTrue(onScreen(by[2]!, [sidecar]), "workspace 5 is on the iPad, so its window goes there")
        XCTAssertTrue(onScreen(by[1]!, [laptop]), "nobody shows workspace 3: the main display")
    }

    /// Undock, then redock the same display (here moved to the other side): every window is back within 2 px.
    func testReplugPutsEveryWindowBackExactlyEvenWhereTheDisplayNowSits() {
        var stash = DisplayStash()
        _ = DisplayRemap.unplug(lost: [studio], remaining: [laptop], frames: frames, workspace: workspace,
                                showing: ["laptop": 1], stash: &stash, now: 0)
        let back = DisplayRemap.replug(studio, workspace: workspace, stash: &stash)
        XCTAssertEqual(back, [.init(window: 1, frame: frames[1]!), .init(window: 2, frame: frames[2]!)])
        XCTAssertTrue(stash.entries.isEmpty)

        var left = studio
        left.frame.origin = CGPoint(x: -2560, y: 0)
        _ = DisplayRemap.unplug(lost: [studio], remaining: [laptop], frames: frames, workspace: workspace,
                                showing: ["laptop": 1], stash: &stash, now: 0)
        let moved = DisplayRemap.replug(left, workspace: workspace, stash: &stash)
        XCTAssertEqual(moved.first { $0.window == 1 }?.frame, CGRect(x: -2472, y: 100, width: 1200, height: 900))
    }

    func testAWindowYouMovedToAnotherWorkspaceMeanwhileStaysPut() {
        var stash = DisplayStash()
        _ = DisplayRemap.unplug(lost: [studio], remaining: [laptop], frames: frames, workspace: workspace,
                                showing: ["laptop": 1], stash: &stash, now: 0)
        var now = workspace
        now[1] = 2
        XCTAssertEqual(DisplayRemap.replug(studio, workspace: now, stash: &stash).map(\.window), [2])
        XCTAssertTrue(stash.entries.isEmpty, "its entry is spent either way")
    }

    func testAnotherDisplaysReturnLeavesThisOnesEntries() {
        var stash = DisplayStash()
        _ = DisplayRemap.unplug(lost: [studio, sidecar], remaining: [laptop],
                                frames: frames.merging([4: CGRect(x: -1000, y: 100, width: 600, height: 400)]) { a, _ in a },
                                workspace: workspace.merging([4: 7]) { a, _ in a }, showing: ["laptop": 1], stash: &stash, now: 0)
        XCTAssertEqual(DisplayRemap.replug(sidecar, workspace: workspace.merging([4: 7]) { a, _ in a }, stash: &stash).map(\.window), [4])
        XCTAssertEqual(Set(stash.entries.keys), [1, 2], "the studio's windows still wait for it")
    }

    func testOldOrGoneWindowsLoseTheirEntries() {
        var stash = DisplayStash(entries: [1: .init(display: "studio", frame: .zero, workspace: 1, at: 0),
                                           2: .init(display: "studio", frame: .zero, workspace: 1, at: 100)])
        stash.prune(alive: [1, 2], now: DisplayStash.keepFor + 50)
        XCTAssertEqual(Set(stash.entries.keys), [2])
        stash.prune(alive: [], now: 0)
        XCTAssertTrue(stash.entries.isEmpty)
    }

    /// None off screen, none lost: windows anywhere on a lost display, of any size, all land inside the one left.
    func testNoWindowEndsOffScreenWhateverItsFrame() {
        var rng = SystemRandomNumberGenerator()
        var frames: [WindowID: CGRect] = [:], ws: [WindowID: Int] = [:]
        for id in WindowID(1)...300 {
            let w = CGFloat.random(in: 50...3200, using: &rng), h = CGFloat.random(in: 50...1800, using: &rng)
            let x = CGFloat.random(in: studio.frame.minX...(studio.frame.maxX - 40), using: &rng)
            let y = CGFloat.random(in: studio.frame.minY...(studio.frame.maxY - 40), using: &rng)
            frames[id] = CGRect(x: x, y: y, width: w, height: h)
            ws[id] = Int(id % 9) + 1
        }
        var stash = DisplayStash()
        let start = ProcessInfo.processInfo.systemUptime
        let moves = DisplayRemap.unplug(lost: [studio], remaining: [laptop], frames: frames, workspace: ws,
                                        showing: ["laptop": 1], stash: &stash, now: 0)
        let ms = (ProcessInfo.processInfo.systemUptime - start) * 1000
        let moved = Set(moves.map(\.window))
        let mostlyOnStudio = frames.filter { Geometry.display(of: $0.value, in: ["studio": studio.frame, "laptop": laptop.frame]) == "studio" }
        XCTAssertEqual(moved, Set(mostlyOnStudio.keys), "every window of the lost display moved")
        for m in moves { XCTAssertTrue(onScreen(m.frame, [laptop]), "\(m.frame) is off screen") }
        XCTAssertLessThan(ms, 50, "planning 300 windows took \(ms) ms")
    }

    /// The stash lives in `placements.json` with the book; a file from before it existed still loads.
    func testTheStashRoundTripsWithTheBookAndAnOlderFileStillLoads() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("placements-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        var book = PlacementBook()
        _ = DisplayRemap.unplug(lost: [studio], remaining: [laptop], frames: frames, workspace: workspace,
                                showing: ["laptop": 1], stash: &book.stash, now: 5)
        book.save(to: url)
        XCTAssertEqual(PlacementBook.load(from: url).stash, book.stash)
        try Data(#"{"live":[],"gone":[]}"#.utf8).write(to: url)
        XCTAssertEqual(PlacementBook.load(from: url), PlacementBook(), "a book without a stash is not thrown away")
    }
}
