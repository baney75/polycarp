import AppKit
import BaneySpacesCore
import CPolycarpCore

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
    /// Set while Silas has the key; the engine is not started then (`LegacyHandover.voiceStart`).
    @Published private(set) var refusal: String?

    /// Level while recording, for the overlay. Not published: it changes many times a second.
    var onLevel: ((Float) -> Void)?
    /// A word was learned from an edit: (from, to).
    var onLearned: ((String, String) -> Void)?
    var onStateChange: (() -> Void)?

    private var core: OpaquePointer?
    private var started = false

    private let dir = Product.voiceDir(home: FileManager.default.homeDirectoryForCurrentUser)

    // MARK: Lifecycle

    /// Opens the core and, unless Silas is running, starts listening for the hotkey. Safe to call again.
    func start() {
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
        let silas = NSRunningApplication.runningApplications(withBundleIdentifier: Product.Silas.bundleID).map(\.processIdentifier)
        switch LegacyHandover.voiceStart(silasPids: silas) {
        case .refuse(let reason):
            // Never take the key from a running Silas. The state is still read so Settings has something to show.
            refusal = reason
            _ = pc_stop(core)
        case .start:
            refusal = nil
            if pc_start(core) == PC_OK { started = true } else { fail(lastCoreError()) }
        }
        reload()
    }

    /// Pauses dictation (the model stays loaded).
    func stop() {
        guard let core else { return }
        _ = pc_stop(core)
        reload()
    }

    /// Silas quit: take over.
    func silasQuit() { if refusal != nil { start() } }

    func toggleRecording() { if let core { _ = pc_toggle_recording(core) } }

    // MARK: Reading

    func reload() {
        guard let core else { return }
        state = decode(pc_status(core))
        settings = decode(pc_settings_get(core))
        models = decode(pc_models_list(core)) ?? models
        dictionary = decode(pc_dictionary_get(core))
        history = decode(pc_history_get(core, 200)) ?? []
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
            DispatchQueue.main.async {
                guard let self else { return }
                self.downloads[id] = nil
                if r != PC_OK { self.fail(self.lastCoreError()) }
                self.reload()
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
    private func fail(_ message: String) { lastError = message; Trace.log("voice: \(message)") }
}
