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
        XCTAssertEqual(VoiceStatus.ready.menuLine(hotkeyLabel: "Right ⌘", tapToToggle: true), "Ready · tap Right ⌘ to speak")
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
        XCTAssertEqual(LegacyHandover.alertTitle(running: ["the Silas app"]), "The Silas app is running. Polycarp replaces it.")
        XCTAssertEqual(LegacyHandover.alertTitle(running: ["BaneySpaces", "the Silas app"]), "BaneySpaces and the Silas app are running. Polycarp replaces them.")
        XCTAssertEqual(LegacyHandover.alertTitle(running: ["BaneySpaces"]), LegacyHandover.alertTitle, "unchanged for the old case")
        XCTAssertEqual(LegacyHandover.continueButton(running: ["the Silas app"]), "Quit the Silas app and Continue")
        XCTAssertTrue(LegacyHandover.alertDetail(running: ["the Silas app"]).contains("copied, never moved"))
        XCTAssertTrue(LegacyHandover.applies(oneShot: false, legacyPids: [7]))
    }

    func testSilasStartingLaterIsAskedToQuitToo() {
        XCTAssertEqual(LegacyHandover.onLaunch(bundleID: "com.baney.silas", alreadyNotified: false), .init(quit: true, notify: true))
        XCTAssertEqual(LegacyHandover.onLaunch(bundleID: "com.baney.silas", alreadyNotified: true), .init(quit: true, notify: false))
    }

    func testPolycarpRefusesTheHotkeyWhileSilasRuns() {
        XCTAssertEqual(LegacyHandover.voiceStart(silasPids: []), .start)
        guard case .refuse(let why) = LegacyHandover.voiceStart(silasPids: [42]) else { return XCTFail("must refuse") }
        XCTAssertTrue(why.contains("The Silas app is running"))
    }

    func testTheInstallerNeverTouchesSilas() throws {
        let sh = try Repo.text("scripts/install-app.sh")
        XCTAssertFalse(sh.contains("SILAS"), "no Silas step at all: Polycarp's gate handles it at launch")
        XCTAssertFalse(sh.contains("Silas"))
        XCTAssertFalse(sh.contains("voiceEnabled"))
        XCTAssertTrue(try Repo.text("scripts/product.env").contains("SILAS_BUNDLE_ID=com.baney.silas"), "the names stay for the app's own use")
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
        XCTAssertTrue(G.message(.needsModel)!.contains("Settings > Silas"))
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
        XCTAssertEqual(LegacyHandover.namesToReplace(running: ["com.baney.silas"], takesOver: true), ["the Silas app"])
        let detail = LegacyHandover.alertDetail(running: ["the Silas app"])
        XCTAssertTrue(detail.contains("Silas in Polycarp takes over from here"), detail)
        XCTAssertTrue(detail.contains("stays installed"), detail)
        XCTAssertTrue(detail.contains("Settings > Silas offers to move it to the Trash"), detail)
    }

    // MARK: Silas can go when the person is ready

    private func plantSilas(_ home: URL, in folder: String = "Applications") -> URL {
        let app = home.appendingPathComponent("\(folder)/Silas.app")
        write("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>com.baney.silas</string></dict></plist>", app.appendingPathComponent("Contents/Info.plist"))
        write("bin", app.appendingPathComponent("Contents/MacOS/silas"))
        return app
    }

    func testOnlyANotificationAfterTheFirstTypedDictationNothingMoves() {
        let a = URL(fileURLWithPath: "/Applications/Silas.app")
        XCTAssertEqual(SilasRetirement.notice, "Dictation is working. The Silas app can go when you're ready.")
        XCTAssertTrue(SilasRetirement.shouldNotify(voiceOn: true, typedText: true, alreadyNotified: false, silas: a))
        XCTAssertFalse(SilasRetirement.shouldNotify(voiceOn: true, typedText: false, alreadyNotified: false, silas: a), "only a real typed result")
        XCTAssertFalse(SilasRetirement.shouldNotify(voiceOn: true, typedText: true, alreadyNotified: true, silas: a), "once")
        XCTAssertFalse(SilasRetirement.shouldNotify(voiceOn: false, typedText: true, alreadyNotified: false, silas: a))
        XCTAssertFalse(SilasRetirement.shouldNotify(voiceOn: true, typedText: true, alreadyNotified: false, silas: nil))
        let voice = temp()
        XCTAssertFalse(SilasRetirement.alreadyNotified(voiceDir: voice))
        SilasRetirement.markNotified(voiceDir: voice)
        XCTAssertTrue(SilasRetirement.alreadyNotified(voiceDir: voice))
    }

    func testTheButtonShowsOnlyWithVoiceOnAndSilasThereAndNotRunning() {
        let a = URL(fileURLWithPath: "/Applications/Silas.app")
        XCTAssertTrue(SilasRetirement.offers(voiceOn: true, silas: a, silasRunning: false))
        XCTAssertFalse(SilasRetirement.offers(voiceOn: false, silas: a, silasRunning: false), "voice off: Silas is the way back")
        XCTAssertFalse(SilasRetirement.offers(voiceOn: true, silas: nil, silasRunning: false))
        XCTAssertFalse(SilasRetirement.offers(voiceOn: true, silas: a, silasRunning: true))
        XCTAssertEqual(SilasRetirement.stillInstalled, "The Silas app is still installed.")
        XCTAssertEqual(SilasRetirement.button, "Move the Silas app to the Trash")
    }

    func testSilasIsFoundOnlyInTheTwoApplicationsFolders() {
        let home = temp(), system = temp()
        XCTAssertNil(SilasRetirement.locate(home: home, systemApplications: system))
        _ = plantSilas(home, in: "Downloads")
        XCTAssertNil(SilasRetirement.locate(home: home, systemApplications: system), "a Silas in Downloads isn't touched")
        let mine = plantSilas(home)
        XCTAssertEqual(SilasRetirement.locate(home: home, systemApplications: system)?.path, mine.path)
    }

    func testTheClickMovesTheAppThenRemovesOnlyItsLoginItem() throws {
        let home = temp(), voice = temp().appendingPathComponent("voice"), trash = temp()
        let app = plantSilas(home)
        let mine = SilasRetirement.loginItem(home: home)
        write("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>Silas</string><key>ProgramArguments</key><array><string>\(app.path)/Contents/MacOS/silas</string><string>--background</string></array></dict></plist>", mine)
        let other = home.appendingPathComponent("Library/LaunchAgents/com.example.other.plist")
        write("<plist version=\"1.0\"><dict/></plist>", other)
        let silasData = home.appendingPathComponent("Library/Application Support/Silas/history.json")
        write("[]", silasData)
        var sawLoginItemWhileMoving = false
        let report = SilasRetirement.moveToTrash(silas: app, home: home, voiceDir: voice) { url in
            sawLoginItemWhileMoving = FileManager.default.fileExists(atPath: mine.path)
            let to = trash.appendingPathComponent(url.lastPathComponent)
            try FileManager.default.moveItem(at: url, to: to)
            return to
        }
        XCTAssertTrue(sawLoginItemWhileMoving, "the login item is still there when the app moves: it goes after")
        XCTAssertNil(report.failure)
        XCTAssertEqual(report.trashed?.path, trash.appendingPathComponent("Silas.app").path)
        XCTAssertTrue(report.loginItemRemoved)
        XCTAssertFalse(FileManager.default.fileExists(atPath: app.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: mine.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: other.path), "any other login item stays")
        XCTAssertTrue(FileManager.default.fileExists(atPath: silasData.path), "its data stays")
        XCTAssertTrue(FileManager.default.fileExists(atPath: voice.appendingPathComponent("silas-retired-record/Silas.plist").path), "a copy of what was removed")
    }

    func testAFailedMoveLeavesSilasAndItsLoginItemAlone_andSaysSo() {
        let home = temp(), voice = temp()
        let app = plantSilas(home)
        let item = SilasRetirement.loginItem(home: home)
        write("<plist version=\"1.0\"><dict><key>ProgramArguments</key><array><string>\(app.path)/Contents/MacOS/silas</string></array></dict></plist>", item)
        struct Boom: Error, LocalizedError { var errorDescription: String? { "no permission" } }
        let r = SilasRetirement.moveToTrash(silas: app, home: home, voiceDir: voice) { _ in throw Boom() }
        XCTAssertNil(r.trashed)
        XCTAssertFalse(r.loginItemRemoved)
        XCTAssertTrue(FileManager.default.fileExists(atPath: item.path), "the login item stays: Silas is still there to use it")
        XCTAssertTrue(r.failure?.contains("no permission") == true, r.failure ?? "")
    }

    func testALoginItemThatIsNotSilasIsNotRemoved() {
        let home = temp(), voice = temp()
        let app = plantSilas(home)
        let item = SilasRetirement.loginItem(home: home)
        write("<plist version=\"1.0\"><dict><key>ProgramArguments</key><array><string>/Applications/Something.app/Contents/MacOS/x</string></array></dict></plist>", item)
        let r = SilasRetirement.moveToTrash(silas: app, home: home, voiceDir: voice) { $0 }
        XCTAssertFalse(r.loginItemRemoved)
        XCTAssertTrue(FileManager.default.fileExists(atPath: item.path))
    }

    // MARK: One gate

    func testAPendingImportMeansSilasIsLeftAlone() {
        let silas = temp(), voice = temp()
        // Silas has a finished model and dictionary; one copy failed, so the import is pending.
        write("w", silas.appendingPathComponent("models/parakeet-v3/m.onnx")); write("ok", silas.appendingPathComponent("models/parakeet-v3/.complete"))
        write("{}", silas.appendingPathComponent("dictionary.json"))
        write("ok", voice.appendingPathComponent("models/parakeet-v3/.complete"))   // a model of Polycarp's own
        write("dictionary.json\n", voice.appendingPathComponent(VoiceImport.pendingName))
        XCTAssertFalse(VoiceGate.takesOverNow(userEnabled: true, voiceDir: voice, silasDir: silas), "pending import: not taking over")
        // The engine's decision with Silas running agrees: it waits for the import, it does not call Silas "in the way".
        XCTAssertEqual(VoiceGate.decide(userEnabled: true, modelInstalled: true, importFinished: false, silasPids: [7]), .wait(.importPending))
        // So the watcher and the launch alert, which ask the same gate, leave Silas alone.
        XCTAssertEqual(LegacyHandover.onLaunch(bundleID: "com.baney.silas", alreadyNotified: false, takesOver: VoiceGate.takesOverNow(userEnabled: true, voiceDir: voice, silasDir: silas)), .init(quit: false, notify: false))
        XCTAssertEqual(LegacyHandover.namesToReplace(running: ["com.baney.silas"], takesOver: false), [])
        // Once the import has finished, the same gate says go.
        try? FileManager.default.removeItem(at: voice.appendingPathComponent(VoiceImport.pendingName))
        write("x", voice.appendingPathComponent(VoiceImport.markerName))
        XCTAssertTrue(VoiceGate.takesOverNow(userEnabled: true, voiceDir: voice, silasDir: silas))
        XCTAssertFalse(VoiceGate.takesOverNow(userEnabled: false, voiceDir: voice, silasDir: silas))
    }

    func testAQuittingSilasIsNotStillInTheWay() {
        XCTAssertEqual(LegacyHandover.livePids([(10, false), (11, true)]), [10], "a terminated app is gone")
        XCTAssertEqual(LegacyHandover.livePids([(10, false)], excluding: 10), [], "the one whose quit notice just arrived is gone")
        XCTAssertEqual(LegacyHandover.livePids([(10, false), (12, false)], excluding: 10), [12])
    }

    func testTheUpdaterWaitsWhileDictating() {
        for s in [VoiceStatus.recording, .transcribing, .typing] { XCTAssertTrue(s.isDictating, "\(s)") }
        for s in [VoiceStatus.ready, .loading, .needsModel, .error] { XCTAssertFalse(s.isDictating, "\(s)") }
    }

    func testAnErrorShowsItsReasonInTheMenu() {
        XCTAssertEqual(VoiceStatus.error.menuLine(hotkeyLabel: "x", detail: "Polycarp can't hear your key yet."), "Polycarp can't hear your key yet.")
        XCTAssertEqual(VoiceStatus.error.menuLine(hotkeyLabel: "x"), "Needs attention")
        XCTAssertEqual(VoiceStatus.ready.menuLine(hotkeyLabel: "Right ⌘", detail: "ignored"), "Ready · hold Right ⌘ to speak")
    }

    func testTheNoticeNamesTheAppThatWasClosed() {
        XCTAssertEqual(LegacyHandover.notificationTitle(forBundleID: "com.baney.silas"), "The Silas app was closed")
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
        let chrome = h.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.polycarp.browser.json")
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
        let chrome = h.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.polycarp.browser.json")
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

final class BrowserHostNameTests: XCTestCase {
    private func home() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("bh-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: d) }
        return d
    }
    private func write(_ s: String, _ url: URL) {
        try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! Data(s.utf8).write(to: url)
    }
    private func hosts(_ h: URL, _ browser: String) -> URL {
        h.appendingPathComponent("Library/Application Support/\(browser)/NativeMessagingHosts")
    }
    private func uninstallBlock(home h: URL, store: URL) throws -> Int32 {
        let sh = try Repo.text("uninstall.sh")
        let from = try XCTUnwrap(sh.range(of: "# BEGIN restore-browser-previous"))
        let to = try XCTUnwrap(sh.range(of: "# END restore-browser-previous"))
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", "set -eu; STORE='\(store.path)'; \(String(sh[from.upperBound..<to.lowerBound]))"]
        p.environment = ["HOME": h.path, "PATH": "/usr/bin:/bin"]
        try p.run(); p.waitUntilExit()
        return p.terminationStatus
    }

    func testTheHelperRegistersTheNewNameAndTheOldOneIsStillKnown() {
        XCTAssertEqual(BrowserPrevious.hostName, "com.polycarp.browser")
        XCTAssertEqual(BrowserPrevious.hostNames, ["com.polycarp.browser", "ai.tabkyra.bridge"])
        let names = BrowserPrevious.paths(home: URL(fileURLWithPath: "/h")).map(\.lastPathComponent)
        XCTAssertEqual(names.filter { $0 == "com.polycarp.browser.json" }.count, 10)
        XCTAssertEqual(names.filter { $0 == "ai.tabkyra.bridge.json" }.count, 10)
    }

    func testBothNamesAreRecordedAndUninstallPutsTheOldBackAndRemovesTheNew() throws {
        let h = home(), store = home()
        let dir = hosts(h, "Google/Chrome")
        let old = dir.appendingPathComponent("ai.tabkyra.bridge.json"), new = dir.appendingPathComponent("com.polycarp.browser.json")
        write("old manifest", old)
        XCTAssertTrue(BrowserPrevious.record(home: h, store: store))
        let index = try String(contentsOf: store.appendingPathComponent("index.tsv"))
        XCTAssertTrue(index.contains(old.path) && index.contains("\(new.path)\t-"), index)
        write("{\"path\":\"/Applications/Polycarp.app/h\"}", old); write("{\"path\":\"/Applications/Polycarp.app/h\"}", new)
        XCTAssertEqual(try uninstallBlock(home: h, store: store), 0)
        XCTAssertEqual(try String(contentsOf: old), "old manifest")
        XCTAssertFalse(FileManager.default.fileExists(atPath: new.path))
    }

    func testAListFromBeforeTheRenameStillLosesPolycarpsNewManifestButNotAStandaloneOne() throws {
        let h = home(), store = home()
        let chrome = hosts(h, "Google/Chrome").appendingPathComponent("com.polycarp.browser.json")
        let brave = hosts(h, "BraveSoftware/Brave-Browser").appendingPathComponent("com.polycarp.browser.json")
        // An index from before the rename lists only the old name.
        write("\(hosts(h, "Google/Chrome").appendingPathComponent("ai.tabkyra.bridge.json").path)\t-\n", store.appendingPathComponent("index.tsv"))
        write("{\"path\":\"/Applications/Polycarp.app/h\"}", chrome)
        write("{\"path\":\"/Users/x/.config/polycarp/browser/polycarp-host\"}", brave)
        XCTAssertEqual(try uninstallBlock(home: h, store: store), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: chrome.path), "Polycarp's own goes")
        XCTAssertTrue(FileManager.default.fileExists(atPath: brave.path), "a standalone helper's stays")
    }

    func testTurningBrowserOffParksBothNames() throws {
        let h = home()
        let dir = hosts(h, "Vivaldi")
        for name in BrowserPrevious.hostNames { write("{\"path\":\"/Applications/Polycarp.app/x\"}", dir.appendingPathComponent("\(name).json")) }
        XCTAssertEqual(BrowserHosts.setEnabled(false, home: h), 2)
        XCTAssertEqual(BrowserHosts.setEnabled(true, home: h), 2)
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

final class InstallerLoginPathTests: XCTestCase {
    private func temp() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("itl-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: d) }
        return d
    }
    /// A test shell, run once untimed before any test times it. 11-12: the first exec of a new unsigned file waits on
    /// Gatekeeper's scan (syspolicyd "GK performScan"), and that scan checks notarization online: with the network slow
    /// or just back from sleep it took over 3 s (cloudkit -1001 at 3.0 s), the shell printed nothing and a timed read
    /// failed 1 run in 4. The scan runs once per file, so after this warm-up the deadlines time only `readLoginPath`.
    /// A real login shell is a signed system binary and never waits like this.
    private func script(_ body: String, at url: URL) {
        try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! Data("#!/bin/sh\n[ \"$1\" = warm ] && exit 0\n\(body)\n".utf8).write(to: url)
        try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        let warm = Process(); warm.executableURL = url; warm.arguments = ["warm"]
        try! warm.run(); warm.waitUntilExit()
        XCTAssertEqual(warm.terminationStatus, 0, "the warm-up exits before the body runs")
    }

    func testTheLoginPathReadsWithinItsDeadlineEvenIfTheProfileLeavesAProcessBehind() {
        let dir = temp()
        let good = dir.appendingPathComponent("good-shell")
        script("printf %s /Users/x/bin:/usr/bin", at: good)
        XCTAssertEqual(BrowserBundle.readLoginPath(shell: good, timeout: 3), "/Users/x/bin:/usr/bin")
        // A profile that starts a background process holding stdout: the shell exits, the pipe stays open.
        let leaky = dir.appendingPathComponent("leaky-shell")
        script("(sleep 6) &\nprintf %s /a:/b", at: leaky)
        let t0 = Date()
        XCTAssertNil(BrowserBundle.readLoginPath(shell: leaky, timeout: 1), "no answer rather than a hang")
        XCTAssertLessThan(Date().timeIntervalSince(t0), 3, "gave up at the deadline")
        let hung = dir.appendingPathComponent("hung-shell")
        script("sleep 6", at: hung)
        let t1 = Date()
        XCTAssertNil(BrowserBundle.readLoginPath(shell: hung, timeout: 1))
        XCTAssertLessThan(Date().timeIntervalSince(t1), 3)
        let failing = dir.appendingPathComponent("failing-shell")
        script("exit 3", at: failing)
        XCTAssertNil(BrowserBundle.readLoginPath(shell: failing, timeout: 3))
    }

    /// 11-12, run 3 of 5 at load 9: the good shell answered nil at its 3 s deadline. The read waited for a thread from the
    /// global pool, which the parallel tests had filled. Every global thread busy here: the answer must still come.
    func testTheLoginPathReadsEvenWhenEveryGlobalThreadIsBusy() {
        let good = temp().appendingPathComponent("good-shell")
        script("printf %s /Users/x/bin:/usr/bin", at: good)
        let release = DispatchSemaphore(value: 0)
        let started = DispatchSemaphore(value: 0)
        for _ in 0..<256 { DispatchQueue.global().async { started.signal(); release.wait() } }
        // At least the pool's width is blocked before the read starts.
        for _ in 0..<32 { _ = started.wait(timeout: .now() + 2) }
        defer { for _ in 0..<256 { release.signal() } }
        let t0 = Date()
        XCTAssertEqual(BrowserBundle.readLoginPath(shell: good, timeout: 3), "/Users/x/bin:/usr/bin")
        XCTAssertLessThan(Date().timeIntervalSince(t0), 3)
    }
}
