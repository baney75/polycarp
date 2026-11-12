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

/// One check `remote test` (or setup's proof) ran from the internet.
public struct RemoteCheck: Equatable, Identifiable {
    public var name: String
    /// ok, warn or fail.
    public var status: String
    public var detail: String
    /// A failure that waiting fixes (a new name not published yet, a tunnel still connecting): the helper checks again. Only
    /// ever true on a failure.
    public var pending: Bool
    public var id: String { name }
    public var failed: Bool { status == "fail" }
    /// Failed, and waiting is what fixes it: shown as waiting, never as a failure and never with Repair.
    public var waiting: Bool { failed && pending }
    /// Failed for real: what Repair and "N checks failed" count.
    public var realFailure: Bool { failed && !pending }
    public init(name: String, status: String, detail: String = "", pending: Bool = false) {
        self.name = name; self.status = status; self.detail = detail; self.pending = pending && status == "fail"
    }

    /// The outside checks the window keeps: the six proof checks, and `probe_cleanup`, the failure `remote test` adds when its
    /// probe token couldn't be deleted. Without it a failed test whose only failure is that cleanup reads as passed (second-S3).
    public static let names: Set<String> = RemoteSharedCopy.checkCodes.union(["probe_cleanup"])

    /// Only the outside checks, each once, with their words capped: anything else in `checks` is the status read's own list.
    static func parse(_ json: Any?) -> [RemoteCheck] {
        guard let list = json as? [[String: Any]] else { return [] }
        var seen = Set<String>()
        return list.compactMap { item in
            guard let name = item["name"] as? String, names.contains(name), !seen.contains(name),
                  let status = item["status"] as? String, ["ok", "warn", "fail"].contains(status) else { return nil }
            seen.insert(name)
            return RemoteCheck(name: name, status: status, detail: String((item["detail"] as? String ?? "").prefix(300)),
                               pending: item["pending"] as? Bool == true)
        }
    }
}

/// A one-time connect code and when it stops working. Memory only.
public struct ConnectCode: Equatable {
    public var code: String
    public var expiresAt: Date
    public init(code: String, expiresAt: Date) { self.code = code; self.expiresAt = expiresAt }

    /// `TK-XXXX-XXXX` in Crockford base 32, as agent-setup-prompt.ts's CONNECT_CODE checks it. Anything else is not shown.
    public static func valid(_ s: String) -> Bool {
        s.range(of: "^TK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$", options: .regularExpression) != nil
    }

    /// From a code and the helper's `expiresAt` (milliseconds since 1970). Nil when either is missing or malformed.
    public static func from(code: Any?, expiresAt: Any?) -> ConnectCode? {
        guard let code = code as? String, valid(code), let ms = (expiresAt as? NSNumber)?.doubleValue, ms.isFinite, ms > 0 else { return nil }
        return ConnectCode(code: code, expiresAt: Date(timeIntervalSince1970: ms / 1000))
    }

    public func secondsLeft(now: Date) -> Int { max(0, Int(expiresAt.timeIntervalSince(now).rounded(.up))) }
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
    /// The state as the helper spelled it, so a state this app doesn't know still picks the right sentence.
    public var rawState: String
    /// The helper's `next`: what kind of step, and a command to show (never run) when it gives one.
    public var nextKind: String?
    public var nextCommand: String?
    /// Checks from the internet, from setup's proof or `remote test`.
    public var checks: [RemoteCheck]
    /// Setup's connect code (asked for with --connect-code). Memory only.
    public var connectCode: ConnectCode?

    /// Status only: remote access is set up on this computer (the answer carries its address), whatever shape it is in.
    public var configured: Bool { connectorURL != nil }

    public init(ok: Bool = false, state: RemoteState, message: String = "", adminURL: URL? = nil, code: String? = nil,
                connectorURL: String? = nil, passcode: String? = nil, passcodeSet: Bool = false, extensionConnected: Bool? = nil, routes: RemoteRoutes? = nil,
                rawState: String? = nil, nextKind: String? = nil, nextCommand: String? = nil, checks: [RemoteCheck] = [], connectCode: ConnectCode? = nil) {
        self.ok = ok; self.state = state; self.message = message; self.adminURL = adminURL; self.code = code
        self.connectorURL = connectorURL; self.passcode = passcode; self.passcodeSet = passcodeSet; self.extensionConnected = extensionConnected
        self.routes = routes
        self.rawState = rawState ?? state.rawValue; self.nextKind = nextKind; self.nextCommand = nextCommand; self.checks = checks; self.connectCode = connectCode
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
            routes: RemoteRoutes(json: root["routes"]),
            rawState: raw,
            nextKind: (root["next"] as? [String: Any])?["kind"] as? String,
            nextCommand: ((root["next"] as? [String: Any])?["command"] as? String).flatMap(oneLine),
            checks: RemoteCheck.parse(root["checks"]),
            connectCode: ConnectCode.from(code: root["connectCode"], expiresAt: root["connectCodeExpiresAt"]))
    }

    /// A command to show for copying: one line, at most 300 characters. Shown as text, never run.
    static func oneLine(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespaces)
        return t.isEmpty || t.count > 300 || t.contains(where: \.isNewline) ? nil : t
    }

    /// Something failed from the internet for real (a pending failure is waiting, not failed).
    public var failedChecks: [RemoteCheck] { checks.filter(\.realFailure) }

    /// The route is on, as a person should read it: the helper says on, or it saved an address and the only failures are ones
    /// that waiting fixes, or an older helper's bare `dns` code with the address. remote-copy.ts's answerOn.
    public var answerOn: Bool {
        if state == .on || state == .noBrowserConnected { return true }
        // The helper gave up waiting and names `remote fix`: a problem to repair, not a name still publishing (second-N2).
        if needsRepair { return false }
        guard state == .problem, connectorURL != nil else { return false }
        return checks.isEmpty ? code == "dns" : RemoteFlow.waitingOnly(checks)
    }

    /// The helper's next step is `remote fix`: setup waited out its deadline on a check that was only pending. The window shows
    /// check_failed with Repair, and takes no connect code from the answer. remote-copy.ts's needsRepair.
    public var needsRepair: Bool {
        guard nextKind == "run_command", let command = nextCommand else { return false }
        return command.range(of: #"(^|\s)remote fix(\s|$)"#, options: .regularExpression) != nil
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
    /// The name to use. `problem`: the helper's words about the last try; `code`: its problem code, which picks the sentence.
    case cloudflareAddress(problem: String?, code: String? = nil)
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
    /// `code`: the helper's problem code, which picks a specific sentence. `message`: its own words, under Details (or the body,
    /// when no entry knows the code).
    case problem(code: String?, message: String)
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
        if readsFailing { return .problem(code: RemoteCopy.helperSilentCode, message: RemoteCopy.helperSilent) }
        if let status, status.answerOn, let url = status.connectorURL {
            // A name still being published (a problem that is only waiting) says nothing against the browser unless status does.
            let connected = status.state == .problem ? status.extensionConnected ?? true : status.state == .on
            return .on(connectorURL: url, browserConnected: connected)
        }
        // Nothing set up: the choice comes first, then the chosen route's steps. A problem (no browser yet, a hub) comes ahead of both.
        if let status, !status.configured, status.state != .problem, !(setup?.answerOn ?? false), let routes = status.routes {
            if chosen == nil, setup == nil { return .chooseRoute(routes) }
            if chosen == .cloudflare {
                if !routes.cloudflareInstalled { return .getCloudflared(configured: false) }
                if signingIn || !routes.cloudflareSignedIn { return .cloudflareSignIn(waiting: signingIn) }
                return .cloudflareAddress(problem: setup.flatMap { $0.message.isEmpty ? nil : $0.message }, code: setup?.code)
            }
        }
        if let setup {
            if setup.answerOn, let url = setup.connectorURL {
                // Just turned on (a new name still being published included). Before the first status read, or while it lags
                // (inside the grace period), this stands in for it.
                if status == nil || setupAge < grace(for: status) {
                    return .on(connectorURL: url, browserConnected: status?.extensionConnected ?? true)
                }
            } else if !setup.answerOn {
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
        if status.answerOn, status.connectorURL != nil { return nil }
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
            .problem(code: nil, message: r.message)
        case .problem:
            r.code == "launcher" ? .needsBrowser : .problem(code: r.code, message: r.message)
        }
    }

    /// While Tailscale's Funnel page is open, Turn on runs again by itself this often, for at most `funnelRetryFor`: allowing
    /// Funnel can't be seen in status, so running setup again is how the window learns it worked. No button to press.
    public static let funnelRetryEvery: TimeInterval = 15
    public static let funnelRetryFor: TimeInterval = 600

    /// Run setup again now? Only while the last setup said Funnel isn't allowed, nothing else is running, the retries started
    /// less than `funnelRetryFor` ago, and the last try was at least `funnelRetryEvery` ago.
    public static func funnelRetryDue(setup: RemoteReport?, busy: Bool, firstRefusal: Date?, lastTry: Date?, now: Date) -> Bool {
        guard setup?.state == .funnelNotAllowed, !busy, let firstRefusal else { return false }
        guard now.timeIntervalSince(firstRefusal) < funnelRetryFor else { return false }
        return now.timeIntervalSince(lastTry ?? firstRefusal) >= funnelRetryEvery
    }

    /// What a setup run's answer puts on screen. A pressed run always shows something: the helper's answer, or that it said
    /// nothing. A quiet run (the Funnel retry) shows only a real change; no JSON, a timeout or the same refusal leave the screen
    /// as it is and the retry goes on (first-F2). Nil: change nothing.
    public static func setupOutcome(_ parsed: RemoteReport?, quiet: Bool) -> RemoteReport? {
        guard quiet else { return parsed ?? RemoteReport(state: .problem, message: RemoteCopy.helperSilent) }
        guard let parsed, parsed.state != .funnelNotAllowed else { return nil }
        return parsed
    }

    /// The steps whose Turn on needs a Cloudflare name: the name field is on the step, and Turn on sets up that name.
    public static let cloudflareNameKeys: Set<String> = ["cloudflare_name", "cloudflare_name_refused", "cloudflare_zone"]

    /// What a problem step's Turn on does. A Cloudflare name step asks for the name, never plain setup, which would turn on
    /// Tailscale (first-F3). Otherwise the last setup runs again, or plain setup, which reuses a route already saved.
    public static func turnOnStep(key: String, last: RemoteCommand?) -> TurnOnStep {
        if cloudflareNameKeys.contains(key) { return .askName }
        if let last, case .setupCloudflare = last { return .run(last) }
        return .run(.setup)
    }

    public enum TurnOnStep: Equatable {
        case run(RemoteCommand)
        /// Set up the name in the step's field.
        case askName
    }

    /// The words above the Cloudflare name field: the step a name problem names, else the plain name step. A problem about
    /// anything else (a sign-in, a tunnel) has words that don't fit a name field (second-S1).
    public static func addressStepKey(code: String?, nextKind: String?) -> String {
        guard let code else { return "cloudflare_name" }
        let k = RemoteSharedCopy.key(state: "problem", code: code, nextKind: nextKind)
        return cloudflareNameKeys.contains(k) || k == "cloudflare_dns" ? k : "cloudflare_name"
    }

    /// Repair shows only when a check from the internet failed for real, or the answer names `remote fix` (second-N2), and this
    /// helper has `remote fix` with something to do.
    public static func offerRepair(checks: [RemoteCheck], plan: RemoteFixPlan?, answer: RemoteReport? = nil) -> Bool {
        (checks.contains(where: \.realFailure) || answer?.needsRepair == true) && repairAvailable(plan)
    }

    /// This helper has `remote fix` (feature-detected) and its plan has something in it. remote-flow.ts's repairAvailable.
    public static func repairAvailable(_ plan: RemoteFixPlan?) -> Bool { (plan?.available ?? false) && !(plan?.actions.isEmpty ?? true) }

    /// Something failed, and every failure is one waiting fixes. remote-copy.ts's waitingChecks.
    public static func waitingOnly(_ checks: [RemoteCheck]) -> Bool {
        let failed = checks.filter(\.failed)
        return !failed.isEmpty && failed.allSatisfy(\.pending)
    }

    /// While a check waits (a name being published, a tunnel connecting), `remote test` runs again this often by itself.
    public static let waitingRecheckEvery: TimeInterval = 30

    /// The On screen's heading and whether it is waiting, from the newest checks, else the answer's own code (an older helper's
    /// bare `dns`). remote-flow.ts's result().
    public static func resultHead(checks: [RemoteCheck], answer: RemoteReport?, browserConnected: Bool) -> (head: String, waiting: Bool) {
        if checks.contains(where: \.realFailure) { return ("check_failed", false) }
        if waitingOnly(checks) || (checks.isEmpty && answer?.code == "dns" && answer?.connectorURL != nil) { return ("on_waiting", true) }
        return (browserConnected ? "on" : "no_browser_connected", false)
    }

    /// The setup answer to keep once `remote test` answers. A run that stopped on dns or a failed check is over once a later
    /// test finds nothing failed for real (waiting is on), so the step can't outlive what it was about. remote-flow.ts's settleRunAfterTest.
    public static func settleAfterTest(setup: RemoteReport?, checks: [RemoteCheck]) -> RemoteReport? {
        guard let setup, !setup.answerOn, !checks.isEmpty, !checks.contains(where: \.realFailure) else { return setup }
        let k = RemoteSharedCopy.key(state: setup.rawState, code: setup.code, nextKind: setup.nextKind, nextCommand: setup.nextCommand)
        return k == "dns" || k == "check_failed" ? nil : setup
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
    /// `download`: the person pressed "Get it for me", so the helper may fetch Cloudflare's own release (pinned, checked).
    case setupCloudflare(String, download: Bool = false)
    case approvalCode
    /// Checks from the internet. Read-only.
    case test
    /// `remote fix` (from a newer helper): what it would repair, changing nothing; then the repair itself.
    case fixPlan, fix

    public var arguments: [String] { arguments(connectCode: true) }

    /// `connectCode`: a person pressed the button, so setup's answer may carry the one-time code a new assistant needs
    /// (`--connect-code`). The Funnel retry runs by itself and passes false: a code is made only by a press.
    public func arguments(connectCode: Bool) -> [String] {
        let code = connectCode ? ["--connect-code"] : []
        switch self {
        case .status: return ["remote", "status", "--json"]
        case .setup: return ["remote", "setup", "--json"] + code
        case .off: return ["remote", "off"]
        case .newPasscode: return ["token", "passcode", "--json"]
        case .setupCloudflare(let host, let download): return ["remote", "setup", "--json"] + code + ["--cloudflare", host] + (download ? ["--yes"] : [])
        case .cloudflareLogin: return ["remote", "cloudflare", "login", "--json"]
        case .approvalCode: return ["token", "approval-code", "--json"]
        case .test: return ["remote", "test", "--json"]
        case .fixPlan: return ["remote", "fix", "--json", "--dry-run"]
        case .fix: return ["remote", "fix", "--json", "--yes"]
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
        case .test: 60
        case .fixPlan: 60
        case .fix: 300
        // cloudflared's own sign-in waits five minutes for the person.
        case .cloudflareLogin: 320
        }
    }

    /// `{"ok":true,"kind":"approval","code":"TK-…","expiresAt":…}` from `token approval-code --json`.
    public static func parseApprovalCode(_ data: Data) -> ConnectCode? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], root["ok"] as? Bool == true else { return nil }
        return ConnectCode.from(code: root["code"], expiresAt: root["expiresAt"])
    }

    /// `remote fix --json`. Exit 2 (a usage error: this helper has no `remote fix`) or no `actions` list means not available.
    public static func parseFix(exitCode: Int32, _ data: Data) -> RemoteFixPlan {
        guard exitCode != 2, let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let list = root["actions"] as? [[String: Any]] else { return RemoteFixPlan(available: false) }
        let actions = list.prefix(10).compactMap { a -> RemoteFixPlan.Action? in
            guard let kind = a["kind"] as? String, let what = a["what"] as? String, let status = a["status"] as? String else { return nil }
            return .init(kind: String(kind.prefix(40)), what: String(what.prefix(300)), status: String(status.prefix(20)))
        }
        return RemoteFixPlan(available: true, ok: root["ok"] as? Bool ?? false, actions: Array(actions), checks: RemoteCheck.parse(root["checks"]))
    }

    /// `{"ok":true,"passcode":"…"}` from `token passcode --json`.
    public static func parsePasscode(_ data: Data) -> String? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              root["ok"] as? Bool == true, let code = root["passcode"] as? String, !code.isEmpty else { return nil }
        return code
    }
}

/// The Funnel retry's clock: when the refusals began, the last try, the admin page opened, and whether ten minutes ran out.
/// Leaving Settings or switching tab pauses it; coming back to a step that still refuses Funnel resumes it, without opening
/// the admin page again (first-F1).
public struct FunnelRetry: Equatable {
    public private(set) var firstRefusal: Date?
    public private(set) var lastTry: Date?
    public private(set) var openedAdmin: URL?
    public private(set) var gaveUp = false
    public init() {}

    /// Setup said Funnel isn't allowed. Returns the page to open: once per refusal run, since allowing Funnel is the step.
    public mutating func refused(admin: URL?, now: Date) -> URL? {
        if firstRefusal == nil { firstRefusal = now; gaveUp = false }
        guard let admin, openedAdmin != admin else { return nil }
        openedAdmin = admin
        return admin
    }

    /// The window is back. True when the last answer still refuses Funnel: the retry starts again, tries at once (Funnel may have
    /// been allowed meanwhile) and has a fresh ten minutes. The page counts as opened, so it doesn't open again.
    public mutating func resume(setup: RemoteReport?, now: Date) -> Bool {
        guard setup?.state == .funnelNotAllowed else { return false }
        firstRefusal = now; lastTry = .distantPast; gaveUp = false
        openedAdmin = setup?.adminURL ?? openedAdmin
        return true
    }

    public mutating func tried(now: Date) { lastTry = now }

    public enum Tick: Equatable { case wait, run, gaveUp }

    public mutating func tick(setup: RemoteReport?, busy: Bool, now: Date) -> Tick {
        if let first = firstRefusal, now.timeIntervalSince(first) >= RemoteFlow.funnelRetryFor { gaveUp = true; return .gaveUp }
        return RemoteFlow.funnelRetryDue(setup: setup, busy: busy, firstRefusal: firstRefusal, lastTry: lastTry, now: now) ? .run : .wait
    }

    public mutating func stop() { self = FunnelRetry() }
}

/// What `remote fix` would do, or did.
public struct RemoteFixPlan: Equatable {
    public struct Action: Equatable {
        public var kind, what, status: String
        public init(kind: String, what: String, status: String) { self.kind = kind; self.what = what; self.status = status }
    }
    public var available: Bool
    public var ok = false
    public var actions: [Action] = []
    public var checks: [RemoteCheck] = []
    public init(available: Bool, ok: Bool = false, actions: [Action] = [], checks: [RemoteCheck] = []) {
        self.available = available; self.ok = ok; self.actions = actions; self.checks = checks
    }
}

/// The sentences only the Mac window has. Every step's title, body and button come from `RemoteSharedCopy`, the same words
/// the side panel shows; these are the app's own pieces around them.
public enum RemoteCopy {
    public static let title = "Use Polycarp from Claude, ChatGPT and Grok"
    public static let tailscaleSignupURL = URL(string: "https://login.tailscale.com/start")!
    public static let cloudflareSignupURL = URL(string: "https://dash.cloudflare.com/sign-up")!
    public static let cloudflaredDownloadURL = URL(string: "https://developers.cloudflare.com/tunnel/downloads/")!
    public static let tailscaleDownloadURL = URL(string: "https://tailscale.com/download")!
    public static let docsURL = URL(string: "https://github.com/baney75/polycarp/blob/main/browser/docs/remote.md#if-funnel-wont-work")!

    public static let createAccountButton = "Create a free account"
    public static let openTailscaleButton = "Open Tailscale"
    public static let openDownloadPage = "Open the download page"
    public static let cloudflareWaiting = "Waiting for you to finish in your browser..."
    public static let cloudflareAddressPlaceholder = "polycarp.yourdomain.com"
    public static let cloudflareAddressInvalid = "That can't be an address. Use one like polycarp.yourdomain.com."
    /// "Get it for me" needs the address first: the helper downloads cloudflared and goes on to set that address up.
    public static let cloudflareAddressFirst = "Type this computer's address first, like polycarp.yourdomain.com."
    public static let funnelWaiting = "Waiting for Funnel to be allowed. This window tries again by itself."

    public static let intro = "Let the assistants you use on the web work in this computer's browser and, if you allow it, in apps on its agent workspace. It's off until you turn it on."
    public static let honest = "This runs on your own account. Assistants you approve can use your signed-in browser, so only approve ones you trust. Computer use stays off for each one unless you tick it when you approve it."
    public static let staysOn = "Your computer must stay on and signed in."
    public static let stillSetUp = "Remote access is still set up on this computer. It picks up again by itself once this is fixed."
    public static let startOverButton = "Turn off and start over"
    public static let detailsLabel = "Details"
    public static let commandLabel = "Command"
    public static let copyCommandButton = "Copy the command"

    public static let passcodeSaved = "I've saved it"
    public static let passcodeEarlier = "You already have a passcode for re-approving. If you didn't save it, make a new one."
    public static let newPasscodeButton = "Make a new passcode"
    public static let newPasscodeFailed = "Couldn't make a new passcode. Try again."
    public static let connectCodeFailed = "Couldn't make a connect code. Try again."
    public static let repairFailed = "Repair didn't finish. Details has the helper's words."
    public static let turnOffFailed = "Couldn't turn it off. Try again."
    /// The problem code the window uses for "the helper didn't answer": not one the helper sends.
    public static let helperSilentCode = "helper_silent"
    public static let helperSilent = "Polycarp's browser helper didn't answer. Quit and reopen Polycarp, then try again."
    public static let unavailable = "This copy of Polycarp doesn't include the browser helper."
    public static let otherWays = "Other ways"
    public static let otherWaysHelp = "Use your own front door, like a server you already run"
    /// Labels for the checks only `remote test` sends, which the shared table doesn't list.
    public static let testCheckLabels = ["probe_cleanup": "Test token removed"]
    /// A check's label: the shared one, else the Mac's, else its name.
    public static func checkLabel(_ name: String) -> String { RemoteSharedCopy.checkLabels[name] ?? testCheckLabels[name] ?? name }
    public static let menusNote = "Menus change; if you can't find it, look for connectors in the assistant's settings."

    /// "Step 2 of 3: Get it and sign in".
    public static func stepHeader(_ n: Int) -> String {
        "Step \(n) of \(RemoteSharedCopy.flowSteps.count): \(RemoteSharedCopy.flowSteps[n - 1])"
    }

    /// The Mac's own sentences, for the tests that hold them to the rules. The shared ones are held by remote-copy.test.mjs.
    public static var everySentence: [String] {
        [title, createAccountButton, openTailscaleButton, openDownloadPage, cloudflareWaiting, cloudflareAddressInvalid, cloudflareAddressFirst,
         funnelWaiting, intro, honest, staysOn, stillSetUp, startOverButton, detailsLabel, commandLabel, copyCommandButton,
         passcodeSaved, passcodeEarlier, newPasscodeButton, newPasscodeFailed, connectCodeFailed, repairFailed, turnOffFailed, helperSilent,
         unavailable, otherWays, otherWaysHelp, menusNote] + testCheckLabels.values.sorted()
    }
}
