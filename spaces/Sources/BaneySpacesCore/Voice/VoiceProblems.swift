import Foundation

/// What Settings > Silas and the overlay say when dictation can't do what was asked: the permission lines, the
/// "notice" event, the key help, and the hotkey pick's outcome. Plain data, so every word and decision is tested
/// without the library or AppKit.

/// One permission as the voice core reads it (core/voice permissions.rs `Grant`). Anything new reads as unknown.
public enum VoiceGrant: String, Codable, Equatable, Sendable {
    case granted, denied, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = VoiceGrant(rawValue: raw) ?? .unknown
    }
}

/// `permissions` in `pc_status`.
public struct VoicePermissions: Codable, Equatable, Sendable {
    public var microphone: VoiceGrant
    public var accessibility: VoiceGrant

    public init(microphone: VoiceGrant, accessibility: VoiceGrant) {
        self.microphone = microphone
        self.accessibility = accessibility
    }

    /// A missing or odd field reads as unknown, so the rest of `pc_status` still decodes.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        microphone = (try? c.decodeIfPresent(VoiceGrant.self, forKey: .microphone)) ?? .unknown
        accessibility = (try? c.decodeIfPresent(VoiceGrant.self, forKey: .accessibility)) ?? .unknown
    }
}

/// A line in Settings > Silas: what the permission is for, its state, and the one button that moves it forward.
public struct VoicePermissionLine: Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        /// macOS shows its own box (it has never been asked).
        case ask
        /// Open the list in System Settings where the switch is.
        case openSettings(String)
    }

    public var kind: PermissionKind
    public var title: String
    public var state: String
    public var help: String
    public var button: String?
    public var action: Action?
    public var allowed: Bool

    /// Microphone: allowed, never asked (Allow shows macOS's box), or refused (only System Settings can change that).
    public static func microphone(_ g: VoiceGrant, product: String = Product.name) -> VoicePermissionLine {
        let url = Welcome.step(.microphone).settingsURL
        let help = "\(product) hears you only while you hold or tap your dictation key."
        switch g {
        case .granted:
            return .init(kind: .microphone, title: "Microphone", state: "Allowed", help: help, button: nil, action: nil, allowed: true)
        case .unknown:
            // Welcome's rule: the list opens only after a no; before that macOS asks.
            let opens = Welcome.opensSettingsWhenAllowing(microphone: .notDetermined)
            return .init(kind: .microphone, title: "Microphone", state: "Not asked yet", help: help, button: "Allow",
                         action: opens ? .openSettings(url) : .ask, allowed: false)
        case .denied:
            return .init(kind: .microphone, title: "Microphone", state: "Not allowed",
                         help: "Turn on \(product) in System Settings, then dictate again.", button: "Open Microphone Settings",
                         action: .openSettings(url), allowed: false)
        }
    }

    /// Accessibility: needed to hear the dictation key and to type. Only System Settings grants it.
    public static func accessibility(_ g: VoiceGrant, product: String = Product.name) -> VoicePermissionLine {
        let url = Welcome.step(.accessibility).settingsURL
        if g == .granted {
            return .init(kind: .accessibility, title: "Accessibility", state: "Allowed",
                         help: "\(product) hears your dictation key and types what you said.", button: nil, action: nil, allowed: true)
        }
        return .init(kind: .accessibility, title: "Accessibility", state: "Not allowed",
                     help: "\(product) can't hear your dictation key or type until this is on. If its switch is on already, turn it off and on again.",
                     button: "Open Accessibility Settings", action: .openSettings(url), allowed: false)
    }
}

/// The core's "notice" event: a dictation failed, a press came while busy, or Escape stopped the typing.
public struct VoiceNotice: Decodable, Equatable, Sendable {
    public enum Kind: String, Decodable, Sendable { case error, busy, stopped }
    public var kind: Kind
    public var message: String

    public init(kind: Kind, message: String) {
        self.kind = kind
        self.message = message
    }

    /// How long the overlay keeps it up. An error stays long enough to read two lines; the core clears its error
    /// status after 4 s (`RECOVER_AFTER` in core.rs).
    public var seconds: TimeInterval {
        switch kind {
        case .error: 4
        case .busy: 2.5
        case .stopped: 3
        }
    }

    /// SF Symbol for the overlay face.
    public var symbol: String {
        switch kind {
        case .error: "exclamationmark.triangle.fill"
        case .busy: "hourglass"
        case .stopped: "stop.circle.fill"
        }
    }

    /// What VoiceOver reads when it appears.
    public var announcement: String { "Silas: \(message)" }

    /// Errors are kept for Settings > Silas; busy and stopped are only for the moment.
    public var keeps: Bool { kind == .error }
}

/// The last error, kept for Settings > Silas after the overlay has cleared it.
public struct VoiceProblem: Equatable, Sendable {
    public var message: String
    public var at: Date

    public init(message: String, at: Date) {
        self.message = message
        self.at = at
    }

    /// "Last problem, 3 minutes ago: …"
    public func line(now: Date) -> String { "Last problem, \(Self.ago(now.timeIntervalSince(at))): \(message)" }

    static func ago(_ s: TimeInterval) -> String {
        let s = max(0, Int(s))
        if s < 60 { return "just now" }
        let m = s / 60
        if m < 60 { return m == 1 ? "1 minute ago" : "\(m) minutes ago" }
        let h = m / 60
        if h < 24 { return h == 1 ? "1 hour ago" : "\(h) hours ago" }
        return "earlier"
    }
}

/// The help under Settings > Silas > Key. Picking a key needs the key listener; when it isn't running, say the real
/// reason, not always "turn dictation on".
public enum VoiceKeyHelp {
    public static func text(listener: Bool, userEnabled: Bool, waiting: VoiceGate.Reason?, accessibility: VoiceGrant?,
                            hotkey: String, hasFallback: Bool, product: String = Product.name) -> String? {
        if listener {
            guard hotkey == "Dictation" else { return nil }
            return "The key with the microphone on the top row. If your keyboard has none, pick another."
                + (hasFallback ? " Right ⌘ also works until you first press it." : "")
        }
        if !userEnabled || waiting == .userOff { return "Turn dictation on first to pick another key." }
        if let w = waiting, let why = VoiceGate.message(w) { return why + " You can pick another key once it starts." }
        if let a = accessibility, a != .granted {
            return "\(product) can't hear keys until Accessibility is on. Use the Accessibility line above, then pick a key."
        }
        return "\(product) isn't listening for keys right now. Turn dictation off and on again, then pick a key."
    }
}

/// How a "Pick another key" ended (`pc_hotkey_capture`: a name, or NULL with the reason).
public enum VoiceCapture: Equatable, Sendable {
    case picked(String)
    case cancelled
    case timedOut
    case refused(String)

    /// The core's `CANCELLED` and its timeout text.
    public static func outcome(key: String?, error: String) -> VoiceCapture {
        if let key { return .picked(key) }
        if error == "cancelled" { return .cancelled }
        if error.isEmpty || error.hasPrefix("No key pressed") { return .timedOut }
        return .refused(error)
    }

    /// The note under the key row, if any.
    public var note: String? {
        switch self {
        case .picked, .cancelled: nil
        case .timedOut: "No key was pressed. Click Pick another key to try again."
        case .refused(let why): why
        }
    }
}
