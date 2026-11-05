import XCTest
@testable import BaneySpacesCore

final class VoiceTests: XCTestCase {
    private func temp() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("voice-test-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: d) }
        return d
    }
    private func write(_ s: String, _ url: URL) {
        try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! Data(s.utf8).write(to: url)
    }
    private func read(_ url: URL) -> String? { try? String(contentsOf: url, encoding: .utf8) }

    // MARK: Wire types (shapes the Rust core produces)

    func testStateDecodesWhatPcStatusSends() throws {
        let json = #"{"status":"needs_model","detail":null,"model":null,"hotkeyLabel":"Right ⌘","hotkey":"CmdRight","enabled":true,"listener":false,"permissions":{"microphone":"Unknown"}}"#
        let s = try JSONDecoder().decode(VoiceState.self, from: Data(json.utf8))
        XCTAssertEqual(s.status, .needsModel)
        XCTAssertEqual(s.hotkeyLabel, "Right ⌘")
    }

    func testSettingsRoundTripKeepsEveryKey() throws {
        let json = #"{"hotkey":"CmdRight","tapToToggle":true,"model":"parakeet-v3","modelSource":"user","language":"en","removeFillers":true,"trailingSpace":true,"typingSpeed":"fast","newlineAsShiftEnter":true,"learnFromEdits":true,"sounds":true,"showOverlay":true,"launchAtLogin":true,"microphone":null,"onboarded":true,"updateChannel":"stable","autoUpdate":true}"#
        let s = try JSONDecoder().decode(VoiceSettings.self, from: Data(json.utf8))
        let back = try JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as! [String: Any]
        let orig = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
        XCTAssertEqual(Set(back.keys).subtracting(["microphone"]), Set(orig.keys).subtracting(["microphone"]))
        XCTAssertEqual(s.modelSource, "user")
    }

    func testModelsHistoryAndDictionaryDecode() throws {
        let m = #"[{"id":"parakeet-v3","name":"Parakeet v3","tier":"balanced","tagline":"x","sizeMb":478,"languages":"en","installed":true,"active":true,"recommended":true,"deviceResult":null,"bestForDevice":false}]"#
        XCTAssertEqual(try JSONDecoder().decode([VoiceModel].self, from: Data(m.utf8)).first?.sizeMb, 478)
        let h = #"[{"id":"a","ts":"2026-11-05T10:00:00Z","text":"hello","raw":"hello","durationS":1.0,"latencyMs":120,"words":1,"corrected":"Hello"}]"#
        let item = try JSONDecoder().decode([VoiceHistoryItem].self, from: Data(h.utf8)).first
        XCTAssertEqual(item?.shown, "Hello")
        let d = #"{"terms":[{"text":"Polycarp","source":"user","added":"x","uses":0}],"corrections":[{"from":"a","to":"b","count":1,"source":"user","added":"x"}],"pending":[],"fillers":["um"]}"#
        let dict = try JSONDecoder().decode(VoiceDictionary.self, from: Data(d.utf8))
        XCTAssertEqual(dict.terms.first?.text, "Polycarp")
        XCTAssertEqual(dict.corrections.first?.to, "b")
    }

    func testMenuWordsAndOverlayFollowTheTauriTray() {
        XCTAssertEqual(VoiceStatus.ready.menuLine(hotkeyLabel: "Right ⌘"), "Ready · hold Right ⌘ to speak")
        XCTAssertEqual(VoiceStatus.recording.menuLine(hotkeyLabel: ""), "Listening…")
        XCTAssertEqual(VoiceStatus.typing.menuLine(hotkeyLabel: ""), "Writing…")
        XCTAssertEqual(VoiceStatus.error.menuLine(hotkeyLabel: ""), "Needs attention")
        XCTAssertEqual(VoiceStatus.allCases_overlay, [.recording, .transcribing, .typing])
        XCTAssertTrue(VoiceStatus.recording.isLive)
        XCTAssertFalse(VoiceStatus.transcribing.isLive)
    }

    // MARK: Import from Silas

    func testImportCopiesDataAndModelsAndNeverTouchesSilas() throws {
        let silas = temp(), new = temp().appendingPathComponent("voice")
        write("{\"hotkey\":\"CmdRight\"}", silas.appendingPathComponent("settings.json"))
        write("{\"terms\":[]}", silas.appendingPathComponent("dictionary.json"))
        write("[]", silas.appendingPathComponent("history.json"))
        write("old", silas.appendingPathComponent("dictionary.json.bak-20261019"))
        write("weights", silas.appendingPathComponent("models/parakeet-v3/model.onnx"))
        write("ok", silas.appendingPathComponent("models/parakeet-v3/.complete"))
        write("half", silas.appendingPathComponent("models/cohere-int4/part.onnx"))
        let before = try FileManager.default.subpathsOfDirectory(atPath: silas.path).sorted()

        guard case .imported(let r) = VoiceImport.run(silasDir: silas, newDir: new) else { return XCTFail("not imported") }
        XCTAssertEqual(r.copiedFiles, ["dictionary.json", "history.json", "settings.json"])
        XCTAssertEqual(r.copiedModels, ["parakeet-v3"])
        XCTAssertEqual(read(new.appendingPathComponent("models/parakeet-v3/model.onnx")), "weights")
        XCTAssertTrue(FileManager.default.fileExists(atPath: new.appendingPathComponent("models/parakeet-v3/.complete").path), "nothing re-downloads")
        XCTAssertFalse(FileManager.default.fileExists(atPath: new.appendingPathComponent("models/cohere-int4").path), "a half download isn't copied")
        XCTAssertFalse(FileManager.default.fileExists(atPath: new.appendingPathComponent("dictionary.json.bak-20261019").path))
        XCTAssertEqual(try FileManager.default.subpathsOfDirectory(atPath: silas.path).sorted(), before, "Silas's folder is unchanged")
        XCTAssertEqual(read(silas.appendingPathComponent("settings.json")), "{\"hotkey\":\"CmdRight\"}")
        XCTAssertEqual(VoiceImport.run(silasDir: silas, newDir: new), .alreadyImported)
    }

    func testImportKeepsAFilePolycarpAlreadyHasAndSaysWhenThereIsNothing() {
        let silas = temp(), new = temp()
        XCTAssertEqual(VoiceImport.run(silasDir: silas, newDir: new), .nothingToImport)
        XCTAssertFalse(FileManager.default.fileExists(atPath: new.appendingPathComponent(VoiceImport.markerName).path), "no marker when nothing was there")
        write("silas", silas.appendingPathComponent("settings.json"))
        write("mine", new.appendingPathComponent("settings.json"))
        VoiceImport.run(silasDir: silas, newDir: new)
        XCTAssertEqual(read(new.appendingPathComponent("settings.json")), "mine")
    }

    func testAFailedFileIsTriedAgainNextLaunch() {
        let silas = temp(), new = temp()
        write("[]", silas.appendingPathComponent("history.json"))
        // A directory where a file belongs can't be read as one.
        try! FileManager.default.createDirectory(at: silas.appendingPathComponent("dictionary.json"), withIntermediateDirectories: true)
        guard case .partial(let r) = VoiceImport.run(silasDir: silas, newDir: new) else { return XCTFail("expected partial") }
        XCTAssertEqual(r.failed, ["dictionary.json"])
        XCTAssertEqual(VoiceImport.pending(in: new), ["dictionary.json"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: new.appendingPathComponent(VoiceImport.markerName).path))
        try! FileManager.default.removeItem(at: silas.appendingPathComponent("dictionary.json"))
        write("{}", silas.appendingPathComponent("dictionary.json"))
        guard case .imported(let again) = VoiceImport.run(silasDir: silas, newDir: new) else { return XCTFail("expected imported") }
        XCTAssertEqual(again.copiedFiles, ["dictionary.json"])
        XCTAssertNil(VoiceImport.pending(in: new))
    }

    func testPathsAreUnderThePolycarpFolder() {
        let home = URL(fileURLWithPath: "/h")
        XCTAssertEqual(Product.voiceDir(home: home).path, "/h/Library/Application Support/Polycarp/voice")
        XCTAssertEqual(Product.silasSupportDir(home: home).path, "/h/Library/Application Support/Silas")
    }

    // MARK: Silas running

    func testASilasThatRunsGetsTheSameOneAlert() {
        XCTAssertEqual(LegacyHandover.alertTitle(running: ["Silas"]), "Silas is running. Polycarp replaces it.")
        XCTAssertEqual(LegacyHandover.alertTitle(running: ["BaneySpaces", "Silas"]), "BaneySpaces and Silas are running. Polycarp replaces them.")
        XCTAssertEqual(LegacyHandover.alertTitle(running: ["BaneySpaces"]), LegacyHandover.alertTitle, "unchanged for the old case")
        XCTAssertEqual(LegacyHandover.continueButton(running: ["Silas"]), "Quit Silas and Continue")
        XCTAssertTrue(LegacyHandover.alertDetail(running: ["Silas"]).contains("copied, never moved"))
        XCTAssertTrue(LegacyHandover.applies(oneShot: false, legacyPids: [7]))
    }

    func testSilasStartingLaterIsAskedToQuitToo() {
        XCTAssertEqual(LegacyHandover.onLaunch(bundleID: "com.baney.silas", alreadyNotified: false), .init(quit: true, notify: true))
        XCTAssertEqual(LegacyHandover.onLaunch(bundleID: "com.baney.silas", alreadyNotified: true), .init(quit: true, notify: false))
    }

    func testPolycarpRefusesTheHotkeyWhileSilasRuns() {
        XCTAssertEqual(LegacyHandover.voiceStart(silasPids: []), .start)
        guard case .refuse(let why) = LegacyHandover.voiceStart(silasPids: [42]) else { return XCTFail("must refuse") }
        XCTAssertTrue(why.contains("Silas is running"))
    }

    func testTheInstallerTreatsSilasAsAnOldApp() throws {
        let sh = try Repo.text("scripts/install-app.sh")
        let env = try Repo.text("scripts/product.env")
        XCTAssertTrue(env.contains("SILAS_BUNDLE_ID=com.baney.silas"))
        XCTAssertTrue(sh.contains(#"tell application id \"$SILAS_BUNDLE_ID\" to quit"#), "quits it")
        XCTAssertTrue(sh.contains(#"for dir in /Applications "$HOME/Applications""#) && sh.contains("$dir/$SILAS_NAME.app"), "looks in both Applications folders")
        XCTAssertTrue(sh.contains(".Trash/$SILAS_NAME-"), "Trash, not delete")
        XCTAssertFalse(sh.contains("rm -rf \"$SILAS"), "never deletes it")
        XCTAssertFalse(sh.contains("Application Support/$SILAS"), "its data stays")
        let quit = try XCTUnwrap(sh.range(of: #"tell application id \"$SILAS_BUNDLE_ID\" to quit"#))
        let copy = try XCTUnwrap(sh.range(of: "cp -R \"$APP\" \"$DEST\""))
        let trash = try XCTUnwrap(sh.range(of: ".Trash/$SILAS_NAME-"))
        XCTAssertLessThan(quit.lowerBound, copy.lowerBound, "quit, then install")
        XCTAssertLessThan(copy.lowerBound, trash.lowerBound, "then Trash")
    }
}

extension VoiceStatus {
    static let allCases_overlay: [VoiceStatus] = [.loading, .needsModel, .ready, .recording, .transcribing, .typing, .error].filter(\.showsOverlay)
}

final class VoiceSpeedRatchetTests: XCTestCase {
    func testTheBaselinesAreThere_andTheLimitIsTwentyFivePercent() throws {
        let data = try Data(contentsOf: Repo.root.appendingPathComponent("spec/speed.json"))
        let j = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(j["regressionLimit"] as? Double, 1.25)
        let start = try XCTUnwrap((j["startToReadyMs"] as? [String: Any])?["baseline"] as? Double)
        XCTAssertGreaterThan(start, 0)
        XCTAssertNotNil(j["transcribeRtf"], "the key stays so a measured RTF has a place")
        let rust = try Repo.text("../core/ffi/tests/speed.rs")
        XCTAssertTrue(rust.contains("fn fast_path_has_not_regressed"), "the test that enforces the baseline")
        XCTAssertTrue(rust.contains("const LIMIT: f64 = 1.25;"))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: Repo.root.appendingPathComponent("scripts/bench-voice").path))
    }
}
