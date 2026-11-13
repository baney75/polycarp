import Carbon.HIToolbox
import XCTest
@testable import BaneySpacesCore

/// 198 r2: the cut, copy and paste refusal holds for any ref, any layout and a closed popup.
final class SessionClipboardRefusalTests: XCTestCase {
    typealias C = SessionClipboard

    func entry(_ role: String, _ name: String, id: String? = nil) -> String {
        let native = id.map { #","native_id":{"kind":"ax_identifier","value":"\#($0)"}"# } ?? ""
        return #"{"pid":7,"source_window_id":"w-9","role":"\#(role)","name":"\#(name)"\#(native)}"#
    }

    /// first-F1: a click is checked against the snapshot's own refmap, which lives as long as its refs resolve, not
    /// against the session's last six reads.
    func testAClickIsRefusedFromTheSnapshotsRefmapHoweverManyReadsCameAfter() throws {
        let refmap = #"{"inner":{"@e2":\#(entry("menuitem", "Kopieren", id: "copy:")),"@e3":\#(entry("button", "Copy")),"#
            + #""@e4":\#(entry("menuitem", "Paste")),"@e5":\#(entry("menuitem", "Copy", id: "syncMode:")),"@e6":\#(entry("menuitem", "Rename"))}}"#
        XCTAssertEqual(C.pasteboardRefs(refmap: Data(refmap.utf8)), ["@e2": "Kopieren", "@e4": "Paste"])
        XCTAssertEqual(C.pasteboardRefs(refmap: Data("[]".utf8)), [:])
        // The rows memory alone forgets the read after six more: that is what the refmap check stands in for.
        var m = SnapshotRowsMemory()
        for i in 0...SnapshotRowsMemory.history { m.remember(session: "a", window: 9, view: "snapshot", snapshot: "s\(i)", rows: [], now: Date()) }
        XCTAssertNil(m.read(snapshot: "s0", session: "a"))
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        // 214 r1 second-S2: recorded when the snapshot is taken, parsed before the router-wide lock.
        let remember = try XCTUnwrap(HandsSourceTests.block(after: "private func remember(_ data: JSONValue", in: router))
        let parse = try XCTUnwrap(remember.range(of: "let pasteboard = SessionClipboard.pasteboardRefs(refmap: file)"))
        XCTAssertLessThan(parse.lowerBound, try XCTUnwrap(remember.range(of: "lock.lock()")).lowerBound)
        XCTAssertTrue(remember.contains("pasteboard: pasteboard)"))
        let check = try XCTUnwrap(HandsSourceTests.block(after: "private func pasteboardItem(", in: router))
        let held = try XCTUnwrap(check.range(of: "snaps[sid]?.pasteboard[key]")), rows = try XCTUnwrap(check.range(of: "withRows("))
        XCTAssertLessThan(held.lowerBound, rows.lowerBound)
    }

    /// 214 r1 first-F2: a refmap the engine itself wrote (agent-desktop's `RefMap`, serialized by serde in its own
    /// test), so a change to its shape fails here, not in silence. Its keys are the ones a ref resolves to.
    func testAnEngineWrittenRefmapGivesItsPasteboardRefs() throws {
        let url = HandsSourceTests.root.appendingPathComponent("Tests/BaneySpacesCoreTests/Fixtures/engine-refmap-menu.json")
        let file = try Data(contentsOf: url)
        let refs = C.pasteboardRefs(refmap: file)
        XCTAssertEqual(refs, ["@e1": "Kopieren", "@e3": "Paste", "@e5": "Copy", "@e6": "Paste"])
        XCTAssertNotNil(refs[try XCTUnwrap(RefmapIdentity.key(forRef: "@sX:e1"))])
        let table = try XCTUnwrap(RefmapIdentity.table(from: file))
        XCTAssertTrue(RefmapIdentity.allTarget(table, window: 9, pid: 7))
    }

    /// 214 r1 first-F1, first-F4: only an action-shaped identifier clears an English title; titles are trimmed.
    func testAnAppsOwnIdentifierOnARealCopyItemStillCounts() {
        XCTAssertTrue(C.isPasteboardItem(role: "menuitem", name: "Copy", identifier: "menu.edit.copy"))
        XCTAssertFalse(C.isPasteboardItem(role: "menuitem", name: "Kopieren", identifier: "menu.edit.copy"))
        XCTAssertFalse(C.isPasteboardItem(role: "menuitem", name: "Copy", identifier: "syncMode:"), "wired to another action")
        XCTAssertTrue(C.isPasteboardItem(role: "menuitem", name: "Kopieren", identifier: " copy: "))
        XCTAssertTrue(C.isPasteboardItem(role: "menuitem", name: " Paste\n", identifier: ""), "trimmed, as the engine trims")
    }

    /// 214 r1 first-F3: text with paste is wrong arguments, said before the ref resolves or the app is waited for.
    func testTextWithPasteIsRefusedBeforeAnyWait() throws {
        XCTAssertEqual(C.both(text: "x", paste: true)?.code, .badArguments)
        XCTAssertNil(C.both(text: nil, paste: true))
        XCTAssertNil(C.both(text: "x", paste: false))
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let act = try XCTUnwrap(HandsSourceTests.block(after: "private func act(_ req: HandsRequest", in: router))
        let refuse = try XCTUnwrap(act.range(of: "SessionClipboard.both(text: text, paste: pasted)"))
        XCTAssertLessThan(refuse.lowerBound, try XCTUnwrap(act.range(of: "resolve(ref, session: session)")).lowerBound)
    }

    /// first-F3, second-S1: by identifier first; an option is matched ignoring case; a closed popup's item is the engine's.
    func testItemsAreJudgedByIdentifierAndOptionsIgnoringCase() {
        func item(_ name: String, _ n: Int, id: String? = nil) -> JSONValue {
            var o: [String: JSONValue] = ["role": "menuitem", "name": .string(name), "ref_id": .string("@s:e\(n)")]
            if let id { o["native_id"] = .object(["kind": "ax_identifier", "value": .string(id)]) }
            return .object(o)
        }
        let rows = SnapshotRows.rows(of: .object(["role": "window", "children": .array([
            .object(["role": "popupbutton", "ref_id": "@s:e1", "children": .array([item("Kopieren", 2, id: "copy:"), item("Copy", 3, id: "syncMode:")])]),
            .object(["role": "popupbutton", "ref_id": "@s:e4"])])]))
        XCTAssertEqual(C.pasteboardItem(rows: rows, number: 1, option: "kopieren"), "Kopieren", "the engine matches ignoring case")
        XCTAssertNil(C.pasteboardItem(rows: rows, number: 1, option: "Copy"), "an item titled Copy wired to another action is the app's")
        XCTAssertNil(C.pasteboardItem(rows: rows, number: 3, option: nil))
        XCTAssertNil(C.pasteboardItem(rows: rows, number: 4, option: "Paste"), "a closed popup: no title shortcut, the engine checks the item")
        XCTAssertTrue(C.isPasteboardItem(role: "menuitem", name: "Paste", identifier: ""))
        XCTAssertFalse(C.isPasteboardItem(role: "button", name: "Paste", identifier: ""))
    }

    /// second-S1: the engine refuses the item it found in the opened popup before pressing it (patch 0003), and the
    /// router answers with its own refusal.
    func testTheEnginesRefusalInAnOpenedPopupIsOurs() throws {
        let err: JSONValue = .object(["code": "POLICY_DENIED", "message": "Select refused a cut, copy or paste menu item",
                                      "details": .object(["kind": "pasteboard_item", "identifier": "copy:", "title": ""])])
        let e = try XCTUnwrap(C.engineRefusal(err))
        XCTAssertEqual(e.code, .notSupported)
        XCTAssertTrue(e.message.hasPrefix("copy: uses the Mac's clipboard"), e.message)
        XCTAssertNil(C.engineRefusal(.object(["code": "POLICY_DENIED", "message": "no"])))
        let engine = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsEngine.swift")
        let translate = try XCTUnwrap(HandsSourceTests.block(after: "static func translate(_ err: JSONValue) -> HandsError", in: engine))
        let ours = try XCTUnwrap(translate.range(of: "if let refusal = SessionClipboard.engineRefusal(err) { return refusal }"))
        XCTAssertLessThan(ours.lowerBound, try XCTUnwrap(translate.range(of: "let code = err[")).lowerBound, "before any other mapping")
        let patch = try String(contentsOf: HandsSourceTests.root.appendingPathComponent("engine/patches/0003-select-refuses-pasteboard-items.patch"), encoding: .utf8)
        let refuse = try XCTUnwrap(patch.range(of: "+            refuse_pasteboard_item(&candidate, deadline)?;"))
        let press = try XCTUnwrap(patch.range(of: "             let verified = activate_menu_item(&candidate, deadline)?;"))
        XCTAssertLessThan(refuse.lowerBound, press.lowerBound, "after the popup opens and the item is found, before the press")
        XCTAssertTrue(patch.contains(#""kind": "pasteboard_item""#) && patch.contains(#"surface_read::string(candidate, "AXIdentifier""#))
    }

    func layout(_ id: String) throws -> Data {
        let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
        let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource] ?? []
        let source = try XCTUnwrap(list.first, "\(id) is installed with macOS")
        let raw = try XCTUnwrap(TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData))
        return Data(Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data)
    }

    /// first-F2: the translation `KeyLayout` uses, given Dvorak's and Russian's own layout data.
    func testKeyTranslationReadsDvorakAndRussian() throws {
        let kind = UInt32(LMGetKbdType())
        let dvorak = try layout("com.apple.keylayout.Dvorak"), russian = try layout("com.apple.keylayout.Russian"), us = try layout("com.apple.keylayout.US")
        let i = UInt16(kVK_ANSI_I), c = UInt16(kVK_ANSI_C)
        XCTAssertEqual(KeyTranslation.character(i, modifiers: 0, layout: dvorak, keyboardType: kind), "c", "Dvorak types c where ANSI has i")
        XCTAssertTrue(KeyTranslation.characters(i, layouts: [dvorak], keyboardType: kind).contains("c"))
        XCTAssertTrue(C.usesPasteboard(try KeyParse.chord("cmd+i").get(), characters: KeyTranslation.characters(i, layouts: [dvorak], keyboardType: kind)))
        XCTAssertFalse(KeyTranslation.characters(c, layouts: [dvorak], keyboardType: kind).contains("c"), "and j where ANSI has c")
        XCTAssertEqual(KeyTranslation.character(c, modifiers: 0, layout: russian, keyboardType: kind), "\u{0441}", "Russian types es")
        XCTAssertTrue(KeyTranslation.characters(c, layouts: [russian, us], keyboardType: kind).contains("c"), "the ASCII-capable layout gives the shortcut's c")
        XCTAssertEqual(KeyTranslation.characters(c, layouts: [Data(), Data([1, 2, 3])], keyboardType: kind), [], "data too short for a layout header gives no characters")
    }

    /// first-F4: the layout is read only for a chord with command held, so a plain sequence never waits on main.
    func testTheLayoutIsReadOnlyForACommandChord() throws {
        var reads = 0
        func probe() -> [Character] { reads += 1; return ["c"] }
        XCTAssertFalse(C.usesPasteboard(try KeyParse.chord("ctrl+i").get(), characters: probe()))
        XCTAssertFalse(C.usesPasteboard(try KeyParse.chord("h").get(), characters: probe()))
        XCTAssertEqual(reads, 0)
        XCTAssertTrue(C.usesPasteboard(try KeyParse.chord("cmd+c").get(), characters: probe()))
        XCTAssertEqual(reads, 0, "the key code alone decides")
        XCTAssertTrue(C.usesPasteboard(try KeyParse.chord("cmd+i").get(), characters: probe()))
        XCTAssertEqual(reads, 1)
    }

    /// second-S2, first-F5: the router refuses text plus paste itself, and the stray doc comment is gone.
    func testTheRouterRefusesTextPlusPaste() throws {
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let act = try XCTUnwrap(HandsSourceTests.block(after: "private func act(", in: router))
        XCTAssertTrue(act.contains("SessionClipboard.typed(text: text, paste: true,"))
        XCTAssertFalse(act.contains("typed(text: nil"))
        let raw = try String(contentsOf: HandsSourceTests.root.appendingPathComponent("Sources/BaneySpaces/Hands/HandsRouter.swift"), encoding: .utf8)
        XCTAssertFalse(raw.contains("/// `type`'s text: the text argument"))
    }

    /// second-S3: the docs say the session id is trusted as given.
    func testTheDocsSaySessionIdsAreTrustedAsGiven() throws {
        let cli = try HandsSourceTests.code("spec/cli.md")
        XCTAssertTrue(cli.contains("The session id is trusted as given"))
        let changelog = try HandsSourceTests.code("CHANGELOG.md")
        XCTAssertTrue(changelog.contains("Any other session id is trusted as given"))
    }
}
