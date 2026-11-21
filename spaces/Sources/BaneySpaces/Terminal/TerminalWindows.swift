#if POLYCARP_TERMINAL
import AppKit
import BaneySpacesCore
import CGhostty

/// The built-in terminal's windows: ordinary ones (`polycarp-spaces term`, the launcher) and the quick terminal, which
/// drops down from the top edge of the screen the pointer is on (⌃`), like Ghostty's own, and goes back up when it
/// loses focus. Its surface lives on while hidden, so the next drop is instant. Known limit (phase 1): Polycarp's
/// workspaces place other apps' windows, not its own, so a terminal window shows on every workspace.
final class TerminalWindows: NSObject, NSWindowDelegate {
    static let shared = TerminalWindows()

    private var windows: [NSWindow] = []
    private var quick: QuickTerminalPanel?
    private var quickShown = false
    /// The app that was in front before the quick terminal came down, given back when it goes up.
    private var quickReturnTo: NSRunningApplication?

    /// Opens what was asked, on the main thread. The reply's `info` says what opened and how long it took.
    func open(_ launch: TerminalLaunch) -> Result<[String: String], TerminalLaunchError> {
        precondition(Thread.isMainThread)
        let t0 = DispatchTime.now().uptimeNanoseconds
        let runtime: GhosttyRuntime
        switch GhosttyRuntime.get() {
        case .failure(let e): return .failure(e)
        case .success(let r): runtime = r
        }
        let env = ProcessInfo.processInfo.environment
        let line = launch.commandLine(shell: TerminalLaunch.loginShell(env: env), tailscale: Self.tailscale())
        let kind: String
        if launch.quick {
            showQuick(runtime, commandLine: line)
            kind = "quick"
        } else {
            openWindow(runtime, launch: launch, commandLine: line)
            kind = "window"
        }
        let ms = (DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000
        // Kind and timing only: never the command or the host, which can say what someone is working on.
        Trace.log("term: opened \(kind) (\(launch.host != nil ? "host" : launch.command != nil ? "command" : launch.preset.rawValue)) in \(ms) ms")
        return .success(["opened": kind, "title": launch.title, "ms": String(ms)])
    }

    /// The Tailscale command: on PATH as Homebrew and the standalone app put it, or inside the Mac App Store app.
    static func tailscale() -> String? {
        let candidates = ["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale",
                          "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    // MARK: Windows

    private func openWindow(_ runtime: GhosttyRuntime, launch: TerminalLaunch, commandLine: String?) {
        let view = TerminalSurfaceView(app: runtime.app, commandLine: commandLine,
                                       workingDirectory: FileManager.default.homeDirectoryForCurrentUser.path)
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 520),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.title = launch.title
        w.contentView = view
        w.delegate = self
        w.tabbingMode = .disallowed
        if let last = windows.last { w.setFrameTopLeftPoint(w.cascadeTopLeft(from: NSPoint(x: last.frame.minX, y: last.frame.maxY))) } else { w.center() }
        view.onTitle = { [weak w] t in w?.title = t }
        view.onClose = { [weak w] in w?.close() }
        windows.append(w)
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
        w.makeFirstResponder(view)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let view = sender.contentView as? TerminalSurfaceView, view.needsConfirmClose else { return true }
        return GhosttyRuntime.ask("Close this terminal?", detail: "A program in it is still running.", allow: "Close")
    }

    func windowWillClose(_ n: Notification) {
        guard let w = n.object as? NSWindow, let view = w.contentView as? TerminalSurfaceView else { return }
        view.free()
        windows.removeAll { $0 === w }
        if w === quick {
            quick = nil
            quickShown = false
        }
    }

    // MARK: Quick terminal

    func toggleQuick() {
        if quickShown { hideQuick() } else if case .success(let r) = GhosttyRuntime.get() { showQuick(r, commandLine: nil) }
    }

    /// Drops the quick terminal down. A command is used only when the panel is made; an open one is shown as it is.
    private func showQuick(_ runtime: GhosttyRuntime, commandLine: String?) {
        let panel = quick ?? makeQuick(runtime, commandLine: commandLine)
        quick = panel
        guard !quickShown else { panel.makeKeyAndOrderFront(nil); return }
        quickShown = true
        let front = NSWorkspace.shared.frontmostApplication
        quickReturnTo = front?.processIdentifier == getpid() ? nil : front
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
        let (up, down) = QuickTerminalPanel.frames(on: screen)
        panel.setFrame(up, display: false)
        (panel.contentView as? TerminalSurfaceView)?.setVisible(true)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(panel.contentView)
        animate(panel, to: down) {}
    }

    func hideQuick() {
        guard let panel = quick, quickShown else { return }
        quickShown = false
        let screen = panel.screen ?? NSScreen.main ?? NSScreen.screens[0]
        animate(panel, to: QuickTerminalPanel.frames(on: screen).up) { [weak self] in
            guard let self, !self.quickShown else { return }
            panel.orderOut(nil)
            (panel.contentView as? TerminalSurfaceView)?.setVisible(false)
            // Back to what you were doing, unless you went to another app on the way.
            if let app = self.quickReturnTo, NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() {
                app.activate(options: [])
            }
            self.quickReturnTo = nil
        }
    }

    private func makeQuick(_ runtime: GhosttyRuntime, commandLine: String?) -> QuickTerminalPanel {
        let view = TerminalSurfaceView(app: runtime.app, commandLine: commandLine,
                                       workingDirectory: FileManager.default.homeDirectoryForCurrentUser.path)
        let panel = QuickTerminalPanel(contentRect: NSRect(x: 0, y: 0, width: 800, height: 400),
                                       styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        panel.contentView = view
        panel.delegate = self
        view.onTitle = { _ in }
        view.onClose = { [weak panel] in panel?.close() }
        panel.onResignKey = { [weak self] in self?.hideQuick() }
        return panel
    }

    /// The theme's motion: its normal duration, none under Reduce Motion or a still theme.
    private func animate(_ panel: NSWindow, to frame: NSRect, done: @escaping () -> Void) {
        let ms = Appearance.shared.look.spec.motion.inMs
        let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion || ms <= 0
        guard !still else { panel.setFrame(frame, display: true); done(); return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = ms / 1000
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().setFrame(frame, display: true)
        }, completionHandler: done)
    }
}

/// The quick terminal's panel: borderless, above other windows, on every Space, and able to take keys without
/// activating anything else.
final class QuickTerminalPanel: NSPanel {
    var onResignKey: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: styleMask, backing: backing, defer: flag)
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        hasShadow = true
        isMovable = false
    }

    override func resignKey() {
        super.resignKey()
        onResignKey?()
    }

    /// Hidden just above the screen's top edge, and dropped down: the full width of the visible area, 40% of its
    /// height, under the menu bar.
    static func frames(on screen: NSScreen) -> (up: NSRect, down: NSRect) {
        let v = screen.visibleFrame
        let h = (v.height * 0.4).rounded()
        let down = NSRect(x: v.minX, y: v.maxY - h, width: v.width, height: h)
        let up = NSRect(x: v.minX, y: screen.frame.maxY, width: v.width, height: h)
        return (up, down)
    }
}
#endif
