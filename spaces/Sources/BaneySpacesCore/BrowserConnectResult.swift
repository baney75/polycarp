import Foundation

/// What `polycarp browser connect on|off|status|waitlist --json` printed: the last line of its standard output.
/// Pure, so the window's states and wording are testable without the app or the helper.
public struct BrowserConnectResult: Equatable {
    public enum State: String, Equatable {
        case off, on, connecting, problem, unsupported, offline, paused
        case atCapacity = "at_capacity"
        case inviteOnly = "invite_only"
        case inviteInvalid = "invite_invalid"
        case rateLimited = "rate_limited"
    }

    public struct Check: Equatable {
        public var name: String
        public var status: String
        public var detail: String
        public init(name: String, status: String, detail: String) { self.name = name; self.status = status; self.detail = detail }
    }

    public var ok: Bool
    public var state: State
    public var message: String
    public var connectorURL: String?
    /// Present only in the answer that just made it. It is never read back, so the window can show it once.
    public var passcode: String?
    public var checks: [Check]

    public init(ok: Bool, state: State, message: String, connectorURL: String? = nil, passcode: String? = nil, checks: [Check] = []) {
        self.ok = ok; self.state = state; self.message = message
        self.connectorURL = connectorURL; self.passcode = passcode; self.checks = checks
    }

    /// The last JSON object line of `data`. The helper prints progress to standard error, but a stray line must not hide the answer.
    public static func parse(_ data: Data) -> BrowserConnectResult? {
        let text = String(decoding: data, as: UTF8.self)
        for line in text.split(whereSeparator: \.isNewline).reversed() {
            guard line.hasPrefix("{"), let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let ok = obj["ok"] as? Bool, let raw = obj["state"] as? String, let state = State(rawValue: raw) else { continue }
            let checks = (obj["checks"] as? [[String: Any]] ?? []).compactMap { c -> Check? in
                guard let name = c["name"] as? String, let status = c["status"] as? String else { return nil }
                return Check(name: name, status: status, detail: c["detail"] as? String ?? "")
            }
            return BrowserConnectResult(ok: ok, state: state, message: obj["message"] as? String ?? "",
                                        connectorURL: obj["connectorUrl"] as? String, passcode: obj["passcode"] as? String, checks: checks)
        }
        return nil
    }

    /// The person should be offered the waitlist and an invite code.
    public var offersWaitlist: Bool { state == .atCapacity || state == .inviteOnly || state == .inviteInvalid }

    /// What the window says. The three answers about room are fixed words so the product says the same thing everywhere;
    /// the rest come from the helper, which writes them in plain words.
    public var headline: String {
        switch state {
        case .atCapacity: Self.fullWords
        case .inviteOnly: Self.inviteWords
        case .paused: Self.pausedWords
        case .on: "Connected. Add the address below to Claude, ChatGPT or Grok."
        case .connecting: message.isEmpty ? "Connecting. This can take a minute." : message
        case .off: "Off."
        case .offline, .problem, .unsupported, .inviteInvalid, .rateLimited: message.isEmpty ? "Something went wrong. Try again." : message
        }
    }

    public static let fullWords = "Polycarp's free connections are full right now. Join the waitlist, or enter an invite code."
    public static let inviteWords = "New connections need an invite code right now. Enter your code, or join the waitlist."
    public static let pausedWords = "Polycarp isn't adding new connections right now. Please try again later."

    /// True when the connector address should be shown with its steps.
    public var showsConnector: Bool { (state == .on || state == .connecting) && connectorURL != nil }

    /// The arguments for the helper, after `connect`. Invite codes and emails are separate arguments, never joined into a string.
    public enum Action: Equatable {
        case status, on(invite: String?, newPasscode: Bool), off, waitlist(email: String)

        public var arguments: [String] {
            switch self {
            case .status: ["connect", "status", "--json"]
            case .off: ["connect", "off", "--json"]
            case .on(let invite, let newPasscode):
                ["connect", "on", "--json"] + (invite.map { ["--invite", $0] } ?? []) + (newPasscode ? ["--new-passcode"] : [])
            case .waitlist(let email): ["connect", "waitlist", email, "--json"]
            }
        }

        /// Seconds to wait. `on` may download the helper and wait for the address to answer.
        public var timeout: TimeInterval {
            switch self {
            case .on: 240
            case .off: 90
            case .status: 40
            case .waitlist: 40
            }
        }
    }

    /// An email address worth sending: one `@`, no spaces, a dot after it. The service checks again.
    public static func looksLikeEmail(_ raw: String) -> Bool {
        let s = raw.trimmingCharacters(in: .whitespaces)
        guard s.count <= 254, !s.contains(" "), !s.hasPrefix("-") else { return false }
        let parts = s.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") && !parts[1].hasPrefix(".") && !parts[1].hasSuffix(".")
    }

    /// An invite code as typed: letters, digits and dashes only, so it can't pass as an option to the helper.
    public static func cleanInvite(_ raw: String) -> String? {
        let s = raw.trimmingCharacters(in: .whitespaces).uppercased()
        guard (8...64).contains(s.count), s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }), !s.hasPrefix("-") else { return nil }
        return s
    }
}
