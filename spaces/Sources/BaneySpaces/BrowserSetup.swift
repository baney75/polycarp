import AppKit
import BaneySpacesCore
import SwiftUI

/// Settings > Browser and the welcome window's Browser row. The bundled helper does the work (`install`, `setup`, `doctor`);
/// this runs it and shows what it says. Status is read again every two seconds while a view that shows it is open.
final class BrowserModel: ObservableObject {
    static let shared = BrowserModel()
    @Published var status: BrowserStatus?
    @Published var busy = false
    @Published var message: String?
    private var timer: Timer?
    private var watchers = 0
    /// A refresh is running: the 2-second poll skips instead of queuing another behind a slow doctor.
    private var refreshing = false
    /// Connect and Add run here; the poll has its own queue, so a click never waits behind a slow `doctor`.
    private let queue = DispatchQueue(label: "polycarp.browser", qos: .userInitiated)
    private let pollQueue = DispatchQueue(label: "polycarp.browser.poll", qos: .utility)

    private var resources: URL? { Bundle.main.resourceURL }
    var helper: URL? { BrowserBundle.helper(resources: resources) }
    var extensionFolder: URL? { BrowserBundle.extensionFolder(resources: resources) }
    private var renderSample = false
    var available: Bool { renderSample || helper.map { FileManager.default.isExecutableFile(atPath: $0.path) } ?? false }

    private static let renderSampleJSON = #"""
    {"checks":[{"id":"host:Helium","status":"ok","label":"Helium: native host registered"},{"id":"host:Chrome","status":"warn","label":"Chrome: not connected yet"},{"id":"connected","status":"ok","label":"Extension connected (1.1.10)"},{"id":"connected:Helium","status":"ok","label":"Helium (1.1.10)"},{"id":"mcp:claude","status":"ok","label":"Claude Code: Polycarp MCP server configured"},{"id":"mcp:codex","status":"warn","label":"Codex: not added"}]}
    """#

    /// `--render` only: sample browsers and agents, so Settings > Browser draws its real rows with no helper running.
    func useRenderSample() {
        renderSample = true
        status = BrowserStatus.parse(Data(BrowserModel.renderSampleJSON.utf8))
    }

    func startWatching() {
        watchers += 1
        refresh()
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func stopWatching() {
        watchers = max(0, watchers - 1)
        if watchers == 0 { timer?.invalidate(); timer = nil }
    }

    func refresh() {
        guard let helper, !refreshing, PartsModel.shared.current.contains(.browser) else { return }
        refreshing = true
        pollQueue.async { [weak self] in
            // A new app brings a new extension: the copy the browser loads is refreshed, and a browser running the old one
            // reloads. With no browser connected the command does nothing, and the browser reads the new copy when it starts.
            let before = self?.loadedBuild()
            _ = self?.loadableFolder()
            if let before, let after = self?.loadedBuild(), before != after { _ = Self.run(helper, ["reload"], timeout: 8) }
            let result = Self.run(helper, ["doctor", "--json"], timeout: 12)
            var parsed = BrowserStatus.parse(result.out)
            parsed?.anySite = BrowserStatus.anySite(fromStatus: Self.run(helper, ["status", "--json"], timeout: 6).out)
            parsed?.claudeAllowed = ClaudeAllowRule.isOn(try? Data(contentsOf: Self.claudeSettings.resolvingSymlinksInPath()))
            DispatchQueue.main.async {
                self?.refreshing = false
                if let parsed, parsed != self?.status { self?.status = parsed }
            }
        }
    }

    /// Puts the browser link in the state Settings > General says. Off, the browser can't start the helper again, and a
    /// helper it already started is stopped, so an agent mid-task loses the browser now rather than at the next restart.
    func applyPart(on: Bool) {
        queue.async { [self] in
            BrowserHosts.setEnabled(on, home: FileManager.default.homeDirectoryForCurrentUser)
            if on { _ = loadableFolder(); return }
            guard let helper else { return }
            let ps = Self.run(URL(fileURLWithPath: "/bin/ps"), ["-axo", "pid=,command="], timeout: 5)
            for pid in BrowserHosts.hostPids(ps: String(decoding: ps.out, as: UTF8.self), helper: helper.path) { kill(pid, SIGTERM) }
        }
    }

    /// The Extension folder in Application Support, current for this app (see `ExtensionCopy`).
    func loadableFolder() -> URL? {
        guard let source = extensionFolder else { return nil }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        return ExtensionCopy.refresh(source: source, supportDir: Product.supportDir(home: home), appVersion: version)
    }

    /// The build in the folder the browser loads.
    private func loadedBuild() -> String? {
        ExtensionCopy.buildID(of: ExtensionCopy.destination(supportDir: Product.supportDir(home: FileManager.default.homeDirectoryForCurrentUser)))
    }

    /// The version of the extension shipped in this app.
    var bundledVersion: String? { extensionFolder.flatMap { ExtensionCopy.manifestVersion(of: $0) } }

    /// One row per installed browser; each says whether it holds the connection (the helper names the browser).
    var rows: [BrowserRow] { status.map { BrowserRows.rows($0, bundledVersion: bundledVersion) } ?? [] }

    /// Registers the helper with this one browser, opens its extensions page, and shows the panel with the folder to drag.
    func connect(_ browser: String) {
        guard let helper else { return }
        busy = true; message = nil
        queue.async { [weak self] in
            // Write down what the helper may overwrite, once, for uninstall.sh to put back.
            let home = FileManager.default.homeDirectoryForCurrentUser
            BrowserPrevious.record(home: home, store: Product.supportDir(home: home).appendingPathComponent("browser-previous", isDirectory: true))
            let folder = self?.loadableFolder()
            let result = Self.run(helper, ["install", "--browser", browser], timeout: 30)
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                if result.code != 0 { self.message = "Couldn't set up \(browser): \(result.text)"; return }
                guard let folder else { self.message = "Couldn't copy the extension to Application Support."; return }
                // By bundle id, so a browser outside /Applications (Setapp, an external drive) opens like any other.
                if let id = BrowserBundle.bundleID(for: browser),
                   let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id),
                   let url = URL(string: BrowserBundle.extensionsAddress(for: browser)) {
                    NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
                } else {
                    self.message = BrowserBundle.openYourselfMessage(for: browser)
                }
                BrowserDropPanel.shared.show(browser: browser, folder: folder)
                self.refresh()
            }
        }
    }

    /// The helper's own setup adds the MCP server to Claude Code and Codex (it edits nothing else).
    /// Always allow: agents open any site without asking, or ask again.
    func setAnySite(_ on: Bool) { runThenRefresh([on ? "allow-all" : "ask"], failure: "Changing site access failed") }

    /// What "Turn on everything" covers in the browser and Claude Code, after the person's yes. Each is the same switch as in Settings.
    func turnOnEverything() {
        if status?.claudeReady == true, status?.claudeAllowed != true { setClaudeAllowed(true) }
        switch status?.anySite {
        case .some(false): setAnySite(true)
        case .some(true): break
        case nil: message = AgentEverything.openBrowser
        }
    }

    /// Always allow: Claude Code stops asking before Polycarp's tools, or asks again.
    func setClaudeAllowed(_ on: Bool) {
        busy = true; message = nil
        queue.async { [weak self] in
            let file = Self.claudeSettings.resolvingSymlinksInPath()
            let attributes = try? FileManager.default.attributesOfItem(atPath: file.path)
            let ok = ClaudeAllowRule.applied(on, to: try? Data(contentsOf: file)).map { (data: Data) -> Bool in
                try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                guard (try? data.write(to: file, options: .atomic)) != nil else { return false }
                let mode = attributes?[.posixPermissions] ?? NSNumber(value: 0o600)
                try? FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: file.path)
                return true
            } ?? false
            DispatchQueue.main.async {
                self?.busy = false
                if !ok { self?.message = "\(file.path) isn't valid JSON, so it was left alone." }
                self?.refresh()
            }
        }
    }

    private static var claudeSettings: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/settings.json")
    }

    private func runThenRefresh(_ args: [String], failure: String) {
        guard let helper else { return }
        busy = true; message = nil
        queue.async { [weak self] in
            let result = Self.run(helper, args, timeout: 15)
            DispatchQueue.main.async {
                self?.busy = false
                if result.code != 0 { self?.message = "\(failure): \(result.text)" }
                self?.refresh()
            }
        }
    }

    func addAgents() {
        guard let helper else { return }
        busy = true; message = nil
        queue.async { [weak self] in
            let result = Self.run(helper, ["setup", "--yes", "--no-wait"], timeout: 120)
            DispatchQueue.main.async {
                self?.busy = false
                if result.code != 0 { self?.message = "Adding agents failed: \(result.text)" }
                self?.refresh()
            }
        }
    }

    /// The person's PATH as a login shell sets it, read once (3 s at most). Nil if the shell doesn't answer.
    static let loginPath: String? = BrowserBundle.readLoginPath(
        shell: URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? "/bin/zsh"))

    struct Result { var code: Int32; var out: Data; var text: String }

    /// Runs the helper and waits at most `timeout` seconds. It runs as the person, in their home, never through a shell.
    static func run(_ exe: URL, _ args: [String], timeout: TimeInterval) -> Result {
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        p.environment = BrowserBundle.environment(base: ProcessInfo.processInfo.environment, loginPath: Self.loginPath)
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return Result(code: 127, out: Data(), text: "\(error.localizedDescription)") }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()
        let text = String(decoding: data.suffix(300), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return Result(code: p.terminationStatus, out: data, text: text)
    }
}

/// The Browser tab: each installed browser, connected or a Connect button, and which agents can use it.
struct BrowserSettingsView: View {
    @ObservedObject var model = BrowserModel.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if !model.available {
                SettingsGroup { SettingsNote("This copy of Polycarp doesn't include the browser helper. Install the release from github.com/baney75/polycarp.") }
            } else {
                browsers
                agents
                BrowserRemoteView()
                if let m = model.message { SettingsGroup { SettingsNote(m, tone: .urgent) } }
            }
        }
        .onAppear { model.startWatching() }
        .onDisappear { model.stopWatching() }
    }

    private var browsers: some View {
        SettingsGroup("Browsers") {
            if let s = model.status, s.unattributed {
                // An older extension or helper doesn't say which browser it is in: one line for the connection.
                SettingsRow("Extension\(s.extensionVersion.map { " \($0)" } ?? "")") { SettingsStatusLabel(text: "Connected") }
            }
            if model.status == nil {
                SettingsNote("Looking…")
            } else if model.rows.isEmpty {
                SettingsNote("No Chromium browser found. Install Helium, Chrome, Brave, Edge or Arc, open it once, then come back.")
            }
            ForEach(model.rows) { row in
                switch row.state {
                case .connected:
                    SettingsRow(row.name) { SettingsStatusLabel(text: "Connected") }
                case .reload(_, _):
                    SettingsRow(row.name, help: "Reload the extension") { connect(row.name) }
                case .connect:
                    SettingsRow(row.name) { connect(row.name) }
                }
            }
        }
    }

    private func connect(_ browser: String) -> some View {
        Button("Connect") { model.connect(browser) }.disabled(model.busy)
    }

    private var agents: some View {
        SettingsGroup("Agents") {
            if let s = model.status {
                ForEach(s.agents) { a in
                    SettingsRow(a.name) {
                        SettingsStatusLabel(text: a.connected ? "Can use the browser" : "Not added", done: a.connected)
                    }
                }
                if s.agents.isEmpty { SettingsNote("No agent found on this Mac.") }
                if !s.addable.isEmpty {
                    SettingsRow("Let your agents use the browser") {
                        Button(model.busy ? "Adding…" : "Add to \(s.addable.map(\.name).joined(separator: " and "))") { model.addAgents() }.disabled(model.busy)
                    }
                }
            }
            SettingsNote("In a terminal, the command is polycarp browser.")
        }
    }
}
