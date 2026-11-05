import AppKit
import ApplicationServices
import BaneySpacesCore

/// Watches app activations while an agent starts an app, and gives your keyboard back if that app takes it (`FocusReturn`).
/// Polycarp is a background app, and since macOS 14 `activate()` from the background may do nothing, so this goes through
/// Accessibility, as switching workspaces does. All on the main thread.
final class AgentLaunchFocus {
    static let shared = AgentLaunchFocus()
    private var state = FocusReturn()
    /// You chose the agent's app: its claim on the next window ends, so a window you open there stays yours.
    var onPersonTook: (pid_t) -> Void = { _ in }

    private init() {
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self.activated(app)
        }
    }

    private func seed() {
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        state.seed(front: front, agentOwned: front.map { AgentOwned.shared.pids.contains($0) } ?? false)
    }

    func watch(bundle: String, excluding running: Set<pid_t>, for seconds: TimeInterval) {
        seed()
        state.watch(bundle: bundle, excluding: running, until: Date().addingTimeInterval(seconds))
    }

    func watch(pid: pid_t, for seconds: TimeInterval) {
        seed()
        state.watch(pid: pid, until: Date().addingTimeInterval(seconds))
    }

    private func activated(_ app: NSRunningApplication) {
        let source = CGEventSourceStateID.combinedSessionState
        let deliberate = FocusReturn.isDeliberate(
            commandHeld: CGEventSource.flagsState(source).contains(.maskCommand),
            sinceModifierChange: CGEventSource.secondsSinceLastEventType(source, eventType: .flagsChanged),
            sinceMouseDown: CGEventSource.secondsSinceLastEventType(source, eventType: .leftMouseDown))
        let pid = app.processIdentifier
        switch state.activated(pid: pid, bundle: app.bundleIdentifier, agentOwned: AgentOwned.shared.pids.contains(pid), deliberate: deliberate, now: Date()) {
        case .none: break
        case .personTook(let pid):
            Trace.log("agent launch focus: you chose \(app.localizedName ?? "the app"), left alone")
            onPersonTook(pid)
        case .returnTo(let target):
            let result = AXUIElementSetAttributeValue(AXUIElementCreateApplication(target), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            if result != .success { Trace.log("agent launch focus: couldn't return the keyboard to \(target): \(result.rawValue)") }
        }
    }
}
