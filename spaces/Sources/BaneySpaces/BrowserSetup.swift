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
    var available: Bool { helper.map { FileManager.default.isExecutableFile(atPath: $0.path) } ?? false }

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
        guard let helper, !refreshing else { return }
        refreshing = true
        pollQueue.async { [weak self] in
            // A new app brings a new extension: the copy the browser loads is refreshed before anyone is asked to reload.
            _ = self?.loadableFolder()
            let result = Self.run(helper, ["doctor", "--json"], timeout: 12)
            let parsed = BrowserStatus.parse(result.out)
            DispatchQueue.main.async {
                self?.refreshing = false
                if let parsed, parsed != self?.status { self?.status = parsed }
            }
        }
    }

    /// The Extension folder in Application Support, current for this app (see `ExtensionCopy`).
    func loadableFolder() -> URL? {
        guard let source = extensionFolder else { return nil }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        return ExtensionCopy.refresh(source: source, supportDir: Product.supportDir(home: home), appVersion: version)
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
                Text("This copy of Polycarp doesn't include the browser helper. Install the release from github.com/baney75/polycarp.")
                    .font(Chrome.font(12)).foregroundStyle(.secondary)
            } else {
                browsers
                agents
                BrowserRemoteView()
                if let m = model.message { Text(m).font(Chrome.font(12)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            }
        }
        .onAppear { model.startWatching() }
        .onDisappear { model.stopWatching() }
    }

    private var browsers: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Browsers").font(Chrome.font(13, .bold))
            if let s = model.status, s.unattributed {
                // An older extension or helper doesn't say which browser it is in: one line for the connection.
                Label("Connected\(s.extensionVersion.map { " (extension \($0))" } ?? "")", systemImage: "checkmark.circle.fill")
                    .font(Chrome.font(12, .medium)).foregroundStyle(Color.green)
            }
            if model.status == nil {
                Text("Looking…").font(Chrome.font(12)).foregroundStyle(.secondary)
            } else if model.rows.isEmpty {
                Text("No Chromium browser found. Install Helium, Chrome, Brave, Edge or Arc, open it once, then come back.")
                    .font(Chrome.font(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(model.rows) { row in
                HStack(spacing: 8) {
                    Text(row.name).font(Chrome.font(12))
                    Spacer()
                    switch row.state {
                    case .connected:
                        Label("Connected", systemImage: "checkmark.circle.fill").font(Chrome.font(12, .medium)).foregroundStyle(Color.green)
                    case .reload(_, _):
                        Text("Reload the extension").font(Chrome.font(12)).foregroundStyle(.orange)
                        Button("Connect") { model.connect(row.name) }.disabled(model.busy)
                    case .connect:
                        Button("Connect") { model.connect(row.name) }.disabled(model.busy)
                    }
                }
            }
        }
    }

    private var agents: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Agents").font(Chrome.font(13, .bold))
            if let s = model.status {
                ForEach(s.agents) { a in
                    HStack(spacing: 8) {
                        Image(systemName: a.connected ? "checkmark.circle.fill" : "circle").foregroundStyle(a.connected ? Color.green : Color.secondary)
                        Text(a.name).font(Chrome.font(12))
                        Text(a.connected ? "can use the browser" : "not added").font(Chrome.font(11)).foregroundStyle(.secondary)
                    }
                }
                if s.agents.isEmpty { Text("No agent found on this Mac.").font(Chrome.font(12)).foregroundStyle(.secondary) }
                if !s.addable.isEmpty {
                    Button(model.busy ? "Adding…" : "Add to Claude Code and Codex") { model.addAgents() }.disabled(model.busy)
                }
            }
            Text("`polycarp browser` is the command; `tabkyra` still works as another name for it.")
                .font(Chrome.font(11)).foregroundStyle(.secondary)
        }
    }
}
