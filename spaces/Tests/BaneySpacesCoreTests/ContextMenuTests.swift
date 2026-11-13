import CoreGraphics
import XCTest
@testable import BaneySpacesCore

/// Context menus: a right click (a) carries the right button number, (b) is proved by the menu's own window, and (c)
/// never leaves a menu where Donovan can see it.
final class ContextMenuTests: XCTestCase {
    struct ChosenError: Error {}
    typealias I = MenuPath.MenuItem
    let p = CGPoint(x: 120, y: 80)
    let main = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let side = CGRect(x: 1512, y: 0, width: 1920, height: 1080)

    /// (a): every right-button event says button 1 (field 3), with its own event kind, and is a click.
    func testTheRightButtonIsStampedAsButtonOne() throws {
        let stamps = try InputScript.rightClick(at: p).map { try XCTUnwrap(PointerStamp.of($0, drag: false)) }
        XCTAssertEqual(stamps.map(\.kind), [.moved, .rightDown, .rightUp])
        XCTAssertEqual(stamps.map(\.button), [0, 1, 1])
        XCTAssertEqual(stamps.dropFirst().map(\.state), [1, 1])
        XCTAssertEqual(stamps.dropFirst().map(\.subtype), [3, 3])
    }

    /// A right press is always released, even when the script stops before its release.
    func testARightPressIsAlwaysReleased() {
        let held = EventRunner.run([.rightDown(p)], stop: { nil }) { _ in {} }
        XCTAssertEqual(held.posted, [.rightDown(p), .rightUp(p)])
        XCTAssertEqual(held.released, 1)
        XCTAssertTrue(InputEvent.rightUp(p).isRelease && InputEvent.rightDown(p).isPress)
    }

    /// (c), before anything is posted: a parked window (off every display) or an agent workspace that isn't on screen
    /// would bring the menu onto Donovan's screen, so nothing is posted.
    func testNothingIsPostedUnlessTheAgentWorkspaceIsOnScreenUnderTheWindow() throws {
        let shown = CGRect(x: 200, y: 100, width: 800, height: 600)
        XCTAssertNil(ContextMenu.gate(agentShown: true, agentWindow: true, window: shown, point: CGPoint(x: 320, y: 180), displays: [main, side]))
        let spot = Geometry.hidingSpot(screens: [main, side])
        let parked = CGRect(origin: spot, size: shown.size)
        let refusals = [
            ContextMenu.gate(agentShown: true, agentWindow: true, window: parked, point: CGPoint(x: spot.x + 120, y: spot.y + 80), displays: [main, side]),
            ContextMenu.gate(agentShown: false, agentWindow: true, window: shown, point: CGPoint(x: 320, y: 180), displays: [main, side]),
            ContextMenu.gate(agentShown: true, agentWindow: true, window: shown, point: CGPoint(x: 1600, y: 180), displays: [main, side]),
            // 210 r1 second-S4: a lent window on Donovan's workspace, on a display the agent workspace is also shown on.
            ContextMenu.gate(agentShown: true, agentWindow: false, window: shown, point: CGPoint(x: 320, y: 180), displays: [main, side]),
        ]
        for r in refusals {
            let e = try XCTUnwrap(r)
            XCTAssertEqual(e.code, .outsideAgentWorkspace)
            XCTAssertTrue(e.message.contains("nothing was posted"), e.message)
            XCTAssertEqual(e.retry, .never)
        }
    }

    /// (b): the press's menu is a window of that process at the pop-up menu level, new since the press.
    func testTheMenuIsTheProcesssNewPopUpWindow() {
        func w(_ id: Int, pid: Int32, layer: Int, on: Bool = true) -> [String: Any] {
            [kCGWindowNumber as String: NSNumber(value: id), kCGWindowOwnerPID as String: NSNumber(value: pid), kCGWindowLayer as String: NSNumber(value: layer),
             kCGWindowBounds as String: CGRect(x: 300, y: 200, width: 220, height: 180).dictionaryRepresentation, kCGWindowIsOnscreen as String: NSNumber(value: on)]
        }
        // 210 r1 second-S3: window 6 is at the menu level but off screen.
        let list = [w(1, pid: 42, layer: 0), w(2, pid: 42, layer: 101), w(3, pid: 7, layer: 101), w(4, pid: 42, layer: 101), w(5, pid: 42, layer: 25), w(6, pid: 42, layer: 101, on: false)]
        XCTAssertEqual(ContextMenu.menus(list, pid: 42, before: [4]), [ContextMenu.Shown(id: 2, frame: CGRect(x: 300, y: 200, width: 220, height: 180))])
        XCTAssertEqual(ContextMenu.menus(list, pid: 42, before: [2, 4]), [])
    }

    /// (c), after the press: on the window's display while the agent workspace is shown, or cancelled and failed.
    func testAMenuAnywhereElseIsCancelled() {
        let window = CGRect(x: 200, y: 100, width: 800, height: 600)
        let display = ContextMenu.display(window: window, displays: [main, side])
        XCTAssertEqual(display, main)
        let here = ContextMenu.Shown(id: 9, frame: CGRect(x: 300, y: 200, width: 220, height: 180))
        let across = ContextMenu.Shown(id: 10, frame: CGRect(x: 1400, y: 200, width: 220, height: 180))
        XCTAssertEqual(ContextMenu.verdict([], agentShown: true, display: display), .none)
        XCTAssertEqual(ContextMenu.verdict([here], agentShown: true, display: display), .onAgent([here]))
        XCTAssertEqual(ContextMenu.verdict([here, across], agentShown: true, display: display), .elsewhere([here, across]))
        XCTAssertEqual(ContextMenu.verdict([here], agentShown: false, display: display), .elsewhere([here]), "Donovan left the agent workspace")
        XCTAssertEqual(ContextMenu.verdict([here], agentShown: true, display: nil), .elsewhere([here]))
        XCTAssertTrue(ContextMenu.elsewhere("Notes", cancelled: true).message.contains("it was cancelled"))
        XCTAssertTrue(ContextMenu.elsewhere("Notes", cancelled: false).message.contains("may still be open"))
        XCTAssertEqual(ContextMenu.noMenu("Notes").code, .unverified)
        // 210 r1 first-F1, first-F2, second-S1.
        XCTAssertTrue(ContextMenu.noCancel("Notes").message.contains("nothing was posted"))
        XCTAssertEqual(ContextMenu.noCancel("Notes").retry, .never)
        XCTAssertTrue(ContextMenu.late("Notes").message.contains("it was cancelled"))
        let pressed = ContextMenu.pressedOpen("Notes", item: "Duplicate")
        XCTAssertTrue(pressed.message.contains("Duplicate was pressed") && pressed.message.contains("still open"), pressed.message)
        XCTAssertEqual(pressed.retry, .never)
    }

    /// An item is pressed only by its title, enabled, not a submenu, and only if the menu bar's rules would let it through.
    func testTheItemIsChosenByTheMenuBarsRules() throws {
        let items = [I(identifier: "cut:", title: "Ausschneiden"), I(identifier: "copy:", title: "Kopieren"), I(title: ""),
                     I(title: "Rename"), I(title: "Services", submenu: true), I(title: "Look Up \u{201C}word\u{201D}"),
                     I(title: "Share\u{2026}"), I(title: "Open With", submenu: true), I(title: "Sort By", submenu: true), I(title: "Delete")]
        let enabled: [Bool?] = [true, true, false, true, true, true, true, true, true, nil]
        XCTAssertEqual(try ContextMenu.choose(items, enabled: enabled, want: "rename").get(), 3)
        func refusal(_ want: String) throws -> HandsError {
            guard case .failure(let e) = ContextMenu.choose(items, enabled: enabled, want: want) else { XCTFail("\(want) was chosen"); throw ChosenError() }
            return e
        }
        XCTAssertTrue(try refusal("Kopieren").message.contains("clipboard"), "by identifier in any language")
        XCTAssertTrue(try refusal("Ausschneiden").message.contains("clipboard"))
        for outside in ["Services", "Look Up \u{201C}word\u{201D}", "Share\u{2026}", "Open With"] {
            XCTAssertEqual(try refusal(outside).code, .notSupported, outside)
        }
        XCTAssertTrue(try refusal("Sort By").message.contains("submenu"))
        XCTAssertTrue(try refusal("Delete").message.contains("unreadable"))
        let missing = try refusal("Duplicate")
        XCTAssertEqual(missing.code, .actionFailed)
        XCTAssertTrue(missing.message.contains("Rename") && !missing.message.contains(", ,"), missing.message)
        guard case .failure(let off) = ContextMenu.choose([I(title: "Rename")], enabled: [false], want: "Rename") else { return XCTFail("disabled") }
        XCTAssertTrue(off.message.contains("disabled"))
    }

    /// The router: the gate runs before anything is posted, a right click takes its own branch (the menu's window is the
    /// proof), and every path that posted cancels a menu it didn't press.
    func testTheRouterGatesBeforePostingAndNeverLeavesAMenu() throws {
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+ContextMenu.swift")
        let press = try XCTUnwrap(HandsSourceTests.block(after: "func contextPress(", in: src))
        let bg = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Background.swift")
        let gate = try XCTUnwrap(press.range(of: "ContextMenu.gate(")), post = try XCTUnwrap(press.range(of: "BackgroundPoster.pointer("))
        XCTAssertLessThan(gate.lowerBound, post.lowerBound)
        XCTAssertFalse(src.contains("AXUIElementPerformAction"), "the router performs no accessibility action itself")
        XCTAssertTrue(press.contains("_ = escape()"), "cancelled with Escape posted to the process")
        XCTAssertTrue(src.contains("surface: HandsEngine.surfaceMenu") && src.contains("actInline(window: w, ref: ref, kind: .click"), "the item is pressed through the engine")
        XCTAssertTrue(press.contains("case .elsewhere:\n            out.result = .failure(ContextMenu.elsewhere(w.app, cancelled: cancel()))"))
        XCTAssertTrue(press.contains("out.result = .failure(shown.isEmpty || cancel() ? stopped : ContextMenu.stillOpen(w.app))"), "a stopped press cancels its menu, and says when it couldn't")
        // 210 r1 first-F1: the cancel's key permit is planned before anything is posted, with the transaction's verifier.
        let keys = try XCTUnwrap(press.range(of: "guard let keyPermit = keys() else { out.result = .failure(ContextMenu.noCancel(w.app)); return out }"))
        XCTAssertLessThan(keys.lowerBound, post.lowerBound)
        XCTAssertTrue(bg.contains("gatherFacts(w, kind: .keys, verifier: verifier, path: [])") && !bg.contains("verifier: .none, path: []"))
        // first-F2: a late menu is cancelled. first-F3: a menu left open is said over the front app's failure.
        XCTAssertTrue(press.contains("let late = waitShown(ContextMenu.wait)") && press.contains("cancel() ? ContextMenu.late(w.app) : ContextMenu.stillOpen(w.app)"))
        XCTAssertTrue(bg.contains("r.posted > 0 && !r.leftOpen ? frontFailure() ?? e : e"))
        // second-S1: a pressed item is never notPressed. second-S3, S4: on-screen menus only, the window's own scope.
        let pressed = try XCTUnwrap(press.range(of: "data[\"pressed\"] = .string(read.items[at].title)"))
        XCTAssertNil(press[pressed.upperBound...].range(of: "notPressed"))
        XCTAssertTrue(src.contains("CGWindowListCopyWindowInfo([.optionOnScreenOnly]") && bg.contains("agentWindow: onAgentWorkspace(w, scope)"))
        XCTAssertTrue(press.contains("out.result = .failure(cancel() ? e : ContextMenu.stillOpen(w.app))"), "a refused item cancels the menu")
        let right = try XCTUnwrap(bg.range(of: "case .pointer where style.right:")), left = try XCTUnwrap(bg.range(of: "case .pointer:\n"))
        XCTAssertLessThan(right.lowerBound, left.lowerBound)
        let poster = try HandsSourceTests.code("Sources/BaneySpaces/Hands/BackgroundPoster.swift")
        XCTAssertTrue(poster.contains("mouseButton: stamp.button == 1 ? .right : .left"))
        XCTAssertTrue(poster.contains("case .rightDown: type = .rightMouseDown"))
    }

    /// 210 r1 second-S6: the docs say which outside items are known only by English title.
    func testTheDocsSayLookUpAndTranslateAreKnownByEnglishTitleOnly() throws {
        for doc in ["CHANGELOG.md", "spec/cli.md"] {
            XCTAssertTrue(try HandsSourceTests.code(doc).contains("by English title only"), doc)
        }
    }

    /// The item is pressed by its ref in the engine's read of the menu: the menu's own item, enabled, never a submenu's.
    func testTheItemsRefComesFromTheEnginesReadOfTheMenu() {
        let tree: JSONValue = .object(["role": "menu", "children": .array([
            .object(["role": "menuitem", "name": "Rename", "ref_id": "@e3"]),
            .object(["role": "menuitem", "name": "Sort By", "ref_id": "@e4", "children": .array([.object(["role": "menu", "children": .array([
                .object(["role": "menuitem", "name": "Name", "ref_id": "@e5"])])])])]),
            .object(["role": "menuitem", "name": "Delete", "ref_id": "@e6", "states": .array(["disabled"])]),
        ])])
        XCTAssertEqual(ContextMenu.ref(tree, title: "rename"), "@e3")
        XCTAssertNil(ContextMenu.ref(tree, title: "Name"), "not inside a submenu")
        XCTAssertNil(ContextMenu.ref(tree, title: "Delete"), "not disabled")
    }
}
