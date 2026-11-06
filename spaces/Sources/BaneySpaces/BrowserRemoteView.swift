import AppKit
import BaneySpacesCore
import SwiftUI

/// Settings > Browser > "Use your browser from Claude, ChatGPT and Grok". Off until a person clicks Turn on. The bundled helper
/// does the work (`remote status|setup|off`, Tailscale Funnel on the person's own free account) and answers in JSON;
/// `RemoteFlow` picks the one step to show. Reading status is all this does on its own.
final class BrowserRemoteModel: ObservableObject {
    static let shared = BrowserRemoteModel()
    @Published private(set) var status: RemoteReport?
    @Published private(set) var setup: RemoteReport?
    @Published private(set) var settingUp = false
    @Published private(set) var working = false
    /// The approval passcode, from the run that made it. Memory only: shown until the person says they've saved it.
    @Published private(set) var passcode: String?
    @Published private(set) var note: String?
    @Published private(set) var copied: String?
    /// Status reads in a row that gave no usable answer.
    @Published private(set) var failedReads = 0
    private var setupAt: Date?
    /// Bumped by every click that changes things. A status read that started before the click is out of date and is dropped.
    private var generation = 0
    private var timer: Timer?
    private var watchers = 0
    private var refreshing = false
    private let queue = DispatchQueue(label: "polycarp.browser.remote", qos: .userInitiated)
    private let pollQueue = DispatchQueue(label: "polycarp.browser.remote.poll", qos: .utility)

    private var helper: URL? { BrowserBundle.helper(resources: Bundle.main.resourceURL) }
    var available: Bool { helper.map { FileManager.default.isExecutableFile(atPath: $0.path) } ?? false }

    var screen: RemoteScreen {
        RemoteFlow.screen(helperAvailable: available, settingUp: settingUp, status: status, setup: setup,
                          setupAge: setupAt.map { Date().timeIntervalSince($0) } ?? 0, readsFailing: failedReads >= RemoteFlow.readFailureLimit)
    }
    /// A Turn on just succeeded and the status reads haven't confirmed it yet (and the grace period isn't over).
    private var bridging: Bool {
        setup?.state == .on && (setupAt.map { Date().timeIntervalSince($0) < RemoteFlow.grace(for: status) } ?? false)
    }
    var passcodeSet: Bool { status?.passcodeSet ?? setup?.passcodeSet ?? false }

    // MARK: Reading

    func startWatching() {
        watchers += 1
        refresh()
        schedule()
    }

    func stopWatching() {
        watchers = max(0, watchers - 1)
        if watchers == 0 { timer?.invalidate(); timer = nil }
    }

    private func schedule() {
        timer?.invalidate()
        guard watchers > 0 else { return }
        timer = Timer.scheduledTimer(withTimeInterval: RemoteFlow.pollInterval(for: screen, status: status, bridging: bridging), repeats: false) { [weak self] _ in
            self?.refresh()
            self?.schedule()
        }
    }

    func refresh() {
        guard available, !refreshing, !settingUp, !working else { return }
        refreshing = true
        let started = generation
        pollQueue.async { [weak self] in
            let result = Self.run(.status)
            let parsed = RemoteReport.parse(result.out)
            DispatchQueue.main.async {
                guard let self else { return }
                self.refreshing = false
                // A click happened while this read ran: its answer describes the old state. Read again.
                guard started == self.generation else { self.refresh(); return }
                guard let parsed else { self.failedReads += 1; return }
                if self.failedReads != 0 { self.failedReads = 0 }
                let kept = RemoteFlow.settle(setup: self.setup, status: parsed)
                if kept != self.setup { self.setup = kept }
                if parsed != self.status { self.status = parsed }
            }
        }
    }

    // MARK: Acting (each one a click)

    func turnOn() {
        guard available, !settingUp, !working else { return }
        settingUp = true; note = nil; generation += 1; failedReads = 0
        queue.async { [weak self] in
            let result = Self.run(.setup)
            let parsed = RemoteReport.parse(result.out)
            DispatchQueue.main.async {
                guard let self else { return }
                self.settingUp = false
                let report = parsed ?? RemoteReport(state: .problem, message: RemoteCopy.helperSilent)
                self.passcode = RemoteFlow.keepPasscode(current: self.passcode, from: report)
                self.setup = report
                self.setupAt = Date()
                if report.state == .on {
                    // The success speaks for itself only briefly: when the grace is over, whatever status says takes over.
                    for grace in [RemoteFlow.setupGrace, RemoteFlow.dnsGrace] {
                        DispatchQueue.main.asyncAfter(deadline: .now() + grace + 0.5) { [weak self] in
                            self?.objectWillChange.send()
                            self?.refresh()
                        }
                    }
                }
                self.refresh()
            }
        }
    }

    func checkAgain() {
        setup = nil; note = nil; generation += 1; failedReads = 0
        refresh()
    }

    func turnOff() {
        guard available, !settingUp, !working else { return }
        working = true; note = nil; generation += 1
        queue.async { [weak self] in
            let result = Self.run(.off)
            DispatchQueue.main.async {
                guard let self else { return }
                self.working = false
                if result.code == 0 {
                    self.setup = nil; self.setupAt = nil; self.passcode = nil; self.status = nil; self.failedReads = 0
                } else {
                    self.note = RemoteCopy.turnOffFailed + (result.text.isEmpty ? "" : " \(result.text)")
                }
                self.refresh()
            }
        }
    }

    func newPasscode() {
        guard available, !settingUp, !working else { return }
        working = true; note = nil; generation += 1
        queue.async { [weak self] in
            let result = Self.run(.newPasscode)
            let code = RemoteCommand.parsePasscode(result.out)
            DispatchQueue.main.async {
                guard let self else { return }
                self.working = false
                if let code { self.passcode = code } else { self.note = "Couldn't make a new passcode. Try again." }
            }
        }
    }

    func savedPasscode() { passcode = nil }

    func copy(_ text: String, label: String, secret: Bool = false) {
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(text, forType: .string)
        if secret {
            // Clipboard managers that honor this skip the entry.
            board.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
            // The passcode doesn't stay on the clipboard: after a minute it is cleared, unless something else was copied since.
            let changeCount = board.changeCount
            DispatchQueue.main.asyncAfter(deadline: .now() + RemoteFlow.passcodeClipboardSeconds) {
                let current = NSPasteboard.general
                if RemoteFlow.shouldClearClipboard(copiedAt: changeCount, now: current.changeCount) { current.clearContents() }
            }
        }
        copied = label
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in if self?.copied == label { self?.copied = nil } }
    }

    func openTailscale() {
        let app = URL(fileURLWithPath: "/Applications/Tailscale.app")
        if FileManager.default.fileExists(atPath: app.path) {
            NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(RemoteCopy.tailscaleDownloadURL)
        }
    }

    var tailscaleAppInstalled: Bool { FileManager.default.fileExists(atPath: "/Applications/Tailscale.app") }

    // MARK: The helper

    private static let loginPath: String? = BrowserBundle.readLoginPath(
        shell: URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? "/bin/zsh"))

    struct Result { var code: Int32; var out: Data; var text: String }

    /// Runs the helper as the person, in their home, never through a shell, and waits at most the command's own time.
    static func run(_ command: RemoteCommand) -> Result {
        guard let exe = BrowserBundle.helper(resources: Bundle.main.resourceURL) else { return Result(code: 127, out: Data(), text: "") }
        let p = Process()
        p.executableURL = exe
        p.arguments = command.arguments
        p.environment = BrowserBundle.environment(base: ProcessInfo.processInfo.environment, loginPath: Self.loginPath)
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return Result(code: 127, out: Data(), text: "\(error.localizedDescription)") }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + command.timeout, execute: killer)
        // stderr is read off this thread so a chatty helper can't fill its pipe and stall.
        let errBox = DataBox()
        let errDone = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { errBox.set(err.fileHandleForReading.readDataToEndOfFile()); errDone.signal() }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()
        _ = errDone.wait(timeout: .now() + 2)
        let text = String(decoding: errBox.get().suffix(300), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return Result(code: p.terminationStatus, out: data, text: text)
    }

    private final class DataBox: @unchecked Sendable {
        private let lock = NSLock(); private var data = Data()
        func set(_ d: Data) { lock.lock(); data = d; lock.unlock() }
        func get() -> Data { lock.lock(); defer { lock.unlock() }; return data }
    }
}

/// The guided flow: one step on screen, and it moves on by itself as Tailscale gets installed and signed in.
struct BrowserRemoteView: View {
    @ObservedObject private var model = BrowserRemoteModel.shared
    @State private var assistant = RemoteCopy.assistants[0].name

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(RemoteCopy.title).font(Chrome.font(13, .bold))
            content
            if let n = model.note { Text(n).font(Chrome.font(11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            Link(destination: RemoteCopy.docsURL) {
                (Text(RemoteCopy.otherWays).font(Chrome.font(11, .medium)).underline() + Text("  \(RemoteCopy.otherWaysHelp)").font(Chrome.font(11)))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(RemoteCopy.otherWays): \(RemoteCopy.otherWaysHelp)")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Chrome.shape(.settingsCell, continuous: false).fill(Chrome.cell(0.06)))
        .onAppear { model.startWatching() }
        .onDisappear { model.stopWatching() }
    }

    @ViewBuilder private var content: some View {
        switch model.screen {
        case .unavailable:
            line(RemoteCopy.unavailable)
        case .checking:
            HStack(spacing: 8) { ProgressView().controlSize(.small); line("Looking…") }
        case .getTailscale(let configured):
            if !configured { line(RemoteCopy.intro) }
            step(RemoteCopy.getTailscaleTitle, RemoteCopy.getTailscaleBody) {
                HStack(spacing: 10) {
                    Button(RemoteCopy.getTailscaleButton) { NSWorkspace.shared.open(RemoteCopy.tailscaleDownloadURL) }
                    if configured { turnOffButton }
                }
            }
            if configured { line(RemoteCopy.stillSetUp) }
        case .signIn(let configured):
            if !configured { line(RemoteCopy.intro) }
            step(RemoteCopy.signInTitle, RemoteCopy.signInBody) {
                HStack(spacing: 10) {
                    if model.tailscaleAppInstalled { Button(RemoteCopy.openTailscaleButton) { model.openTailscale() } }
                    if configured { turnOffButton }
                }
            }
            if configured { line(RemoteCopy.stillSetUp) }
        case .needsBrowser:
            step(RemoteCopy.needsBrowserTitle, RemoteCopy.needsBrowserBody) {
                Button(RemoteCopy.checkAgainButton) { model.checkAgain() }
            }
        case .funnelNotAllowed(let admin):
            step(RemoteCopy.funnelTitle, RemoteCopy.funnelBody) {
                HStack(spacing: 10) {
                    if let admin { Button(RemoteCopy.funnelButton) { NSWorkspace.shared.open(admin) } }
                    Button(RemoteCopy.tryAgainButton) { model.turnOn() }
                    turnOffButton
                }
            }
            // The passcode was made before Funnel was refused: show it here, so it can't be lost unseen.
            passcodeShown
        case .funnelClosed:
            step(RemoteCopy.funnelClosedTitle, RemoteCopy.funnelClosedBody) {
                HStack(spacing: 10) {
                    Button(RemoteCopy.funnelClosedButton) { model.turnOn() }
                    turnOffButton
                }
            }
            passcodeShown
        case .tailnetLock(let configured):
            step(RemoteCopy.lockTitle, configured ? RemoteCopy.lockConfiguredBody : RemoteCopy.lockBody) {
                HStack(spacing: 10) {
                    Button(RemoteCopy.checkAgainButton) { model.checkAgain() }
                    if configured { turnOffButton }
                }
            }
            if configured { line(RemoteCopy.stillSetUp) }
        case .portBusy(let tailscaleSetting, let detail):
            step(RemoteCopy.busyTitle, tailscaleSetting ? RemoteCopy.busyTailscaleBody : RemoteCopy.busyBody) {
                Button(RemoteCopy.checkAgainButton) { model.checkAgain() }
            }
            details(detail)
            // The passcode may have been made before the run stopped: never leave it unseen.
            passcodeShown
        case .ready:
            line(RemoteCopy.intro)
            step(RemoteCopy.readyTitle, RemoteCopy.readyBody) {
                Button(RemoteCopy.turnOnButton) { model.turnOn() }
            }
            footnotes
        case .turningOn:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                VStack(alignment: .leading, spacing: 2) {
                    Text(RemoteCopy.turningOnTitle).font(Chrome.font(12, .medium))
                    line(RemoteCopy.turningOnBody)
                }
            }
        case .on(let address, let browserConnected):
            onView(address: address, browserConnected: browserConnected)
        case .problem(let message):
            let silent = message == RemoteCopy.helperSilent
            step("Something is not working", silent ? RemoteCopy.helperSilent : RemoteCopy.genericProblem) {
                HStack(spacing: 10) {
                    Button(RemoteCopy.checkAgainButton) { model.checkAgain() }
                    Button(RemoteCopy.startOverButton) { model.turnOff() }.disabled(model.working)
                }
            }
            if message != RemoteCopy.genericProblem, !silent { details(message) }
            passcodeShown
        }
    }

    /// The helper's own words, for anyone who wants them.
    @ViewBuilder private func details(_ message: String) -> some View {
        if !message.isEmpty {
            DisclosureGroup(RemoteCopy.detailsLabel) {
                Text(message).font(Chrome.font(11)).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            .font(Chrome.font(11))
        }
    }

    // MARK: Pieces

    private func line(_ text: String) -> some View {
        Text(text).font(Chrome.font(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }

    private func step<Actions: View>(_ title: String, _ body: String, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Chrome.font(12, .medium))
            line(body)
            actions()
        }
    }

    private var turnOffButton: some View {
        Button(RemoteCopy.turnOffButton) { model.turnOff() }.controlSize(.small).disabled(model.working)
    }

    @ViewBuilder private var footnotes: some View {
        line(RemoteCopy.honest)
        line(RemoteCopy.staysOn)
    }

    private func onView(address: String, browserConnected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: browserConnected ? "checkmark.circle.fill" : "exclamationmark.circle").foregroundStyle(browserConnected ? Chrome.accent : Color.orange)
                Text(RemoteCopy.onTitle).font(Chrome.font(12, .medium))
            }
            if !browserConnected { Text(RemoteCopy.noBrowserNote).font(Chrome.font(11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            copyRow(RemoteCopy.addressLabel, address, label: "address", secret: false)
            passcodeBlock
            assistants
            footnotes
            Button(RemoteCopy.turnOffButton) { model.turnOff() }.disabled(model.working)
        }
    }

    /// The passcode this run made, with the "I've saved it" step. Nothing when there isn't one to show.
    @ViewBuilder private var passcodeShown: some View {
        if let code = model.passcode {
            copyRow(RemoteCopy.passcodeLabel, code, label: "passcode", secret: true)
            HStack(spacing: 8) {
                line(RemoteCopy.passcodeOnce)
                Button(RemoteCopy.passcodeSaved) { model.savedPasscode() }.controlSize(.small)
            }
        }
    }

    @ViewBuilder private var passcodeBlock: some View {
        if model.passcode != nil {
            passcodeShown
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if model.passcodeSet {
                    line(RemoteCopy.passcodeEarlier)
                    line(RemoteCopy.newPasscodeNote)
                } else {
                    line(RemoteCopy.noPasscodeNote)
                }
                Button(RemoteCopy.newPasscodeButton) { model.newPasscode() }.controlSize(.small).disabled(model.working)
            }
        }
    }

    private var assistants: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker("", selection: $assistant) {
                ForEach(RemoteCopy.assistants) { Text($0.name).tag($0.name) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if let chosen = RemoteCopy.assistants.first(where: { $0.name == assistant }) {
                ForEach(Array(chosen.steps.enumerated()), id: \.offset) { index, words in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(index + 1).").font(Chrome.font(12, .medium))
                        Text(words).font(Chrome.font(12)).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            line(RemoteCopy.approvalNote)
            line(RemoteCopy.menusNote)
        }
    }

    private func copyRow(_ title: String, _ value: String, label: String, secret: Bool) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Chrome.font(11)).foregroundStyle(.secondary)
                Text(value).font(Chrome.font(12, .medium)).textSelection(.enabled).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            // Every screen with a Copy button confirms it here, so the Funnel refusal and problem screens do too.
            if model.copied == label { Text("Copied").font(Chrome.font(11)).foregroundStyle(.secondary) }
            Button("Copy") { model.copy(value, label: label, secret: secret) }.controlSize(.small).accessibilityLabel("Copy the \(label)")
        }
    }
}
