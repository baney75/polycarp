import Foundation

/// Settings > Browser > "Use your browser from Claude, ChatGPT and Grok". The bundled helper does the work (`remote setup`,
/// `remote status`, `remote off`) and answers in JSON; this reads the answer and decides which one step to show. No UI
/// and no process here, so all of it is tested. The helper's states are the contract: nothing below reads a sentence.

/// Where remote access stands, as the helper names it.
public enum RemoteState: String, CaseIterable, Equatable {
    case tailscaleMissing = "tailscale_missing"
    case tailscaleSignedOut = "tailscale_signed_out"
    case funnelNotAllowed = "funnel_not_allowed"
    case tailnetLock = "tailnet_lock"
    case portBusy = "port_busy"
    case ready
    case on
    case noBrowserConnected = "no_browser_connected"
    case problem
}

/// One answer from `remote status --json` or `remote setup --json`.
public struct RemoteReport: Equatable {
    public var ok: Bool
    public var state: RemoteState
    /// The helper's own words. Shown only for `.problem`, where no state says more.
    public var message: String
    /// Tailscale's page for allowing Funnel: only ever a tailscale.com address.
    public var adminURL: URL?
    /// Why a problem happened, when the helper says (`launcher`: no browser has been connected yet).
    public var code: String?
    public var connectorURL: String?
    /// Present only in the answer of the run that made the passcode.
    public var passcode: String?
    public var passcodeSet: Bool
    /// Status only: whether a browser has the extension connected. Nil when the answer didn't say.
    public var extensionConnected: Bool?

    public init(ok: Bool = false, state: RemoteState, message: String = "", adminURL: URL? = nil, code: String? = nil,
                connectorURL: String? = nil, passcode: String? = nil, passcodeSet: Bool = false, extensionConnected: Bool? = nil) {
        self.ok = ok; self.state = state; self.message = message; self.adminURL = adminURL; self.code = code
        self.connectorURL = connectorURL; self.passcode = passcode; self.passcodeSet = passcodeSet; self.extensionConnected = extensionConnected
    }

    /// The helper's JSON, or nil when it isn't an object with a `state`. An unknown state is a problem, so a newer helper
    /// never leaves the window blank.
    public static func parse(_ data: Data) -> RemoteReport? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let raw = root["state"] as? String else { return nil }
        func string(_ key: String) -> String? { (root[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        return RemoteReport(
            ok: root["ok"] as? Bool ?? false,
            state: RemoteState(rawValue: raw) ?? .problem,
            message: string("message") ?? "",
            adminURL: string("adminUrl").flatMap(tailscaleURL),
            code: string("code"),
            connectorURL: string("connectorUrl").flatMap(connectorAddress),
            passcode: string("passcode"),
            passcodeSet: root["passcodeSet"] as? Bool ?? (root["passcode"] != nil),
            extensionConnected: root["extensionConnected"] as? Bool)
    }

    /// An https address on tailscale.com (or a subdomain, like login.tailscale.com). Anything else is dropped, so a button
    /// never opens an address the helper's output chose.
    static func tailscaleURL(_ s: String) -> URL? {
        guard let url = URL(string: s), url.scheme == "https", let host = url.host?.lowercased(),
              host == "tailscale.com" || host.hasSuffix(".tailscale.com") else { return nil }
        return url
    }

    /// The address a person pastes into an assistant: an http(s) address that ends in /mcp.
    static func connectorAddress(_ s: String) -> String? {
        guard let url = URL(string: s), url.scheme == "https" || url.scheme == "http", url.host != nil, url.path.hasSuffix("/mcp") else { return nil }
        return s
    }
}

/// The one step on screen.
public enum RemoteScreen: Equatable {
    case unavailable
    case checking
    case getTailscale
    case signIn
    case needsBrowser
    case funnelNotAllowed(adminURL: URL?)
    case tailnetLock
    case portBusy
    case ready
    case turningOn
    case on(connectorURL: String, browserConnected: Bool)
    case problem(String)
}

public enum RemoteFlow {
    /// What the window shows for the latest status and the result of the last Turn on.
    /// - `setup`: the last `remote setup` answer, kept until the person acts again. A refusal stays on screen (the status
    ///   read afterwards only says the setup is half done) except where status names something more basic.
    public static func screen(helperAvailable: Bool, settingUp: Bool, status: RemoteReport?, setup: RemoteReport?) -> RemoteScreen {
        guard helperAvailable else { return .unavailable }
        if settingUp { return .turningOn }
        if let status, status.state == .on || status.state == .noBrowserConnected, let url = status.connectorURL {
            return .on(connectorURL: url, browserConnected: status.state == .on)
        }
        if let setup {
            if setup.state == .on, let url = setup.connectorURL {
                // Just turned on; the next status read confirms it.
                return .on(connectorURL: url, browserConnected: status?.extensionConnected ?? true)
            }
            let moreBasic: Set<RemoteState> = [.tailscaleMissing, .tailscaleSignedOut, .tailnetLock]
            if setup.state != .on, !(status.map { moreBasic.contains($0.state) } ?? false) { return screen(for: setup) }
        }
        guard let status else { return .checking }
        return screen(for: status)
    }

    private static func screen(for r: RemoteReport) -> RemoteScreen {
        switch r.state {
        case .tailscaleMissing: .getTailscale
        case .tailscaleSignedOut: .signIn
        case .funnelNotAllowed: .funnelNotAllowed(adminURL: r.adminURL)
        case .tailnetLock: .tailnetLock
        case .portBusy: .portBusy
        case .ready: .ready
        case .on, .noBrowserConnected:
            // Set up but the answer carried no address: nothing to show but what the helper said.
            .problem(r.message.isEmpty ? RemoteCopy.genericProblem : r.message)
        case .problem:
            r.code == "launcher" ? .needsBrowser : .problem(r.message.isEmpty ? RemoteCopy.genericProblem : r.message)
        }
    }

    /// Seconds until the next status read: quick while a step is waiting on the person, slow once it is on (the read then
    /// checks the internet side too).
    public static func pollInterval(for screen: RemoteScreen) -> TimeInterval {
        if case .on = screen { return 30 }
        return 4
    }

    /// The passcode to show. The first answer that carries one wins until the person says they've saved it; a later answer
    /// without one (a retry after a refusal) never clears it.
    public static func keepPasscode(current: String?, from report: RemoteReport) -> String? { report.passcode ?? current }
}

/// The helper's commands and what the app tells it. Exact arguments are pinned by tests, so a rename here fails loudly.
public enum RemoteCommand: Equatable {
    case status, setup, off, newPasscode

    public var arguments: [String] {
        switch self {
        case .status: ["remote", "status", "--json"]
        case .setup: ["remote", "setup", "--json"]
        case .off: ["remote", "off"]
        case .newPasscode: ["token", "passcode", "--json"]
        }
    }

    /// Seconds the app waits. Setup may install a service and wait for it (15 s), then ask Tailscale; status asks the
    /// internet and the browser too.
    public var timeout: TimeInterval {
        switch self {
        case .status: 30
        case .setup: 120
        case .off: 60
        case .newPasscode: 15
        }
    }

    /// The Tailscale Mac app keeps its command inside the app and doesn't put it on PATH.
    public static let tailscaleAppCommand = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

    /// The helper's environment for these commands: the usual one, plus the Tailscale app's own command when it is there.
    public static func environment(base: [String: String], tailscaleAppExists: Bool) -> [String: String] {
        var env = base
        if tailscaleAppExists { env["TABKYRA_TAILSCALE_APP"] = tailscaleAppCommand }
        return env
    }

    /// `{"ok":true,"passcode":"…"}` from `token passcode --json`.
    public static func parsePasscode(_ data: Data) -> String? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              root["ok"] as? Bool == true, let code = root["passcode"] as? String, !code.isEmpty else { return nil }
        return code
    }
}

/// Every sentence on screen, in one place so tests can hold it to the rules: plain words, no jargon.
public enum RemoteCopy {
    public static let title = "Use your browser from Claude, ChatGPT and Grok"
    public static let docsURL = URL(string: "https://github.com/baney75/polycarp/blob/main/browser/docs/remote.md#if-funnel-wont-work")!
    public static let tailscaleDownloadURL = URL(string: "https://tailscale.com/download")!

    public static let intro = "Let the assistants you use on the web work in the browser on this computer. It's off until you turn it on."
    public static let honest = "This runs on your own account. Agents you approve can use your signed-in browser, so only approve ones you trust."
    public static let staysOn = "Your computer must stay on and signed in."
    public static let genericProblem = "Something is not working. Check again, or turn it off and start over."
    public static let startOverButton = "Turn off and start over"
    public static let detailsLabel = "Details"

    public static let getTailscaleTitle = "First, get Tailscale"
    public static let getTailscaleBody = "It's free, and it's your own account. Tailscale is what lets the assistants reach this computer. Polycarp notices when it's installed and you're signed in."
    public static let getTailscaleButton = "Get Tailscale"

    public static let signInTitle = "Sign in to Tailscale"
    public static let signInBody = "Tailscale is installed but you're not signed in. Open it and sign in; this window updates by itself."
    public static let openTailscaleButton = "Open Tailscale"

    public static let needsBrowserTitle = "Connect a browser first"
    public static let needsBrowserBody = "Polycarp needs a browser connected before an assistant can use it. Use Connect in the Browsers section above, then come back; this window updates by itself."

    public static let funnelTitle = "Allow Funnel in Tailscale"
    public static let funnelBody = "Funnel is Tailscale's setting that lets the internet reach this computer. Allow it for this computer on the page below, then come back and try again."
    public static let funnelButton = "Open Tailscale settings"
    public static let tryAgainButton = "I've allowed it, try again"

    public static let lockTitle = "This won't work on your Tailscale network"
    public static let lockBody = "Your network has Tailnet Lock turned on, and Tailscale's Funnel setting doesn't work with it. Nothing was changed. Turning Tailnet Lock off is your decision, so Polycarp doesn't. Other ways are listed in the guide."

    public static let busyTitle = "Something else is in the way"
    public static let busyBody = "Another program on this computer is already using the connection Polycarp needs. Nothing was changed. Quit that program, then check again."
    public static let checkAgainButton = "Check again"

    public static let readyTitle = "Ready to turn on"
    public static let readyBody = "Tailscale is signed in. Turning this on gives you an address to add in each assistant, and a passcode that approves them."
    public static let turnOnButton = "Turn on"

    public static let turningOnTitle = "Turning on…"
    public static let turningOnBody = "This can take about a minute the first time."

    public static let onTitle = "On"
    public static let noBrowserNote = "No browser is connected right now. Open your browser with Polycarp's extension, and assistants will be able to use it."
    public static let addressLabel = "Address to add in an assistant"
    public static let passcodeLabel = "Passcode"
    public static let passcodeOnce = "Shown once. Save it in a password manager; you type it when an assistant asks to connect."
    public static let passcodeSaved = "I've saved it"
    public static let passcodeEarlier = "Your passcode was shown when you turned this on."
    public static let newPasscodeButton = "Make a new passcode"
    public static let newPasscodeNote = "A new passcode replaces the old one. Assistants you've already approved keep working."
    public static let turnOffButton = "Turn off"
    public static let turnOffFailed = "Couldn't turn it off. Try again."
    public static let helperSilent = "Polycarp's browser helper didn't answer. Quit and reopen Polycarp, then try again."
    public static let unavailable = "This copy of Polycarp doesn't include the browser helper."
    public static let otherWays = "Other ways"
    public static let otherWaysHelp = "Use your own Cloudflare address instead of Tailscale"
    public static let approvalNote = "When an assistant asks to connect, a page from this computer opens. Check the name, tick what it may do, type the passcode and press Allow. Only approve a connection you just started."
    public static let menusNote = "Menus change; if you can't find it, look for connectors in the assistant's settings."

    public struct Assistant: Equatable, Identifiable {
        public var name: String
        public var steps: [String]
        public var id: String { name }
    }

    /// From browser/docs/remote.md, "Add the connector". Only what that page says.
    public static let assistants: [Assistant] = [
        Assistant(name: "Claude", steps: ["Open claude.ai and go to Settings, then Connectors.", "Choose Add custom connector and paste the address."]),
        Assistant(name: "ChatGPT", steps: ["Go to Settings, then Apps & Connectors, and turn on developer mode.", "Choose Create, paste the address and choose OAuth."]),
        Assistant(name: "Grok", steps: ["Open grok.com/connectors.", "Choose New Connector, then Custom, and paste the address."]),
    ]

    /// All of it, for the tests that hold the words to the rules.
    public static var everySentence: [String] {
        let fixed = [title, intro, honest, staysOn, genericProblem, getTailscaleTitle, getTailscaleBody, getTailscaleButton, signInTitle, signInBody, openTailscaleButton,
                     needsBrowserTitle, needsBrowserBody, funnelTitle, funnelBody, funnelButton, tryAgainButton, lockTitle, lockBody, busyTitle, busyBody, checkAgainButton,
                     readyTitle, readyBody, turnOnButton, turningOnTitle, turningOnBody, onTitle, noBrowserNote, addressLabel, passcodeLabel, passcodeOnce, passcodeSaved,
                     passcodeEarlier, startOverButton, detailsLabel, newPasscodeButton, newPasscodeNote, turnOffButton, turnOffFailed, helperSilent, unavailable, otherWays, otherWaysHelp, approvalNote, menusNote]
        return fixed + assistants.flatMap { [$0.name] + $0.steps }
    }
}
