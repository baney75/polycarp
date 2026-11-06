import AppKit
import BaneySpacesCore
import SwiftUI

/// Settings > Browser > "Use your browser from Claude, ChatGPT and Grok". One Connect button runs the bundled helper's
/// `connect` command; the window shows what it says. It is off until a person clicks Connect, and nothing here runs a
/// command on its own except reading the state (`connect status`) when the tab opens.
final class BrowserConnectModel: ObservableObject {
    static let shared = BrowserConnectModel()
    @Published var result: BrowserConnectResult?
    @Published var busy = false
    @Published var busyWords = ""
    /// The approval passcode from the answer that just made it. Memory only: it is shown once, then gone.
    @Published var passcode: String?
    @Published var waitlistNote: String?
    @Published var copied: String?
    private let queue = DispatchQueue(label: "polycarp.browser.connect", qos: .userInitiated)

    private var helper: URL? { BrowserModel.shared.helper }

    func refresh() {
        guard !busy else { return }
        perform(.status, words: "Checking…")
    }

    func connect(invite: String? = nil, newPasscode: Bool = false) { perform(.on(invite: invite, newPasscode: newPasscode), words: "Connecting… the first time takes about a minute.") }
    func turnOff() { passcode = nil; perform(.off, words: "Turning off…") }
    func joinWaitlist(_ email: String) { perform(.waitlist(email: email.trimmingCharacters(in: .whitespaces)), words: "Joining the waitlist…") }

    func copy(_ text: String, label: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = label
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in if self?.copied == label { self?.copied = nil } }
    }

    func hidePasscode() { passcode = nil }

    private func perform(_ action: BrowserConnectResult.Action, words: String) {
        guard let helper, !busy else { return }
        busy = true; busyWords = words
        queue.async { [weak self] in
            let out = BrowserModel.run(helper, action.arguments, timeout: action.timeout)
            let parsed = BrowserConnectResult.parse(out.out)
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                guard let parsed else {
                    // The helper didn't answer in JSON (older helper, crash, timeout): say so plainly and keep any earlier state.
                    self.result = BrowserConnectResult(ok: false, state: .problem, message: "Polycarp's helper didn't answer. Quit and reopen Polycarp, then try again.", connectorURL: nil, passcode: nil, checks: [])
                    return
                }
                if case .waitlist = action {
                    self.waitlistNote = parsed.ok ? "You're on the waitlist. We only use your email to tell you when there's room." : parsed.message
                    return
                }
                if let code = parsed.passcode { self.passcode = code }
                self.result = parsed
            }
        }
    }
}

struct BrowserConnectView: View {
    @ObservedObject private var model = BrowserConnectModel.shared
    @State private var email = ""
    @State private var invite = ""
    @State private var showSteps = false

    private var state: BrowserConnectResult.State { model.result?.state ?? .off }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Use your browser from Claude, ChatGPT and Grok").font(Chrome.font(13, .bold))
            if model.busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(model.busyWords).font(Chrome.font(12)).foregroundStyle(.secondary)
                }
            } else {
                content
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Chrome.shape(.settingsCell, continuous: false).fill(Chrome.cell(0.06)))
        .onAppear { model.refresh() }
    }

    @ViewBuilder private var content: some View {
        switch state {
        case .off:
            offView
        case .on, .connecting:
            if let r = model.result { onView(r) }
        case .atCapacity, .inviteOnly, .inviteInvalid:
            if let r = model.result { roomView(r) }
        case .paused, .offline, .rateLimited, .problem, .unsupported:
            if let r = model.result { problemView(r) }
        }
    }

    // MARK: Off

    private var offView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("One click lets the assistants you use on the web work in the browser on this Mac. It stays off until you turn it on, and each assistant still needs your approval with a passcode that never leaves this Mac.")
                .font(Chrome.font(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            // Only a turned-off answer that isn't clean (the service couldn't be told yet) says anything here.
            if let r = model.result, !r.ok { Text(r.message).font(Chrome.font(11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            Button("Connect") { model.connect() }
        }
    }

    // MARK: On

    private func onView(_ r: BrowserConnectResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: r.state == .on ? "checkmark.circle.fill" : "clock").foregroundStyle(r.state == .on ? Color.green : Color.secondary)
                Text(r.headline).font(Chrome.font(12, .medium)).fixedSize(horizontal: false, vertical: true)
            }
            if let url = r.connectorURL { copyRow("Address to add", url, label: "address") }
            if let code = model.passcode {
                copyRow("Approval passcode", code, label: "passcode")
                HStack(spacing: 8) {
                    Text("Shown once. Save it in a password manager; you type it when an assistant asks to connect.")
                        .font(Chrome.font(11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button("I've saved it") { model.hidePasscode() }.controlSize(.small)
                }
            } else {
                HStack(spacing: 8) {
                    Text("Your passcode was shown when you first connected.").font(Chrome.font(11)).foregroundStyle(.secondary)
                    Button("Make a new passcode") { model.connect(newPasscode: true) }.controlSize(.small)
                }
            }
            DisclosureGroup("How to add it", isExpanded: $showSteps) { steps }.font(Chrome.font(12))
            HStack(spacing: 10) {
                Button("Turn off") { model.turnOff() }
                Button("Check again") { model.refresh() }.controlSize(.small)
                if let c = model.copied { Text("Copied \(c)").font(Chrome.font(11)).foregroundStyle(.secondary) }
            }
            if r.state == .on || !r.checks.isEmpty { failedChecks(r) }
        }
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 6) {
            step("Claude (claude.ai)", "Settings, Connectors, Add custom connector. Paste the address.")
            step("ChatGPT", "Settings, Apps & Connectors. Turn on developer mode, press Create, paste the address and choose OAuth.")
            step("Grok (grok.com)", "Connectors, New Connector, Custom. Paste the address.")
            Text("When one asks to connect, a page from this Mac opens. Type the passcode there and press Allow. Only approve a connection you just started.")
                .font(Chrome.font(11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 4)
    }

    private func step(_ name: String, _ words: String) -> some View {
        (Text(name + ": ").font(Chrome.font(12, .semibold)) + Text(words).font(Chrome.font(12)))
            .fixedSize(horizontal: false, vertical: true)
    }

    private func copyRow(_ title: String, _ value: String, label: String) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Chrome.font(11)).foregroundStyle(.secondary)
                Text(value).font(Chrome.font(12, .medium)).textSelection(.enabled).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button("Copy") { model.copy(value, label: label) }.controlSize(.small).accessibilityLabel("Copy the \(label)")
        }
    }

    @ViewBuilder private func failedChecks(_ r: BrowserConnectResult) -> some View {
        let failed = r.checks.filter { $0.status == "fail" }
        if !failed.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(failed, id: \.name) { c in
                    Text("\(c.name): \(c.detail)").font(Chrome.font(11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: Full, invite only

    private func roomView(_ r: BrowserConnectResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(r.headline).font(Chrome.font(12, .medium)).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Waitlist").font(Chrome.font(11, .semibold))
                HStack {
                    TextField("you@example.com", text: $email).textFieldStyle(.roundedBorder).frame(maxWidth: 240)
                    Button("Join the waitlist") { model.joinWaitlist(email) }.disabled(!BrowserConnectResult.looksLikeEmail(email))
                }
                Text("We use your email only to tell you when there's room, and you can ask us to remove it.")
                    .font(Chrome.font(11)).foregroundStyle(.secondary)
                if let note = model.waitlistNote { Text(note).font(Chrome.font(11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Invite code").font(Chrome.font(11, .semibold))
                HStack {
                    TextField("PC-XXXX-XXXX-XXXX-XXXX", text: $invite).textFieldStyle(.roundedBorder).frame(maxWidth: 240)
                    Button("Use code") { if let code = BrowserConnectResult.cleanInvite(invite) { model.connect(invite: code) } }
                        .disabled(BrowserConnectResult.cleanInvite(invite) == nil)
                }
            }
        }
    }

    // MARK: Paused, offline, trouble

    private func problemView(_ r: BrowserConnectResult) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(r.headline).font(Chrome.font(12)).foregroundStyle(r.state == .paused ? Color.secondary : Color.orange).fixedSize(horizontal: false, vertical: true)
            failedChecks(r)
            HStack(spacing: 10) {
                Button("Try again") { model.connect() }
                if r.state == .problem { Button("Turn off") { model.turnOff() } }
            }
        }
    }
}
