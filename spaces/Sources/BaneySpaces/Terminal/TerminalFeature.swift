import AppKit
import BaneySpacesCore
import Carbon.HIToolbox

/// The built-in terminal's one door for the rest of the app: the socket (`polycarp-spaces term`), the launcher's rows
/// and the quick terminal's key. In a build without libghostty (universal and Intel builds, a Mac without the Metal
/// Toolchain) it compiles to a stub that answers `TerminalBuild.notBuilt`. docs/terminal.md.
enum TerminalFeature {
    #if POLYCARP_TERMINAL
    static let built = true
    #else
    static let built = false
    #endif

    /// `polycarp-spaces term`, on the main thread (the socket server hops there).
    static func open(_ r: Wire.Request) -> Wire.Reply {
        guard let launch = TerminalLaunch(request: r) else {
            return .init(ok: false, error: "not a terminal request. \(TerminalLaunch.usage)")
        }
        switch openNow(launch) {
        case .success(let info): return .init(ok: true, info: info)
        case .failure(let e): return .init(ok: false, error: e.description)
        }
    }

    /// A launcher row: a problem shows as a toast.
    static func open(_ launch: TerminalLaunch) {
        if case .failure(let e) = openNow(launch) { Toast.show(e.description, symbol: "terminal") }
    }

    /// ⌃` toggles the quick terminal from any app. Registered after Polycarp has started (`registerShortcuts`), only
    /// in a build with the terminal, and only while Settings > Launcher's switch is on, so the key can be left to other
    /// apps (VS Code's terminal, for one).
    static func registerQuickKey(_ hotkeys: Hotkeys) {
        #if POLYCARP_TERMINAL
        guard quickKeyOn else { return }
        hotkeys.register(keyCode: kVK_ANSI_Grave, modifiers: controlKey) { TerminalWindows.shared.toggleQuick() }
        #endif
    }

    /// Settings > Launcher's "⌃` opens the quick terminal". On unless turned off.
    static var quickKeyOn: Bool {
        get { UserDefaults.standard.object(forKey: "terminalQuickKey") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "terminalQuickKey") }
    }

    /// Terminal windows whose program would end if Polycarp quit now.
    static func busyCount() -> Int {
        #if POLYCARP_TERMINAL
        guard let r = GhosttyRuntime.shared else { return 0 }
        // Ghostty's app-wide rule first; the count only words the question.
        return r.needsConfirmQuit ? max(1, TerminalWindows.shared.busyCount) : 0
        #else
        return 0
        #endif
    }

    /// `applicationShouldTerminate`: the terminals' programs end with Polycarp, so a quit asks while any runs. An
    /// install's own quit (`InstallHandoff`) doesn't ask again: its update asked before it started, or refused.
    static func shouldTerminate() -> NSApplication.TerminateReply {
        let marked = (UserDefaults.standard.object(forKey: InstallHandoff.key) as? NSNumber)?.doubleValue
        let forInstall = InstallHandoff.isCurrent(markedAt: marked, now: Date().timeIntervalSince1970)
        guard let question = TerminalQuit.question(busy: busyCount(), forInstall: forInstall) else { return .terminateNow }
        let a = NSAlert()
        a.messageText = question
        a.informativeText = TerminalQuit.detail
        a.addButton(withTitle: "Quit")
        a.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        // Not inside any libghostty callback: a quit comes from the menu, a signal or an Apple event.
        return a.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }

    private static func openNow(_ launch: TerminalLaunch) -> Result<[String: String], TerminalLaunchError> {
        #if POLYCARP_TERMINAL
        return TerminalWindows.shared.open(launch)
        #else
        sayNotBuiltOnce()
        return .failure(.init(TerminalBuild.notBuilt))
        #endif
    }

    #if !POLYCARP_TERMINAL
    private static var saidNotBuilt = false
    /// trace.log gets the line once a run, however often it is asked.
    private static func sayNotBuiltOnce() {
        guard !saidNotBuilt else { return }
        saidNotBuilt = true
        Trace.log(TerminalBuild.notBuilt)
    }
    #endif
}
