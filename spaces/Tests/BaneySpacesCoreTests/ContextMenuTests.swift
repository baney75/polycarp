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

    /// No press may raise an Open or Save panel or a new window: nothing watches a context item's press for one, so an
    /// item that can is refused before anything is posted (210 r2 first-F1).
    func testAnItemThatCanRaiseAPanelOrWindowIsRefused() throws {
        let items = [I(title: "Save Image As\u{2026}"), I(title: "Download Linked File As..."), I(title: "Export as PDF\u{2026}"),
                     I(identifier: "WKMenuItemIdentifierDownloadImage", title: "Bild laden"), I(identifier: "saveDocument:", title: "Sichern"),
                     I(cmdChar: "S", modifiers: 1, title: "Duplizieren"), I(title: "Copy Image Address"), I(title: "Reload")]
        let enabled = [Bool?](repeating: true, count: items.count)
        for want in ["Save Image As\u{2026}", "Download Linked File As...", "Export as PDF\u{2026}", "Bild laden", "Sichern", "Duplizieren"] {
            guard case .failure(let e) = ContextMenu.choose(items, enabled: enabled, want: want) else { XCTFail("\(want) was chosen"); continue }
            XCTAssertEqual(e.code, .notSupported, want)
            XCTAssertEqual(e.retry, .never, want)
            XCTAssertTrue(e.message.contains("Open or Save panel"), e.message)
        }
        XCTAssertEqual(try ContextMenu.choose(items, enabled: enabled, want: "Reload").get(), 7, "an item that asks nothing more is pressed")
    }

    /// The router: the gate runs before anything is posted, a right click takes its own branch (the menu's window is the
    /// proof), and every path that posted cancels a menu it didn't press.
    func testTheRouterGatesBeforePostingAndNeverLeavesAMenu() throws {
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+ContextMenu.swift")
        let press = try XCTUnwrap(HandsSourceTests.block(after: "func contextPress(", in: src))
        let bg = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/BaneySpaces/Hands/HandsRouter+Background.swift"), encoding: .utf8)
        let gate = try XCTUnwrap(press.range(of: "ContextMenu.gate(")), post = try XCTUnwrap(press.range(of: "BackgroundPoster.pointer("))
        XCTAssertLessThan(gate.lowerBound, post.lowerBound)
        XCTAssertTrue(press.contains("contextMenu(w, frame: frame, displays: displays, before: before, item: item, stopped: post.report.stopped"))
        // The tail both right clicks share (a posted one and one on a ref).
        let menu = try XCTUnwrap(HandsSourceTests.block(after: "func contextMenu(", in: src))
        XCTAssertFalse(src.contains("AXUIElementPerformAction"), "the router performs no accessibility action itself")
        XCTAssertTrue(menu.contains("_ = escape()"), "cancelled with Escape posted to the process")
        XCTAssertTrue(src.contains("surface: HandsEngine.surfaceMenu") && src.contains("actInline(window: w, ref: ref, kind: .click"), "the item is pressed through the engine")
        XCTAssertTrue(menu.contains("case .elsewhere:\n            return .failure(ContextMenu.elsewhere(w.app, cancelled: cancel()))"))
        XCTAssertTrue(menu.contains("return .failure(shown.isEmpty || cancel() ? stopped : ContextMenu.stillOpen(w.app))"), "a stopped press cancels its menu, and says when it couldn't")
        // 210 r1 first-F1: the cancel's key permit is planned before anything is posted, with the transaction's verifier.
        let keys = try XCTUnwrap(press.range(of: "guard let keyPermit = keys() else { out.result = .failure(ContextMenu.noCancel(w.app)); return out }"))
        XCTAssertLessThan(keys.lowerBound, post.lowerBound)
        XCTAssertTrue(bg.contains("escapeKeys(w, verifier: verifier)") && !bg.contains("verifier: .none, path: []"))
        // first-F2: a late menu is cancelled. first-F3: a menu left open is said over the front app's failure.
        XCTAssertTrue(menu.contains("let late = waitShown(ContextMenu.wait)") && menu.contains("cancel() ? ContextMenu.late(w.app) : ContextMenu.stillOpen(w.app)"))
        XCTAssertTrue(menu.contains("defer { if open { leftOpen = true } }") && bg.contains("r.posted > 0 && !r.leftOpen ? frontFailure() ?? e : e"))
        // second-S1: a pressed item is never notPressed. second-S3, S4: on-screen menus only, the window's own scope.
        let pressed = try XCTUnwrap(menu.range(of: "data[\"pressed\"] = .string(read.items[at].title)"))
        XCTAssertNil(menu[pressed.upperBound...].range(of: "notPressed"))
        XCTAssertTrue(src.contains("CGWindowListCopyWindowInfo([.optionOnScreenOnly]") && bg.contains("agentWindow: onAgentWorkspace(w, scope)"))
        XCTAssertTrue(menu.contains("return .failure(cancel() ? e : ContextMenu.stillOpen(w.app))"), "a refused item cancels the menu")
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

    /// By ref: nothing reaches the app unless the agent workspace is on screen under the window and the element
    /// (AXShowMenu opens the menu at it); a parked window is refused, nothing sent. A menu that still opens
    /// off the window's display is cancelled by the verdict, as after a posted click.
    func testARightClickOnARefIsGatedLikeAPostedOne() throws {
        let shown = CGRect(x: 200, y: 100, width: 800, height: 600)
        let button = CGRect(x: 300, y: 200, width: 80, height: 24)
        XCTAssertNil(ContextMenu.gate(agentShown: true, agentWindow: true, window: shown, element: button, displays: [main, side]))
        let parked = CGRect(origin: Geometry.hidingSpot(screens: [main, side]), size: shown.size)
        for (window, agent, own) in [(parked, true, true), (shown, false, true), (shown, true, false)] {
            let e = try XCTUnwrap(ContextMenu.gate(agentShown: agent, agentWindow: own, window: window, element: button, displays: [main, side]), "\(window) \(agent) \(own)")
            XCTAssertEqual(e.code, .outsideAgentWorkspace)
            XCTAssertTrue(e.message.contains("nothing was sent"), e.message)
            XCTAssertEqual(e.retry, .never)
        }
    }

    /// 231 r1 second-S1: the window's middle doesn't stand for the element. A window across two displays, its middle on
    /// the main one and the element on the other, would open the menu on a display Donovan may be looking at; an element
    /// whose bounds can't be read is refused the same way, nothing sent.
    func testARightClickOnARefIsGatedAtTheElementNotTheWindowsMiddle() throws {
        let across = CGRect(x: 900, y: 100, width: 1000, height: 600)
        XCTAssertTrue(main.contains(CGPoint(x: across.midX, y: across.midY)))
        let onSide = CGRect(x: 1700, y: 300, width: 80, height: 24), onMain = CGRect(x: 1000, y: 300, width: 80, height: 24)
        XCTAssertNil(ContextMenu.gate(agentShown: true, agentWindow: true, window: across, element: onMain, displays: [main, side]))
        for element in [onSide, nil] as [CGRect?] {
            let e = try XCTUnwrap(ContextMenu.gate(agentShown: true, agentWindow: true, window: across, element: element, displays: [main, side]), "\(String(describing: element))")
            XCTAssertEqual(e.code, .outsideAgentWorkspace)
            XCTAssertTrue(e.message.contains("nothing was sent"), e.message)
        }
    }

    /// 231 r1 first-F5: a refusal that sent nothing (no such action, a ref gone stale) has no menu to watch for; any other
    /// failure may have opened one, so it is watched and cancelled.
    func testARefusalThatSentNothingIsNotWatchedForAMenu() {
        XCTAssertTrue(ContextMenu.nothingSent(HandsError(.notSupported, "no AXShowMenu", suggestion: "")))
        XCTAssertTrue(ContextMenu.nothingSent(HandsError(.staleRef, "gone", suggestion: "")))
        XCTAssertFalse(ContextMenu.nothingSent(HandsError(.timeout, "slow", suggestion: "")))
        XCTAssertFalse(ContextMenu.nothingSent(nil))
    }

    /// `click` takes button and item: left is the plain press, right opens the menu, item only with right.
    func testClickOnARefTakesTheRightButton() throws {
        XCTAssertEqual(try ContextMenu.refClick(button: nil, item: nil).get(), .press)
        XCTAssertEqual(try ContextMenu.refClick(button: "Right", item: "Rename").get(), .right(item: "Rename"))
        XCTAssertEqual(try ContextMenu.refClick(button: "right", item: nil).get(), .right(item: nil))
        for (b, i) in [("left", "Rename"), ("right", " "), ("middle", nil)] as [(String, String?)] {
            guard case .failure(let e) = ContextMenu.refClick(button: b, item: i) else { return XCTFail("\(b) \(String(describing: i))") }
            XCTAssertEqual(e.code, .badArguments)
        }
        let click = try XCTUnwrap(HandsTools.all.first { $0.verb == "click" })
        XCTAssertTrue(Set(click.params.map(\.name)).isSuperset(of: ["ref", "button", "item"]))
    }

    /// The router: a right click on a ref is gated before the engine is asked, goes to the engine as its RightClick
    /// (kind 2, headless: AXShowMenu, never a posted click), and shares the posted right click's proof and cancel.
    func testARightClickOnARefIsTheEnginesShowMenuWithTheSameProof() throws {
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertTrue(router.contains("case .success(.right(let item)): return contextClick(req, item: item)"))
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+ContextRef.swift")
        let click = try XCTUnwrap(HandsSourceTests.block(after: "func contextClick(", in: src))
        let gate = try XCTUnwrap(click.range(of: "ContextMenu.gate(")), act = try XCTUnwrap(click.range(of: "kind: .rightClick"))
        XCTAssertLessThan(gate.lowerBound, act.lowerBound)
        // 210 r1 first-F1, S4: the window's own scope, and the cancel's key permit before the engine is asked.
        let keys = try XCTUnwrap(click.range(of: "guard let keyPermit = escapeKeys(w) else { answer = .failure(ContextMenu.noCancel(w.app)); return .ok(.null) }"))
        XCTAssertLessThan(keys.lowerBound, act.lowerBound)
        XCTAssertTrue(click.contains("agentWindow: onAgentWorkspace(w, scope)") && click.contains("permit: keyPermit") && click.contains("leftOpen: &open"))
        XCTAssertFalse(src.contains("escapeMenu"))
        XCTAssertTrue(click.contains("contextMenu(w, frame: frame, displays: displays, before: before, item: pressed == nil ? item : nil, stopped: nil, none: refused"))
        // first-F5: nothing sent, no menu watch; it answers before contextMenu is asked.
        let skip = try XCTUnwrap(click.range(of: "if ContextMenu.nothingSent(refused), let refused { answer = .failure(refused); return .ok(.null) }"))
        let watch = try XCTUnwrap(click.range(of: "answer = contextMenu("))
        XCTAssertLessThan(act.lowerBound, skip.lowerBound)
        XCTAssertLessThan(skip.lowerBound, watch.lowerBound)
        let engine = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsEngine.swift")
        XCTAssertTrue(engine.contains("rightClick = 2") && engine.contains("Self.headlessPolicy, 0, &out"))
    }

    /// 231 r1 first-F3: an app that comes forward by itself on AXShowMenu is caught as after a posted click. The front app
    /// is watched from before the press to after the cancel, by the same verdict; a press that brought it forward chooses
    /// nothing from the menu and only cancels it.
    func testARightClickOnARefWatchesTheFrontAppLikeAPostedOne() throws {
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+ContextRef.swift")
        let click = try XCTUnwrap(HandsSourceTests.block(after: "func contextClick(", in: src))
        let front = try XCTUnwrap(click.range(of: "guard let front = frontWatch(w, kind: .pointer) else { answer = .failure(BackgroundRefusal.frontUnknown(w.app)); return .ok(.null) }"))
        let after = try XCTUnwrap(click.range(of: "if let e = pressed ?? front.failure() { answer = .failure(e) }"))
        XCTAssertLessThan(front.lowerBound, try XCTUnwrap(click.range(of: "kind: .rightClick")).lowerBound)
        XCTAssertLessThan(try XCTUnwrap(click.range(of: "answer = contextMenu(")).lowerBound, after.lowerBound)
        XCTAssertTrue(click.contains("let pressed = front.failure()") && click.contains("defer { front.stop() }"))
        let bg = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Background.swift")
        XCTAssertEqual(bg.components(separatedBy: "PostGuard.verdict(span, hardware: hardware)").count, 2, "one front verdict, shared by transact and the ref")
        XCTAssertTrue(bg.contains("func frontFailure() -> HandsError? { frontVerdict(w, kind: kind, spanFront(), hardware: hardware()) }"))
        XCTAssertFalse(src.contains("BackgroundPoster.pointer") || src.contains("AXUIElementPerformAction"), "no posted click, no accessibility action of its own")
    }

    /// 231 r1 first-F4: "never a posted click" rests on the pinned engine; the note beside the kind quotes the lines
    /// that make it so, and names the version they were read at.
    func testTheRefRightClicksNoPostIsQuotedFromThePinnedEngine() throws {
        let raw = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/BaneySpaces/Hands/HandsEngine.swift"), encoding: .utf8)
        for quote in ["RIGHT_CLICK_CHAIN starts with `ChainStep::CGClick {", "`if !step_allowed(step, policy) { continue; }`", "|| policy.is_headed()`",
                      "`Self::Headless => InteractionPolicy::headless()`", "agent-desktop 5261b52", "`assert!(!step_allowed(&physical, headless))`"] {
            XCTAssertTrue(raw.contains(quote), quote)
        }
    }

    /// 231 r1 first-F1: rule 1 is read inside the transaction, when the work runs. Read before it, work ahead on the
    /// process's queue could hold the right click while Donovan put the agent workspace away, and AXShowMenu would draw
    /// the menu on his screen. first-F2: it waits while he uses the app, as a posted key does.
    func testARightClickOnARefIsGatedWhenItRunsNotWhenItQueues() throws {
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+ContextRef.swift")
        let click = try XCTUnwrap(HandsSourceTests.block(after: "func contextClick(", in: src))
        let tx = try XCTUnwrap(click.range(of: "HandsEngine.shared.transaction(window: w, check: acting) { [self] cancelled in"))
        let frame = try XCTUnwrap(click.range(of: "guard let frame = BackgroundAX.serverWindow(w.id)?.frame else {"))
        let displays = try XCTUnwrap(click.range(of: "let displays = ContextMenuAX.displays()"))
        let gate = try XCTUnwrap(click.range(of: "ContextMenu.gate(agentShown: agentShown(), agentWindow: onAgentWorkspace(w, scope), window: frame, element: element, displays: displays) { answer = .failure(e); return .ok(.null) }"))
        let bounds = try XCTUnwrap(click.range(of: #"HandsEngine.shared.getInline(window: w, ref: ref, property: "bounds")"#))
        let keys = try XCTUnwrap(click.range(of: "escapeKeys(w)"))
        XCTAssertLessThan(bounds.lowerBound, gate.lowerBound)
        for (name, r) in [("frame", frame), ("displays", displays), ("bounds", bounds), ("gate", gate)] {
            XCTAssertLessThan(tx.lowerBound, r.lowerBound, "\(name) is read inside the transaction")
            XCTAssertLessThan(r.lowerBound, keys.lowerBound, "\(name) before the cancel's permit and the engine")
        }
        XCTAssertEqual(click.components(separatedBy: "ContextMenu.gate(").count, 2, "one gate, the one inside")
        XCTAssertTrue(click.contains(#"awaitUse(w, verb: "click", delivery: .posted"#))
        XCTAssertTrue(click.contains(#"actingCheck(w, ref: ref, verb: "click", delivery: .posted"#))
        XCTAssertFalse(click.contains(".headlessAX"))
        let bg = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/BaneySpaces/Hands/HandsRouter+Background.swift"), encoding: .utf8)
        XCTAssertTrue(bg.contains("/// The facts the planner decides on, read now, on the process queue. nil when the window is gone.\n    private func gatherFacts("), "231 r1 second-S4")
    }
}
