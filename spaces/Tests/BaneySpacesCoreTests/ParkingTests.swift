import BaneySpacesCore
import CoreGraphics
import XCTest

/// Where a parked window waits (`Parking.place`), how it gets there (`Parking.route`), and when it counts as there
/// (`Parking.landed`). The switch code lives in the app target, which tests can't import, so its order is read from source.
final class ParkingTests: XCTestCase {
    let laptop = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let window = CGSize(width: 800, height: 600)

    func frame(on d: CGRect) -> CGRect { CGRect(x: d.midX - 400, y: d.midY - 300, width: 800, height: 600) }

    func testOneDisplayParksInItsBottomRightCornerAsBefore() {
        let p = Parking.place(frame(on: laptop), screens: [laptop])
        XCTAssertEqual(p.corner, .bottomRight)
        XCTAssertEqual(p.spot, Geometry.hidingSpot(screens: [laptop]))
        XCTAssertEqual(p.spot, CGPoint(x: 1511, y: 981))
    }

    func testANeighborBelowTheRightCornerSendsTheWindowLeft() {
        // A taller display to the right reaches below the laptop's bottom edge: the bottom-right spot would draw the
        // window on it, so it waits off the laptop's left edge instead.
        let right = CGRect(x: 1512, y: -100, width: 2560, height: 1440)
        let p = Parking.place(frame(on: laptop), screens: [laptop, right])
        XCTAssertEqual(p.corner, .bottomLeft)
        XCTAssertEqual(p.spot, CGPoint(x: 1 - 800, y: 981))
        // The furthest corner of all (the old spot) would have moved it to the other display.
        XCTAssertNotEqual(p.spot, Geometry.hidingSpot(screens: [laptop, right]))
        // A window on the big display keeps its own bottom-right corner.
        XCTAssertEqual(Parking.place(frame(on: right), screens: [laptop, right]).spot, CGPoint(x: 4071, y: 1339))
    }

    func testNeighborsOnBothSidesFallBackToTheCornerThatHangsOffEveryDisplay() {
        let left = CGRect(x: -1920, y: 0, width: 1920, height: 1200)
        let right = CGRect(x: 1512, y: 0, width: 1920, height: 1200)
        let screens = [laptop, left, right]
        let p = Parking.place(frame(on: laptop), screens: screens)
        XCTAssertEqual(p.corner, .furthest)
        XCTAssertEqual(p.spot, CGPoint(x: 3431, y: 1199))
        XCTAssertLessThanOrEqual(shown(CGRect(origin: p.spot, size: window), screens), 1)
    }

    func testAWindowOnNoDisplayGoesToTheFurthestCorner() {
        let gone = CGRect(x: 5000, y: 5000, width: 800, height: 600)
        XCTAssertEqual(Parking.place(gone, screens: [laptop]).corner, .furthest)
        XCTAssertEqual(Parking.place(.null, screens: [laptop]).corner, .furthest)
        XCTAssertEqual(Parking.place(frame(on: laptop), screens: []).spot, .zero)
    }

    /// Every arrangement of two or three displays touching edge to edge: a parked window shows at most its one-point
    /// corner, and that corner is on its own display unless no corner there was free.
    func testNoArrangementShowsAParkedWindowOnAnotherDisplay() {
        var rng = SplitMix(seed: 7)
        var cornersSeen = Set<Parking.Corner>()
        for _ in 0..<2000 {
            var screens = [laptop]
            for _ in 0..<Int(rng.next() % 3) {
                let base = screens[Int(rng.next() % UInt64(screens.count))]
                let w = CGFloat(800 + rng.next() % 2000), h = CGFloat(600 + rng.next() % 1200)
                let slide = CGFloat(Int(rng.next() % 1600) - 800)
                let candidate: CGRect
                switch rng.next() % 4 {
                case 0: candidate = CGRect(x: base.maxX, y: base.minY + slide, width: w, height: h)
                case 1: candidate = CGRect(x: base.minX - w, y: base.minY + slide, width: w, height: h)
                case 2: candidate = CGRect(x: base.minX + slide, y: base.maxY, width: w, height: h)
                default: candidate = CGRect(x: base.minX + slide, y: base.minY - h, width: w, height: h)
                }
                if !screens.contains(where: { $0.intersects(candidate) }) { screens.append(candidate) }
            }
            let own = screens[Int(rng.next() % UInt64(screens.count))]
            let size = CGSize(width: CGFloat(300 + rng.next() % 2000), height: CGFloat(200 + rng.next() % 1400))
            let f = CGRect(x: own.midX - size.width / 2, y: own.midY - size.height / 2, width: size.width, height: size.height)
            let p = Parking.place(f, screens: screens)
            cornersSeen.insert(p.corner)
            let parked = CGRect(origin: p.spot, size: f.size)
            XCTAssertLessThanOrEqual(shown(parked, screens), 1, "\(screens) \(f) parked at \(p)")
            XCTAssertTrue(Geometry.isStranded(parked, screens: screens))
            if p.corner != .furthest {
                let home = Geometry.display(of: f, in: Dictionary(uniqueKeysWithValues: screens.enumerated().map { ($0.offset, $0.element) }))
                XCTAssertEqual(parked.intersection(screens[home!]).width, 1, "the one point left is on the window's own display")
            }
        }
        XCTAssertEqual(cornersSeen, [.bottomRight, .bottomLeft, .furthest], "the arrangements reach every branch")
    }

    func testOnlyAnAnimatingAppInSightHidesAroundItsMove() {
        var asked = 0
        func covered(_ v: Bool) -> () -> Bool { { asked += 1; return v } }
        // The common case: no hide, and the window list isn't even read.
        XCTAssertEqual(Parking.route(hidden: false, animates: false, undoesMovesOnUnhide: false, covered: covered(false)), .direct)
        XCTAssertEqual(asked, 0)
        XCTAssertEqual(Parking.route(hidden: true, animates: true, undoesMovesOnUnhide: false, covered: covered(false)), .direct)
        // T3 Code puts a window back when unhidden: hiding around the move would undo it.
        XCTAssertEqual(Parking.route(hidden: false, animates: true, undoesMovesOnUnhide: true, covered: covered(false)), .direct)
        XCTAssertEqual(asked, 0)
        XCTAssertEqual(Parking.route(hidden: false, animates: true, undoesMovesOnUnhide: false, covered: covered(true)), .direct)
        XCTAssertEqual(Parking.route(hidden: false, animates: true, undoesMovesOnUnhide: false, covered: covered(false)), .whileHidden)
        XCTAssertEqual(asked, 2)
    }

    func testAWindowAtItsSpotHasLandedWithoutWaiting() {
        let spot = CGPoint(x: 1511, y: 981)
        let parked = CGRect(origin: spot, size: window)
        XCTAssertTrue(Parking.landed(parked, target: spot, away: true, still: 0, screens: [laptop]))
        // Placed a few points off by its app: it must hold still out of sight first.
        let near = parked.offsetBy(dx: -3, dy: 0)
        XCTAssertFalse(Parking.landed(near, target: spot, away: true, still: 0.01, screens: [laptop]))
        XCTAssertTrue(Parking.landed(near, target: spot, away: true, still: 0.05, screens: [laptop]))
        // Still in sight is not parked; still in sight is home.
        let home = frame(on: laptop)
        XCTAssertFalse(Parking.landed(home, target: spot, away: true, still: 1, screens: [laptop]))
        XCTAssertTrue(Parking.landed(home, target: home.origin.applying(.init(translationX: 5, y: 0)), away: false, still: 0.05, screens: [laptop]))
        XCTAssertTrue(Parking.landed(home, target: home.origin, away: false, still: 0, screens: [laptop]))
    }

    /// AeroSpace's order (`layoutWorkspaces`): what this workspace shows comes back before anything else leaves, so there
    /// is never a frame with neither. In `Spaces.apply`: parked windows home, then apps shown, then apps hidden, then
    /// windows parked; and both moves go by `Parking.route`, not a hide around every move.
    func testASwitchShowsBeforeItHides() throws {
        let text = try source("Sources/BaneySpaces/Spaces.swift")
        let apply = try XCTUnwrap(text.range(of: "private func apply(_ plan: SwitchPlan"))
        let body = String(text[apply.lowerBound...].prefix(20000))
        let steps = ["bringHome(home", "app.isHidden { app.unhide() }", "conceal(how, apps: how.hideApps", "target.focus()",
                     "conceal(how, apps: deferred", "park(how, parkedApps:"]
        let at = try steps.map { step in try XCTUnwrap(body.range(of: step), "apply lost \(step)").lowerBound }
        XCTAssertEqual(at, at.sorted(), "apply must show, then focus, then hide: \(steps)")
        XCTAssertEqual(text.components(separatedBy: "Parking.route(").count - 1, 2, "bringHome and park each choose a route")
        XCTAssertFalse(text.contains("let spot = Geometry.hidingSpot"), "each window parks at its own display's corner")
    }

    private func shown(_ r: CGRect, _ screens: [CGRect]) -> CGFloat {
        screens.reduce(0) { sum, s in let i = s.intersection(r); return i.isNull ? sum : sum + i.width * i.height }
    }

    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { $0.components(separatedBy: "//")[0] }
            .joined(separator: "\n")
    }
}

/// A small seeded generator, so the arrangement sweep is the same on every run.
struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
