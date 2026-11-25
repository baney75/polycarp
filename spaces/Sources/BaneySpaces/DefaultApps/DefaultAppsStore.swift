import AppKit
import BaneySpacesCore
import Combine

/// Who does each job now, kept ready: the keys, the launcher and Settings read it without touching the disk. It is read
/// off the main thread, again when config.toml changes and when an app is added or removed.
final class DefaultAppsStore: ObservableObject {
    static let shared = DefaultAppsStore()
    static let didChange = Notification.Name("PolycarpDefaultAppsDidChange")

    struct Now: Equatable {
        var resolved: [AppRole: ResolvedDefault] = [:]
        /// What macOS uses for the jobs it keeps a default for.
        var system: [AppRole: DefaultCandidate] = [:]
        /// Where a program opens (`DefaultAppResolver.terminalForCommands`).
        var programs: DefaultCandidate?
        /// The keys that open them.
        var keys = RoleKeys.Plan()
        /// What is wrong in the file, one line each.
        var warnings: [String] = []
    }

    /// Main thread.
    @Published private(set) var now = Now()
    /// The apps' icons, small. Empty until Settings first shows them (`showIcons`).
    @Published private(set) var icons: [DefaultApp: NSImage] = [:]
    /// Chords macOS wouldn't give us when they were registered. Main thread.
    var refused: Set<Chord> = []
    /// The keys as they are now, for the shortcut lists.
    var keys: RoleKeys.Plan { now.keys.leaving(refused) }
    private var log: (String) -> Void = { _ in }
    private let queue = DispatchQueue(label: "com.baney.polycarp.default-apps", qos: .userInitiated)
    // Only on `queue`.
    private var choices = DefaultAppsFile.Choices()
    private var due = false
    /// What stops each watch. Kept: a watch whose stop is let go is freed, and hears nothing.
    private var stops: [() -> Void] = []
    private var drawn: [DefaultApp: NSImage]?

    func start(log: @escaping (String) -> Void) {
        self.log = log
        let home = NSHomeDirectory()
        stops = [DefaultAppsFile.path(), SurfacesFile.path(), "/Applications", home + "/Applications"].map { path in
            PolycarpThemeWatcher.fileEvents(queue, path) { [weak self] in self?.look(after: 0.3) }
        }
        refresh()
    }

    /// Looks again: macOS's own defaults change without a word, so whoever is about to show them asks.
    func refresh() { queue.async { self.look(after: 0) } }

    /// Settings is about to show every app there is to pick: looks again, and has their icons from then on.
    func showIcons() {
        queue.async {
            if self.drawn == nil { self.drawn = [:] }
            self.look(after: 0)
        }
    }

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
        var next = Self.answer(choices, installed)
        next.keys = RoleKeys.now(modifier: Modifier.current.rawValue)
        next.warnings = choices.warnings + next.keys.warnings + (problem.map { [$0] } ?? [])
        DispatchQueue.main.async {
            guard next != self.now else { return }
            if next.warnings != self.now.warnings { next.warnings.forEach { self.log("default apps: \($0)") } }
            self.now = next
            NotificationCenter.default.post(name: Self.didChange, object: nil)
        }
        drawIcons(next, installed)
    }

    private static func answer(_ choices: DefaultAppsFile.Choices, _ installed: LaunchServicesApps) -> Now {
        var out = Now()
        for role in AppRole.allCases {
            out.resolved[role] = DefaultAppResolver.resolve(role, choice: choices.apps[role], installed: installed)
            out.system[role] = DefaultAppResolver.systemDefault(role, installed)
        }
        out.programs = DefaultAppResolver.terminalForCommands(choice: choices.apps[.terminal], installed: installed)
        return out
    }

    /// The icons the list is missing, drawn here so the main thread only shows them.
    private func drawIcons(_ now: Now, _ installed: LaunchServicesApps) {
        guard let had = drawn else { return }
        let icons = Self.icons(now, installed, had: had)
        drawn = icons
        if icons.count != had.count { DispatchQueue.main.async { self.icons = icons } }
    }

    private static func icons(_ now: Now, _ installed: LaunchServicesApps, had: [DefaultApp: NSImage]) -> [DefaultApp: NSImage] {
        var out = had
        for c in now.resolved.values.flatMap(\.candidates) where out[c.app] == nil {
            guard case let .app(bundle) = c.app, let path = installed.appURL(bundle)?.path else { continue }
            let icon = NSWorkspace.shared.icon(forFile: path)
            var rect = NSRect(x: 0, y: 0, width: 64, height: 64)
            if let image = icon.cgImage(forProposedRect: &rect, context: nil, hints: nil) {
                out[c.app] = NSImage(cgImage: image, size: NSSize(width: 16, height: 16))
            }
        }
        return out
    }

    /// What the product shots show: this Mac's apps, with choices that show each kind of row.
    func useRenderSample() {
        var sample = DefaultAppsFile.Choices()
        let chosen: [AppRole: DefaultApp] = [.terminal: .app("com.mitchellh.ghostty"), .agent: .command("claude"), .browser: .app("com.apple.Safari"),
                                             .notes: .app("com.example.notes")]
        for (role, app) in chosen { sample.apps[role] = app }
        let installed = LaunchServicesApps()
        now = Self.answer(sample, installed)
        icons = Self.icons(now, installed, had: [:])
    }
}
