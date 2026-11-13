import CoreGraphics
import XCTest
@testable import BaneySpacesCore

/// Item C: double and triple clicks through `click-at`'s pointer route; right click refused for now.
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

    /// r1 first-F2 and second-F5: right click is refused until a context menu can be proved and kept off Donovan's screen.
    func testCountIsCheckedAndRightClickIsNotAvailableYet() throws {
        XCTAssertEqual(try ClickStyle.parse(count: nil, button: nil).get(), .single)
        XCTAssertEqual(try ClickStyle.parse(count: 2, button: "LEFT").get(), ClickStyle(count: 2))
        for (count, button) in [(0, "left"), (4, "left"), (1, "middle")] as [(Int, String)] {
            guard case .failure(let e) = ClickStyle.parse(count: count, button: button) else { return XCTFail("\(count) \(button)") }
            XCTAssertEqual(e.code, .badArguments)
            XCTAssertEqual(e.nextCall, .null)
        }
        for count in [nil, 1, 2] as [Int?] {
            guard case .failure(let e) = ClickStyle.parse(count: count, button: "right") else { return XCTFail("right") }
            XCTAssertEqual(e.code, .notSupported)
            XCTAssertTrue(e.message.contains("right click is not available yet"), e.message)
            XCTAssertEqual(e.retry, .never)
            XCTAssertEqual(e.nextCall, .null)
        }
        let tool = try XCTUnwrap(HandsTools.all.first { $0.verb == "click-at" })
        XCTAssertTrue(tool.summary.contains(#""count":2}"#), "one example call")
        XCTAssertFalse(tool.params.contains { $0.help.contains("context menu") }, "nothing offers a right click")
    }
}
