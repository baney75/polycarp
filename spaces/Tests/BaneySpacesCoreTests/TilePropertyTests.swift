import XCTest
@testable import BaneySpacesCore

/// Random but repeatable: the same seed gives the same numbers everywhere.
struct TileRandom: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        let x = (state ^ (state >> 33)) &* 0xFF51_AFD7_ED55_8CCD
        return x ^ (x >> 29)
    }
    mutating func below(_ n: Int) -> Int { Int(next() % UInt64(max(1, n))) }
    mutating func between(_ a: Double, _ b: Double) -> Double { a + (b - a) * Double(next() >> 12) / Double(1 << 52) }
}

/// One random call on a layout, the way the app would make it, and what it should do to the windows there are. Windows
/// are 1...20, at most 14 at a time, and some calls name one that isn't there.
func randomTileCall(_ l: inout TileLayout, _ there: inout Set<WindowID>, _ r: inout TileRandom, area: CGRect, gaps: TileGaps,
                    minimums: [WindowID: CGSize]) {
    let id = WindowID(1 + r.below(20)), other = WindowID(1 + r.below(20))
    let d = TileDirection.allCases[r.below(4)], axis = TileAxis.allCases[r.below(2)]
    switch r.below(15) {
    case 0, 1, 2:
        guard there.count < 14 else { return }
        l.insert(id, beside: r.below(4) == 0 ? nil : other, area: area)
        there.insert(id)
    case 3:
        l.remove(id, area: area)
        there.remove(id)
    case 4:
        let any = (0..<r.below(15)).map { _ in WindowID(1 + r.below(20)) }
        let present = r.below(6) == 0 ? any : l.windows.filter { _ in r.below(10) > 0 } + (there.count < 14 ? [id] : [])
        let before = l
        XCTAssertEqual(l.sync(present, focused: other, area: area), l != before)
        there = Set(present)
    case 5:
        l.replace(id, with: other)
        if there.contains(id), !there.contains(other) { there.remove(id); there.insert(other) }
    case 6: l.setStyle(TileStyle.allCases[r.below(3)], area: area)
    case 7, 8: l.move(id, toward: d, area: area)
    case 9: l.swap(id, other)
    case 10: l.resize(id, axis: axis, by: r.between(-600, 600), area: area, gaps: gaps, minimums: minimums)
    case 11:
        guard var f = l.frames(in: area, gaps: gaps, minimums: minimums)[id] else { return }
        f = f.offsetBy(dx: r.between(-300, 300), dy: r.between(-300, 300))
        f.size = CGSize(width: max(1, f.width + r.between(-300, 300)), height: max(1, f.height + r.between(-300, 300)))
        l.resize(id, to: f, area: area, gaps: gaps, minimums: minimums)
    case 12: l.balance(r.below(4) == 0 ? nil : id)
    case 13: l.flip(r.below(6) == 0 ? nil : id, area: area)
    default:
        if r.below(2) == 0 { l.promote(id) } else { l.full = r.below(3) == 0 }
    }
}

final class TilePropertyTests: XCTestCase {
    static let areas = [CGRect(x: 0, y: 33, width: 1512, height: 949), CGRect(x: -1080, y: -200.5, width: 1080, height: 1887.25),
                        CGRect(x: 1512, y: 0, width: 5120, height: 1415)]

    func testRandomCallsNeverBreakTheRules() throws {
        for seed in 0..<300 {
            var r = TileRandom(state: UInt64(seed) &* 7919 &+ 20_261_125)
            let gaps = TileGaps(inner: Double(r.below(20)), top: Double(r.below(30)), bottom: Double(r.below(30)), left: Double(r.below(30)),
                                right: Double(r.below(30)))
            var minimums: [WindowID: CGSize] = [:]
            for id in WindowID(1)...20 where r.below(3) == 0 { minimums[id] = CGSize(width: r.between(50, 500), height: r.between(50, 400)) }
            var l = TileLayout(style: TileStyle.allCases[(seed / 3) % 3]), there: Set<WindowID> = []
            for step in 0..<60 {
                let area = Self.areas[(seed + step / 25) % 3]  // and now and then the workspace changes displays
                let before = l
                randomTileCall(&l, &there, &r, area: area, gaps: gaps, minimums: minimums)
                XCTAssertEqual(Set(l.windows), there, "seed \(seed) step \(step)")
                try check(l, &r, area, gaps, minimums, "seed \(seed) step \(step)")
                if failed { return XCTFail("before: \(before)\nafter: \(l)") }
            }
        }
    }

    func testADragMovesOneEdgeAndEnoughMovesReachTheWorkspacesEdge() {
        let gaps = TileGaps(inner: 8, outer: 8)
        var dragged = 0
        for seed in 0..<400 {
            var r = TileRandom(state: UInt64(seed) &* 104_729 &+ 5)
            let area = Self.areas[seed % 3]
            var l = TileLayout(), there: Set<WindowID> = []
            for _ in 0..<40 { randomTileCall(&l, &there, &r, area: area, gaps: gaps, minimums: [:]) }
            l.full = false
            guard there.count > 1 else { continue }
            let id = l.windows[r.below(there.count)], d = TileDirection.allCases[r.below(4)]
            let was = TileBox(l.frames(in: area, gaps: gaps)[id]!)
            var to = was
            let by = r.between(-80, 80).rounded()
            switch d {
            case .left: to.x0 -= by
            case .right: to.x1 += by
            case .up: to.y0 -= by
            case .down: to.y1 += by
            }
            let edge = { (b: TileBox, d: TileDirection) in d.back ? b.lo(d.axis) : b.hi(d.axis) }
            if to.width >= 1, to.height >= 1, l.resize(id, to: CGRect(to.x0, to.y0, to.x1, to.y1), area: area, gaps: gaps) {
                dragged += 1
                let now = TileBox(l.frames(in: area, gaps: gaps)[id]!)
                for e in TileDirection.allCases where e != d {
                    XCTAssertEqual(edge(now, e), edge(was, e), accuracy: 1, "seed \(seed): the \(e) edge moved with the \(d) one")
                }
                let moved = (edge(now, d) - edge(was, d)) * (d.back ? -1 : 1)
                XCTAssertTrue(moved * by >= 0 && abs(moved) <= abs(by) + 1, "seed \(seed): \(moved) for \(by)")
            }
            var steps = 0
            while l.move(id, toward: d, area: area) {
                steps += 1
                if steps > 60 { return XCTFail("seed \(seed): moving \(d) never reaches the edge") }
            }
            XCTAssertNil(l.neighbor(of: id, toward: d, in: area, gaps: gaps))
        }
        XCTAssertGreaterThan(dragged, 100)
    }

    private var failed: Bool { (testRun?.totalFailureCount ?? 0) > 0 }

    private func check(_ l: TileLayout, _ r: inout TileRandom, _ area: CGRect, _ gaps: TileGaps, _ minimums: [WindowID: CGSize],
                       _ at: String) throws {
        let ids = l.windows
        XCTAssertEqual(Set(ids).count, ids.count, "\(at): a window twice")
        if l.style == .main, let top = l.root?[split: []] {
            let stack = top.parts.count == 2 ? top.parts[1].node : nil
            let flat: Bool = { if case .split(let s)? = stack { return s.parts.count == ids.count - 1 } else { return ids.count == 2 } }()
            XCTAssertTrue(flat && top.parts[0].node == .window(ids[0]), "\(at): not one main window and one stack")
        }
        XCTAssertEqual(try JSONDecoder().decode(TileLayout.self, from: JSONEncoder().encode(l)), l, at)
        let box = try XCTUnwrap(gaps.inset(area))
        for minimums in [[:], minimums] {
            let frames = l.frames(in: area, gaps: gaps, minimums: minimums)
            XCTAssertEqual(Set(frames.keys), Set(ids), at)
            guard !ids.isEmpty else { return }
            let tiles = ids.map { TileBox(frames[$0]!) }
            var covered = 0.0
            for t in tiles {
                XCTAssertTrue([t.x0, t.y0, t.x1, t.y1].allSatisfy { $0 == $0.rounded() }, "\(at): not whole points")
                XCTAssertTrue(t.x0 >= box.x0 && t.y0 >= box.y0 && t.x1 <= box.x1 && t.y1 <= box.y1 && t.width >= 1 && t.height >= 1, "\(at): outside")
                covered += (t.width + gaps.inner) * (t.height + gaps.inner)
            }
            if l.full {
                XCTAssertTrue(tiles.allSatisfy { $0 == box }, at)
                continue
            }
            XCTAssertEqual(covered, (box.width + gaps.inner) * (box.height + gaps.inner), "\(at): tiles and gaps don't fill the area")
            for i in tiles.indices {
                for j in 0..<i {
                    let a = tiles[i], b = tiles[j]
                    XCTAssertTrue(a.x1 + gaps.inner <= b.x0 || b.x1 + gaps.inner <= a.x0 || a.y1 + gaps.inner <= b.y0 || b.y1 + gaps.inner <= a.y0,
                                  "\(at): tiles \(ids[i]) and \(ids[j]) overlap or are closer than the gap")
                }
            }
            let solver = TileSolver(l.root!, in: box, gap: gaps.inner, minimums: minimums), grown = solver.grown(box)
            if TileAxis.allCases.allSatisfy({ solver.need(l.root!, $0) <= grown.length($0) }) {
                for (id, m) in minimums {
                    guard let f = frames[id] else { continue }
                    XCTAssertTrue(f.width >= m.width && f.height >= m.height, "\(at): \(id) is under its minimum though all fit")
                }
            }
        }
        checkFocus(l, ids[r.below(ids.count)], area, gaps, box, at)
    }

    private func checkFocus(_ l: TileLayout, _ id: WindowID, _ area: CGRect, _ gaps: TileGaps, _ box: TileBox, _ at: String) {
        let back: [TileDirection: TileDirection] = [.left: .right, .right: .left, .up: .down, .down: .up]
        let frames = l.frames(in: area, gaps: gaps)
        for d in TileDirection.allCases {
            guard let over = l.neighbor(of: id, toward: d, in: area, gaps: gaps) else {
                if l.full { continue }
                let f = TileBox(frames[id]!)
                XCTAssertEqual(d.back ? f.lo(d.axis) : f.hi(d.axis), d.back ? box.lo(d.axis) : box.hi(d.axis), "\(at): no neighbor, not at the edge")
                var moved = l
                XCTAssertFalse(moved.move(id, toward: d, area: area), "\(at): moved \(d) off the edge")
                XCTAssertEqual(moved, l)
                continue
            }
            XCTAssertEqual(l.neighbor(of: over, toward: back[d]!, in: area, gaps: gaps, recent: [99, id]), id, "\(at): \(d) and back")
            if l.full { continue }
            var moved = l
            XCTAssertTrue(moved.move(id, toward: d, area: area), "\(at): \(d) has a neighbor")
            XCTAssertNotEqual(moved.frames(in: area, gaps: gaps)[id], frames[id], "\(at): a move that shows nothing")
        }
    }
}
