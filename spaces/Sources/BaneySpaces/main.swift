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

// A one-shot with what it needs missing exits here with a usage error. It never falls through to start the app.
if let problem = EntryPoint.usageError(arguments: CommandLine.arguments) {
    FileHandle.standardError.write(Data((problem + "\n").utf8))
    exit(EntryPoint.usageExit)
}

// Opened from the disk image, Downloads or a temporary read-only place: offer to move to Applications first, before
// anything is touched. This ends the process unless the copy is already installed (or this is a one-shot).
MoveToApplicationsRunner.runIfNeeded(home: FileManager.default.homeDirectoryForCurrentUser)

// Only one copy runs, however it was started (see `SingleInstance`). BaneySpaces, if it is running, is dealt
// with first and in the open: one alert, before any file is touched. Among Polycarp copies the lock decides:
// a second one hands over to the running copy and exits here, silently, before it touches anything the first
// one owns. The lock is held for this process's life; it is kept in a global so it is never released early.
let instanceLock: SingleInstance.Lock? = {
    guard EntryPoint.needsExclusiveCopy(arguments: CommandLine.arguments) else { return nil }
    let home = FileManager.default.homeDirectoryForCurrentUser
    let oneShot = !Set(CommandLine.arguments).isDisjoint(with: crashLoopOneShots)
    // Every app Polycarp replaces that is running now (BaneySpaces, Silas): one alert for all of them.
    let allLegacy = LegacyHandover.replacedBundleIDs.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0) }
    // Silas is in the alert only when Polycarp's dictation takes over right now, by the one gate the engine and the watcher
    // use (`VoiceGate.takesOverNow`: voice on, a finished model of its own, the import really finished). Otherwise Silas is
    // the working dictation and is left alone; once the import has run, the app asks it to quit if the gate then says so.
    let voiceTakesOver = VoiceGate.takesOverNow(userEnabled: VoiceGate.userEnabled(.standard),
        voiceDir: Product.voiceDir(home: home), silasDir: Product.silasSupportDir(home: home))
    let running = LegacyHandover.namesToReplace(running: allLegacy.compactMap(\.bundleIdentifier), takesOver: voiceTakesOver)
    let legacy = allLegacy.filter { $0.bundleIdentifier != Product.Silas.bundleID || voiceTakesOver }
    if LegacyHandover.applies(oneShot: oneShot, legacyPids: legacy.map(\.processIdentifier)) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        let outcome = LegacyHandover.run(
            ask: {
                NSApp.activate(ignoringOtherApps: true)
                let alert = NSAlert()
                alert.messageText = LegacyHandover.alertTitle(running: running)
                alert.informativeText = LegacyHandover.alertDetail(running: running)
                alert.addButton(withTitle: LegacyHandover.continueButton(running: running))
                alert.addButton(withTitle: LegacyHandover.notNowButton)
                return alert.runModal() == .alertFirstButtonReturn ? .quitAndContinue : .notNow
            },
            quit: { legacy.forEach { $0.terminate() } },
            // Asks the system each time: NSRunningApplication's own state only updates as the run loop turns, and
            // this runs before there is one.
            isRunning: { legacy.contains { kill($0.processIdentifier, 0) == 0 } },
            names: running)
        if case .exit(let message) = outcome {
            if let message {
                let alert = NSAlert()
                alert.messageText = message
                alert.runModal()
            }
            exit(0)
        }
    }
    switch SingleInstance.claim(lockURL: Product.supportDir(home: home).appendingPathComponent(Product.lockName)) {
    case .mine(let lock):
        return lock
    case .yield(let pid):
        if let pid, let other = NSRunningApplication(processIdentifier: pid) { other.activate(options: []) }
        // A one-shot that could not run says so (uninstall.sh reads the status); a second launch is not an error.
        exit(oneShot ? 75 : 0)
    }
}()

// First launch after BaneySpaces: copy its settings over (copy only, once). Before anything reads a setting.
if instanceLock != nil {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let result = SettingsImport.run(legacyDir: Product.legacySupportDir(home: home), newDir: Product.supportDir(home: home),
                                    legacyDefaults: UserDefaults(suiteName: Product.Legacy.bundleID) ?? .standard,
                                    legacyDomain: Product.Legacy.bundleID, newDefaults: .standard)
    // Not finished: the failed names are tried again at the next launch, and Settings says so (LegacyApp).
    if case .partial(let report) = result { NSLog("Polycarp: could not import %@ yet", report.failedFiles.joined(separator: ", ")) }
    // And Silas's dictation data and models, the same way (copy only; Silas's folder is never written).
    if case .partial(let report) = VoiceImport.run(silasDir: Product.silasSupportDir(home: home), newDir: Product.voiceDir(home: home)) {
        NSLog("Polycarp: could not import %@ from Silas yet", report.failed.joined(separator: ", "))
    }
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
