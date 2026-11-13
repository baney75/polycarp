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
            for b in ["NSPasteboard", "ad_get_clipboard", "ad_set_clipboard", "UIPasteboard"] { XCTAssertFalse(text.contains(b), "\(f) must not use \(b)") }
        }
        let session = try HandsSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertTrue(session.contains("SessionClipboardBox.shared.end(session: e.session)"), "an ended session's text goes")
    }
}
