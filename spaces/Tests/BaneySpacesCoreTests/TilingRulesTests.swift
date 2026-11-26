import XCTest
@testable import BaneySpacesCore

// MARK: Anything that can happen, in any order

/// Random windows, apps, drags, displays and settings, with the rules checked each time the windows come to rest.
final class TilingEnginePropertyTests: XCTestCase {
    /// Every rule holds with the main display on its side too, where most splits are across its height.
    private var portrait = false
    private var home: CGRect { turned(CGRect(x: 0, y: 25, width: 1728, height: 1050)) }
    private func turned(_ r: CGRect) -> CGRect { portrait ? CGRect(x: r.minX, y: r.minY, width: r.height, height: r.width) : r }

    private func step(_ f: inout FakeWindows, _ r: inout TileRandom, _ next: inout WindowID) {
        let ids = f.wins.keys.sorted()
        let id = ids.isEmpty ? 0 : ids[r.below(ids.count)]
        switch r.below(21) {
        case 0, 1, 2:
            guard ids.count < 12 else { return }
            next += 1
            let pid = Int32(100 + r.below(4))
            f.open(next, pid: pid, bundle: pid == 103 ? "float" : "app\(pid)", workspace: 1 + r.below(3),
                   frame: CGRect(x: r.between(0, 900), y: r.between(30, 500), width: r.between(200, 900), height: r.between(150, 700)).integral,
                   least: CGSize(width: r.between(80, 620).rounded(), height: r.between(60, 420).rounded()))
            if r.below(5) == 0 { f.wins[next]!.grid = 13; f.wins[next]!.roundsUp = r.below(2) == 0 }
            if r.below(8) == 0 { f.wins[next]!.w.fixed = true }
            f.focused = next
        case 3: f.wins[id] = nil; if f.focused == id { f.focused = nil }
        case 4, 5: f.wins[id]?.w.away.toggle()
        case 6:
            // Another native tab of the same window comes to the front.
            guard let old = f.wins.removeValue(forKey: id) else { return }
            next += 1
            f.wins[next] = old
            f.wins[next]!.w.id = next
            if f.focused == id { f.focused = next }
        case 7: f.focused = ids.isEmpty ? nil : id
        case 8:
            // The person drags it somewhere.
            f.wins[id]?.w.frame.origin = CGPoint(x: r.between(0, 1200), y: r.between(30, 700))
            f.engine.touched(id)
        case 9: f.wins[id]?.w.workspace = 1 + r.below(3)
        case 10:
            let place = f.shown.values.first { $0.display == "D1" } ?? .init(display: "D1", area: home)
            f.shown = [1 + r.below(3): place]
        case 11:
            // A second display comes or goes.
            if f.shown.count > 1 { f.shown = f.shown.filter { $0.value.display == "D1" } } else if let used = f.shown.keys.first {
                f.shown[used % 3 + 1] = .init(display: "D2", area: CGRect(x: 1728, y: 0, width: 1080, height: 1880))
            }
        case 12:
            for n in f.shown.keys where f.shown[n]!.display == "D1" {
                f.shown[n]!.area = turned([CGRect(x: 0, y: 25, width: 1728, height: 1050), CGRect(x: 0, y: 51, width: 1728, height: 940), CGRect(x: 0, y: 25, width: 1400, height: 875)][r.below(3)])
            }
        case 13:
            let style = TileStyle.allCases[r.below(3)], inner = Double(r.below(20)), side = TilingSide.allCases[r.below(2)]
            let off: Set<Int> = r.below(3) == 0 ? [1 + r.below(3)] : []
            f.engine.apply(FakeWindows.options {
                $0.style = style; $0.gaps = TileGaps(inner: inner, outer: inner); $0.side = side; $0.off = off; $0.floatApps = ["float"]
            })
        case 16:
            // Groups made, taken apart, joined and left.
            guard let w = f.wins[id]?.w, f.shown[w.workspace] != nil else { return }
            let commands: [TilingCommand] = [.group, .groupCycle(backward: false)] + TileDirection.allCases.map { .join($0) }
            _ = f.engine.run(commands[r.below(commands.count)], on: w.workspace, focused: id)
            f.focused = id
        case 17:
            guard let w = f.wins[id]?.w, let strip = f.engine.tabs(w.workspace).first?.frame else { return }
            f.engine.drop(id, on: CGPoint(x: strip.midX, y: strip.midY))
        case 18:
            // Popped out, pinned or let go, and carried to another workspace on the way.
            guard let w = f.wins[id]?.w else { return }
            if w.over == nil { f.engine.popOut(id, sized: r.below(2) == 0) } else if r.below(3) == 0 { f.wins[id]!.w.workspace = 1 + r.below(3) }
            f.wins[id]!.w.over = w.over == nil ? .pinned : nil
        case 19:
            guard let w = f.wins[id]?.w else { return }
            _ = f.engine.run(.zoom(r.below(2) == 0 ? .screen : .width), on: w.workspace, focused: id)
        case 20:
            guard let w = f.wins[id]?.w else { return }
            let commands: [TilingCommand] = [.keepWidth, .restoreWidth, .balance] + TileDirection.allCases.map { .grow($0) }
            for _ in 0..<(1 + r.below(8)) { _ = f.engine.run(commands[r.below(commands.count)], on: w.workspace, focused: id) }
        case 14: if f.wins[id] != nil { f.engine.choice[id] = r.below(2) == 0 }
        default:
            guard f.wins[id] != nil else { return }
            f.wins[id]!.stuck = r.below(5) == 0
            if r.below(3) == 0 { f.wins[id]!.busy = 1 + r.below(3) }
        }
    }

    private func check(_ f: inout FakeWindows, _ where_: String) {
        // Settled: after that no look writes anything.
        let settled = f.rest(most: 12)
        XCTAssertLessThan(settled, 12, "\(where_): never came to rest")
        let quiet = f.writes
        f.look(); f.look()
        XCTAssertEqual(f.writes, quiet, "\(where_): wrote at rest")
        for (n, place) in f.shown {
            let here = f.wins.values.filter { $0.w.workspace == n }
            let should = Set(here.filter { !$0.w.away && !f.engine.floats($0.w) }.map(\.w.id))
            let tiled = f.tiled(n)
            guard f.engine.options.tiles(n) else { XCTAssertTrue(tiled.isEmpty, "\(where_): a layout while off"); continue }
            XCTAssertEqual(tiled.count, Set(tiled).count, "\(where_): a window twice")
            XCTAssertEqual(Set(tiled), should, "\(where_): one slot per tiled window")
            let targets = f.engine.frames(n)
            XCTAssertEqual(Set(targets.keys), should, where_)
            let shared = Set(f.engine.tiles(n).stacked)
            let slot = f.engine.slots[f.engine.key(n)!]!
            let grouped = slot.groups.flatMap(\.members)
            XCTAssertEqual(grouped.count, Set(grouped).count, "\(where_): in two groups")
            for g in slot.groups {
                XCTAssertEqual(g.members.filter(slot.layout.contains).count, 1, "\(where_): one front")
                XCTAssertEqual(Set(g.members.map { "\(targets[$0] ?? .null)" }).count, 1, "\(where_): a group is one tile")
            }
            for strip in f.engine.tabs(n) {
                XCTAssertTrue(place.area.contains(strip.frame), "\(where_): a strip outside")
                for (id, t) in targets where slot.front(of: id) != strip.front || TilingEngine.zoom(of: id, slot) == nil { XCTAssertFalse(strip.frame.intersects(t), "\(where_): \(id) over a strip") }
            }
            for (id, t) in targets {
                XCTAssertTrue(place.area.contains(t), "\(where_): \(id) at \(t) outside \(place.area)")
                // A zoomed window lies over the tiles, which keep theirs; one too big for its tile shares the next.
                for (other, o) in targets where other > id && o != t && !shared.contains(id) && !shared.contains(other)
                    && TilingEngine.zoom(of: id, slot) == nil && TilingEngine.zoom(of: other, slot) == nil {
                    XCTAssertFalse(t.intersects(o), "\(where_): \(id) \(t) over \(other) \(o)")
                }
            }
        }
    }

    func testEveryRuleHoldsWhateverHappens() {
        for seed in 1...60 { run(seed) }
    }

    func testEveryRuleHoldsOnADisplayOnItsSide() {
        portrait = true
        for seed in 1...30 { run(seed) }
    }

    private func run(_ seed: Int) {
        var r = TileRandom(state: UInt64(seed)), f = FakeWindows(area: home), next: WindowID = 0
        f.engine.apply(FakeWindows.options { $0.floatApps = ["float"] })
        for n in 0..<120 {
            step(&f, &r, &next)
            let seenBefore = f.engine.before
            f.log = []
            check(&f, "\(portrait ? "portrait " : "")seed \(seed) step \(n)")
            for (m, win) in f.log {
                XCTAssertFalse(win.w.away, "\(portrait ? "portrait " : "")seed \(seed) step \(n): wrote a window that is away")
                XCTAssertTrue(f.shown.keys.contains(win.w.workspace), "\(portrait ? "portrait " : "")seed \(seed) step \(n): wrote a window out of sight")
                // Only ever its own frame from before tiling goes to a window that doesn't tile.
                if f.engine.floats(win.w) || !f.engine.options.tiles(win.w.workspace) {
                    let was = seenBefore[m.id].map { Geometry.restoreFrame(saved: $0, size: $0.size, screens: [f.shown[win.w.workspace]!.area]).size }
                    XCTAssertEqual(m.to.size, was, "\(portrait ? "portrait " : "")seed \(seed) step \(n): wrote a window that floats")
                }
            }
            if testRun?.failureCount ?? 0 > 5 { return }
        }
    }

    func testTurningItOffPutsEveryFrameBackWhateverHappened() {
        for seed in 1...40 {
            var r = TileRandom(state: UInt64(seed) &* 977), f = FakeWindows(), next: WindowID = 0
            var was: [WindowID: CGRect] = [:]
            f.engine.apply(FakeWindows.options())
            for _ in 0..<40 {
                // One display, one workspace, windows that do as told: what was before is what must come back.
                switch r.below(5) {
                case 0, 1:
                    guard f.wins.count < 9 else { break }
                    next += 1
                    f.open(next, frame: CGRect(x: r.between(0, 800), y: r.between(30, 300), width: r.between(150, 900), height: r.between(100, 700)).integral)
                    was[next] = f.wins[next]!.w.frame
                case 2: if let id = f.wins.keys.randomElement(using: &r) { f.wins[id] = nil; was[id] = nil }
                case 3: if let id = f.wins.keys.sorted().randomElement(using: &r) { f.wins[id]!.w.away.toggle() }
                default: f.focused = f.wins.keys.sorted().randomElement(using: &r)
                }
                f.rest()
            }
            for id in f.wins.keys { f.wins[id]!.w.away = false }
            f.engine.apply(TilingOptions())
            f.rest()
            XCTAssertEqual(f.wins.mapValues(\.w.frame), was, "seed \(seed)")
        }
    }

    func testPlanningForEightWindowsIsASliverOfTheBudget() {
        var f = FakeWindows()
        for id in WindowID(1)...8 { f.open(id); f.focused = id; f.rest() }
        var ms: [Double] = []
        for n in 0..<200 {
            var g = f
            g.open(WindowID(100 + n))
            let t = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
            _ = g.engine.plan(g.shot)
            ms.append(Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - t) / 1e6)
        }
        ms.sort()
        print(String(format: "tiling: plan for a ninth window, p50 %.4f ms, p90 %.4f ms", ms[99], ms[179]))
        XCTAssertLessThan(ms[179], 2)
    }
}
