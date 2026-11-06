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
            let result = Self.run(helper, ["doctor", "--json"], timeout: 12)
            let parsed = BrowserStatus.parse(result.out)
            DispatchQueue.main.async {
                self?.refreshing = false
                if let parsed, parsed != self?.status { self?.status = parsed }
            }
        }
    }

    /// Registers the helper with the browsers, then opens the browser on its extensions page with the folder to load shown.
    func connect(_ browser: String) {
        guard let helper, let folder = extensionFolder else { return }
        busy = true; message = nil
        queue.async { [weak self] in
            // Write down what `install --force` is about to overwrite, once, for uninstall.sh to put back.
            let home = FileManager.default.homeDirectoryForCurrentUser
            BrowserPrevious.record(home: home, store: Product.supportDir(home: home).appendingPathComponent("browser-previous", isDirectory: true))
            let result = Self.run(helper, ["install", "--force"], timeout: 30)
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                if result.code != 0 { self.message = "Couldn't register with \(browser): \(result.text)"; return }
                NSWorkspace.shared.activateFileViewerSelecting([folder])
                let name = BrowserBundle.appName(for: browser)
                let candidates = ["/Applications/\(name).app", NSHomeDirectory() + "/Applications/\(name).app"]
                if let path = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }),
                   let url = URL(string: BrowserBundle.extensionsAddress) {
                    NSWorkspace.shared.open([url], withApplicationAt: URL(fileURLWithPath: path), configuration: NSWorkspace.OpenConfiguration())
                } else {
                    self.message = "Open \(browser) and go to \(BrowserBundle.extensionsAddress) yourself; the folder is shown in Finder."
                }
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

/// The Browser tab: which browsers were found, whether the extension is connected, and which agents can use it.
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
            if let s = model.status {
                HStack(spacing: 8) {
                    Image(systemName: s.extensionConnected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(s.extensionConnected ? Color.green : Color.secondary)
                    Text(s.extensionConnected ? "Connected\(s.extensionVersion.map { " (extension \($0))" } ?? "")" : "Not connected yet")
                        .font(Chrome.font(12, .medium))
                }
                if s.browsers.isEmpty {
                    Text("No Chromium browser found. Open Helium, Chrome, Brave, Edge, Arc or another Chromium browser once, then come back.")
                        .font(Chrome.font(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(s.browsers) { b in
                    HStack {
                        Text(b.name).font(Chrome.font(12))
                        Text(b.registered ? "ready" : "not set up").font(Chrome.font(11)).foregroundStyle(.secondary)
                        Spacer()
                        Button(s.extensionConnected ? "Reconnect" : "Connect") { model.connect(b.name) }.disabled(model.busy)
                    }
                }
            } else {
                Text("Looking…").font(Chrome.font(12)).foregroundStyle(.secondary)
            }
            Text("1. Click Connect. The browser opens its extensions page and the extension folder shows in Finder.\n2. Turn on Developer mode, top right.\n3. Click Load unpacked and choose that folder. This window updates by itself.\nIf Polycarp's extension is already loaded, Connect just registers it again.")
                .font(Chrome.font(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
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
            Text("The command is still called tabkyra, and `polycarp browser` runs the same thing.")
                .font(Chrome.font(11)).foregroundStyle(.secondary)
        }
    }
}
