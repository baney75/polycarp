import Foundation

/// The words "Use Polycarp from Claude, ChatGPT and Grok" shares with the side panel and the helper. Each literal below is
/// the same as browser/src/connect/remote-copy.ts (`STEP_COPY`, `ASSISTANT_STEPS`, `APPROVAL_STEP`, `RESULT_COPY`,
/// `CHECK_LABELS`); browser/test/remote-copy.test.mjs fails when either side changes alone, so edit both together.
public struct RemoteStepCopy: Equatable {
    public let title: String
    /// Nil only for `unknown`, whose body is the helper's own message.
    public let body: String?
    /// The one button's label. Nil where the step has none.
    public let action: String?
    /// What the button does (remote-copy.ts's RemoteActionKind): the window does the work.
    public let kind: String?
    /// The window moves on by itself on this step.
    public let waits: Bool
}

public struct RemoteAssistantStep: Equatable, Identifiable {
    public let id: String
    public let name: String
    public let `where`: String
}

public enum RemoteSharedCopy {
    public static let steps: [String: RemoteStepCopy] = [
        "tailscale_missing": RemoteStepCopy(title: "Get Tailscale", body: "Tailscale is free and runs on your own account. Install it and sign in; this page moves on by itself.", action: "Get Tailscale", kind: "open_url", waits: true),
        "tailscale_signed_out": RemoteStepCopy(title: "Sign in to Tailscale", body: "Tailscale is installed but not signed in. Open Tailscale and sign in, or run the command below in a terminal. This page moves on by itself.", action: "Copy the command", kind: "copy_command", waits: true),
        "tailnet_lock": RemoteStepCopy(title: "Funnel won't work on this tailnet", body: "Your tailnet has Tailnet Lock turned on, and Funnel doesn't work with it. Nothing was changed. Use Cloudflare instead; turning Tailnet Lock off is your decision.", action: "Use Cloudflare", kind: "use_cloudflare", waits: false),
        "local_port": RemoteStepCopy(title: "Another program is using Polycarp's port", body: "A program on this computer already listens on the port Polycarp needs, so nothing was changed. Quit it, then check again.", action: "Check again", kind: "check_again", waits: false),
        "tailscale_port": RemoteStepCopy(title: "A Tailscale setting is using port 8443", body: "A setting saved in Tailscale already uses the port Funnel needs, so nothing was changed. Turn that setting off in Tailscale, then check again.", action: "Check again", kind: "check_again", waits: false),
        "ready": RemoteStepCopy(title: "Ready to turn on", body: "Tailscale is signed in. Turning on gives you an address to add in each assistant and a one-time connect code that approves it.", action: "Turn on", kind: "turn_on", waits: false),
        "turning_on": RemoteStepCopy(title: "Turning on", body: "This can take about a minute the first time.", action: nil, kind: nil, waits: false),
        "funnel_not_allowed": RemoteStepCopy(title: "Allow Funnel in Tailscale", body: "Funnel is the Tailscale setting that lets assistants reach this computer. On Tailscale's page, press the button that enables it. This page moves on by itself once it's allowed.", action: "Open Tailscale's page", kind: "open_url", waits: true),
        "funnel_gave_up": RemoteStepCopy(title: "Allow Funnel in Tailscale", body: "This page stopped checking after 10 minutes. Once Funnel is allowed on Tailscale's page, press Check again.", action: "Check again", kind: "open_funnel", waits: false),
        "funnel_closed": RemoteStepCopy(title: "Funnel is closed in Tailscale", body: "Remote access is set up, but Funnel isn't open for this computer, so assistants can't reach it.", action: "Open Funnel again", kind: "open_funnel", waits: false),
        "tailscale_operator": RemoteStepCopy(title: "Let your user control Tailscale", body: "Tailscale refused because your user isn't its operator. Run this command once in a terminal; Polycarp never runs sudo. This page moves on by itself.", action: "Copy the command", kind: "copy_command", waits: true),
        "tailscale_operator_check": RemoteStepCopy(title: "Let your user control Tailscale", body: "Tailscale refused because your user isn't its operator. Run this command once in a terminal; Polycarp never runs sudo. Then press Check again.", action: "Check again", kind: "open_funnel", waits: false),
        "launcher": RemoteStepCopy(title: "Finish installing Polycarp", body: "Polycarp's launcher isn't set up on this computer, so the background service would have nothing to start. Run this command once in a terminal, then try again.", action: "Copy the command", kind: "copy_command", waits: false),
        "launcher_app": RemoteStepCopy(title: "Connect a browser first", body: "Polycarp needs a browser connected before an assistant can use it. Use Connect in the Browsers section above, then press Check again.", action: "Check again", kind: "check_again", waits: false),
        "hub": RemoteStepCopy(title: "This computer is a hub", body: "It already has the one public address an install can have, for your devices. Add the hub's address in assistants, or turn the hub off first.", action: "Check again", kind: "check_again", waits: false),
        "service": RemoteStepCopy(title: "The background service didn't start", body: "Polycarp couldn't start the service that keeps the connector running. Your settings are kept. Details has the reason.", action: "Try again", kind: "try_again", waits: false),
        "serve": RemoteStepCopy(title: "The connector didn't answer on this computer", body: "The service started, but nothing answered on Polycarp's local port, so nothing was opened to the internet. Details has the reason.", action: "Try again", kind: "try_again", waits: false),
        "funnel": RemoteStepCopy(title: "Tailscale couldn't open Funnel", body: "Tailscale refused to open Funnel. Its own words are under Details. Fix that, then try again.", action: "Try again", kind: "try_again", waits: false),
        "config": RemoteStepCopy(title: "A settings file couldn't be saved", body: "Polycarp couldn't read or write its connector settings. Details names the file. Fix it, then try again.", action: "Try again", kind: "try_again", waits: false),
        "dns": RemoteStepCopy(title: "The new address is still spreading", body: "A new address takes a few minutes to reach public DNS. This page checks again by itself.", action: "Check now", kind: "check_again", waits: true),
        "dns_lookup": RemoteStepCopy(title: "Public DNS can't look up this address", body: "Public DNS answered that the lookup failed, often because of broken DNSSEC, so waiting won't fix it. Fix the name's records or DNSSEC with your DNS provider, then check again.", action: "Check again", kind: "check_again", waits: false),
        "cloudflared_missing": RemoteStepCopy(title: "Get cloudflared", body: "cloudflared is Cloudflare's free program for tunnels. Polycarp can download Cloudflare's own release and check its fingerprint before using it.", action: "Get it for me", kind: "download", waits: false),
        "cloudflared_manual": RemoteStepCopy(title: "Get cloudflared", body: "cloudflared is Cloudflare's free program for tunnels. Install it from Cloudflare's page; this page moves on by itself.", action: "Open the download page", kind: "open_url", waits: true),
        "cloudflare_login": RemoteStepCopy(title: "Sign in to Cloudflare", body: "Your browser opens Cloudflare. Sign in and pick the domain for this computer's address. This page moves on by itself.", action: "Sign in to Cloudflare", kind: "sign_in_cloudflare", waits: true),
        "cloudflare_name": RemoteStepCopy(title: "Pick this computer's address", body: "Any name on a domain in your Cloudflare account, like polycarp.yourdomain.com. Polycarp makes the tunnel and its DNS record there.", action: "Turn on", kind: "turn_on", waits: false),
        "cloudflare_name_refused": RemoteStepCopy(title: "Pick another name", body: "Cloudflare can't use that name for a new tunnel: it's taken, or it isn't a valid name. Polycarp never replaces a record.", action: "Turn on", kind: "turn_on", waits: false),
        "cloudflare_dns": RemoteStepCopy(title: "Cloudflare couldn't make the DNS record", body: "The tunnel is ready, but its DNS record wasn't made. Details has Cloudflare's words.", action: "Try again", kind: "try_again", waits: false),
        "cloudflare_zone": RemoteStepCopy(title: "That domain isn't on your Cloudflare account", body: "The name must be on the domain you signed in for. Pick a name on that domain, or sign in again for another one.", action: "Turn on", kind: "turn_on", waits: false),
        "cloudflare_tunnel": RemoteStepCopy(title: "Cloudflare couldn't make the tunnel", body: "Details has Cloudflare's words. Fix that, then try again.", action: "Try again", kind: "try_again", waits: false),
        "connect_code": RemoteStepCopy(title: "On, but no connect code yet", body: "The connector is set up, but the one-time connect code couldn't be made. Make a new code before you add an assistant.", action: "New code", kind: "new_code", waits: false),
        "check_failed": RemoteStepCopy(title: "On, but a check from the internet failed", body: "The connector answers, but an assistant may not be able to use it. The failed check says why.", action: "Repair", kind: "repair", waits: false),
        "on_waiting": RemoteStepCopy(title: "On: the address is still being published", body: "A new address takes a few minutes to reach the internet. This page checks again by itself; add the assistant once it passes.", action: nil, kind: nil, waits: false),
        "on": RemoteStepCopy(title: "On: add Polycarp to an assistant", body: "Assistants you approve can use this browser. Only approve a connection you just started.", action: nil, kind: nil, waits: false),
        "no_browser_connected": RemoteStepCopy(title: "On, but no browser is connected", body: "Open your browser with Polycarp's extension, and assistants can use it.", action: nil, kind: nil, waits: false),
        "not_set_up": RemoteStepCopy(title: "Nothing is set up yet", body: "Choose how assistants reach this computer.", action: "Choose a way", kind: "choose", waits: false),
        "unknown": RemoteStepCopy(title: "Setup stopped", body: nil, action: "Try again", kind: "try_again", waits: false),
    ]
    public static let assistantSteps: [RemoteAssistantStep] = [
        RemoteAssistantStep(id: "claude", name: "claude.ai", where: "Settings > Connectors > Add custom connector."),
        RemoteAssistantStep(id: "chatgpt", name: "ChatGPT", where: "Settings > Apps & Connectors (turn on developer mode) > Create. Choose OAuth."),
        RemoteAssistantStep(id: "grok", name: "grok.com", where: "grok.com/connectors > New Connector > Custom."),
    ]
    public static let approvalStep = "Each opens Polycarp's approval page: check the name, tick what it may do, type the connect code and press Allow."
    public static let result: [String: String] = [
        "assistantsStep": "1. In your assistant, add a custom connector",
        "addressStep": "2. Paste this address",
        "codeStep": "3. On Polycarp's approval page, type this code",
        "addressLabel": "Connector URL",
        "codeLabel": "Connect code",
        "expiresIn": "Expires in",
        "expired": "Expired. Make a new code.",
        "newCode": "New code",
        "codeNote": "It works once, for 10 minutes. Each new assistant needs its own code.",
        "passcodeLabel": "Passcode, for re-approving",
        "passcodeNote": "Shown once. Use it when an assistant you already approved asks again. Keep it in a password manager, but not one the browser Polycarp drives can fill.",
        "noPasscode": "No passcode was made here. To approve an assistant again later, make a new connect code.",
        "codeNone": "Press New code to make the code for your assistant.",
        "checksWaiting": "Waiting for the address to answer.",
        "checksTitle": "Checked from the internet",
        "checksPassed": "Every check passed.",
        "checksRunning": "Checking from the internet...",
        "checksNone": "Not checked yet.",
        "checkAgain": "Check again",
        "repair": "Repair",
        "repairing": "Repairing...",
        "turnOff": "Turn off",
        "copy": "Copy",
        "copied": "Copied.",
    ]
    public static let checkLabels: [String: String] = [
        "dns": "Public DNS",
        "tls": "Certificate",
        "resource_metadata": "Connector address",
        "auth_metadata": "Sign-in settings",
        "auth_challenge": "Sign-in challenge",
        "streaming": "Streaming",
    ]
    public static let route: [String: String] = [
        "chooseTitle": "How should assistants reach this computer?",
        "chooseBody": "Both ways are free and run on your own account. Polycarp never sees the account or makes one for you.",
        "tailscale.name": "Tailscale",
        "tailscale.detail": "No domain needed.",
        "tailscale.use": "Use Tailscale",
        "cloudflare.name": "Cloudflare",
        "cloudflare.detail": "Uses a domain on your Cloudflare account.",
        "cloudflare.use": "Use Cloudflare",
        "recommended": "Recommended",
        "signedIn": "Signed in on this computer",
        "installed": "Installed, not signed in",
        "missing": "Not on this computer yet",
        "chooseAgain": "Choose another way",
        "useCloudflareInstead": "Use Cloudflare instead",
    ]
    public static let problemCodes: [String] = ["tailscale_operator", "launcher", "hub", "service", "serve", "funnel", "config", "dns", "dns_lookup", "cloudflare_login", "cloudflare_zone", "cloudflare_tunnel", "connect_code"]
    public static let flowSteps: [String] = ["Choose a way", "Get it and sign in", "Turn on"]

    /// The proof check names: a `problem` whose code is one of these failed a check from outside.
    public static var checkCodes: Set<String> { Set(checkLabels.keys) }

    /// The entry for one helper answer, as `copyKey` picks it in remote-copy.ts. `launcher` is the app's own entry: its remedy
    /// here is Connect, not a terminal command.
    public static func key(state: String, code: String?, nextKind: String? = nil, nextCommand: String? = nil) -> String {
        switch state {
        case "tailscale_missing", "tailscale_signed_out", "tailnet_lock", "ready", "funnel_not_allowed", "funnel_closed", "on", "no_browser_connected", "turning_on":
            return state
        case "cloudflared_missing":
            return nextCommand == nil ? "cloudflared_manual" : "cloudflared_missing"
        case "port_busy":
            return code == "tailscale_port" ? "tailscale_port" : "local_port"
        case "problem":
            guard let code else { return "unknown" }
            if code == "launcher" { return "launcher_app" }
            if code == "cloudflare_name" || code == "not_set_up" { return code }
            if code == "cloudflare_dns" { return nextKind == "choose_name" ? "cloudflare_name_refused" : "cloudflare_dns" }
            // A new name not published yet has words of its own; any other check is check_failed.
            if code == "dns" { return "dns" }
            if checkCodes.contains(code) { return "check_failed" }
            if problemCodes.contains(code), steps[code] != nil { return code }
            return "unknown"
        default:
            return "unknown"
        }
    }

    /// The sentence for one answer: its entry, or for `unknown` the helper's message as the body.
    public static func copy(for r: RemoteReport) -> (key: String, title: String, body: String) {
        let k = key(state: r.rawState, code: r.code, nextKind: r.nextKind, nextCommand: r.nextCommand)
        let entry = steps[k] ?? steps["unknown"]!
        let trimmed = r.message.trimmingCharacters(in: .whitespacesAndNewlines)
        return (k, entry.title, entry.body ?? (trimmed.isEmpty ? unknownBody : trimmed))
    }

    public static let unknownBody = "The helper stopped without saying why."

    /// "1 check failed.", "2 checks failed."
    public static func checksFailed(_ n: Int) -> String { "\(n) check\(n == 1 ? "" : "s") failed." }

    /// "Expires in 9:05".
    public static func countdown(seconds: Int) -> String {
        guard seconds > 0 else { return result["expired"]! }
        return "\(result["expiresIn"]!) \(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }
}
