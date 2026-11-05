import AppKit
import BaneySpacesCore

// One-shots the delegate answers and exits on don't count as a launch. `--setup` and a plain
// start do (`CrashLoopGuard`): any other `--` flag used to skip the guard and leave a crash loop
// uncounted.
let crashLoopOneShots: Set<String> = [
    "--restore-shortcuts", "--restore-dock", "--check-settings", "--unregister-login",
]

// First, before AppKit, sockets, files, the Dock, hotkeys or settings: `--version` and `--help`
// print and exit. Starting the app with `--version` used to start a whole second copy.
if let answer = EntryPoint.immediate(arguments: CommandLine.arguments, info: Bundle.main.infoDictionary) {
    print(answer.text)
    exit(answer.code)
}

// Only one copy runs, however it was started (see `SingleInstance`). A second one hands over to the
// running copy and exits here, before it touches anything the first one owns. The lock is held for
// this process's life; it is kept in a global so it is never released early.
let instanceLock: SingleInstance.Lock? = {
    guard EntryPoint.needsExclusiveCopy(arguments: CommandLine.arguments) else { return nil }
    let home = FileManager.default.homeDirectoryForCurrentUser
    let running = [Product.bundleID, Product.Legacy.bundleID].flatMap {
        NSRunningApplication.runningApplications(withBundleIdentifier: $0).map(\.processIdentifier)
    }
    switch SingleInstance.claim(runningPids: running,
                                lockURL: Product.supportDir(home: home).appendingPathComponent(Product.lockName)) {
    case .mine(let lock):
        return lock
    case .yield(let pid):
        if let pid, let other = NSRunningApplication(processIdentifier: pid) { other.activate(options: []) }
        // A one-shot that could not run says so (uninstall.sh reads the status); a second launch is not an error.
        exit(Set(CommandLine.arguments).isDisjoint(with: crashLoopOneShots) ? 0 : 75)
    }
}()

// First launch after BaneySpaces: copy its settings over (copy only, once). Before anything reads a setting.
if instanceLock != nil {
    let home = FileManager.default.homeDirectoryForCurrentUser
    SettingsImport.run(legacyDir: Product.legacySupportDir(home: home), newDir: Product.supportDir(home: home),
                       legacyDefaults: UserDefaults(suiteName: Product.Legacy.bundleID) ?? .standard,
                       legacyDomain: Product.Legacy.bundleID, newDefaults: .standard)
}

// `Polycarp --render <folder>` draws product images with sample windows, then exits.
if let i = CommandLine.arguments.firstIndex(of: "--render"), i + 1 < CommandLine.arguments.count {
    _ = NSApplication.shared
    CrashLoop.checkRender()
    let code = MainActor.assumeIsolated { Render.run(into: URL(fileURLWithPath: CommandLine.arguments[i + 1])) }
    CrashLoop.renderEnded()
    exit(code)
}

// `Polycarp --bangs …` manages the launcher's custom bangs from a terminal or an agent, then exits.
if let i = CommandLine.arguments.firstIndex(of: "--bangs") {
    exit(Launcher.commandLine(Array(CommandLine.arguments[(i + 1)...])))
}

if Set(CommandLine.arguments).isDisjoint(with: crashLoopOneShots) { CrashLoop.checkLaunch() }

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
