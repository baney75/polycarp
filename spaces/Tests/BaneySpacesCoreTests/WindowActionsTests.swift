@testable import BaneySpacesCore
import CoreGraphics
import XCTest

/// Window actions (K2, W1): the frame math on three display layouts. Every frame lies inside the usable area (2 points is
/// the live probe's tolerance; the math itself is exact), halves and thirds tile it with no gap, and a repeat cycles sizes.
final class WindowActionsTests: XCTestCase {
    /// Accessibility coordinates, y down. Visible frames as macOS gives them, less a menu bar on each display.
    static let layouts: [(name: String, visible: CGRect, dock: (edge: DockEdge, thickness: CGFloat)?)] = [
        ("laptop alone", CGRect(x: 0, y: 33, width: 1512, height: 945), nil),
        ("wide display to the right, odd width", CGRect(x: 1512, y: 25, width: 2561, height: 1415), nil),
        ("portrait display to the left, Polycarp's dock pinned at its bottom", CGRect(x: -1080, y: -375, width: 1080, height: 1895), (.bottom, 72)),
    ]

    func testEveryPlacementLandsInsideTheUsableAreaOnEveryLayout() {
        for l in Self.layouts {
            let area = WindowLayout.usable(visible: l.visible, dock: l.dock)
            XCTAssertTrue(l.visible.contains(area))
            for p in Placement.allCases {
                for step in 0..<p.steps {
                    let r = WindowLayout.rect(p, in: area, step: step)
                    XCTAssertTrue(area.insetBy(dx: -2, dy: -2).contains(r), "\(l.name) \(p) step \(step): \(r) outside \(area)")
                    XCTAssertTrue(area.contains(r), "\(l.name) \(p) step \(step)")
                    XCTAssertEqual(r, r.integral, "\(l.name) \(p): whole points")
                    XCTAssertGreaterThan(r.width * r.height, 0)
                }
            }
            for a in [WindowAction.center, .grow, .shrink] {
                let start = CGRect(x: area.minX - 40, y: area.minY + 10, width: 900, height: 700)
                let r = a == .center ? WindowLayout.centered(start, in: area)
                    : WindowLayout.resized(start, by: a == .grow ? 30 : -30, in: area)
                XCTAssertTrue(area.contains(r), "\(l.name) \(a)")
            }
        }
        XCTAssertEqual(WindowLayout.usable(visible: Self.layouts[2].visible, dock: (.bottom, 72)).maxY, 1520 - 72)
    }

    func testHalvesAndThirdsTileTheAreaWithNoGap() {
        for l in Self.layouts {
            let a = WindowLayout.usable(visible: l.visible, dock: l.dock)
            let left = WindowLayout.rect(.leftHalf, in: a), right = WindowLayout.rect(.rightHalf, in: a)
            XCTAssertEqual(left.maxX, right.minX, l.name)
            XCTAssertEqual(left.union(right), a, l.name)
            let top = WindowLayout.rect(.topHalf, in: a), bottom = WindowLayout.rect(.bottomHalf, in: a)
            XCTAssertEqual(top.union(bottom), a, l.name)
            XCTAssertEqual(top.maxY, bottom.minY, l.name)
            let thirds = [Placement.firstThird, .centerThird, .lastThird].map { WindowLayout.rect($0, in: a) }
            XCTAssertEqual(thirds[0].union(thirds[1]).union(thirds[2]), a, l.name)
            XCTAssertEqual(WindowLayout.rect(.firstTwoThirds, in: a), thirds[0].union(thirds[1]), l.name)
            XCTAssertEqual(WindowLayout.rect(.lastTwoThirds, in: a), thirds[1].union(thirds[2]), l.name)
            let quarters = [Placement.topLeft, .topRight, .bottomLeft, .bottomRight].map { WindowLayout.rect($0, in: a) }
            XCTAssertEqual(quarters.dropFirst().reduce(quarters[0]) { $0.union($1) }, a, l.name)
            if a.height > a.width {
                XCTAssertEqual(thirds[0].width, a.width, "a portrait display's thirds run down it")
            } else {
                XCTAssertEqual(thirds[0].height, a.height)
            }
        }
    }

    func testARepeatCyclesHalfTwoThirdsThird() {
        let a = Self.layouts[0].visible
        XCTAssertEqual(WindowLayout.rect(.leftHalf, in: a, step: 0), CGRect(x: 0, y: 33, width: 756, height: 945))
        XCTAssertEqual(WindowLayout.rect(.leftHalf, in: a, step: 1), CGRect(x: 0, y: 33, width: 1008, height: 945))
        XCTAssertEqual(WindowLayout.rect(.leftHalf, in: a, step: 2), CGRect(x: 0, y: 33, width: 504, height: 945))
        XCTAssertEqual(WindowLayout.rect(.leftHalf, in: a, step: 3), WindowLayout.rect(.leftHalf, in: a))
        XCTAssertEqual(WindowLayout.rect(.rightHalf, in: a, step: 1), CGRect(x: 504, y: 33, width: 1008, height: 945))
        XCTAssertEqual(WindowLayout.rect(.firstThird, in: a, step: 1), WindowLayout.rect(.centerThird, in: a))

        var m = WindowActionMemory()
        let start = CGRect(x: 100, y: 100, width: 800, height: 600)
        XCTAssertEqual(m.step(.place(.leftHalf), window: 7, frame: start), 0)
        m.willMove(7, from: start)
        // A terminal snaps to its text cells and lands a point short: still a repeat.
        m.landed(7, .place(.leftHalf), step: 0, at: CGRect(x: 0, y: 33, width: 755, height: 944))
        XCTAssertEqual(m.step(.place(.leftHalf), window: 7, frame: CGRect(x: 0, y: 33, width: 755, height: 944)), 1)
        XCTAssertEqual(m.step(.place(.rightHalf), window: 7, frame: CGRect(x: 0, y: 33, width: 755, height: 944)), 0, "another action starts over")
        XCTAssertEqual(m.step(.place(.leftHalf), window: 7, frame: CGRect(x: 40, y: 80, width: 755, height: 944)), 0, "moved by hand: starts over")
        m.willMove(7, from: CGRect(x: 0, y: 33, width: 755, height: 944))
        XCTAssertEqual(m.restore(7), start, "restore goes back to before the first action, not between actions")
        XCTAssertNil(m.restore(7))
    }

    func testFocusAndSwapPickTheNearestWindowThatWay() {
        let me = CGRect(x: 800, y: 100, width: 600, height: 600)
        let others: [(id: WindowID, frame: CGRect)] = [
            (1, CGRect(x: 0, y: 900, width: 300, height: 300)),     // left but far below
            (2, CGRect(x: 100, y: 120, width: 500, height: 500)),   // left, beside it
            (3, CGRect(x: 1500, y: 100, width: 400, height: 400)),  // right
            (4, CGRect(x: 820, y: 760, width: 500, height: 300)),   // below
        ]
        XCTAssertEqual(WindowLayout.neighbor(of: me, toward: .left, among: others), 2)
        XCTAssertEqual(WindowLayout.neighbor(of: me, toward: .right, among: others), 3)
        XCTAssertEqual(WindowLayout.neighbor(of: me, toward: .down, among: others), 4)
        XCTAssertNil(WindowLayout.neighbor(of: me, toward: .up, among: others))
        XCTAssertNil(WindowLayout.neighbor(of: me, toward: .left, among: [(5, me)]), "a window on top of it is no way")
    }

    func testNextDisplayGoesLeftToRightAndWraps() {
        let d: [(key: DisplayKey, frame: CGRect)] = [("main", CGRect(x: 0, y: 0, width: 1512, height: 982)),
                                                    ("right", CGRect(x: 1512, y: -200, width: 2560, height: 1440)),
                                                    ("left", CGRect(x: -1080, y: -400, width: 1080, height: 1920))]
        XCTAssertEqual(WindowLayout.display(after: "left", in: d), "main")
        XCTAssertEqual(WindowLayout.display(after: "main", in: d), "right")
        XCTAssertEqual(WindowLayout.display(after: "right", in: d), "left")
        XCTAssertEqual(WindowLayout.display(after: "main", in: d, backward: true), "left")
        XCTAssertNil(WindowLayout.display(after: "main", in: [d[0]]))
    }

    func testEveryWindowActionSpellingReadsBack() {
        for a in WindowAction.all {
            XCTAssertEqual(WindowAction.parse(a.spelling), a)
            XCTAssertFalse(a.title.isEmpty)
        }
        XCTAssertEqual(Set(WindowAction.all.map(\.spelling)).count, WindowAction.all.count)
    }
}
