import AppKit
import BaneySpacesCore
import SwiftUI
import UniformTypeIdentifiers

/// Looks, at the top of Settings > Appearance: one click picks a look, Apply puts all of it on, and Undo takes it back.
struct LooksGroup: View {
    @ObservedObject private var library = LookLibrary.shared
    @ObservedObject private var appearance = Appearance.shared

    var body: some View {
        SettingsGroup("Looks") {
            SettingsBlock {
                VStack(alignment: .leading, spacing: 10) {
                    shelf
                    buttons
                    if let title = library.newTitle { nameField(title) }
                    if let r = library.replacing { question(r) }
                    answer
                }
            }
            LearnMore("A look is how all of Polycarp looks, as one thing: the theme and accent, your style.css, the bar and the other surfaces, and the paper. Export writes one file to share. A look someone sends you can change only how things look, and it is checked before it is saved. In Terminal, polycarp look does the same.")
        }
        .onAppear { library.reload() }
        // A theme picked below, or by an agent, changes which look is in force.
        .onChange(of: appearance.polycarp) { _ in library.reload() }
        // A look applied elsewhere may keep the theme and change the sheet, the surfaces or the paper (in surfaces.json).
        .onReceive(NotificationCenter.default.publisher(for: SurfacesStore.didChange)) { _ in library.reload() }
        .onReceive(NotificationCenter.default.publisher(for: StyleSheetStore.didChange)) { _ in library.reload() }
    }

    private var shelf: some View {
        ScrollViewReader { scroller in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(library.looks) { look in
                        LookTile(look: look, selected: look.name == library.chosen?.name) {
                            library.picked = look.name
                            library.notice = look.problem.map { ($0, .urgent) }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            .onChange(of: library.chosen?.name) { name in if let name { scroller.scrollTo(name) } }
        }
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            Button("Apply") { if let l = library.chosen { library.apply(l) } }
                .disabled(library.chosen.map { $0.current || $0.problem != nil } ?? true)
                .help("Puts the picked look on, all of it or none")
            Button("Save Current Look…") { library.newTitle = library.newTitle == nil ? "" : nil }
            Button("Import…") { chooseFile() }.help("Check a look someone sent you and add it. Nothing on screen changes.")
            Button("Export…") { if let l = library.chosen { saveFile(l) } }
                .disabled(library.chosen.map { $0.problem != nil } ?? true)
                .help("Write the picked look to one file to share")
            Spacer(minLength: 0)
            Button("Undo") { library.undo() }.disabled(!library.canUndo)
                .help("Puts everything back as it was before the last look. Undo again to come forward.")
        }
        .disabled(library.busy != nil)
    }

    private func nameField(_ title: String) -> some View {
        HStack(spacing: 8) {
            TextField("Name", text: Binding(get: { title }, set: { library.newTitle = $0 }), prompt: Text("Name this look"))
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("The look's name")
                .onSubmit { library.save(title) }
            Button("Save") { library.save(title) }.disabled(LookCommands.name(for: title) == nil || library.busy != nil)
            Button("Cancel") { library.newTitle = nil }.keyboardShortcut(.cancelAction)
        }
    }

    private func question(_ r: LookLibrary.Replace) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(r.question).font(Chrome.font(12)).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Replace") { library.replace(r) }
                Button("Keep Mine") { library.replacing = nil }
            }
        }
    }

    @ViewBuilder private var answer: some View {
        if let b = library.busy {
            Text(b).font(Chrome.font(11.5)).foregroundStyle(Chrome.muted)
        } else if let n = library.notice {
            Text(n.text).font(Chrome.font(11.5)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(n.tone == .urgent ? Chrome.urgent : n.tone == .done ? Chrome.done : Chrome.muted)
        }
    }

    private static var type: UTType { UTType(filenameExtension: LookCommands.fileExtension) ?? .data }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [Self.type]
        panel.allowsMultipleSelection = false
        panel.prompt = "Import"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        library.importFile(url)
    }

    private func saveFile(_ look: ThemeCommandReply.Look) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [Self.type]
        panel.nameFieldStringValue = "\(look.name).\(LookCommands.fileExtension)"
        panel.prompt = "Export"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        library.export(look, to: url)
    }
}

/// One look: its light and dark pages, its name, and a check on the one in force.
struct LookTile: View {
    let look: ThemeCommandReply.Look
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                ThemePages(light: look.light, dark: look.dark)
                    .overlay {
                        if look.problem != nil { Image(systemName: "exclamationmark.triangle").font(Chrome.font(14)).foregroundStyle(Chrome.urgent) }
                    }
                    .overlay(Chrome.shape(.settingsTile).strokeBorder(selected ? Chrome.accent : Chrome.edge(0.2),
                                                                      lineWidth: Chrome.width(.settingsTile, focused: selected)))
                HStack(spacing: 3) {
                    if look.current { Image(systemName: "checkmark").font(Chrome.font(9, .bold)).foregroundStyle(Chrome.done) }
                    Text(look.title).font(Chrome.font(11, selected ? .semibold : .regular)).lineLimit(1)
                }
                .frame(width: ThemePages.size.width)
            }
        }
        .buttonStyle(.plain)
        .help(look.problem ?? (look.current ? "\(look.title) is how everything looks now" : "\(look.title): click, then Apply"))
        .accessibilityLabel("\(look.title) look\(look.shipped ? "" : ", yours")\(look.current ? ", in use" : "")\(look.problem == nil ? "" : ", can't be used")")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}
