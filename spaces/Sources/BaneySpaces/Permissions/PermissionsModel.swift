import AppKit
import ApplicationServices
import AVFoundation
import BaneySpacesCore
import Carbon
import IOKit.hid
import UserNotifications

/// macOS's live answers for every permission in `Permissions.all`, for Settings > Permissions, the welcome window and the
/// drag helper. It reads once a second, and only while a window showing it is on screen or the drag helper is up: closed,
/// it reads nothing. None of these reads ever puts a prompt on screen; only `perform` and `askAutomation` do, after a click.
final class PermissionsModel: ObservableObject {
    static let shared = PermissionsModel()

    @Published private(set) var states: [PermissionID: PermissionState] = [:]

    /// One app Polycarp scripts, as macOS has it now. Only apps that are installed.
    struct TargetRow: Identifiable, Equatable {
        let target: Permissions.AutomationTarget
        let state: PermissionState
        let path: String
        var id: String { target.bundleID }
    }
    @Published private(set) var targets: [TargetRow] = []

    private var timer: Timer?
    private let watching = NSHashTable<NSWindow>.weakObjects()
    private var observers: [NSObjectProtocol] = []
    private var notifications: PermissionState = .unknown
    private var sample = false
    /// Apple Events and Launch Services answers can take a moment, so they're read off the main thread, one at a time.
    private let slow = DispatchQueue(label: "polycarp.permissions.read", qos: .userInitiated)
    private var slowBusy = false

    private init() {
        states = readFast()
        let center = NotificationCenter.default
        // Coming back from System Settings, or a watched window coming into view, reads at once and starts the clock again.
        for name in [NSApplication.didBecomeActiveNotification, NSWindow.didBecomeKeyNotification, NSWindow.didChangeOcclusionStateNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let self else { return }
                if let w = note.object as? NSWindow, !self.watching.contains(w) { return }
                self.wake()
            })
        }
    }

    // MARK: Watching

    /// A view showing permissions is in this window. Reading runs while it is on screen.
    func watch(_ window: NSWindow?) {
        guard let window, !watching.contains(window) else { return }
        watching.add(window)
        wake(force: true)
    }

    /// Read now, and keep reading while anyone can see the result. Without `force`, only when someone can.
    func wake(force: Bool = false) {
        guard !sample, force || shouldRead else { return }
        refresh()
        guard timer == nil, shouldRead else { return }
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        t.tolerance = 0.2
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private var shouldRead: Bool {
        DragHelper.shared.isActive || watching.allObjects.contains { $0.isVisible && $0.occlusionState.contains(.visible) }
    }

    private func tick() {
        guard shouldRead else { timer?.invalidate(); timer = nil; return }
        refresh()
    }

    // MARK: Reading

    private static func askedKey(_ id: PermissionID) -> String { "permissionAsked.\(id.rawValue)" }
    private func asked(_ id: PermissionID) -> Bool { UserDefaults.standard.bool(forKey: Self.askedKey(id)) }

    /// A real app bundle: Notifications and the drag helper need one; a `swift build` run has none.
    static var isAppBundle: Bool { Bundle.main.bundleURL.pathExtension == "app" }

    /// The answers macOS gives at once, without a prompt.
    private func readFast() -> [PermissionID: PermissionState] {
        var s: [PermissionID: PermissionState] = [:]
        for id in PermissionID.allCases { s[id] = readNow(id) }
        return s
    }

    /// One answer, now. Automation and Notifications come from the last slow read.
    func readNow(_ id: PermissionID) -> PermissionState {
        if sample { return states[id] ?? .unknown }
        switch id {
        case .accessibility: return Permissions.listState(granted: AXIsProcessTrusted(), asked: asked(id))
        case .screenRecording: return Permissions.listState(granted: CGPreflightScreenCaptureAccess(), asked: asked(id))
        case .inputMonitoring: return Permissions.hidState(IOHIDCheckAccess(kIOHIDRequestTypeListenEvent).rawValue)
        case .microphone: return Permissions.microphoneState(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)
        case .notifications: return notifications
        case .automation: return Permissions.automationState(targets.map(\.state))
        }
    }

    func refresh() {
        guard !sample else { return }
        var now = readFast()
        now[.automation] = states[.automation] ?? .unknown
        if now != states { states = now }
        readSlow()
    }

    private func readSlow() {
        guard !slowBusy else { return }
        slowBusy = true
        let bundle = Self.isAppBundle
        slow.async { [weak self] in
            let rows: [TargetRow] = Permissions.automationTargets().compactMap { t in
                guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: t.bundleID) else { return nil }
                return TargetRow(target: t, state: Self.appleEventState(t.bundleID), path: url.path)
            }
            let finish = { (note: PermissionState) in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.slowBusy = false
                    self.notifications = note
                    if rows != self.targets { self.targets = rows }
                    var s = self.states
                    s[.automation] = Permissions.automationState(rows.map(\.state))
                    s[.notifications] = note
                    if s != self.states { self.states = s }
                }
            }
            // UNUserNotificationCenter stops the process when there's no app bundle.
            guard bundle else { return finish(.unknown) }
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                finish(Permissions.notificationState(settings.authorizationStatus.rawValue))
            }
        }
    }

    /// Asks nothing: `askUserIfNeeded` is false.
    private static func appleEventState(_ bundleID: String) -> PermissionState {
        let target = NSAppleEventDescriptor(bundleIdentifier: bundleID)
        return Permissions.appleEventState(AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, false))
    }

    // MARK: Acting, after a click

    /// The row's one button: macOS's own box when it will show one, otherwise the exact pane, with the drag helper for a list.
    func perform(_ id: PermissionID) {
        let entry = Permissions.entry(id)
        let state = readNow(id)
        let action = Permissions.action(entry, state)
        UserDefaults.standard.set(true, forKey: Self.askedKey(id))
        switch action {
        case .none: break
        case .ask: request(id)
        case .openSettings(let requestFirst, let helper):
            if requestFirst { request(id) }
            if let url = URL(string: entry.settingsURL) { NSWorkspace.shared.open(url) }
            if helper { DragHelper.shared.begin(for: id) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.wake(force: true) }
    }

    /// macOS's own request for each. For a list, it also puts Polycarp in the list, switched off.
    private func request(_ id: PermissionID) {
        switch id {
        case .accessibility:
            let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
        case .screenRecording: _ = CGRequestScreenCaptureAccess()
        case .inputMonitoring: _ = CGRequestListenEventAccess()
        case .microphone:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in DispatchQueue.main.async { self?.wake(force: true) } }
        case .notifications:
            guard Self.isAppBundle else { return }
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.wake(force: true) }
            }
        case .automation: break
        }
    }

    /// One app's Automation button: macOS's own box for an app it hasn't asked about, else the Automation list.
    func askAutomation(_ row: TargetRow) {
        switch Permissions.automationAction(row.state) {
        case .none: break
        case .openSettings:
            if let url = URL(string: Permissions.entry(.automation).settingsURL) { NSWorkspace.shared.open(url) }
        case .ask:
            let target = NSAppleEventDescriptor(bundleIdentifier: row.target.bundleID)
            // It waits for your answer, so never on the main thread or the script queue.
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                _ = AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, true)
                DispatchQueue.main.async { self?.wake(force: true) }
            }
        }
    }

    // MARK: Render

    /// `--render`: fixed answers, so the pictures don't depend on this Mac. Reads nothing after this.
    func useRenderSample() {
        sample = true
        timer?.invalidate(); timer = nil
        states = [.accessibility: .granted, .screenRecording: .notAsked, .inputMonitoring: .denied, .microphone: .granted,
                  .automation: .notAsked, .notifications: .notAsked]
        let pick: [String: PermissionState] = ["com.mitchellh.ghostty": .granted, "net.imput.helium": .notAsked,
                                               "com.apple.Terminal": .unknown, "com.apple.systemevents": .denied]
        targets = Permissions.automationTargets().compactMap { t in
            guard let state = pick[t.bundleID] else { return nil }
            let path = NSWorkspace.shared.urlForApplication(withBundleIdentifier: t.bundleID)?.path ?? "/System/Applications/Utilities/Terminal.app"
            return TargetRow(target: t, state: state, path: path)
        }
    }
}
