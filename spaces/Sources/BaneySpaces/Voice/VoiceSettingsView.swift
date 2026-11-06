import AppKit
import BaneySpacesCore
import SwiftUI

/// Settings > Silas: the dictation key, the speech model (choose, download, remove), the dictionary and History. The
/// same controls as Silas's settings, home and dictionary pages, in Polycarp's Chrome. Every change goes to the voice
/// core, which owns the files.
struct VoiceSettingsView: View {
    @ObservedObject private var voice = VoiceEngine.shared
    @State private var capturing = false
    @State private var newTerm = ""
    @State private var from = ""
    @State private var to = ""
    @State private var showHistory = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            statusLine
            if voice.offersSilasTrash { silasSection }
            if let s = voice.settings { keySection(s); modelSection(s); dictionarySection; historySection }
            else { Text("The voice engine isn't running.").foregroundStyle(.secondary) }
            if let e = voice.lastError { Text(e).font(Chrome.font(12)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        }
        .onAppear { voice.reload() }
    }

    private var statusLine: some View {
        VStack(alignment: .leading, spacing: 6) {
        // What Silas is, in one line, for someone meeting it here.
        Text(SilasName.description).font(Chrome.font(11)).foregroundStyle(.secondary)
        HStack(alignment: .top, spacing: 8) {
            SilasMarkView(live: voice.state?.status.isLive == true)
            Text(voice.statusLine)
                .font(Chrome.font(13, .semibold))
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Toggle("On", isOn: Binding(get: { voice.userEnabled }, set: { voice.setUserEnabled($0) })).toggleStyle(.switch)
        }
        .padding(10)
        .background(Chrome.shape(.settingsCell, continuous: false).fill(Chrome.cell(0.08)))
        }
    }

    /// Only when Silas is on and the Silas app is installed. Nothing here happens by itself.
    private var silasSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(SilasRetirement.stillInstalled).font(Chrome.font(12, .semibold))
                Spacer()
                Button(SilasRetirement.button) { voice.trashSilas() }
            }
            Text("Its dictionary, history and models are already copied here, and its own data stays where it is.")
                .font(Chrome.font(11)).foregroundStyle(.secondary)
            if let m = voice.silasMessage { Text(m).font(Chrome.font(12)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        }
        .padding(10)
        .background(Chrome.shape(.settingsCell, continuous: false).fill(Chrome.cell(0.06)))
    }

    private func keySection(_ s: VoiceSettings) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Dictation key").font(Chrome.font(13, .bold))
            HStack {
                Picker("", selection: Binding(get: { s.hotkey }, set: { k in voice.update { $0.hotkey = k } })) {
                    ForEach(VoiceHotkeys.presets + (VoiceHotkeys.presets.contains(s.hotkey) ? [] : [s.hotkey]), id: \.self) { Text(label($0)).tag($0) }
                }.labelsHidden().frame(width: 160)
                Button(capturing ? "Press a key…" : "Pick another key") {
                    capturing = true
                    voice.captureHotkey { _ in capturing = false }
                }.disabled(capturing || voice.state?.listener != true)
                if voice.state?.listener != true {
                    Text("Turn dictation on first.").font(Chrome.font(11)).foregroundStyle(.secondary)
                }
            }
            Toggle("Tap once to start and again to stop (otherwise hold)", isOn: Binding(get: { s.tapToToggle }, set: { v in voice.update { $0.tapToToggle = v } }))
            Toggle("Show the pill while dictating", isOn: Binding(get: { s.showOverlay }, set: { v in voice.update { $0.showOverlay = v } }))
            Toggle("Remove filler words", isOn: Binding(get: { s.removeFillers }, set: { v in voice.update { $0.removeFillers = v } }))
            Toggle("Learn from my edits", isOn: Binding(get: { s.learnFromEdits }, set: { v in voice.update { $0.learnFromEdits = v } }))
            Toggle("Sounds", isOn: Binding(get: { s.sounds }, set: { v in voice.update { $0.sounds = v } }))
            Text("Text is typed as keystrokes. Polycarp never pastes and never touches your clipboard.")
                .font(Chrome.font(11)).foregroundStyle(.secondary)
        }
    }

    private func label(_ key: String) -> String {
        switch key {
        case "CmdRight": "Right ⌘"
        case "OptRight": "Right ⌥"
        case "CtrlRight": "Right Ctrl"
        case "Fn": "fn"
        default: voice.state.flatMap { $0.hotkey == key ? $0.hotkeyLabel : nil } ?? key
        }
    }

    private func modelSection(_ s: VoiceSettings) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Speech model").font(Chrome.font(13, .bold))
            Text("Runs on this Mac. It stays loaded so dictation starts at once.").font(Chrome.font(11)).foregroundStyle(.secondary)
            ForEach(voice.models) { m in
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m.name + (m.recommended ? "  Recommended" : "")).font(Chrome.font(12, .semibold))
                        Text("\(m.tagline) \(m.sizeMb) MB.").font(Chrome.font(11)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    if let p = voice.downloads[m.id] {
                        ProgressView(value: p).frame(width: 90)
                    } else if m.active {
                        Text("In use").font(Chrome.font(11, .medium)).foregroundStyle(Chrome.accent)
                    } else if m.installed {
                        Button("Use") { voice.select(model: m.id) }
                        Button("Remove") { voice.delete(model: m.id) }
                    } else {
                        Button("Download") { voice.download(model: m.id) }
                    }
                }
                .padding(8)
                .background(Chrome.shape(.settingsCell, continuous: false).fill(Chrome.cell(m.active ? 0.1 : 0.04)))
            }
        }
    }

    private var dictionarySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Dictionary").font(Chrome.font(13, .bold))
            HStack {
                TextField("Add a word or name", text: $newTerm).onSubmit(addTerm)
                Button("Add", action: addTerm).disabled(newTerm.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            HStack {
                TextField("When I say", text: $from)
                Image(systemName: "arrow.right").foregroundStyle(.secondary)
                TextField("Write", text: $to)
                Button("Add") { voice.addCorrection(from: from, to: to); from = ""; to = "" }
                    .disabled(from.trimmingCharacters(in: .whitespaces).isEmpty || to.trimmingCharacters(in: .whitespaces).isEmpty)
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
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("History").font(Chrome.font(13, .bold))
                Spacer()
                Button(showHistory ? "Hide" : "Show \(voice.history.count)") { showHistory.toggle() }
                if !voice.history.isEmpty { Button("Clear") { voice.clearHistory() } }
            }
            if showHistory {
                ForEach(voice.history.prefix(30)) { h in
                    row(h.shown) { voice.deleteHistory(h.id) }
                }
            }
        }
    }

    private func row(_ text: String, remove: @escaping () -> Void) -> some View {
        HStack {
            Text(text).font(Chrome.font(12)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button(action: remove) { Image(systemName: "xmark.circle") }.buttonStyle(.plain).foregroundStyle(.secondary)
                .accessibilityLabel("Remove")
        }
    }
}
