import XCTest
@testable import BaneySpacesCore

/// A window server with no windows behind it: it does what apps do with the frames tiling writes. A window keeps its
/// minimum, rounds its size to its own grid, is busy for a while, or doesn't move at all.
struct FakeWindows {
    struct Win {
        var w: TilingWindow
        var least = CGSize(width: 100, height: 80)
        var grid: CGFloat = 1
        var roundsUp = false
        var stuck = false
        /// Writes it misses before it answers again.
        var busy = 0
        /// Writes of which it takes the place and not the size.
        var slow = 0
        /// Its app puts it back at once, whatever it is told.
        var stubborn: CGRect?
    }

    var wins: [WindowID: Win] = [:]
    var shown: [Int: TilingShot.Place]
    var focused: WindowID?
    var displays: [CGRect] = []
    var corner: CGPoint?
    var engine = TilingEngine()
    var writes = 0
    /// Every write in this run, with what the window was when it was written.
    var log: [(TilingMove, Win)] = []

    init(area: CGRect = CGRect(x: 0, y: 25, width: 1728, height: 1050), workspace: Int = 1) {
        shown = [workspace: .init(display: "D1", area: area)]
        engine.apply(Self.options())
    }

    static func options(_ change: (inout TilingOptions) -> Void = { _ in }) -> TilingOptions {
        var o = TilingOptions()
        o.everywhere = true
        o.gaps = TileGaps(inner: 8, outer: 8)
        change(&o)
        return o
    }

    var shot: TilingShot {
        var s = TilingShot(windows: wins.values.map(\.w).sorted { $0.id < $1.id }, shown: shown, focused: focused)
        (s.displays, s.corner) = (displays, corner)
        return s
    }

    mutating func open(_ id: WindowID, pid: Int32 = 100, bundle: String = "app", workspace: Int = 1, frame: CGRect? = nil, least: CGSize? = nil) {
        let f = frame ?? CGRect(x: 40 + CGFloat(id) * 12, y: 60 + CGFloat(id) * 9, width: 700, height: 500)
        wins[id] = Win(w: TilingWindow(id: id, pid: pid, bundle: bundle, workspace: workspace, frame: f))
        if let least { wins[id]!.least = least }
    }

    private mutating func write(_ moves: [TilingMove]) -> [WindowID: CGRect] {
        var out: [WindowID: CGRect] = [:]
        for m in moves {
            guard var win = wins[m.id] else { continue }
            writes += 1
            log.append((m, win))
            if let back = win.stubborn {
                win.w.frame = back
            } else if win.busy > 0 {
                win.busy -= 1
            } else if !win.stuck {
                let g = win.grid, how: FloatingPointRoundingRule = win.roundsUp ? .up : .down
                let size = CGSize(width: max(win.least.width, (m.to.width / g).rounded(how) * g),
                                  height: max(win.least.height, (m.to.height / g).rounded(how) * g))
                win.w.frame = CGRect(origin: m.to.origin, size: win.slow > 0 ? win.w.frame.size : size)
                win.slow = max(0, win.slow - 1)
            }
            wins[m.id] = win
            out[m.id] = win.w.frame
        }
        return out
    }

    /// What the app does after a scan: write the plan, read back, and look again when something was learned.
    mutating func look() {
        for _ in 0..<20 {
            let moves = engine.plan(shot)
            guard !moves.isEmpty, engine.landed(write(moves)) else { return }
        }
        XCTFail("it never stops asking")
    }

    /// Looks until a look writes nothing; the number of looks that wrote.
    @discardableResult
    mutating func rest(most: Int = 12) -> Int {
        for n in 0..<most {
            let was = writes
            look()
            if writes == was { return n }
        }
        return most
    }

    func tiled(_ workspace: Int) -> [WindowID] { engine.key(workspace).flatMap { engine.slots[$0] }?.layout.windows ?? [] }
}

final class TilingEngineTests: XCTestCase {
    private func two() -> FakeWindows {
        var f = FakeWindows()
        f.open(1); f.open(2)
        f.focused = 1
        f.rest()
        return f
    }

    func testOffPlansNothingAndKeepsNothing() {
        var f = FakeWindows()
        f.engine.apply(TilingOptions())
        f.open(1); f.open(2)
        f.look()
        XCTAssertEqual(f.writes, 0)
        XCTAssertFalse(f.engine.wanted(on: [1]))
        XCTAssertTrue(f.engine.slots.isEmpty)
        XCTAssertTrue(f.engine.before.isEmpty)
    }

    func testTwoWindowsShareTheArea() {
        let f = two()
        XCTAssertEqual(f.wins[1]!.w.frame, CGRect(x: 8, y: 33, width: 852, height: 1034))
        XCTAssertEqual(f.wins[2]!.w.frame, CGRect(x: 868, y: 33, width: 852, height: 1034))
        XCTAssertEqual(f.writes, 2)
    }

    func testNothingIsWrittenAtRest() {
        var f = two()
        f.writes = 0
        f.look(); f.look()
        XCTAssertEqual(f.writes, 0)
    }

    func testAWorkspaceOfItsOwnChoice() {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.everywhere = false; $0.on = [1] })
        XCTAssertTrue(f.engine.options.tiles(1)); XCTAssertFalse(f.engine.options.tiles(2))
        f.engine.apply(FakeWindows.options { $0.off = [1] })
        XCTAssertFalse(f.engine.options.tiles(1)); XCTAssertTrue(f.engine.options.tiles(2))
        f.engine.apply(FakeWindows.options { $0.on = [3]; $0.agentWorkspace = 3 })
        XCTAssertFalse(f.engine.options.tiles(3), "the agent workspace never tiles")
    }

    func testFramesFromBeforeComeBackWhenItIsTurnedOff() {
        var f = FakeWindows()
        f.open(1); f.open(2); f.open(3)
        let was = f.wins.mapValues(\.w.frame)
        f.rest()
        XCTAssertNotEqual(f.wins.mapValues(\.w.frame), was)
        f.engine.apply(TilingOptions())
        XCTAssertTrue(f.engine.wanted(on: [1]), "the frames are still owed")
        f.rest()
        XCTAssertEqual(f.wins.mapValues(\.w.frame), was)
        XCTAssertFalse(f.engine.wanted(on: [1]))
        XCTAssertTrue(f.engine.slots.isEmpty)
    }

    func testTurnedOffWhileHiddenItGoesBackOnceInSight() {
        var f = two()
        let before = f.engine.before
        f.shown = [2: f.shown[1]!]
        f.look()
        f.engine.apply(FakeWindows.options { $0.off = [1] })
        f.writes = 0
        f.look()
        XCTAssertEqual(f.writes, 0, "a workspace out of sight is never written")
        f.shown = [1: f.shown[2]!]
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame, before[1])
    }

    func testFixedRuleFloatedAndChosenWindowsAreNeverTouched() {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.floatApps = ["calc"] })
        f.open(1); f.open(2, bundle: "calc"); f.open(3)
        f.wins[3]!.w.fixed = true
        f.rest()
        XCTAssertEqual(f.tiled(1), [1])
        XCTAssertEqual(Set(f.log.map(\.0.id)), [1])
        f.engine.choice[2] = false
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 2], "a person's choice goes over the rule")
        f.engine.choice[3] = false
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 2], "a window that can't be resized still floats")
    }

    func testFloatingPutsTheFrameFromBeforeBackAndClosesUp() {
        var f = two()
        let was = f.engine.before[2]!
        f.engine.choice[2] = true
        f.rest()
        XCTAssertEqual(f.wins[2]!.w.frame, was)
        XCTAssertEqual(f.wins[1]!.w.frame.width, 1712)
        f.wins[2]!.w.frame = CGRect(x: 300, y: 300, width: 400, height: 300)
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.writes, 0, "a floating window goes where it is put")
    }

    func testAMinimizedWindowComesBackToItsPlace() {
        var f = FakeWindows()
        for id in WindowID(1)...4 { f.open(id); f.focused = id; f.rest() }
        let frames = f.wins.mapValues(\.w.frame)
        for id in WindowID(1)...4 {
            f.wins[id]!.w.away = true
            f.rest()
            XCTAssertFalse(f.tiled(1).contains(id))
            XCTAssertFalse(f.log.last!.0.id == id)
            f.wins[id]!.w.away = false
            f.rest()
            XCTAssertEqual(f.wins.mapValues(\.w.frame), frames, "window \(id)")
        }
    }

    func testTwoMinimizedWindowsComeBackInEitherOrder() {
        for order in [[WindowID(2), 3], [3, 2]] {
            var f = FakeWindows()
            for id in WindowID(1)...4 { f.open(id); f.focused = id; f.rest() }
            let frames = f.wins.mapValues(\.w.frame)
            f.wins[2]!.w.away = true; f.rest()
            f.wins[3]!.w.away = true; f.rest()
            for id in order { f.wins[id]!.w.away = false; f.rest() }
            XCTAssertEqual(f.wins.mapValues(\.w.frame), frames, "\(order)")
        }
    }

    func testAWindowBackToAChangedLayoutGoesBesideItsOldNeighbor() {
        var f = FakeWindows()
        for id in WindowID(1)...3 { f.open(id); f.focused = id; f.rest() }
        f.wins[2]!.w.away = true; f.rest()
        f.open(9); f.focused = 3; f.rest()
        f.wins[2]!.w.away = false; f.rest()
        XCTAssertEqual(Set(f.tiled(1)), [1, 2, 3, 9])
        let order = f.tiled(1)
        XCTAssertEqual(order.firstIndex(of: 2)! - order.firstIndex(of: 1)!, 1, "\(order)")
    }

    func testANativeTabTakesTheSlotOfTheOneItReplaces() {
        var f = two()
        let slot = f.wins[1]!.w.frame
        f.wins[1] = nil
        f.open(50, frame: slot)
        f.focused = 50
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.tiled(1), [50, 2])
        XCTAssertEqual(f.writes, 0, "the tab is already in place")
        XCTAssertNotNil(f.engine.before[50], "and goes back where the window was when tiling is turned off")
    }

    /// The window server can keep a tab that isn't in front, out of sight, while the next one comes up in its place.
    func testATabOutOfSightGivesItsSlotToTheOneInFront() {
        var f = two()
        let layout = f.engine.slots[f.engine.key(1)!]!.layout
        let place = f.wins[2]!.w.frame, writes = f.writes
        f.open(3, frame: place); f.wins[2]!.w.away = true
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 3])
        f.wins[3]!.w.away = true; f.wins[2]!.w.away = false
        f.rest()
        XCTAssertEqual(f.engine.slots[f.engine.key(1)!]!.layout, layout)
        XCTAssertEqual(f.writes, writes)
        // Wherever the focus is.
        f.focused = 2; f.open(7); f.focused = 7; f.rest()
        let order = f.tiled(1)
        for (old, new) in [(WindowID(1), WindowID(8)), (8, 1)] {
            if f.wins[new] == nil { f.open(new) }
            f.wins[new]!.w.frame = f.wins[old]!.w.frame; f.wins[new]!.w.away = false; f.wins[old]!.w.away = true
            f.rest()
            XCTAssertEqual(f.tiled(1), order.map { $0 == 1 && old == 1 ? new : $0 })
        }
        f.wins[7] = nil; f.wins[8] = nil; f.rest(); f.focused = 1
        f.rest()
        // On another workspace it is no tab.
        f.open(5); f.wins[3] = nil; f.rest()
        XCTAssertEqual(f.tiled(1), [1, 5, 2])
        f.open(4, workspace: 2, frame: f.wins[2]!.w.frame); f.wins[2]!.w.away = true
        f.look()
        f.wins[2]!.w.away = false
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 5, 2], "its place, not one beside the focused window")
    }

    func testAnotherAppsWindowInTheSamePlaceIsNoTab() {
        var f = FakeWindows()
        for id in WindowID(1)...3 { f.open(id); f.focused = id; f.rest() }
        let slot = f.wins[1]!.w.frame
        f.wins[1] = nil
        f.open(50, pid: 200, frame: slot)
        f.rest()
        XCTAssertEqual(f.tiled(1).last, 50, "\(f.tiled(1))")
    }

    func testAWindowTakenFromAHiddenWorkspaceLeavesItsLayoutAtOnce() {
        var f = two()
        f.shown = [2: f.shown[1]!]
        f.open(5, workspace: 2)
        f.rest()
        f.wins[2]!.w.workspace = 2
        f.rest()
        XCTAssertEqual(f.tiled(1), [1])
        XCTAssertEqual(f.tiled(2), [5, 2])
    }

    func testTabsMergedWhileOneWasBehindTakeOnePlace() {
        var f = two()
        f.open(3); f.focused = 3; f.rest()
        let home = f.shown[1]!
        f.shown = [1: .init(display: "D2", area: CGRect(x: 2000, y: 0, width: 1200, height: 900))]
        f.rest()
        // The first display's layout still has 1 and 2 side by side when 2 comes up as a tab at 1's place.
        f.wins[3]!.w.away = true; f.wins[2]!.w.away = true; f.rest()
        f.wins[2]!.w.frame = f.wins[1]!.w.frame
        f.wins[1]!.w.away = true; f.wins[2]!.w.away = false
        f.rest()
        XCTAssertEqual(f.tiled(1), [2])
        for slot in f.engine.slots.values {
            XCTAssertEqual(slot.layout.windows.filter { $0 == 2 }, [2])
            for a in slot.away.values { XCTAssertEqual(a.whole.windows.filter { $0 == 2 }.count, 1) }
        }
        f.shown = [1: home]
        f.rest()
        XCTAssertEqual(f.tiled(1), [2])
    }

    func testEachTabKeepsItsOwnFrameFromBefore() {
        var f = two()
        let before = f.engine.before
        f.wins[2]!.w.away = true; f.rest()
        f.wins[2]!.w.frame = f.wins[1]!.w.frame
        f.wins[1]!.w.away = true; f.wins[2]!.w.away = false; f.rest()
        // Pulled out of the window again.
        f.wins[1]!.w.frame = CGRect(x: 300, y: 300, width: 600, height: 400)
        f.wins[1]!.w.away = false; f.rest()
        XCTAssertEqual(f.tiled(1).count, 2)
        f.engine.apply(TilingOptions())
        f.rest()
        XCTAssertEqual(f.wins.mapValues(\.w.frame), before)
        // One that closes passes its frame on only to a tab that has none.
        f = two()
        let first = f.engine.before[1]!
        f.open(9, frame: f.wins[1]!.w.frame); f.wins[1] = nil; f.rest()
        XCTAssertEqual(f.engine.before[9], first)
        XCTAssertNil(f.engine.before[1])
    }

    func testATabOfAWindowBackInItsPlaceStaysWhereTheWindowIs() {
        for floated in [false, true] {
            var f = FakeWindows()
            f.open(1); f.open(2)
            f.rest()
            // 2 has another tab in front.
            f.open(3, frame: f.wins[2]!.w.frame)
            f.wins[2]!.w.away = true
            f.rest()
            XCTAssertNotNil(f.engine.before[2])
            if floated { f.engine.choice[3] = true } else { f.engine.apply(TilingOptions()) }
            f.rest()
            XCTAssertNil(f.engine.before[3])
            f.wins[3]!.w.frame = CGRect(x: 600, y: 400, width: 500, height: 300)
            f.engine.touched(3)
            f.rest()
            f.wins[2]!.w.frame = f.wins[3]!.w.frame
            f.wins[2]!.w.away = false
            f.wins[3]!.w.away = true
            f.log = []
            f.rest()
            XCTAssertTrue(f.log.filter { $0.0.id == 2 }.isEmpty, "floated: \(floated)")
        }
    }

    func testATabFloatsAsTheWindowItIsIn() {
        var f = two()
        f.open(3); f.focused = 3; f.rest()
        f.engine.choice[2] = true; f.rest()
        f.wins[2]!.w.away = true; f.rest()
        // Put into a tiled window, it has that one's tile.
        f.wins[2]!.w.frame = f.wins[1]!.w.frame; f.wins[2]!.w.away = false
        f.wins[1]!.w.away = true
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.tiled(1), [2, 3])
        XCTAssertEqual(f.writes, 0)
        // One that floats passes it on to its next tab.
        f.engine.choice[2] = true; f.rest()
        f.open(8, frame: f.wins[2]!.w.frame); f.wins[2] = nil
        f.rest()
        XCTAssertEqual(f.engine.choice, [8: true])
        XCTAssertEqual(f.tiled(1), [3])
    }

    func testAFrameFromBeforeIsPutOnTheDisplayTheWindowIsOnNow() {
        var f = FakeWindows()
        let second = TilingShot.Place(display: "D2", area: CGRect(x: 1728, y: 0, width: 1600, height: 900))
        f.engine.apply(FakeWindows.options { $0.everywhere = false; $0.on = [1] })
        f.open(1); f.open(2); f.rest()
        f.shown[2] = second
        f.wins[2]!.w.workspace = 2
        f.wins[2]!.w.frame = CGRect(x: 1800, y: 100, width: 700, height: 500)
        f.rest()
        XCTAssertTrue(second.area.contains(f.wins[2]!.w.frame), "\(f.wins[2]!.w.frame)")
        XCTAssertNil(f.engine.before[2])
        // Floated on another display than it was tiled on.
        f.engine.apply(FakeWindows.options())
        f.rest()
        f.engine.before[2] = CGRect(x: 100, y: 100, width: 700, height: 500)
        f.engine.choice[2] = true
        f.rest()
        XCTAssertTrue(second.area.contains(f.wins[2]!.w.frame), "\(f.wins[2]!.w.frame)")
    }

    func testTheAgentWorkspaceIsNeverWrittenNotEvenToPutAFrameBack() {
        var f = two()
        f.writes = 0
        f.engine.apply(FakeWindows.options { $0.agentWorkspace = 1 })
        f.rest()
        XCTAssertEqual(f.writes, 0)
        XCTAssertFalse(f.engine.wanted(on: [1]), "and nothing is owed there")
    }

    func testNewWindowsGoOnTheChosenSide() {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = .columns; $0.side = .before })
        f.open(1); f.open(2); f.focused = 2; f.rest()
        f.open(3); f.rest()
        XCTAssertEqual(f.tiled(1), [1, 3, 2])
        f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = .columns })
        f.open(1); f.open(2); f.focused = 1; f.rest()
        f.open(3); f.focused = 3; f.rest()
        XCTAssertEqual(f.tiled(1), [1, 3, 2], "beside the one that had the focus")
    }

    func testADisplayThatComesBackFindsItsOwnLayout() {
        var f = FakeWindows()
        for id in WindowID(1)...3 { f.open(id); f.focused = id; f.rest() }
        let frames = f.wins.mapValues(\.w.frame), home = f.shown
        f.shown = [1: .init(display: "D2", area: CGRect(x: 2000, y: 0, width: 1200, height: 1920))]
        f.rest()
        XCTAssertTrue(f.wins.values.allSatisfy { f.shown[1]!.area.contains($0.w.frame) })
        XCTAssertEqual(f.tiled(1).count, 3)
        f.shown = home
        f.rest()
        XCTAssertEqual(f.wins.mapValues(\.w.frame), frames)
    }

    func testADisplayWithNoAreaLeftWritesNothingAndKeepsTheLayout() {
        var f = two()
        f.open(3); f.rest()
        let before = f.engine.slots, frames = f.wins.mapValues(\.w.frame), writes = f.writes
        for gone in [CGRect.zero, .null] {
            f.shown[1]!.area = gone
            f.look()
            XCTAssertEqual(f.engine.slots, before)
        }
        f.shown[1]!.area = CGRect(x: 0, y: 25, width: 1728, height: 1050)
        f.rest()
        XCTAssertEqual(f.wins.mapValues(\.w.frame), frames)
        XCTAssertEqual(f.writes, writes)
    }

    func testAChangedAreaSolvesAgain() {
        var f = two()
        f.shown[1]!.area = CGRect(x: 0, y: 60, width: 1728, height: 900)
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame, CGRect(x: 8, y: 68, width: 852, height: 884))
    }

    func testALoneWindowKeepsItsWidthInTheMiddle() {
        var f = FakeWindows(area: CGRect(x: 0, y: 0, width: 3440, height: 1440))
        f.engine.apply(FakeWindows.options { $0.lone = .points(1600) })
        f.open(1); f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame, CGRect(x: 920, y: 8, width: 1600, height: 1424))
    }

    func testASmartLoneWindowFillsAnyDisplayButAWideOne() {
        XCTAssertNil(TilingLone.smart.width(in: CGRect(x: 0, y: 0, width: 1920, height: 1080)))
        XCTAssertNil(TilingLone.smart.width(in: CGRect(x: 0, y: 0, width: 1080, height: 1920)))
        XCTAssertEqual(TilingLone.smart.width(in: CGRect(x: 0, y: 0, width: 3440, height: 1400)), 2240)
        XCTAssertNil(TilingLone.fill.width(in: CGRect(x: 0, y: 0, width: 5120, height: 1440)))
    }

    func testAStyleChosenInSettingsLaysOutOnlyWhatFollowedTheOldOne() {
        var f = two()
        f.engine.apply(FakeWindows.options { $0.style = .main })
        XCTAssertEqual(f.engine.slots.values.map(\.layout.style), [.main])
        f.engine.slots[f.engine.key(1)!]!.layout.setStyle(.columns, area: f.shown[1]!.area)
        f.engine.apply(FakeWindows.options { $0.style = .dwindle })
        XCTAssertEqual(f.engine.slots.values.map(\.layout.style), [.columns])
    }
}
