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

    /// A read that shows only the sidebar until `drawnAt` reads have been made: System Settings drawing a pane after the
    /// click that chose it. The clock moves only when the wait sleeps.
    func loading(drawnAt: Int) -> (read: () -> Result<JSONValue, HandsError>, reads: () -> Int, sleep: (TimeInterval) -> Void, now: () -> Date) {
        var n = 0, t = Date(timeIntervalSince1970: 0)
        let sidebar: JSONValue = .object(["role": "window", "children": .array([.object(["role": "outline", "name": "Sidebar", "ref_id": "@s1:e1"])])])
        return ({ n += 1; return .success(n >= drawnAt ? self.settings() : sidebar) }, { n }, { t += $0 }, { t })
    }

    func testAClickByTextWaitsForAPaneStillDrawing() throws {
        // On main the one read missed it: "no element in window 7 shows "Display"", and run-steps stopped there.
        let l = loading(drawnAt: 3)
        let m = try TextTarget.pickWhenShown(text: "Display", role: nil, window: 7, read: l.read, sleep: l.sleep, now: l.now).get()
        XCTAssertEqual(m.ref, "@s1:e21")
        XCTAssertEqual(l.reads(), 3)
    }

    func testTheWaitIsBoundedAndSaysWhatIsMissing() {
        let l = loading(drawnAt: .max)
        guard case .failure(let e) = TextTarget.pickWhenShown(text: "Display", role: nil, window: 7, read: l.read, sleep: l.sleep, now: l.now) else {
            return XCTFail("never drawn")
        }
        XCTAssertEqual(e.code, .actionFailed)
        XCTAssertTrue(e.message.contains("shows \"Display\""))
        XCTAssertLessThanOrEqual(l.now().timeIntervalSince1970, TextTarget.shownWait + 0.2, "about 2 s, then the refusal")
        let none = loading(drawnAt: .max)
        _ = TextTarget.pickWhenShown(text: "Display", role: nil, window: 7, within: 0, read: none.read, sleep: none.sleep, now: none.now)
        XCTAssertEqual(none.reads(), 1, "within 0 (the main thread) reads once, as before")
    }

    /// #387 first-F1: the sidebar draws first, so "Display" is only inside the "Displays" row until the pane draws. On
    /// 5e6685ae that lone partial won on the first read and the click went to Displays.
    func testAPartialFromTheSidebarDoesNotWinWhileThePaneDraws() throws {
        var n = 0, t = Date(timeIntervalSince1970: 0)
        let rows: JSONValue = .object(["role": "window", "children": .array([.object(["role": "outline", "name": "Sidebar", "ref_id": "@s1:e1", "children": .array([
            .object(["role": "row", "ref_id": "@s1:e8", "children": .array([.object(["role": "statictext", "name": "Displays", "ref_id": "@s1:e10"])])]),
        ])])])])
        let m = try TextTarget.pickWhenShown(text: "Display", role: nil, window: 7, read: { n += 1; return .success(n >= 3 ? self.settings() : rows) },
                                             sleep: { t += $0 }, now: { t }).get()
        XCTAssertEqual(m.ref, "@s1:e21", "the pane's Display button, not the sidebar's Displays row")
        XCTAssertEqual(n, 3)
        // Never drawn: at the deadline the lone partial is what a single read always gave.
        var r = 0, u = Date(timeIntervalSince1970: 0)
        let late = try TextTarget.pickWhenShown(text: "Display", role: nil, window: 7, read: { r += 1; return .success(rows) }, sleep: { u += $0 }, now: { u }).get()
        XCTAssertEqual(late.ref, "@s1:e10")
        XCTAssertGreaterThan(r, 1)
    }

    func testOnlyAnExactMatchEndsTheWaitEarly() {
        let l = loading(drawnAt: 1)
        guard case .failure(let e) = TextTarget.pickWhenShown(text: "Dis", role: nil, window: 7, read: l.read, sleep: l.sleep, now: l.now) else {
            return XCTFail("two match")
        }
        XCTAssertEqual(e.code, .ambiguousTarget, "two partials, refused at the deadline")
        XCTAssertGreaterThan(l.reads(), 1, "two partials read again: the pane may still draw the exact one")
        let once = loading(drawnAt: 1)
        if case .failure(let e) = TextTarget.pickWhenShown(text: "Dis", role: nil, window: 7, within: 0, read: once.read, sleep: once.sleep, now: once.now) {
            XCTAssertEqual(e.code, .ambiguousTarget)
        } else { XCTFail("within 0") }
        XCTAssertEqual(once.reads(), 1, "within 0 is pick on one read")
        var reads = 0
        let gone = TextTarget.pickWhenShown(text: "Display", role: nil, window: 7, read: {
            reads += 1; return .failure(HandsError(.windowNotFound, "gone", suggestion: "", retry: .safe))
        }, sleep: { _ in }, now: Date.init)
        if case .failure(let e) = gone { XCTAssertEqual(e.code, .windowNotFound) } else { XCTFail("a failed read") }
        XCTAssertEqual(reads, 1, "a read that fails answers at once")
    }

    func testTheRouterClicksByTextThroughTheWait() throws {
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let target = try XCTUnwrap(HandsSourceTests.block(after: "private func clickTarget(", in: src))
        XCTAssertTrue(target.contains("TextTarget.pickWhenShown("), "the pick reads again for a pane still drawing")
        XCTAssertTrue(target.contains("Thread.isMainThread ? 0 : TextTarget.shownWait"), "never a wait on the main thread")
        XCTAssertFalse(target.contains("TextTarget.pick(tree:"), "no single-read pick left")
    }
}
