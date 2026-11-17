import AppKit
import BaneySpacesCore
import SwiftUI

extension Modifier {
    /// Settings > Keys' choice as the keymap's `mod`.
    var keyModifiers: Set<KeyModifier> { Keymap.settingsMod(stored: rawValue) }
}

/// The keys in force, from `spaces.toml` (`KeymapState`). The file is looked at about once a second, a stat, the way the
/// feature file is; a change is applied at once, a bad one leaves the keys as they were and says why.
final class KeymapController {
    private let path = SpacesFile.path()
    private var stamp: PolycarpThemeFile.Stamp?
    private var timer: Timer?
    private(set) var state = KeymapState(settingsMod: Modifier.current.keyModifiers)
    private let notice = KeysNotice()
    /// Chords macOS refused at the last registration (another app holds them).
    var taken: [Chord] = []

    /// The keys changed: register them again.
    var onChange: (() -> Void)?

    var keymap: Keymap { state.keymap }

    init() {
        stamp = path.flatMap { PolycarpThemeFile.stamp($0) }
        if let message = state.fileChanged(read(), quiet: true) { tell(message) }
    }

    func watch() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.look() }
    }

    private func read() -> String? {
        guard let path, let data = FileManager.default.contents(atPath: path) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private func look() {
        guard let path else { return }
        let now = PolycarpThemeFile.stamp(path)
        guard now != stamp else { return }
        stamp = now
        let before = state.keymap
        let message = state.fileChanged(read())
        if let message { tell(message) }
        if state.keymap != before { onChange?() }
    }

    /// The recovery chord was held.
    func recover() {
        tell(state.recover())
        onChange?()
    }

    func settingsModChanged() {
        state.settingsModChanged(Modifier.current.keyModifiers)
    }

    /// Chords another app holds: said once per registration, in the notice and the trace.
    func refused(_ chords: [Chord]) {
        let new = chords.filter { !taken.contains($0) }
        taken = chords
        guard !new.isEmpty else { return }
        tell("Another app holds \(new.map(\.symbol).joined(separator: ", ")); \(new.count == 1 ? "that key does" : "those keys do") nothing in Polycarp")
    }

    private func tell(_ message: String) {
        Trace.log("keys: \(message)")
        notice.show(message)
    }
}

/// A short line near the bottom of the screen, in the theme's HUD panel, that never takes focus or clicks.
final class KeysNotice {
    private var panel: NSPanel?
    private var hideWork: DispatchWorkItem?
    private let model = KeysNoticeModel()

    func show(_ text: String) {
        model.text = text
        let p = panel ?? makePanel()
        panel = p
        if let host = p.contentView { host.layoutSubtreeIfNeeded(); p.setContentSize(host.fittingSize) }
        if let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main {
            let size = p.frame.size
            p.setFrameOrigin(NSPoint(x: screen.frame.midX - size.width / 2, y: screen.frame.minY + screen.frame.height * 0.08))
        }
        hideWork?.cancel()
        p.alphaValue = 1
        p.orderFrontRegardless()
        let work = DispatchWorkItem { [weak p] in
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = Chrome.duration(0.18, .panelOut)
                p?.animator().alphaValue = 0
            }
        }
        hideWork = work
        // Long enough to read a line and its reason.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2 + Double(text.count) / 25, execute: work)
    }

    private func makePanel() -> NSPanel {
        let host = NSHostingView(rootView: KeysNoticeView(model: model))
        host.sizingOptions = [.intrinsicContentSize]
        let p = NSPanel(contentRect: NSRect(origin: .zero, size: host.fittingSize), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.ignoresMouseEvents = true
        p.level = .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        p.contentView = host
        return p
    }
}

final class KeysNoticeModel: ObservableObject {
    @Published var text = ""
}

struct KeysNoticeView: View {
    @ObservedObject var model: KeysNoticeModel
    @ObservedObject private var appearance = Appearance.shared

    var body: some View {
        Text(model.text)
            .font(Chrome.font(13, .medium))
            .foregroundStyle(Chrome.wash())
            .multilineTextAlignment(.center)
            .frame(maxWidth: 520)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 18).padding(.vertical, 12)
            .background(Chrome.panelBackground(.hudPanel))
            .padding(20)
            .environment(\.colorScheme, Chrome.scheme)
            .accessibilityLabel(model.text)
    }
}
