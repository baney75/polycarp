import AppKit
import BaneySpacesCore
import SwiftUI

/// Settings › Keys: the key that opens each job's app, and changing it by pressing another.
struct RoleKeysGroup: View {
    /// Polycarp's own keys stop while one is recorded, or pressing one would do what it does instead of being the answer.
    var pauseKeys: (Bool) -> Void
    @ObservedObject private var store = DefaultAppsStore.shared
    @ObservedObject private var appearance = Appearance.shared
    @State private var recording: AppRole?
    @State private var monitor: Any?
    @State private var problem: [AppRole: String] = [:]

    var body: some View {
        SettingsGroup("Default apps") {
            ForEach(DefaultAppsText.groups.flatMap(\.roles), id: \.self) { role in
                SettingsRow(role.title, help: RoleKeysText.line(role, store.keys)) { control(role) }
                if let p = problem[role] { SettingsNote(p, tone: .urgent) }
            }
            LearnMore("Click a key, then press the one you want. Escape leaves it as it was and Delete takes it away. A key macOS, another app or Polycarp has already is refused. Each is a line under [keys.bindings] in config.toml.")
        }
        .onDisappear(perform: stop)
        // Anywhere else the keys belong to the app in front.
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didResignKeyNotification)) { _ in stop() }
    }

    private func control(_ role: AppRole) -> some View {
        HStack(spacing: 6) {
            Button(recording == role ? "Press a key…" : RoleKeysText.key(role, store.keys) ?? "Add a key…") {
                if recording == role { stop() } else { start(role) }
            }
            .accessibilityLabel("Key for \(role.title)")
            .accessibilityValue(recording == role ? "recording" : RoleKeysText.key(role, store.keys) ?? "none")
            Menu {
                Button(RoleKeysText.standard(role)) { change(role, RoleKeysText.suggestion(role)) }
                Button("No Key") { change(role, .off) }
            } label: { Image(systemName: "ellipsis").foregroundStyle(Chrome.muted) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 22)
                .accessibilityLabel("More for \(role.title)")
        }
    }

    // MARK: Recording

    private func start(_ role: AppRole) {
        stop()
        problem[role] = nil
        recording = role
        pauseKeys(true)
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            take(e, role)
            return nil
        }
    }

    private func stop() {
        guard recording != nil else { return }
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        recording = nil
        pauseKeys(false)
    }

    private func take(_ e: NSEvent, _ role: AppRole) {
        let held: [(NSEvent.ModifierFlags, Chord.Mod)] = [(.control, .ctrl), (.option, .alt), (.shift, .shift), (.command, .cmd)]
        let mods = Set(held.filter { e.modifierFlags.contains($0.0) }.map(\.1))
        switch RoleKeysText.press(keyCode: Int(e.keyCode), mods: mods) {
        case .needsMore: NSSound.beep()
        case .cancel: stop()
        case .clear: stop(); change(role, .off)
        case .chord(let c): stop(); change(role, .chord(c))
        }
    }

    private func change(_ role: AppRole, _ to: RoleKeysFile.Change) {
        store.setKey(role, to) { problem[role] = $0 }
    }
}
