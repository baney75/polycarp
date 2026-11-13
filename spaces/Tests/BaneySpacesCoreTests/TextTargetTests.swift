import XCTest
@testable import BaneySpacesCore

/// `click` by text: the element is found in a fresh read of the window when the call runs, so a step can name an element
/// that only appears after the step before it (System Settings' Accessibility > Display). An exact label wins; a
/// partial match counts only when it is the only one; two of either are refused with the refs, never guessed.
final class TextTargetTests: XCTestCase {
    /// System Settings on Accessibility, as the engine's tree reads: a sidebar outline whose rows hold the pane's name,
    /// the pane's heading, and its buttons.
    func settings() -> JSONValue {
        func row(_ n: Int, _ name: String) -> JSONValue {
            .object(["role": "row", "ref_id": .string("@s1:e\(n)"), "children": .array([
                .object(["role": "cell", "ref_id": .string("@s1:e\(n + 1)"), "children": .array([
                    .object(["role": "statictext", "name": .string(name), "ref_id": .string("@s1:e\(n + 2)")]),
                ])]),
            ])])
        }
        func button(_ n: Int, _ name: String) -> JSONValue { .object(["role": "button", "name": .string(name), "ref_id": .string("@s1:e\(n)")]) }
        return .object(["role": "window", "name": "Accessibility", "children": .array([
            .object(["role": "outline", "name": "Sidebar", "ref_id": "@s1:e1", "children": .array([
                row(2, "Accessibility"), row(5, "Appearance"), row(8, "Displays"), row(11, "Keyboard"),
            ])]),
            .object(["role": "statictext", "name": "Accessibility", "ref_id": "@s1:e20"]),
            button(21, "Display"), button(22, "Zoom"), button(23, "Keyboard"), button(24, "Night Shift…"),
            .object(["role": "textfield", "name": "Search", "value": "", "ref_id": "@s1:e25"]),
        ])])
    }

    func pick(_ text: String, role: String? = nil) -> Result<TextTarget.Match, HandsError> {
        TextTarget.pick(tree: settings(), text: text, role: role, window: 7)
    }

    func testAnExactLabelWinsOverLongerOnes() throws {
        // "Display" is also inside "Displays": the exact label is the one meant.
        XCTAssertEqual(try pick("Display").get(), TextTarget.Match(ref: "@s1:e21", role: "button", label: "Display"))
        XCTAssertEqual(try pick("  appearance ").get().ref, "@s1:e7", "case and spaces don't matter")
        XCTAssertEqual(try pick("Night Shift").get().ref, "@s1:e24", "a trailing ellipsis is not part of the label")
    }

    func testAPartialMatchCountsOnlyWhenItIsTheOnlyOne() throws {
        XCTAssertEqual(try pick("Appear").get().ref, "@s1:e7")
        guard case .failure(let e) = pick("Dis") else { return XCTFail("Displays and Display both hold dis") }
        XCTAssertEqual(e.code, .ambiguousTarget)
    }

    func testTwoExactLabelsAreRefusedWithTheirRefsAndRoleNarrowsThem() throws {
        guard case .failure(let e) = pick("Keyboard") else { return XCTFail("the sidebar's Keyboard and the pane's") }
        XCTAssertEqual(e.code, .ambiguousTarget)
        XCTAssertTrue(e.message.contains("@s1:e13") && e.message.contains("@s1:e23"), e.message)
        XCTAssertEqual(e.nextCall, .null, "the refs are in the message: no read needed")
        XCTAssertEqual(try pick("Keyboard", role: "button").get().ref, "@s1:e23")
        XCTAssertEqual(try pick("Keyboard", role: "StaticText").get().ref, "@s1:e13", "roles compare as the engine prints them")
    }

    func testNoMatchSendsNothingAndSaysWhatToRead() throws {
        guard case .failure(let e) = pick("Bluetooth") else { return XCTFail("nothing shows Bluetooth") }
        XCTAssertEqual(e.code, .actionFailed)
        XCTAssertEqual(e.retry, .safe, "nothing was sent")
        XCTAssertTrue(e.message.contains("Nothing was sent"), e.message)
        XCTAssertEqual(e.nextCall, HandsError.call("snapshot", ["window": .int(7)]))
        guard case .failure(let blank) = pick("   ") else { return XCTFail("an empty text") }
        XCTAssertEqual(blank.code, .badArguments)
    }

    func testClickTakesARefOrAWindowAndText() throws {
        XCTAssertNoThrow(try HandsParse.call(name: "click", arguments: ["window": 7, "text": "Appearance"], session: nil).get())
        XCTAssertNoThrow(try HandsParse.call(name: "click", arguments: ["ref": "5"], session: nil).get())
        XCTAssertNoThrow(try HandsParse.call(name: "click", arguments: ["ref": "@s1:e5", "window": 7], session: nil).get(), "a ref names its own window: a window beside it is harmless")
        for bad: [String: JSONValue] in [[:], ["text": "Appearance"], ["window": 7], ["ref": "5", "text": "Appearance"], ["ref": "5", "role": "button"], ["ref": "5", "window": 7, "text": "x"]] {
            guard case .failure(let e) = HandsParse.call(name: "click", arguments: bad, session: nil) else { return XCTFail("\(bad) must be refused") }
            XCTAssertEqual(e.code, .badArguments, "\(bad)")
        }
        let tool = try XCTUnwrap(HandsTools.tool(verb: "click"))
        XCTAssertFalse(try XCTUnwrap(tool.params.first { $0.name == "ref" }).required, "ref or text")
        XCTAssertEqual(Set(tool.params.map(\.name)).isSuperset(of: ["window", "text", "role"]), true)
    }

    func testARunStepCanClickByText() throws {
        let steps: JSONValue = .array([
            .object(["tool": "click", "args": .object(["window": 7, "text": "Accessibility", "role": "statictext"])]),
            .object(["tool": "click", "args": .object(["window": 7, "text": "Display"])]),
        ])
        XCTAssertEqual(try RunSteps.parse(steps, session: nil, wait: nil).get().count, 2)
    }
}
