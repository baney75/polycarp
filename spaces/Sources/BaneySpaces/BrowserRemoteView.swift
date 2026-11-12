import AppKit
import BaneySpacesCore
import SwiftUI

/// Settings > Browser > "Use Polycarp from Claude, ChatGPT and Grok". Off until a person clicks Turn on. The bundled helper
/// does the work (`remote status|setup|off`, Tailscale Funnel on the person's own free account) and answers in JSON;
/// `RemoteFlow` picks the one step to show. Reading status is all this does on its own.
final class BrowserRemoteModel: ObservableObject {
    static let shared = BrowserRemoteModel()
    @Published private(set) var status: RemoteReport?
    /// Setup's last answer, the secrets, the checks, the Repair plan and the Funnel retry's clock, with every decision about
    /// them (BaneySpacesCore's RemoteSession, tested by value). This model runs the helper and the timers it asks for.
    @Published private(set) var session = RemoteSession()
    @Published private(set) var settingUp = false
    @Published private(set) var working = false
    /// Any new note replaces the old one's details.
    @Published private(set) var note: String? { didSet { noteDetails = nil } }
    /// The helper's words for the note, under Details.
    @Published private(set) var noteDetails: String?
    @Published private(set) var checking = false
    @Published private(set) var fixing = false
    /// Turn on is running again by itself while Tailscale's Funnel page is open.
    @Published private(set) var retryingFunnel = false
    /// The render harness's gave-up step.
    @Published private var renderGaveUp = false
    @Published private(set) var copied: String?
    /// Status reads in a row that gave no usable answer.
    @Published private(set) var failedReads = 0
    /// The route picked on the first step, until it's on or turned off.
    @Published private(set) var route: RemoteRoute?
    @Published private(set) var signingIn = false
    private var setupAt: Date?
    private var funnelTimer: Timer?
    /// `remote test` again while a check waits (a name being published, a tunnel connecting).
    private var waitingTimer: Timer?
    /// The setup command of the last Turn on, so Try again runs the same one. Plain setup until one ran: the helper's plain
    /// setup reuses a route already saved in remote.json, Cloudflare's name included.
    private var lastSetup: RemoteCommand = .setup
    /// Bumped by every click that changes things. A status read that started before the click is out of date and is dropped.
    private var generation = 0
    private var timer: Timer?
    private var refreshing = false
    private let queue = DispatchQueue(label: "polycarp.browser.remote", qos: .userInitiated)
    private let pollQueue = DispatchQueue(label: "polycarp.browser.remote.poll", qos: .utility)

    private var helper: URL? { BrowserBundle.helper(resources: Bundle.main.resourceURL) }
    var available: Bool { helper.map { FileManager.default.isExecutableFile(atPath: $0.path) } ?? false }

    var setup: RemoteReport? { session.setup }
    var passcode: String? { session.passcode }
    var connectCode: ConnectCode? { session.connectCode }
    var checks: [RemoteCheck] { session.checks }
    var fixPlan: RemoteFixPlan? { session.fixPlan }
    var funnelGaveUp: Bool { session.funnel.gaveUp || renderGaveUp }

    private var shown: (screen: RemoteScreen, answer: RemoteReport?) {
        RemoteFlow.shown(helperAvailable: available, settingUp: settingUp, status: status, setup: setup,
                         setupAge: setupAt.map { Date().timeIntervalSince($0) } ?? 0, readsFailing: failedReads >= RemoteFlow.readFailureLimit,
                         chosen: route, signingIn: signingIn)
    }
    var screen: RemoteScreen { shown.screen }
    /// The answer the screen was drawn from: a step's command and `next` come from it (round 2 first-F3).
    var screenAnswer: RemoteReport? { shown.answer }

    /// One decision on the session, published only when it changed anything, then its effects.
    private func update(_ decide: (inout RemoteSession) -> [RemoteSession.Effect]) {
        var next = session
        let effects = decide(&next)
        if next != session { session = next }
        for effect in effects {
            switch effect {
            case .planFix: planFix()
            case .open(let page): NSWorkspace.shared.open(page)
            case .startFunnelTimer: startFunnelTimer()
            case .stopFunnelTimer: funnelTimer?.invalidate(); funnelTimer = nil
            case .recheckIfWaiting: scheduleWaitingRecheck()
            case .pause:
                timer?.invalidate(); timer = nil
                funnelTimer?.invalidate(); funnelTimer = nil
                stopWaitingRecheck()
            }
        }
    }
    /// A Turn on just succeeded and the status reads haven't confirmed it yet (and the grace period isn't over).
    private var bridging: Bool {
        (setup?.answerOn ?? false) && (setupAt.map { Date().timeIntervalSince($0) < RemoteFlow.grace(for: status) } ?? false)
    }
    var passcodeSet: Bool { status?.passcodeSet ?? setup?.passcodeSet ?? false }

    // MARK: Reading

    func startWatching() {
        // Back on a step that still refuses Funnel: the retry goes on, without opening Tailscale's page again.
        update { $0.startWatching(now: Date()) }
        refresh()
        schedule()
    }

    /// Leaving the section (another tab, or the window closing) pauses the reads and retries; the secrets stay.
    func stopWatching() { update { $0.stopWatching() } }

    /// The passcode and connect code are shown once: closing the Settings window forgets them (SetupWindowController's
    /// windowWillClose), the copies in setup's answer included. Nothing here is ever saved.
    func clearSecrets() { update { $0.clearSecrets(); return [] } }

    private func schedule() {
        timer?.invalidate()
        guard session.watchers > 0 else { return }
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
                self.update { _ = $0.settle(status: parsed); return [] }
                if parsed != self.status { self.status = parsed }
            }
        }
    }

    // MARK: Acting (each one a click)

    func choose(_ route: RemoteRoute?) {
        self.route = route
        update { $0.forgetSetup(stopRetry: false) }
        setupAt = nil; note = nil
    }

    /// cloudflared's own sign-in, in the person's browser. Status notices the sign-in; this only says it's waiting.
    func signInToCloudflare() {
        guard available, !signingIn else { return }
        signingIn = true; note = nil
        queue.async { [weak self] in
            let result = Self.run(.cloudflareLogin)
            let parsed = RemoteReport.parse(result.out)
            DispatchQueue.main.async {
                guard let self else { return }
                self.signingIn = false
                if parsed?.state != .ready { self.note = parsed?.message ?? RemoteCopy.helperSilent }
                self.refresh()
            }
        }
    }

    /// `download`: "Get it for me" was pressed, so the helper may fetch Cloudflare's own cloudflared first.
    func turnOn(cloudflare host: String? = nil, download: Bool = false) {
        let command = host.map { RemoteCommand.setupCloudflare($0, download: download) } ?? .setup
        runSetup(command, quiet: false)
    }

    /// Try again: the same setup as last time.
    func tryAgain() { runSetup(lastSetup, quiet: false) }

    /// A problem step's Turn on, on the route that step is about. `name`: the Cloudflare name typed on the step, for the steps
    /// that ask for one (first-F3). Nil when the step wants a name and none fits.
    func turnOn(step key: String, name: String?) -> Bool {
        switch RemoteFlow.turnOnStep(key: key, last: lastSetup) {
        case .run(let command): runSetup(command, quiet: false); return true
        case .askName:
            guard let name else { return false }
            turnOn(cloudflare: name); return true
        }
    }

    /// `quiet`: the Funnel retry. The screen stays as it is (no "Turning on") until an answer changes it. Nobody pressed
    /// anything for it, so it never asks for a connect code: New code makes one (second-N2).
    private func runSetup(_ command: RemoteCommand, quiet: Bool) {
        guard available, !settingUp, !working, !retryingFunnel else { return }
        if quiet { retryingFunnel = true } else { settingUp = true; note = nil }
        var asksForCode = false
        update { let start = $0.setupStarts(quiet: quiet, now: Date()); asksForCode = start.connectCode; return start.effects }
        lastSetup = command
        generation += 1; failedReads = 0
        queue.async { [weak self] in
            let result = Self.run(command, connectCode: asksForCode)
            let parsed = RemoteReport.parse(result.out)
            DispatchQueue.main.async {
                guard let self else { return }
                self.settingUp = false; self.retryingFunnel = false
                // A quiet retry that hears the same refusal, times out or prints no JSON changes nothing on screen (first-F2).
                guard let report = RemoteFlow.setupOutcome(parsed, quiet: quiet) else { self.refresh(); return }
                self.take(report, pressed: !quiet)
                if report.answerOn {
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

    /// `pressed`: a person pressed Turn on, Try again or Check again. Only then is a connect code taken from the answer.
    private func take(_ report: RemoteReport, pressed: Bool) {
        setupAt = Date()
        update { $0.take(report, pressed: pressed, now: Date()) }
    }

    // MARK: Funnel: allowed in Tailscale, noticed here

    private func startFunnelTimer() {
        guard funnelTimer == nil, session.watchers > 0 else { return }
        funnelTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.funnelTick() }
    }

    private func funnelTick() {
        var tick = FunnelRetry.Tick.wait
        let busy = settingUp || working || retryingFunnel
        update { tick = $0.funnelTick(busy: busy, now: Date()); return [] }
        switch tick {
        case .gaveUp: funnelTimer?.invalidate(); funnelTimer = nil
        case .run: runSetup(lastSetup, quiet: true)
        case .wait: break
        }
    }

    // MARK: Checks from the internet, and Repair

    /// Once per visit to the On screen when nothing has been checked yet, and on Check again.
    func checkFromOutside(force: Bool = false) {
        guard available, !checking else { return }
        var go = false
        update { go = $0.startTest(force: force); return [] }
        guard go else { return }
        checking = true
        queue.async { [weak self] in
            let result = Self.run(.test)
            let parsed = RemoteReport.parse(result.out)
            DispatchQueue.main.async {
                guard let self else { return }
                self.checking = false
                self.update { $0.tested(parsed) }
            }
        }
    }

    /// While the On screen waits on a check, `remote test` runs again every `waitingRecheckEvery` seconds, until it passes,
    /// fails for real or the window closes. No button to press.
    private func scheduleWaitingRecheck() {
        waitingTimer?.invalidate(); waitingTimer = nil
        guard session.watchers > 0, waitingNow else { return }
        waitingTimer = Timer.scheduledTimer(withTimeInterval: RemoteFlow.waitingRecheckEvery, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.waitingTimer = nil
            if self.waitingNow { self.checkFromOutside(force: true) }
        }
    }

    private func stopWaitingRecheck() { waitingTimer?.invalidate(); waitingTimer = nil }

    /// The On screen is up and says it is waiting.
    var waitingNow: Bool {
        guard case .on(_, let connected) = screen else { return false }
        return RemoteFlow.resultHead(checks: checks, answer: setup ?? status, browserConnected: connected).waiting
    }

    /// Asks `remote fix --dry-run` what it would repair. Changes nothing; an older helper answers "not available".
    private func planFix() {
        guard available else { return }
        queue.async { [weak self] in
            let result = Self.run(.fixPlan)
            let plan = RemoteCommand.parseFix(exitCode: result.code, result.out)
            DispatchQueue.main.async { self?.update { $0.planned(plan); return [] } }
        }
    }

    func repair() {
        guard available, !fixing, session.offersRepair else { return }
        fixing = true; note = nil; generation += 1
        queue.async { [weak self] in
            let result = Self.run(.fix)
            let done = RemoteCommand.parseFix(exitCode: result.code, result.out)
            DispatchQueue.main.async {
                guard let self else { return }
                self.fixing = false
                // The note names Details only when the helper gave words to put there (round 2 first-F4).
                if let failed = RemoteFlow.repairNote(done) { self.note = failed.note; self.noteDetails = failed.details }
                // Re-planned whenever Repair would still be offered, so it can be pressed again (round 2 second-F6).
                self.update { $0.repaired(done) }
                self.refresh()
            }
        }
    }

    func checkAgain() {
        update { $0.forgetSetup(stopRetry: true) }
        note = nil; generation += 1; failedReads = 0
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
                    self.update { $0.turnedOff() }
                    self.setupAt = nil; self.status = nil; self.failedReads = 0; self.route = nil; self.stopWaitingRecheck()
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
                if let code { self.update { $0.madePasscode(code); return [] } } else { self.note = RemoteCopy.newPasscodeFailed }
            }
        }
    }

    func newConnectCode() {
        guard available, !settingUp, !working else { return }
        working = true; note = nil
        queue.async { [weak self] in
            let result = Self.run(.approvalCode)
            let code = RemoteCommand.parseApprovalCode(result.out)
            DispatchQueue.main.async {
                guard let self else { return }
                self.working = false
                if let code { self.update { $0.madeConnectCode(code); return [] } } else { self.note = RemoteCopy.connectCodeFailed }
            }
        }
    }

    func savedPasscode() { update { $0.savedPasscode(); return [] } }

    /// The render harness's result screen: a made-up code and checks, in memory, never from the helper.
    func stageForRender(code: ConnectCode?, passcode: String?, checks: [RemoteCheck], plan: RemoteFixPlan?, funnelGaveUp: Bool = false) {
        update { $0.stageForRender(code: code, passcode: passcode, checks: checks, plan: plan); return [] }
        renderGaveUp = funnelGaveUp
    }

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
    /// `connectCode`: false for a run nobody pressed (the Funnel retry), so its setup asks for no connect code.
    static func run(_ command: RemoteCommand, connectCode: Bool = true) -> Result {
        guard let exe = BrowserBundle.helper(resources: Bundle.main.resourceURL) else { return Result(code: 127, out: Data(), text: "") }
        let p = Process()
        p.executableURL = exe
        p.arguments = command.arguments(connectCode: connectCode)
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

/// The guided flow: one step on screen, and it moves on by itself as Tailscale gets installed, signed in and Funnel allowed.
/// Every title, body and button is `RemoteSharedCopy`'s, the side panel's own words.
struct BrowserRemoteView: View {
    /// The render harness's step, in place of the live one. Nothing is read from the helper while it is set.
    var preview: RemoteScreen?
    @ObservedObject private var model = BrowserRemoteModel.shared
    @State private var cloudflareName = ""
    @State private var nameRefused = false

    private typealias Shared = RemoteSharedCopy

    var body: some View {
        SettingsGroup(RemoteCopy.title) {
            SettingsBlock {
                VStack(alignment: .leading, spacing: 10) { content }
            }
            if let n = model.note {
                SettingsNote(n, tone: .urgent)
                // The helper's own words for the note, when it gave some (round 2 first-F4).
                if let words = model.noteDetails { SettingsBlock { details(words) } }
            }
            SettingsBlock {
                Link(destination: RemoteCopy.docsURL) {
                    (Text(RemoteCopy.otherWays).font(Chrome.font(11, .medium)).underline() + Text("  \(RemoteCopy.otherWaysHelp)").font(Chrome.font(11)))
                        .foregroundStyle(Chrome.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(RemoteCopy.otherWays): \(RemoteCopy.otherWaysHelp)")
            }
        }
        .onAppear { if preview == nil { model.startWatching() } }
        .onDisappear { if preview == nil { model.stopWatching() } }
    }

    private var current: RemoteScreen { preview ?? model.screen }

    @ViewBuilder private var content: some View {
        switch current {
        case .unavailable:
            line(RemoteCopy.unavailable)
        case .checking:
            HStack(spacing: 8) { ProgressView().controlSize(.small); line("Looking...") }
        case .chooseRoute(let routes):
            line(RemoteCopy.intro)
            header(1)
            Text(Shared.route["chooseTitle"]!).font(Chrome.font(13, .semibold))
            line(Shared.route["chooseBody"]!)
            routeChoice("tailscale", installed: routes.tailscaleInstalled, signedIn: routes.tailscaleSignedIn, recommended: routes.tailscaleInstalled,
                        signup: RemoteCopy.tailscaleSignupURL) { model.choose(.tailscale) }
            routeChoice("cloudflare", installed: routes.cloudflareInstalled, signedIn: routes.cloudflareSignedIn, recommended: false,
                        signup: RemoteCopy.cloudflareSignupURL) { model.choose(.cloudflare) }
            footnotes
        case .getCloudflared(let configured, let problem):
            step("cloudflared_missing") {
                if !configured { nameField(onSubmit: getCloudflared) }
                HStack(spacing: 10) {
                    Button(Shared.steps["cloudflared_missing"]!.action!, action: getCloudflared).keyboardShortcut(.defaultAction)
                    Button(RemoteCopy.openDownloadPage) { NSWorkspace.shared.open(RemoteCopy.cloudflaredDownloadURL) }.buttonStyle(.link).font(Chrome.font(11))
                    if configured { turnOffButton } else { chooseAgain }
                }
            }
            if nameRefused { warning(RemoteCopy.cloudflareAddressFirst) }
            // "Get it for me" stopped before cloudflared was in place: the helper's words say why (round 2 first-F1).
            if let problem { details(problem) }
            if configured { line(RemoteCopy.stillSetUp) }
        case .cloudflareSignIn(let waiting):
            step("cloudflare_login") {
                HStack(spacing: 10) {
                    if waiting {
                        ProgressView().controlSize(.small)
                        line(RemoteCopy.cloudflareWaiting)
                    } else {
                        Button(Shared.steps["cloudflare_login"]!.action!) { model.signInToCloudflare() }.keyboardShortcut(.defaultAction)
                    }
                    Button(RemoteCopy.createAccountButton) { NSWorkspace.shared.open(RemoteCopy.cloudflareSignupURL) }
                    chooseAgain
                }
            }
        case .cloudflareAddress(let problem, let code):
            step(RemoteFlow.addressStepKey(code: code, nextKind: model.setup?.nextKind)) {
                nameField(onSubmit: turnOnCloudflare)
                HStack(spacing: 10) {
                    Button(Shared.steps["cloudflare_name"]!.action!, action: turnOnCloudflare).keyboardShortcut(.defaultAction)
                    chooseAgain
                }
            }
            if nameRefused { warning(RemoteCopy.cloudflareAddressInvalid) }
            if let problem { details(problem) }
            passcodeShown
            footnotes
        case .getTailscale(let configured):
            if !configured { line(RemoteCopy.intro) }
            step("tailscale_missing") {
                HStack(spacing: 10) {
                    Button(Shared.steps["tailscale_missing"]!.action!) { NSWorkspace.shared.open(RemoteCopy.tailscaleDownloadURL) }.keyboardShortcut(.defaultAction)
                    if configured { turnOffButton } else { Button(RemoteCopy.createAccountButton) { NSWorkspace.shared.open(RemoteCopy.tailscaleSignupURL) }; chooseAgain }
                }
                waitingLine
            }
            if configured { line(RemoteCopy.stillSetUp) }
        case .signIn(let configured):
            if !configured { line(RemoteCopy.intro) }
            step("tailscale_signed_out") {
                commandBox(model.status?.nextCommand ?? model.setup?.nextCommand ?? "tailscale up")
                HStack(spacing: 10) {
                    if model.tailscaleAppInstalled { Button(RemoteCopy.openTailscaleButton) { model.openTailscale() }.keyboardShortcut(.defaultAction) }
                    if configured { turnOffButton } else { chooseAgain }
                }
                waitingLine
            }
            if configured { line(RemoteCopy.stillSetUp) }
        case .needsBrowser:
            step("launcher_app") {
                Button(Shared.steps["launcher_app"]!.action!) { model.checkAgain() }.keyboardShortcut(.defaultAction)
            }
        case .funnelNotAllowed(let admin):
            step(model.funnelGaveUp ? "funnel_gave_up" : "funnel_not_allowed", header: 3) {
                HStack(spacing: 10) {
                    if model.funnelGaveUp {
                        // Ten minutes passed: the waiting line goes and the one button checks again (a press, first-F3).
                        Button(Shared.steps["funnel_gave_up"]!.action!) { model.tryAgain() }.keyboardShortcut(.defaultAction)
                        if let admin { Button(Shared.steps["funnel_not_allowed"]!.action!) { NSWorkspace.shared.open(admin) }.buttonStyle(.link).font(Chrome.font(11)) }
                    } else if let admin {
                        Button(Shared.steps["funnel_not_allowed"]!.action!) { NSWorkspace.shared.open(admin) }.keyboardShortcut(.defaultAction)
                    }
                    turnOffButton
                }
                if !model.funnelGaveUp {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small).opacity(model.retryingFunnel ? 1 : 0.5)
                        line(RemoteCopy.funnelWaiting)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            // The passcode was made before Funnel was refused: show it here, so it can't be lost unseen.
            passcodeShown
        case .funnelClosed:
            step("funnel_closed", header: 3) {
                HStack(spacing: 10) {
                    Button(Shared.steps["funnel_closed"]!.action!) { model.turnOn() }.keyboardShortcut(.defaultAction)
                    turnOffButton
                }
            }
            passcodeShown
        case .tailnetLock(let configured):
            step("tailnet_lock") {
                HStack(spacing: 10) {
                    if configured {
                        turnOffButton
                    } else {
                        Button(Shared.steps["tailnet_lock"]!.action!) { model.choose(.cloudflare) }.keyboardShortcut(.defaultAction)
                    }
                }
            }
            if configured { line(RemoteCopy.stillSetUp) }
        case .portBusy(let tailscaleSetting, let detail):
            let key = tailscaleSetting ? "tailscale_port" : "local_port"
            step(key, header: 3) {
                Button(Shared.steps[key]!.action!) { model.checkAgain() }.keyboardShortcut(.defaultAction)
            }
            details(detail)
            // The passcode may have been made before the run stopped: never leave it unseen.
            passcodeShown
        case .ready:
            line(RemoteCopy.intro)
            step("ready", header: 3) {
                HStack(spacing: 10) {
                    Button(Shared.steps["ready"]!.action!) { model.turnOn() }.keyboardShortcut(.defaultAction)
                    chooseAgain
                }
            }
            footnotes
        case .turningOn:
            header(3)
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Shared.steps["turning_on"]!.title).font(Chrome.font(12, .medium))
                    line(Shared.steps["turning_on"]!.body!)
                }
            }
            .accessibilityElement(children: .combine)
        case .on(let address, let browserConnected):
            onView(address: address, browserConnected: browserConnected)
        case .problem(let code, let message):
            problemView(code: code, message: message)
        }
    }

    // MARK: Problems: each code its own sentence and one button

    @ViewBuilder private func problemView(code: String?, message: String) -> some View {
        if code == RemoteCopy.helperSilentCode {
            stepText(Shared.steps["unknown"]!.title, RemoteCopy.helperSilent)
            Button(Shared.steps["unknown"]!.action!) { model.checkAgain() }.keyboardShortcut(.defaultAction)
            // Reads that stopped answering must not hide a passcode shown once (second-S2).
            passcodeShown
        } else {
            // `next` from the answer this step was drawn from, status's or setup's, never a setup answer not on screen (round 2 first-F3).
            let next = model.screenAnswer
            let copy = Shared.copy(for: RemoteReport(state: .problem, message: message, code: code, nextKind: next?.nextKind, nextCommand: next?.nextCommand))
            let entry = Shared.steps[copy.key]!
            header(stepNumber(copy.key))
            stepText(copy.title, copy.body)
            if let command = next?.nextCommand, entry.kind == "copy_command" { commandBox(command) }
            // A Cloudflare name step keeps its name field wherever it shows, so Turn on sets up a name, not Tailscale (first-F3).
            let asksName = RemoteFlow.cloudflareNameKeys.contains(copy.key)
            if asksName { nameField { act("turn_on", key: copy.key) } }
            HStack(spacing: 10) {
                // A button with nothing behind it is not drawn: Repair needs `remote fix` and a plan with something in it.
                if let label = entry.action, let kind = entry.kind, kind != "copy_command", kind != "repair" || RemoteFlow.repairAvailable(model.fixPlan) {
                    Button(label) { act(kind, key: copy.key) }.keyboardShortcut(.defaultAction).disabled(model.working || model.fixing)
                }
                Button(RemoteCopy.startOverButton) { model.turnOff() }.disabled(model.working)
            }
            if asksName, nameRefused { warning(RemoteCopy.cloudflareAddressInvalid) }
            // The helper's own words, unless they already are the body.
            if copy.key != "unknown" { details(message) }
            passcodeShown
        }
    }

    /// What a step's one button does. The kinds are remote-copy.ts's. `key`: the step, so Turn on stays on its route.
    private func act(_ kind: String, key: String) {
        switch kind {
        case "try_again": model.tryAgain()
        case "turn_on": if !model.turnOn(step: key, name: RemoteFlow.cloudflareHost(cloudflareName)) { nameRefused = true }
        case "open_funnel": model.turnOn()
        case "new_code": model.newConnectCode()
        case "repair": model.repair()
        case "choose": model.choose(nil)
        case "use_cloudflare": model.choose(.cloudflare)
        case "sign_in_cloudflare": model.signInToCloudflare()
        default: model.checkAgain()
        }
    }

    // MARK: Pieces

    private func line(_ text: String) -> some View {
        Text(text).font(Chrome.font(12)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
    }

    private func warning(_ text: String) -> some View {
        Text(text).font(Chrome.font(11)).foregroundStyle(Chrome.working).fixedSize(horizontal: false, vertical: true)
    }

    /// "Step 2 of 3: Get it and sign in", the side panel's header.
    private func header(_ n: Int) -> some View {
        Text(RemoteCopy.stepHeader(n)).font(Chrome.font(11, .medium)).foregroundStyle(Chrome.muted).accessibilityAddTraits(.isHeader)
    }

    private func stepText(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Chrome.font(13, .semibold)).accessibilityAddTraits(.isHeader)
            line(body)
        }
    }

    /// One shared entry: the step number, its title and body, then the actions.
    private func step<Actions: View>(_ key: String, header n: Int? = nil, @ViewBuilder actions: () -> Actions) -> some View {
        let entry = Shared.steps[key] ?? Shared.steps["unknown"]!
        let number = n ?? stepNumber(key)
        return VStack(alignment: .leading, spacing: 8) {
            header(number)
            stepText(entry.title, entry.body ?? Shared.unknownBody)
            actions()
        }
    }

    /// Step 2 is getting the tool and signing in; anything about turning on or what it found is step 3 (remote-flow.ts's STEP_TWO).
    private func stepNumber(_ key: String) -> Int {
        ["tailscale_missing", "tailscale_signed_out", "tailnet_lock", "cloudflared_missing", "cloudflared_manual", "cloudflare_login"].contains(key) ? 2 : 3
    }

    /// Steps that wait on the person say so, in a line that is always there, so the layout doesn't jump.
    private var waitingLine: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text("Watching for it...").font(Chrome.font(11)).foregroundStyle(Chrome.muted)
        }
        .accessibilityElement(children: .combine)
    }

    private func nameField(onSubmit: @escaping () -> Void) -> some View {
        TextField(RemoteCopy.cloudflareAddressPlaceholder, text: $cloudflareName)
            .textFieldStyle(.roundedBorder)
            .font(Chrome.font(12))
            .autocorrectionDisabled()
            .onSubmit(onSubmit)
            .onChange(of: cloudflareName) { _ in nameRefused = false }
            .accessibilityLabel(Shared.steps["cloudflare_name"]!.title)
    }

    private func commandBox(_ command: String) -> some View {
        copyRow(RemoteCopy.commandLabel, command, label: "command", secret: false)
    }

    /// The helper's own words, for anyone who wants them.
    @ViewBuilder private func details(_ message: String) -> some View {
        if !message.isEmpty {
            DisclosureGroup(RemoteCopy.detailsLabel) {
                Text(message).font(Chrome.font(11)).foregroundStyle(Chrome.muted).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            .font(Chrome.font(11))
        }
    }

    /// One way in: what it is, where it stands here, and both ways to start: an account you have, or a new one.
    private func routeChoice(_ id: String, installed: Bool, signedIn: Bool, recommended: Bool, signup: URL, action: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(Shared.route["\(id).name"]!).font(Chrome.font(13, .semibold))
                if recommended {
                    Text(Shared.route["recommended"]!).font(Chrome.font(10, .medium)).foregroundStyle(Chrome.done)
                }
                Text(signedIn ? Shared.route["signedIn"]! : installed ? Shared.route["installed"]! : Shared.route["missing"]!)
                    .font(Chrome.font(11)).foregroundStyle(signedIn ? Chrome.done : Chrome.muted)
            }
            line(Shared.route["\(id).detail"]!)
            HStack(spacing: 10) {
                Button(Shared.route["\(id).use"]!, action: action)
                if !signedIn { Button(RemoteCopy.createAccountButton) { NSWorkspace.shared.open(signup) } }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Chrome.shape(.settingsCell, continuous: false).fill(Chrome.cell(0.06)))
        .accessibilityElement(children: .contain)
    }

    private var chooseAgain: some View {
        Button(Shared.route["chooseAgain"]!) { model.choose(nil) }.buttonStyle(.link).font(Chrome.font(11))
    }

    private func turnOnCloudflare() {
        guard let host = RemoteFlow.cloudflareHost(cloudflareName) else { nameRefused = true; return }
        model.turnOn(cloudflare: host)
    }

    /// "Get it for me": the helper downloads Cloudflare's pinned release and goes on to set up the address. An install that is
    /// already set up keeps its own address; a new one needs the address first.
    private func getCloudflared() {
        if case .getCloudflared(true, _) = current {
            guard let url = model.status?.connectorURL, let host = URL(string: url)?.host else { nameRefused = true; return }
            model.turnOn(cloudflare: host, download: true)
            return
        }
        guard let host = RemoteFlow.cloudflareHost(cloudflareName) else { nameRefused = true; return }
        model.turnOn(cloudflare: host, download: true)
    }

    private var turnOffButton: some View {
        Button(Shared.result["turnOff"]!) { model.turnOff() }.controlSize(.small).disabled(model.working)
    }

    @ViewBuilder private var footnotes: some View {
        line(RemoteCopy.honest)
        line(RemoteCopy.staysOn)
    }

    // MARK: The result

    private func result(_ key: String) -> String { Shared.result[key]! }

    private func onView(address: String, browserConnected: Bool) -> some View {
        let failed = model.checks.filter(\.realFailure)
        // A new name still being published is On and waiting: calm, and it checks again by itself (first-F1).
        let (head, waiting) = RemoteFlow.resultHead(checks: model.checks, answer: model.setup ?? model.status, browserConnected: browserConnected)
        let good = head == "on"
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: good ? "checkmark.circle.fill" : waiting ? "clock" : "exclamationmark.circle")
                    .foregroundStyle(good ? Chrome.done : waiting ? Chrome.muted : Chrome.working)
                    .accessibilityHidden(true)
                Text(Shared.steps[head]!.title).font(Chrome.font(13, .semibold)).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            }
            line(Shared.steps[head]!.body!)

            numbered(result("assistantsStep")) {
                ForEach(Shared.assistantSteps) { a in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(a.name).font(Chrome.font(12, .medium)).frame(width: 72, alignment: .leading)
                        Text(a.where).font(Chrome.font(12)).fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
                line(RemoteCopy.menusNote)
            }
            numbered(result("addressStep")) {
                copyRow(result("addressLabel"), address, label: "address", secret: false)
            }
            numbered(result("codeStep")) {
                line(Shared.approvalStep)
                codeBox
                // A run nobody pressed (the Funnel retry) brings no code: the line says to press New code.
                line(model.connectCode == nil ? result("codeNone") : result("codeNote"))
            }
            passcodeBlock
            checksBlock(failed: failed, waiting: waiting)
            footnotes
            Button(Shared.result["turnOff"]!) { model.turnOff() }.disabled(model.working)
        }
        .onAppear { if preview == nil { model.checkFromOutside() } }
    }

    private func numbered<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(Chrome.font(12, .semibold)).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    /// The connect code, its countdown and New code. The row keeps its size with or without a code, so nothing jumps.
    private var codeBox: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = model.connectCode?.secondsLeft(now: context.date) ?? 0
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(result("codeLabel")).font(Chrome.font(11)).foregroundStyle(Chrome.muted)
                    Text(left > 0 ? model.connectCode!.code : "----").font(Chrome.font(14, .semibold)).monospaced().textSelection(.enabled)
                    Text(model.connectCode == nil ? " " : Shared.countdown(seconds: left)).font(Chrome.font(11)).monospacedDigit()
                        .foregroundStyle(left > 0 ? Chrome.muted : Chrome.working)
                        .accessibilityLabel(left > 0 ? Shared.countdown(seconds: left) : result("expired"))
                }
                Spacer(minLength: 8)
                if model.copied == "connect code" { Text(result("copied")).font(Chrome.font(11)).foregroundStyle(Chrome.muted) }
                if left > 0, let code = model.connectCode {
                    Button(result("copy")) { model.copy(code.code, label: "connect code", secret: true) }.controlSize(.small).accessibilityLabel("Copy the connect code")
                }
                if model.connectCode == nil {
                    Button(result("newCode")) { model.newConnectCode() }.controlSize(.small).buttonStyle(.borderedProminent).disabled(model.working)
                } else {
                    Button(result("newCode")) { model.newConnectCode() }.controlSize(.small).disabled(model.working)
                }
            }
        }
    }

    /// The passcode only when this run made it, labeled for re-approving. Otherwise one line, and a way to make a new one.
    @ViewBuilder private var passcodeBlock: some View {
        if model.passcode != nil {
            passcodeShown
        } else if model.passcodeSet {
            VStack(alignment: .leading, spacing: 6) {
                line(RemoteCopy.passcodeEarlier)
                Button(RemoteCopy.newPasscodeButton) { model.newPasscode() }.controlSize(.small).disabled(model.working)
            }
        } else {
            line(result("noPasscode"))
        }
    }

    @ViewBuilder private var passcodeShown: some View {
        if let code = model.passcode {
            copyRow(result("passcodeLabel"), code, label: "passcode", secret: true)
            HStack(spacing: 8) {
                line(result("passcodeNote"))
                Button(RemoteCopy.passcodeSaved) { model.savedPasscode() }.controlSize(.small)
            }
        }
    }

    /// The outside checks as a checklist, with Repair only when one failed for real and the helper can repair it. A pending
    /// check is Waiting, never red.
    private func checksBlock(failed: [RemoteCheck], waiting: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(result("checksTitle")).font(Chrome.font(12, .semibold)).accessibilityAddTraits(.isHeader)
                Text(model.checking ? result("checksRunning") : model.checks.isEmpty ? result("checksNone")
                     : !failed.isEmpty ? Shared.checksFailed(failed.count) : waiting ? result("checksWaiting") : result("checksPassed"))
                    .font(Chrome.font(11)).foregroundStyle(failed.isEmpty ? Chrome.muted : Chrome.working)
            }
            ForEach(model.checks) { check in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: check.status == "ok" ? "checkmark.circle" : check.waiting ? "clock" : check.failed ? "xmark.circle" : "exclamationmark.circle")
                        .foregroundStyle(check.status == "ok" ? Chrome.done : check.waiting ? Chrome.muted : Chrome.working).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(RemoteCopy.checkLabel(check.name)).font(Chrome.font(12))
                        if check.status != "ok", !check.detail.isEmpty {
                            Text(check.detail).font(Chrome.font(11)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(RemoteCopy.checkLabel(check.name)): \(check.status == "ok" ? "passed" : check.waiting ? "waiting" : check.failed ? "failed" : "warning")")
            }
            HStack(spacing: 10) {
                Button(result("checkAgain")) { model.checkFromOutside(force: true) }.controlSize(.small).disabled(model.checking || model.fixing)
                if RemoteFlow.offerRepair(checks: model.checks, plan: model.fixPlan) {
                    Button(model.fixing ? result("repairing") : result("repair")) { model.repair() }.controlSize(.small).disabled(model.fixing)
                }
            }
        }
    }

    private func copyRow(_ title: String, _ value: String, label: String, secret: Bool) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Chrome.font(11)).foregroundStyle(Chrome.muted)
                Text(value).font(Chrome.font(12, .medium)).textSelection(.enabled).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if model.copied == label { Text(result("copied")).font(Chrome.font(11)).foregroundStyle(Chrome.muted) }
            Button(result("copy")) { model.copy(value, label: label, secret: secret) }.controlSize(.small).accessibilityLabel("Copy the \(label)")
        }
    }
}
