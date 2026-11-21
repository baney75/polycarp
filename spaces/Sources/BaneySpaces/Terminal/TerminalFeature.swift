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

    /// ⌃` toggles the quick terminal from any app. Not registered without the terminal, so the key keeps its meaning
    /// in other apps (VS Code's terminal, for one).
    static func registerQuickKey(_ hotkeys: Hotkeys) {
        #if POLYCARP_TERMINAL
        hotkeys.register(keyCode: kVK_ANSI_Grave, modifiers: controlKey) { TerminalWindows.shared.toggleQuick() }
        #endif
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
