import Foundation

/// "Turn on everything": one decision for all of what agents may do here, so a person who wants that doesn't hunt for three switches.
/// One sheet, one real click. It never includes the connector, which stays at Default, and never macOS's own permissions, which only
/// the person can grant in System Settings.
public enum AgentEverything {
    public static let title = "Give agents everything"
    public static let why = "Full Access to this Mac, any site in your browser, and no prompts for Polycarp's tools in Claude Code."
    public static let button = "Turn On Everything…"
    public static let on = "Everything is on"
    public static let consentTitle = "Turn on everything for agents?"
    public static let consentBody = "Agents can read and act on every window on every workspace and start any app. They can open any site in your browser without asking, and Claude Code stops asking before it uses Polycarp's tools. They still can't drive an Open or Save panel, and assistants on the web stay limited to what you tick for them. You can turn any of this off in Settings > Agents."
    public static let consentButton = "Turn On Everything"
    public static let openBrowser = "Full Access is on. Open your browser with Polycarp's extension, then turn on Any site in Settings > Agents."
    public static let finishing = "Full Access is on. Finishing the rest…"
    public static let browserPartOff = "Full Access is on. Any site and Claude Code's setting need Polycarp's Browser part, in Settings > General."

    /// `anySite` is nil when no browser has answered. Claude Code counts only where it's set up, because the rule matches nothing otherwise.
    public static func isOn(access: AgentAccessMode, anySite: Bool?, claudeAllowed: Bool, claudeReady: Bool) -> Bool {
        access == .full && anySite == true && (claudeAllowed || !claudeReady)
    }
}

/// Who is asking, as the socket sees it. The remote server names every caller "remote …", and `polycarp-spaces mcp --connector`
/// names itself the same way; a local caller claiming it only loses access.
public enum HandsCaller {
    public static let connector = "remote connector"
    /// In `ping`'s answer from an app that holds a connector to `forRemote`. Without it the app is older than the cap, so a connector stops.
    public static let capKey = "connector_cap"
    public static let capValue = "default"
    /// `serverInfo.name` from `mcp --connector`. A helper older than the flag ignores it and answers with its usual name, so `polycarp browser serve` won't use it.
    public static let connectorServerName = "polycarp-connector"
    public static func isRemote(_ caller: String?) -> Bool { caller?.hasPrefix("remote ") == true }
}

/// How much of this Mac agents may use, picked by Donovan in Settings > Agents and kept until he changes it.
/// Every mode keeps the background-only rules: no app activation, no raised window, no global keys or clicks,
/// no action while he is using an app (it waits until the app has been out of the front `UserUse.quiet` seconds; reads
/// never wait), and never an Open or Save panel.
public enum AgentAccessMode: String, CaseIterable, Codable, Sendable {
    /// Agents may list, read and capture the windows Default allows, and change nothing.
    case readOnly = "read_only"
    /// The agent workspace, apps BaneySpaces starts for agents from its short list, and windows he lends.
    case standard = "default"
    /// Every window BaneySpaces places, on every workspace, and any app.
    case full

    public static let defaultsKey = "agentAccessMode"

    /// A saved value that isn't one of the modes reads as Default, never as more access.
    public init(saved: String?) { self = saved.flatMap(Self.init(rawValue:)) ?? .standard }

    var rank: Int {
        switch self {
        case .readOnly: return 0
        case .standard: return 1
        case .full: return 2
        }
    }

    /// Whether moving from `old` to this mode gives agents more than they had: only Donovan's real click
    /// on a consent sheet does that. Narrowing never asks.
    public func widens(from old: AgentAccessMode) -> Bool { rank > old.rank }

    /// What a caller on another machine gets: never more than Default. Full Access is for agents on this Mac;
    /// a remote caller only gives the agent workspace work (SECURITY.md).
    public var forRemote: AgentAccessMode { self == .full ? .standard : self }

    public var title: String {
        switch self {
        case .readOnly: return "Read Only"
        case .standard: return "Default"
        case .full: return "Full Access"
        }
    }

    public var detail: String {
        switch self {
        case .readOnly:
            return "Agents can list, read and capture the windows they could use in Default, and can't click, type, open apps, run commands, move windows or turn the agent workspace on."
        case .standard:
            return "Agents work on the agent workspace, in apps Polycarp starts for them (TextEdit, Preview, Calculator) and in apps you lend."
        case .full:
            return "Agents can read and act on every window on every workspace and start any app. They still work from behind: they never bring an app forward, move your pointer, type into the window you are using, or use an Open or Save panel, and an action in an app you are using waits until it has been out of the front for \(Int(UserUse.quiet)) seconds."
        }
    }
}

/// What Read Only refuses: every verb that changes something. `shot` only reads.
public enum AgentAccessGate {
    public static let changes: Set<String> = ["click", "type", "set-value", "press", "click-at", "drag", "scroll", "select", "toggle", "open", "arrange", "move", "close"]
    /// The session engine's own agent ops that start or move something.
    public static let sessionChanges: Set<String> = ["open", "run", "move", "on"]

    public static func refusal(verb: String, mode: AgentAccessMode) -> HandsError? {
        guard mode == .readOnly, changes.contains(verb) else { return nil }
        return readOnly(verb)
    }

    /// The check right before an action is delivered (and before each retry): the mode may have narrowed to Read Only
    /// since the request was let in.
    public static func actingRefusal(mode: AgentAccessMode) -> HandsError? {
        mode == .readOnly ? readOnly("this action") : nil
    }

    public static func sessionRefusal(op: String, mode: AgentAccessMode) -> HandsError? {
        guard mode == .readOnly, sessionChanges.contains(op) else { return nil }
        return readOnly("agent \(op)")
    }

    static func readOnly(_ what: String) -> HandsError {
        HandsError(.permissionDenied, "agents have read-only access, so \(what) is refused",
                   suggestion: "You can still list, snapshot, find, get and shot. Donovan sets agent access in Polycarp Settings > Agents.",
                   retry: .never)
    }
}
