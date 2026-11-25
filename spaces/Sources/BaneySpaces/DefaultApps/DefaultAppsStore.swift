import AppKit
import BaneySpacesCore

/// Who does each job now, kept ready: the keys, the launcher and Settings read it without touching the disk. It is read
/// off the main thread, again when config.toml changes and when an app is added or removed.
final class DefaultAppsStore {
    static let shared = DefaultAppsStore()
    static let didChange = Notification.Name("PolycarpDefaultAppsDidChange")

    struct Now: Equatable {
        var resolved: [AppRole: ResolvedDefault] = [:]
        /// Where a program opens (`DefaultAppResolver.terminalForCommands`).
        var programs: DefaultCandidate?
        /// What is wrong in the file, one line each.
        var warnings: [String] = []
    }

    /// Main thread.
    private(set) var now = Now()
    private var log: (String) -> Void = { _ in }
    private let queue = DispatchQueue(label: "com.baney.polycarp.default-apps", qos: .userInitiated)
    // Only on `queue`.
    private var choices = DefaultAppsFile.Choices()
    private var due = false

    func start(log: @escaping (String) -> Void) {
        self.log = log
        let home = NSHomeDirectory()
        for path in [DefaultAppsFile.path(), "/Applications", home + "/Applications"] {
            _ = PolycarpThemeWatcher.fileEvents(queue, path) { [weak self] in self?.look(after: 0.3) }
        }
        refresh()
    }

    /// Looks again: macOS's own defaults change without a word, so whoever is about to show them asks.
    func refresh() { queue.async { self.look(after: 0) } }

    /// Chooses, or goes back to macOS's for nil. `done` gets what went wrong, on the main thread.
    func choose(_ role: AppRole, _ app: DefaultApp?, done: @escaping (String?) -> Void = { _ in }) {
        queue.async {
            var problem: String?
            do { try DefaultAppsFile.set(role, to: app, path: DefaultAppsFile.path()) } catch { problem = "\(error)" }
            self.read()
            DispatchQueue.main.async { done(problem) }
        }
    }

    /// An install writes a folder many times: one look, a moment later.
    private func look(after seconds: Double) {
        guard !due else { return }
        due = true
        queue.asyncAfter(deadline: .now() + seconds) { self.due = false; self.read() }
    }

    private func read() {
        var problem: String?
        // A file that can't be read keeps the choices it gave before.
        do { choices = try DefaultAppsFile.load(path: DefaultAppsFile.path()) } catch { problem = "config.toml: \(error)" }
        let installed = LaunchServicesApps()
        var next = Now()
        for role in AppRole.allCases { next.resolved[role] = DefaultAppResolver.resolve(role, choice: choices.apps[role], installed: installed) }
        next.programs = DefaultAppResolver.terminalForCommands(choice: choices.apps[.terminal], installed: installed)
        next.warnings = choices.warnings + (problem.map { [$0] } ?? [])
        DispatchQueue.main.async {
            guard next != self.now else { return }
            if next.warnings != self.now.warnings { next.warnings.forEach { self.log("default apps: \($0)") } }
            self.now = next
            NotificationCenter.default.post(name: Self.didChange, object: nil)
        }
    }
}
