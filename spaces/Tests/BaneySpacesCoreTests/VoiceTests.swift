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

    func testTheInstallerQuitsSilasButLeavesItInstalled() throws {
        let sh = try Repo.text("scripts/install-app.sh")
        let env = try Repo.text("scripts/product.env")
        XCTAssertTrue(env.contains("SILAS_BUNDLE_ID=com.baney.silas"))
        XCTAssertTrue(sh.contains(#"tell application id \"$SILAS_BUNDLE_ID\" to quit"#), "quits it so the key is free")
        XCTAssertFalse(sh.contains(".Trash/$SILAS_NAME"), "the installer never trashes Silas; Polycarp does, after its dictation has typed")
        XCTAssertFalse(sh.contains("mv \"$dir/$SILAS_NAME.app\""))
        XCTAssertFalse(sh.contains("rm -rf \"$SILAS"))
        XCTAssertFalse(sh.contains("Application Support/$SILAS"), "its data stays")
        XCTAssertTrue(sh.contains("voiceEnabled"), "with voice switched off, Silas is left running")
    }

    func testTheInstallerRunThroughTrashesNothingOfSilas() throws {
        // A temp HOME with a planted Silas.app; test mode (BANEYSPACES_DEST_DIR) skips every step that touches the machine.
        let home = temp()
        let silas = home.appendingPathComponent("Applications/Silas.app/Contents")
        write("silas", silas.appendingPathComponent("MacOS/Silas"))
        let stamp = try FileManager.default.attributesOfItem(atPath: silas.deletingLastPathComponent().path)[.modificationDate] as? Date
        let dest = temp()
        let fake = temp().appendingPathComponent("Polycarp.app/Contents/MacOS")
        write("x", fake.appendingPathComponent("Polycarp"))
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [Repo.root.appendingPathComponent("scripts/install-app.sh").path, "--in-place", fake.deletingLastPathComponent().deletingLastPathComponent().path]
        p.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin", "BANEYSPACES_DEST_DIR": dest.path, "BANEYSPACES_NO_LAUNCH": "1"]
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        try p.run(); p.waitUntilExit()
        XCTAssertTrue(FileManager.default.fileExists(atPath: silas.path), "Silas is still in the temp home's Applications")
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: silas.deletingLastPathComponent().path)[.modificationDate] as? Date, stamp)
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(".Trash").path), "nothing went to a Trash")
    }

    // MARK: When voice listens

    func testVoiceListensOnlyWithAModelAnImportedSilasAndTheSwitchOn() {
        typealias G = VoiceGate
        XCTAssertEqual(G.decide(userEnabled: true, modelInstalled: true, importFinished: true, silasPids: []), .start)
        XCTAssertEqual(G.decide(userEnabled: true, modelInstalled: false, importFinished: true, silasPids: []), .wait(.needsModel), "no model, no key")
        XCTAssertEqual(G.decide(userEnabled: true, modelInstalled: true, importFinished: false, silasPids: []), .wait(.importPending))
        XCTAssertEqual(G.decide(userEnabled: false, modelInstalled: true, importFinished: true, silasPids: []), .wait(.userOff))
        XCTAssertEqual(G.decide(userEnabled: true, modelInstalled: true, importFinished: true, silasPids: [9]), .wait(.silasRunning))
        XCTAssertEqual(G.decide(userEnabled: false, modelInstalled: true, importFinished: true, silasPids: [9]), .wait(.userOff), "the person's Off outlives Silas quitting")
        XCTAssertNil(G.message(.userOff))
        XCTAssertTrue(G.message(.needsModel)!.contains("Settings > Voice"))
    }

    func testAModelImportedFromSilasCounts() {
        let silas = temp(), new = temp()
        XCTAssertFalse(VoiceGate.hasModel(in: [new, silas]))
        write("w", silas.appendingPathComponent("models/parakeet-v3/m.onnx"))
        XCTAssertFalse(VoiceGate.hasModel(in: [new, silas]), "a half download is not a model")
        write("ok", silas.appendingPathComponent("models/parakeet-v3/.complete"))
        XCTAssertTrue(VoiceGate.hasModel(in: [new, silas]))
        XCTAssertFalse(VoiceImport.isFinished(silasDir: silas, newDir: new), "there is something to bring across")
        VoiceImport.run(silasDir: silas, newDir: new)
        XCTAssertTrue(VoiceImport.isFinished(silasDir: silas, newDir: new))
        XCTAssertTrue(VoiceGate.hasModel(in: [new]), "now it's Polycarp's own")
        XCTAssertTrue(VoiceImport.isFinished(silasDir: temp(), newDir: temp()), "no Silas data at all: nothing to wait for")
    }

    func testSilasIsLeftAloneUnlessPolycarpsDictationTakesOver() {
        XCTAssertEqual(LegacyHandover.onLaunch(bundleID: "com.baney.silas", alreadyNotified: false, takesOver: false), .init(quit: false, notify: false))
        XCTAssertEqual(LegacyHandover.onLaunch(bundleID: "com.baney.silas", alreadyNotified: false, takesOver: true), .init(quit: true, notify: true))
        XCTAssertEqual(LegacyHandover.onLaunch(bundleID: "com.baney.baneyspaces", alreadyNotified: false, takesOver: false), .init(quit: true, notify: true), "BaneySpaces is unaffected")
        XCTAssertEqual(LegacyHandover.namesToReplace(running: ["com.baney.silas"], takesOver: false), [])
        XCTAssertEqual(LegacyHandover.namesToReplace(running: ["com.baney.silas", "com.baney.baneyspaces"], takesOver: false), ["BaneySpaces"])
        XCTAssertEqual(LegacyHandover.namesToReplace(running: ["com.baney.silas"], takesOver: true), ["Silas"])
        let detail = LegacyHandover.alertDetail(running: ["Silas"])
        XCTAssertTrue(detail.contains("dictation takes over from here"), detail)
        XCTAssertTrue(detail.contains("stays installed until that has worked once"), detail)
    }

    // MARK: Silas goes to the Trash after the first dictation that typed

    private func plantSilas(_ home: URL, in folder: String = "Applications") -> URL {
        let app = home.appendingPathComponent("\(folder)/Silas.app")
        write("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>com.baney.silas</string></dict></plist>", app.appendingPathComponent("Contents/Info.plist"))
        write("bin", app.appendingPathComponent("Contents/MacOS/silas"))
        return app
    }

    func testTheDecisionToRetireSilas() {
        let a = URL(fileURLWithPath: "/Applications/Silas.app")
        XCTAssertTrue(SilasRetirement.shouldRetire(voiceOn: true, typedText: true, alreadyRetired: false, silas: a, silasRunning: false))
        XCTAssertFalse(SilasRetirement.shouldRetire(voiceOn: false, typedText: true, alreadyRetired: false, silas: a, silasRunning: false), "voice off: Silas is the way back")
        XCTAssertFalse(SilasRetirement.shouldRetire(voiceOn: true, typedText: false, alreadyRetired: false, silas: a, silasRunning: false), "only a real typed result")
        XCTAssertFalse(SilasRetirement.shouldRetire(voiceOn: true, typedText: true, alreadyRetired: true, silas: a, silasRunning: false), "once")
        XCTAssertFalse(SilasRetirement.shouldRetire(voiceOn: true, typedText: true, alreadyRetired: false, silas: nil, silasRunning: false), "not at /Applications or ~/Applications")
        XCTAssertFalse(SilasRetirement.shouldRetire(voiceOn: true, typedText: true, alreadyRetired: false, silas: a, silasRunning: true))
    }

    func testSilasIsFoundOnlyInTheTwoApplicationsFolders() {
        let home = temp(), system = temp()
        XCTAssertNil(SilasRetirement.locate(home: home, systemApplications: system))
        _ = plantSilas(home, in: "Downloads")
        XCTAssertNil(SilasRetirement.locate(home: home, systemApplications: system), "a Silas in Downloads isn't touched")
        let mine = plantSilas(home)
        XCTAssertEqual(SilasRetirement.locate(home: home, systemApplications: system)?.path, mine.path)
    }

    func testRetiringMovesSilasRemovesOnlyItsLoginItemAndRecordsIt() throws {
        let home = temp(), voice = temp().appendingPathComponent("voice"), trash = temp()
        let app = plantSilas(home)
        let agents = home.appendingPathComponent("Library/LaunchAgents")
        let mine = SilasRetirement.loginItem(home: home)
        write("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>Silas</string><key>ProgramArguments</key><array><string>\(app.path)/Contents/MacOS/silas</string><string>--background</string></array></dict></plist>", mine)
        let other = agents.appendingPathComponent("com.example.other.plist")
        write("<plist version=\"1.0\"><dict/></plist>", other)
        let silasData = home.appendingPathComponent("Library/Application Support/Silas/history.json")
        write("[]", silasData)

        let report = SilasRetirement.retire(silas: app, home: home, voiceDir: voice) { url in
            let to = trash.appendingPathComponent(url.lastPathComponent)
            try FileManager.default.moveItem(at: url, to: to)
            return to
        }
        XCTAssertEqual(report.trashed?.path, trash.appendingPathComponent("Silas.app").path)
        XCTAssertTrue(report.loginItemRemoved)
        XCTAssertFalse(FileManager.default.fileExists(atPath: app.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: mine.path), "Silas's own login item is gone")
        XCTAssertTrue(FileManager.default.fileExists(atPath: other.path), "any other login item stays")
        XCTAssertTrue(FileManager.default.fileExists(atPath: silasData.path), "its data stays")
        XCTAssertTrue(FileManager.default.fileExists(atPath: voice.appendingPathComponent("silas-retired-record/Silas.plist").path), "a copy of what was removed")
        XCTAssertTrue(SilasRetirement.alreadyRetired(voiceDir: voice), "once only")
        XCTAssertFalse(SilasRetirement.shouldRetire(voiceOn: true, typedText: true, alreadyRetired: SilasRetirement.alreadyRetired(voiceDir: voice), silas: nil, silasRunning: false))
        XCTAssertEqual(SilasRetirement.notice, "Dictation works here, so Silas went to the Trash.")
    }

    func testALoginItemThatIsNotSilasIsNotRemoved() {
        let home = temp(), voice = temp()
        let app = plantSilas(home)
        let item = SilasRetirement.loginItem(home: home)
        write("<plist version=\"1.0\"><dict><key>ProgramArguments</key><array><string>/Applications/Something.app/Contents/MacOS/x</string></array></dict></plist>", item)
        let r = SilasRetirement.retire(silas: app, home: home, voiceDir: voice) { $0 }
        XCTAssertFalse(r.loginItemRemoved)
        XCTAssertTrue(FileManager.default.fileExists(atPath: item.path))
    }

    func testAFailedMoveLeavesNoMarkerSoItIsTriedAgain() {
        let home = temp(), voice = temp()
        let app = plantSilas(home)
        struct Boom: Error {}
        let r = SilasRetirement.retire(silas: app, home: home, voiceDir: voice) { _ in throw Boom() }
        XCTAssertNil(r.trashed)
        XCTAssertEqual(r.failed, ["app"])
        XCTAssertFalse(SilasRetirement.alreadyRetired(voiceDir: voice))
    }

    func testAnErrorShowsItsReasonInTheMenu() {
        XCTAssertEqual(VoiceStatus.error.menuLine(hotkeyLabel: "x", detail: "Polycarp can't hear your key yet."), "Polycarp can't hear your key yet.")
        XCTAssertEqual(VoiceStatus.error.menuLine(hotkeyLabel: "x"), "Needs attention")
        XCTAssertEqual(VoiceStatus.ready.menuLine(hotkeyLabel: "Right ⌘", detail: "ignored"), "Ready · hold Right ⌘ to speak")
    }

    func testTheNoticeNamesTheAppThatWasClosed() {
        XCTAssertEqual(LegacyHandover.notificationTitle(forBundleID: "com.baney.silas"), "Silas was closed")
        XCTAssertTrue(LegacyHandover.notificationBody(forBundleID: "com.baney.silas").contains("dictation key"))
        XCTAssertEqual(LegacyHandover.notificationTitle(forBundleID: "com.baney.baneyspaces"), "BaneySpaces was closed")
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

final class BrowserPreviousTests: XCTestCase {
    private func home() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("bp-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: d) }
        return d
    }
    private func write(_ s: String, _ url: URL) {
        try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! Data(s.utf8).write(to: url)
    }

    func testTheOldManifestAndLauncherAreWrittenDownOnce() throws {
        let h = home(), store = home()
        let chrome = h.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.tabkyra.bridge.json")
        write("old manifest", chrome)
        write("old launcher", h.appendingPathComponent(".config/tabkyra/host"))
        XCTAssertTrue(BrowserPrevious.record(home: h, store: store))
        let index = try String(contentsOf: store.appendingPathComponent("index.tsv"))
        XCTAssertTrue(index.contains(chrome.path), index)
        XCTAssertTrue(index.contains(".config/tabkyra/host"))
        XCTAssertTrue(index.contains("tabkyra\t-"), "the launcher that wasn't there is recorded as none")
        XCTAssertFalse(index.contains("Brave"), "a browser that isn't installed is not recorded")
        write("{\"path\":\"/Applications/Polycarp.app/x\"}", chrome)
        XCTAssertFalse(BrowserPrevious.record(home: h, store: store), "a second Connect records nothing new")
        XCTAssertEqual(try String(contentsOf: store.appendingPathComponent("index.tsv")), index)
    }

    func testAFileAlreadyPointingIntoPolycarpIsNotRecordedAsPrevious() throws {
        let h = home(), store = home()
        write("exec /Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser", h.appendingPathComponent(".config/tabkyra/host"))
        BrowserPrevious.record(home: h, store: store)
        let index = try String(contentsOf: store.appendingPathComponent("index.tsv"))
        XCTAssertFalse(index.contains("tabkyra/host\t"), index)
    }

    func testUninstallPutsThemBackOrRemovesWhatPolycarpMade() throws {
        let h = home(), store = home()
        let chrome = h.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.tabkyra.bridge.json")
        let host = h.appendingPathComponent(".config/tabkyra/host")
        let cli = h.appendingPathComponent(".config/tabkyra/tabkyra")
        write("old manifest", chrome); write("old launcher", host)
        BrowserPrevious.record(home: h, store: store)
        write("{\"path\":\"/Applications/Polycarp.app/h\"}", chrome)
        write("exec /Applications/Polycarp.app/h", host)
        write("exec /Applications/Polycarp.app/h", cli)
        let sh = try Repo.text("uninstall.sh")
        let from = try XCTUnwrap(sh.range(of: "# BEGIN restore-browser-previous"))
        let to = try XCTUnwrap(sh.range(of: "# END restore-browser-previous"))
        let block = String(sh[from.upperBound..<to.lowerBound])
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", "set -eu; STORE='\(store.path)'; \(block)"]
        p.environment = ["HOME": h.path, "PATH": "/usr/bin:/bin"]
        try p.run(); p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0)
        XCTAssertEqual(try String(contentsOf: chrome), "old manifest")
        XCTAssertEqual(try String(contentsOf: host), "old launcher")
        XCTAssertFalse(FileManager.default.fileExists(atPath: cli.path), "there was none before, so Polycarp's is removed")
    }
}

final class BrowserPathTests: XCTestCase {
    func testTheHelperGetsTheLoginPathThenTheUsualFolders() {
        let p = BrowserBundle.path(base: "/usr/bin:/bin", loginPath: "/Users/x/.nvm/bin:/opt/homebrew/bin:/usr/bin", home: "/Users/x")
        XCTAssertEqual(p, "/Users/x/.nvm/bin:/opt/homebrew/bin:/usr/bin:/Users/x/.local/bin:/usr/local/bin:/bin")
    }
    func testWithoutALoginPathTheUsualFoldersStillComeFirst() {
        XCTAssertEqual(BrowserBundle.path(base: "/usr/bin:/bin", loginPath: nil, home: "/h"), "/h/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        XCTAssertEqual(BrowserBundle.environment(base: ["PATH": "bin:/usr/bin"], home: "/h")["PATH"], "/h/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin", "a relative entry is dropped")
    }
}
