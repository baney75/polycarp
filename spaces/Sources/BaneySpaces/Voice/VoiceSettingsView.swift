import AppKit
import BaneySpacesCore
import SwiftUI

/// Settings > Silas: the dictation key, the speech model (choose, download, remove), the dictionary and History. The
/// same controls as Silas's settings, home and dictionary pages, in Polycarp's Chrome. Every change goes to the voice
/// core, which owns the files.
struct VoiceSettingsView: View {
    @ObservedObject private var voice = VoiceEngine.shared
    @State private var capturing = false
    /// Why the last key pick didn't take (refused or timed out); cleared by the next pick.
    @State private var captureNote: String?
    @State private var newTerm = ""
    @State private var from = ""
    @State private var to = ""
    @State private var showHistory = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            statusSection
            if let p = voice.state?.permissions { permissionsSection(p) }
            if voice.offersSilasTrash { silasSection }
            if let s = voice.settings { keySection(s); modelSection(s); dictionarySection; historySection }
            else { SettingsGroup { SettingsNote("The voice engine isn't running.") } }
            if let e = voice.lastError { SettingsGroup { SettingsNote(e, tone: .urgent) } }
            if let p = voice.lastProblem, p.message != voice.lastError {
                // Kept after the overlay clears it, so a failure seen out of the corner of an eye can be read here.
                TimelineView(.periodic(from: .now, by: 30)) { t in SettingsGroup { SettingsNote(p.line(now: t.date)) } }
            }
        }
        .onAppear { voice.reload() }
        // Grants change in System Settings with no event; the reads never prompt.
        .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in voice.refreshPermissions() }
        .onDisappear { if capturing { voice.cancelHotkeyCapture() } }
    }

    /// One line each for the two permissions dictation needs, with the one button that moves it forward. The full
    /// permissions tab will hold these too; this is the part Silas's own messages point at.
    private func permissionsSection(_ p: VoicePermissions) -> some View {
        SettingsGroup("Permissions") {
            ForEach([VoicePermissionLine.microphone(p.microphone), .accessibility(p.accessibility)], id: \.title) { line in
                SettingsRow(line.title, help: line.help) {
                    HStack {
                        SettingsStatusLabel(text: line.state, done: line.allowed)
                        if let b = line.button { Button(b) { voice.allow(line.kind) } }
                    }
                }
            }
        }
    }

    private var statusSection: some View {
        SettingsGroup {
            SettingsBlock {
                HStack(spacing: 12) {
                    SilasMarkView(live: voice.state?.status.isLive == true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(voice.statusLine).font(Chrome.font(13, .semibold)).fixedSize(horizontal: false, vertical: true)
                        // What Silas is, in one line, for someone meeting it here.
                        Text(SilasName.description).font(Chrome.font(11)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Toggle("On", isOn: Binding(get: { voice.userEnabled }, set: { voice.setUserEnabled($0) })).toggleStyle(.switch).labelsHidden()
                }
            }
        }
    }

    /// Only when Silas is on and the Silas app is installed. Nothing here happens by itself.
    private var silasSection: some View {
        SettingsGroup {
            SettingsRow(SilasRetirement.stillInstalled, help: "Its dictionary, history and models are already copied here, and its own data stays where it is.") {
                Button(SilasRetirement.button) { voice.trashSilas() }
            }
            if let m = voice.silasMessage { SettingsNote(m, tone: .urgent) }
        }
    }

    private func keySection(_ s: VoiceSettings) -> some View {
        SettingsGroup("Dictation key") {
            SettingsRow("Key", help: VoiceKeyHelp.text(listener: voice.state?.listener == true, userEnabled: voice.userEnabled && voice.state?.enabled != false,
                                                       waiting: voice.waiting, accessibility: voice.state?.permissions?.accessibility,
                                                       hotkey: s.hotkey, hasFallback: s.hotkeyFallback != nil)) {
                HStack {
                    Picker("Key", selection: Binding(get: { s.hotkey }, set: { k in voice.update { $0.hotkey = k } })) {
                        ForEach(VoiceHotkeys.presets + (VoiceHotkeys.presets.contains(s.hotkey) ? [] : [s.hotkey]), id: \.self) { Text(label($0)).tag($0) }
                    }.labelsHidden().frame(width: 130)
                    Button(capturing ? "Press a key…" : "Pick another key") {
                        capturing = true
                        captureNote = nil
                        voice.captureHotkey { outcome in capturing = false; captureNote = outcome.note }
                    }.disabled(capturing || voice.state?.listener != true)
                    // Escape also cancels.
                    if capturing { Button("Cancel") { voice.cancelHotkeyCapture() } }
                }
            }
            if let n = captureNote { SettingsNote(n, tone: .urgent) }
            toggle("Tap once to start and again to stop", help: "Otherwise hold the key.", s.tapToToggle) { v in voice.update { $0.tapToToggle = v } }
            toggle("Show a listening indicator", s.showOverlay) { v in voice.update { $0.showOverlay = v } }
            toggle("Remove filler words", s.removeFillers) { v in voice.update { $0.removeFillers = v } }
            toggle("Learn from my edits", s.learnFromEdits) { v in voice.update { $0.learnFromEdits = v } }
            toggle("Sounds", s.sounds) { v in voice.update { $0.sounds = v } }
            SettingsNote("Text is typed as keystrokes. Polycarp never pastes and never touches your clipboard.")
        }
    }

    private func toggle(_ title: String, help: String? = nil, _ value: Bool, _ set: @escaping (Bool) -> Void) -> some View {
        SettingsRow(title, help: help) {
            Toggle(title, isOn: Binding(get: { value }, set: set)).toggleStyle(.switch).labelsHidden()
        }
    }

    private func label(_ key: String) -> String {
        switch key {
        case "Dictation": "Microphone key"
        case "CmdRight": "Right ⌘"
        case "OptRight": "Right ⌥"
        case "CtrlRight": "Right Ctrl"
        case "Fn": "fn"
        default: voice.state.flatMap { $0.hotkey == key ? $0.hotkeyLabel : nil } ?? key
        }
    }

    private func modelSection(_ s: VoiceSettings) -> some View {
        SettingsGroup("Speech model") {
            SettingsNote("Runs on this Mac. It stays loaded so dictation starts at once.")
            ForEach(voice.models) { m in
                SettingsRow(m.name + (m.recommended ? "  Recommended" : ""), help: "\(m.tagline) \(m.sizeMb) MB.") {
                    HStack {
                        if let p = voice.downloads[m.id] {
                            ProgressView(value: p).frame(width: 90)
                            Button("Cancel") { voice.cancelDownload(model: m.id) }
                        } else if m.active {
                            SettingsStatusLabel(text: "In use")
                        } else if m.installed {
                            Button("Use") { voice.select(model: m.id) }
                            Button("Remove") { voice.delete(model: m.id) }
                        } else {
                            Button("Download") { voice.download(model: m.id) }
                        }
                    }
                }
            }
        }
    }

    private var dictionarySection: some View {
        SettingsGroup("Dictionary") {
            SettingsBlock {
                HStack {
                    TextField("Add a word or name", text: $newTerm).onSubmit(addTerm)
                    Button("Add", action: addTerm).disabled(newTerm.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            SettingsBlock {
                HStack {
                    TextField("When I say", text: $from)
                    Image(systemName: "arrow.right").foregroundStyle(Chrome.muted).accessibilityHidden(true)
                    TextField("Write", text: $to)
                    Button("Add") { voice.addCorrection(from: from, to: to); from = ""; to = "" }
                        .disabled(from.trimmingCharacters(in: .whitespaces).isEmpty || to.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            if let d = voice.dictionary {
                ForEach(d.terms, id: \.text) { t in
                    row(t.text) { voice.removeTerm(t.text) }
                }
                ForEach(d.corrections, id: \.from) { c in
                    row("\(c.from) → \(c.to)") { voice.removeCorrection(c.from) }
                }
            }
        }
    }

    private func addTerm() {
        let t = newTerm.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        voice.addTerm(t); newTerm = ""
    }

    private var historySection: some View {
        SettingsGroup("History") {
            SettingsRow(voice.history.isEmpty ? "Nothing yet" : "\(voice.history.count) saved") {
                HStack {
                    if !voice.history.isEmpty {
                        Button(showHistory ? "Hide" : "Show") { showHistory.toggle() }
                        Button("Clear") { voice.clearHistory() }
                    }
                }
            }
            if showHistory {
                ForEach(voice.history.prefix(30)) { h in
                    row(h.shown) { voice.deleteHistory(h.id) }
                }
            }
        }
    }

    private func row(_ text: String, remove: @escaping () -> Void) -> some View {
        SettingsBlock {
            HStack {
                Text(text).font(Chrome.font(12)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button(action: remove) { Image(systemName: "xmark.circle") }.buttonStyle(.plain).foregroundStyle(Chrome.muted)
                    .accessibilityLabel("Remove")
            }
        }
    }
}
