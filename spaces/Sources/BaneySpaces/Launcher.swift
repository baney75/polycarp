import AppKit
import BaneySpacesCore
import Carbon.HIToolbox
import SwiftUI
import UniformTypeIdentifiers

/// One place to open, find, install, update and remove apps, find files, and run the Mac's
/// everyday commands. Type to search everything at once, or pick a menu (Apps, Files, Install,
/// Remove, Update, System, Workspaces) and search inside it. It can take ⌘Space from Spotlight.
enum Launcher {
    /// ⌘Space opens the launcher instead of Spotlight. Off unless chosen.
    static var onCmdSpace: Bool {
        get { UserDefaults.standard.bool(forKey: "launcherOnCmdSpace") }
        set { UserDefaults.standard.set(newValue, forKey: "launcherOnCmdSpace") }
    }

    /// The engine a plain web search uses: `search.engine` in surfaces.json, the one setting the launcher, the new tab
    /// page and `polycarp-spaces search` read (Google unless chosen; `OneSearch.engine` resolves it).
    static var searchEngine: String { SurfacesStore.shared.current.search.engine }

    /// Writes `search.engine`; nil when it was saved, else why not (an invalid surfaces.json, a value it refuses).
    static func setSearchEngine(_ engine: String) -> String? {
        guard case .failure(let f) = SurfacesOps.set("search.engine", .string(engine), file: SurfacesFile.path()) else { return nil }
        Trace.log("search engine not saved: \(f.message)")
        return f.message
    }

    /// Where the launcher kept its engine before `search.engine`.
    static let oldSearchEngineKey = "launcherSearchEngine"

    /// Moves an engine chosen before `search.engine` into surfaces.json once (`OneSearch.moveOldEngine` decides), then
    /// forgets the old key. A file that can't be read or written now keeps the key, so the choice moves once it can.
    static func moveOldSearchEngine(file: String = SurfacesFile.path()) {
        let defaults = UserDefaults.standard
        let old = defaults.string(forKey: oldSearchEngineKey)
        switch OneSearch.moveOldEngine(old, file: SurfacesFile.load(path: file)) {
        case .keep:
            if old != nil { Trace.log("search engine \(old ?? "") not moved yet: surfaces.json can't be read") }
        case .forget:
            defaults.removeObject(forKey: oldSearchEngineKey)
        case .write(let engine):
            switch SurfacesOps.set("search.engine", .string(engine), file: file) {
            case .success:
                defaults.removeObject(forKey: oldSearchEngineKey)
                Trace.log("search engine \(engine) moved into surfaces.json")
            case .failure(let f):
                Trace.log("search engine \(engine) not moved into surfaces.json: \(f.message)")
            }
        }
    }

    /// Opens a web address in your browser on the workspace the person is on, when that can be done; the closure is the
    /// caller's own way, run if it turns out it can't.
    static var openHere: (URL, @escaping () -> Void) -> Bool = { _, _ in false }

    /// Your browser (Settings › Default apps), else macOS's.
    static var browser: URL? {
        DefaultAppsStore.shared.now.resolved[.browser]?.app?.path.map { URL(fileURLWithPath: $0) }
            ?? NSWorkspace.shared.urlForApplication(toOpen: URL(string: "https://example.com")!)
    }

    /// A web address in your browser, never an app that claims the link; Apple Maps and anything else go where macOS
    /// sends them.
    static func openInBrowser(_ url: URL) {
        if ["http", "https"].contains(url.scheme?.lowercased() ?? ""), openHere(url, { openAnyway(url) }) { return }
        openAnyway(url)
    }

    private static func openAnyway(_ url: URL) {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let browser else {
            NSWorkspace.shared.open(url)
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.open([url], withApplicationAt: browser, configuration: config) { _, error in
            guard error != nil else { return }
            DispatchQueue.main.async { NSWorkspace.shared.open(url) }
        }
    }

    /// The agent a "?" question goes to: the one picked for it, else your default agent where it has a page that takes
    /// a question, else Claude.
    static var agent: String {
        get {
            UserDefaults.standard.string(forKey: "launcherAgent")
                ?? RoleSearch.webAgent(DefaultAppsStore.shared.now.resolved[.agent]?.app?.app) ?? "claude"
        }
        set { UserDefaults.standard.set(newValue, forKey: "launcherAgent") }
    }

    /// Your own bangs, as JSON: [{"trigger": "jira", "name": "Jira", "url": "https://…/browse/{q}"}].
    static let customBangsURL = Spaces.folder.appendingPathComponent("bangs.json")

    /// The bangs you added, and anything wrong with the file. No file is no bangs, not a problem.
    static func readCustomBangs() -> (bangs: [Bang], problems: [String], readable: Bool) {
        guard let data = try? Data(contentsOf: customBangsURL) else {
            let exists = FileManager.default.fileExists(atPath: customBangsURL.path)
            return ([], exists ? ["bangs.json can't be read."] : [], !exists)
        }
        return Bangs.decodeCustom(data)
    }

    enum SaveError: LocalizedError {
        case unreadable(String)
        var errorDescription: String? {
            switch self { case .unreadable(let why): "\(why) Fix or delete \(Launcher.customBangsURL.path) first, so nothing in it is lost." }
        }
    }

    /// Saves the list with `change` applied to what's on disk now. Refuses when the file can't be
    /// read as a list (writing would erase it), and throws if the write itself fails.
    @discardableResult
    static func updateCustomBangs(_ change: ([Bang]) -> [Bang]) throws -> [Bang] {
        let current = readCustomBangs()
        // Any entry it couldn't use would be dropped by saving, so it waits until the file is fixed.
        guard current.readable, current.problems.isEmpty else {
            throw SaveError.unreadable(current.problems.first.map { "bangs.json: \($0)" } ?? "bangs.json can't be read.")
        }
        let list = change(current.bangs)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try FileManager.default.createDirectory(at: Spaces.folder, withIntermediateDirectories: true)
        try enc.encode(list).write(to: customBangsURL, options: .atomic)
        return list
    }

    static func loadBangs() -> [Bang] { Bangs.all(custom: readCustomBangs().bangs) }

    /// `BaneySpaces --bangs list | add <trigger> <name> <address with {q}> [--agent] | remove <trigger>`:
    /// for scripts and agents. The running app picks changes up the next time the launcher opens.
    static func commandLine(_ args: [String]) -> Int32 {
        func out(_ s: String) { FileHandle.standardOutput.write(Data((s + "\n").utf8)) }
        func err(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }
        let usage = """
        usage: Polycarp --bangs list
               Polycarp --bangs add <trigger> <name> <address with {q}> [--agent]
               Polycarp --bangs remove <trigger>
        Example: Polycarp --bangs add jira Jira 'https://acme.atlassian.net/browse/{q}'
        """
        switch args.first {
        case "list", nil:
            let read = readCustomBangs()
            read.problems.forEach { err("bangs.json: \($0)") }
            let mine = Set(read.bangs.map(\.trigger))
            for b in Bangs.all(custom: read.bangs) {
                out("!\(b.trigger)\t\(b.name)\t\(b.url)\(b.isAgent ? "\tagent" : "")\(mine.contains(b.trigger) ? "\tcustom" : "")")
            }
            return 0
        case "add":
            let rest = args.dropFirst().filter { $0 != "--agent" }
            guard rest.count == 3 else { err(usage); return 2 }
            let r = Array(rest)
            if let why = Bangs.problem(trigger: r[0], name: r[1], url: r[2]) { err(why); return 1 }
            let bang = Bang(trigger: r[0], name: r[1], url: r[2], agent: args.contains("--agent"))
            do {
                let list = try updateCustomBangs { Bangs.adding(bang, to: $0) ?? $0 }
                guard let added = list.last else { return 1 }
                out("Added !\(added.trigger) (\(added.name)).")
                return 0
            } catch {
                err(error.localizedDescription)
                return 1
            }
        case "remove":
            guard args.count == 2 else { err(usage); return 2 }
            let t = args[1].lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "! "))
            guard readCustomBangs().bangs.contains(where: { $0.trigger == t }) else {
                err("No bang of yours is !\(t). Built-in bangs can be replaced by adding one with the same trigger.")
                return 1
            }
            do {
                try updateCustomBangs { $0.filter { $0.trigger != t } }
                out("Removed !\(t).")
                return 0
            } catch {
                err(error.localizedDescription)
                return 1
            }
        default:
            err(usage)
            return 2
        }
    }

    /// Opens the custom bangs file, writing an example first if there isn't one.
    static func editCustomBangs() {
        if !FileManager.default.fileExists(atPath: customBangsURL.path) {
            let example = """
            [
              {"trigger": "jw", "name": "JW Player docs", "url": "https://docs.jwplayer.com/search?q={q}"},
              {"trigger": "ask", "name": "Claude", "url": "https://claude.ai/new?q={q}", "agent": true}
            ]

            """
            try? FileManager.default.createDirectory(at: Spaces.folder, withIntermediateDirectories: true)
            try? example.write(to: customBangsURL, atomically: true, encoding: .utf8)
        }
        let edit = NSWorkspace.OpenConfiguration()
        let textEdit = URL(fileURLWithPath: "/System/Applications/TextEdit.app")
        NSWorkspace.shared.open([customBangsURL], withApplicationAt: textEdit, configuration: edit)
    }
}

/// What the launcher can do in the rest of BaneySpaces.
struct LauncherActions {
    var focusApp: (pid_t, Int?) -> Void = { _, _ in }
    /// A new window of a running app on the workspace you're on; calls the second argument when it can't make one.
    /// It reads the app's menus off the main thread, so it answers later.
    var openWindowHere: (pid_t, @escaping () -> Void) -> Void = { _, orElse in orElse() }
    /// Whether a running app has a New Window command, answered on the main thread after a look off it.
    var canOpenWindow: (pid_t, @escaping (Bool) -> Void) -> Void = { _, done in done(false) }
    var current: () -> Int = { 1 }
    var switchTo: (Int) -> Void = { _ in }
    var appsOn: (Int) -> [String] = { _ in [] }
    /// Workspaces each running app (by bundle path) has windows on, as Polycarp last knew them: it reads nothing.
    var workspacesByApp: () -> [String: [Int]] = { [:] }
    /// Brings what the open drew from up to date (the running apps, the windows that are gone) and says when: the running
    /// apps are read off the main thread, so the open draws first.
    var lookAgain: (@escaping () -> Void) -> Void = { $0() }
    var showOverview: () -> Void = {}
    var bringBack: () -> Void = {}
    /// Apps running with no window to see (`BackgroundApps`), read once when the launcher opens. The answer comes
    /// back on the main thread after the open has drawn: the read of every running app runs off it (`RunningApps.prepare`).
    var restingApps: (@escaping ([BackgroundApps.Entry]) -> Void) -> Void = { $0([]) }
    /// Brings a resting app forward onto the workspace you're on (`Spaces.showBackgroundApp`).
    var showResting: (pid_t) -> Void = { _ in }
    /// Quits a resting app the way its Quit menu would, and says whether it went: one with something unsaved may stay.
    var quitResting: (pid_t, @escaping (Bool) -> Void) -> Void = { $1(false) }
    var checkForUpdates: () -> Void = {}
    var showSetup: () -> Void = {}
    /// Another Claude Code session beside the ones running, in Ghostty.
    var newClaude: () -> Void = {}
    /// A new window of your terminal, where you were working.
    var newTerminal: () -> Void = {}
    /// Your agent, there too, with this as its first message.
    var askAgent: (String) -> Void = { _ in }
    /// Where you were working when the launcher opened.
    var folder: () -> String? = { nil }
    /// Settings › Default apps.
    var showDefaultApps: () -> Void = {}
    /// The session rows (terminal splits, browser tabs, agents) that answer a query; with nothing
    /// typed, only the agents that finished or need you.
    var sessionItems: (String) -> [LauncherItem] = { _ in [] }
    /// The tab already open in the main browser that answers a web search, as a "Switch to" row (`OneSearch.sessions`).
    var browserTab: (String) -> LauncherItem? = { _ in nil }
    /// What the browsers running the Polycarp extension have that answers a query (`BrowserBook`), and going there.
    var browserHits: (String) -> [BrowserHit] = { _ in [] }
    var openBrowser: (BrowserHit) -> Void = { _ in }
    var siteIcon: (BrowserHit) -> NSImage? = { _ in nil }
    /// The browser that can search with its own engine, and doing it.
    var searcher: () -> BrowserPeer? = { nil }
    var searchIn: (String, BrowserPeer) -> Void = { _, _ in }
    /// The tab group a name means, and sending it to a workspace.
    var tabGroup: (String) -> (peer: BrowserPeer, row: BrowserRow)? = { _ in nil }
    var sendGroup: (BrowserPeer, BrowserRow, Int) -> Void = { _, _, _ in }
    /// An empty tab in a browser, on this workspace.
    var newTab: (BrowserPeer) -> Void = { _ in }
    /// The person's web apps, opening one, and the page in front on this workspace.
    var webApps = WebAppStore.shared
    var openWebApp: (WebApp) -> Void = { _ in }
    var frontPage: () -> BrowserWindows.Front? = { nil }
    /// A page to its browser's Reader or library; false when that browser is gone.
    var sharePage: (BrowserWindows.Front, BrowserShare.Place) -> Bool = { _, _ in false }
    /// The launcher is opening: read every app's tabs and splits again, since the session engine
    /// reads background tabs only now and then (`Sweep`). They arrive through `rowsChanged`.
    var willShow: () -> Void = {}
}

final class LauncherController: NSObject, NSWindowDelegate {
    let model: LauncherModel
    private var panel: LauncherPanel?

    init(actions: LauncherActions) {
        model = LauncherModel(actions: actions)
        super.init()
        model.close = { [weak self] in self?.hide() }
        // The sheet can change the panel's width while it is open.
        restyle = NotificationCenter.default.addObserver(forName: StyleSheetStore.didChange, object: nil, queue: .main) { [weak self] _ in
            Styles.shared.sync()
            if let p = self?.panel, p.isVisible { self?.place(p, on: p.screen) }
        }
    }

    private var restyle: NSObjectProtocol?

    var isShown: Bool { panel?.isVisible == true }

    func toggle() { isShown ? hide() : show() }

    /// Opened on text the person chose on a page.
    func find(_ text: String) {
        show()
        model.setQuery(text)
    }

    func rowsChanged() { if isShown { model.rowsChanged() } }

    /// `takeKeys: false` (opened by a link) shows it without taking the keyboard, so typing meant
    /// for another app never lands in it; a click on it takes the keyboard.
    func show(scope: LauncherModel.Scope = .root, takeKeys: Bool = true) {
        let clock = OpenClock(panel == nil ? "launcher-first" : "launcher")
        defer { clock.shown() }
        let p = panel ?? makePanel()
        panel = p
        model.prepare(scope: scope)
        place(p, on: NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) })
        // Drawn with the new list before it appears, never with the last one's.
        p.contentView?.layoutSubtreeIfNeeded()
        p.alphaValue = 1
        if takeKeys { p.makeKeyAndOrderFront(nil) } else { p.orderFrontRegardless(); watchClicksElsewhere() }
        p.displayIfNeeded()
        if let field = model.field { p.makeFirstResponder(field) }
    }

    private func place(_ p: LauncherPanel, on screen: NSScreen?) {
        let screen = screen ?? NSScreen.main ?? NSScreen.screens[0]
        let size = LauncherView.size(Styles.shared.book.launcher.panel, within: screen.visibleFrame.width)
        // A little above center, where Spotlight sits.
        let origin = NSPoint(x: screen.visibleFrame.midX - size.width / 2,
                             y: screen.visibleFrame.minY + screen.visibleFrame.height * 0.62 - size.height / 2)
        p.setFrame(NSRect(origin: origin, size: size), display: false)
    }

    func hide() {
        model.pendingReturn = nil
        if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
        guard let p = panel, p.isVisible else { return }
        p.orderOut(nil)
    }

    /// Without the keyboard, a launcher a link opened can't see Esc or lose focus; a click in any
    /// other app puts it away instead.
    private var clickMonitor: Any?
    private func watchClicksElsewhere() {
        if clickMonitor != nil { return }
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            guard let self, self.panel?.isKeyWindow != true else { return }
            self.hide()
        }
    }

    /// Clicking anywhere else puts it away, like Spotlight.
    func windowDidResignKey(_ notification: Notification) {
        if !model.alertOpen { hide() }
    }


    private func makePanel() -> LauncherPanel {
        let p = LauncherPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .modalPanel
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        p.delegate = self
        p.contentView = NSHostingView(rootView: LauncherView(model: model).environment(\.colorScheme, .dark))
        p.onKeys = { [weak self] in self?.model.toggleKeys() }
        return p
    }
}

/// Takes the keyboard without bringing BaneySpaces forward, so the app you were in stays in front.
final class LauncherPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    /// ⌘K: every shortcut, and ⌘K again goes back.
    var onKeys: (() -> Void)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // ⌘ alone among ⌘⇧⌃⌥, so Caps Lock, fn and the keypad flag never stop it.
        let flags = CGEventFlags(rawValue: UInt64(event.modifierFlags.rawValue))
        if KeysHold.commandOnly(flags), event.keyCode == UInt16(kVK_ANSI_K), let onKeys {
            onKeys()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

// MARK: Model

struct LauncherItem: Identifiable {
    enum Icon {
        case file(String)
        case symbol(String)
        case image(NSImage)
        case remote(URL?)
    }
    enum State: Equatable { case idle, working, failed }

    let id: String
    var section: String
    var title: String
    var subtitle: String = ""
    var icon: Icon
    /// Shown at the right: "Install", "Installed", "Failed".
    var badge: String = ""
    /// Workspaces shown at the right as colored numbers.
    var workspaces: [Int] = []
    var state = State.idle
    var run: () -> Void
    /// ⌘↩: show in Finder, or a cask's web page.
    var reveal: URL?
    /// ⌘↩ does this instead, when set (a person's second action), named in the footer.
    var alternate: (() -> Void)?
    var alternateTitle = ""
}

final class LauncherModel: ObservableObject {
    enum Scope: String, CaseIterable {
        case root, web, apps, files, install, remove, update, system, workspaces, keys

        var title: String {
            switch self {
            case .root: "Search"
            case .web: "Search the Web"
            case .apps: "Apps"
            case .files: "Files"
            case .install: "Install"
            case .remove: "Remove"
            case .update: "Update"
            case .system: "System"
            case .workspaces: "Workspaces"
            case .keys: "Shortcuts"
            }
        }
        var symbol: String {
            switch self {
            case .root: "magnifyingglass"
            case .web: "globe"
            case .apps: "square.grid.2x2"
            case .files: "doc.text.magnifyingglass"
            case .install: "arrow.down.circle"
            case .remove: "trash"
            case .update: "arrow.triangle.2.circlepath"
            case .system: "gearshape"
            case .workspaces: "rectangle.split.3x3"
            case .keys: "keyboard"
            }
        }
        var blurb: String {
            switch self {
            case .root: ""
            case .web: "Bangs like !yt and !i, and AI agents like !claude"
            case .apps: "Every app on this Mac"
            case .files: "Any file or folder in your home folder and iCloud Drive, by name"
            case .install: "Thousands of apps from Homebrew and the App Store"
            case .remove: "Uninstall apps Homebrew installed"
            case .update: "Homebrew apps, macOS and Polycarp"
            case .system: "Lock, sleep, restart, dark mode and more"
            case .workspaces: "Go to any of the nine"
            case .keys: "Every Polycarp shortcut and where it works (⌘K)"
            }
        }
        var placeholder: String {
            switch self {
            case .root: "Search apps, files and the web"
            case .files: "Search files and folders by name"
            case .web: "Search the web, or !bang, or ? to ask"
            case .install: "Search for an app to install"
            case .keys: "Search shortcuts: workspace, terminal, ⌘1"
            default: "Search \(title.lowercased())"
            }
        }
    }

    enum Job: Equatable { case installing, removing, failed(String) }

    @Published var query = "" {
        didSet {
            guard query != oldValue else { return }
            let started = ProcessInfo.processInfo.systemUptime
            selected = 0
            rebuild()
            searchStore()
            searchFiles()
            if let line = KeyPressCheck.slowLine(seconds: ProcessInfo.processInfo.systemUptime - started,
                                                 typed: query.count, rows: items.count) { Trace.log(line) }
        }
    }
    @Published private(set) var scope = Scope.root
    @Published private(set) var items: [LauncherItem] = []
    /// A list no search made, for the renders.
    func sample(_ list: [LauncherItem]) { items = list; selected = 0 }
    @Published var selected = 0
    @Published private(set) var jobs: [String: Job] = [:]
    @Published private(set) var storeResults: [StoreApp] = []
    @Published private(set) var catalogState = CaskCatalog.State.idle
    weak var field: NSTextField?
    var close: () -> Void = {}
    var alertOpen = false

    private let actions: LauncherActions
    /// Every app, with its search key folded once, so a keystroke scores names without folding them again.
    private var apps: [AppEntry] = []
    private var running: [String: [Int]] = [:]
    /// Running apps by bundle path, so rows don't walk them on every keystroke: the last read's when the launcher opens, and
    /// a new read's a moment later (`catchUp`).
    private var runningPids: [String: pid_t] = [:]
    /// Apps running with no window to see, read when the launcher opens (`LauncherActions.restingApps`).
    private var resting: [BackgroundApps.Entry] = []
    /// The resting apps this list has a row for, so each is listed once.
    private var restingListed: Set<pid_t> = []
    /// Resting apps asked to quit that haven't gone.
    private var quitting: Set<pid_t> = []
    /// Bumped by every open, so an answer for an earlier open is dropped.
    private var restingAsk = 0
    private var recents = Recents(UserDefaults.standard.stringArray(forKey: "launcherRecents") ?? [])
    private var iconCache: [String: NSImage] = [:]
    private let catalog = CaskCatalog()
    private var storeWork: DispatchWorkItem?
    /// Files Spotlight found for the query, best first. A newer search makes an older one stale.
    private var fileResults: [FileSearch.Hit] = []
    /// What `fileResults` were found for. Until a newer search answers, they're shown only while
    /// they still match what's typed.
    private var fileResultsQuery = ""
    private var fileWork: DispatchWorkItem?
    private var fileSearches = 0
    private var bangs = Launcher.loadBangs()
    /// Terminal agents found on this Mac: command to path.
    var agents: [String: String] = [:]
    /// Calculator and the other providers, asked on every keystroke of the main search.
    /// The rooms first: a room's name or mark ("know", "=") is that room, above an app that starts the same.
    var providers: [LauncherProvider] = [RoomsProvider.shared] + LauncherProviders.standard(terminal: TerminalFeature.built) + [ContactsLibrary.shared.provider]
    /// People's pictures, made once from their image data.
    private let contactImages: NSCache<NSString, NSImage> = {
        let c = NSCache<NSString, NSImage>()
        c.countLimit = 100
        return c
    }()

    init(actions: LauncherActions) {
        self.actions = actions
        // The first open draws from a read of the running apps, as every later one does.
        RunningApps.prepare {}
        // The disk scan runs off the main thread; `prepare` keeps the list fresh after that.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let fresh = AppEntry.scan()
            DispatchQueue.main.async { self?.took(fresh) }
        }
    }

    /// False until the first app list lands. Until then Return waits for it (at most a second), so it never runs a web
    /// search or a file row the app you typed would have topped.
    private var appsLanded = false
    /// A Return pressed before the first app list landed (its reveal flag).
    var pendingReturn: Bool?

    /// A new app list from a scan off the main thread: rows rebuild only when it changed. The first list keeps the top
    /// row selected unless you moved off it.
    private func took(_ fresh: [AppEntry]) {
        let first = !appsLanded
        appsLanded = true
        if fresh != apps {
            apps = fresh
            // A query an app's name holds ("text edit") is that app, never a contact verb.
            ContactsLibrary.shared.provider.useApps(fresh.map(\.name))
            if first, selected == 0 { rebuild() } else { rebuildKeepingSelection() }
        }
        if let reveal = pendingReturn { pendingReturn = nil; runSelected(reveal: reveal) }
    }

    /// The same scan, after Homebrew installed or removed an app.
    private func rescanApps() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let fresh = AppEntry.scan()
            DispatchQueue.main.async { self?.took(fresh) }
        }
    }

    func prepare(scope: Scope) {
        actions.willShow()
        self.scope = scope
        query = ""
        field?.stringValue = ""
        selected = 0
        pendingReturn = nil
        running = actions.workspacesByApp()
        runningPids = RunningApps.byPath
        resting = []
        quitting = []
        restingAsk += 1
        storeResults = []
        fileResults = []
        bangs = Launcher.loadBangs()
        // Contacts access turned on or off in System Settings counts a moment later. It reads macOS's answer; it never asks.
        ContactsLibrary.shared.launcherOpened()
        // The BES root and its Inbox count, read once here so a keystroke never touches the disk for them.
        RoomsProvider.shared.refresh()
        rebuild()
        // The "Running, no window" rows join once the running apps are read off the main thread, as files and agents do.
        // Asked in every scope, since Esc goes back to the root from any of them.
        let ask = restingAsk
        actions.lookAgain { [weak self] in
            guard let self, ask == self.restingAsk, self.catchUp() else { return }
            self.rebuildKeepingSelection()
        }
        actions.restingApps { [weak self] list in
            guard let self, ask == self.restingAsk else { return }
            // A scan may have landed since: its windows count too.
            let moved = self.catchUp()
            guard moved || !list.isEmpty else { return }
            self.resting = list
            self.rebuildKeepingSelection()
        }
        // Apps installed since the last look show up without a restart.
        rescanApps()
        Terminals.installedAgents { [weak self] found in
            guard let self, found != self.agents else { return }
            self.agents = found
            self.rebuild()
        }
        if scope == .install || scope == .remove { loadCatalog() }
    }

    /// Takes where the running apps are now; whether that changed.
    private func catchUp() -> Bool {
        let on = actions.workspacesByApp(), pids = RunningApps.byPath
        guard on != running || pids != runningPids else { return false }
        running = on
        runningPids = pids
        return true
    }

    func enter(_ s: Scope) {
        scope = s
        query = ""
        field?.stringValue = ""
        selected = 0
        storeResults = []
        fileResults = []
        if s == .install || s == .remove { loadCatalog() }
        rebuild()
    }

    func back() {
        guard scope != .root else { return }
        enter(.root)
    }

    func icon(for path: String) -> NSImage {
        if let i = iconCache[path] ?? fileIcons.object(forKey: path as NSString) { return i }
        let i = NSWorkspace.shared.icon(forFile: path)
        // Apps are a bounded list; files found by search aren't, so their icons can be let go.
        if path.hasSuffix(".app") { iconCache[path] = i } else { fileIcons.setObject(i, forKey: path as NSString) }
        return i
    }
    private let fileIcons: NSCache<NSString, NSImage> = {
        let c = NSCache<NSString, NSImage>()
        c.countLimit = 300
        return c
    }()

    // MARK: Keys

    func move(_ by: Int) {
        guard !items.isEmpty else { return }
        selected = (selected + by + items.count) % items.count
    }

    func runSelected(reveal: Bool = false) {
        guard appsLanded else {
            if pendingReturn == nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    guard let self, let reveal = self.pendingReturn else { return }
                    self.pendingReturn = nil
                    self.appsLanded = true
                    self.runSelected(reveal: reveal)
                }
            }
            pendingReturn = reveal
            return
        }
        guard items.indices.contains(selected) else { return }
        let item = items[selected]
        if reveal, let alternate = item.alternate { return alternate() }
        if reveal, let url = item.reveal {
            close()
            if url.isFileURL { NSWorkspace.shared.activateFileViewerSelecting([url]) } else { NSWorkspace.shared.open(url) }
            return
        }
        item.run()
    }

    func run(_ item: LauncherItem) {
        if let i = items.firstIndex(where: { $0.id == item.id }) { selected = i }
        item.run()
    }

    /// Tab: into the selected menu, or complete "Install …" from the search.
    func tab() {
        guard items.indices.contains(selected) else { return }
        let id = items[selected].id
        if id.hasPrefix("scope:"), let s = Scope(rawValue: String(id.dropFirst("scope:".count))) { enter(s) }
        else if id == "find-install" || id.hasPrefix("bang-pick:") { items[selected].run() }
    }

    // MARK: Building the list

    private func rebuild() {
        let q = query
        var out: [LauncherItem] = []
        restingListed = []
        // A bang or a question takes over the list, wherever you are: it's clearly for the web.
        if scope == .root || scope == .web, let web = webItems(q) {
            items = web
            if selected >= items.count { selected = max(0, items.count - 1) }
            return
        }
        switch scope {
        case .web: out = q.isEmpty ? bangDirectory() : siteItems(q) + searchEverywhere(q)
        case .root:
            if q.isEmpty {
                out += actions.sessionItems("")
                out += recentApps()
                out += restingItems("")
                out += menuItems()
            } else if RoomsProvider.shared.filter(q) != nil {
                // "room:know tax": the room, then the files in it, and nothing else, since the filter says it's files.
                out += RoomsProvider.shared.results(for: q).map(providedItem)
                out += fileItems()
            } else if let prompt = RoleSearch.prompt(q) {
                // "> fix the build" is for your agent and nothing else. Nothing happens before Return.
                out.append(roleItem(RoleSearch.ask(prompt, DefaultAppsStore.shared.now.resolved[.agent])))
            } else {
                let provided = LauncherProviders.results(providers, for: q)
                // "x.com" is a website: it opens in the main browser before any app or file that happens to match.
                let site = OneSearch.typedSite(q)
                if site?.sure == true { out += siteItems(q) }
                out += provided.top.map(providedItem)
                let ranked = rankedApps(q).prefix(8)
                let found = actions.sessionItems(q).prefix(8)
                let hits = actions.browserHits(q)
                let listed = Set(found.map { String($0.id.dropFirst("session:".count)) })
                let behind = BrowserListing.behind(hits, listed: listed)
                let sessions = found.map { item in behind[String(item.id.dropFirst("session:".count))].map { asTab(item, $0) } ?? item }
                let pages = browserItems(hits, listed: listed)
                // Apps that answer better than the best page shown go above the pages; the rest go below.
                let above = BrowserListing.above(hits, listed: listed, apps: ranked.map(\.score))
                let apps = appItems(ranked.prefix(above).map(\.app), q, limit: 8)
                let jobs = roleItems(q, beside: ranked.map(\.app))
                // "browser" is the job; "mail" is the app of that name first.
                out += apps.contains { $0.title.lowercased().hasPrefix(q.lowercased()) } ? apps + jobs : jobs + apps
                out += webAppItems(q)
                if above < ranked.count {
                    out += pages
                    out += appItems(ranked.dropFirst(above).map(\.app), q, limit: 8, section: "Other Apps")
                }
                out += restingItems(q)
                out += sessions
                if above == ranked.count { out += pages }
                out += agentItems(q)
                out += provided.normal.map(providedItem)
                out += groupItem(q)
                out += workspaceItems(q)
                out += commandItems(q)
                out += keysEntry(q)
                out += menuItems().filter { Fuzzy.score(q, $0.title) != nil }
                // Files come in a moment after the rest, below them, so the row you're on stays put.
                out += fileItems().prefix(5)
                if site?.sure == false { out += siteItems(q) }
                out += searchEverywhere(q).prefix(3)
                if let peer = actions.searcher() {
                    let name = Self.appName(peer.bundleID)
                    out.append(LauncherItem(id: "browser-search", section: "Web", title: "Search in \(name) for “\(q)”", subtitle: "With the browser's own search engine",
                                            icon: .file(SessionController.appPath(peer.bundleID)), run: { [weak self] in
                                                self?.close()
                                                self?.actions.searchIn(q, peer)
                                            }))
                }
                out.append(LauncherItem(id: "find-install", section: "Install", title: "Install “\(q)”…",
                                        subtitle: "Search Homebrew and the App Store", icon: .symbol("arrow.down.circle"),
                                        badge: "⇥", run: { [weak self] in self?.enter(.install); self?.setQuery(q) }))
            }
        case .apps: out = webAppItems(q) + appItems(q.isEmpty ? apps : rankedApps(q).map(\.app), q, limit: 500)
        case .files: out = fileItems()
        case .install: out = installItems(q)
        case .remove: out = removeItems(q)
        case .update: out = updateItems().filter { q.isEmpty || Fuzzy.score(q, $0.title) != nil }
        case .system: out = commandItems(q)
        case .workspaces: out = workspaceItems(q, all: true)
        case .keys: out = keyItems(q)
        }
        items = out
        if selected >= items.count { selected = max(0, items.count - 1) }
    }

    /// The session rows changed while the launcher is open.
    func rowsChanged() { rebuildKeepingSelection() }

    // MARK: Providers

    /// A provider's row as the launcher draws it; choosing it does what its action says.
    private func providedItem(_ r: LauncherResult) -> LauncherItem {
        var icon = LauncherItem.Icon.symbol(r.symbol)
        if let data = r.image {
            let key = r.id as NSString
            if let img = contactImages.object(forKey: key) ?? NSImage(data: data) {
                contactImages.setObject(img, forKey: key)
                icon = .image(img)
            }
        }
        var item = LauncherItem(id: "provider:\(r.id)", section: r.section, title: r.title, subtitle: r.subtitle, icon: icon,
                                badge: r.badge, run: { [weak self] in self?.perform(r.action) })
        if let second = r.second {
            item.alternate = { [weak self] in self?.perform(second) }
            item.alternateTitle = r.secondTitle
        }
        return item
    }

    private func perform(_ action: LauncherAction) {
        switch action {
        case .copy(let text):
            close()
            LauncherPasteboard.copy(text)
            Toast.show("Copied \(text.count > 40 ? String(text.prefix(40)) + "…" : text)", symbol: "doc.on.doc")
        case .open(let url): openWeb(url)
        case .terminal(let launch): close(); TerminalFeature.open(launch)
        case .contact(let launch):
            close()
            ContactsLibrary.shared.open(launch, from: "launcher")
            // Messages has the draft in its box; the owner presses Send.
            if launch.verb == .message, !launch.text.isEmpty { Toast.show("Draft to \(launch.name) is in Messages. Press Send when ready.", symbol: "message") }
        case .contactsAccess:
            // macOS's own box the first time (with the Info.plist reason), the Contacts pane after a no.
            close()
            PermissionsModel.shared.perform(.contacts)
        case .none: break
        }
    }

    /// Rebuilds for results that came in after the typing (files, the App Store): the row you
    /// were on stays selected wherever it moved, so Return still does what it showed.
    private func rebuildKeepingSelection() {
        let on = items.indices.contains(selected) ? items[selected].id : nil
        rebuild()
        // A row that went away leaves the top selected, never whatever moved into its place.
        selected = on.flatMap { id in items.firstIndex { $0.id == id } } ?? 0
    }

    // MARK: Web and agents

    /// "!yt cats", "cats !yt", "!y" while typing a bang, or "? a question". Nil for anything else.
    private func webItems(_ q: String) -> [LauncherItem]? {
        let t = q.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("?") {
            let question = String(t.dropFirst()).trimmingCharacters(in: .whitespaces)
            let mine = Bangs.find(Launcher.agent, in: bangs) ?? Bangs.agents[0]
            return [bangItem(mine, question, section: "Ask")]
                + bangs.filter { $0.isAgent && $0.trigger != mine.trigger }.map { bangItem($0, question, section: "Other agents") }
        }
        // Still typing the bang: "!" or "!yo" with nothing after it yet.
        if t.hasPrefix("!"), !t.contains(" ") {
            let partial = String(t.dropFirst())
            if let exact = Bangs.find(partial, in: bangs), !partial.isEmpty {
                return [bangItem(exact, "", section: "Bang")] + Bangs.suggest(partial, in: bangs).filter { $0 != exact }.map(bangPick)
            }
            let picks = Bangs.suggest(partial, in: bangs).map(bangPick)
            return picks.isEmpty && !partial.isEmpty ? [unknownBang(partial, "")] : picks
        }
        guard let parsed = Bangs.parse(t) else { return nil }
        guard let bang = Bangs.find(parsed.trigger, in: bangs) else { return [unknownBang(parsed.trigger, parsed.terms)] }
        return [bangItem(bang, parsed.terms, section: "Bang")]
    }

    /// One row that searches (or asks) with a bang.
    private func bangItem(_ b: Bang, _ terms: String, section: String) -> LauncherItem {
        let title: String
        if terms.isEmpty { title = "Open \(b.name)" } else if b.isAgent { title = "Ask \(b.name) “\(terms)”" } else { title = "Search \(b.name) for “\(terms)”" }
        // An engine given as an address has no trigger: its host says where it goes.
        let mark = b.trigger.isEmpty ? (URL(string: b.url.replacingOccurrences(of: "{q}", with: ""))?.host ?? b.name) : "!\(b.trigger)"
        let subtitle = b.isAgent ? "\(mark) · opens a new chat in your browser with the question asked" : "\(mark) · opens in your browser"
        return LauncherItem(id: "bang:\(b.trigger):\(section)", section: section, title: title, subtitle: subtitle, icon: .symbol(Self.symbol(for: b)),
                            run: { [weak self] in self?.openWeb(b.address(for: terms)) })
    }

    /// A bang offered while typing "!": Tab or Return fills it in, ready for the words.
    private func bangPick(_ b: Bang) -> LauncherItem {
        LauncherItem(id: "bang-pick:\(b.trigger)", section: "Bangs", title: b.name, subtitle: "!\(b.trigger)",
                     icon: .symbol(Self.symbol(for: b)), badge: "⇥", run: { [weak self] in self?.setQuery("!\(b.trigger) ") })
    }

    private func unknownBang(_ trigger: String, _ terms: String) -> LauncherItem {
        LauncherItem(id: "bang-ddg:\(trigger)", section: "Bang", title: "Search with !\(trigger)\(terms.isEmpty ? "" : " for “\(terms)”")",
                     subtitle: "Not a built-in bang; DuckDuckGo knows thousands more", icon: .symbol("globe"),
                     run: { [weak self] in self?.openWeb(Bangs.fallbackAddress(trigger: trigger, terms: terms)) })
    }

    /// A typed web address as one row that opens it in a new tab of the main browser (Helium, as a rule). The row names
    /// the browser, so it is plain where Return goes.
    private func siteItems(_ q: String) -> [LauncherItem] {
        guard let site = OneSearch.typedSite(q) else { return [] }
        let browser = Launcher.browser
        let name = browser.map { FileManager.default.displayName(atPath: $0.path).replacingOccurrences(of: ".app", with: "") } ?? "your browser"
        let shown = q.trimmingCharacters(in: .whitespacesAndNewlines)
        return [LauncherItem(id: "site:\(site.url.absoluteString)", section: "Web", title: "Open \(shown)",
                             subtitle: "\(site.url.absoluteString) · opens in \(name)",
                             icon: browser.map { .file($0.path) } ?? .symbol("globe"),
                             run: { [weak self] in self?.openWeb(site.url) })]
    }

    /// Plain words: your search engine (`search.engine`), images, and your agent first, then every other bang. In the
    /// Search the Web menu a tab already open in the main browser that answers the words comes first, so it is switched
    /// to rather than opened twice; the main search lists it with the other tabs above the web rows.
    private func searchEverywhere(_ q: String) -> [LauncherItem] {
        let engine = OneSearch.engine(Launcher.searchEngine, bangs: bangs)
        let agent = Bangs.find(Launcher.agent, in: bangs) ?? Bangs.agents[0]
        let images = Bangs.find("i", in: bangs)
        var seen = Set<String>()
        let lead = [engine, images, agent].compactMap { $0 }.filter { seen.insert($0.trigger).inserted }
        let builtInImages = Bangs.builtIn.first { $0.trigger == "i" }
        let leadItems = lead.map { b -> LauncherItem in
            var item = bangItem(b, q, section: "Web")
            if b == builtInImages { item.title = "Search images for “\(q)”" }
            return item
        }
        guard scope == .web else { return leadItems }
        let skip = Set(lead.map(\.trigger) + ["img", "gi"])
        return (actions.browserTab(q).map { [$0] } ?? []) + leadItems + bangs.filter { !skip.contains($0.trigger) }.map { bangItem($0, q, section: $0.isAgent ? "Agents" : "Sites") }
    }

    /// The Search the Web menu with nothing typed: every agent and site, each a bang to fill in.
    private func bangDirectory() -> [LauncherItem] {
        bangs.filter(\.isAgent).map { var i = bangPick($0); i.section = "Agents"; return i }
            + bangs.filter { !$0.isAgent }.map { var i = bangPick($0); i.section = "Sites"; return i }
            + [LauncherItem(id: "bang-edit", section: "Your bangs", title: "Add Your Own Bangs…",
                            subtitle: "Opens bangs.json; each needs a trigger, a name and an address with {q}", icon: .symbol("plus"),
                            run: { [weak self] in self?.close(); Launcher.editCustomBangs() })]
    }

    private static func symbol(for b: Bang) -> String {
        if b.isAgent { return "sparkles" }
        switch b.trigger {
        case "i", "img", "gi", "ddgi": return "photo"
        case "v", "yt": return "play.rectangle"
        case "maps", "am": return "map"
        case "gh", "so", "mdn", "npm", "pypi", "apple", "hf", "brew": return "chevron.left.forwardslash.chevron.right"
        case "bible", "esv": return "book.closed"
        case "a", "ebay": return "cart"
        case "w", "d", "scholar", "wa": return "text.book.closed"
        default: return "globe"
        }
    }

    /// In a new tab of your main browser (or Maps for an Apple Maps bang).
    private func openWeb(_ url: URL?) {
        close()
        guard let url else { return NSSound.beep() }
        Launcher.openInBrowser(url)
    }

    func setQuery(_ q: String) {
        field?.stringValue = q
        query = q
    }

    private func menuItems() -> [LauncherItem] {
        Scope.allCases.filter { $0 != .root }.map { s in
            LauncherItem(id: "scope:\(s.rawValue)", section: "Menu", title: s.title, subtitle: s.blurb, icon: .symbol(s.symbol),
                         badge: "⇥", run: { [weak self] in self?.enter(s) })
        }
    }

    private func recentApps() -> [LauncherItem] {
        recents.paths.lazy.compactMap { path in self.apps.first { $0.path == path } }.prefix(5).map { appItem($0, section: "Recent") }
    }

    /// A browser's tabs, bookmarks, visited pages and downloads. Their icons are the browser's and a symbol.
    private func browserItems(_ hits: [BrowserHit], listed: Set<String>) -> [LauncherItem] {
        BrowserListing.rows(hits, listed: listed, app: Self.appName).map { r in
            let make = makeAction(r.hit)
            return LauncherItem(id: "page:" + r.hit.id, section: "Browser", title: r.title, subtitle: r.subtitle,
                         icon: (r.hit.row.source == .downloads ? nil : actions.siteIcon(r.hit)).map { .image($0) }
                             ?? r.symbol.map { .symbol($0) } ?? .file(SessionController.appPath(r.hit.peer.bundleID)), badge: r.badge,
                         run: { [weak self] in
                             self?.close()
                             self?.actions.openBrowser(r.hit)
                         }, alternate: make, alternateTitle: make == nil ? "" : "Make This an App")
        }
    }

    /// ⌘↩ on a page that can be an app.
    private func makeAction(_ hit: BrowserHit) -> (() -> Void)? {
        WebApps.fits(hit.row) ? { [weak self] in self?.makeApp(of: hit.row, in: hit.peer) ?? () } : nil
    }

    /// A session row for a tab the extension also knows: it is the one listed, so it does what the browser row would.
    private func asTab(_ item: LauncherItem, _ hit: BrowserHit) -> LauncherItem {
        var item = item
        if hit.row.app != nil { item.badge = "App" }
        if item.alternate == nil, let make = makeAction(hit) { item.alternate = make; item.alternateTitle = "Make This an App" }
        return item
    }

    private func webAppItems(_ q: String) -> [LauncherItem] {
        let all = actions.webApps.list
        return (q.isEmpty ? all.sorted { $0.name < $1.name } : WebApps.find(q, in: all)).map { app in
            LauncherItem(id: "webapp:" + app.id, section: "Apps", title: app.name, subtitle: "Web app · \(Self.appName(app.browser))",
                         icon: actions.webApps.image(app).map { .image($0) } ?? .symbol("macwindow"),
                         run: { [weak self] in self?.close(); self?.actions.openWebApp(app) },
                         alternate: { [weak self] in self?.removeApp(app) }, alternateTitle: "Remove")
        }
    }

    /// Asks what to call it: a page's title says too much, or too little.
    private func makeApp(of row: BrowserRow, in peer: BrowserPeer) {
        let hit = BrowserHit(BrowserWindows.Front(peer, row))
        _ = actions.siteIcon(hit)
        let name = NSTextField(string: WebApps.name(title: row.title, site: row.site))
        name.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        guard ask("Make This an App", "It opens \(row.site) in a window of its own in \(Self.appName(peer.bundleID)). Its name in the launcher:", button: "Make App", entry: name) else { return }
        done(actions.webApps.add(name.stringValue, url: row.url, browser: peer.bundleID, icon: actions.siteIcon(hit)), "\(name.stringValue) is an app")
    }

    private func share(_ place: BrowserShare.Place) {
        guard let f = actions.frontPage(), actions.sharePage(f, place) else {
            return Toast.show("That browser isn't open", symbol: "exclamationmark.triangle.fill")
        }
    }

    static let notesCommand = "Add Page to Notes File"
    /// The person's notes file, chosen the first time; nothing else writes this key.
    static let notesKey = "browserNotesFile"
    private var notesFile: URL? { UserDefaults.standard.string(forKey: Self.notesKey).map { URL(fileURLWithPath: $0) } }

    /// A line for the page in front at the end of the person's notes file, which they choose the first time.
    private func addToNotes(choose: Bool) {
        guard let f = actions.frontPage(), let line = BrowserShare.line(f.tab, on: Date()) else { return }
        var file = choose ? nil : notesFile
        if file == nil {
            let panel = NSSavePanel()
            panel.title = "Choose a Notes File"
            panel.message = "Polycarp adds a line for each page you send to it, and never changes what is there."
            panel.nameFieldStringValue = notesFile?.lastPathComponent ?? "Saved Pages.md"
            panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText]
            panel.canCreateDirectories = true
            NSApp.activate(ignoringOtherApps: true)
            guard panel.runModal() == .OK, let url = panel.url else { return }
            UserDefaults.standard.set(url.path, forKey: Self.notesKey)
            file = url
        }
        guard let file else { return }
        let wrong = BrowserShare.append(line, to: file)
        Toast.show(wrong ?? "Added to \(file.lastPathComponent)", symbol: wrong == nil ? "note.text" : "exclamationmark.triangle.fill")
    }

    private func removeApp(_ app: WebApp) {
        guard ask("Remove \(app.name)?", "It leaves the launcher. Nothing in \(Self.appName(app.browser)) changes.", button: "Remove", destructive: true) else { return }
        done(actions.webApps.remove(app), "\(app.name) is removed")
    }

    private func done(_ wrong: String?, _ said: String) {
        Toast.show(wrong ?? said, symbol: wrong == nil ? "macwindow" : "exclamationmark.triangle.fill")
        rebuild()
    }

    /// "trip planning 3": that tab group, sent to workspace 3.
    private func groupItem(_ q: String) -> [LauncherItem] {
        guard let (name, n) = BrowserListing.sending(q, to: Workspaces.range), let g = actions.tabGroup(name) else { return [] }
        return [LauncherItem(id: "group:\(g.peer.bundleID):\(g.row.key):\(n)", section: "Workspaces", title: "Send “\(g.row.title)” to Workspace \(n)",
                             subtitle: "Tab group · \(Self.appName(g.peer.bundleID))", icon: .symbol("rectangle.stack"), workspaces: [n],
                             run: { [weak self] in
                                 self?.close()
                                 self?.actions.sendGroup(g.peer, g.row, n)
                             })]
    }

    private static var appNames: [String: String] = [:]
    private static func appName(_ bundleID: String) -> String {
        if let known = appNames[bundleID] { return known }
        let path = SessionController.appPath(bundleID)
        let name = path.isEmpty ? "the browser" : FileManager.default.displayName(atPath: path).replacingOccurrences(of: ".app", with: "")
        appNames[bundleID] = name
        return name
    }

    /// The apps that answer what is typed, best first.
    private func rankedApps(_ q: String) -> [(app: AppEntry, score: Int)] {
        let folded = Fuzzy.fold(q)
        return apps.compactMap { a -> (app: AppEntry, score: Int)? in
            guard let s = Fuzzy.score(folded: folded, key: a.key) else { return nil }
            return (a, s + recents.boost(a.path) + (running[a.path] != nil ? 15 : 0))
        }
        .sorted { $0.score != $1.score ? $0.score > $1.score : $0.app.name < $1.app.name }
    }

    private func appItems(_ matches: [AppEntry], _ q: String, limit: Int, section: String = "Apps") -> [LauncherItem] {
        // An app open on more than one workspace also gets a row for each, to pick which, and so
        // does one that opens a new window here instead of going to its workspace.
        return matches.prefix(limit).flatMap { a -> [LauncherItem] in
            let on = running[a.path] ?? []
            let look = !q.isEmpty && limit <= 8
            let main = appItem(a, section: section, look: look)
            if restingEntry(a) != nil { return [main] }
            guard on.count > 1 || opensHere(a, look: look), !q.isEmpty else { return [main] }
            return [main] + on.map { n in
                LauncherItem(id: "app:\(a.path):\(n)", section: section, title: "\(a.name) on Workspace \(n)",
                             subtitle: "The \(a.name) windows there", icon: .file(a.path), workspaces: [n],
                             run: { [weak self] in self?.focus(a, on: n) }, reveal: URL(fileURLWithPath: a.path))
            }
        }
    }

    /// The job by its name ("browser"), "open terminal here", "set default mail". Not a job whose app is listed anyway.
    private func roleItems(_ q: String, beside apps: [AppEntry]) -> [LauncherItem] {
        let listed = Set(apps.map { "app:\($0.path)" }), folder = actions.folder().map { ($0 as NSString).abbreviatingWithTildeInPath }
        return RoleSearch.rows(q, DefaultAppsStore.shared.now.resolved, folder: folder).filter { r in
            guard case .open = r.action, let path = r.app?.path else { return true }
            return !listed.contains("app:\(path)")
        }.map(roleItem)
    }

    private func roleItem(_ r: RoleSearch.Row) -> LauncherItem {
        var icon = LauncherItem.Icon.symbol(Self.symbols[r.role] ?? "app")
        if let c = r.app, case .app = c.app, let path = c.path { icon = .file(path) }
        if case .choose = r.action { icon = .symbol("star") }
        var item = LauncherItem(id: r.id, section: "Default apps", title: r.title, subtitle: r.subtitle, icon: icon, run: { [weak self] in
            guard let self else { return }
            self.close()
            // After the launcher is gone: what opens takes its place in front.
            DispatchQueue.main.async {
                switch r.action {
                case .open(let role): RoleOpener.key(role, new: false)
                case .terminalHere: self.actions.newTerminal()
                case .choose: self.actions.showDefaultApps()
                case .ask(let prompt): self.actions.askAgent(prompt)
                }
            }
        })
        if case .open(let role) = r.action {
            // ⌘Return: a new window, as Option does with the job's key.
            item.alternate = { [weak self] in
                self?.close()
                DispatchQueue.main.async { RoleOpener.key(role, new: true) }
            }
            item.alternateTitle = "New Window"
        }
        return item
    }

    /// A job's mark when its app has no icon to show: a terminal program, or none chosen yet.
    private static let symbols: [AppRole: String] = [
        .agent: "sparkle", .browser: "globe", .terminal: "terminal", .editor: "chevron.left.forwardslash.chevron.right",
        .files: "folder", .mail: "envelope", .messages: "message", .calendar: "calendar", .notes: "note.text",
        .music: "music.note", .video: "play.rectangle", .passwords: "key",
    ]

    /// "claude" or "codex": that agent, started in your terminal.
    private func agentItems(_ q: String) -> [LauncherItem] {
        let matches = TerminalAgent.matches(q, installed: agents.keys)
        guard !matches.isEmpty, let terminal = DefaultAppsStore.shared.now.programs else { return [] }
        return matches.map { a in
            LauncherItem(id: "agent:\(a.command)", section: "Terminal", title: a.name, subtitle: "Opens in \(terminal.name) · runs \(a.command)",
                         icon: terminal.path.map { .file($0) } ?? .symbol("terminal"), run: { [weak self] in
                             self?.close()
                             if let path = self?.agents[a.command] { RoleOpener.start(a.command, at: path, in: NSHomeDirectory()) }
                         })
        }
    }

    private func focus(_ a: AppEntry, on n: Int) {
        close()
        guard let app = runningApp(a) else { return open(a) }
        actions.focusApp(app.processIdentifier, n)
    }

    /// The resting app behind an app's row, if it is one.
    private func restingEntry(_ a: AppEntry) -> BackgroundApps.Entry? {
        guard let pid = runningPids[a.path] else { return nil }
        return resting.first { $0.pid == pid }
    }

    private func appItem(_ a: AppEntry, section: String, look: Bool = false) -> LauncherItem {
        // A resting app keeps its row, its place and its ⌘Return: only where Return opens it changes when the answer
        // joins. Quit is a row of its own, so no key turns into Quit under your finger.
        if let e = restingEntry(a) {
            let pid = e.pid
            restingListed.insert(pid)
            return LauncherItem(id: "app:\(a.path)", section: section, title: a.name,
                                subtitle: quitting.contains(pid) ? "Quitting…" : Self.restingSubtitle(e.state), icon: .file(a.path),
                                run: { [weak self] in self?.close(); self?.actions.showResting(pid) }, reveal: URL(fileURLWithPath: a.path))
        }
        let on = running[a.path] ?? []
        var where_ = on.isEmpty ? a.folder : on.count == 1 ? "Open on workspace \(on[0])" : "Open on workspaces \(on.map(String.init).joined(separator: ", "))"
        if opensHere(a, look: look) { where_ += " · Return opens a new window here" }
        return LauncherItem(id: "app:\(a.path)", section: section, title: a.name, subtitle: where_, icon: .file(a.path),
                            workspaces: on,
                            run: { [weak self] in self?.open(a) }, reveal: URL(fileURLWithPath: a.path))
    }

    /// Apps found to have a New Window command, by path. Only a yes is kept: a no can be an app
    /// that was busy, still building its menus, or showing a sheet.
    private var newWindowCommand: Set<String> = []
    /// Apps whose menus are being read now, so a keystroke doesn't ask twice.
    private var lookingForNewWindow: Set<String> = []

    /// An app open only on other workspaces that can open a window here: opening it does that,
    /// as opening an app on a Mac desktop where it has no window would. `look` reads the app's
    /// menus, 15 to 130 ms an app (more when it doesn't answer), so rows only look for the few best
    /// matches of a search, and the look runs off the main thread: the row says so once it answers.
    private func opensHere(_ a: AppEntry, look: Bool = true) -> Bool {
        guard let on = running[a.path], !on.contains(actions.current()), let pid = runningPids[a.path] else { return false }
        if newWindowCommand.contains(a.path) { return true }
        guard look, lookingForNewWindow.insert(a.path).inserted else { return false }
        let path = a.path
        actions.canOpenWindow(pid) { [weak self] yes in
            guard let self else { return }
            self.lookingForNewWindow.remove(path)
            guard yes, self.newWindowCommand.insert(path).inserted else { return }
            self.rebuildKeepingSelection()
        }
        return false
    }

    private func runningApp(_ a: AppEntry) -> NSRunningApplication? {
        // The pid may be from a read before this open: it counts only while it is still this app's.
        if let pid = runningPids[a.path], let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
           app.bundleURL?.path == a.path { return app }
        return NSWorkspace.shared.runningApplications.first { $0.bundleURL?.path == a.path }
    }

    /// A running app opens a new window here when it's open only elsewhere and can; otherwise
    /// it's gone to, wherever its windows are. Anything else opens here.
    private func open(_ a: AppEntry) {
        close()
        recents.used(a.path)
        UserDefaults.standard.set(recents.paths, forKey: "launcherRecents")
        let url = URL(fileURLWithPath: a.path)
        if let app = runningApp(a), running[a.path] != nil {
            let pid = app.processIdentifier
            // Open only on other workspaces: try a new window here. The menus are read off the main thread, and an app
            // without a New Window command is gone to instead, as before.
            if let on = running[a.path], !on.contains(actions.current()) {
                actions.openWindowHere(pid) { [actions] in actions.focusApp(pid, nil) }
                return
            }
            actions.focusApp(pid, nil)
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
            if let error { NSLog("Polycarp: couldn't open %@: %@", a.path, error.localizedDescription) }
        }
    }

    private func workspaceItems(_ q: String, all: Bool = false) -> [LauncherItem] {
        Workspaces.range.compactMap { n in
            let apps = actions.appsOn(n)
            let title = "Workspace \(n)"
            let text = "\(title) \(apps.joined(separator: " "))"
            if !q.isEmpty {
                // "3" or "ws 3" goes straight there; names find the workspace an app is on.
                let digitMatch = q.trimmingCharacters(in: .whitespaces) == String(n)
                if !digitMatch && Fuzzy.score(q, title) == nil && !apps.contains(where: { Fuzzy.score(q, $0).map { $0 >= 500 } ?? false }) { return nil }
            } else if !all { return nil }
            _ = text
            return LauncherItem(id: "ws:\(n)", section: "Workspaces", title: title,
                                subtitle: apps.isEmpty ? "Empty" : apps.joined(separator: ", "), icon: .symbol("\(n).square"),
                                run: { [weak self] in self?.close(); self?.actions.switchTo(n) })
        }
    }

    /// Every shortcut from the keymap, grouped as the sheet groups them, the keys at the right in the modifier the
    /// person picked. Typing matches the title, the group, where it works and the keys themselves ("⌘1", "tab").
    private func keyItems(_ q: String) -> [LauncherItem] {
        let mod = Modifier.current.symbol
        let table = Keymap.rows(DefaultAppsStore.shared.keys, in: Keymap.rows(SurfacesStore.shared.current))
        let rows = KeyBinding.Group.allCases.flatMap { group in table.filter { $0.group == group } }
        return rows.compactMap { b in
            let keys = b.display(modifierSymbol: mod)
            if !q.isEmpty {
                let text = "\(b.title) \(b.group.title) \(b.scope.title) \(b.note ?? "") \(keys)"
                guard Fuzzy.score(q, text) != nil || keys.localizedCaseInsensitiveContains(q) else { return nil }
            }
            let subtitle = b.note.map { "\(b.scope.title). \($0)" } ?? b.scope.title
            return LauncherItem(id: "key:\(b.id)", section: b.group.title, title: b.title, subtitle: subtitle,
                                icon: .symbol("keyboard"), badge: keys, run: {})
        }
    }

    /// "keys", "shortcuts" or "keyboard" typed at the top: one row into the shortcuts.
    private func keysEntry(_ q: String) -> [LauncherItem] {
        guard ["keys", "shortcuts", "keyboard", "cheat sheet"].contains(where: { Fuzzy.score(q, $0) != nil }) else { return [] }
        return [LauncherItem(id: "keys-entry", section: "Shortcuts", title: "Keys and Shortcuts",
                             subtitle: "Every Polycarp shortcut. Hold \(Modifier.current.symbol) anywhere to see them",
                             icon: .symbol("keyboard"), badge: "⌘K", run: { [weak self] in self?.enter(.keys) })]
    }

    /// ⌘K in the launcher: the shortcuts, and ⌘K again goes back.
    func toggleKeys() {
        enter(scope == .keys ? .root : .keys)
    }

    /// Apps running with no window to see, under their own heading: a row that brings the app onto this workspace, or
    /// that quits it when it has its row among the apps already. With nothing typed every one is listed; a query keeps
    /// the ones it matches. A row stays until its app has gone.
    private func restingItems(_ q: String) -> [LauncherItem] {
        BackgroundApps.launcherRows(resting, listed: restingListed, matches: { q.isEmpty || Fuzzy.score(q, $0) != nil }).map { e, row in
            let pid = e.pid
            let icon: LauncherItem.Icon = NSRunningApplication(processIdentifier: pid)?.bundleURL.map { .file($0.path) } ?? .symbol("app.dashed")
            if row == .quit {
                return LauncherItem(id: "quit:\(pid)", section: Self.restingSection, title: "Quit \(e.name)",
                                    subtitle: quitting.contains(pid) ? "Quitting…" : "Running with no window", icon: icon,
                                    run: { [weak self] in self?.quit(resting: pid) })
            }
            return LauncherItem(id: "resting:\(pid)", section: Self.restingSection, title: e.name,
                                subtitle: quitting.contains(pid) ? "Quitting…" : Self.restingSubtitle(e.state) + ", ⌘Return quits", icon: icon,
                                run: { [weak self] in self?.close(); self?.actions.showResting(pid) },
                                alternate: { [weak self] in self?.quit(resting: pid) }, alternateTitle: "Quit")
        }
    }

    private func quit(resting pid: pid_t) {
        guard quitting.insert(pid).inserted else { return }
        rebuildKeepingSelection()
        actions.quitResting(pid) { [weak self] went in
            guard let self else { return }
            self.quitting.remove(pid)
            if went {
                self.resting.removeAll { $0.pid == pid }
                self.runningPids = self.runningPids.filter { $0.value != pid }
            }
            self.rebuildKeepingSelection()
        }
    }

    static let restingSection = "Running, no window"

    static func restingSubtitle(_ state: BackgroundApps.State) -> String {
        switch state {
        case .hidden: "Hidden, no window · Return shows it here"
        case .minimized: "Every window minimized · Return shows it here"
        case .noWindow: "No window · Return opens one here"
        }
    }

    private func commandItems(_ q: String) -> [LauncherItem] {
        let all: [(String, String, String, () -> Void)] = [
            ("Lock Screen", "lock", "", { System.lock() }),
            ("Sleep", "moon.zzz", "", { System.run("/usr/bin/pmset", ["sleepnow"]) }),
            ("Restart…", "restart", "macOS asks before restarting", { System.loginWindow("rrst") }),
            ("Shut Down…", "power", "macOS asks before shutting down", { System.loginWindow("rsdn") }),
            ("Log Out…", "rectangle.portrait.and.arrow.right", "macOS asks before logging out", { System.loginWindow("rlgo") }),
            ("Toggle Dark Mode", "circle.lefthalf.filled", "Asks once to let Polycarp change appearance", { System.toggleDarkMode() }),
            ("Take a Screenshot", "camera.viewfinder", "Choose an area, a window or the screen", { System.run("/usr/bin/open", ["-a", "Screenshot"]) }),
            ("New Claude Session", "sparkle", "Another Claude Code session in Ghostty", { [weak self] in self?.actions.newClaude() }),
            ("New Terminal", "plus", "A new \(DefaultAppsStore.shared.now.resolved[.terminal]?.app?.name ?? "terminal") window", { [weak self] in self?.actions.newTerminal() }),
            ("New Tab Here", "plus.square.on.square", actions.searcher().map { "In \(Self.appName($0.bundleID)), on this workspace" } ?? "",
             { [weak self] in if let peer = self?.actions.searcher() { self?.actions.newTab(peer) } }),
            ("Make This Page an App", "macwindow.badge.plus", "The page in front on this workspace, in a window of its own",
             { [weak self] in if let f = self?.actions.frontPage() { self?.makeApp(of: f.tab, in: f.peer) } }),
            ("Send Page to Reader", "doc.plaintext", "The page in front on this workspace, in Polycarp Reader",
             { [weak self] in self?.share(.reader) }),
            ("Save Page to Library", "books.vertical", "The page in front on this workspace, in your Polycarp library",
             { [weak self] in self?.share(.library) }),
            (Self.notesCommand, "note.text.badge.plus", notesFile.map { "A line in \($0.lastPathComponent)" } ?? "A line in a Markdown file you choose",
             { [weak self] in self?.addToNotes(choose: false) }),
            ("Show All Workspaces", "square.grid.3x3", "", { [weak self] in self?.actions.showOverview() }),
            ("Bring Every Window Back", "arrow.uturn.backward.circle", "Gathers every window onto workspace 1", { [weak self] in self?.actions.bringBack() }),
            ("Polycarp Settings", "slider.horizontal.3", "", { [weak self] in self?.actions.showSetup() }),
        ]
        func here(_ name: String) -> Bool {
            switch name {
            case "New Tab Here": actions.searcher() != nil
            case "Make This Page an App": actions.frontPage().map { WebApps.fits($0.tab) } ?? false
            case "Send Page to Reader", "Save Page to Library": actions.frontPage().map { BrowserShare.send($0.tab, to: .reader) != nil } ?? false
            case Self.notesCommand: actions.frontPage().map { BrowserShare.line($0.tab, on: Date()) != nil } ?? false
            default: true
            }
        }
        return all.filter { (q.isEmpty || Fuzzy.score(q, $0.0) != nil) && here($0.0) }.map { c in
            LauncherItem(id: "cmd:\(c.0)", section: "System", title: c.0, subtitle: c.2, icon: .symbol(c.1),
                         run: { [weak self] in self?.close(); DispatchQueue.main.async(execute: c.3) },
                         alternate: c.0 == Self.notesCommand ? { [weak self] in self?.close(); DispatchQueue.main.async { self?.addToNotes(choose: true) } } : nil,
                         alternateTitle: c.0 == Self.notesCommand ? "Choose Another File" : "")
        }
    }

    private func updateItems() -> [LauncherItem] {
        var out: [LauncherItem] = []
        if Brew.path != nil {
            out.append(LauncherItem(id: "upd:brew", section: "Update", title: "Update Homebrew Apps",
                                    subtitle: "Runs brew update and brew upgrade in Terminal, where you can watch it",
                                    icon: .symbol("shippingbox"),
                                    run: { [weak self] in self?.close(); Brew.openInTerminal(["brew", "update"], ["brew", "upgrade"]) }))
        }
        out.append(LauncherItem(id: "upd:macos", section: "Update", title: "Update macOS and App Store Apps",
                                subtitle: "Opens Software Update", icon: .symbol("apple.logo"),
                                run: { [weak self] in
                                    self?.close()
                                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Software-Update-Settings.extension")!)
                                }))
        out.append(LauncherItem(id: "upd:self", section: "Update", title: "Check for Polycarp Updates",
                                subtitle: "Stable or Nightly, as set in Settings > Updates", icon: .symbol("square.grid.3x3.fill"),
                                run: { [weak self] in self?.close(); self?.actions.checkForUpdates() }))
        return out
    }

    // MARK: Install and remove

    /// Picks for an empty Install search: well-known apps most Macs want.
    private static let popular = ["google-chrome", "firefox", "visual-studio-code", "ghostty", "obsidian", "slack", "discord",
                                  "spotify", "zoom", "vlc", "1password", "rectangle", "iina", "appcleaner", "the-unarchiver"]

    private func loadCatalog() {
        catalog.load { [weak self] state in
            self?.catalogState = state
            self?.rebuild()
        }
    }

    private func installItems(_ q: String) -> [LauncherItem] {
        var out: [LauncherItem] = []
        if Brew.path == nil {
            out.append(LauncherItem(id: "brew:get", section: "Homebrew", title: "Get Homebrew First",
                                    subtitle: "The free installer most Mac developers use. Opens Terminal; it asks for your password.",
                                    icon: .symbol("shippingbox"),
                                    run: { [weak self] in self?.close(); Brew.installHomebrew() }))
        }
        let installed = Brew.installedCasks()
        let casks = q.isEmpty
            ? Self.popular.compactMap { t in catalog.casks.first { $0.token == t } }
            : Cask.search(q, in: catalog.casks, limit: 25)
        if catalog.casks.isEmpty {
            switch catalogState {
            case .loading: out.append(LauncherItem(id: "brew:loading", section: "Homebrew", title: "Loading Homebrew’s app list…",
                                                   icon: .symbol("hourglass"), state: .working, run: {}))
            case .failed(let why): out.append(LauncherItem(id: "brew:failed", section: "Homebrew", title: "Couldn’t load Homebrew’s app list",
                                                           subtitle: why + ". Press ↩ to try again.", icon: .symbol("wifi.exclamationmark"),
                                                           run: { [weak self] in self?.catalog.reset(); self?.loadCatalog() }))
            default: break
            }
        }
        for c in casks { out.append(caskItem(c, installed: installed.contains(c.token), section: q.isEmpty ? "Popular" : "Homebrew")) }
        for app in storeResults {
            let local = app.bundleID.flatMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }
            out.append(LauncherItem(id: "store:\(app.id)", section: "App Store", title: app.name,
                                    subtitle: [app.seller, app.price].filter { !$0.isEmpty }.joined(separator: " · "),
                                    icon: .remote(app.artwork), badge: local != nil ? "Installed" : "App Store",
                                    run: { [weak self] in
                                        self?.close()
                                        if let local { NSWorkspace.shared.open(local) } else if let url = app.storeURL { NSWorkspace.shared.open(url) }
                                    }, reveal: app.webURL))
        }
        return out
    }

    private func caskItem(_ c: Cask, installed: Bool, section: String) -> LauncherItem {
        let job = jobs[c.token]
        var item = LauncherItem(id: "cask:\(c.token)", section: section, title: c.name,
                                subtitle: c.desc.isEmpty ? c.token : c.desc, icon: .symbol("shippingbox"),
                                badge: installed ? "Installed" : "Install", run: {},
                                reveal: URL(string: c.homepage))
        if let local = Brew.appPath(for: c, installedApps: apps) { item.icon = .file(local) }
        switch job {
        case .installing: item.badge = "Installing…"; item.state = .working
        case .removing: item.badge = "Removing…"; item.state = .working
        case .failed(let why):
            item.state = .failed
            item.subtitle = why + " Press ↩ to finish in Terminal."
            item.badge = "Failed"
            item.run = { [weak self] in self?.close(); Brew.openInTerminal(["brew", "install", "--cask", c.token]) }
            return item
        case nil: break
        }
        if job == nil {
            item.run = installed
                ? { [weak self] in
                    guard let self else { return }
                    if let path = Brew.appPath(for: c, installedApps: self.apps), let a = self.apps.first(where: { $0.path == path }) { self.open(a) }
                }
                : { [weak self] in self?.confirmInstall(c) }
        }
        return item
    }

    /// Installing changes the Mac, so it is always asked, the same as removing.
    private func confirmInstall(_ c: Cask) {
        guard Brew.path != nil else { close(); return Brew.installHomebrew() }
        guard ask("Install \(c.name)?", c.desc.isEmpty ? "Homebrew downloads and installs it from \(c.homepage.isEmpty ? "its maker" : c.homepage)."
                  : "\(c.desc). Homebrew downloads it from \(c.homepage.isEmpty ? "its maker" : c.homepage).", button: "Install") else { return }
        install(c)
    }

    /// A yes-or-no question over the launcher. The app you were in comes back afterwards.
    private func ask(_ title: String, _ detail: String, button: String, destructive: Bool = false, entry: NSTextField? = nil) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: button)
        alert.addButton(withTitle: "Cancel")
        alert.buttons[0].hasDestructiveAction = destructive
        alert.accessoryView = entry
        alert.window.initialFirstResponder = entry
        let previous = NSWorkspace.shared.frontmostApplication
        alertOpen = true
        NSApp.activate(ignoringOtherApps: true)
        let answer = alert.runModal()
        alertOpen = false
        if let previous, previous.processIdentifier != getpid() { previous.activate(options: []) }
        field?.window?.makeKey()
        return answer == .alertFirstButtonReturn
    }

    private func install(_ c: Cask) {
        guard Brew.path != nil else { return Brew.installHomebrew() }
        jobs[c.token] = .installing
        rebuild()
        Brew.run(["install", "--cask", c.token]) { [weak self] ok, tail in
            guard let self else { return }
            if ok {
                self.jobs[c.token] = nil
                self.rescanApps()
                Toast.show("\(c.name) is installed", symbol: "checkmark.circle.fill")
            } else {
                self.jobs[c.token] = .failed(tail.isEmpty ? "Homebrew stopped." : "Homebrew: \(tail).")
                Toast.show("\(c.name) didn’t install. Open the launcher to finish in Terminal.", symbol: "exclamationmark.triangle.fill")
            }
            self.rebuild()
        }
    }

    private func removeItems(_ q: String) -> [LauncherItem] {
        guard Brew.path != nil else {
            return [LauncherItem(id: "rm:none", section: "Remove", title: "Homebrew isn’t installed",
                                 subtitle: "Apps from elsewhere are removed by dragging them from Applications to the Trash.",
                                 icon: .symbol("shippingbox"), run: {})]
        }
        let installed = Brew.installedCasks().sorted()
        let list = installed.map { t in catalog.casks.first { $0.token == t } ?? Cask(token: t, name: t, desc: "", homepage: "") }
            .filter { q.isEmpty || Fuzzy.score(q, $0.name) != nil || Fuzzy.score(q, $0.token) != nil }
        if list.isEmpty {
            return [LauncherItem(id: "rm:empty", section: "Remove", title: q.isEmpty ? "Homebrew hasn’t installed any apps" : "No Homebrew app matches",
                                 icon: .symbol("tray"), run: {})]
        }
        return list.map { c in
            var item = LauncherItem(id: "rm:\(c.token)", section: "Installed with Homebrew", title: c.name,
                                    subtitle: c.desc.isEmpty ? c.token : c.desc, icon: .symbol("shippingbox"), badge: "Remove",
                                    run: { [weak self] in self?.remove(c) }, reveal: URL(string: c.homepage))
            if let local = Brew.appPath(for: c, installedApps: apps) { item.icon = .file(local) }
            if jobs[c.token] == .removing { item.badge = "Removing…"; item.state = .working; item.run = {} }
            return item
        }
    }

    private func remove(_ c: Cask) {
        guard ask("Remove \(c.name)?", "Homebrew uninstalls the app. Its documents and settings stay.",
                  button: "Remove", destructive: true) else { return }
        jobs[c.token] = .removing
        rebuild()
        Brew.run(["uninstall", "--cask", c.token]) { [weak self] ok, tail in
            guard let self else { return }
            self.jobs[c.token] = nil
            self.rescanApps()
            Toast.show(ok ? "\(c.name) is removed" : "\(c.name) wasn’t removed: \(tail)",
                       symbol: ok ? "trash.fill" : "exclamationmark.triangle.fill")
            self.rebuild()
        }
    }

    /// App Store results arrive a moment after typing stops, and only in the Install menu.
    private func searchStore() {
        storeWork?.cancel()
        let q = query.trimmingCharacters(in: .whitespaces)
        guard scope == .install, q.count >= 2 else {
            if !storeResults.isEmpty { storeResults = []; rebuild() }
            return
        }
        let work = DispatchWorkItem { [weak self] in
            StoreApp.search(q) { results in
                guard let self, self.query.trimmingCharacters(in: .whitespaces) == q, self.scope == .install else { return }
                self.storeResults = results
                self.rebuildKeepingSelection()
            }
        }
        storeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    // MARK: Files

    /// Spotlight, a moment after typing stops: the top five in the main search, more in Files.
    /// A bang or a question is for the web, not a file name.
    private func searchFiles() {
        fileWork?.cancel()
        fileSearches += 1
        let q = query.trimmingCharacters(in: .whitespaces)
        let forFiles = scope == .files || scope == .root && !q.hasPrefix("!") && !q.hasPrefix("?") && Bangs.parse(q) == nil
        // "room:know tax" looks for "tax" in 3 Know only, and shows more than the main search's five.
        let filter = RoomsProvider.shared.filter(q)
        let words = filter?.words ?? q
        let within = filter.flatMap { f in RoomsProvider.shared.rooms?.url(f.room).path }
        guard forFiles, FileSearch.spotlightQuery(words) != nil else {
            if !fileResults.isEmpty { fileResults = []; rebuild() }
            return
        }
        let search = fileSearches, inScope = scope
        let work = DispatchWorkItem {
            FileFinder.find(words, limit: inScope == .files || within != nil ? 60 : 5, search: search, within: within) { [weak self] hits in
                guard let self, self.fileSearches == search, self.scope == inScope else { return }
                self.fileResults = hits
                self.fileResultsQuery = q
                self.rebuildKeepingSelection()
            }
        }
        fileWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    private func fileItems() -> [LauncherItem] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        // An older search's files stay up while the newer one runs, only those that still match.
        let q = query.trimmingCharacters(in: .whitespaces)
        let words = RoomsProvider.shared.filter(q)?.words ?? q
        let shown = q == fileResultsQuery ? fileResults : fileResults.filter { FileSearch.matches(words, $0.name) }
        return shown.map { f in
            let url = URL(fileURLWithPath: f.path)
            return LauncherItem(id: "file:\(f.path)", section: "Files", title: f.name,
                                subtitle: FileSearch.folder(of: f.path, home: home) + " · ⌘↩ shows it in Finder",
                                icon: .file(f.path), run: { [weak self] in
                                    self?.close()
                                    if !NSWorkspace.shared.open(url) { NSSound.beep() }
                                }, reveal: url)
        }
    }
}

/// Runs `FileSearch`'s query through Spotlight over your own folders (iCloud Drive and cloud
/// drives included, the rest of Library left out), off the main thread, and ranks what it finds.
enum FileFinder {
    private static let queue = DispatchQueue(label: "Polycarp file search", qos: .userInitiated)
    /// Files kept per search for ranking. A two-letter search can match thousands; the ranking
    /// only needs enough to find the few worth showing.
    static let cap = 1000
    /// Matches Spotlight gathers per search, most recently used first. Noise is skipped as it's
    /// read, since Spotlight can't leave it out (it ignores kMDItemPath) and it can be most of
    /// the matches: 4,887 of 5,159 for "ind" in ~/Projects on Donovan's Mac were in node_modules.
    /// Measured there: 6,000 takes 80–580 ms a search; 20,000 took up to 1.9 s.
    static let scanLimit = 6_000
    /// Reading each match's path costs about 0.3 ms, so reading stops after this long with what
    /// it has kept.
    static let readBudget: TimeInterval = 0.3
    /// The newest search asked for. One queued behind it is stale and doesn't run.
    private static let lock = NSLock()
    nonisolated(unsafe) private static var newest = 0
    private static func isNewest(_ n: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return newest == n }

    /// `within` narrows the search to one folder (a room, for "room:know"), with nothing from the home folder's top.
    static func find(_ typed: String, limit: Int, search n: Int, within: String? = nil, done: @escaping ([FileSearch.Hit]) -> Void) {
        guard let text = FileSearch.spotlightQuery(typed) else { return done([]) }
        lock.lock(); newest = n; lock.unlock()
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        queue.async {
            guard isNewest(n) else { return }
            let start = Date()
            let places = within.map { [$0] } ?? scopes(home)
            let hits = search(text, in: places, stale: { !isNewest(n) }) + (within == nil ? topLevel(typed, home) : [])
            guard isNewest(n) else { return }
            let ranked = FileSearch.rank(typed, hits, home: home, limit: limit)
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            DispatchQueue.main.async {
                // One line a search, so an empty list can be told apart from a slow or blocked one.
                Trace.log("files q=\(typed.count)ch places=\(places.count) kept=\(hits.count) shown=\(ranked.count) ms=\(ms)")
                done(ranked)
            }
        }
    }

    /// The home folder's own folders, without Library or hidden ones, plus iCloud Drive and the
    /// cloud drives: noise never takes a place under the cap.
    private static func scopes(_ home: String) -> [String] {
        let fm = FileManager.default
        let top = (try? fm.contentsOfDirectory(atPath: home)) ?? []
        let own = top.filter { name in
            var dir: ObjCBool = false
            return !name.hasPrefix(".") && name != "Library"
                && fm.fileExists(atPath: home + "/" + name, isDirectory: &dir) && dir.boolValue
        }.map { home + "/" + $0 }
        return own + FileSearch.cloudFolders.sorted().map { home + "/Library/" + $0 }.filter { fm.fileExists(atPath: $0) }
    }

    /// Files and folders right in the home folder, which no scope above covers.
    private static func topLevel(_ typed: String, _ home: String) -> [FileSearch.Hit] {
        let top = (try? FileManager.default.contentsOfDirectory(atPath: home)) ?? []
        return top.filter { !$0.hasPrefix(".") && $0 != "Library" && FileSearch.matches(typed, $0) }.map { name in
            let path = home + "/" + name
            let attrs = try? FileManager.default.attributesOfItem(atPath: path)
            return FileSearch.Hit(name: name, path: path, modified: attrs?[.modificationDate] as? Date)
        }
    }

    /// Spotlight hands these back with the results; asking item by item took seconds. The path
    /// isn't one it can (it isn't stored), so that one is asked of each item.
    private static let attributes = [kMDItemFSName, kMDItemLastUsedDate, kMDItemFSContentChangeDate] as [CFString]

    private static func search(_ text: String, in scopes: [String], stale: () -> Bool) -> [FileSearch.Hit] {
        guard !scopes.isEmpty,
              let q = MDQueryCreate(kCFAllocatorDefault, text as CFString, attributes as CFArray, [kMDItemLastUsedDate] as CFArray)
        else { return [] }
        MDQuerySetSearchScope(q, scopes as CFArray, 0)
        MDQuerySetMaxCount(q, scanLimit)
        guard MDQueryExecute(q, CFOptionFlags(kMDQuerySynchronous.rawValue)), !stale() else { return [] }
        func value<T>(_ attr: CFString, _ i: Int) -> T? {
            MDQueryGetAttributeValueOfResultAtIndex(q, attr, i).map { Unmanaged<AnyObject>.fromOpaque($0).takeUnretainedValue() } as? T
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var out: [FileSearch.Hit] = []
        let until = Date().addingTimeInterval(readBudget)
        for i in 0..<MDQueryGetResultCount(q) where out.count < cap {
            if i % 200 == 199 {
                if stale() { return [] }
                if Date() > until { break }
            }
            guard let raw = MDQueryGetResultAtIndex(q, i),
                  let path = MDItemCopyAttribute(Unmanaged<MDItem>.fromOpaque(raw).takeUnretainedValue(), kMDItemPath) as? String,
                  !FileSearch.isNoise(path, home: home)
            else { continue }
            out.append(FileSearch.Hit(name: value(kMDItemFSName, i) ?? (path as NSString).lastPathComponent, path: path,
                                      lastUsed: value(kMDItemLastUsedDate, i), modified: value(kMDItemFSContentChangeDate, i)))
        }
        return out
    }
}

// MARK: Sources

struct AppEntry: Equatable {
    let name: String
    let path: String
    /// Where it lives, for the subtitle: "Applications", "Utilities", "System".
    let folder: String
    /// The name folded for search once, when the list is read, not on every keystroke.
    let key: SearchKey

    init(name: String, path: String, folder: String) {
        self.name = name
        self.path = path
        self.folder = folder
        key = SearchKey(name)
    }

    private static var roots: [(String, String)] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [("/Applications", "Applications"), ("/Applications/Utilities", "Utilities"),
                ("/System/Applications", "Applications"), ("/System/Applications/Utilities", "Utilities"),
                (home + "/Applications", "Your Applications"), ("/System/Library/CoreServices/Applications", "System"),
                ("/Applications/Setapp", "Setapp")]
    }

    /// Every app in the usual folders, plus one folder level down (Adobe and the like). The
    /// first copy of a name wins, in the order above.
    static func scan() -> [AppEntry] {
        let fm = FileManager.default
        var seen = Set<String>()
        var out: [AppEntry] = []
        func add(_ path: String, _ folder: String) {
            let name = fm.displayName(atPath: path).replacingOccurrences(of: ".app", with: "")
            guard seen.insert(name.lowercased()).inserted else { return }
            out.append(AppEntry(name: name, path: path, folder: folder))
        }
        add("/System/Library/CoreServices/Finder.app", "System")
        for (root, folder) in roots {
            guard let names = try? fm.contentsOfDirectory(atPath: root) else { continue }
            for n in names.sorted() where !n.hasPrefix(".") {
                let path = root + "/" + n
                if n.hasSuffix(".app") { add(path, folder); continue }
                guard root.hasSuffix("Applications"), n != "Utilities",
                      let inner = try? fm.contentsOfDirectory(atPath: path) else { continue }
                for m in inner.sorted() where m.hasSuffix(".app") { add(path + "/" + m, n) }
            }
        }
        return out.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

/// Homebrew's list of installable apps, kept on disk and refreshed once a day.
final class CaskCatalog {
    enum State: Equatable { case idle, loading, ready, failed(String) }
    private(set) var casks: [Cask] = []
    private var state = State.idle
    private var waiting: [(State) -> Void] = []
    private static let url = URL(string: "https://formulae.brew.sh/api/cask.json")!
    private static let cache = Spaces.folder.appendingPathComponent("casks.json")

    func reset() { state = .idle }

    func load(_ done: @escaping (State) -> Void) {
        if state == .ready || state == .loading {
            if state == .loading { waiting.append(done) }
            return done(state)
        }
        state = .loading
        waiting = [done]
        done(.loading)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let cached = ((try? Data(contentsOf: Self.cache)).flatMap { try? JSONDecoder().decode([Cask].self, from: $0) } ?? [])
                .filter { Cask.isSafeToken($0.token) }
            let age = (try? FileManager.default.attributesOfItem(atPath: Self.cache.path)[.modificationDate] as? Date)
                .map { Date().timeIntervalSince($0) } ?? .infinity
            if !cached.isEmpty { self?.finish(cached, .ready) }
            guard cached.isEmpty || age > 86_400 else { return }
            URLSession.shared.dataTask(with: Self.url) { data, response, error in
                let ok = (response as? HTTPURLResponse)?.statusCode == 200
                let fresh = ok ? data.map(Cask.parseCatalog) ?? [] : []
                if !fresh.isEmpty {
                    try? FileManager.default.createDirectory(at: Spaces.folder, withIntermediateDirectories: true)
                    try? JSONEncoder().encode(fresh).write(to: Self.cache, options: .atomic)
                    self?.finish(fresh, .ready)
                } else if cached.isEmpty {
                    self?.finish([], .failed(error?.localizedDescription ?? "No answer from formulae.brew.sh"))
                }
            }.resume()
        }
    }

    private func finish(_ list: [Cask], _ s: State) {
        DispatchQueue.main.async {
            self.casks = list
            self.state = s
            let w = self.waiting
            if s != .loading { self.waiting = [] }
            w.forEach { $0(s) }
        }
    }
}

enum Brew {
    static var path: String? {
        ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Tokens of the casks Homebrew has installed, read from its Caskroom folder.
    static func installedCasks() -> Set<String> {
        let rooms = ["/opt/homebrew/Caskroom", "/usr/local/Caskroom"]
        return Set(rooms.flatMap { (try? FileManager.default.contentsOfDirectory(atPath: $0)) ?? [] }.filter(Cask.isSafeToken))
    }

    /// The installed app a cask most likely put in Applications, matched by name.
    static func appPath(for c: Cask, installedApps: [AppEntry]) -> String? {
        let names = [c.name, c.token.replacingOccurrences(of: "-", with: " ")].map { $0.lowercased() }
        return installedApps.first { names.contains($0.name.lowercased()) }?.path
    }

    /// Runs brew without a terminal. An installer that wants a password fails here and is
    /// finished in Terminal instead. Calls back on the main thread with the last useful line.
    static func run(_ args: [String], done: @escaping (Bool, String) -> Void) {
        guard let brew = path, args.dropFirst(2).allSatisfy(Cask.isSafeToken) else { return done(false, "not a Homebrew app name") }
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: brew)
            p.arguments = args
            var env = ProcessInfo.processInfo.environment
            env["HOMEBREW_NO_AUTO_UPDATE"] = "1"
            env["HOMEBREW_NO_ENV_HINTS"] = "1"
            env["NONINTERACTIVE"] = "1"
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            p.environment = env
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            p.standardInput = FileHandle.nullDevice
            var ok = false
            var text = ""
            do {
                try p.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                ok = p.terminationStatus == 0
                text = String(decoding: data, as: UTF8.self)
            } catch {
                text = error.localizedDescription
            }
            let tail = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
                .last { !$0.isEmpty && !$0.hasPrefix("==>") } ?? ""
            DispatchQueue.main.async { done(ok, String(tail.prefix(140))) }
        }
    }

    /// Opens Terminal running brew commands, so their output and any password prompt are in
    /// view. Only brew, and only with fixed words or names that passed `Cask.isSafeToken`, each
    /// quoted, ever reaches the script.
    static func openInTerminal(_ commands: [String]...) {
        let allowed: Set<String> = ["brew", "install", "uninstall", "--cask", "update", "upgrade"]
        guard commands.allSatisfy({ $0.first == "brew" && $0.allSatisfy { allowed.contains($0) || Cask.isSafeToken($0) } }) else { return }
        let lines = commands.map { $0.map { "'\($0)'" }.joined(separator: " ") }.joined(separator: " && ")
        runInTerminal(lines)
    }

    private static func runInTerminal(_ command: String) {
        // One file per run: Ghostty reads it only once its window exists, and a second run must not overwrite it first.
        let url = Spaces.folder.appendingPathComponent("launcher-\(UUID().uuidString.prefix(8).lowercased()).command")
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) { try? FileManager.default.removeItem(at: url) }
        let script = """
        #!/bin/zsh
        export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
        \(command)
        echo
        echo "Finished. You can close this window."

        """
        try? FileManager.default.createDirectory(at: Spaces.folder, withIntermediateDirectories: true)
        try? script.write(to: url, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        // Ghostty asks "Allow Ghostty to execute …?" for every script file it is handed: it runs the script as a window's command instead.
        if Terminals.isGhostty(Terminals.handler()), let ghostty = Terminals.ghostty {
            return ghostty(NSHomeDirectory(), url) { NSWorkspace.shared.open(url) }
        }
        NSWorkspace.shared.open(url)
    }

    /// Homebrew's own installer, from brew.sh, in Terminal where it can ask for a password.
    static func installHomebrew() {
        runInTerminal(#"/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)""#)
    }
}

/// Your terminal, and the coding agents it can run.
enum Terminals {
    /// Opens a Ghostty window in a folder running a script file as its command, or runs the last argument when it
    /// can't (`Engine.runInGhostty`). Set by the app delegate.
    static var ghostty: ((_ dir: String?, _ script: URL, _ orElse: @escaping () -> Void) -> Void)?

    static func isGhostty(_ app: URL?) -> Bool { app.flatMap { Bundle(url: $0)?.bundleIdentifier } == Catalog.known[0].bundleID }

    /// The app that opens .command files now.
    static func handler() -> URL? {
        UTType("com.apple.terminal.shell-script").flatMap { NSWorkspace.shared.urlForApplication(toOpen: $0) }
    }

    private static var found: (at: Date, agents: [String: String])?

    /// The agents on this Mac (command to path), checked off the main thread at most every five
    /// minutes: the usual install folders first, then your login shell's PATH for anything
    /// installed somewhere else. The shell gets two seconds; a profile that leaves something
    /// running in the background can't hold the check open.
    static func installedAgents(_ done: @escaping ([String: String]) -> Void) {
        if let found, Date().timeIntervalSince(found.at) < 300 { return done(found.agents) }
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            var paths: [String: String] = [:]
            for cmd in TerminalAgent.all.map(\.command) {
                paths[cmd] = TerminalAgent.folders.lazy
                    .map { (($0 as NSString).expandingTildeInPath as NSString).appendingPathComponent(cmd) }
                    .first(where: fm.isExecutableFile(atPath:))
            }
            let missing = TerminalAgent.all.map(\.command).filter { paths[$0] == nil }
            if !missing.isEmpty {
                let out = fm.temporaryDirectory.appendingPathComponent("baneyspaces-agents-\(UUID().uuidString)")
                fm.createFile(atPath: out.path, contents: nil)
                defer { try? fm.removeItem(at: out) }
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/bin/zsh")
                p.arguments = ["-lc", "command -v " + missing.joined(separator: " ")]
                p.standardOutput = try? FileHandle(forWritingTo: out)
                p.standardError = FileHandle.nullDevice
                p.standardInput = FileHandle.nullDevice
                if (try? p.run()) != nil {
                    let deadline = Date().addingTimeInterval(2)
                    while p.isRunning && Date() < deadline { usleep(20_000) }
                    if p.isRunning { p.terminate() }
                    let text = (try? String(contentsOf: out, encoding: .utf8)) ?? ""
                    for line in text.split(separator: "\n") where line.hasPrefix("/") && fm.isExecutableFile(atPath: String(line)) {
                        let cmd = (String(line) as NSString).lastPathComponent
                        if missing.contains(cmd) { paths[cmd] = String(line) }
                    }
                }
            }
            DispatchQueue.main.async {
                found = (Date(), paths)
                done(paths)
            }
        }
    }
}

/// A Mac App Store result from Apple's public search.
struct StoreApp: Identifiable {
    let id: Int
    let name: String
    let seller: String
    let price: String
    let bundleID: String?
    let artwork: URL?
    let webURL: URL?
    var storeURL: URL? {
        webURL.flatMap { URL(string: $0.absoluteString.replacingOccurrences(of: "https://", with: "macappstore://")) }
    }

    static func search(_ term: String, done: @escaping ([StoreApp]) -> Void) {
        var c = URLComponents(string: "https://itunes.apple.com/search")!
        c.queryItems = [.init(name: "term", value: term), .init(name: "entity", value: "macSoftware"), .init(name: "limit", value: "6"),
                        .init(name: "country", value: Locale.current.region?.identifier ?? "US")]
        guard let url = c.url else { return done([]) }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let results = (json?["results"] as? [[String: Any]] ?? []).compactMap { r -> StoreApp? in
                guard let id = r["trackId"] as? Int, let name = r["trackName"] as? String else { return nil }
                return StoreApp(id: id, name: name, seller: r["sellerName"] as? String ?? r["artistName"] as? String ?? "",
                                price: r["formattedPrice"] as? String ?? "", bundleID: r["bundleId"] as? String,
                                artwork: (r["artworkUrl100"] as? String).flatMap(URL.init(string:)),
                                webURL: (r["trackViewUrl"] as? String).flatMap(URL.init(string:)))
            }
            DispatchQueue.main.async { done(results) }
        }.resume()
    }
}

/// The Mac's everyday commands.
enum System {
    static func run(_ path: String, _ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        try? p.run()
    }

    /// ⌃⌘Q, the lock shortcut macOS itself listens for.
    static func lock() {
        let src = CGEventSource(stateID: .hidSystemState)
        let q = CGKeyCode(kVK_ANSI_Q)
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: src, virtualKey: q, keyDown: down)
            e?.flags = [.maskCommand, .maskControl]
            e?.post(tap: .cghidEventTap)
        }
    }

    /// Restart, shut down or log out through macOS's own confirmation dialog.
    static func loginWindow(_ event: String) {
        run("/usr/bin/osascript", ["-e", "tell application \"loginwindow\" to «event aevt\(event)»"])
    }

    static func toggleDarkMode() {
        run("/usr/bin/osascript", ["-e", "tell application \"System Events\" to tell appearance preferences to set dark mode to not dark mode"])
    }
}

/// A short message near the top of the screen, for work that finishes after the launcher closed.
enum Toast {
    private static var panel: NSPanel?
    private static var work: DispatchWorkItem?

    /// What it draws, with room around it for the shadow.
    struct Message: View {
        let text: String
        let symbol: String

        var body: some View {
            let sheet = Styles.shared.book.hud, label = sheet.label, icon = sheet.icon
            HStack(spacing: 10) {
                if !icon.isHidden {
                    Image(systemName: symbol).font(Chrome.font(16, .semibold)).opacity(icon.opacity ?? 1)
                        .foregroundStyle(sheet.symbol?.swiftUI ?? Chrome.accent)
                }
                Text(label.cased(text)).spaced(label).font(Styled.font(label, .ui, 13, .semibold)).foregroundStyle(label.ink(Chrome.wash()))
                    .opacity(label.opacity ?? 1)
            }
            .padding(sheet.panel, else: EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16))
            .background(Chrome.panelBackground(.launcherMini, style: sheet.panel))
            .opacity(sheet.panel.opacity ?? 1)
            .padding(24)
            .environment(\.colorScheme, Chrome.scheme)
        }
    }

    static func show(_ text: String, symbol: String) {
        let host = NSHostingView(rootView: Message(text: text, symbol: symbol))
        let size = host.fittingSize
        let p = panel ?? {
            let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = false
            p.ignoresMouseEvents = true
            p.level = .statusBar
            p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
            return p
        }()
        panel = p
        p.contentView = host
        let screen = NSScreen.main ?? NSScreen.screens[0]
        p.setFrame(NSRect(x: screen.visibleFrame.midX - size.width / 2, y: screen.visibleFrame.maxY - size.height,
                          width: size.width, height: size.height), display: true)
        p.alphaValue = 1
        p.orderFrontRegardless()
        work?.cancel()
        let w = DispatchWorkItem {
            NSAnimationContext.runAnimationGroup({ $0.duration = Chrome.duration(0.25, .panelOut); p.animator().alphaValue = 0 }, completionHandler: { p.orderOut(nil) })
        }
        work = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5, execute: w)
    }
}

// MARK: Views

struct LauncherView: View {
    @ObservedObject var model: LauncherModel
    /// Redraws when Settings › Appearance changes.
    @ObservedObject private var appearance = Appearance.shared
    @ObservedObject private var styles = Styles.shared
    /// The row under the pointer, while a rule changes something there.
    @State private var hovered: String?

    /// The panel's size: the sheet's width, on a screen this wide.
    static func size(_ c: ComputedStyle, within width: CGFloat) -> NSSize {
        NSSize(width: c.width.map { min(CGFloat($0), width) } ?? 700, height: 512)
    }

    /// Every part's style, worked out once for the sheet in force (`StyleBook.launcher`).
    private var sheet: LauncherStyles { styles.book.launcher }

    var body: some View {
        let sheet = sheet
        VStack(spacing: 0) {
            searchBar
            if sheet.field.borderBottom == nil { Rectangle().fill(Chrome.edge(0.08)).frame(height: Chrome.width(.launcherPanel)) }
            // The search field stays outside the choice: a sheet that names the launcher for the first time doesn't take
            // the keyboard from it.
            if sheet.plain { list(Bare.self) } else { list(Dressed.self) }
        }
        .padding(sheet.panel, else: EdgeInsets())
        .background(Chrome.panelBackground(.launcherPanel, style: sheet.panel))
        .clipShape(Styled.shape(sheet.panel, else: Chrome.radius(.launcherPanel)))
        .opacity(sheet.panel.opacity ?? 1)
        .environment(\.colorScheme, Chrome.scheme)
        .padding(1)
    }

    @ViewBuilder private func list<D: Dress>(_ d: D.Type) -> some View {
        let footer = sheet.footer
        // A row running under the footer fades out, so it reads as more below and not as a cut.
        results(d).mask(VStack(spacing: 0) {
            Chrome.wash(1)
            LinearGradient(colors: [Chrome.wash(1), Chrome.wash(1).opacity(0)], startPoint: .top, endPoint: .bottom).frame(height: 18)
        })
        if !footer.isHidden, footer.border == nil { Rectangle().fill(Chrome.edge(0.08)).frame(height: Chrome.width(.launcherPanel)) }
        self.footer(d, footer)
    }

    private var searchBar: some View {
        let field = sheet.field
        // The field and the strip it sits in grow with the sheet's text.
        let line = max(30, (field.fontSize.map { CGFloat($0) } ?? 0) * 1.4)
        return HStack(spacing: 10) {
            Image(systemName: model.scope.symbol).font(Chrome.font(18, .medium)).foregroundStyle(field.ink(Chrome.wash(0.6), dim: 0.6))
                .frame(width: 24)
            if model.scope != .root {
                HStack(spacing: 4) {
                    Text(model.scope.title)
                    Image(systemName: "xmark").font(Chrome.font(9, .bold)).opacity(0.7)
                }
                .font(Chrome.font(13, .semibold))
                .foregroundStyle(Chrome.onAccent)
                .padding(.horizontal, 9).padding(.vertical, 4)
                .background(Capsule().fill(Chrome.accent.opacity(0.85)))
                .onTapGesture { model.back() }
                .accessibilityLabel("\(model.scope.title) menu. Press Delete to go back.")
            }
            SearchField(model: model, placeholder: model.scope.placeholder, style: field)
                .frame(height: line)
        }
        .padding(field, else: EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
        .frame(height: field.padding == nil ? 32 + line : nil)
        .background { StyledBack(field) }
        .opacity(field.opacity ?? 1)
    }

    private func results<D: Dress>(_ d: D.Type) -> some View {
        let sheet = sheet, section = sheet.section, gap = sheet.panel.gap.map { CGFloat($0) } ?? 2
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: gap) {
                    // One view per item, header included, so the list never mixes old and new rows.
                    ForEach(Array(model.items.enumerated()), id: \.element.id) { i, item in
                        VStack(alignment: .leading, spacing: gap) {
                            if !section.isHidden, i == 0 || model.items[i - 1].section != item.section {
                                Text(section.textTransform == nil ? item.section.uppercased() : section.cased(item.section))
                                    .spaced(section, tracking: 0.8).font(Styled.font(section, .ui, 10, .bold))
                                    .foregroundStyle(section.ink(Chrome.muted))
                                    .padding(section, else: EdgeInsets(top: i == 0 ? 4 : 10, leading: 12, bottom: 2, trailing: 0))
                                    .modifier(D.plate(section))
                            }
                            row(d, item, sheet.row(selected: i == model.selected, hover: hovered == item.id), selected: i == model.selected)
                                .modifier(D.hover(on: sheet.hovers) { over in
                                    if over { hovered = item.id } else if hovered == item.id { hovered = nil }
                                })
                        }
                        .id(item.id)
                    }
                    if model.items.isEmpty {
                        Text("Nothing matches “\(model.query)”").font(Styled.font(sheet.panel, orNone: 13))
                            .foregroundStyle(sheet.panel.ink(Chrome.wash(0.5), dim: 0.5))
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                }
                .padding(8)
                .id(model.scope)
            }
            .onChange(of: model.selected) { i in
                if model.items.indices.contains(i) { proxy.scrollTo(model.items[i].id) }
            }
        }
    }

    private func row<D: Dress>(_ d: D.Type, _ item: LauncherItem, _ c: LauncherStyles.Row, selected: Bool) -> some View {
        // A row as short as the sheet makes it still holds its icon.
        let icon = c.box.height.map { min(30, CGFloat($0) - 4) } ?? 30
        return HStack(spacing: c.box.gap.map { CGFloat($0) } ?? 12) {
            iconView(item.icon, c.icon).modifier(D.cut(c.icon)).frame(width: icon, height: icon).modifier(D.part(c.icon))
            names(d, item, c, subtitle: true, selected: selected).modifier(D.fit(c.box) { AnyView(names(d, item, c, subtitle: false, selected: selected)) })
            Spacer(minLength: 8)
            if item.state == .working { ProgressView().controlSize(.small).scaleEffect(0.8) }
            // The Tab hint only where Tab would act; a status such as "Installing…" always shows.
            if !c.badge.isHidden, !item.badge.isEmpty, selected || item.badge != "⇥" { badge(d, item.badge, c.badge, strong: selected) }
            HStack(spacing: 3) { ForEach(item.workspaces.prefix(5), id: \.self) { WorkspaceBadge(n: $0, size: 18) } }
        }
        .padding(c.box, else: EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10))
        .frame(height: c.box.height.map { CGFloat($0) } ?? 46)
        .background(D.back(c.box, .launcherRow).fill(selected ? Chrome.lit(Chrome.accent, 0.22) : .clear).marking(selected && !c.marked))
        .overlay(alignment: .leading) {
            if selected, !c.marked || (c.box.border == nil && c.box.borderBottom == nil) {
                Chrome.pill().fill(Chrome.accent).frame(width: 3, height: 22).offset(x: 1)
            }
        }
        .modifier(D.part(c.box))
        .contentShape(Rectangle())
        .onTapGesture { model.run(item) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    /// A row's title, and the line under it.
    private func names<D: Dress>(_ d: D.Type, _ item: LauncherItem, _ c: LauncherStyles.Row, subtitle: Bool, selected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(c.title.cased(item.title)).spaced(c.title).font(Styled.font(c.title, .ui, 14, .semibold))
                .foregroundStyle(c.title.ink(Chrome.wash())).lineLimit(1).modifier(D.part(c.title))
            if subtitle, !item.subtitle.isEmpty, !c.subtitle.isHidden {
                Text(c.subtitle.cased(item.subtitle)).spaced(c.subtitle).font(Styled.font(c.subtitle, .ui, 11.5))
                    .foregroundStyle(item.state == .failed ? Chrome.role(selected ? Chrome.look.roleOnSelection("urgent") : "urgent") : c.subtitle.ink(Chrome.muted)).lineLimit(1)
                    .modifier(D.part(c.subtitle))
            }
        }
    }

    private func badge<D: Dress>(_ d: D.Type, _ text: String, _ c: ComputedStyle, strong: Bool) -> some View {
        // The one filled with the accent keeps the text that reads on it, unless the sheet fills it.
        let filled = text == "Install" && strong
        return Text(c.cased(text)).spaced(c)
            .font(Styled.font(c, .ui, 11, .semibold, rounded: text.count <= 5))
            .foregroundStyle(filled && c.background == nil ? Chrome.onAccent : c.ink(filled ? Chrome.onAccent : Chrome.wash(strong ? 0.95 : 0.6)))
            .padding(c, else: EdgeInsets(top: 3, leading: 8, bottom: 3, trailing: 8))
            .background(D.pill(c, .launcherRow, filled ? Chrome.accent : c.ink(Chrome.wash(0.1), dim: 0.1)))
            .modifier(D.part(c))
    }

    @ViewBuilder private func iconView(_ icon: LauncherItem.Icon, _ c: ComputedStyle) -> some View {
        switch icon {
        case .file(let path): Image(nsImage: model.icon(for: path)).resizable().interpolation(.high)
        case .image(let img): Image(nsImage: img).resizable()
        case .symbol(let name):
            Chrome.shape(.launcherThumb).fill(c.ink(Chrome.wash(0.09), dim: 0.09))
                .overlay(Image(systemName: name).font(Chrome.font(14, .medium)).foregroundStyle(c.ink(Chrome.wash(0.85))))
        case .remote(let url):
            AsyncImage(url: url) { $0.resizable() } placeholder: { Chrome.shape(.launcherImage, continuous: false).fill(Chrome.wash(0.08)) }
                .clipShape(Chrome.shape(.launcherImage))
        }
    }

    private func footer<D: Dress>(_ d: D.Type, _ c: ComputedStyle) -> some View {
        HStack(spacing: 16) {
            hint("↩", "Open", c)
            hint("⌘↩", model.items.indices.contains(model.selected) && !model.items[model.selected].alternateTitle.isEmpty
                 ? model.items[model.selected].alternateTitle : "Show in Finder", c)
            hint("⇥", "Open menu", c)
            if model.scope != .root { hint("⌫", "Back", c) }
            Spacer()
            hint("esc", "Close", c)
        }
        .padding(c, else: EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
        .frame(minHeight: c.padding == nil ? 34 : nil, maxHeight: c.padding == nil && c.fontSize == nil ? 34 : nil)
        .modifier(D.plate(c))
    }

    private func hint(_ key: String, _ what: String, _ c: ComputedStyle) -> some View {
        HStack(spacing: 5) {
            Text(key).spaced(c).font(Styled.font(c, .ui, 10.5, .semibold, rounded: true))
                .padding(.horizontal, 5).padding(.vertical, 1.5)
                .background(Chrome.shape(.launcherKey, continuous: false).fill(c.ink(Chrome.wash(0.1), dim: 0.1)))
            Text(c.cased(what)).spaced(c).font(Styled.font(c, .ui, 11)).lineLimit(1)
        }
        .foregroundStyle(c.ink(Chrome.muted))
    }
}

/// The search box: an AppKit field, so arrow keys, Return, Tab and Esc steer the list.
private struct SearchField: NSViewRepresentable {
    @ObservedObject var model: LauncherModel
    var placeholder: String
    let style: ComputedStyle

    private var font: NSFont { Styled.nsFont(style, 21) }
    private var ink: NSColor { style.color?.nsColor ?? Chrome.nsWash() }
    /// What the field says while it is empty: a third of the text's color.
    private var faint: NSColor { style.color.map { $0.nsColor.withAlphaComponent(CGFloat($0.alpha) * 0.35) } ?? Chrome.nsWash(0.35) }

    func makeNSView(context: Context) -> NSTextField {
        let f = NSTextField()
        f.isBordered = false
        f.drawsBackground = false
        f.focusRingType = .none
        f.font = font
        f.textColor = ink
        f.delegate = context.coordinator
        f.cell?.lineBreakMode = .byTruncatingTail
        model.field = f
        return f
    }

    func updateNSView(_ f: NSTextField, context: Context) {
        f.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [
            .foregroundColor: faint, .font: font,
        ])
        f.font = font
        f.textColor = ink
        if f.stringValue != model.query { f.stringValue = model.query }
    }

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        let model: LauncherModel
        init(model: LauncherModel) { self.model = model }

        func controlTextDidChange(_ n: Notification) {
            guard let f = n.object as? NSTextField else { return }
            model.query = f.stringValue
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
            switch sel {
            case #selector(NSResponder.moveDown(_:)): model.move(1)
            case #selector(NSResponder.moveUp(_:)): model.move(-1)
            case #selector(NSResponder.insertNewline(_:)):
                model.runSelected(reveal: NSEvent.modifierFlags.contains(.command))
            case #selector(NSResponder.insertTab(_:)): model.tab()
            case #selector(NSResponder.cancelOperation(_:)):
                if !model.query.isEmpty { model.query = "" } else if model.scope != .root { model.back() } else { model.close() }
            case #selector(NSResponder.deleteBackward(_:)) where model.query.isEmpty && model.scope != .root:
                model.back()
            default: return false
            }
            return true
        }
    }
}
