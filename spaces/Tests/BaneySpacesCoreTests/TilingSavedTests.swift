import XCTest
@testable import BaneySpacesCore

final class TilingSavedTests: XCTestCase {
    private let key = Data(repeating: 7, count: 32)
    private let titles: [WindowID: String] = [1: "Notes", 2: "Inbox", 3: "Draft"]

    private func record(_ id: WindowID, at: Double = 1000, pid: Int32 = 100) -> WindowRecord? {
        titles[id].map { WindowRecord(bundle: "app", title: $0, order: Int(id), workspace: 1, frame: nil, displays: [], window: id, pid: pid, at: at, key: key) }
    }

    private func three() -> FakeWindows {
        var f = FakeWindows()
        for id in WindowID(1)...3 { f.open(id); f.focused = id; f.rest() }
        return f
    }

    private func live(_ id: WindowID, _ title: String, pid: Int32 = 100, order: Int? = nil) -> (window: LiveWindow, workspace: Int) {
        (LiveWindow(id: id, bundle: "app", title: title, order: order ?? Int(id), pid: pid, key: key), 1)
    }

    /// A new run of Polycarp: the engine starts over with what was saved.
    private func restart(_ f: FakeWindows) -> FakeWindows {
        var g = f
        let data = f.engine.saved { self.record($0) }.data()
        g.engine = TilingEngine()
        g.engine.apply(f.engine.options)
        g.engine.restore(TilingSaved.read(data, now: 2000)!)
        g.writes = 0
        return g
    }

    func testPolycarpStartsAgainAndNothingMoves() {
        let f = three()
        var g = restart(f)
        g.engine.claim(titles.map { live($0.key, $0.value) })
        g.rest()
        XCTAssertEqual(g.writes, 0)
        XCTAssertEqual(g.engine.before, f.engine.before)
        XCTAssertFalse(g.engine.awaits)
        g.engine.apply(TilingOptions())
        g.rest()
        XCTAssertEqual(g.wins.mapValues(\.w.frame), f.engine.before)
    }

    func testAfterTheMacRestartsWindowsFindTheirPlacesAsTheyOpen() {
        let f = three()
        let was = f.wins.mapValues(\.w.frame)
        for order in [[WindowID(3), 1, 2], [2, 3, 1]] {
            var g = restart(f)
            g.wins = [:]
            for old in order {
                let id = old + 500
                g.open(id, pid: 900)
                g.focused = id
                g.engine.claim([live(id, titles[old]!, pid: 900)])
                g.rest()
            }
            XCTAssertEqual(g.wins.mapValues(\.w.frame), Dictionary(uniqueKeysWithValues: was.map { ($0.key + 500, $0.value) }), "\(order)")
            XCTAssertFalse(g.engine.awaits)
        }
    }

    func testAWindowWithAnotherTitleTakesNoPlace() {
        var g = restart(three())
        g.wins = [:]
        g.open(700, pid: 900)
        g.engine.claim([live(700, "Something else", pid: 900, order: 1)])
        g.rest()
        XCTAssertTrue(g.engine.awaits)
        XCTAssertEqual(g.tiled(1), [700])
        XCTAssertEqual(g.wins[700]!.w.frame.width, 1712)
    }

    func testAWindowTiledBeforeItHadATitleMovesToItsPlace() {
        let f = three()
        let was = f.wins.mapValues(\.w.frame)
        for late in WindowID(1)...3 {
            var g = restart(f)
            g.wins = [:]
            g.open(500 + late, pid: 900); g.engine.claim([live(500 + late, "", pid: 900)]); g.rest()
            for old in titles.keys.sorted() where old != late {
                g.open(500 + old, pid: 900); g.engine.claim([live(500 + old, titles[old]!, pid: 900)]); g.rest()
            }
            g.engine.claim([live(500 + late, titles[late]!, pid: 900)]); g.rest()
            XCTAssertEqual(g.wins.mapValues(\.w.frame), Dictionary(uniqueKeysWithValues: was.map { ($0.key + 500, $0.value) }), "\(late)")
        }
    }

    /// Only Polycarp restarted: a page that changed its title meanwhile is the same window.
    func testTheSameWindowIsKnownWhateverItsTitleNow() {
        let f = three()
        var g = restart(f)
        g.engine.claim(titles.keys.map { live($0, "Another page") })
        g.rest()
        XCTAssertFalse(g.engine.awaits)
        XCTAssertEqual(g.writes, 0)
        g.engine = restart(f).engine
        g.engine.claim(titles.keys.map { live($0, "Another page", pid: 901) })
        XCTAssertTrue(g.engine.awaits, "a number used again by another process is another window")
    }

    func testMinimizedWindowsAreKeptInTheirPlaces() {
        var f = three()
        let frames = f.wins.mapValues(\.w.frame)
        f.wins[2]!.w.away = true
        f.rest()
        var g = restart(f)
        g.engine.claim(titles.map { live($0.key, $0.value) })
        g.rest()
        g.wins[2]!.w.away = false
        g.rest()
        XCTAssertEqual(g.wins.mapValues(\.w.frame), frames)
    }

    func testAFloatedWindowStaysFloated() {
        var f = three()
        f.engine.choice[2] = true
        f.rest()
        var g = restart(f)
        g.engine.claim(titles.map { live($0.key, $0.value) })
        g.rest()
        XCTAssertEqual(Set(g.tiled(1)), [1, 3])
        XCTAssertEqual(g.writes, 0)
    }

    func testABrokenFileGivesAFreshLayout() {
        let good = three().engine.saved { self.record($0) }.data()!
        XCTAssertNotNil(TilingSaved.read(good, now: 2000))
        XCTAssertNil(TilingSaved.read(nil, now: 0))
        for n in stride(from: 0, to: good.count - 1, by: 7) { XCTAssertNil(TilingSaved.read(good.prefix(n), now: 2000)) }
        let text = String(decoding: good, as: UTF8.self)
        XCTAssertNil(TilingSaved.read(Data(text.replacingOccurrences(of: "\"version\":1", with: "\"version\":2").utf8), now: 2000))
        XCTAssertNil(TilingSaved.read(Data("[]".utf8), now: 2000))
    }

    func testAnEditedFileNeverPutsAWindowTwiceOrCrashes() {
        let good = String(decoding: three().engine.saved { self.record($0) }.data()!, as: UTF8.self)
        for (a, b) in [("\"window\":2", "\"window\":1"), ("\"workspace\":1", "\"workspace\":0"), ("dwindle", "columns"), ("[", "[null,")] {
            guard let saved = TilingSaved.read(Data(good.replacingOccurrences(of: a, with: b).utf8), now: 2000) else { continue }
            var g = three()
            g.engine = TilingEngine()
            g.engine.apply(FakeWindows.options())
            g.engine.restore(saved)
            g.engine.claim(titles.map { live($0.key, $0.value) })
            XCTAssertLessThan(g.rest(), 12)
            XCTAssertEqual(g.tiled(1).sorted(), [1, 2, 3], "\(a) to \(b)")
        }
    }

    func testOldRecordsAreDroppedAndAPlaceWithoutOneIsNotKept() {
        let f = three()
        let saved = f.engine.saved { self.record($0) }
        XCTAssertEqual(TilingSaved.read(saved.data(), now: 1000 + TilingSaved.keep + 1)!.windows.count, 0)
        let partial = f.engine.saved { $0 == 2 ? nil : self.record($0) }
        XCTAssertEqual(partial.slots.first?.layout.windows.contains(2), false)
    }

    func testTurnedOffNothingIsWaitedFor() {
        var g = restart(three())
        XCTAssertTrue(g.engine.awaits)
        g.engine.apply(TilingOptions())
        XCTAssertFalse(g.engine.wanted(on: [1]), "a saved place alone asks for nothing")
        g.look()
        XCTAssertFalse(g.engine.awaits)
    }

    func testTheFileNamesNoWindow() {
        let text = String(decoding: three().engine.saved { self.record($0) }.data()!, as: UTF8.self)
        for t in titles.values { XCTAssertFalse(text.contains(t)) }
    }
}
