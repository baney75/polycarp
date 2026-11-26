import AppKit
import BaneySpacesCore

/// Does what `RoleStep` says. Main thread.
enum RoleOpener {
    /// What the workspaces and the session engine do, set by the app delegate.
    struct Hooks {
        var hasWindow: (pid_t) -> Bool
        var focus: (pid_t) -> Void
        var newWindow: (pid_t, @escaping () -> Void) -> Void
        /// Where you are working: the terminal in front's folder.
        var folder: () -> String?
        /// A new Ghostty window at a folder, when it is running.
        var ghosttyWindow: (String) -> Void
    }
    static var hooks: Hooks?

    /// `handle` answers at once; what opens comes a moment later.
    @discardableResult
    static func open(_ r: RoleRequest) -> Wire.Reply {
        guard let hooks, let resolved = DefaultAppsStore.shared.now.resolved[r.role] else {
            return .init(ok: false, error: "Polycarp is still reading which apps are installed; try again")
        }
        let bundle = resolved.app.flatMap { if case .app(let b) = $0.app { b } else { nil } }
        let running = bundle.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0).first }
        let step = RoleStep.of(r, resolved, running: running != nil, hasWindow: running.map { hooks.hasWindow($0.processIdentifier) } ?? false)
        Trace.log("open \(r.role.rawValue): \(resolved.app?.app.id ?? "none"), \(step.name)")
        let reply = Wire.Reply(ok: true, info: ["role": r.role.rawValue, "app": resolved.app?.name ?? "", "did": step.name])
        switch step {
        case .nothing(let why): return .init(ok: false, error: why)
        case .ask:
            guard !asking else { return .init(ok: false, error: "Polycarp is already asking which agent to use: answer it on screen") }
            asking = true
            // After the reply: the question waits for a person. A run loop turn, not a main-queue block: a modal loop
            // run inside a main-queue block holds the queue, and everything else on it waits for the answer.
            RunLoop.main.perform { defer { asking = false }; ask(r, resolved) }
            return .init(ok: true, info: ["role": r.role.rawValue, "did": "asked on screen which agent to use"])
        case .program(let id, let path): run(id, path, r, hooks)
        case .terminalWindow: if let bundle { terminal(bundle, r.folder ?? hooks.folder() ?? NSHomeDirectory(), hooks) }
        case .openFolder(let f): if let bundle { openFile(f, with: bundle) }
        case .goTo: if let running { hooks.focus(running.processIdentifier) }
        case .newWindow: if let bundle, let running { hooks.newWindow(running.processIdentifier) { launch(bundle) } }
        case .launch: if let bundle { launch(bundle) }
        }
        if let p = r.prompt, bundle != nil, let name = resolved.app?.name { copy(p, for: name) }
        return reply
    }

    // MARK: Programs

    private static func run(_ id: String, _ path: String, _ r: RoleRequest, _ hooks: Hooks) {
        let words = r.role == .agent ? AgentLaunch.argv(id, at: path, prompt: r.prompt) : (argv: [path], clipboard: nil)
        let folder = r.folder ?? hooks.folder() ?? NSHomeDirectory()
        guard let app = DefaultAppsStore.shared.now.programs, let job = TerminalJob(argv: words.argv, folder: folder) else {
            return fail("Couldn’t open \(id): there is no terminal for it, or its words are too long")
        }
        let runner = SessionController.cliPath()
        do {
            let (name, script) = try TerminalJobs(folder: TerminalJobs.folder(home: FileManager.default.homeDirectoryForCurrentUser)).write(job, runner: runner)
            guard let plan = TerminalPlan.run(app.app.id, folder: folder, runner: runner, id: name, script: script) else {
                return fail("\(app.name) can’t be told what to run")
            }
            carryOut(plan, app.app.id, hooks)
            if let p = words.clipboard { copy(p, for: DefaultAppCatalog.name(.command(id), for: r.role)) }
        } catch {
            fail("Couldn’t open \(id): \(error)")
        }
    }

    private static func terminal(_ bundle: String, _ folder: String, _ hooks: Hooks) {
        carryOut(TerminalPlan.shell(bundle, folder: folder), bundle, hooks)
    }

    private static func carryOut(_ plan: TerminalPlan, _ bundle: String, _ hooks: Hooks) {
        switch plan {
        case let .ghostty(folder, script?):
            let open = { openFile(script, with: bundle) }
            if let ghostty = Terminals.ghostty { ghostty(folder, URL(fileURLWithPath: script), open) } else { open() }
        case let .ghostty(folder, nil):
            // Started by the folder when it isn't running: its own first window would open at home beside it.
            let running = !NSRunningApplication.runningApplications(withBundleIdentifier: bundle).isEmpty
            if running { hooks.ghosttyWindow(folder) } else { openFile(folder, with: bundle) }
        case .openFile(let f): openFile(f, with: bundle)
        case .link(let l): if let url = URL(string: l) { open([url], with: bundle) }
        case .launch(let words):
            guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { return fail("\(bundle) isn’t installed") }
            let c = NSWorkspace.OpenConfiguration()
            c.arguments = words
            c.createsNewApplicationInstance = true
            NSWorkspace.shared.openApplication(at: app, configuration: c) { _, e in if let e { say(e) } }
        }
    }

    // MARK: Apps

    private static func launch(_ bundle: String) {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { return fail("\(bundle) isn’t installed") }
        NSWorkspace.shared.openApplication(at: app, configuration: .init()) { _, e in if let e { say(e) } }
    }

    private static func openFile(_ path: String, with bundle: String) { open([URL(fileURLWithPath: path)], with: bundle) }

    private static func open(_ urls: [URL], with bundle: String) {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { return fail("\(bundle) isn’t installed") }
        NSWorkspace.shared.open(urls, withApplicationAt: app, configuration: .init()) { _, e in if let e { say(e) } }
    }

    private static func copy(_ prompt: String, for name: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(prompt, forType: .string)
        Toast.show("\(name) takes no prompt from outside: it is on the clipboard, press ⌘V there", symbol: "doc.on.clipboard")
    }

    private static func say(_ e: Error) { DispatchQueue.main.async { fail(e.localizedDescription) } }
    private static func fail(_ line: String) { Toast.show(line, symbol: "exclamationmark.triangle.fill") }

    // MARK: Asking

    /// The question is on screen: one at a time, so two calls never start two agents.
    private static var asking = false

    /// First use, or the chosen one is gone: you choose, it is saved, and it opens.
    private static func ask(_ r: RoleRequest, _ resolved: ResolvedDefault) {
        let alert = NSAlert()
        guard !resolved.candidates.isEmpty else {
            alert.messageText = "No AI agent is installed"
            alert.informativeText = "Install one (Claude Code, Codex, OpenCode, the ChatGPT or Claude app…) and open it again."
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            return
        }
        alert.messageText = "Which AI agent should Polycarp open?"
        alert.informativeText = (resolved.gone == nil ? "" : resolved.said + " ") + "It opens now and from then on. Change it in Settings › Default apps. Agents can cost money under your own plan with them."
        let pick = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 260, height: 26))
        for c in resolved.candidates {
            pick.addItem(withTitle: c.name)
            pick.lastItem?.image = RoleIcon.image(c, size: 16)
        }
        pick.setAccessibilityLabel("AI agent")
        alert.accessoryView = pick
        alert.addButton(withTitle: "Choose and Open")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn, resolved.candidates.indices.contains(pick.indexOfSelectedItem) else { return }
        DefaultAppsStore.shared.choose(r.role, resolved.candidates[pick.indexOfSelectedItem].app) { problem in
            if let problem { return fail("Not saved: \(problem)") }
            // Saved, so the store answers with it now; were it not, this would ask again rather than open another.
            open(r)
        }
    }
}

/// The picture for a candidate: the app's own, or a terminal for a program.
enum RoleIcon {
    static func image(_ c: DefaultCandidate, size: CGFloat) -> NSImage? {
        let image: NSImage?
        switch c.app {
        case .app(let b):
            image = NSWorkspace.shared.urlForApplication(withBundleIdentifier: b).map { NSWorkspace.shared.icon(forFile: $0.path) }
        case .command:
            image = NSImage(systemSymbolName: "terminal", accessibilityDescription: nil)
        }
        image?.size = NSSize(width: size, height: size)
        return image
    }
}
