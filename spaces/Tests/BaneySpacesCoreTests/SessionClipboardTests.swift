import XCTest
@testable import BaneySpacesCore

/// The agent clipboard: per session, in Polycarp's memory, never the Mac's pasteboard.
final class SessionClipboardTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_000_000)

    func text(_ r: Result<String, HandsError>) -> String? { if case .success(let s) = r { return s }; return nil }
    func error(_ r: Result<String, HandsError>) -> HandsError? { if case .failure(let e) = r { return e }; return nil }

    func testEachSessionHoldsItsOwnTextUntilItEndsOrIdles() {
        var b = SessionClipboard()
        XCTAssertNil(b.copy("alpha", session: "a", now: t0))
        XCTAssertNil(b.copy("beta", session: "b", now: t0))
        XCTAssertEqual(text(b.paste(session: "a", now: t0)), "alpha")
        XCTAssertEqual(text(b.paste(session: "b", now: t0)), "beta", "another session never sees a's text")
        XCTAssertNil(b.copy("gamma", session: "a", now: t0))
        XCTAssertEqual(text(b.paste(session: "a", now: t0)), "gamma", "a copy replaces")
        b.end(session: "a")
        XCTAssertTrue(error(b.paste(session: "a", now: t0))?.suggestion.contains("copy") == true, "ended: gone, and the error says how to copy")
        XCTAssertEqual(text(b.paste(session: "b", now: t0.addingTimeInterval(3000))), "beta", "a paste keeps it in use")
        XCTAssertNil(text(b.paste(session: "b", now: t0.addingTimeInterval(3000 + SessionClipboard.idle))), "an hour unused: gone")
        XCTAssertEqual(b.sessions, 0)
    }

    func testTheClipboardIsBounded() {
        var b = SessionClipboard()
        XCTAssertEqual(b.copy(String(repeating: "x", count: SessionClipboard.maxCharacters + 1), session: "a", now: t0)?.code, .badArguments)
        for i in 0...SessionClipboard.maxSessions { XCTAssertNil(b.copy("\(i)", session: "s\(i)", now: t0.addingTimeInterval(Double(i)))) }
        XCTAssertEqual(b.sessions, SessionClipboard.maxSessions)
        XCTAssertNil(text(b.paste(session: "s0", now: t0.addingTimeInterval(100))), "the one unused longest went")
        XCTAssertEqual(text(b.paste(session: "s1", now: t0.addingTimeInterval(100))), "1")
    }

    func testTypeTakesTextOrPasteNeverBoth() {
        let board: () -> Result<String, HandsError> = { .success("held") }
        XCTAssertEqual(text(SessionClipboard.typed(text: "hi", paste: false, from: board)), "hi")
        XCTAssertEqual(text(SessionClipboard.typed(text: nil, paste: true, from: board)), "held")
        XCTAssertEqual(error(SessionClipboard.typed(text: "hi", paste: true, from: board))?.message, "pass text or paste: true, not both")
        XCTAssertEqual(error(SessionClipboard.typed(text: nil, paste: false, from: board))?.message, "text is missing")
        XCTAssertEqual(text(SessionClipboard.copyable(.string("Hello"))), "Hello")
        XCTAssertEqual(error(SessionClipboard.copyable(.object(["x": 1, "y": 2])))?.code, .badArguments, "bounds are no text")
        XCTAssertNotNil(error(SessionClipboard.copyable(nil)))
    }

    /// Cut, copy and paste keys never go out, by key code and by what the key types in the Mac's layout.
    func testClipboardKeysAreRefused() throws {
        for k in ["cmd+c", "cmd+x", "cmd+v", "cmd+shift+v", "cmd+opt+shift+v", "cmd+opt+v", "cmd+C"] {
            guard case .failure(let e) = KeyParse.sequence(k) else { return XCTFail(k) }
            XCTAssertEqual(e.code, .notSupported, k)
            XCTAssertTrue(e.suggestion.contains("paste\":true"), e.suggestion)
        }
        for k in ["c", "ctrl+c", "cmd+a", "cmd+z", "shift+v"] {
            guard case .success = KeyParse.sequence(k) else { return XCTFail(k) }
        }
        let i = try KeyParse.chord("cmd+i").get()
        XCTAssertTrue(SessionClipboard.usesPasteboard(i, characters: ["c"]), "cmd+i types c on Dvorak: copy")
        XCTAssertTrue(SessionClipboard.usesPasteboard(i, characters: ["i", "V"]))
        XCTAssertFalse(SessionClipboard.usesPasteboard(i, characters: ["i"]))
        XCTAssertFalse(SessionClipboard.usesPasteboard(try KeyParse.chord("ctrl+i").get(), characters: ["c"]), "no command key, no clipboard")
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+Background.swift")
        XCTAssertTrue(src.contains("SessionClipboard.usesPasteboard($0, characters: KeyLayout.characters($0.keyCode))"))
    }

    /// The engine's advice for a field with no text write is its clipboard and the paste key; it's said without them.
    func testTheEnginesClipboardAdviceIsReplaced() {
        let s = EngineVerdict.suggestion("Use set_clipboard and paste with cmd+v instead.")
        XCTAssertFalse(s.lowercased().contains("clipboard and") || s.contains("cmd+v"), s)
        XCTAssertTrue(s.contains("the Mac's clipboard is not used"), s)
        XCTAssertEqual(EngineVerdict.suggestion("Try again."), "Try again.")
        // 198 r1 first-F6: the engine's real advice is replaced; other words about pasting are kept.
        let engine = "This field has no semantic text-write action. If typing refuses because the field cannot be focused, use clipboard-set and the app's paste shortcut, then verify the field."
        XCTAssertTrue(EngineVerdict.suggestion(engine).contains("the Mac's clipboard is not used"))
        XCTAssertEqual(EngineVerdict.suggestion("The pasted value was rejected; check its format."), "The pasted value was rejected; check its format.")
        XCTAssertTrue(EngineVerdict.suggestion("Run list-windows").contains("agent windows"))
    }

    /// Agents never reach the general pasteboard: no NSPasteboard and no engine clipboard call in any Hands source.
    func testHandsNeverTouchesTheMacsPasteboard() throws {
        let core = try FileManager.default.contentsOfDirectory(atPath: HandsSourceTests.root.appendingPathComponent("Sources/BaneySpacesCore/Hands").path)
            .filter { $0.hasSuffix(".swift") }.map { "Sources/BaneySpacesCore/Hands/" + $0 }
        let files = try HandsSourceTests.handsFiles() + core
        XCTAssertGreaterThan(files.count, 8)
        for f in files {
            let text = try HandsSourceTests.code(f)
            // 198 r1 second-N2: Carbon's Pasteboard Manager and the pb tools are the other ways in.
            for b in ["NSPasteboard", "ad_get_clipboard", "ad_set_clipboard", "UIPasteboard", "PasteboardCreate", "kPasteboardClipboard",
                      "PasteboardCopyItemFlavorData", "pbcopy", "pbpaste", "import Carbon\n"] { XCTAssertFalse(text.contains(b), "\(f) must not use \(b)") }
        }
        let session = try HandsSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertTrue(session.contains("SessionClipboardBox.shared.end(session: e.session)"), "an ended session's text goes")
    }

    /// 198 r1 first-F3: callers with no session of their own share one id, so they get no clipboard.
    func testACallWithNoSessionOfItsOwnGetsNoClipboard() {
        var b = SessionClipboard()
        for none in ["", "default"] {
            XCTAssertTrue(b.copy("secret", session: none, now: t0)?.message.contains("needs a session of its own") == true, none)
            XCTAssertTrue(error(b.paste(session: none, now: t0))?.suggestion.contains("BANEYSPACES_SESSION") == true, none)
        }
        XCTAssertEqual(b.sessions, 0)
        XCTAssertNil(b.copy("mine", session: "mcp:1", now: t0))
    }

    /// 198 r1 first-F2: a click or select of Cut, Copy or Paste would have the app write the Mac's pasteboard.
    func testCutCopyAndPasteItemsAreRefused() {
        func item(_ name: String, _ n: Int, id: String? = nil, role: String = "menuitem") -> JSONValue {
            var o: [String: JSONValue] = ["role": .string(role), "name": .string(name), "ref_id": .string("@s:e\(n)")]
            if let id { o["native_id"] = .object(["kind": "ax_identifier", "value": .string(id)]) }
            return .object(o)
        }
        let rows = SnapshotRows.rows(of: .object(["role": "window", "children": .array([
            .object(["role": "menu", "ref_id": "@s:e1", "children": .array([item("Kopieren", 2, id: "copy:"), item("Einf\u{FC}gen", 3, id: "paste:"),
                                                                             item("Paste", 4), item("Alles ausw\u{E4}hlen", 5, id: "selectAll:")])]),
            item("Copy", 6, role: "button"), .object(["role": "popupbutton", "ref_id": "@s:e7", "children": .array([item("Ausschneiden", 8, id: "cut:")])])])]))
        typealias C = SessionClipboard
        XCTAssertEqual(C.pasteboardItem(rows: rows, number: 2, option: nil), "Kopieren", "by its action, in any language")
        XCTAssertEqual(C.pasteboardItem(rows: rows, number: 3, option: nil), "Einf\u{FC}gen")
        XCTAssertEqual(C.pasteboardItem(rows: rows, number: 4, option: nil), "Paste", "by English title, with no action")
        XCTAssertNil(C.pasteboardItem(rows: rows, number: 5, option: nil), "Select All")
        XCTAssertNil(C.pasteboardItem(rows: rows, number: 6, option: nil), "an app's own button")
        XCTAssertEqual(C.pasteboardItem(rows: rows, number: 7, option: "Ausschneiden"), "Ausschneiden", "select of an option under it")
        XCTAssertNil(C.pasteboardItem(rows: rows, number: 1, option: "Paste and Match Style"), "no such row: the engine refuses it once the menu is open (198 r2 first-F3)")
        XCTAssertNil(C.pasteboardItem(rows: rows, number: 7, option: "Kopieren"), "the item must be under the ref")
        XCTAssertNil(C.pasteboardItem(rows: rows, number: 1, option: "Alles ausw\u{E4}hlen"))
    }

    /// 198 r1 first-F1, first-F4, second-N1: the router's side, in its source.
    func testTheRouterReadsTheLayoutOnMainAndTheClipboardAtDispatch() throws {
        let layout = try HandsSourceTests.code("Sources/BaneySpaces/Hands/KeyLayout.swift")
        let entry = try XCTUnwrap(HandsSourceTests.block(after: "static func characters(_ keyCode: UInt16) -> [Character]", in: layout))
        XCTAssertTrue(entry.contains("Thread.isMainThread ? read(keyCode) : DispatchQueue.main.sync { read(keyCode) }"), "TIS only on main")
        XCTAssertEqual(layout.components(separatedBy: "TISCopy").count - 1, 2, "the layouts are read in one place")
        XCTAssertTrue(layout.contains("private static func read("))
        XCTAssertTrue(layout.contains("KeyTranslation.characters(keyCode, layouts:"), "the translation is the tested one")
        let translation = try HandsSourceTests.code("Sources/BaneySpacesCore/Hands/KeyTranslation.swift")
        XCTAssertTrue(translation.contains("OptionBits(kUCKeyTranslateNoDeadKeysMask)") && !translation.contains("NoDeadKeysBit"), "the mask, not the bit index")
        XCTAssertTrue(translation.contains("[0, command]"), "with command held too")
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let act = try XCTUnwrap(HandsSourceTests.block(after: "private func act(", in: router))
        let refuse = try XCTUnwrap(act.range(of: "pasteboardItem(ref, option:"))
        let resolve = try XCTUnwrap(act.range(of: "switch resolve(ref, session: session)"))
        let wait = try XCTUnwrap(act.range(of: "awaitUse(w, verb: name"))
        let paste = try XCTUnwrap(act.range(of: "SessionClipboardBox.shared.paste(session: session)"))
        XCTAssertLessThan(refuse.lowerBound, resolve.lowerBound)
        XCTAssertLessThan(wait.lowerBound, paste.lowerBound, "the copied text is read once the app is free")
        XCTAssertFalse(router.contains("typedText"))
    }

    /// 198 r1 first-F5, second-N3: the spec's syntax, and which catalog the Mac's arguments live in.
    func testTheSpecSaysHowAndWhere() throws {
        let cli = try HandsSourceTests.code("spec/cli.md")
        XCTAssertTrue(cli.contains("`agent get <ref> --copy`, `agent type <ref> --paste`"))
        XCTAssertTrue(cli.contains("`computer_*` tools come from its own catalog"))
        guard case .failure(let e) = HandsParse.command(["type", "@s1:e1", "hi", "--paste"]) else { return XCTFail("text and paste") }
        XCTAssertTrue(e.message.contains("not both"), e.message)
        XCTAssertEqual(try HandsParse.command(["type", "@s1:e1", "--paste"]).get().bool("paste"), true)
    }
}
