import AppKit
import Combine
import BaneySpacesCore
import ApplicationServices
import ServiceManagement
import SwiftUI

/// Live state for the setup window. While the window is open it re-reads permission four times a
/// second, so flipping the switch in System Settings shows up here almost at once.
final class SetupModel: ObservableObject {
    @Published var trusted = AXIsProcessTrusted()
    @Published var modifier = Modifier.current
    @Published var conflicts: [String] = SystemShortcuts.conflicts(for: Modifier.current)
    @Published var desktops = Desktops.count
    @Published var openAtLogin = SMAppService.mainApp.status == .enabled
    @Published var viewerKeys = MissionControlKeys.enabled
    @Published var topDrag = TopDragWatcher.enabled
    var onTopDragChange: ((Bool) -> Void)?
    @Published var cmdTab = MissionControlKeys.cmdTabMode
    var onCmdTabChange: ((MissionControlKeys.CmdTabMode) -> Void)?
    @Published var workspaceDock = WorkspaceDock.enabled
    var onWorkspaceDockChange: ((Bool) -> Void)?
    @Published var dockEdge = WorkspaceDock.edge
    var onDockEdgeChange: ((DockEdge) -> Void)?
    @Published var dockAgentStatus = WorkspaceDock.agentStatus
    var onDockAgentStatusChange: ((Bool) -> Void)?
    /// What agents may use (Settings > Agents). Shows the mode in force: a pick that widens access takes effect
    /// only after the consent sheet, so this follows `AgentAccess`, never the picker.
    @Published var agentAccess = AgentAccess.shared.current
    var onAgentAccessPick: ((AgentAccessMode) -> Void)?
    /// Whether Claude Code and Grok report to BaneySpaces; agent badges need it.
    enum HookState { case on, off, noClaudeCode, unreadable }
    var hooksInstalled: () -> HookState = { .on }
    var onInstallHooks: (() -> Void)?
    @Published var hooks: HookState = .on
    // Sandbox (Settings > Agents)
    @Published var sandbox = SandboxSettings.load()
    @Published var sandboxState = "Not running"
    @Published var sandboxDisk = ""
    @Published var sandboxRunning = false
    @Published var sandboxBusy = false
    @Published var sandboxProblem: String?
    var sandboxSummary: () -> AppSandbox.Summary? = { nil }
    var onSandboxReset: ((@escaping (String?) -> Void) -> Void)?
    var onSandboxDeleteImages: ((@escaping (String?) -> Void) -> Void)?

    var onSandboxDisabled: (() -> Void)?
    /// Why this Mac can't run the sandbox (under 16 GB), shown instead of quietly running a smaller VM.
    var sandboxHostProblem: String? { SandboxSettings.hostProblem(hostMemoryGB: Int(ProcessInfo.processInfo.physicalMemory >> 30)) }
    func setSandbox(_ s: SandboxSettings) {
        let wasOn = sandbox.enabled
        sandbox = s; s.save(); refreshSandbox()
        if wasOn && !s.enabled { onSandboxDisabled?() } // turning it off removes the VMs, not just refuses new ones
    }
    func refreshSandbox() {
        guard let s = sandboxSummary() else { return }
        sandboxState = s.state; sandboxDisk = s.detail; sandboxRunning = s.running; sandboxBusy = s.busy
    }
    func sandboxReset() {
        sandboxBusy = true; sandboxProblem = nil
        onSandboxReset? { [weak self] err in self?.sandboxProblem = err; self?.refreshSandbox() }
    }
    func sandboxDeleteImages() {
        sandboxBusy = true; sandboxProblem = nil
        onSandboxDeleteImages? { [weak self] err in self?.sandboxProblem = err; self?.refreshSandbox() }
    }

    @Published var tab: SettingsTab = .general {
        // The app list changes while the window is open; it's read when you look at it.
        didSet {
            if tab == .automation { reloadParked() }
            if tab == .updates { onUpdatesShown?() }
            if tab == .agents { refreshSandbox() }
        }
    }
    var onUninstall: (() -> Void)?
    /// Everything the menu bar menu's Options, Updates and About items used to do (2026-10-31).
    var onBringBack: (() -> Void)?
    var onAbout: (() -> Void)?
    /// An app that can be kept usable by automation: its windows are parked, not hidden.
    struct ParkedRow: Identifiable, Equatable {
        let id: String
        let name: String
        var on: Bool
        /// It slides its windows when moved, so it is hidden even with the box checked.
        var animates: Bool
    }
    @Published var parkedRows: [ParkedRow] = []
    /// The parked list is read when the tab appears, the window takes the keyboard, or an app
    /// launches or quits (`SetupWindowController`), not on every tick: it walks every window.
    var parkedApps: () -> [ParkedRow] = { [] }
    /// BaneySpaces has started (Accessibility allowed, AeroSpace gone). Automation waits for it.
    /// False until the first read says otherwise, so nothing is live before the gate knows.
    @Published var started = false {
        didSet {
            // The list was empty while waiting; read it as soon as BaneySpaces is up, and once more
            // after its first scan of the windows.
            guard started, !oldValue, tab == .automation, windowVisible() else { return }
            reloadParked()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                if self?.tab == .automation, self?.windowVisible() == true { self?.reloadParked() }
            }
        }
    }
    /// Whether the Settings window is on screen: a read nobody can see is a scan for nothing.
    var windowVisible: () -> Bool = { false }
    var isStarted: () -> Bool = { false } {
        didSet { started = isStarted() }
    }
    /// Why Automation can't act yet, or nil.
    var automationReason: String? { AutomationGate.reason(trusted: trusted, aeroSpaceRunning: aeroSpaceRunning, started: started) }
    var onToggleParked: ((String) -> Void)?
    /// BaneySpaces' own updates: the build you have, the channel, and any release waiting.
    struct UpdateInfo: Equatable {
        var have = ""
        var channel = UpdateChannel.stable
        var daily = true
        var nightlyNeedsTools = false
        /// A release waiting, or installing.
        var notice: UpdateNotice?
    }
    @Published var update = UpdateInfo()
    var updateInfo: () -> UpdateInfo = { UpdateInfo() }
    /// The Updates tab came up: look again for the command line tools, which a Mac can gain while this runs.
    var onUpdatesShown: (() -> Void)?
    var onCheckForUpdates: (() -> Void)?
    var onOfferUpdate: (() -> Void)?
    var onSetUpdateChannel: ((UpdateChannel) -> Void)?
    var onSetCheckDaily: ((Bool) -> Void)?
    /// Agents that finished while you were away, newest to oldest; a click goes to the agent.
    struct FinishedRow: Identifiable, Equatable { let id: String; let label: String }
    @Published var finished: [FinishedRow] = []
    var finishedRows: () -> [FinishedRow] = { [] }
    var onFocusFinished: ((String) -> Void)?

    /// Goes to the agent, which marks it seen; the list drops it at once instead of at the next tick.
    func focusFinished(_ id: String) {
        onFocusFinished?(id)
        finished = finishedRows()
    }
    @Published var launcherOnCmdSpace = Launcher.onCmdSpace
    @Published var searchEngine = Launcher.searchEngine { didSet { Launcher.searchEngine = searchEngine } }
    @Published var agent = Launcher.agent { didSet { Launcher.agent = agent } }
    @Published var customBangs = Launcher.readCustomBangs().bangs
    @Published var newTrigger = ""
    @Published var newName = ""
    @Published var newURL = ""
    @Published var newIsAgent = false
    @Published var bangProblem: String?
    var onLauncherChange: ((Bool) -> Void)?
    @Published var aeroSpaceRunning = SetupModel.isAeroSpaceRunning
    @Published var loginNeedsApproval = SMAppService.mainApp.status == .requiresApproval
    @Published var screenshotsFreed = SystemShortcuts.hasFreed
    /// The Mission Control key is switched on but macOS refused the key watcher.
    @Published var viewerKeysFailed = false
    /// Why macOS's Mission Control couldn't be switched off (the way back couldn't be set up).
    @Published var missionControlFailed: String?
    /// The person asked for access a while ago and macOS still says no: most likely an old
    /// permission from an earlier copy of the app, which only a reset clears.
    @Published var staleGrant = false
    @Published var fixing = false
    @Published var freeing = false
    /// Shown once, the moment everything required turns green.
    @Published var justEnabled = false

    var onModifierChange: ((Modifier) -> Void)?
    var onViewerKeysChange: ((Bool) -> Void)?
    /// Asked by the window controller; true while the Mission Control key watcher is running.
    var viewerKeysActive: () -> Bool = { true }
    var missionControlProblem: () -> String? = { nil }
    /// Called when every required step turns green while the window is open.
    var onReady: (() -> Void)?

    private var timer: Timer?
    private var ticks = 0
    private var askedAt: Date?

    /// Required to work at all. Desktops, login and keys are optional notices.
    var ready: Bool { trusted && !aeroSpaceRunning }

    static var isAeroSpaceRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: "bobko.aerospace").isEmpty
    }

    func startWatching() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
    }

    func stopWatching() { timer?.invalidate() }

    private func tick() {
        ticks += 1
        let wasReady = ready
        trusted = AXIsProcessTrusted()
        aeroSpaceRunning = SetupModel.isAeroSpaceRunning
        if let askedAt, !trusted, Date().timeIntervalSince(askedAt) > 8 { staleGrant = true }
        if trusted { staleGrant = false }
        if !wasReady && ready { becameReady() }
        // The slower checks once a second.
        if ticks % 4 == 0 { reloadOptional() }
        // An app's first window can come long after it launches, and one can close with the app still
        // running: no notification says so, so the Automation list reads every few seconds while up.
        if ticks % 12 == 0, tab == .automation, windowVisible() { reloadParked() }
    }

    func reload() {
        trusted = AXIsProcessTrusted()
        aeroSpaceRunning = SetupModel.isAeroSpaceRunning
        reloadOptional()
    }

    private func reloadOptional() {
        conflicts = SystemShortcuts.conflicts(for: modifier)
        screenshotsFreed = SystemShortcuts.hasFreed
        desktops = Desktops.count
        let status = SMAppService.mainApp.status
        openAtLogin = status == .enabled
        loginNeedsApproval = status == .requiresApproval
        viewerKeysFailed = trusted && viewerKeys && !viewerKeysActive()
        let mc = trusted && viewerKeys ? missionControlProblem() : nil
        if mc != missionControlFailed { missionControlFailed = mc }
        hooks = hooksInstalled()
        let info = updateInfo()
        if info != update { update = info }
        let rows = finishedRows()
        if rows != finished { finished = rows }
        let running = isStarted()
        if running != started { started = running }
    }

    func reloadParked() {
        let rows = parkedApps()
        if rows != parkedRows { parkedRows = rows }
    }

    func toggleParked(_ id: String) {
        onToggleParked?(id)
        reloadParked()
    }

    func setUpdateChannel(_ channel: UpdateChannel) {
        onSetUpdateChannel?(channel)
        update = updateInfo()
    }

    func setCheckDaily(_ on: Bool) {
        onSetCheckDaily?(on)
        update = updateInfo()
    }

    private func becameReady() {
        justEnabled = true
        askedAt = nil
        onReady?()
    }

    /// Adds BaneySpaces to the Accessibility list with macOS's own prompt, then opens the list so
    /// the only thing left is one switch.
    func allow() {
        askedAt = Date()
        staleGrant = false
        let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
        SetupModel.openAccessibilitySettings()
    }

    /// Settings > Permissions asked for Accessibility: after a while with no grant, the old-permission fix shows there.
    func askedForAccessibility() {
        askedAt = Date()
        staleGrant = false
    }

    /// Clears the old permission macOS kept for an earlier copy of BaneySpaces, then asks again.
    func fixPermission() {
        fixing = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
            p.arguments = ["reset", "Accessibility", "com.baney.polycarp"]
            try? p.run()
            p.waitUntilExit()
            DispatchQueue.main.async {
                self?.fixing = false
                self?.allow()
            }
        }
    }

    static func openAccessibilitySettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    func quitAeroSpace() {
        NSRunningApplication.runningApplications(withBundleIdentifier: "bobko.aerospace").forEach { $0.terminate() }
    }

    func pick(_ m: Modifier) {
        modifier = m
        Modifier.current = m
        onModifierChange?(m)
        reloadOptional()
    }

    /// `defaults` and `activateSettings` can take seconds, so they run off the main thread.
    func freeShortcuts() {
        freeing = true
        let m = modifier
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            SystemShortcuts.free(for: m)
            DispatchQueue.main.async { self?.freeing = false; self?.reloadOptional() }
        }
    }

    func restoreShortcuts() {
        freeing = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            SystemShortcuts.restore()
            DispatchQueue.main.async { self?.freeing = false; self?.reloadOptional() }
        }
    }

    func setViewerKeys(_ on: Bool) {
        viewerKeys = on
        onViewerKeysChange?(on)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.reloadOptional() }
    }

    func setTopDrag(_ on: Bool) {
        topDrag = on
        onTopDragChange?(on)
    }

    func setCmdTab(_ mode: MissionControlKeys.CmdTabMode) {
        cmdTab = mode
        onCmdTabChange?(mode)
    }

    func setWorkspaceDock(_ on: Bool) {
        workspaceDock = on
        onWorkspaceDockChange?(on)
    }

    func setDockAgentStatus(_ on: Bool) {
        dockAgentStatus = on
        onDockAgentStatusChange?(on)
    }

    /// After the picker's own update: the consent sheet is modal and must not run inside a SwiftUI binding.
    func pickAgentAccess(_ mode: AgentAccessMode) {
        DispatchQueue.main.async { [weak self] in
            self?.onAgentAccessPick?(mode)
            self?.agentAccess = AgentAccess.shared.current
        }
    }

    /// Settings > Agents, "Turn On Everything…". Asks in one sheet; nothing changes on a no.
    func turnOnEverything() {
        DispatchQueue.main.async { [weak self] in
            guard let self, AgentAccess.shared.requestEverything() else { return }
            self.agentAccess = AgentAccess.shared.current
            BrowserModel.shared.turnOnEverything()
        }
    }

    func installHooks() {
        onInstallHooks?()
        hooks = hooksInstalled()
    }

    func setLauncher(_ on: Bool) {
        launcherOnCmdSpace = on
        onLauncherChange?(on)
    }

    func addBang() {
        if let why = Bangs.problem(trigger: newTrigger, name: newName, url: newURL) { bangProblem = why; return }
        let bang = Bang(trigger: newTrigger, name: newName, url: newURL, agent: newIsAgent)
        do {
            customBangs = try Launcher.updateCustomBangs { Bangs.adding(bang, to: $0) ?? $0 }
            newTrigger = ""; newName = ""; newURL = ""; newIsAgent = false
            bangProblem = nil
        } catch {
            bangProblem = error.localizedDescription
        }
    }

    func removeBang(_ trigger: String) {
        do {
            customBangs = try Launcher.updateCustomBangs { $0.filter { $0.trigger != trigger } }
            bangProblem = nil
        } catch {
            bangProblem = error.localizedDescription
        }
    }

    /// Bangs changed elsewhere (the file, an agent) show up when setup opens.
    func reloadBangs() {
        let read = Launcher.readCustomBangs()
        customBangs = read.bangs
        bangProblem = read.problems.first
    }

    func setOpenAtLogin(_ on: Bool) {
        UserDefaults.standard.set(true, forKey: "loginItemChosen")
        do {
            try on ? SMAppService.mainApp.register() : SMAppService.mainApp.unregister()
        } catch {
            NSLog("Polycarp: open at login failed: %@", error.localizedDescription)
        }
        reloadOptional()
    }

    /// Setup's last act: start with the Mac unless the person already decided.
    func finish() {
        let defaults = UserDefaults.standard
        // Someone who already decided (here, or in 0.1, which recorded "loginItemOffered") keeps
        // their choice; so does anyone whose login item macOS already knows about.
        guard !defaults.bool(forKey: "loginItemChosen"), !defaults.bool(forKey: "loginItemOffered"),
              SMAppService.mainApp.status == .notRegistered else { return }
        defaults.set(true, forKey: "loginItemChosen")
        try? SMAppService.mainApp.register()
    }
}

/// The settings window's tabs. General comes first: it's where a new Mac starts.
enum SettingsTab: String, CaseIterable, Identifiable {
    case general = "General", keys = "Keys", dock = "Dock", appearance = "Appearance", launcher = "Launcher",
         automation = "Automation", permissions = "Permissions", updates = "Updates", agents = "Agents", voice = "Silas", browser = "Browser"
    var id: Self { self }

    var symbol: String? {
        switch self {
        case .general: "gearshape"
        case .keys: "keyboard"
        case .dock: "dock.rectangle"
        case .appearance: "paintpalette"
        case .launcher: "magnifyingglass"
        case .automation: "gearshape.2"
        case .permissions: "hand.raised"
        case .updates: "arrow.down.circle"
        case .agents: "cpu"
        case .voice: nil   // Silas draws its own pen (`SilasMark`); every consumer must handle the missing symbol
        case .browser: "globe"
        }
    }
}

/// Polycarp's settings: a sidebar of sections on the left and the chosen section on the right, in a window that never changes
/// size. It opens on General until Polycarp has what it needs to run.
struct SetupView: View {
    @ObservedObject var model: SetupModel
    @ObservedObject private var appearance = Appearance.shared
    @ObservedObject private var cursor = CursorController.shared
    @ObservedObject private var parts = PartsModel.shared
    @StateObject private var themes = ThemePicker()
    var close: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            SettingsSidebarView(selection: $model.tab)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(model.tab.rawValue).font(Chrome.font(20, .bold)).accessibilityAddTraits(.isHeader)
                    switch model.tab {
                    case .general: general
                    case .keys: keys
                    case .dock: dock
                    case .appearance: appearanceTab
                    case .launcher: launcher
                    case .automation: automation
                    case .permissions: PermissionsPane(fix: .init(shown: model.staleGrant, busy: model.fixing, run: model.fixPermission),
                                                       onAsk: { if $0 == .accessibility { model.askedForAccessibility() } })
                    case .updates: updates
                    case .agents: agents
                    case .voice: VoiceSettingsView()
                    case .browser: BrowserSettingsView()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(.horizontal, 28).padding(.top, 40).padding(.bottom, 28)
            }
            .id(model.tab)   // each section opens at its top
        }
        .frame(width: SettingsSidebar.windowSize.width, height: SettingsSidebar.windowSize.height)
        .foregroundStyle(Chrome.wash())
        .tint(Chrome.accent)
        .toggleStyle(.switch)   // every on-or-off setting is the same control
        .background(Chrome.panel())
        .environment(\.colorScheme, Chrome.scheme)
        // ⌘W closes the window, as in any Mac app; so does its close button.
        .background(Button("", action: close).keyboardShortcut("w", modifiers: .command).opacity(0).accessibilityHidden(true))
        // The content runs under the title bar; without this the title bar's inset pushes the fixed frame down and clips its bottom.
        .ignoresSafeArea()
    }

    private func binding<T>(_ get: @escaping () -> T, _ set: @escaping (T) -> Void) -> Binding<T> { Binding(get: get, set: set) }

    // MARK: General

    @ViewBuilder private var general: some View {
        SettingsGroup {
            SettingsBlock {
                HStack(spacing: 14) {
                    Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 44, height: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Polycarp").font(Chrome.font(15, .bold))
                        Text(parts.current.contains(.workspaces) ? "Nine workspaces. One row of keys." : "Bear much fruit.")
                            .font(Chrome.font(12)).foregroundStyle(Chrome.muted)
                    }
                    Spacer()
                    if parts.current.contains(.workspaces) || parts.current.contains(.voice) {
                        SettingsStatusLabel(text: model.trusted ? "Running" : "Needs a switch", done: model.trusted)
                    }
                }
            }
            if model.justEnabled && model.ready { SettingsNote("Polycarp is on. Try \(model.modifier.symbol)2.", tone: .done) }
        }

        PartsSection(parts: parts)

        if parts.current.contains(.workspaces) || parts.current.contains(.voice) {
        SettingsGroup("Permissions") {
            // Every permission, its state and its button live in the Permissions section.
            SettingsRow(model.trusted ? "Accessibility is on" : "Polycarp needs Accessibility",
                        help: "See and change every permission Polycarp uses in Permissions.") {
                Button("Open Permissions") { model.tab = .permissions }
            }
            if model.aeroSpaceRunning {
                SettingsRow("AeroSpace is running", help: "It uses the same keys. Polycarp starts as soon as it quits.") {
                    Button("Quit AeroSpace", action: model.quitAeroSpace)
                }
            }
            if model.desktops > 1 {
                SettingsRow("Extra macOS desktops", help: "You have \(model.desktops). Windows on the others are out of reach.") {
                    if !model.viewerKeys {
                        Button("Open Mission Control") { NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/Mission Control.app")) }
                    }
                }
                LearnMore(model.viewerKeys
                    ? "Polycarp's overview has replaced Mission Control. To close the extra desktops, turn off \"Use Polycarp's overview instead of Mission Control\" under Keys, open Mission Control, hover each extra desktop at the top and click its close button, then turn the switch back on."
                    : "Open Mission Control, hover each extra desktop at the top, and click its close button.")
            }
        }

        }

        SettingsGroup("Startup") {
            SettingsRow("Open Polycarp at login") {
                Toggle("Open Polycarp at login", isOn: binding({ model.openAtLogin }, { model.setOpenAtLogin($0) })).labelsHidden()
            }
            if model.loginNeedsApproval {
                SettingsRow("macOS needs your approval", help: "Approve Polycarp in Login Items.") {
                    Button("Approve") { SMAppService.openSystemSettingsLoginItems() }
                }
            }
        }

        // The old app, if it is still installed: a line, never a removal (see LegacyApp for why there is no button).
        let home = FileManager.default.homeDirectoryForCurrentUser
        if let note = LegacyApp.line(installed: LegacyApp.installed(in: LegacyApp.searchFolders(home: home)),
                                     supportDir: Product.supportDir(home: home)) {
            SettingsGroup { SettingsNote(note) }
        }

        SettingsGroup { SettingsNote("Full screen works as usual; switching workspaces takes a window out of it first. Settings… in the menu bar icon's menu opens this window (⌘,).") }

        SettingsGroup {
            SettingsRow("Uninstall Polycarp", help: "Puts things back as they were, then removes Polycarp.") {
                Button("Uninstall Polycarp…") { model.onUninstall?() }
            }
            LearnMore("Puts back your windows, the macOS Dock, the screenshot and Spotlight shortcuts and your Claude Code settings as they were, then removes Polycarp.")
        }
    }

    // MARK: Keys

    @ViewBuilder private var keys: some View {
        SettingsGroup("Workspace keys") {
            SettingsRow("Modifier", help: model.modifier.tradeoff) {
                Picker("Modifier", selection: binding({ model.modifier }, { model.pick($0) })) {
                    ForEach(Modifier.allCases) { Text($0.symbol).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 200)
            }
            SettingsRow("Go to a workspace") { Text("\(model.modifier.symbol)1 – \(model.modifier.symbol)9").font(Chrome.font(12).monospaced()).foregroundStyle(Chrome.muted) }
            SettingsRow("Send the front window there") { Text("\(model.modifier.symbol)⇧1 – \(model.modifier.symbol)⇧9").font(Chrome.font(12).monospaced()).foregroundStyle(Chrome.muted) }
            ForEach(model.conflicts, id: \.self) { c in
                SettingsRow(c) { Button(model.freeing ? "Working…" : "Free Them", action: model.freeShortcuts).disabled(model.freeing) }
            }
            if model.screenshotsFreed && model.conflicts.isEmpty {
                SettingsRow("macOS's own shortcuts for these keys are off") {
                    Button(model.freeing ? "Working…" : "Turn Them Back On", action: model.restoreShortcuts).disabled(model.freeing)
                }
            }
        }

        SettingsGroup("Overview") {
            SettingsRow("Use Polycarp's overview instead of Mission Control", help: "The Mission Control key, ⌃↑ and hot corners open it.") {
                Toggle("Overview", isOn: binding({ model.viewerKeys }, { model.setViewerKeys($0) })).labelsHidden()
            }
            if model.viewerKeysFailed {
                SettingsRow("Already on, still not working?", help: "macOS kept an old permission. Fixing removes it and asks again.") {
                    Button(model.fixing ? "Fixing…" : "Fix Permission", action: model.fixPermission).disabled(model.fixing)
                }
                LearnMore("macOS wouldn't let Polycarp watch the Mission Control key and ⌃↑, so macOS's Mission Control stays on until it does. The overview is always in the menu bar menu (Show All Workspaces).")
            } else {
                LearnMore("macOS's Mission Control is switched off in the Dock while Polycarp runs, and comes back, with your hot corners as they were, when you turn this off or quit. A Magic Mouse's two-finger double tap opens nothing while this is on.")
            }
            if let problem = model.missionControlFailed {
                SettingsNote("macOS's Mission Control is still on. \(problem) Polycarp tries again every few minutes.", tone: .urgent)
            }
            SettingsRow("Drag a window to the top to open the overview", help: "Drop it on a workspace to send it there.") {
                Toggle("Drag to top", isOn: binding({ model.topDrag }, { model.setTopDrag($0) })).labelsHidden()
            }
        }

        SettingsGroup("Full screen") {
            SettingsRow("The green button and ⌃⌘F fill the screen here", help: "Switching stays instant. macOS full screen slides each time.") {
                Toggle("Fill the screen", isOn: Binding(get: { FullScreenGestures.isEnabled }, set: { UserDefaults.standard.set($0, forKey: FullScreenFill.enabledKey); model.objectWillChange.send() })).labelsHidden()
            }
        }

        SettingsGroup("⌘Tab") {
            SettingsRow("⌘Tab switches") {
                Picker("⌘Tab switches", selection: binding({ model.cmdTab }, { model.setCmdTab($0) })) {
                    ForEach(MissionControlKeys.CmdTabMode.allCases) { Text($0.title).tag($0) }
                }
                .labelsHidden()
            }
            LearnMore(cmdTabNote)
        }
    }

    // MARK: Dock

    @ViewBuilder private var dock: some View {
        SettingsGroup("Workspace Dock") {
            SettingsRow("Workspace Dock in place of the macOS Dock", help: "Rest the pointer on the screen edge to see your workspaces and their apps.") {
                Toggle("Workspace Dock", isOn: binding({ model.workspaceDock }, { model.setWorkspaceDock($0) })).labelsHidden()
            }
            SettingsRow("Position on screen") {
                Picker("Position on screen", selection: binding({ model.dockEdge }, { model.dockEdge = $0; model.onDockEdgeChange?($0) })) {
                    ForEach(DockEdge.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .labelsHidden().disabled(!model.workspaceDock)
            }
            LearnMore("Click a workspace to go there. At the top the dock waits a moment longer, so reaching for the menu bar doesn't bring it up. The macOS Dock stays out of sight while this is on and comes back as it was when you turn it off or quit Polycarp.")
        }

        SettingsGroup("Agent status") {
            SettingsRow("Show what coding agents are doing on their app icons", help: "Click an app with a badge to go to that agent's tab.") {
                Toggle("Agent status", isOn: binding({ model.dockAgentStatus }, { model.setDockAgentStatus($0) })).labelsHidden()
                    .disabled(!model.workspaceDock)
            }
            SettingsBlock {
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 7) {
                    legend(AgentStatusBadge(state: .working, size: 16), "Working")
                    legend(AgentStatusBadge(state: .asking, size: 16), "Asking you something, such as a permission")
                    legend(AgentStatusBadge(state: .failed, size: 16), "Stopped on an error")
                    legend(Text("1").font(Chrome.font(10, .heavy, rounded: true)).foregroundStyle(Chrome.light())
                            .frame(width: 16, height: 16).background(Circle().fill(Chrome.finished)),
                           "Finished while you were away")
                }
                .opacity(model.dockAgentStatus && model.workspaceDock ? 1 : 0.4)
            }
        }

        SettingsGroup("Agent cursor") {
            SettingsRow("Show each agent's cursor on the agent workspace", help: "It never moves your pointer or takes a click.") {
                Toggle("Agent cursor", isOn: binding({ cursor.settings.enabled }, { cursor.setEnabled($0) })).labelsHidden()
            }
            SettingsRow("Look") {
                Picker("Look", selection: binding({ cursor.settings.resolvedTheme.name }, { cursor.setTheme($0) })) {
                    ForEach(cursor.themeNames, id: \.self) { Text($0.capitalized).tag($0) }
                }
                .labelsHidden().disabled(!cursor.settings.enabled || cursor.themeSetInFile)
            }
            if cursor.themeSetInFile { SettingsNote("The look is set in config.toml (behavior.cursor.theme).") }
            SettingsRow("Show when an agent is using a window", help: "A glowing edge and a name tag over the window. Clicks and keys still go to the window.") {
                Toggle("In-use veil", isOn: binding({ cursor.settings.veil }, { cursor.setVeil($0) })).labelsHidden().disabled(cursor.veilSetInFile)
            }
            if cursor.veilSetInFile { SettingsNote("Set in config.toml (behavior.cursor.veil).") }
            LearnMore("A small cursor with the agent's name glides to what it is working on, so you can follow it. It is drawn only inside the window the agent is using, only while that window is in sight, and never over a window in front of it. It shows on the agent workspace while you look at it, or over an app you lent. Its colors are its own. Agents can pick its look with polycarp-spaces agent cursor theme <name>, but only you can turn it or the veil off.")
        }

        if !model.finished.isEmpty {
            SettingsGroup("Finished while you were away") {
                ForEach(model.finished) { row in
                    SettingsBlock {
                        Button { model.focusFinished(row.id) } label: { Label(row.label, systemImage: "checkmark.circle").lineLimit(1) }
                            .buttonStyle(.link)
                    }
                }
            }
        }

        SettingsGroup("Agent hooks") {
            switch model.hooks {
            case .noClaudeCode:
                SettingsRow("Claude Code isn't set up on this Mac", help: "Once it is, install the hooks here.") {
                    Button("Install Hooks", action: model.installHooks)
                }
            case .unreadable:
                SettingsNote("~/.claude/settings.json isn't valid JSON, so Polycarp leaves it alone. Fix it, then come back here.", tone: .urgent)
            case .on:
                SettingsRow("Claude Code and Grok report to Polycarp") { SettingsStatusLabel(text: "On") }
            case .off:
                SettingsRow("Let Claude Code and Grok report to Polycarp", help: "They say when they start, finish, ask or hit an error.") {
                    Button("Install Hooks", action: model.installHooks)
                }
            }
        }
    }

    private func legend<Badge: View>(_ badge: Badge, _ text: String) -> some View {
        GridRow {
            badge.frame(width: 18, alignment: .center)
            Text(text).font(Chrome.font(12))
        }
    }

    // MARK: Automation

    @ViewBuilder private var automation: some View {
        SettingsGroup("Keep usable by automation") {
            SettingsNote("Checked apps aren't hidden on other workspaces, so automation tools can still click and type in them. Their windows are parked just out of view.")
            if let why = model.automationReason { SettingsNote(why, tone: .urgent) }
            if model.parkedRows.isEmpty {
                if model.automationReason == nil { SettingsNote("No apps with windows yet.") }
            } else {
                // Past eight rows the list scrolls inside the group.
                SettingsBlock {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(model.parkedRows) { row in
                                Toggle(row.on && row.animates ? "\(row.name) (hidden: it animates window moves)" : row.name,
                                       isOn: Binding(get: { row.on }, set: { _ in model.toggleParked(row.id) }))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .toggleStyle(.checkbox)   // a list to tick, as the note above says
                    .frame(height: CGFloat(min(model.parkedRows.count, 8)) * 24)
                    .disabled(model.automationReason != nil)
                }
            }
        }

        SettingsGroup("If windows get tangled") {
            SettingsRow("If windows get tangled", help: "Gathers every window onto workspace 1, all visible.") {
                Button("Bring Every Window Back") { model.onBringBack?() }.disabled(model.automationReason != nil)
            }
        }
    }

    // MARK: Updates

    @ViewBuilder private var updates: some View {
        SettingsGroup("Software update") {
            SettingsRow("You have \(model.update.have)") {
                Button("Check for Updates Now…") { model.onCheckForUpdates?() }
            }
            if let notice = model.update.notice, notice.installing {
                SettingsBlock { Label(notice.menuTitle, systemImage: "arrow.down.circle") }
            } else if let notice = model.update.notice {
                SettingsRow(notice.sentence, help: "Shows what's new first. Nothing installs until you press Update Now.") {
                    Button(notice.menuTitle) { model.onOfferUpdate?() }
                }
            }
            SettingsBlock {
                Picker("Follow", selection: binding({ model.update.channel }, { model.setUpdateChannel($0) })) {
                    Text("Stable: tested releases").tag(UpdateChannel.stable)
                    Text(model.update.nightlyNeedsTools ? "Nightly: needs Apple's command line tools" : "Nightly: newest changes, every night").tag(UpdateChannel.nightly)
                }
                .pickerStyle(.radioGroup)
            }
            SettingsRow("Check for updates daily") {
                Toggle("Daily", isOn: binding({ model.update.daily }, { model.setCheckDaily($0) })).labelsHidden()
            }
        }

        SettingsGroup("About") {
            SettingsBlock {
                HStack(spacing: 14) {
                    Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 44, height: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Polycarp").font(Chrome.font(15, .bold))
                        Text("\(model.modifier.symbol)1–\(model.modifier.symbol)9 to switch. Add ⇧ to bring the window along.")
                            .font(Chrome.font(11)).foregroundStyle(Chrome.muted)
                    }
                    Spacer()
                    Button("About Polycarp…") { model.onAbout?() }
                }
            }
        }
    }

    // MARK: Agents

    @ObservedObject private var browserModel = BrowserModel.shared

    @ViewBuilder private var agents: some View {
        SettingsGroup("Agent access") {
            SettingsBlock {
                Picker("Agent access", selection: binding({ model.agentAccess }, { model.pickAgentAccess($0) })) {
                    ForEach(AgentAccessMode.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden()
            }
            SettingsNote(model.agentAccess.detail, tone: model.agentAccess == .full ? .urgent : .quiet)
            SettingsNote("Only you change this, here or in the Polycarp menu. More access asks you first.")
            SettingsRow(AgentEverything.title, help: AgentEverything.why) {
                if AgentEverything.isOn(access: model.agentAccess, anySite: browserModel.status?.anySite, claudeAllowed: browserModel.status?.claudeAllowed ?? false, claudeReady: browserModel.status?.claudeReady ?? false) {
                    Text(AgentEverything.on).font(Chrome.font(12)).foregroundStyle(Chrome.muted)
                } else {
                    Button(AgentEverything.button) { model.turnOnEverything() }
                }
            }
        }

        SettingsGroup("Always allow") {
            SettingsRow("Agents open any site without asking", help: browserModel.status?.anySite == nil ? "Open your browser to change this." : "Otherwise they ask you before each new site.") {
                Toggle("Any site", isOn: binding({ browserModel.status?.anySite ?? false }, { browserModel.setAnySite($0) }))
                    .labelsHidden().toggleStyle(.switch)
                    .disabled(browserModel.busy || browserModel.status?.anySite == nil)
            }
            SettingsRow("Claude Code uses Polycarp without asking", help: browserModel.status?.claudeReady == true ? "Stops its prompt for Polycarp's tools. Its other tools still ask." : "Add Polycarp to Claude Code first, in Settings > Browser.") {
                Toggle("Claude Code", isOn: binding({ browserModel.status?.claudeAllowed ?? false }, { browserModel.setClaudeAllowed($0) }))
                    .labelsHidden().toggleStyle(.switch)
                    .disabled(browserModel.busy || browserModel.status?.claudeReady != true)
            }
            SettingsNote("Page scripts run without asking. For the fastest ones, turn on Allow user scripts at chrome://extensions > Polycarp > Details.")
            if let message = browserModel.message { SettingsNote(message, tone: .urgent) }
        }

        SettingsGroup("Sandbox") {
            SettingsRow("Allow the sandbox", help: "A throwaway macOS VM for agent work.") {
                Toggle("Sandbox", isOn: binding({ model.sandbox.enabled }, { var s = model.sandbox; s.enabled = $0; model.setSandbox(s) })).labelsHidden()
                    .disabled(model.sandboxHostProblem != nil)
            }
            if let why = model.sandboxHostProblem { SettingsNote(why, tone: .urgent) }
            SettingsRow("Memory") {
                Picker("Memory", selection: binding({ model.sandbox.memoryGB }, { var s = model.sandbox; s.memoryGB = $0; model.setSandbox(s) })) {
                    ForEach(SandboxSettings.memoryChoices, id: \.self) { Text("\($0) GB").tag($0) }
                }.labelsHidden().disabled(!model.sandbox.enabled || model.sandboxRunning)
            }
            SettingsRow("CPUs") {
                Picker("CPUs", selection: binding({ model.sandbox.cpus }, { var s = model.sandbox; s.cpus = $0; model.setSandbox(s) })) {
                    ForEach(SandboxSettings.cpuChoices, id: \.self) { Text("\($0)").tag($0) }
                }.labelsHidden().disabled(!model.sandbox.enabled || model.sandboxRunning)
            }
            SettingsRow("Handoff folder limit", help: "A guest that writes more than this is stopped.") {
                Picker("Handoff folder limit", selection: binding({ model.sandbox.handoffGB }, { var s = model.sandbox; s.handoffGB = $0; model.setSandbox(s) })) {
                    ForEach(SandboxSettings.handoffChoices, id: \.self) { Text("\($0) GB").tag($0) }
                }.labelsHidden().disabled(!model.sandbox.enabled)
            }
            SettingsRow(model.sandboxState, help: (model.sandboxDisk.isEmpty ? "" : "Disk used: \(model.sandboxDisk). ") + "Changes apply the next time it starts.") {
                HStack {
                    Button("Reset Now", action: model.sandboxReset).disabled(!model.sandboxRunning || model.sandboxBusy)
                    Button("Delete Images…", action: model.sandboxDeleteImages).disabled(model.sandboxRunning || model.sandboxBusy)
                        .help("Deletes the sandbox's VMs and the downloaded macOS image (about 24 GB, downloaded again next time)")
                }
            }
            if let p = model.sandboxProblem { SettingsNote(p, tone: .urgent) }
            LearnMore("Untrusted sites, throwaway logins and anything that installs software run in a virtual Mac that has no access to your files, iCloud, keychain, the Mac itself, your network or your tailnet: only the internet, and one handoff folder per task. It's deleted when the task ends, and a clean copy is kept ready so a reset takes seconds. Nothing starts until an agent asks.")
        }
    }

    // MARK: Appearance

    /// The shape, palette and accent, shown only with no Polycarp theme on: a theme draws instead of them.
    @ViewBuilder private var ownColors: some View {
        SettingsGroup("Style") {
            SettingsBlock {
                HStack(spacing: 10) {
                    ForEach(ThemeID.allCases, id: \.self) { t in
                        ThemeCard(theme: t, selected: appearance.settings.theme == t) { appearance.settings.theme = t }
                    }
                }
            }
            SettingsRow("Palette", help: appearance.settings.colorPalette == AppearanceSettings.autoPalette
                        ? "Auto: the panels' own dark look with your accent." : "Any theme takes any palette.") { paletteMenu }
        }

        SettingsGroup("Accent") {
            SettingsBlock {
                HStack(spacing: 7) {
                    ForEach(AccentPreset.allCases, id: \.self) { p in
                        swatch(Appearance.color(p.rgb), selected: appearance.settings.accent == .preset(p), name: p.title) {
                            appearance.settings.accent = .preset(p)
                        }
                    }
                    Divider().frame(height: 18)
                    Button { appearance.settings.accent = .system } label: {
                        HStack(spacing: 5) {
                            Circle().fill(Appearance.color(Appearance.systemAccent)).frame(width: 10, height: 10)
                            Text("System").font(Chrome.font(12))
                        }
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Chrome.pill().strokeBorder(appearance.settings.accent == .system ? Chrome.wash() : Chrome.wash(0.35),
                                                           lineWidth: Chrome.width(.settingsTile, focused: appearance.settings.accent == .system)))
                    }
                    .buttonStyle(.plain)
                    .help("Follow the accent color in System Settings")
                    ColorPicker("Custom accent", selection: Binding(
                        get: { Appearance.color(appearance.settings.accentRGB(system: Appearance.systemAccent)) },
                        set: { picked in
                            // The picker also answers with the color it was shown; that isn't a pick.
                            guard let rgb = Appearance.rgb(picked) else { return }
                            let shown = appearance.accentRGB
                            guard abs(rgb.r - shown.r) + abs(rgb.g - shown.g) + abs(rgb.b - shown.b) > 0.01 else { return }
                            appearance.settings.accent = .custom(rgb)
                        }), supportsOpacity: false)
                        .labelsHidden()
                        .help("Pick any color")
                }
            }
        }
    }

    @ViewBuilder private var appearanceTab: some View {
        SettingsGroup("Theme") {
            SettingsRow("Theme") {
                Picker("Theme", selection: binding({ themes.pendingName ?? appearance.polycarp?.name ?? ThemeChoice.ownColors }, { themes.pick(name: $0) })) {
                    ForEach(ThemeChoice.builtIn, id: \.name) { Text($0.title).tag($0.name) }
                    if let p = appearance.polycarp, !ThemeChoice.builtIn.contains(where: { $0.name == p.name }) { Text(p.title).tag(p.name) }
                    Divider()
                    Text("My own colors").tag(ThemeChoice.ownColors)
                }
                .labelsHidden().frame(width: 170).disabled(!themes.available)
            }
            if let p = appearance.polycarp {
                SettingsRow("Light or dark") {
                    Picker("Light or dark", selection: binding({ themes.pendingMode ?? p.mode }, { themes.pick(name: themes.pendingName ?? p.name, mode: $0) })) {
                        Text("Auto").tag(PolycarpTheme.Mode.auto)
                        Text("Light").tag(PolycarpTheme.Mode.light)
                        Text("Dark").tag(PolycarpTheme.Mode.dark)
                    }
                    .pickerStyle(.segmented).labelsHidden().frame(width: 190)
                    .disabled(!themes.available || themes.pendingName == ThemeChoice.ownColors)
                }
            }
            if !themes.available { SettingsNote("This copy of Polycarp doesn't include the theme command, so the theme can't change here.") }
            if let e = themes.error { SettingsNote(e, tone: .urgent) }
            LearnMore("Your theme colors Polycarp and stays through updates. In Terminal, polycarp theme set <name> does the same, and polycarp theme create mine starts your own.")
        }
        if appearance.polycarp == nil { ownColors }

        SettingsGroup("Workspace colors") {
            SettingsRow("Colors") {
                HStack(spacing: 10) {
                    Picker("Workspace colors", selection: binding({ appearance.settings.palette }, { appearance.settings.palette = $0 })) {
                        ForEach(WorkspacePalette.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented).labelsHidden().frame(width: 270)
                    Button("Reset") { appearance.settings.resetOverrides() }
                        .disabled(appearance.settings.overrides.isEmpty)
                        .help("Clear the colors picked for single workspaces")
                }
            }
            SettingsBlock {
                HStack(spacing: 6) {
                    ForEach(1...9, id: \.self) { n in
                        VStack(spacing: 1) {
                            ColorPicker("Workspace \(n)", selection: Binding(
                                get: { Chrome.workspace(n) },
                                set: { picked in
                                    guard let rgb = Appearance.rgb(picked) else { return }
                                    let shown = appearance.settings.workspaceColor(n, accent: appearance.accentRGB).rgb
                                    guard abs(rgb.r - shown.r) + abs(rgb.g - shown.g) + abs(rgb.b - shown.b) > 0.01 else { return }
                                    appearance.settings.overrides[n] = rgb
                                }), supportsOpacity: false)
                                .labelsHidden()
                            Text("\(n)").font(Chrome.font(10, .semibold)).foregroundStyle(appearance.settings.overrides[n] == nil ? Chrome.muted : Chrome.wash())
                        }
                    }
                }
            }
            SettingsNote("Click a color to change one workspace. Bright colors are dimmed so the numbers stay readable.")
        }

        SettingsGroup("Panels") {
            SettingsRow("Style") {
                Picker("Panel style", selection: binding({ appearance.settings.panelStyle }, { appearance.settings.panelStyle = $0 })) {
                    ForEach(PanelStyle.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 200)
                .disabled(!Chrome.spec.fill.adjustable)
            }
            SettingsRow("Opacity", help: Chrome.spec.fill.adjustable ? "Dock, ⌘Tab, launcher, overview and switch overlay. Solid is always opaque."
                        : "This look draws its own fill, so style and opacity don't change it.") {
                HStack(spacing: 8) {
                    Slider(value: binding({ appearance.settings.panelOpacity }, { appearance.settings.panelOpacity = $0 }),
                           in: AppearanceSettings.panelOpacityRange)
                        .accessibilityLabel("Panel opacity")
                        .frame(width: 120)
                        .disabled(appearance.settings.panelStyle == .solid || !Chrome.spec.fill.adjustable)
                    Text("\(Int((appearance.settings.effectivePanelOpacity * 100).rounded()))%")
                        .font(Chrome.font(12).monospacedDigit()).foregroundStyle(Chrome.muted).frame(width: 40, alignment: .trailing)
                }
            }
        }

        SettingsGroup("Dock size") {
            SettingsRow("Size") {
                Picker("Dock size", selection: binding({ appearance.settings.dockSize }, { appearance.settings.dockSize = $0 })) {
                    ForEach(DockSize.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 200)
            }
        }
    }

    /// Auto and the 22 palettes, each with its swatch.
    private var paletteMenu: some View {
        Menu {
            paletteItem(AppearanceSettings.autoPalette, "Auto")
            Divider()
            ForEach(PaletteCatalog.shared.palettes) { p in paletteItem(p.name, p.name) }
        } label: {
            let name = appearance.settings.colorPalette
            Label { Text(name == AppearanceSettings.autoPalette ? "Auto" : name) } icon: {
                Image(nsImage: PaletteSwatch.image(appearance.look.palette))
            }
        }
        .fixedSize()
    }

    private func paletteItem(_ name: String, _ title: String) -> some View {
        Button { appearance.settings.colorPalette = name } label: {
            let palette = PaletteCatalog.shared.named(name) ?? Palette.auto(accent: appearance.accentRGB)
            Label { Text(title) } icon: { Image(nsImage: PaletteSwatch.image(palette)) }
        }
    }

    private func swatch(_ color: Color, selected: Bool, name: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Circle().fill(color).frame(width: 20, height: 20)
                .overlay(Circle().strokeBorder(Chrome.wash(selected ? 0.9 : 0.15), lineWidth: Chrome.width(.settingsTile, focused: selected)))
                .padding(2)
        }
        .buttonStyle(.plain)
        .help(name)
        .accessibilityLabel(name)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    // MARK: Launcher

    @ViewBuilder private var launcher: some View {
        SettingsGroup("Launcher") {
            SettingsRow("⌘Space opens the Polycarp launcher instead of Spotlight", help: "One box for apps, files, tabs, the web and agents. ⌃⌘K opens it from any app.") {
                Toggle("Launcher on ⌘Space", isOn: binding({ model.launcherOnCmdSpace }, { model.setLauncher($0) })).labelsHidden()
            }
            LearnMore("Open apps, install and remove them, find files, terminal tabs and splits, browser tabs and agent windows, search the web and ask an agent, from one box. Off gives ⌘Space back to Spotlight; the launcher stays in the menu bar, the Workspace Dock and ⌃⌘K.")
            SettingsRow("Search the web with") {
                Picker("Search the web with", selection: $model.searchEngine) { ForEach(Bangs.engines, id: \.trigger) { Text($0.name).tag($0.trigger) } }
                    .labelsHidden()
            }
            SettingsRow("Ask questions (?) with", help: "Type !yt cats, !i sunsets or ? a question. Type ! to see every bang.") {
                Picker("Ask questions with", selection: $model.agent) { ForEach(Bangs.agents, id: \.trigger) { Text($0.name).tag($0.trigger) } }
                    .labelsHidden()
            }
        }
        SettingsGroup("Your bangs\(model.customBangs.isEmpty ? "" : " (\(model.customBangs.count))")") {
            bangEditor
            LearnMore("Agents and scripts can add bangs too: ~/Applications/Polycarp.app/Contents/MacOS/Polycarp --bangs add jira Jira 'https://acme.atlassian.net/browse/{q}'")
        }
    }

    /// Your own bangs: each a trigger, a name and an address with {q} where the words go.
    private var bangEditor: some View {
        SettingsBlock {
            VStack(alignment: .leading, spacing: 8) {
                // Past six, the list scrolls inside the group.
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(model.customBangs, id: \.trigger) { b in
                            HStack {
                                Text("!\(b.trigger)").monospaced().frame(width: 70, alignment: .leading)
                                Text(b.name + (b.isAgent ? " (agent)" : "")).lineLimit(1)
                                Text(b.url).font(Chrome.font(10)).foregroundStyle(Chrome.muted).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                Button { model.removeBang(b.trigger) } label: { Image(systemName: "minus.circle") }
                                    .buttonStyle(.borderless).help("Remove !\(b.trigger)")
                                    .accessibilityLabel("Remove !\(b.trigger)")
                            }
                        }
                    }
                }
                .frame(height: model.customBangs.isEmpty ? 0 : CGFloat(min(model.customBangs.count, 6)) * 22)
                HStack {
                    TextField("trigger", text: $model.newTrigger).frame(width: 70)
                    TextField("Name", text: $model.newName).frame(width: 100)
                    TextField("https://example.com/search?q={q}", text: $model.newURL)
                }
                .textFieldStyle(.roundedBorder)
                HStack {
                    Toggle("It's an AI agent", isOn: $model.newIsAgent)
                    Spacer()
                    Button("Add Bang", action: model.addBang)
                }
                if let why = model.bangProblem { Text(why).font(Chrome.font(11)).foregroundStyle(Chrome.urgent) }
                Text("A bang with a built-in's trigger replaces it.").font(Chrome.font(11)).foregroundStyle(Chrome.muted)
            }
        }
    }

    private var cmdTabNote: String {
        switch model.cmdTab {
        case .off: "macOS's own app switcher. It only reaches apps on the workspace you're on."
        case .apps: "Hold ⌘ and tap Tab to step through every app with a window, on any workspace, most recent first; let go to go straight to it. ⌘⇧Tab steps back and Esc cancels."
        case .workspaces: "Hold ⌘ and tap Tab to step through your workspaces, most recent first; let go to go there. ⌘⇧Tab steps back and Esc cancels."
        }
    }
}

/// Runs the bundled `polycarp theme` command for a pick in Settings, one at a time and in order, so the last pick is the one that
/// stays. The theme's file changes and the app's watcher redraws within about a second, so a pick shows at once and lets go after
/// that. Only the latest pick may clear what's shown or report a failure.
final class ThemePicker: ObservableObject {
    @Published private(set) var pendingName: String?
    @Published private(set) var pendingMode: PolycarpTheme.Mode?
    @Published private(set) var error: String?

    private let queue = DispatchQueue(label: "polycarp.settings.theme", qos: .userInitiated)
    private var latest = 0
    private var command: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/bin/polycarp") }
    var available: Bool { FileManager.default.isExecutableFile(atPath: command.path) }

    func pick(name: String, mode: PolycarpTheme.Mode? = nil) {
        guard available else { return }
        latest += 1
        let pick = latest
        pendingName = name; pendingMode = mode; error = nil
        let command = command
        queue.async { [weak self] in
            let why = Self.run(command, ThemeChoice.arguments(name: name, mode: mode))
            DispatchQueue.main.asyncAfter(deadline: .now() + (why == nil ? 1.5 : 0)) { [weak self] in
                guard let self, pick == self.latest else { return }
                self.pendingName = nil; self.pendingMode = nil
                self.error = why
            }
        }
    }

    /// nil when it worked, or the command's own last line of complaint.
    private static func run(_ command: URL, _ arguments: [String]) -> String? {
        let p = Process()
        let errors = Pipe()
        p.executableURL = command
        p.arguments = arguments
        p.standardOutput = FileHandle.nullDevice
        p.standardError = errors
        do { try p.run() } catch { return "That theme didn't apply: \(error.localizedDescription)" }
        let data = errors.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus != 0 else { return nil }
        let last = String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline).last.map(String.init)
        return "That theme didn't apply" + (last.map { ": \($0)" } ?? ".")
    }
}

final class SetupWindowController: NSWindowController, NSWindowDelegate {
    let model = SetupModel()
    private var activeObserver: NSObjectProtocol?
    /// The window taking the keyboard, and apps launching or quitting: kept so `deinit` can remove them.
    private var observers: [(center: NotificationCenter, token: NSObjectProtocol)] = []

    convenience init() {
        // A fixed size: the sections scroll inside it, so the window never changes shape. The title bar blends with the sidebar.
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: NSSize(width: SettingsSidebar.windowSize.width, height: SettingsSidebar.windowSize.height)),
                              styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        self.init(window: window)
        window.title = "Polycarp Settings"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.delegate = self
        model.windowVisible = { [weak window] in window?.isVisible == true }
        let host = NSHostingView(rootView: SetupView(model: model) { [weak window] in window?.close() })
        host.sizingOptions = []   // the window alone owns its size
        window.contentView = host
        window.setContentSize(SettingsSidebar.windowSize)
        window.center()
        // The title bar's controls follow the theme, not the Mac's own light or dark.
        func matchTheme() { window.appearance = NSAppearance(named: Chrome.scheme == .dark ? .darkAqua : .aqua) }
        matchTheme()
        observers.append((NotificationCenter.default, NotificationCenter.default.addObserver(
            forName: Appearance.didChange, object: nil, queue: .main) { _ in matchTheme() }))
        // On grant: come forward, celebrate, then get out of the way.
        model.onReady = { [weak self] in
            NSApp.activate(ignoringOtherApps: true)
            self?.window?.makeKeyAndOrderFront(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self, self.model.ready, self.window?.isVisible == true else { return }
                self.window?.close()
            }
        }
        // The window taking the keyboard (opened, or clicked back to) reads the lists again.
        observers.append((NotificationCenter.default, NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) { [weak self] _ in
            self?.model.reload()
            self?.model.reloadParked()
        }))
        // An app launching or quitting changes the list on the Automation tab; a launch has no
        // windows for a moment, so it's read once soon after. Later windows are caught by the
        // model's slow read while the tab is up.
        let workspace = NSWorkspace.shared.notificationCenter
        for (name, delay) in [(NSWorkspace.didLaunchApplicationNotification, 1.5), (NSWorkspace.didTerminateApplicationNotification, 0.3)] {
            observers.append((workspace, workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    guard let self, self.window?.isVisible == true, self.model.tab == .automation else { return }
                    self.model.reloadParked()
                }
            }))
        }
        // Coming back from System Settings re-checks at once instead of waiting for the next tick.
        activeObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification,
                                                                object: nil, queue: .main) { [weak self] _ in
            guard self?.window?.isVisible == true else { return }
            self?.model.reload()
        }
    }

    deinit {
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
        for o in observers { o.center.removeObserver(o.token) }
    }

    var isVisible: Bool { window?.isVisible == true }

    func show() {
        model.justEnabled = false
        if !model.ready { model.tab = model.trusted ? .general : .permissions }
        model.dockAgentStatus = WorkspaceDock.agentStatus
        model.reload()
        model.reloadParked()
        if model.tab == .updates { model.onUpdatesShown?() }
        model.reloadBangs()
        model.startWatching()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ n: Notification) {
        model.stopWatching()
        model.finish()
    }
}
