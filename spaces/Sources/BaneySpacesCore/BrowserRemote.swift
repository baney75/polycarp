import Foundation

/// Settings > Browser > "Use Polycarp from Claude, ChatGPT and Grok". The bundled helper does the work (`remote setup`,
/// `remote status`, `remote off`) and answers in JSON; this reads the answer and decides which one step to show. No UI
/// and no process here, so all of it is tested. The helper's states are the contract: nothing below reads a sentence.

/// Where remote access stands, as the helper names it.
public enum RemoteState: String, CaseIterable, Equatable {
    case tailscaleMissing = "tailscale_missing"
    case tailscaleSignedOut = "tailscale_signed_out"
    case funnelNotAllowed = "funnel_not_allowed"
    case funnelClosed = "funnel_closed"
    case cloudflaredMissing = "cloudflared_missing"
    case tailnetLock = "tailnet_lock"
    case portBusy = "port_busy"
    case ready
    case on
    case noBrowserConnected = "no_browser_connected"
    case problem
}

/// The two ways an assistant can reach this computer, on the person's own account.
public enum RemoteRoute: String, Equatable { case tailscale, cloudflare }

/// Which routes are installed and signed in, from `remote status --json`.
public struct RemoteRoutes: Equatable {
    public var tailscaleInstalled, tailscaleSignedIn, cloudflareInstalled, cloudflareSignedIn: Bool
    public init(tailscaleInstalled: Bool = false, tailscaleSignedIn: Bool = false, cloudflareInstalled: Bool = false, cloudflareSignedIn: Bool = false) {
        self.tailscaleInstalled = tailscaleInstalled; self.tailscaleSignedIn = tailscaleSignedIn
        self.cloudflareInstalled = cloudflareInstalled; self.cloudflareSignedIn = cloudflareSignedIn
    }

    init?(json: Any?) {
        guard let root = json as? [String: Any], let t = root["tailscale"] as? [String: Any], let c = root["cloudflare"] as? [String: Any] else { return nil }
        self.init(tailscaleInstalled: t["installed"] as? Bool ?? false, tailscaleSignedIn: t["signedIn"] as? Bool ?? false,
                  cloudflareInstalled: c["installed"] as? Bool ?? false, cloudflareSignedIn: c["signedIn"] as? Bool ?? false)
    }
}

/// One answer from `remote status --json` or `remote setup --json`.
public struct RemoteReport: Equatable {
    public var ok: Bool
    public var state: RemoteState
    /// The helper's own words. Shown only for `.problem`, where no state says more.
    public var message: String
    /// Tailscale's page for allowing Funnel: only ever a tailscale.com address.
    public var adminURL: URL?
    /// Why a problem or a busy connection happened, when the helper says (`launcher`: no browser has been connected yet;
    /// `tailscale_port`: a saved Tailscale setting is in the way; `local_port`: a program on this computer is).
    public var code: String?
    public var connectorURL: String?
    /// Present only in the answer of the run that made the passcode.
    public var passcode: String?
    public var passcodeSet: Bool
    /// Status only: whether a browser has the extension connected. Nil when the answer didn't say.
    public var extensionConnected: Bool?
    /// Status only. Nil from an older helper, which then goes straight to Tailscale, the only route it knew.
    public var routes: RemoteRoutes?

    /// Status only: remote access is set up on this computer (the answer carries its address), whatever shape it is in.
    public var configured: Bool { connectorURL != nil }

    public init(ok: Bool = false, state: RemoteState, message: String = "", adminURL: URL? = nil, code: String? = nil,
                connectorURL: String? = nil, passcode: String? = nil, passcodeSet: Bool = false, extensionConnected: Bool? = nil, routes: RemoteRoutes? = nil) {
        self.ok = ok; self.state = state; self.message = message; self.adminURL = adminURL; self.code = code
        self.connectorURL = connectorURL; self.passcode = passcode; self.passcodeSet = passcodeSet; self.extensionConnected = extensionConnected
        self.routes = routes
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
            extensionConnected: root["extensionConnected"] as? Bool,
            routes: RemoteRoutes(json: root["routes"]))
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
    /// Nothing is set up and no route is picked: Tailscale or Cloudflare, each with a way to make an account.
    case chooseRoute(RemoteRoutes)
    /// `configured`: remote access is set up on the Cloudflare route and cloudflared went away.
    case getCloudflared(configured: Bool)
    /// `waiting`: cloudflared's sign-in is open in the browser.
    case cloudflareSignIn(waiting: Bool)
    /// The name to use. `problem`: the helper's words about the last try.
    case cloudflareAddress(problem: String?)
    /// `configured`: remote access is already set up and only waiting on Tailscale, so the intro and "nothing was changed" are wrong.
    case getTailscale(configured: Bool)
    case signIn(configured: Bool)
    case needsBrowser
    case funnelNotAllowed(adminURL: URL?)
    /// Set up, but Tailscale's Funnel setting no longer lets the internet in for the saved address. Try again opens it.
    case funnelClosed
    case tailnetLock(configured: Bool)
    /// `tailscaleSetting`: a saved Tailscale setting uses the connection (not a program to quit). `detail`: the helper's own words.
    case portBusy(tailscaleSetting: Bool, detail: String)
    case ready
    case turningOn
    case on(connectorURL: String, browserConnected: Bool)
    case problem(String)
}

public enum RemoteFlow {
    /// How long a successful Turn on is allowed to speak for itself while status reads catch up (Funnel can lag).
    public static let setupGrace: TimeInterval = 60
    /// The same, while the only thing status finds wrong is public DNS (code `dns`): Tailscale takes minutes to publish a new address.
    public static let dnsGrace: TimeInterval = 600
    /// The grace that applies to what status says now.
    public static func grace(for status: RemoteReport?) -> TimeInterval { status?.code == "dns" ? dnsGrace : setupGrace }
    /// Status reads in a row that must fail (no JSON, a crash, a timeout) before the window says the helper is silent.
    public static let readFailureLimit = 2
    /// A copied passcode is taken off the clipboard after this many seconds, unless something else was copied since.
    public static let passcodeClipboardSeconds: TimeInterval = 60

    /// What the window shows for the latest status and the result of the last Turn on.
    /// - `setup`: the last `remote setup` answer. A refusal stays on screen (the status read afterwards only says the setup
    ///   is half done) except where status names something more basic. A success is a short bridge, not a lasting state: it
    ///   speaks for itself only until a status read answers, and for at most `setupGrace` seconds (`setupAge`) after that.
    /// - `readsFailing`: the last `readFailureLimit` status reads all failed.
    /// - `chosen`: the route the person picked, while nothing is set up yet. `signingIn`: cloudflared's sign-in is running.
    public static func screen(helperAvailable: Bool, settingUp: Bool, status: RemoteReport?, setup: RemoteReport?, setupAge: TimeInterval = 0,
                              readsFailing: Bool = false, chosen: RemoteRoute? = nil, signingIn: Bool = false) -> RemoteScreen {
        guard helperAvailable else { return .unavailable }
        if settingUp { return .turningOn }
        // Reads that keep failing come before the last good answer: an old "On" must not stay up while the helper is silent.
        if readsFailing { return .problem(RemoteCopy.helperSilent) }
        if let status, status.state == .on || status.state == .noBrowserConnected, let url = status.connectorURL {
            return .on(connectorURL: url, browserConnected: status.state == .on)
        }
        // Nothing set up: the choice comes first, then the chosen route's steps. A problem (no browser yet, a hub) comes ahead of both.
        if let status, !status.configured, status.state != .problem, setup?.state != .on, let routes = status.routes {
            if chosen == nil, setup == nil { return .chooseRoute(routes) }
            if chosen == .cloudflare {
                if !routes.cloudflareInstalled { return .getCloudflared(configured: false) }
                if signingIn || !routes.cloudflareSignedIn { return .cloudflareSignIn(waiting: signingIn) }
                return .cloudflareAddress(problem: setup.flatMap { $0.message.isEmpty ? nil : $0.message })
            }
        }
        if let setup {
            if setup.state == .on, let url = setup.connectorURL {
                // Just turned on. Before the first status read, or while it lags (inside the grace period), this stands in for it.
                if status == nil || setupAge < grace(for: status) {
                    return .on(connectorURL: url, browserConnected: status?.extensionConnected ?? true)
                }
            } else if setup.state != .on {
                if !(status.map { moreBasic.contains($0.state) } ?? false) { return screen(for: setup, configured: status?.configured ?? false) }
            }
        }
        guard let status else { return .checking }
        return screen(for: status, configured: status.configured)
    }

    /// Tailscale itself being gone is more basic than any refusal about Funnel or a busy connection.
    private static let moreBasic: Set<RemoteState> = [.tailscaleMissing, .tailscaleSignedOut, .tailnetLock, .cloudflaredMissing]

    /// The `setup` answer to keep once a status read arrives. A success was only a bridge: a status that confirms it ends it. A
    /// refusal about Tailscale itself ends once status no longer says the same thing, so signing in moves the window on.
    public static func settle(setup: RemoteReport?, status: RemoteReport) -> RemoteReport? {
        guard let setup else { return nil }
        if status.state == .on || status.state == .noBrowserConnected, status.connectorURL != nil { return nil }
        if moreBasic.contains(setup.state), status.state != setup.state { return nil }
        return setup
    }

    private static func screen(for r: RemoteReport, configured: Bool) -> RemoteScreen {
        switch r.state {
        case .tailscaleMissing: .getTailscale(configured: configured)
        case .tailscaleSignedOut: .signIn(configured: configured)
        case .funnelNotAllowed: .funnelNotAllowed(adminURL: r.adminURL)
        case .funnelClosed: .funnelClosed
        case .cloudflaredMissing: .getCloudflared(configured: configured)
        case .tailnetLock: .tailnetLock(configured: configured)
        case .portBusy: .portBusy(tailscaleSetting: r.code == "tailscale_port", detail: r.message)
        case .ready: .ready
        case .on, .noBrowserConnected:
            // Set up but the answer carried no address: nothing to show but what the helper said.
            .problem(r.message.isEmpty ? RemoteCopy.genericProblem : r.message)
        case .problem:
            r.code == "launcher" ? .needsBrowser : .problem(r.message.isEmpty ? RemoteCopy.genericProblem : r.message)
        }
    }

    /// Seconds until the next status read. Quick while a step waits on the person and the read is cheap; slow whenever status
    /// reports an install that is set up (a full read then checks the internet side and the browser too, so it isn't repeated
    /// every few seconds), except while Tailscale itself is the problem: that read skips those checks and the window should
    /// notice the sign-in. `bridging`: a Turn on just succeeded and status hasn't confirmed it yet.
    public static func pollInterval(for screen: RemoteScreen, status: RemoteReport? = nil, bridging: Bool = false) -> TimeInterval {
        if bridging { return 4 }
        if case .on = screen { return 30 }
        if let status, status.configured, !moreBasic.contains(status.state) { return 30 }
        return 4
    }

    /// The passcode to show. The first answer that carries one wins until the person says they've saved it; a later answer
    /// without one (a retry after a refusal) never clears it.
    public static func keepPasscode(current: String?, from report: RemoteReport) -> String? { report.passcode ?? current }

    /// What a person typed as the tunnel's name, as the helper will take it: lowercase, with no scheme or path. Nil when it can't be a name.
    public static func cloudflareHost(_ raw: String) -> String? {
        var host = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for scheme in ["https://", "http://"] where host.hasPrefix(scheme) { host.removeFirst(scheme.count) }
        if let slash = host.firstIndex(of: "/") { host = String(host[..<slash]) }
        if host.hasSuffix(".") { host.removeLast() }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard host.count <= 253, labels.count >= 2 else { return nil }
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-")
        let fits = labels.allSatisfy { $0.count >= 1 && $0.count <= 63 && $0.allSatisfy(allowed.contains) && $0.first != "-" && $0.last != "-" }
        return fits ? host : nil
    }

    /// Clear a copied passcode only if nothing else has been copied since (the pasteboard's change count is the same).
    public static func shouldClearClipboard(copiedAt: Int, now: Int) -> Bool { copiedAt == now }
}

/// The helper's commands and what the app tells it. Exact arguments are pinned by tests, so a rename here fails loudly.
public enum RemoteCommand: Equatable {
    case status, setup, off, newPasscode, cloudflareLogin
    case setupCloudflare(String)
    case approvalCode

    public var arguments: [String] {
        switch self {
        case .status: ["remote", "status", "--json"]
        case .setup: ["remote", "setup", "--json"]
        case .off: ["remote", "off"]
        case .newPasscode: ["token", "passcode", "--json"]
        case .setupCloudflare(let host): ["remote", "setup", "--json", "--cloudflare", host]
        case .cloudflareLogin: ["remote", "cloudflare", "login", "--json"]
        case .approvalCode: ["token", "approval-code", "--json"]
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
        case .setupCloudflare: 180
        case .approvalCode: 15
        // cloudflared's own sign-in waits five minutes for the person.
        case .cloudflareLogin: 320
        }
    }

    /// `{"ok":true,"kind":"approval","code":"…"}` from `token approval-code --json`.
    public static func parseApprovalCode(_ data: Data) -> String? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              root["ok"] as? Bool == true, let code = root["code"] as? String, !code.isEmpty else { return nil }
        return code
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
    public static let title = "Use Polycarp from Claude, ChatGPT and Grok"
    public static let tailscaleSignupURL = URL(string: "https://login.tailscale.com/start")!
    public static let cloudflareSignupURL = URL(string: "https://dash.cloudflare.com/sign-up")!
    public static let cloudflaredDownloadURL = URL(string: "https://developers.cloudflare.com/tunnel/downloads/")!

    public static let chooseTitle = "How should assistants reach this computer?"
    public static let chooseBody = "Both are free and run on your own account. Polycarp never sees your account or makes one for you."
    public static let tailscaleChoice = "No domain needed. The quickest way to start."
    public static let cloudflareChoice = "The address is on your own domain, which has to be on your Cloudflare account."
    public static let useTailscaleButton = "Use Tailscale"
    public static let useCloudflareButton = "Use Cloudflare"
    public static let createAccountButton = "Create a free account"
    public static let chooseAgainButton = "Choose another way"

    public static func routeStatus(installed: Bool, signedIn: Bool) -> String {
        signedIn ? "Signed in on this computer" : installed ? "Installed, not signed in" : "Not on this computer yet"
    }

    public static let getCloudflaredTitle = "First, get cloudflared"
    public static let getCloudflaredBody = "It's Cloudflare's free program for tunnels. Polycarp notices when it's installed."
    public static let getCloudflaredButton = "Get cloudflared"
    public static let cloudflaredCommand = "brew install cloudflared"
    public static let copyCommandButton = "Copy brew command"

    public static let cloudflareSignInTitle = "Sign in to Cloudflare"
    public static let cloudflareSignInBody = "Your browser opens Cloudflare. Sign in and pick the domain to use. No domain there yet? Add one in Cloudflare, or use Tailscale, which doesn't need one."
    public static let cloudflareSignInButton = "Sign in to Cloudflare"
    public static let cloudflareWaiting = "Waiting for you to finish in your browser…"

    public static let cloudflareAddressTitle = "Pick this computer's address"
    public static let cloudflareAddressBody = "Any name on the domain you picked, like polycarp.yourdomain.com. Polycarp makes the tunnel and its DNS record on your account. A name already in use is left alone."
    public static let cloudflareAddressPlaceholder = "polycarp.yourdomain.com"
    public static let cloudflareAddressInvalid = "That can't be an address. Use one like polycarp.yourdomain.com."
    public static let docsURL = URL(string: "https://github.com/baney75/polycarp/blob/main/browser/docs/remote.md#if-funnel-wont-work")!
    public static let tailscaleDownloadURL = URL(string: "https://tailscale.com/download")!

    public static let intro = "Let the assistants you use on the web work in this computer's browser and, if you allow it, in apps on its agent workspace. It's off until you turn it on."
    public static let honest = "This runs on your own account. Assistants you approve can use your signed-in browser, so only approve ones you trust. Computer use stays off for each one unless you tick it when you approve it."
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
    public static let needsBrowserBody = "Polycarp needs a browser connected before an assistant can use it. Use Connect in the Browsers section above, then come back and press Check again."

    public static let funnelTitle = "Allow Funnel in Tailscale"
    public static let funnelBody = "Funnel is Tailscale's setting that lets the internet reach this computer. Allow it for this computer on the page below, then come back and try again."
    public static let funnelButton = "Open Tailscale settings"
    public static let tryAgainButton = "I've allowed it, try again"

    public static let lockTitle = "This won't work on your Tailscale network"
    public static let lockBody = "Your network has Tailnet Lock turned on, and Tailscale's Funnel setting doesn't work with it. Nothing was changed. Turning Tailnet Lock off is your decision, so Polycarp doesn't. Other ways are listed in the guide."
    /// The same, for an install that is already set up: nothing is "unchanged" about it.
    public static let lockConfiguredBody = "Your network has Tailnet Lock turned on, and Tailscale's Funnel setting doesn't work with it. Turning Tailnet Lock off is your decision, so Polycarp doesn't. Other ways are listed in the guide."
    public static let stillSetUp = "Remote access is still set up on this computer. It picks up again by itself once this is fixed."

    public static let funnelClosedTitle = "Funnel is closed in Tailscale"
    public static let funnelClosedBody = "Remote access is still set up, but Tailscale's Funnel setting isn't open for this computer, so assistants can't reach it. Try again to open it. If Tailscale asks you to allow it first, Polycarp shows you the page."
    public static let funnelClosedButton = "Try again"

    public static let busyTitle = "Something else is in the way"
    public static let busyBody = "Another program on this computer is already using the connection Polycarp needs. Nothing was changed. Quit that program, then check again."
    public static let busyTailscaleBody = "A setting saved in Tailscale is already using the connection Polycarp needs. It isn't a program you can quit. Nothing was changed. Turn that setting off in Tailscale, then check again."
    public static let checkAgainButton = "Check again"

    public static let readyTitle = "Ready to turn on"
    public static let readyBody = "Tailscale is signed in. Turning this on gives you an address to add in each assistant, and a passcode that approves them. Anyone on the internet can reach that address, but an assistant still needs the passcode."
    public static let turnOnButton = "Turn on"

    public static let turningOnTitle = "Turning on…"
    public static let turningOnBody = "This can take about a minute the first time."

    public static let onTitle = "On"
    public static let noBrowserNote = "No browser is connected right now. Open your browser with Polycarp's extension, and assistants will be able to use it."
    public static let addressLabel = "Address to add in an assistant"
    public static let passcodeLabel = "Passcode"
    public static let passcodeOnce = "Shown once. Save it in a password manager, but not one built into the browser Polycarp uses. You type it when an assistant asks to connect."
    public static let passcodeSaved = "I've saved it"
    public static let passcodeEarlier = "You already have a passcode. If you didn't save it, make a new one."
    public static let noPasscodeNote = "There's no passcode yet. Make one before you add an assistant."
    public static let newPasscodeButton = "Make a new passcode"
    public static let newPasscodeNote = "A new passcode replaces the old one. Assistants you've already approved keep working."
    public static let turnOffButton = "Turn off"
    public static let turnOffFailed = "Couldn't turn it off. Try again."
    public static let helperSilent = "Polycarp's browser helper didn't answer. Quit and reopen Polycarp, then try again."
    public static let unavailable = "This copy of Polycarp doesn't include the browser helper."
    public static let otherWays = "Other ways"
    public static let otherWaysHelp = "Use your own front door, like a server you already run"
    public static let approvalNote = "When an assistant asks to connect, a page from this computer opens. Check the name, tick what it may do, enter the connect code and press Allow. Only approve a connection you just started."
    public static let connectCodeButton = "Make a connect code"
    public static let connectCodeLabel = "Connect code"
    public static let connectCodeNote = "A new assistant needs this once. It works for ten minutes. After that, your passcode approves that assistant again."
    public static let connectCodeFailed = "Couldn't make a connect code. Try again."
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
                     needsBrowserTitle, needsBrowserBody, funnelTitle, funnelBody, funnelButton, tryAgainButton, lockTitle, lockBody, lockConfiguredBody, stillSetUp, funnelClosedTitle, funnelClosedBody, funnelClosedButton, busyTitle, busyBody, checkAgainButton,
                     readyTitle, readyBody, turnOnButton, turningOnTitle, turningOnBody, onTitle, noBrowserNote, addressLabel, passcodeLabel, passcodeOnce, passcodeSaved,
                     passcodeEarlier, noPasscodeNote, busyTailscaleBody, startOverButton, detailsLabel, newPasscodeButton, newPasscodeNote, turnOffButton, turnOffFailed, helperSilent, unavailable, otherWays, otherWaysHelp, approvalNote, menusNote]
        return fixed + assistants.flatMap { [$0.name] + $0.steps }
    }
}
