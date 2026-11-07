import AppKit
import ApplicationServices
import AVFoundation
import BaneySpacesCore
import ServiceManagement
import SwiftUI

/// Live permission state for the welcome window. It reads four times a second while open, so flipping a switch in System
/// Settings shows here at once, and none of these reads ever puts a prompt on screen.
final class WelcomeModel: ObservableObject {
    @Published var granted: Set<PermissionKind> = WelcomeModel.read()
    @Published var skipped: Set<PermissionKind> = []
    @Published var asked: Set<PermissionKind> = []
    var onFinish: () -> Void = {}
    var modifierSymbol: () -> String = { "⌘" }
    var onFixStale: () -> Void = {}
    /// A permission was just granted: the window comes forward so the next button is under the pointer.
    var onGained: () -> Void = {}
    /// The login item, as macOS has it. On unless the person turned it off.
    @Published var startAtLogin = false
    /// BaneySpaces went to the Trash on this first launch: one line says so (`LegacyRetirement`).
    @Published var legacyNote = UserDefaults.standard.bool(forKey: LegacyRetirement.noteKey)
    @Published var loginNeedsApproval = false
    @Published var askedAccessibilityAt: Date?
    /// "Allow All": each permission that comes through, or is skipped, opens the next one, until none is left.
    @Published private(set) var walking = false
    private var timer: Timer?

    static func read() -> Set<PermissionKind> {
        var s = Set<PermissionKind>()
        if AXIsProcessTrusted() { s.insert(.accessibility) }
        if CGPreflightScreenCaptureAccess() { s.insert(.screenRecording) }
        if CGPreflightListenEventAccess() { s.insert(.inputMonitoring) }
        if AVCaptureDevice.authorizationStatus(for: .audio) == .authorized { s.insert(.microphone) }
        return s
    }

    var current: PermissionKind? { Welcome.next(granted: granted, skipped: skipped, features: PartsModel.shared.current) }
    var canStart: Bool { Welcome.canStart(granted: granted, features: PartsModel.shared.current) }
    /// macOS keeps an old grant for an earlier copy: the switch is on and nothing happens.
    var looksStale: Bool {
        guard !granted.contains(.accessibility), let at = askedAccessibilityAt else { return false }
        return Date().timeIntervalSince(at) > 8
    }

    func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            let now = Self.read()
            if now != self.granted {
                let gained = now.subtracting(self.granted)
                self.granted = now
                if !gained.isEmpty {
                    if self.walking {
                        self.walkOn()
                    } else {
                        NSApp.activate(ignoringOtherApps: true)
                        self.onGained()
                    }
                }
            }
            if self.looksStale { self.objectWillChange.send() }
            self.readLoginItem()
            let note = UserDefaults.standard.bool(forKey: LegacyRetirement.noteKey)
            if note != self.legacyNote { self.legacyNote = note }
        }
    }

    func stop() { timer?.invalidate(); timer = nil }

    /// macOS grants each of these only by hand, so this can't do them at once. It takes the person through them with no more clicks here.
    func allowAll() {
        walking = true
        walkOn()
    }

    private func walkOn() {
        guard let next = current else {
            walking = false
            NSApp.activate(ignoringOtherApps: true)
            onGained()
            return
        }
        allow(next)
    }

    /// Adds Polycarp to the list with macOS's own prompt, then opens that list, so what's left is one switch.
    func allow(_ kind: PermissionKind) {
        asked.insert(kind)
        switch kind {
        case .accessibility:
            askedAccessibilityAt = Date()
            let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
        case .screenRecording: _ = CGRequestScreenCaptureAccess()
        case .inputMonitoring: _ = CGRequestListenEventAccess()
        case .microphone:
            // macOS shows its own box while it has never been asked; the list opens only after a no.
            let access: Welcome.MicrophoneAccess = switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: .authorized
            case .notDetermined: .notDetermined
            default: .denied
            }
            if !Welcome.opensSettingsWhenAllowing(microphone: access) {
                if access == .notDetermined { AVCaptureDevice.requestAccess(for: .audio) { _ in } }
                return
            }
        }
        if let url = URL(string: Welcome.step(kind).settingsURL) { NSWorkspace.shared.open(url) }
    }

    /// Reads the login item and, on the first look, turns it on unless the person already decided (Setup's rule, shared).
    func settleLoginItem() {
        let d = UserDefaults.standard
        let status = SMAppService.mainApp.status
        if Welcome.StartAtLogin.shouldRegister(chosen: d.bool(forKey: "loginItemChosen"), offered: d.bool(forKey: "loginItemOffered"),
                                                registered: status != .notRegistered) {
            d.set(true, forKey: "loginItemChosen")
            try? SMAppService.mainApp.register()
        }
        readLoginItem()
    }

    func readLoginItem() {
        let status = SMAppService.mainApp.status
        startAtLogin = status == .enabled || status == .requiresApproval
        loginNeedsApproval = status == .requiresApproval
    }

    func setStartAtLogin(_ on: Bool) {
        UserDefaults.standard.set(true, forKey: "loginItemChosen")
        do { try on ? SMAppService.mainApp.register() : SMAppService.mainApp.unregister() }
        catch { NSLog("Polycarp: open at login failed: %@", error.localizedDescription) }
        readLoginItem()
    }

    func skip(_ kind: PermissionKind) {
        guard Welcome.canSkip(kind) else { return }
        skipped.insert(kind)
        if walking { walkOn() }
    }
}

struct WelcomeView: View {
    @ObservedObject var model: WelcomeModel
    @ObservedObject private var parts = PartsModel.shared
    @ObservedObject private var browser = BrowserModel.shared
    @State private var fullAccess = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 60, height: 60)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Welcome to Polycarp").font(Chrome.font(21, .bold))
                    Text(parts.hasChosen ? (model.canStart ? "You're ready. The rest is optional." : "One switch and you're working.")
                        : "Pick what you want. You can change this any time.")
                        .foregroundStyle(Chrome.muted)
                }
            }
            .padding(.horizontal, 28).padding(.top, 26).padding(.bottom, 20)

            if parts.hasChosen { walk } else { WelcomePartsChooser(parts: parts) }
        }
        .frame(width: 560)
        .foregroundStyle(Chrome.wash())
        .tint(Chrome.accent)
        .background(Chrome.panel())
        .environment(\.colorScheme, Chrome.scheme)
        .animation(Chrome.ease(0.2), value: model.granted)
        .animation(Chrome.ease(0.2), value: model.skipped)
        .animation(Chrome.ease(0.2), value: parts.hasChosen)
    }

    /// The permissions the chosen parts need, then the way in.
    @ViewBuilder private var walk: some View {
            VStack(spacing: 8) {
                allowAllRow
                ForEach(Welcome.steps(for: parts.current).filter(\.isRequired), id: \.kind) { row($0) }
                tryIt
                ForEach(Welcome.steps(for: parts.current).filter { !$0.isRequired }, id: \.kind) { row($0) }
                loginRow
                if parts.current.contains(.browser) { BrowserWelcomeRow() }
                if parts.current.contains(.workspaces) { everythingRow }
            }
            .padding(.horizontal, 20)

            if model.legacyNote {
                Text(LegacyRetirement.welcomeNote).font(Chrome.font(12)).foregroundStyle(Chrome.muted)
                    .padding(.horizontal, 28).padding(.top, 12)
            }

            HStack {
                Text("You can change any of this in Settings.").font(Chrome.font(11)).foregroundStyle(Chrome.muted)
                Spacer()
                Button(model.canStart ? "Start using Polycarp" : "Waiting for Accessibility") { UserDefaults.standard.set(false, forKey: LegacyRetirement.noteKey); model.onFinish() }
                    // Return presses the current permission's button while one is left; this only when none is.
                    .keyboardShortcut(Welcome.defaultAction(granted: model.granted, skipped: model.skipped, features: parts.current) == .finish ? KeyboardShortcut.defaultAction : nil)
                    .disabled(!model.canStart)
                    .buttonStyle(WelcomeButtonStyle(large: true))
            }
            .padding(.horizontal, 28).padding(.vertical, 18)
    }

    /// Everything left at once. Shown only while there are at least two, because one is the button already on its row.
    @ViewBuilder private var allowAllRow: some View {
        let left = Welcome.steps(for: parts.current).filter { !model.granted.contains($0.kind) && !model.skipped.contains($0.kind) }.count
        if left >= 2 {
            HStack(spacing: 10) {
                Text(model.walking ? "Turn on Polycarp in each list, and the next one opens." : "Want all of it? macOS asks for each, one after another.")
                    .font(Chrome.font(12)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if !model.walking { Button("Allow All") { model.allowAll() } }
            }
            .padding(.horizontal, 12).padding(.vertical, 4)
        }
    }

    /// Off until chosen, and it never blocks starting. The sheet says what it covers.
    private var everythingRow: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(AgentEverything.title).font(Chrome.font(13, .bold))
                Text(AgentEverything.why).font(Chrome.font(12)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                if let message = browser.message { Text(message).font(Chrome.font(11)).foregroundStyle(Chrome.working).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 8)
            if everythingOn {
                Image(systemName: "checkmark.circle.fill").font(Chrome.font(16)).foregroundStyle(Chrome.accent)
            } else {
                Button(AgentEverything.button) {
                    if AgentAccess.shared.requestEverything() { browser.turnOnEverything(); fullAccess = AgentAccess.shared.current == .full }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { fullAccess = AgentAccess.shared.current == .full }
    }

    private var everythingOn: Bool {
        AgentEverything.isOn(access: fullAccess ? .full : .standard, anySite: browser.status?.anySite, claudeAllowed: browser.status?.claudeAllowed ?? false, claudeReady: browser.status?.claudeReady ?? false)
    }

    /// Right under what makes it possible, not below the optional steps.
    @ViewBuilder private var tryIt: some View {
            if model.canStart, parts.current.contains(.workspaces) {
                HStack(spacing: 10) {
                    Image(systemName: "leaf.fill").foregroundStyle(Chrome.accent)
                    Text("Try it: press \(model.modifierSymbol())2. Add ⇧ to bring the window along.")
                        .font(Chrome.font(13, .medium))
                }
                .padding(.horizontal, 12).padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .transition(.opacity)
            }
    }

    private func firstSentence(_ text: String) -> String {
        guard let end = text.range(of: ". ") else { return text }
        return String(text[..<end.lowerBound]) + "."
    }

    @ViewBuilder private func row(_ s: PermissionStep) -> some View {
        let done = model.granted.contains(s.kind)
        let isCurrent = model.current == s.kind
        let wasSkipped = model.skipped.contains(s.kind)
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(Chrome.font(16))
                .foregroundStyle(done ? Chrome.accent : Color.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text(s.title).font(Chrome.font(13, .bold))
                    if !s.isRequired { WelcomeTag(text: "Optional") }
                    if wasSkipped { WelcomeTag(text: "Skipped for now") }
                    Spacer(minLength: 0)
                }
                if !done {
                    // The whole reason on the step you're on; its first sentence on the others.
                    Text(isCurrent ? s.why : firstSentence(s.why)).font(Chrome.font(12)).foregroundStyle(Chrome.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !done, isCurrent {
                    HStack(spacing: 10) {
                        Button("Allow in \(s.settingsName)") { model.allow(s.kind) }
                            .keyboardShortcut(.defaultAction)
                            .buttonStyle(WelcomeButtonStyle(large: false))
                        if Welcome.canSkip(s.kind) { Button("Not now") { model.skip(s.kind) } }
                    }
                    if model.asked.contains(s.kind) {
                        Text(s.after).font(Chrome.font(11)).foregroundStyle(Chrome.muted)
                    }
                    if s.kind == .accessibility, model.looksStale {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Already on and still waiting?").font(Chrome.font(12, .bold))
                            Text("macOS can keep an old permission from an earlier copy. This clears it and asks again.")
                                .font(Chrome.font(11)).foregroundStyle(Chrome.muted)
                            Button("Fix Permission") { model.onFixStale() }
                        }
                        .padding(.top, 2)
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Chrome.shape(.settingsCell, continuous: false).fill(isCurrent ? Chrome.cell(0.08) : Color.clear))
    }

    /// Not a permission: a switch, on by default, that never blocks starting.
    private var loginRow: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text(Welcome.StartAtLogin.title).font(Chrome.font(13, .bold))
                    Spacer()
                    Toggle(Welcome.StartAtLogin.title, isOn: Binding(get: { model.startAtLogin }, set: { model.setStartAtLogin($0) }))
                        .toggleStyle(.switch)
                        .labelsHidden()
                }
                Text(Welcome.StartAtLogin.why).font(Chrome.font(12)).foregroundStyle(Chrome.muted)
                if model.loginNeedsApproval {
                    HStack {
                        Text(Welcome.StartAtLogin.approval).font(Chrome.font(11)).foregroundStyle(Chrome.muted)
                        Spacer(minLength: 0)
                        Button(Welcome.StartAtLogin.approvalButton) { SMAppService.openSystemSettingsLoginItems() }
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

}

/// A small label on a welcome row. A type and not a helper named `tag`: from another view, that name is SwiftUI's own
/// `.tag()` on the view itself, which puts the view inside itself and overflows the stack.
private struct WelcomeTag: View {
    let text: String

    var body: some View {
        Text(text).font(Chrome.font(10, .medium)).foregroundStyle(Chrome.muted)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Capsule().fill(Chrome.cell(0.08)))
    }
}

/// The accent with the theme's own text on it, so a light accent in a dark theme stays readable. The system's prominent
/// button always draws white text.
struct WelcomeButtonStyle: ButtonStyle {
    let large: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Chrome.font(large ? 13 : 12, .semibold))
            .foregroundStyle(isEnabled ? Chrome.onAccent : Chrome.wash(0.45))
            .padding(.horizontal, large ? 16 : 12).padding(.vertical, large ? 8 : 5)
            .background(Chrome.shape(.settingsCell, continuous: false).fill(isEnabled ? Chrome.accent : Chrome.cell(0.1)))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

final class WelcomeWindowController: NSWindowController, NSWindowDelegate {
    let model = WelcomeModel()

    convenience init() {
        let window = NSWindow(contentRect: .zero, styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        self.init(window: window)
        window.title = "Welcome to Polycarp"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.delegate = self
        let host = NSHostingView(rootView: WelcomeView(model: model))
        host.sizingOptions = [.intrinsicContentSize]
        window.contentView = host
        window.setContentSize(host.fittingSize)
        window.center()
        model.onGained = { [weak self] in self?.window?.makeKeyAndOrderFront(nil) }
        model.onFinish = { [weak self] in
            UserDefaults.standard.set(true, forKey: Welcome.finishedKey)
            self?.window?.close()
        }
    }

    func show() {
        model.granted = WelcomeModel.read()
        model.settleLoginItem()
        model.start()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) { model.stop() }
}


/// Optional, like the login item: it never blocks starting. The Browser tab in Settings does the work.
private struct BrowserWelcomeRow: View {
    @ObservedObject var model = BrowserModel.shared
    var body: some View {
        if model.available {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: model.status?.extensionConnected == true ? "checkmark.circle.fill" : "globe")
                    .font(Chrome.font(16))
                    .foregroundStyle(model.status?.extensionConnected == true ? Chrome.accent : Color.secondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text("Browser agents").font(Chrome.font(13, .bold))
                        WelcomeTag(text: "Optional")
                    }
                    Text("Let Claude Code and Codex use your browser, in their own tab group. Set it up now or later in Settings > Browser.")
                        .font(Chrome.font(12)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                    if model.status?.unattributed == true {
                        Label("Connected", systemImage: "checkmark.circle.fill").font(Chrome.font(12, .medium)).foregroundStyle(Chrome.accent)
                    }
                    ForEach(model.rows) { row in
                        if row.state == .connected {
                            Label("\(row.name) is connected", systemImage: "checkmark.circle.fill").font(Chrome.font(12, .medium)).foregroundStyle(Chrome.accent)
                        } else {
                            Button("Connect \(row.name)") { model.connect(row.name) }.disabled(model.busy)
                        }
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onAppear { model.startWatching() }
            .onDisappear { model.stopWatching() }
        }
    }
}
