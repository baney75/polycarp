import AppKit
import ApplicationServices
import BaneySpacesCore

/// Watches app activations while an agent starts an app, and gives your keyboard back if that app takes it (`FocusReturn`).
/// Polycarp is a background app, and since macOS 14 `activate()` from the background may do nothing, so this goes through
/// Accessibility, as switching workspaces does. All on the main thread.
final class AgentLaunchFocus {
    static let shared = AgentLaunchFocus()
    private var state = FocusReturn()

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
        let now = Date()
        state.watch(bundle: bundle, excluding: running, now: now, until: now.addingTimeInterval(seconds))
    }

    func watch(pid: pid_t, for seconds: TimeInterval) {
        seed()
        let now = Date()
        state.watch(pid: pid, now: now, until: now.addingTimeInterval(seconds))
    }

    private func activated(_ app: NSRunningApplication) {
        let pid = app.processIdentifier
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        switch state.activated(pid: pid, bundle: app.bundleIdentifier, agentOwned: AgentOwned.shared.pids.contains(pid), frontNow: front, now: Date()) {
        case .none: break
        case .returnTo(let target):
            let result = AXUIElementSetAttributeValue(AXUIElementCreateApplication(target), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            if result != .success { Trace.log("agent launch focus: couldn't return the keyboard to \(target): \(result.rawValue)") }
        }
    }
}
