import CoreGraphics
import XCTest
@testable import BaneySpacesCore

/// Item C: double, triple and right clicks through `click-at`'s pointer route.
final class ClickStyleTests: XCTestCase {
    let p = CGPoint(x: 120, y: 80)

    func testOneLeftClickIsTheSameScriptAsBefore() {
        XCTAssertEqual(InputScript.click(at: p, count: 1, right: false), [.mouseDown(p), .mouseUp(p)])
    }

    func testADoubleClickCountsItsClickStateUp() {
        let one = InputEvent.Click(right: false, state: 1), two = InputEvent.Click(right: false, state: 2)
        XCTAssertEqual(InputScript.click(at: p, count: 2, right: false), [.buttonDown(p, one), .buttonUp(p, one), .buttonDown(p, two), .buttonUp(p, two)])
        XCTAssertEqual(InputScript.click(at: p, count: 3, right: false).count, 6)
        let r = InputEvent.Click(right: true, state: 1)
        XCTAssertEqual(InputScript.click(at: p, count: 1, right: true), [.buttonDown(p, r), .buttonUp(p, r)])
    }

    /// A stop after the first press still releases it, with the same click: no button is left held.
    func testAStoppedDoubleClickLeavesNoButtonDown() {
        var calls = 0
        let report = EventRunner.run(InputScript.click(at: p, count: 2, right: false), stop: {
            calls += 1
            return calls > 1 ? HandsError(.inUse, "back", suggestion: "") : nil
        }) { _ in {} }
        let one = InputEvent.Click(right: false, state: 1)
        XCTAssertEqual(report.posted, [.buttonDown(p, one), .buttonUp(p, one)])
        XCTAssertNotNil(report.stopped)
        let right = InputEvent.Click(right: true, state: 1)
        let held = EventRunner.run([.buttonDown(p, right)], stop: { nil }) { _ in {} }
        XCTAssertEqual(held.posted, [.buttonDown(p, right), .buttonUp(p, right)], "a press the script never released is released at the end")
        XCTAssertEqual(held.released, 1)
    }

    func testCountAndButtonAreChecked() {
        XCTAssertEqual(try ClickStyle.parse(count: nil, button: nil).get(), .single)
        XCTAssertEqual(try ClickStyle.parse(count: 2, button: "LEFT").get(), ClickStyle(count: 2, right: false))
        XCTAssertEqual(try ClickStyle.parse(count: nil, button: "right").get(), ClickStyle(count: 1, right: true))
        for (count, button) in [(0, "left"), (4, "left"), (2, "right"), (1, "middle")] as [(Int, String)] {
            guard case .failure(let e) = ClickStyle.parse(count: count, button: button) else { return XCTFail("\(count) \(button)") }
            XCTAssertEqual(e.code, .badArguments)
            XCTAssertEqual(e.nextCall, .null)
        }
        let tool = HandsTools.all.first { $0.verb == "click-at" }
        XCTAssertEqual(tool?.params.filter { ["count", "button"].contains($0.name) }.count, 2)
        XCTAssertTrue(tool?.summary.contains(#""count":2}"#) == true, "one example call")
    }

    /// The poster and router live in the app target: their source posts the right button with the counted click state.
    func testThePosterAndRouterCarryTheStyle() throws {
        let poster = try HandsSourceTests.code("Sources/BaneySpaces/Hands/BackgroundPoster.swift")
        XCTAssertTrue(poster.contains("c.right ? .rightMouseDown : .leftMouseDown, p, Int64(c.state)"))
        XCTAssertTrue(poster.contains("mouseButton: button"))
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Background.swift")
        XCTAssertTrue(router.contains(#"ClickStyle.parse(count: req.int("count"), button: req.string("button"))"#))
        XCTAssertTrue(router.contains("InputScript.click(at: path[0], count: style.count, right: style.right)"))
    }
}
