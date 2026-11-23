import XCTest
@testable import BaneySpacesCore

/// Donovan, 2026-11-23: with Polycarp's bar up, macOS's menu bar must not come in any form. It slid in each time the
/// pointer touched the top edge (Shotate recording 10.05.47), so the pointer is held under that edge. One point was
/// too shallow: macOS also reveals its bar with the pointer at 2 (live check of #619).
final class MenuBarEdgeTests: XCTestCase {
    private let main = MenuBarEdge.Screen(x: 0, y: 0, width: 1512, height: 982)

    func testThePointerAtTheTopIsHeldOnePointUnderIt() {
        let edges = MenuBarEdge.edges(guarded: [main], all: [main])
        XCTAssertEqual(edges, [MenuBarEdge.Edge(minX: 0, maxX: 1512, top: 0)])
        let held = MenuBarEdge.clamp(x: 700, y: 0, edges: edges)
        XCTAssertEqual(held?.x, 700)
        XCTAssertEqual(held?.y, 4)
        XCTAssertEqual(MenuBarEdge.clamp(x: 700, y: 2, edges: edges)?.y, 4, "macOS reveals its bar from 2 points down")
        XCTAssertEqual(MenuBarEdge.clamp(x: 700, y: 3.9, edges: edges)?.y, 4)
    }

    func testThePointerBelowTheEdgeIsLeftAlone() {
        let edges = MenuBarEdge.edges(guarded: [main], all: [main])
        XCTAssertNil(MenuBarEdge.clamp(x: 700, y: 4, edges: edges))
        XCTAssertNil(MenuBarEdge.clamp(x: 700, y: 500, edges: edges))
    }

    func testAScreenWithoutTheBarIsNotGuarded() {
        let side = MenuBarEdge.Screen(x: 1512, y: 0, width: 1920, height: 1080)
        let edges = MenuBarEdge.edges(guarded: [main], all: [main, side])
        XCTAssertNil(MenuBarEdge.clamp(x: 2000, y: 0, edges: edges))
    }

    func testAnEdgeUnderAnotherScreenIsAWayAcrossNotAnEdge() {
        let above = MenuBarEdge.Screen(x: 200, y: -1080, width: 1920, height: 1080)
        let edges = MenuBarEdge.edges(guarded: [main, above], all: [main, above])
        XCTAssertEqual(edges, [MenuBarEdge.Edge(minX: 0, maxX: 200, top: 0), MenuBarEdge.Edge(minX: 200, maxX: 2120, top: -1080)])
        XCTAssertNil(MenuBarEdge.clamp(x: 700, y: 0, edges: edges), "crossing up to the screen above")
        XCTAssertEqual(MenuBarEdge.clamp(x: 700, y: -1080, edges: edges)?.y, -1076)
    }

    /// Review r1 of #619 (first-F1, sol-F1): a screen partly under another keeps the rest of its top edge guarded.
    func testThePartOfAnEdgeWithNothingAboveIsStillGuarded() {
        let above = MenuBarEdge.Screen(x: 200, y: -1080, width: 1000, height: 1080)
        let edges = MenuBarEdge.edges(guarded: [main], all: [main, above])
        XCTAssertEqual(edges, [MenuBarEdge.Edge(minX: 0, maxX: 200, top: 0), MenuBarEdge.Edge(minX: 1200, maxX: 1512, top: 0)])
        XCTAssertEqual(MenuBarEdge.clamp(x: 100, y: 0, edges: edges)?.y, 4)
        XCTAssertNil(MenuBarEdge.clamp(x: 700, y: 0, edges: edges), "crossing up")
        XCTAssertEqual(MenuBarEdge.clamp(x: 1400, y: 0, edges: edges)?.y, 4)
    }
}
