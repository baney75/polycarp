import CoreGraphics
import XCTest
@testable import BaneySpacesCore

/// Item C: double and triple clicks through `click-at`'s pointer route; right click through `ContextMenu`.
final class ClickStyleTests: XCTestCase {
    let p = CGPoint(x: 120, y: 80)

    func testOneClickIsTheSameScriptAsBefore() {
        XCTAssertEqual(InputScript.click(at: p, count: 1), [.mouseDown(p), .mouseUp(p)])
    }

    func testADoubleClickCountsItsClickStateUp() {
        XCTAssertEqual(InputScript.click(at: p, count: 2), [.buttonDown(p, state: 1), .buttonUp(p, state: 1), .buttonDown(p, state: 2), .buttonUp(p, state: 2)])
        XCTAssertEqual(InputScript.click(at: p, count: 3).count, 6)
    }

    /// r1 first-F1 and first-F4: the stamped fields of the events a double click posts, by value. Every click says the
    /// left button (field 3 is 0) with its own click state, and is a click (subtype 3), not part of a drag.
    func testTheStampedFieldsOfADoubleClick() throws {
        let stamps = try InputScript.click(at: p, count: 2).map { try XCTUnwrap(PointerStamp.of($0, drag: false)) }
        XCTAssertEqual(stamps.map(\.kind), [.leftDown, .leftUp, .leftDown, .leftUp])
        XCTAssertEqual(stamps.map(\.state), [1, 1, 2, 2])
        XCTAssertEqual(stamps.map(\.button), [0, 0, 0, 0])
        XCTAssertEqual(stamps.map(\.subtype), [3, 3, 3, 3])
        XCTAssertLessThan(stamps.map(\.pause).reduce(0, +), 0.5, "inside the double-click interval")
        let drag = try InputScript.drag(path: [p, CGPoint(x: 140, y: 80)]).map { try XCTUnwrap(PointerStamp.of($0, drag: true)) }
        XCTAssertEqual(drag.map(\.kind), [.leftDown, .leftDragged, .leftUp])
        XCTAssertEqual(drag.map(\.subtype), [0, 0, 0], "a drag's events are not clicks")
        XCTAssertEqual(PointerStamp.of(.mouseMoved(p), drag: false)?.state, 0)
        XCTAssertNil(PointerStamp.of(.keyDown(KeyChord(keyCode: 0, flags: 0, label: "a")), drag: false))
    }

    /// r2 second-F3: a stop is asked only before a press, never between a press and its release. The path that can
    /// hold a click is an event that can't be made: the second press fails, and the first click is already released.
    func testADoubleClickWhoseSecondPressCantBeMadeLeavesNoButtonDown() {
        let report = EventRunner.run(InputScript.click(at: p, count: 2), stop: { nil }) { e in
            e == .buttonDown(p, state: 2) ? nil : {}
        }
        XCTAssertEqual(report.posted, [.buttonDown(p, state: 1), .buttonUp(p, state: 1)])
        XCTAssertEqual(report.stopped?.code, .engineError)
        let unmadeRelease = EventRunner.run([.buttonDown(p, state: 1), .buttonUp(p, state: 1)], stop: { nil }) { e in
            e == .buttonUp(p, state: 1) ? nil : {}
        }
        XCTAssertEqual(unmadeRelease.posted, [], "a press whose release can't be made is never posted")
        XCTAssertEqual(unmadeRelease.stopped?.code, .engineError)
        let held = EventRunner.run([.buttonDown(p, state: 2)], stop: { nil }) { _ in {} }
        XCTAssertEqual(held.posted, [.buttonDown(p, state: 2), .buttonUp(p, state: 2)], "a press the script never released is released at the end")
        XCTAssertEqual(held.released, 1)
    }

    /// Context menus: a right click is one click, `item` goes only with it, and other buttons are refused.
    func testCountIsCheckedAndARightClickIsOneClick() throws {
        XCTAssertEqual(try ClickStyle.parse(count: nil, button: nil).get(), .single)
        XCTAssertEqual(try ClickStyle.parse(count: 2, button: "LEFT").get(), ClickStyle(count: 2))
        XCTAssertEqual(try ClickStyle.parse(count: nil, button: "right").get(), ClickStyle(count: 1, right: true))
        XCTAssertEqual(try ClickStyle.parse(count: 1, button: "Right", item: "Rename").get(), ClickStyle(count: 1, right: true, item: "Rename"))
        for (count, button, item) in [(0, "left", nil), (4, "left", nil), (1, "middle", nil), (2, "right", nil), (1, "left", "Rename"), (1, "right", " ")] as [(Int, String, String?)] {
            guard case .failure(let e) = ClickStyle.parse(count: count, button: button, item: item) else { return XCTFail("\(count) \(button) \(item ?? "")") }
            XCTAssertEqual(e.code, .badArguments)
            XCTAssertEqual(e.nextCall, .null)
        }
        let tool = try XCTUnwrap(HandsTools.all.first { $0.verb == "click-at" })
        XCTAssertTrue(tool.summary.contains(#""count":2}"#), "one example call")
        XCTAssertTrue(tool.params.contains { $0.name == "item" })
        XCTAssertTrue(tool.params.first { $0.name == "button" }?.help.contains("never leaves a menu open") == true)
    }
}
