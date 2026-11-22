import AppKit
import ApplicationServices
import BaneySpacesCore
import Carbon.HIToolbox
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let spaces = Spaces()
    /// Terminal splits, browser tabs and agents for the launcher and the dock's badges, plus the `baneyspaces` command.
    private let session = SessionController()
    private let hotkeys = Hotkeys()
    private let updater = Updater()
    private var statusItem: NSStatusItem!
    private var started = false { didSet { MissionControlKeys.appStarted = started } }
    private var trustTimer: Timer?
    /// While running, checks every 2 s that macOS still trusts BaneySpaces.
    private var watchdog: Timer?
    private var signalSources: [DispatchSourceSignal] = []
    private lazy var viewer = ViewerController(spaces: spaces)
    /// The top bar (`bar.*` in surfaces.json); draws nothing until `bar.enabled`.
    private lazy var topBar = TopBar(spaces: spaces)
    private lazy var dock: WorkspaceDock = {
        let d = WorkspaceDock(spaces: spaces)
        d.onShowOverview = { [weak self] in self?.viewer.open() }
        d.onShowLauncher = { [weak self] in self?.launcher.show() }
        d.onSetEdge = { [weak self] e in self?.setDockEdge(e) }
        d.onTurnOff = { [weak self] in self?.setWorkspaceDock(false) }
        d.onSetAgentStatus = { [weak self] on in self?.setDockAgentStatus(on) }
        d.notMenus = { [weak self] in self?.switcher.windowNumber.map { [$0] } ?? [] }
        d.model.agents = { [weak self] in
            guard let self, self.session.started else { return [] }
            return self.session.dockAgents()
        }
        d.model.onFocusAgent = { [weak self] a, n in
            guard let self, !self.session.focusAgent(a.id) else { return }
            if a.window != 0 { self.spaces.focus(a.window, on: n) } else { self.spaces.switchTo(n, announce: false) }
        }
        return d
    }()
    private lazy var switcher = WorkspaceSwitcher(spaces: spaces)
    /// Carried windows let go over a workspace, each waiting for its drop to settle. Picking
    /// one up again bumps its generation, so its stale move never runs, even one queued.
    private var settling: [WindowID: Timer] = [:]
    private var dropGeneration: [WindowID: Int] = [:]
    /// Windows waiting to hold still after a drag before `correctAfterDrag` looks at them, and the timer looking at each.
    private var pendingSettles = PendingSettles()
    private var settleTimers: [WindowID: Timer] = [:]

    /// Waits for the window server, the app and any tile animation to finish the drop, then lets Spaces correct a blind
    /// drop or an unreachable title bar. `DragRelease.settleWatch` sets how long and what ends the wait early;
    /// `PendingSettles` cancels it when the window is pressed or dragged again, or any button goes down. A window dropped
    /// on a workspace is the drop's.
    private func correctOnceStill(_ id: WindowID, after end: DragEnd) {
        guard !end.dropped else { return }
        cancelCorrection(id)
        let watch = DragRelease.settleWatch(from: TopDragWatcher.bounds(of: id), after: end, displays: Spaces.dragDisplays())
        if watch.leaveIfMoved {
            Trace.log("drag end window=\(id) let go blind at a side edge: waits \(watch.stillLooks * 20) ms still, left alone if it moves")
        }
        pendingSettles.start(id, watch: watch, end: end)
        settleTimers[id] = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] timer in
            guard let self, self.settleTimers[id] === timer else { return timer.invalidate() }
            let outcome = self.pendingSettles.look(id, frame: TopDragWatcher.bounds(of: id), buttonDown: NSEvent.pressedMouseButtons != 0)
            switch outcome {
            case .wait: return
            case let .correct(end): self.spaces.correctAfterDrag(id, end: end)
            case let .leftAlone(why): if end.coveredFrom != nil { Trace.log("drag end window=\(id) \(why); left alone") }
            case .none: break
            }
            timer.invalidate()
            self.settleTimers[id] = nil
        }
    }

    /// Cancels the correction waiting for window `id`: it was pressed or dragged again.
    private func cancelCorrection(_ id: WindowID) {
        pendingSettles.cancel(id)
        settleTimers.removeValue(forKey: id)?.invalidate()
    }

    /// Cancels the drop waiting for window `id`, or every one.
    private func cancelSettling(_ id: WindowID? = nil) {
        for w in id.map({ [$0] }) ?? Array(Set(settling.keys).union(dropGeneration.keys)) {
            dropGeneration[w, default: 0] += 1
            if let timer = settling.removeValue(forKey: w) {
                if timer.isValid { Trace.log("drop cancelled window=\(w)") }
                timer.invalidate()
            }
        }
    }
    /// A window dragged to the top of the screen opens the overview, in place of Mission Control.
    private lazy var topDrag: TopDragWatcher = {
        let t = TopDragWatcher()
        t.onDragStart = { [weak self] id, p in
            self?.cancelCorrection(id)
            self?.spaces.unfillForDrag(id, at: p)
        }
        t.onOpen = { [weak self] grab, p in
            guard let self, self.started else { return false }
            if self.spaces.switching { return nil }
            return self.viewer.openCarrying(grab.window, at: p)
        }
        t.onMove = { [weak self] p in self?.viewer.carryMoved(to: p) }
        // Picking the window up again makes its drop still waiting to settle stale, even one
        // already queued behind a switch. A click anywhere else leaves the drop alone.
        t.onPress = { [weak self] id in
            guard let self, let id else { return }
            self.cancelSettling(id)
            self.cancelCorrection(id)
        }
        t.overviewCovers = { [weak self] p in self?.viewer.carryCovers(p) ?? false }
        t.onRelease = { [weak self] grab, p in
            guard let self, let n = self.viewer.endCarrying(at: p), p != nil else { return false }
            self.dropCarried(grab, on: n)
            return true
        }
        // The same drag taken down to the Workspace Dock: let go on a tile, it goes there.
        t.onCarry = { [weak self] grab, _ in
            guard let self, self.started else { return }
            self.dock.carryMoved(grab)
        }
        t.onCarryEnd = { [weak self] grab, p in
            guard let self, let n = self.dock.endCarry(grab, at: p), p != nil else { return false }
            self.dropCarried(grab, on: n)
            return true
        }
        // A drag the overview covered and that dropped nowhere goes back where it was; any other is the person's own.
        t.onDragEnd = { [weak self] id, end in self?.correctOnceStill(id, after: end) }
        t.onLetGo = { id in DragFrameTrace.released(id) }
        return t
    }()

    /// A window dragged by its title bar and let go over workspace `n` in the overview or the
    /// dock. The window server and the app finish their own drop first: the window moves once
    /// it has held still for 60 ms (four looks 20 ms apart), no sooner than 0.1 s after the
    /// release and no later than 0.5 s.
    private func dropCarried(_ grab: TopDrag.Grab, on n: Int) {
        let id = grab.window
        cancelSettling(id)
        let gen = dropGeneration[id, default: 0]
        var last = TopDragWatcher.bounds(of: id)
        var looks = 0, still = 0
        let began = ProcessInfo.processInfo.systemUptime
        Trace.log("drop settling window=\(id) to=\(n)")
        settling[id] = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] timer in
            looks += 1
            let now = TopDragWatcher.bounds(of: id)
            still = now == last ? still + 1 : 0
            last = now
            let heldStill = looks >= 5 && still >= 3
            guard heldStill || looks >= 25 else { return }
            timer.invalidate()
            let ms = Int((ProcessInfo.processInfo.systemUptime - began) * 1000)
            guard let self, now != nil, self.dropGeneration[id, default: 0] == gen else {
                let why = self.map { "stale=\($0.dropGeneration[id, default: 0] != gen)" } ?? "self=nil"
                Trace.log("drop dropped window=\(id) after \(ms) ms looks=\(looks) gone=\(now == nil) \(why)")
                return
            }
            // Ended still, or gave up waiting for it to be (the move runs either way).
            if heldStill {
                Trace.log("drop settled window=\(id) after \(ms) ms looks=\(looks) still=\(still) settled=true")
            } else {
                Trace.log("drop gave up waiting window=\(id) after \(ms) ms looks=\(looks) still=\(still) settled=false")
            }
            self.settling[id] = nil
            self.spaces.moveCarried(id, to: n, from: grab.frame) { [weak self] in self?.dropGeneration[id, default: 0] == gen }
        }
    }
    /// The launcher is built just after launch (its app scan runs off the main thread), so the first open finds the apps.
    private var launcherBuilt = false
    /// The focused terminal's folder when the launcher opened, for New Terminal.
    private var terminalFolder: String?
    private lazy var launcher: LauncherController = {
        launcherBuilt = true
        var a = LauncherActions()
        a.focusApp = { [weak self] pid, n in self?.spaces.focusApp(pid, on: n) }
        a.openWindowHere = { [weak self] pid, orElse in
            guard let self, self.started else { return orElse() }
            self.spaces.openWindowHere(pid, orElse: orElse)
        }
        a.canOpenWindow = { pid, done in
            // Reading an app's menus waits on the app, so it never runs on the main thread.
            Spaces.axQueue.async {
                let yes = Windows.newWindowItem(pid) != nil
                DispatchQueue.main.async { done(yes) }
            }
        }
        a.current = { [weak self] in self?.spaces.model.current ?? 1 }
        a.switchTo = { [weak self] n in self?.run { $0.switchTo(n) } }
        a.appsOn = { [weak self] n in self?.spaces.apps(on: n) ?? [] }
        a.workspacesByApp = { [weak self] in
            guard let self, self.started else { return [:] }
            self.spaces.refresh()
            var out: [String: [Int]] = [:]
            for n in Workspaces.range {
                for e in self.spaces.entries(on: n) {
                    guard let path = NSRunningApplication(processIdentifier: e.pid)?.bundleURL?.path else { continue }
                    if out[path]?.contains(n) != true { out[path, default: []].append(n) }
                }
            }
            return out
        }
        a.showOverview = { [weak self] in self?.viewer.open() }
        a.sessionItems = { [weak self] q in self?.session.launcherItems(q) ?? [] }
        a.willShow = { [weak self] in
            guard let self else { return }
            // New Terminal opens where you were working, read before the launcher takes focus.
            // Only a terminal in front says where you were working; a focused row in another app doesn't.
            let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            self.terminalFolder = Item.workingFolder(self.session.engine.items, front: front)
            self.session.engine.refreshAll()
        }
        a.newClaude = { [weak self] in self?.session.newClaude(in: self?.terminalFolder) }
        a.newTerminal = { [weak self] in self?.session.engine.newTerminal(in: self?.terminalFolder) }
        Terminals.ghostty = { [weak self] dir, script, orElse in
            guard let self else { return orElse() }
            self.session.engine.runInGhostty(in: dir, script: script, orElse: orElse)
        }
        a.bringBack = { [weak self] in self?.bringBack() }
        a.toggleDock = { [weak self] in self?.toggleWorkspaceDock() }
        a.dockOn = { WorkspaceDock.enabled }
        a.checkForUpdates = { [weak self] in self?.checkForUpdates() }
        a.showSetup = { [weak self] in self?.showSetup() }
        return LauncherController(actions: a)
    }()
    private var missionControlTicks = 0
    private lazy var hotCorners: HotCornerWatcher = {
        let w = HotCornerWatcher()
        w.onOpen = { [weak self] in
            guard let self, self.started, !self.viewer.isOpen else { return }
            self.viewer.open()
        }
        return w
    }()
    private lazy var missionControlKeys: MissionControlKeys = {
        let keys = MissionControlKeys { [weak self] in self?.viewer.toggle() }
        keys.onCmdTab = { [weak self] forward, isRepeat, time in
            guard let self, self.started, !self.viewer.isOpen else {
                Trace.log("cmdTab ignored started=\(self?.started ?? false) viewerOpen=\(self?.viewer.isOpen ?? false)")
                MissionControlKeys.inGesture = false
                return
            }
            // Titles change with every tab: read them again in the background, ready for the window bar the hold opens.
            if !isRepeat { self.spaces.refreshDetails() }
            self.switcher.step(forward: forward, isRepeat: isRepeat, at: time)
        }
        keys.onTabUp = { [weak self] in self?.switcher.tabReleased() }
        keys.onCmdReleased = { [weak self] in self?.switcher.commit() }
        keys.onCancel = { [weak self] in self?.switcher.cancel() }
        keys.onArrow = { [weak self] forward in self?.switcher.arrow(forward: forward) }
        return keys
    }()
    /// Whether the Settings window was built yet: its first open pays for that, timed apart (`showSettings`).
    private var setupBuilt = false
    private lazy var setup: SetupWindowController = {
        setupBuilt = true
        let c = SetupWindowController()
        c.model.onModifierChange = { [weak self] _ in self?.registerShortcuts() }
        c.model.onQuickTerminalKeyChange = { [weak self] _ in self?.registerShortcuts() }
        c.model.onUninstall = { [weak self] in self?.uninstall() }
        c.model.onBringBack = { [weak self] in self?.bringBack() }
        c.model.onAbout = { [weak self] in self?.about() }
        c.model.isStarted = { [weak self] in self?.started ?? false }
        c.model.parkedApps = { [weak self] in self?.parkedRows() ?? [] }
        c.model.onToggleParked = { [weak self] id in self?.toggleParked(id) }
        c.model.updateInfo = { [weak self] in self?.updateInfo() ?? .init() }
        c.model.onCheckForUpdates = { [weak self] in self?.checkForUpdates() }
        c.model.onOfferUpdate = { [weak self] in if let r = self?.updater.available { self?.updater.offer(r) } }
        c.model.onSetUpdateChannel = { [weak self] in self?.updater.channel = $0 }
        c.model.onSetCheckDaily = { [weak self] in self?.updater.checksAutomatically = $0 }
        c.model.finishedRows = { [weak self] in
            guard let self, self.session.started else { return [] }
            return self.session.finishedRows().map { .init(id: $0.id, label: $0.label) }
        }
        c.model.onFocusFinished = { [weak self] id in self?.session.focusFinished(id) }
        c.model.viewerKeysActive = { [weak self] in self?.missionControlKeys.isActive ?? false }
        c.model.missionControlProblem = { SystemMissionControl.problem }
        c.model.onViewerKeysChange = { [weak self] on in
            MissionControlKeys.enabled = on
            guard let self else { return }
            if self.started { self.restartKeyWatcher() }
            self.syncMissionControl()
        }
        c.model.onWorkspaceDockChange = { [weak self] on in self?.setWorkspaceDock(on) }
        c.model.onTopDragChange = { [weak self] on in self?.setTopDrag(on) }
        c.model.onDockEdgeChange = { [weak self] e in self?.setDockEdge(e) }
        c.model.onDockAgentStatusChange = { [weak self] on in self?.setDockAgentStatus(on) }
        // Every event, not just any: an older install lacks StopFailure, which the red badge needs.
        c.model.hooksInstalled = {
            guard let d = FileManager.default.contents(atPath: NSHomeDirectory() + "/.claude/settings.json") else { return .noClaudeCode }
            guard let settings = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return .unreadable }
            return HookSettings.installed(settings).count == HookSettings.events.count ? .on : .off
        }
        c.model.onInstallHooks = { [weak self] in self?.session.installHooks() }
        c.model.onLauncherChange = { [weak self] on in self?.setLauncherOnCmdSpace(on) }
        c.model.onCmdTabChange = { [weak self] mode in
            MissionControlKeys.cmdTabMode = mode
            guard let self, self.started else { return }
            self.restartKeyWatcher()
        }
        return c
    }()

    private var mcBackAtDock = 0

    /// While Mission Control is held off: the person may have turned it back on (the README's
    /// `defaults delete`, a profile), and the launch agent may have been switched off (the
    /// Background Item notice). Neither may leave BaneySpaces answering beside macOS's view, or
    /// holding it off with no way back.
    private func checkMissionControlHeld() {
        // The key watcher can stop while Accessibility is still granted; then nothing answers the key.
        guard missionControlKeys.isActive else {
            Trace.log("mission control: the key watcher stopped; giving Mission Control back")
            return syncMissionControl()
        }
        if SystemMissionControl.isOffAtDock {
            mcBackAtDock = 0
        } else {
            // Twice in a row, so one unlucky read of the Dock's settings doesn't undo it.
            mcBackAtDock += 1
            if mcBackAtDock >= 2 {
                mcBackAtDock = 0
                Trace.log("mission control: turned back on at the Dock; Polycarp's overview switched off")
                return setup.model.setViewerKeys(false)
            }
        }
        guard missionControlTicks % 15 == 0 else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard !SystemMissionControl.isArmed else { return }
            DispatchQueue.main.async {
                Trace.log("mission control: the launch agent is no longer loaded")
                self?.syncMissionControl()
            }
        }
    }

    /// The key watcher reads its settings when it starts, so a change restarts it.
    private func restartKeyWatcher() {
        missionControlKeys.stop()
        missionControlKeys.start()
    }

    /// macOS's Mission Control is off while BaneySpaces' overview answers its keys, and its hot
    /// corners; switched off, without Accessibility, or while macOS won't let the
    /// key watcher run (nothing would answer the key), all of it goes back.
    private func syncMissionControl() {
        guard missionControlWanted else { return giveMissionControlBack() }
        // The launch agent is set up off the main thread; one attempt at a time.
        guard !armingMissionControl else { return }
        armingMissionControl = true
        SystemMissionControl.takeOver(stillWanted: { [weak self] in self?.missionControlWanted ?? false }) { [weak self] taken in
            guard let self else { return }
            self.armingMissionControl = false
            guard taken else { return self.giveMissionControlBack() }
            self.hotCorners.set(corners: SystemMissionControl.answeredCorners())
        }
    }

    private var armingMissionControl = false

    /// Accessibility granted, the switch on, and the key watcher running: something answers the keys.
    private var missionControlWanted: Bool { started && MissionControlKeys.enabled && missionControlKeys.isActive }

    /// Not wanted, or not safe: without the launch agent that puts it back, Mission Control stays
    /// on (and the corners stay quiet, since it would open beside the overview).
    private func giveMissionControlBack() {
        let why = missionControlWanted ? SystemMissionControl.problem : nil
        hotCorners.stop()
        // The agent goes with the switch, and only then; Accessibility lost or a quit leaves it loaded.
        SystemMissionControl.restore(keeping: why, removeAgent: !MissionControlKeys.enabled)
    }

    /// An app dragged out of the disk image never ran the installer's other steps: AeroSpace stepping
    /// aside, the `baneyspaces` command in ~/.local/bin, Ghostdeck going to the Trash. The first
    /// launch from Applications does them, once: the bundled install-app.sh with --in-place, run
    /// off the main thread. It runs only when the command is missing or points somewhere else, and
    /// only from an Applications folder (never from the disk image or a build folder).
    private func linkCommandIfNeeded() {
        let bundle = Bundle.main.bundleURL.path
        let home = NSHomeDirectory()
        let link = "\(home)/.local/bin/\(Product.commandName)"
        guard FirstLaunch.shouldRunInstallStep(bundle: Bundle.main.bundleURL, home: URL(fileURLWithPath: home),
                                               commandLinkTarget: try? FileManager.default.destinationOfSymbolicLink(atPath: link)),
              let script = Bundle.main.url(forResource: "install-app", withExtension: "sh") else { return }
        // A copy dragged to Applications still carries the download mark on every file, including the tools this step starts.
        MoveToApplications.clearDownloadMark(at: Bundle.main.bundleURL)
        DispatchQueue.global(qos: .utility).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [script.path, "--in-place", bundle]
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            do {
                try p.run()
                let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                p.waitUntilExit()
                Trace.log("install-app --in-place exit \(p.terminationStatus): \(out.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))")
            } catch {
                Trace.log("install-app --in-place didn't start: \(error.localizedDescription)")
            }
        }
    }

    private var polycarpWatcher: PolycarpThemeWatcher?

    func applicationDidFinishLaunching(_ n: Notification) {
        // `BaneySpaces --restore-shortcuts`: the uninstaller's way to turn macOS's screenshot
        // shortcuts back on before the app's settings are deleted.
        if CommandLine.arguments.contains("--restore-shortcuts") {
            SystemShortcuts.restore()
            SystemShortcuts.spotlightQueue.sync { SystemShortcuts.restoreSpotlight() }
            // Still recorded means still off: the uninstaller says so instead of claiming success.
            let left = !(UserDefaults.standard.array(forKey: "freedShortcuts") ?? []).isEmpty || SystemShortcuts.spotlightFreed
            exit(left ? 1 : 0)
        }
        // `BaneySpaces --restore-dock`: the uninstaller's way to put the macOS Dock back if the
        // Workspace Dock had it out of sight.
        if CommandLine.arguments.contains("--restore-dock") {
            SystemDock.restore()
            SystemTopDrag.restore()
            SystemMissionControl.restore()
            exit(0)
        }
        // `BaneySpaces --check-settings`: opens the settings window on each section and exits 1 if the window is not the one
        // fixed size on every section. It opened 0×0, invisible, on macOS 27. It checks the window's size, not what a section shows.
        if CommandLine.arguments.contains("--check-settings") {
            // The app's own controller, wired as the app wires it.
            let c = setup
            c.show()
            let screen = NSScreen.main?.visibleFrame.height ?? 800
            var ok = true
            for t in SettingsTab.allCases {
                c.model.tab = t
                RunLoop.current.run(until: Date().addingTimeInterval(0.5))
                let f = c.window!.frame
                let want = SettingsSidebar.windowSize
                let content = c.window!.contentRect(forFrameRect: f).size
                let fits = abs(content.width - want.width) < 1 && abs(content.height - want.height) < 1 && f.height <= screen
                print("\(t.rawValue): \(Int(f.width))×\(Int(f.height))\(fits ? "" : "  FAIL")")
                ok = ok && fits
            }
            exit(ok ? 0 : 1)
        }
        // `BaneySpaces --unregister-login`: the uninstaller's way to take it out of Login Items.
        if CommandLine.arguments.contains("--unregister-login") {
            // Never registered is as good as removed.
            let app = SMAppService.mainApp
            if app.status == .notRegistered || app.status == .notFound { exit(0) }
            exit((try? app.unregister()) != nil ? 0 : 1)
        }
        linkCommandIfNeeded()
        // A person who came by the disk image never ran install.sh: BaneySpaces, if there, goes to the Trash once Polycarp runs.
        let welcomeFinishedAtLaunch = UserDefaults.standard.bool(forKey: Welcome.finishedKey)
        // Tried at 5 s, and again every 10 s (for up to two minutes) while only the settings import is unfinished.
        func tryRetirement(_ attempt: Int) {
            DispatchQueue.main.asyncAfter(deadline: .now() + (attempt == 0 ? 5 : 10)) {
                let finished = LegacyRetirement.welcomeFinished(atLaunch: welcomeFinishedAtLaunch, now: UserDefaults.standard.bool(forKey: Welcome.finishedKey))
                if !LegacyRetirementRunner.runIfDue(welcomeFinished: finished), attempt < 12 { tryRetirement(attempt + 1) }
            }
        }
        tryRetirement(0)
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass),
                                                     andEventID: AEEventID(kAEGetURL))
        // `baneyspaces set` and `get` answer from launch on, before Accessibility: looks and the dock switch
        // only store a choice then; the dock starts with the rest once BaneySpaces does.
        session.readSetting = { [weak self] in self?.settingValue($0) }
        session.writeSetting = { [weak self] k, v in self?.applySetting(k, v) ?? false }
        // A Polycarp theme (`polycarp theme set ...`) draws instead of Settings' theme and palette while its
        // file is there. A kqueue watch on the file and its folders wakes a background queue when it changes; a change
        // is applied here, on the main queue, the way Settings applies one. Normal launches only: the
        // modes above exit before this, and `--render` never gets here.
        let watcher = PolycarpThemeWatcher(path: PolycarpThemeFile.path(), log: { Trace.log($0) }) { theme in
            DispatchQueue.main.async { Appearance.shared.usePolycarp(theme) }
        }
        polycarpWatcher = watcher
        // Wait a moment for the first look (a stat and a small read) so a theme file that is already there
        // draws from the first panel on; a slow disk costs 0.15 s at most and the theme then arrives as any change does.
        if case .theme(let t) = watcher.start(firstLookWithin: 0.15) { Appearance.shared.usePolycarp(t) }
        // surfaces.json (`polycarp-spaces surfaces set ...`, docs/surfaces.md): every surface reads
        // `SurfacesStore.shared.current` and listens for `SurfacesStore.didChange`. Same watch as the theme's, off main.
        SurfacesStore.shared.start(log: { Trace.log($0) })
        // Settings › Appearance › "Theme sets the desktop picture" (off by default): looks once now, then on each change.
        ThemeWallpaperApplier.shared.start()
        // `idle.enabled` (off by default): looks every 15 s for the minutes without input it waits for.
        IdleCover.shared.start()
        // `alarm.wake` (off by default): rings at `alarm.wakeAt` and opens the morning question; re-arms on each change.
        WakeAlarm.shared.start()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        topBar.ownMenu = { [weak self] in self?.statusItem.menu }

        spaces.onChange = { [weak self] in
            guard let self else { return }
            self.updateIcon()
            self.dock.reload()
            self.topBar.workspacesChanged()
            // The day ledger counts time from each switch; a change that keeps the workspace adds nothing.
            PurposeKeeper.shared.noteWorkspace(self.spaces.model.current)
        }
        // The purpose layer (purposes, the one thing, the day ledger, the rhythm) answers from launch on: none of it
        // needs Accessibility. It draws nothing itself; the surfaces read it.
        session.purposeHandler = { [weak self] r in PurposeKeeper.shared.answer(r, current: self?.spaces.model.current ?? 1) }
        PurposeKeeper.shared.start()
        // After the purposes, which it shows; it reads surfaces.json and stays away while `bar.enabled` is off.
        topBar.start()
        RhythmSheet.shared.workspaces = { [weak self] in
            guard let self else { return ([], 1) }
            return (Set(Workspaces.range.filter { !self.spaces.apps(on: $0).isEmpty }), self.spaces.model.current)
        }
        RhythmSheet.shared.start()
        // A new theme redraws the menu bar indicator as well as the panels.
        NotificationCenter.default.addObserver(forName: Appearance.didChange, object: nil, queue: .main) { [weak self] _ in
            self?.updateIcon()
        }
        for name in [NSWorkspace.didTerminateApplicationNotification, NSWorkspace.didHideApplicationNotification] {
            NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
                self?.spaces.appLeft(app.processIdentifier)
                if name == NSWorkspace.didTerminateApplicationNotification { self?.spaces.appQuit(app.processIdentifier) }
            }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                          object: nil, queue: .main) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self.switcher.noteActivated(app.processIdentifier)
            guard self.started else { return }
            self.spaces.appActivated(app)
            self.session.appChanged()
            // The app used last goes first on its tile, so a dock in view reorders now.
            self.dock.reload()
        }
        // Once another app is in front, the viewer and the empty-workspace holder step aside.
        NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            guard let self, self.started else { return }
            self.viewer.close()
            self.spaces.dropEmptyHolder()
        }
        // A BaneySpaces window of its own (setup, About) taking the keyboard ends the holder's job too.
        NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification,
                                               object: nil, queue: .main) { [weak self] note in
            guard let self, self.started, let w = note.object as? NSWindow, !(w is KeyablePanel) else { return }
            self.spaces.dropEmptyHolder()
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            guard let self, self.started else { return }
            self.spaces.screensChanged()
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification,
                                                          object: nil, queue: .main) { [weak self] _ in
            guard let self, self.started else { return }
            self.spaces.didWake()
        }
        // `kill`, logout and `launchctl stop` still bring every window back.
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
        // ⌃⌘K (registered in `registerShortcuts`) opens the launcher, which searches the session rows.
        session.onSearch = { [weak self] in self?.launcher.toggle() }
        session.onItemsChange = { [weak self] in if self?.launcherBuilt == true { self?.launcher.rowsChanged() } }
        // People for the launcher: read now only when Contacts access is already on. Nothing asks for it here.
        ContactsLibrary.shared.onChange = { [weak self] in if self?.launcherBuilt == true { self?.launcher.rowsChanged() } }
        ContactsLibrary.shared.start()
        // The new tab page's host manifest for each Chromium browser here (docs/newtab.md), off the main thread.
        NewTabRegistration.start()
        DispatchQueue.main.async { [weak self] in _ = self?.launcher }
        DockRestart.isSwitching = { [weak self] in self?.spaces.switching ?? false }
        legacyWatcher.start()
        startWorkspaces()
        updater.onChange = { [weak self] in self?.updateIcon() }
        // Not while a workspace switches.
        updater.isBusy = { [weak self] in self?.spaces.switching ?? false }
        updater.start()
        // The first launch walks through setup, and so does any launch without permission (an
        // update that macOS no longer trusts). Otherwise it's one click away in the menu.
        UserDefaults.standard.set(true, forKey: "setupShown")
        if CommandLine.arguments.contains("--setup") {
            showSetup()
        } else if Welcome.shouldShow(hasFinished: UserDefaults.standard.bool(forKey: Welcome.finishedKey), granted: WelcomeModel.read(), forced: false) {
            showWelcome()
        }
    }

    /// Opening BaneySpaces again from Finder, Spotlight or Launchpad shows setup.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showSetup()
        return false
    }

    @objc private func showSetup() { showSettings() }

    /// Shows Settings, timed in timing.log as `open settings-first=` (the window built too) or `open settings=` (#350).
    private func showSettings() {
        let clock = OpenClock(setupBuilt ? "settings" : "settings-first")
        defer { clock.shown() }
        setup.show()
    }
    private let legacyWatcher = LegacyWatcher()

    /// Starts the workspaces. They are always on: an old `features.toml` that says `workspaces = false` is not read.
    private func startWorkspaces() {
        startWhenTrusted()
        // ⌘Space works with or without Accessibility; Spotlight hands it over first.
        if Launcher.onCmdSpace { setLauncherOnCmdSpace(true) } else { registerShortcuts() }
        updateIcon()
    }

    @objc private func showWelcome() { welcome.show() }
    private lazy var welcome: WelcomeWindowController = {
        let c = WelcomeWindowController()
        c.model.modifierSymbol = { [weak self] in self?.setup.model.modifier.symbol ?? "⌘" }
        c.model.onFixStale = { [weak self] in self?.setup.model.fixPermission() }
        return c
    }()

    /// Programs in the built-in terminal end with Polycarp: it asks first while one runs (`TerminalFeature`).
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        TerminalFeature.shouldTerminate()
    }

    func applicationWillTerminate(_ n: Notification) {
        // An install swaps the app in place: the Dock and Mission Control stay as they are, since
        // restoring them here and taking them back at the launch would restart the Dock twice in seconds.
        let forInstall = InstallHandoff.isCurrent(markedAt: (UserDefaults.standard.object(forKey: InstallHandoff.key) as? NSNumber)?.doubleValue, now: Date().timeIntervalSince1970)
        UserDefaults.standard.removeObject(forKey: InstallHandoff.key)
        DockRestart.isQuitting = true
        // A purpose set a moment ago is on disk before the app is gone.
        PurposeKeeper.flushIfStarted()
        // The macOS Dock comes back with everything else; the next launch tucks it away again.
        dock.stop(restoreSystemDock: !forInstall)
        topDrag.stop()
        DragFrameTrace.stopAll()
        // Mission Control comes back with the Dock, so there's always a way to see the desktops.
        // Quitting for an update is the exception: the new build takes over, and if it never
        // starts the launch agent puts Mission Control back after 30 seconds.
        if SystemMissionControl.isTakenByUs {
            if forInstall || UserDefaults.standard.dictionary(forKey: "updatingTo") != nil { SystemMissionControl.leaveForUpdate() }
            else { SystemMissionControl.restore() }
        }
        if started { spaces.restoreAll() }
        // ⌘Space goes back to Spotlight while BaneySpaces isn't running; the next launch takes it again.
        SystemShortcuts.spotlightQueue.sync { SystemShortcuts.restoreSpotlight() }
        spaces.flushWrites()
        // A clean quit, not a crash, for the next launch's crash-loop check.
        CrashLoop.launchEnded()
        hotCorners.stop()
        DockRestart.handOffBeforeQuit()
    }

    // MARK: Accessibility

    /// Moving other apps' windows needs Accessibility access. Ask once, then wait for it, and for
    /// AeroSpace to quit, since two managers moving the same windows would fight.
    private let fullScreenGestures = FullScreenGestures()

    private func startWhenTrusted() {
        if canStart { return start() }
        // Left out of sight by a crash, the macOS Dock comes back while BaneySpaces waits; the
        // Workspace Dock takes over again once it starts. The same goes for the drag to the top.
        SystemDock.restore()
        SystemTopDrag.restore()
        SystemMissionControl.restore()
        updateIcon()
        trustTimer?.invalidate()
        trustTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self, self.canStart else { return }
            timer.invalidate()
            self.start()
        }
    }

    private var aeroSpaceRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: "bobko.aerospace").isEmpty
    }

    private var canStart: Bool { AXIsProcessTrusted() && !aeroSpaceRunning }

    /// A press anywhere tells Spaces which display you're on: in other apps and on the desktop
    /// (global), and on BaneySpaces' own dock, overview and launcher (local, before the press is
    /// handled, so a dock tile switches the dock's display).
    private var clickMonitors: [Any] = []
    private func watchClicksForDisplay() {
        guard clickMonitors.isEmpty else { return }
        if let g = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown, handler: { [weak self] _ in self?.spaces.usePointerDisplay() }) {
            clickMonitors.append(g)
        }
        if let l = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown, handler: { [weak self] e in self?.spaces.usePointerDisplay(); return e }) {
            clickMonitors.append(l)
        }
    }

    private func start() {
        // Applies to every Accessibility call, so one frozen app can't stall a switch.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
        started = true
        registerShortcuts()
        missionControlKeys.start()
        syncMissionControl()
        spaces.start()
        fullScreenGestures.onGesture = { [weak self] window in self?.spaces.toggleFill(window) }
        fullScreenGestures.start()
        watchClicksForDisplay()
        if WorkspaceDock.enabled { dock.start() }
        // macOS's own top-of-screen drag goes quiet first, so only one view answers the gesture.
        // Off, settings left taken over (a crash, a change while it wasn't running) go back.
        if TopDragWatcher.enabled { SystemTopDrag.takeOver() } else { SystemTopDrag.restore() }
        syncWindowDrags()
        startSession()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.sendBackOldMovedIn() }
        updateIcon()
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self else { return }
            guard self.stillTrusted() else { return }
            // A key watcher macOS refused earlier gets another chance.
            if (MissionControlKeys.enabled || MissionControlKeys.cmdTabEnabled) && !self.missionControlKeys.isActive {
                self.missionControlKeys.start()
                if self.missionControlKeys.isActive { self.syncMissionControl() }
            }
            // Every ten seconds: proof of life for the launch agent, and System Settings changes
            // to hot corners.
            self.missionControlTicks += 1
            if self.missionControlTicks % 5 == 0 {
                if SystemMissionControl.isTakenByUs {
                    SystemMissionControl.beat()
                    self.hotCorners.set(corners: SystemMissionControl.answeredCorners())
                    self.checkMissionControlHeld()
                } else if self.started, MissionControlKeys.enabled, self.missionControlKeys.isActive,
                          SystemMissionControl.problem == nil || self.missionControlTicks % 150 == 0 {
                    // Taken back by the launch agent while this ran, or not armed yet: try again
                    // (every five minutes when the safety net failed, so macOS isn't asked again and again).
                    self.syncMissionControl()
                }
            }
        }
    }

    /// True while macOS trusts BaneySpaces. The moment it doesn't (switched off in System
    /// Settings, or an update with a new signature), every shortcut goes back to the other apps,
    /// every hidden window comes back, and setup opens to put it right.
    @discardableResult
    private func stillTrusted() -> Bool {
        guard started else { return false }
        if AXIsProcessTrusted() { return true }
        watchdog?.invalidate()
        missionControlKeys.stop()
        topDrag.stop()
        DragFrameTrace.stopAll()
        cancelSettling()
        // Not watching any more, so macOS answers the drag and the corners again until BaneySpaces is back.
        SystemTopDrag.restore()
        hotCorners.stop()
        SystemMissionControl.restore()
        viewer.close()
        dock.stop(restoreSystemDock: true)
        session.stop()
        spaces.suspend()
        started = false
        registerShortcuts()
        updateIcon()
        showWelcome()
        startWhenTrusted()
        return false
    }

    /// Windows dragged by their title bars are followed while the drag to the top opens the
    /// overview or the Workspace Dock takes them. macOS's own top-of-screen drag is the top
    /// drag's to turn off and on (`setTopDrag`), never the dock's: turning the dock on or off
    /// leaves those settings, and the Dock process, alone.
    private func syncWindowDrags() {
        guard started else { return }
        topDrag.topEnabled = TopDragWatcher.enabled
        if DockSwitch<DockPanel>.windowDragsNeeded(topDrag: TopDragWatcher.enabled, dockEnabled: WorkspaceDock.enabled) {
            topDrag.start()
        } else {
            topDrag.stop()
            DragFrameTrace.stopAll()
            cancelSettling()
        }
    }

    private func setTopDrag(_ on: Bool) {
        TopDragWatcher.enabled = on
        if on, started { SystemTopDrag.takeOver() } else if !on { SystemTopDrag.restore() }
        syncWindowDrags()
    }

    /// The shortcuts are taken only once they work, so the keys keep their usual meaning in other
    /// apps until then. Picking a different modifier in setup re-registers them.
    private func registerShortcuts() {
        hotkeys.removeAll()
        if Launcher.onCmdSpace, !SystemShortcuts.spotlightOwnsCmdSpace {
            hotkeys.register(keyCode: kVK_Space, modifiers: cmdKey) { [weak self] in self?.launcher.toggle() }
        }
        // ⌃⌘K opens the launcher from any app, with or without Accessibility.
        hotkeys.register(keyCode: kVK_ANSI_K, modifiers: controlKey | cmdKey) { [weak self] in self?.session.onSearch() }
        // ⌃⌘U goes to the agent that finished, from any app.
        hotkeys.register(keyCode: kVK_ANSI_U, modifiers: controlKey | cmdKey) { [weak self] in
            if self?.session.started == true { self?.session.jumpToFinished() }
        }
        guard started else { return }
        // ⌃` drops the quick terminal down, from any app (in builds with the terminal, while Settings has it on).
        TerminalFeature.registerQuickKey(hotkeys)
        let mods = Modifier.current.carbon
        for (i, code) in Hotkeys.digitKeyCodes.enumerated() {
            let n = i + 1
            hotkeys.register(keyCode: code, modifiers: mods) { [weak self] in
                guard let self, self.stillTrusted() else { return }
                self.spaces.switchTo(n)
            }
            hotkeys.register(keyCode: code, modifiers: mods | shiftKey) { [weak self] in
                guard let self, self.stillTrusted() else { return }
                self.spaces.moveFocused(to: n)
            }
        }
    }

    /// Once: the windows an older build's agents moved onto the agent workspace go back (`AgentAPI.OldMovedIn`), then the
    /// record goes. It waits for the first scan, since before it no window is placed.
    private func sendBackOldMovedIn(tries: Int = 15) {
        let url = Spaces.folder.appendingPathComponent("moved-in.json")
        guard let data = try? Data(contentsOf: url) else { return }
        if spaces.model.home.isEmpty, tries > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.sendBackOldMovedIn(tries: tries - 1) }
            return
        }
        let saved = AgentAPI.OldMovedIn.decode(data)
        let back = AgentAPI.OldMovedIn.sendBack(saved, window: { [spaces] in spaces.moveCandidate($0) },
                                                current: spaces.model.current, agentWorkspace: Spaces.agentWorkspace)
        for b in back { run { $0.move(b.window, to: b.to) } }
        try? FileManager.default.removeItem(at: url)
        Trace.log("agent workspace: old moved-in record: \(back.count) of \(saved.count) windows sent back, record removed")
    }

    private func run(_ action: (Spaces) -> Void) {
        guard stillTrusted() else { return NSSound.beep() }
        action(spaces)
    }

    // MARK: Menu bar

    private func updateIcon() {
        let name = started ? "\(spaces.model.current).square.fill" : "exclamationmark.triangle"
        let description = started ? "Polycarp, workspace \(spaces.model.current)" : "Polycarp needs Accessibility access"
        // The Polycarp theme shows the olive branch with the workspace number; the others draw their own indicator.
        let image = (started ? (MenuBarMark.image(workspace: spaces.model.current, description: description)
                                ?? MenuBarMark.polycarp(workspace: spaces.model.current, description: description)) : nil)
            ?? NSImage(systemSymbolName: name, accessibilityDescription: description)
        image?.isTemplate = true
        statusItem.button?.image = image
        // Agents that finished while you were elsewhere, counted beside the workspace number.
        let n = started && session.started ? session.unseenCount : 0
        statusItem.button?.title = n > 0 ? " \(n)" : ""
        statusItem.button?.toolTip = nil
        statusItem.button?.imagePosition = .imageLeading
    }

    private func startSession() {
        session.onUnseenChange = { [weak self] _ in self?.updateIcon(); self?.dock.reload() }
        var h = AgentHost()
        h.workspace = { Spaces.agentWorkspace }
        h.setWorkspace = { [weak self] n in Spaces.agentWorkspace = n; self?.run { $0.reapply() } }
        h.current = { [weak self] in self?.spaces.model.current ?? 1 }
        h.move = { [weak self] id, n in self?.run { $0.move(id, to: n) } }
        h.windows = { [weak self] in self?.spaces.agentWindows() ?? [] }
        h.window = { [weak self] id in self?.spaces.moveCandidate(id) }
        h.occupied = { [weak self] n in self?.spaces.isOccupied(n) ?? false }
        session.agentHost = h
        session.updateHandler = { [weak self] what in self?.updater.answer(what) ?? Wire.Reply(ok: false, error: "the updater isn't ready") }
        session.onWorkingChange = { [weak self] in self?.dock.reload() }
        // A moment after launch: setting up an observer per app costs the main thread a few
        // hundred milliseconds, which would otherwise land on your first workspace switch.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, self.started else { return }
            self.session.focusWindow = { [weak self] id, n in
                guard let self, self.spaces.active else { return false }
                self.spaces.focus(id, on: n)
                return true
            }
            self.session.start(workspaceOf: { [weak self] in self?.spaces.model.workspace(of: $0) },
                            currentWorkspace: { [weak self] in self?.spaces.model.current ?? 1 })
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard started else {
            if aeroSpaceRunning {
                menu.addItem(withTitle: "Waiting for AeroSpace to quit", action: nil, keyEquivalent: "")
            }
            if !AXIsProcessTrusted() {
                menu.addItem(withTitle: "Polycarp needs permission to arrange windows", action: nil, keyEquivalent: "")
                menu.addItem(item("Allow Polycarp…", #selector(showWelcome)))
            } else {
                menu.addItem(item("Settings…", #selector(showSetup)))
            }
            menu.addItem(.separator())
            menu.addItem(item("Quit Polycarp", #selector(quit), key: "q"))
            return
        }
        spaces.refresh()
        var apps: [Int: [String]] = [:]
        for n in Workspaces.range { apps[n] = spaces.apps(on: n) }
        let keeper = PurposeKeeper.shared
        let named = keeper.purposes.snapshot
        let here = spaces.model.current
        let now = MenuNow.make(workspace: here, purpose: named.purpose(of: here), since: keeper.arrived)
        let settings = keeper.settings, clock = keeper.ledger.dayClock, at = Date()
        let evening = settings.eveningExamen && at >= Rhythm.eveningStart(of: clock.day(of: at), settings: settings, clock: clock)
        let running = keeper.timer.flatMap { $0.done(now: at) ? nil : $0 }
        let timer = MenuTimer(minutes: SurfacesStore.shared.current.alarm.timerMinutes, left: running?.remaining(now: at))
        let entries = MenuLayout.entries(now: now, oneThing: named.oneThing?.text, timer: timer, evening: evening,
                                         rows: MenuLayout.rows(current: here, apps: apps, purposes: named.all),
                                         finished: session.started ? session.unseenCount : 0,
                                         update: MenuUpdate(notice: updateNotice(), checking: updater.checking))
        for entry in entries { menu.addItem(menuItem(for: entry)) }
    }

    /// Each entry `MenuLayout.entries` lists, as the one menu item it is. Every item the menu holds
    /// is built here or in `item(_:_:key:)`, which `MenuLayoutTests` counts.
    private func menuItem(for entry: MenuEntry) -> NSMenuItem {
        switch entry {
        case .now(let now):
            // The purpose in serif italic, the workspace and time below it; clicking it opens Name This Hour.
            let it = item(now.title, #selector(nameHour))
            it.attributedTitle = MenuHead.title(now)
            it.toolTip = "Click to name this hour"
            return it
        case .setOneThing:
            return item("Set the One Thing…", #selector(setOneThing))
        case .oneThing(let one):
            // The one thing's own words; changing it, its timer and the examen sit one level down.
            let it = item(one.title, #selector(setOneThing))
            it.action = nil
            let sub = NSMenu()
            for i in one.items { sub.addItem(oneThingItem(i)) }
            it.submenu = sub
            return it
        case .timer(let timer):
            return oneThingItem(.timer(timer))
        case .examen:
            return oneThingItem(.examen)
        case .workspace(let row):
            let it = item(row.title, #selector(pick(_:)), key: "\(row.workspace)")
            it.keyEquivalentModifierMask = Modifier.current.menuFlags
            it.tag = row.workspace
            it.state = row.isCurrent ? .on : .off
            it.toolTip = row.fullList
            return it
        case .showAll:
            return item("Show All Workspaces", #selector(showViewer))
        case .find:
            let find = item("Find or Install an App…", #selector(showLauncher))
            if Launcher.onCmdSpace { find.keyEquivalent = " "; find.keyEquivalentModifierMask = [.command] }
            return find
        case .settings:
            return item("Settings…", #selector(showSetup), key: ",")
        case .quit:
            return item("Quit Polycarp", #selector(quit), key: "q")
        case .finished(let count):
            // Clicking an agent goes to it and marks it seen, which drops it from this list.
            return session.finishedMenuItem(title: MenuLayout.finishedTitle(count))
        case .update(let update):
            // Always here: a check by hand, the check running, or the release on offer or installing.
            let it = item(update.title, update.offersRelease ? #selector(offerUpdate) : #selector(checkForUpdatesFromMenu))
            if !update.enabled {
                it.action = nil
                it.isEnabled = false
            } else if update.offersRelease {
                it.attributedTitle = NSAttributedString(string: it.title, attributes: [.font: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)])
            }
            return it
        case .separator:
            return .separator()
        }
    }

    /// One row of the one thing's submenu, or the timer or examen row when no one thing holds them.
    private func oneThingItem(_ i: MenuOneThing.Item) -> NSMenuItem {
        switch i {
        case .change: return item(i.title, #selector(setOneThing))
        case .timer: return item(i.title, #selector(toggleTimer))
        case .examen: return item(i.title, #selector(eveningExamen))
        }
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
        it.target = self
        return it
    }

    /// A release waiting or installing, if any: the menu's "Update to …" row and Settings > Updates.
    private func updateNotice() -> UpdateNotice? {
        if let r = updater.installing { return UpdateNotice(name: r.name, isNightly: r.isNightly, installing: true) }
        return updater.available.map { UpdateNotice(name: $0.name, isNightly: $0.isNightly, installing: false) }
    }

    @objc private func offerUpdate() { if let r = updater.available { updater.offer(r) } }

    /// "Check for Updates…": the manual check, which always answers, "up to date" included.
    @objc private func checkForUpdatesFromMenu() { checkForUpdates() }

    @objc private func pick(_ sender: NSMenuItem) { spaces.switchTo(sender.tag) }

    /// "Evening Examen…": the examen card now, given tonight or not.
    @objc private func eveningExamen() {
        RhythmSheet.shared.show(.eveningExamen)
    }

    /// "Start a timer (25 min)" / "Stop the timer (12 min left)": the one-thing timer.
    @objc private func toggleTimer() {
        let keeper = PurposeKeeper.shared
        if let t = keeper.timer, !t.done(now: Date()) { keeper.stopTimer(by: "menu") } else { keeper.startTimer(by: "menu") }
    }

    /// "Name This Hour…": what the workspace you are on is for.
    @objc private func nameHour() {
        let n = spaces.model.current
        let store = PurposeKeeper.shared.purposes
        MenuHead.ask("What is this hour for?", info: "Workspace \(n). A few words, up to \(Purposes.purposeLimit) characters; leave it empty to clear it.",
                     value: store.purpose(of: n) ?? "") { try store.setPurpose($0, for: n); Trace.log("purpose: workspace \(n) purpose set by menu") }
    }

    /// "Set the One Thing…": the one thing for today, until 4 am.
    @objc private func setOneThing() {
        let n = spaces.model.current
        let store = PurposeKeeper.shared.purposes
        MenuHead.ask("What is the one thing today?", info: "Up to \(Purposes.oneThingLimit) characters. It clears at 4 am; leave it empty to clear it now.",
                     value: store.oneThing?.text ?? "") { try store.setOneThing($0, workspace: n); Trace.log("purpose: one thing set by menu") }
    }

    /// Apps whose windows are parked instead of hidden, so automation can still use them: Settings >
    /// Automation. Apps with windows, plus every app already on the list, so any of them can be unchecked.
    private func parkedRows() -> [SetupModel.ParkedRow] {
        let on = ParkedApps.bundleIDs
        let slow = SlowMovers.bundleIDs
        // The window list as it is now, as the menu did: an app's late first window shows.
        if started { spaces.refresh() }
        var apps = started ? spaces.appsWithWindows() : []
        for id in on where !apps.contains(where: { $0.bundleID == id }) {
            let name = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)
                .map { FileManager.default.displayName(atPath: $0.path).replacingOccurrences(of: ".app", with: "") } ?? id
            apps.append((name, id))
        }
        // An app that slides its windows when moved is hidden anyway, so nothing moves on screen.
        return apps.map { .init(id: $0.bundleID, name: $0.name, on: on.contains($0.bundleID), animates: slow.contains($0.bundleID)) }
    }

    // MARK: Workspace Dock

    private func toggleWorkspaceDock() { setWorkspaceDock(!WorkspaceDock.enabled) }

    /// Moves the Workspace Dock to another side of the screen; setup follows.
    func setDockEdge(_ e: DockEdge) {
        dock.setEdge(e)
        if setup.model.dockEdge != e { setup.model.dockEdge = e }
    }

    /// Asks, then hands off to the bundled uninstall.sh and quits; quitting brings every window
    /// back, and the script waits for that before it removes anything.
    private func uninstall() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Uninstall Polycarp?"
        alert.informativeText = Uninstaller.summary
        alert.addButton(withTitle: "Uninstall")
        alert.addButton(withTitle: "Cancel")
        alert.buttons[0].hasDestructiveAction = true
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            try Uninstaller.start()
            NSApp.terminate(nil)
        } catch {
            let fail = NSAlert()
            fail.messageText = "Polycarp couldn't start the uninstaller"
            fail.informativeText = "\(error.localizedDescription)\n\nRun this in Terminal instead:\n\(Uninstaller.command)"
            fail.runModal()
        }
    }

    /// Shows or hides agent badges on the Workspace Dock; settings follow.
    func setDockAgentStatus(_ on: Bool) {
        WorkspaceDock.agentStatus = on
        dock.model.agentStatus = on
        if setup.model.dockAgentStatus != on { setup.model.dockAgentStatus = on }
        dock.reload()
    }

    /// `dock.enabled`, `appearance.theme` and `appearance.palette` by name: what `baneyspaces get` reads.
    func settingValue(_ key: SettingKey) -> String? {
        switch key {
        case .theme: Appearance.shared.settings.theme.rawValue
        case .palette: Appearance.shared.settings.colorPalette
        case .dockEnabled: WorkspaceDock.enabled ? "true" : "false"
        }
    }

    /// What `baneyspaces set` and Settings do: applied at once, no restart. False when the app can't (it is going away).
    @discardableResult
    func applySetting(_ key: SettingKey, _ value: String) -> Bool {
        switch key {
        case .theme: Appearance.shared.settings.theme = ThemeID(rawValue: value) ?? .macDefault
        case .palette: Appearance.shared.settings.colorPalette = value
        case .dockEnabled: setWorkspaceDock(value == "true")
        }
        return true
    }

    /// Turns the Workspace Dock on or off (`dock.enabled`). Off, there is no dock window at all and
    /// the macOS Dock comes back as it was; on, the dock returns on the next reveal at its edge.
    func setWorkspaceDock(_ on: Bool) {
        WorkspaceDock.enabled = on
        if setup.model.workspaceDock != on { setup.model.workspaceDock = on }
        if on, started { dock.start() } else if !on { dock.stop(restoreSystemDock: true) }
        syncWindowDrags()
    }

    // MARK: Launcher

    @objc private func showLauncher() { launcher.show() }

    /// Takes ⌘Space from Spotlight for the launcher, or gives it back. Changing macOS's shortcut
    /// takes a moment, so it happens off the main thread.
    func setLauncherOnCmdSpace(_ on: Bool) {
        Launcher.onCmdSpace = on
        if setup.model.launcherOnCmdSpace != on { setup.model.launcherOnCmdSpace = on }
        SystemShortcuts.spotlightQueue.async { [weak self] in
            if on { SystemShortcuts.freeSpotlight() } else { SystemShortcuts.restoreSpotlight() }
            DispatchQueue.main.async { self?.registerShortcuts() }
        }
    }

    // MARK: Updates

    /// What Settings > Updates shows: the build you have, the channel, and any release waiting.
    private func updateInfo() -> SetupModel.UpdateInfo {
        .init(have: Updater.buildDescription, channel: updater.channel, channels: updater.offered, daily: updater.checksAutomatically, notice: updateNotice())
    }

    private func checkForUpdates() { updater.check(manual: true) }

    private func toggleParked(_ id: String) {
        guard started else { return }
        ParkedApps.toggle(id)
        // Checking an app again gives it a fresh try at parking.
        if ParkedApps.bundleIDs.contains(id) { SlowMovers.bundleIDs.remove(id) }
        spaces.reapply()
    }

    private func bringBack() {
        guard started else { return }
        spaces.gatherOnOne()
    }

    @objc private func showViewer() { viewer.open() }

    private func about() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [
            .credits: NSAttributedString(string: "Nine workspaces on one keyboard row.\n\(Modifier.current.symbol)1–\(Modifier.current.symbol)9 to switch. Add ⇧ to bring the window along."),
        ])
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: URL commands

    /// `open baneyspaces://switch/2`, `baneyspaces://move/3`, `baneyspaces://restore`.
    /// The same actions as the shortcuts, for scripts and checks.
    @objc private func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let url = URL(string: text) else { return }
        runURL(url)
    }

    /// Also run for a link that started Polycarp (`application(_:open:)` in Player.swift), which arrives before
    /// `handleURL` is installed.
    func runURL(_ url: URL) {
        guard url.scheme == "polycarp" || url.scheme == "baneyspaces" else { return }
        let text = url.absoluteString
        let n = Int(url.lastPathComponent) ?? 0
        switch url.host {
        case "switch": run { $0.switchTo(n) }
        case "move": run { $0.moveFocused(to: n) }
        case "restore": run { _ in bringBack() }
        case "viewer": run { _ in viewer.toggle() }
        // Opening it changes nothing on its own, so a web page may: every action inside needs a key press.
        case "launcher": launcher.show(scope: LauncherModel.Scope(rawValue: url.lastPathComponent) ?? .root, takeKeys: false)
        case "dock":
            // Turning it off or hiding it is always allowed: a pinned dock must never outlive
            // its check (2026-10-14, a hide that raced the setting going off left it stuck up).
            // Showing it or turning it on (which hides the macOS Dock) is for checks, only when
            // `defaults write com.baney.baneyspaces dockURLCommands -bool true` says so, so a
            // web page can't do either.
            let checks = UserDefaults.standard.bool(forKey: "dockURLCommands")
            switch url.lastPathComponent {
            case "off": run { _ in setWorkspaceDock(false) }
            case "show" where checks: run { _ in dock.pin(true) }
            case "hide": run { _ in dock.pin(false) }
            case "on" where checks: run { _ in setWorkspaceDock(true) }
            // For `scripts/dock-motion-probe.swift`: open and close the first "+N" list without the pointer.
            case "more" where checks: run { _ in _ = dock.openMoreForCheck() }
            case "lessmore" where checks: run { _ in dock.closeMoreForCheck() }
            default: NSLog("Polycarp: dock command refused or unknown %@", text)
            }
        default: NSLog("Polycarp: unknown command %@", text)
        }
    }
}
