import AppKit
import BaneySpacesCore
import SwiftUI
import UniformTypeIdentifiers

/// The theme editor: every field the CLI's schema lists on the left, the draft in light and dark on the right, and Save,
/// which sends the edits to `polycarp theme change`. The editor's own chrome follows the theme in use, like Settings.
struct ThemeEditorView: View {
    static let size = CGSize(width: 1040, height: 700)
    static let controlsWidth: CGFloat = 400

    @ObservedObject var model: ThemeEditorModel
    @ObservedObject private var appearance = Appearance.shared
    @State private var dropping = false
    var close: () -> Void = {}

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Chrome.edge(0.14)).frame(height: 1)
            if model.draft == nil {
                VStack(spacing: 10) {
                    if let p = model.problem {
                        Text(p).font(Chrome.font(12)).foregroundStyle(Chrome.urgent).textSelection(.enabled).multilineTextAlignment(.center)
                    } else {
                        ProgressView().controlSize(.small)
                        Text("Reading the theme…").font(Chrome.font(12)).foregroundStyle(Chrome.muted)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HStack(spacing: 0) {
                    ScrollView { controls.padding(16) }
                        .frame(width: Self.controlsWidth)
                    Rectangle().fill(Chrome.edge(0.14)).frame(width: 1)
                    ScrollView { previews.padding(16) }
                }
            }
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .foregroundStyle(Chrome.wash())
        .tint(Chrome.accent)
        .toggleStyle(.switch)
        .background(Chrome.panel())
        .overlay {
            if dropping {
                Chrome.shape(.settingsCallout).strokeBorder(Chrome.accent, lineWidth: Chrome.width(.settingsTile, focused: true)).padding(4)
                    .allowsHitTesting(false)
            }
        }
        .onDrop(of: [UTType.fileURL], isTargeted: $dropping) { providers in
            ThemeDrop.urls(providers) { urls in
                guard let url = urls.first else { return }
                switch ThemeImport.kind(url.path) {
                case .picture: model.propose(from: url)
                case .theme: ThemeLibrary.shared.importTheme(url)
                case .other: model.notice = "Drop a picture here to take its colors."
                }
            }
            return true
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.title).font(Chrome.font(17, .bold)).accessibilityAddTraits(.isHeader)
                Text(model.draft?.isEdited == true ? "Edited, not saved" : "Saved as \(model.name)")
                    .font(Chrome.font(11)).foregroundStyle(Chrome.muted)
            }
            Spacer()
            Button { model.undo() } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
                .keyboardShortcut("z", modifiers: .command).disabled(model.draft?.canUndo != true)
                .help("Undo the last edit")
            Button { model.redo() } label: { Label("Redo", systemImage: "arrow.uturn.forward") }
                .keyboardShortcut("z", modifiers: [.command, .shift]).disabled(model.draft?.canRedo != true)
                .help("Redo")
            Button("Revert") { model.revert() }.disabled(model.draft?.isEdited != true)
                .help("Back to the theme as last saved. Undo brings your edits back.")
            Button(model.saving ? "Saving…" : "Save") { model.save() }
                .keyboardShortcut("s", modifiers: .command)
                .buttonStyle(.borderedProminent)
                .disabled(model.draft?.isEdited != true || model.saving)
                .help("Saves with polycarp theme change, which checks every value. polycarp theme undo takes it back.")
            Button("Done") { close() }.keyboardShortcut(.cancelAction)
        }
        .labelStyle(.iconOnly)
        .padding(.horizontal, 18).padding(.top, 34).padding(.bottom, 12)
    }

    // MARK: Controls

    private var controls: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(model.sections) { section in
                SettingsGroup(section.title) {
                    ForEach(section.fields) { f in
                        SettingsRow(f.label) { ThemeFieldControl(field: f, model: model, warned: warned(f.path)) }
                            .help(f.help)
                    }
                }
            }
        }
    }

    private func warned(_ path: String) -> [ThemeContrastWarning] { model.warnings.filter { $0.paths.contains(path) } }

    // MARK: Previews

    private var previews: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let t = model.shown {
                HStack(alignment: .top, spacing: 12) {
                    ForEach([false, true], id: \.self) { dark in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(dark ? "Dark" : "Light").font(Chrome.font(12, .semibold)).foregroundStyle(Chrome.muted).padding(.horizontal, 4)
                            ThemeEditorPreview(theme: t, dark: dark)
                        }
                    }
                }
            }
            if let p = model.proposal { proposal(p) }
            SettingsGroup("Contrast") {
                if model.warnings.isEmpty {
                    SettingsNote("Every pair passes WCAG AA in light and dark: 4.5:1 for text, 3:1 for marks.", tone: .done)
                } else {
                    ForEach(model.warnings) { w in SettingsNote(w.message, tone: .urgent) }
                    SettingsNote("Save refuses a theme with these. Change either color of a pair.")
                }
            }
            if let p = model.problem {
                SettingsGroup("Not saved") {
                    SettingsBlock { Text(p).font(Chrome.font(11.5)).foregroundStyle(Chrome.urgent).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                }
            }
            if let n = model.notice { SettingsGroup { SettingsNote(n) } }
            SettingsGroup {
                SettingsNote("Drop a picture on this window to take its colors, or a theme file to add it. In Terminal, polycarp theme preview \(model.name) --format png draws every product.")
            }
        }
    }

    private func proposal(_ p: ThemePaletteProposal) -> some View {
        SettingsGroup("From the picture") {
            SettingsBlock {
                HStack(spacing: 8) {
                    ForEach(Array(p.swatches.enumerated()), id: \.offset) { _, c in
                        Chrome.shape(.settingsCell).fill(Appearance.color(c)).frame(width: 22, height: 22)
                            .overlay(Chrome.shape(.settingsCell).strokeBorder(Chrome.edge(0.2), lineWidth: Chrome.width(.settingsCell)))
                    }
                    Image(systemName: "arrow.right").foregroundStyle(Chrome.muted)
                    ForEach(["light", "dark"], id: \.self) { m in
                        if let c = p.changes["\(m).accent"]?.color {
                            Chrome.pill().fill(Appearance.color(c)).frame(width: 34, height: 18).help("\(m) accent \(c.hex)")
                        }
                    }
                    Spacer()
                    Button("Not Now") { model.proposal = nil }
                    Button("Use These Colors") { model.accept() }.buttonStyle(.borderedProminent)
                }
            }
            SettingsNote("The accent, the text on it, the selection and the border, fitted so every pair still reads. Nothing changes until you use them, and Undo takes them back.")
        }
    }
}

/// The control for one field, picked by its schema type.
struct ThemeFieldControl: View {
    let field: ThemeField
    @ObservedObject var model: ThemeEditorModel
    let warned: [ThemeContrastWarning]

    var body: some View {
        switch field.kind {
        case .color: color
        case .integer(let lo, let hi): slider(Double(lo), Double(hi), step: 1, whole: true)
        case .number(let lo, let hi): slider(lo, hi, step: (hi - lo) / 100, whole: false)
        case .choice(let options):
            Picker(field.label, selection: Binding(get: { model.value(field.path).flatMap { if case .text(let s) = $0 { s } else { nil } } ?? "" },
                                                   set: { model.set(field.path, .text($0)) })) {
                ForEach(options, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden()
            .modifier(Segmented(on: options.count <= 3))
            .frame(width: 190)
        case .toggle:
            Toggle(field.label, isOn: Binding(get: { model.value(field.path) == .flag(true) }, set: { model.set(field.path, .flag($0)) }))
                .labelsHidden()
        case .text:
            ThemeTextField(path: field.path, model: model, width: 190)
        }
    }

    private var color: some View {
        HStack(spacing: 6) {
            if !warned.isEmpty {
                Image(systemName: "exclamationmark.triangle.fill").font(Chrome.font(11)).foregroundStyle(Chrome.urgent)
                    .help(warned.map(\.message).joined(separator: "\n"))
                    .accessibilityLabel("Contrast warning: " + warned.map(\.message).joined(separator: " "))
            }
            ThemeTextField(path: field.path, model: model, width: 76, mono: true)
            ColorPicker(field.label, selection: Binding(
                get: { Appearance.color(model.value(field.path)?.color ?? RGB(r: 0, g: 0, b: 0)) },
                set: { picked in
                    // The well also answers with the color it was shown; that isn't an edit.
                    guard let rgb = Appearance.rgb(picked), let was = model.value(field.path)?.color, rgb.hex != was.hex else { return }
                    model.set(field.path, .color(rgb))
                }), supportsOpacity: false)
                .labelsHidden()
        }
    }

    private func slider(_ lo: Double, _ hi: Double, step: Double, whole: Bool) -> some View {
        let v = model.value(field.path)?.number ?? lo
        return HStack(spacing: 8) {
            Slider(value: Binding(get: { v }, set: { n in
                let snapped = whole ? n.rounded() : (n / step).rounded() * step
                model.set(field.path, .number(min(hi, max(lo, whole ? snapped : (snapped * 100).rounded() / 100))))
            }), in: lo...hi)
            .frame(width: 130)
            .accessibilityLabel(field.label)
            Text(whole ? String(Int(v)) : String(format: "%.2f", v))
                .font(Chrome.font(12).monospacedDigit()).foregroundStyle(Chrome.muted).frame(width: 38, alignment: .trailing)
        }
    }

    private struct Segmented: ViewModifier {
        let on: Bool
        func body(content: Content) -> some View {
            if on { content.pickerStyle(.segmented) } else { content.pickerStyle(.menu) }
        }
    }
}

/// Text for a font stack, an easing or a hex color. Each keystroke goes into the draft; the preview keeps the last value it
/// could draw, and the CLI checks the text on Save.
struct ThemeTextField: View {
    let path: String
    @ObservedObject var model: ThemeEditorModel
    var width: CGFloat
    var mono = false
    @State private var text = ""

    var body: some View {
        TextField(path, text: $text)
            .labelsHidden()
            .textFieldStyle(.roundedBorder)
            .font(mono ? Chrome.font(12).monospaced() : Chrome.font(12))
            .frame(width: width)
            .onAppear { text = current }
            .onChange(of: current) { if $0 != text { text = $0 } }
            .onChange(of: text) { t in
                guard t != current else { return }
                // A color is only taken whole; anything else as typed.
                if mono { if let c = RGB(hex: t), t.count == 7 { model.set(path, .color(c)) } } else { model.set(path, .text(t)) }
            }
            .accessibilityLabel(path)
    }

    private var current: String { if case .text(let s) = model.value(path) { s } else { "" } }
}

/// File URLs from a drop, on the main thread.
enum ThemeDrop {
    static func urls(_ providers: [NSItemProvider], then: @escaping @MainActor ([URL]) -> Void) {
        let group = DispatchGroup()
        var urls: [URL] = []
        let lock = NSLock()
        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            group.enter()
            _ = p.loadObject(ofClass: URL.self) { url, _ in
                if let url { lock.lock(); urls.append(url); lock.unlock() }
                group.leave()
            }
        }
        group.notify(queue: .main) { MainActor.assumeIsolated { then(urls) } }
    }
}
