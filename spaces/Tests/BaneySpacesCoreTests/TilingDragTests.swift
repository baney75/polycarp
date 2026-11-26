import XCTest
@testable import BaneySpacesCore

final class TilingDragTests: XCTestCase {
    private let frame = CGRect(x: 100, y: 100, width: 400, height: 300)
    private let p = CGPoint(x: 700, y: 500)

    private func drag(_ to: CGRect?...) -> TilingDrag {
        var d = TilingDrag(window: 5, press: frame)
        for f in to { d.saw(f) }
        return d
    }

    private func end(_ d: TilingDrag, at point: CGPoint? = CGPoint(x: 700, y: 500), floating: Bool = false, taken: Bool = false,
                     under: DisplayKey? = "main") -> TilingDrag.Release {
        d.release(at: point, floating: floating, taken: taken, under: under, home: "main")
    }

    func testTheFirstChangeSaysWhatTheDragIs() {
        XCTAssertEqual(drag(frame, nil).phase, .still)
        XCTAssertEqual(drag(frame.offsetBy(dx: 1, dy: 0)).phase, .still, "a point is no drag")
        XCTAssertEqual(drag(frame.offsetBy(dx: 30, dy: 0)).phase, .moving)
        XCTAssertEqual(drag(frame.offsetBy(dx: 0, dy: 30)).phase, .moving, "straight down")
        XCTAssertEqual(drag(CGRect(x: 100, y: 100, width: 400, height: 340)).phase, .resizing, "the bottom edge")
        XCTAssertEqual(drag(CGRect(x: 100, y: 100, width: 401, height: 301)).phase, .still, "an app's own point of rounding is no pull")
        XCTAssertEqual(drag(CGRect(x: 60, y: 100, width: 440, height: 300)).phase, .resizing, "the left edge moves the window too")
        XCTAssertEqual(drag(frame.offsetBy(dx: 30, dy: 0), CGRect(x: 60, y: 100, width: 200, height: 300)).phase, .moving)
        XCTAssertEqual(drag(CGRect(x: 100, y: 100, width: 440, height: 300), frame.offsetBy(dx: 30, dy: 0)).phase, .resizing)
    }

    func testWhatAReleaseDoes() {
        let moving = drag(frame.offsetBy(dx: 30, dy: 0)), pulled = drag(CGRect(x: 100, y: 100, width: 440, height: 300))
        XCTAssertEqual(end(drag(frame)), .nothing, "a click")
        XCTAssertEqual(end(moving), .drop(p))
        XCTAssertEqual(end(moving, floating: true), .float)
        XCTAssertEqual(end(moving, under: "side"), .across("side", p))
        XCTAssertEqual(end(moving, under: nil), .drop(p))
        XCTAssertEqual(end(moving, taken: true), .nothing, "the overview took it")
        XCTAssertEqual(end(moving, at: nil), .back, "nothing says where it was let go")
        XCTAssertEqual(end(pulled), .resize)
        XCTAssertEqual(end(pulled, floating: true), .resize, "the key floats a window that is carried")
        XCTAssertEqual(end(pulled, under: "side"), .resize)
    }

    func testEscapeSendsItBack() {
        for var d in [drag(frame.offsetBy(dx: 30, dy: 0)), drag(CGRect(x: 100, y: 100, width: 440, height: 300))] {
            d.cancelled = true
            XCTAssertEqual(end(d), .back)
            XCTAssertEqual(end(d, floating: true), .back)
            XCTAssertEqual(end(d, taken: true), .nothing)
        }
    }

    func testItWaitsUntilTheWindowHoldsStill() {
        var d = drag()
        let looks = (0..<9).map { d.settled(frame.offsetBy(dx: Double(min($0, 3)), dy: 0)) }
        XCTAssertEqual(looks.firstIndex(of: true), 6, "still from the fourth look, for three more")
        var still = drag()
        XCTAssertEqual((0..<9).map { _ in still.settled(frame) }.firstIndex(of: true), 4, "never sooner than a tenth of a second")
        var restless = drag()
        XCTAssertEqual((0..<40).map { restless.settled(frame.offsetBy(dx: Double($0), dy: 0)) }.firstIndex(of: true), 24, "nor later than half a second")
    }
}
