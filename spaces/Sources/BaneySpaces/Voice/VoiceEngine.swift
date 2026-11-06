import AppKit
import BaneySpacesCore
import CPolycarpCore
import UserNotifications

/// Dictation, inside this process: a thin Swift face on the Rust voice core (core/ffi, linked as a static library).
/// The behavior is the core's, ported from Silas, not rewritten here: hold the key, speak, the text is typed as
/// keystrokes (never pasted), and the model is never unloaded by anything but quitting.
///
/// Threading: the core calls back from any thread; everything is hopped to the main queue before it touches state.
/// Calls that can block (model download, hotkey capture) run on a background queue.
final class VoiceEngine: ObservableObject {
    static let shared = VoiceEngine()

    @Published private(set) var state: VoiceState?
    @Published private(set) var settings: VoiceSettings?
    @Published private(set) var models: [VoiceModel] = []
    @Published private(set) var dictionary: VoiceDictionary?
    @Published private(set) var history: [VoiceHistoryItem] = []
    /// 0...1 download progress by model id.
    @Published private(set) var downloads: [String: Double] = [:]
    @Published private(set) var lastError: String?
    /// Why the key isn't being listened to, if it isn't (`VoiceGate`). Silas running clears itself when Silas quits;
    /// the person's own Off stays until the person turns dictation on, across restarts.
    @Published private(set) var waiting: VoiceGate.Reason?
    /// The words for `waiting`, or nil for the person's own Off (the switch says it).
    var refusal: String? { waiting.flatMap(VoiceGate.message) }
    var userEnabled: Bool { VoiceGate.userEnabled(.standard) }

    /// Whether Polycarp's dictation is taking over right now (`VoiceGate.takesOverNow`: voice on, a finished model of its
    /// own, the import really finished). Silas is asked to quit only when this is true.
    var takesOver: Bool {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return VoiceGate.takesOverNow(userEnabled: userEnabled, voiceDir: dir, silasDir: Product.silasSupportDir(home: home))
    }

    /// The one line for the menu and Settings: why it's waiting, the error's reason and next step, or the status.
    var statusLine: String {
        if let w = waiting { return VoiceGate.message(w) ?? "Dictation is off" }
        guard let st = state else { return "Starting…" }
        if !st.enabled { return "Dictation is off" }
        return st.status.menuLine(hotkeyLabel: st.hotkeyLabel, detail: st.detail)
    }

    /// Level while recording, for the overlay. Not published: it changes many times a second.
    var onLevel: ((Float) -> Void)?
    /// A word was learned from an edit: (from, to).
    var onLearned: ((String, String) -> Void)?
    var onStateChange: (() -> Void)?
    /// Dictation would take over now but Silas is still running: the watcher asks it to quit.
    var onSilasInTheWay: (() -> Void)?
    /// Silas is installed (/Applications or ~/Applications) and Settings may offer to move it; set by `reload`.
    @Published private(set) var silasApp: URL?
    @Published private(set) var silasMessage: String?

    private var core: OpaquePointer?
    private var started = false

    private let dir = Product.voiceDir(home: FileManager.default.homeDirectoryForCurrentUser)

    /// `--render` only: sample settings, so Settings > Silas draws its real rows with no engine running.
    func useRenderSample() {
        let decoder = JSONDecoder()
        state = try? decoder.decode(VoiceState.self, from: Data(#"{"status":"ready","detail":null,"model":"parakeet-v3","hotkey":"CmdRight","hotkeyLabel":"Right ⌘","enabled":true,"listener":true}"#.utf8))
        settings = try? decoder.decode(VoiceSettings.self, from: Data(#"{"hotkey":"CmdRight","tapToToggle":true,"model":"parakeet-v3","modelSource":"default","language":"en","removeFillers":true,"trailingSpace":true,"typingSpeed":"fast","newlineAsShiftEnter":true,"learnFromEdits":true,"sounds":true,"showOverlay":true,"launchAtLogin":true,"microphone":null,"onboarded":true,"updateChannel":"stable","autoUpdate":true}"#.utf8))
        models = (try? decoder.decode([VoiceModel].self, from: Data(#"[{"id":"parakeet-v3","name":"Parakeet v3","tagline":"Fast and accurate on this Mac.","tier":"fast","languages":"English and 24 more","sizeMb":478,"recommended":true,"installed":true,"active":true},{"id":"cohere-int4","name":"Cohere Transcribe","tagline":"Best on long, careful speech.","tier":"best","languages":"English and 13 more","sizeMb":1420,"recommended":false,"installed":false,"active":false}]"#.utf8))) ?? []
    }

    // MARK: Lifecycle

    /// Opens the core and decides whether to listen for the dictation key (`VoiceGate`): only with voice on, a speech
    /// model installed, Silas's import finished, and Silas not running. Safe to call again; it is how every change
    /// (Silas starting or quitting, a model arriving, the switch) is applied, so a pause for one reason never outlives it.
    func start(terminating: Int32? = nil) {
        if core == nil {
            let user = Unmanaged.passUnretained(self).toOpaque()
            core = dir.path.withCString { pc_open($0, 0, { user, event, json in
                guard let user, let event, let json else { return }
                let me = Unmanaged<VoiceEngine>.fromOpaque(user).takeUnretainedValue()
                let e = String(cString: event), j = String(cString: json)
                DispatchQueue.main.async { me.handle(event: e, json: j) }
            }, { user, level in
                guard let user else { return }
                let me = Unmanaged<VoiceEngine>.fromOpaque(user).takeUnretainedValue()
                me.onLevel?(level)
            }, user) }
            guard core != nil else { return fail("The voice engine didn't open.") }
        }
        guard let core else { return }
        models = decode(pc_models_list(core)) ?? models
        let silas = LegacyHandover.livePids(NSRunningApplication.runningApplications(withBundleIdentifier: Product.Silas.bundleID)
            .map { ($0.processIdentifier, $0.isTerminated) }, excluding: terminating)
        let home = FileManager.default.homeDirectoryForCurrentUser
        let decision = VoiceGate.decide(userEnabled: userEnabled, modelInstalled: VoiceGate.hasModel(in: [dir]),
                                        importFinished: VoiceImport.isFinished(silasDir: Product.silasSupportDir(home: home), newDir: dir),
                                        silasPids: silas)
        switch decision {
        case .wait(let why):
            // No key is listened to (no listener has started, or it is paused); the model stays loaded if it was.
            waiting = why
            _ = pc_stop(core)
            if why == .silasRunning { onSilasInTheWay?() }
        case .start:
            waiting = nil
            if pc_start(core) != PC_OK { fail(lastCoreError()) }
        }
        reload()
    }

    /// Silas started or quit: decide again.
    func silasChanged(terminating: Int32? = nil) { start(terminating: terminating) }

    /// The person's switch: remembered across restarts.
    func setUserEnabled(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: VoiceGate.enabledKey)
        start()
    }

    func toggleRecording() { if let core { _ = pc_toggle_recording(core) } }

    // MARK: Reading

    func reload() {
        guard let core else { return }
        state = decode(pc_status(core))
        settings = decode(pc_settings_get(core))
        models = decode(pc_models_list(core)) ?? models
        dictionary = decode(pc_dictionary_get(core))
        history = decode(pc_history_get(core, 200)) ?? []
        refreshSilas()
        onStateChange?()
    }

    private func handle(event: String, json: String) {
        switch event {
        case "status":
            if let data = json.data(using: .utf8), let s = try? JSONDecoder().decode(StatusEvent.self, from: data), var st = state {
                st.status = s.status; st.detail = s.detail
                state = st
                onStateChange?()
            }
            if let core { state = decode(pc_status(core)) ?? state }
        case "transcript":
            if let core { history = decode(pc_history_get(core, 200)) ?? history }
            if let data = json.data(using: .utf8), let t = try? JSONDecoder().decode(Typed.self, from: data), t.typed { notifyIfDue() }
        case "benchmark-done", "benchmark-error":
            // A benchmark may have switched the model: the tab must not keep showing the old one "In use".
            reload()
        case "learned":
            if let data = json.data(using: .utf8), let r = try? JSONDecoder().decode(Learned.self, from: data), let c = r.learned.first {
                onLearned?(c.from, c.to)
            }
            if let core { dictionary = decode(pc_dictionary_get(core)) }
        case "model-progress":
            if let data = json.data(using: .utf8), let p = try? JSONDecoder().decode(Progress.self, from: data) {
                if p.stage == "error" { downloads[p.id] = nil; fail(p.message ?? "The download failed.") }
                else if p.total > 0 { downloads[p.id] = Double(p.downloaded) / Double(p.total) }
            }
        case "show-main":
            NSApp.activate(ignoringOtherApps: true)
            (NSApp.delegate as? AppDelegate)?.showVoiceSettings()
        default: break
        }
    }

    private struct Typed: Decodable { var typed: Bool }
    private struct StatusEvent: Decodable { var status: VoiceStatus; var detail: String? }
    private struct Learned: Decodable { struct C: Decodable { var from: String; var to: String }; var learned: [C] }
    private struct Progress: Decodable { var id: String; var downloaded: Int64; var total: Int64; var stage: String; var message: String? }

    // MARK: Writing

    func update(_ change: (inout VoiceSettings) -> Void) {
        guard let core, var s = settings else { return }
        change(&s)
        guard let json = try? JSONEncoder().encode(s), let text = String(data: json, encoding: .utf8) else { return }
        if let out = text.withCString({ pc_settings_set(core, $0) }) {
            settings = decode(out)
            state = decode(pc_status(core)) ?? state
            lastError = nil
        } else { fail(lastCoreError()) }
        onStateChange?()
    }

    func select(model id: String) {
        guard let core else { return }
        if id.withCString({ pc_model_select(core, $0, 0) }) != PC_OK { fail(lastCoreError()) }
        reload()
    }

    func download(model id: String) {
        guard let core else { return }
        downloads[id] = 0
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let r = id.withCString { pc_model_download(core, $0) }
            // The core keeps its message per thread: read it here, on the thread that made the call.
            let message = r != PC_OK ? String(cString: pc_last_error()) : nil
            DispatchQueue.main.async {
                guard let self else { return }
                self.downloads[id] = nil
                if let message { self.fail(message) }
                self.reload()
                self.start()   // a first model may be the last thing dictation was waiting for
            }
        }
    }

    func delete(model id: String) {
        guard let core else { return }
        if id.withCString({ pc_model_delete(core, $0) }) != PC_OK { fail(lastCoreError()) }
        reload()
    }

    /// Waits up to ten seconds for the key the person presses; the result becomes the hotkey.
    func captureHotkey(done: @escaping (Bool) -> Void) {
        guard let core else { return done(false) }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let p = pc_hotkey_capture(core, 10_000)
            let key = p.map { String(cString: $0) }
            pc_string_free(p)
            DispatchQueue.main.async {
                if let key { self?.update { $0.hotkey = key } }
                done(key != nil)
            }
        }
    }

    func addTerm(_ t: String) {
        guard let core else { return }
        dictionary = t.withCString { decode(pc_dictionary_add_term(core, $0)) } ?? dictionary
    }
    func removeTerm(_ t: String) {
        guard let core else { return }
        dictionary = t.withCString { decode(pc_dictionary_remove_term(core, $0)) } ?? dictionary
    }
    func addCorrection(from: String, to: String) {
        guard let core else { return }
        dictionary = from.withCString { f in to.withCString { t in decode(pc_dictionary_add_correction(core, f, t)) } } ?? dictionary
    }
    func removeCorrection(_ from: String) {
        guard let core else { return }
        dictionary = from.withCString { decode(pc_dictionary_remove_correction(core, $0)) } ?? dictionary
    }

    func deleteHistory(_ id: String) {
        guard let core else { return }
        _ = id.withCString { pc_history_delete(core, $0) }
        history = decode(pc_history_get(core, 200)) ?? history
    }

    func clearHistory() {
        guard let core else { return }
        _ = pc_history_clear(core)
        history = []
    }

    // MARK: Helpers

    private func decode<T: Decodable>(_ p: UnsafeMutablePointer<CChar>?) -> T? {
        guard let p else { return nil }
        defer { pc_string_free(p) }
        return try? JSONDecoder().decode(T.self, from: Data(String(cString: p).utf8))
    }

    private func lastCoreError() -> String { String(cString: pc_last_error()) }
    /// An empty message never replaces a real one (the download's own event already set the real text).
    private func fail(_ message: String) {
        guard !message.isEmpty else { return }
        lastError = message
        Trace.log("voice: \(message)")
    }

    // MARK: Silas can go when the person is ready

    /// One notification after the first dictation that typed. Nothing is moved; the button in Settings > Silas does that.
    private func notifyIfDue() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        guard SilasRetirement.shouldNotify(voiceOn: userEnabled && state?.enabled != false, typedText: true,
                                           alreadyNotified: SilasRetirement.alreadyNotified(voiceDir: dir),
                                           silas: SilasRetirement.locate(home: home)) else { return }
        SilasRetirement.markNotified(voiceDir: dir)
        refreshSilas()
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = SilasRetirement.notice
            center.add(UNNotificationRequest(identifier: "silas-can-go", content: content, trigger: nil))
        }
    }

    /// What Settings > Silas shows: Silas, if it is installed where this can move it.
    func refreshSilas() {
        silasApp = SilasRetirement.locate(home: FileManager.default.homeDirectoryForCurrentUser)
    }

    /// Whether the tab offers "Move Silas to the Trash".
    var offersSilasTrash: Bool {
        let running = !LegacyHandover.livePids(NSRunningApplication.runningApplications(withBundleIdentifier: Product.Silas.bundleID)
            .map { ($0.processIdentifier, $0.isTerminated) }).isEmpty
        return SilasRetirement.offers(voiceOn: userEnabled, silas: silasApp, silasRunning: running)
    }

    /// The button. The app first, its login item only after that worked; a failure is shown in the tab.
    func trashSilas() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        guard let silas = SilasRetirement.locate(home: home) else { refreshSilas(); return }
        let report = SilasRetirement.moveToTrash(silas: silas, home: home, voiceDir: dir) { url in
            var landed: NSURL?
            try FileManager.default.trashItem(at: url, resultingItemURL: &landed)
            return landed as URL?
        }
        Trace.log("voice: moved Silas to the Trash: \(report)")
        silasMessage = report.failure
        refreshSilas()
    }
}
