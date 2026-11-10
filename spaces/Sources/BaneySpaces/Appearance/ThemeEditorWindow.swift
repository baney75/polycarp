import AppKit
import BaneySpacesCore
import SwiftUI
import UniformTypeIdentifiers

/// The theme editor's window, one per theme. Closing it with edits not saved asks first.
@MainActor
final class ThemeEditorWindow: NSWindowController, NSWindowDelegate {
    private static var open: [String: ThemeEditorWindow] = [:]
    let model: ThemeEditorModel

    /// Opens (or brings forward) the editor for a user theme. `proposal` is a palette the person already chose to use.
    static func show(name: String, title: String? = nil, proposal: ThemePaletteProposal? = nil) {
        if let w = open[name] {
            if let proposal { w.model.proposal = proposal }
            w.window?.makeKeyAndOrderFront(nil)
            return
        }
        let w = ThemeEditorWindow(model: ThemeEditorModel(name: name, title: title ?? name))
        open[name] = w
        w.model.proposal = proposal
        w.model.load()
        w.window?.center()
        NSApp.activate(ignoringOtherApps: true)
        w.window?.makeKeyAndOrderFront(nil)
    }

    init(model: ThemeEditorModel) {
        self.model = model
        let size = ThemeEditorView.size
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = "Edit \(model.title)"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: Chrome.scheme == .dark ? .darkAqua : .aqua)
        super.init(window: window)
        window.delegate = self
        let host = NSHostingView(rootView: ThemeEditorView(model: model) { [weak window] in window?.performClose(nil) })
        host.sizingOptions = []
        window.contentView = host
        window.setContentSize(size)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard model.draft?.isEdited == true else { return true }
        let alert = NSAlert()
        alert.messageText = "Save your changes to \(model.title)?"
        alert.informativeText = "If you don't save, your edits are lost."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Don't Save")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: sender) { [weak self] answer in
            guard let self else { return }
            switch answer {
            case .alertFirstButtonReturn:
                self.model.save()
                self.closeWhenSaved(sender)
            case .alertSecondButtonReturn:
                self.model.revert()
                sender.close()
            default: break
            }
        }
        return false
    }

    /// Closes once Save has worked; a refusal keeps the window open with the CLI's words in it.
    private func closeWhenSaved(_ window: NSWindow, tries: Int = 0) {
        if model.draft?.isEdited != true { window.close(); return }
        guard model.problem == nil, tries < 50 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.closeWhenSaved(window, tries: tries + 1) }
    }

    func windowWillClose(_ notification: Notification) { Self.open[model.name] = nil }
}

/// The themes in Settings > Appearance as tiles: click one to use it, drag one to Finder to save its file, and Customize or
/// Edit opens the editor. Also where a dropped theme file or picture is answered.
struct ThemeShelf: View {
    @ObservedObject private var library = ThemeLibrary.shared
    @ObservedObject private var appearance = Appearance.shared
    /// The theme in use, or nil for the person's own colors.
    let current: String?
    let pick: (String) -> Void

    private var currentTile: ThemeLibrary.Tile? { library.tiles.first { $0.theme.name == current } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollViewReader { scroller in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(library.tiles) { tile in
                        ThemeShelfTile(tile: tile, selected: tile.theme.name == current) { pick(tile.theme.name) }
                            .onDrag {
                                guard let f = tile.file, let p = NSItemProvider(contentsOf: f) else { return NSItemProvider() }
                                p.suggestedName = f.lastPathComponent
                                return p
                            }
                            .help("Click to use \(tile.theme.title). Drag to Finder to save its file.")
                    }
                }
                .padding(.vertical, 2)
            }
            // The theme in use is always in view, even when it's one of yours at the end.
            .onAppear { if let current { scroller.scrollTo(current, anchor: .trailing) } }
            .onChange(of: library.tiles.map(\.id)) { _ in if let current { scroller.scrollTo(current, anchor: .trailing) } }
            }
            HStack(spacing: 8) {
                if let t = currentTile {
                    if t.theme.builtIn {
                        Button("Customize…") { library.customize(t.theme.name) { ThemeEditorWindow.show(name: $0) } }
                            .help("Makes your own copy of \(t.theme.title) and opens it in the editor")
                    } else {
                        Button("Edit…") { ThemeEditorWindow.show(name: t.theme.name, title: t.theme.title) }
                    }
                }
                Button("Import…") { chooseFile() }.help("Add a theme file (.toml)")
                Spacer()
                Text("Drop a theme file or a picture here").font(Chrome.font(11)).foregroundStyle(Chrome.muted)
            }
            answers
        }
        .onAppear { library.reload() }
        .onChange(of: current) { _ in library.reload() }
    }

    @ViewBuilder private var answers: some View {
        if let r = library.replacing {
            VStack(alignment: .leading, spacing: 6) {
                Text(r.question).font(Chrome.font(12)).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Replace") { library.save(r.file, name: r.name) }
                    Button("Keep Mine") { library.replacing = nil }.keyboardShortcut(.cancelAction)
                }
            }
        }
        if let p = library.picture {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    ForEach(Array(p.proposal.swatches.enumerated()), id: \.offset) { _, c in
                        Chrome.shape(.settingsCell).fill(Appearance.color(c)).frame(width: 18, height: 18)
                    }
                    Image(systemName: "arrow.right").foregroundStyle(Chrome.muted)
                    ForEach(["light", "dark"], id: \.self) { m in
                        if let c = p.proposal.changes["\(m).accent"]?.color { Chrome.pill().fill(Appearance.color(c)).frame(width: 28, height: 16) }
                    }
                }
                Text("An accent from the picture, fitted to \(p.base) so every pair still reads.").font(Chrome.font(11.5)).foregroundStyle(Chrome.muted)
                HStack {
                    Button("Open in Editor") { openPicture(p.proposal, base: p.base) }
                    Button("Not Now") { library.picture = nil }
                }
            }
        }
        if let n = library.notice {
            Text(n.text).font(Chrome.font(11.5)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(n.tone == .urgent ? Chrome.urgent : n.tone == .done ? Chrome.done : Chrome.muted)
        }
    }

    /// The editor opens with the picture's colors offered again there; nothing is saved until Save.
    private func openPicture(_ proposal: ThemePaletteProposal, base: String) {
        library.picture = nil
        if let t = library.tiles.first(where: { $0.theme.name == base }), !t.theme.builtIn {
            ThemeEditorWindow.show(name: base, title: t.theme.title, proposal: proposal)
        } else {
            library.customize(base) { ThemeEditorWindow.show(name: $0, proposal: proposal) }
        }
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "toml") ?? .data]
        panel.allowsMultipleSelection = false
        panel.prompt = "Import"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        library.importTheme(url)
    }
}

/// One theme: its light and dark pages side by side with the text and accent on each.
struct ThemeShelfTile: View {
    let tile: ThemeLibrary.Tile
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                HStack(spacing: 0) {
                    half(tile.light)
                    half(tile.dark)
                }
                .frame(width: 84, height: 44)
                .clipShape(Chrome.shape(.settingsTile))
                .overlay(Chrome.shape(.settingsTile).strokeBorder(selected ? Chrome.accent : Chrome.edge(0.2),
                                                                  lineWidth: Chrome.width(.settingsTile, focused: selected)))
                Text(tile.theme.title).font(Chrome.font(11, selected ? .semibold : .regular)).lineLimit(1).frame(width: 84)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(tile.theme.title) theme\(tile.theme.builtIn ? "" : ", yours")\(selected ? ", in use" : "")")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    /// Page, a surface card with a line of text, and the accent.
    @ViewBuilder private func half(_ c: [RGB]) -> some View {
        if c.count == 4 {
            ZStack(alignment: .bottomLeading) {
                Appearance.color(c[0])
                VStack(alignment: .leading, spacing: 3) {
                    Chrome.pill().fill(Appearance.color(c[2])).frame(width: 22, height: 3)
                    Chrome.pill().fill(Appearance.color(c[3])).frame(width: 14, height: 6)
                }
                .padding(5)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .background(Appearance.color(c[1]).padding(.top, 14).padding(.leading, 4))
            }
        } else {
            Chrome.shade(0.5)
        }
    }
}

/// The Appearance tab as a drop target for theme files and pictures.
struct ThemeDropTarget<Content: View>: View {
    let current: String?
    @ViewBuilder var content: () -> Content
    @State private var over = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) { content() }
            .overlay {
                if over {
                    Chrome.shape(.settingsCallout).strokeBorder(Chrome.accent, lineWidth: Chrome.width(.settingsTile, focused: true))
                        .padding(-6).allowsHitTesting(false)
                }
            }
            .onDrop(of: [UTType.fileURL], isTargeted: $over) { providers in
                ThemeDrop.urls(providers) { ThemeLibrary.shared.dropped($0, current: current) }
                return true
            }
    }
}
