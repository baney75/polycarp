import Foundation

/// What the voice core reports (core/ffi `pc_status`) and takes (`pc_settings_set`), as Swift types. Plain data, so the
/// words and decisions are tested without the library or AppKit. Ported from voice/src: tray.rs (menu text), core.rs
/// (`overlay_status`), overlay.ts (what the pill shows).
public enum VoiceStatus: String, Codable, Sendable {
    case loading, needsModel = "needs_model", ready, recording, transcribing, typing, error

    /// The menu bar line, as the Tauri tray words it.
    public func menuLine(hotkeyLabel: String, detail: String? = nil) -> String {
        // An error says why and what to do (the core words it with the host's product name).
        if self == .error, let detail, !detail.isEmpty { return detail }
        return switch self {
        case .loading: "Loading model…"
        case .needsModel: "Choose a speech model"
        case .ready: "Ready · hold \(hotkeyLabel) to speak"
        case .recording: "Listening…"
        case .transcribing, .typing: "Writing…"
        case .error: "Needs attention"
        }
    }

    /// The overlay is up for these (`overlay_status` in core.rs).
    public var showsOverlay: Bool { self == .recording || self == .transcribing || self == .typing }
    /// Listening, transcribing or typing: the updater must not restart the app now.
    public var isDictating: Bool { showsOverlay }
    /// The menu bar mark is the "live" one only while listening.
    public var isLive: Bool { self == .recording }
}

public struct VoiceState: Codable, Equatable, Sendable {
    public var status: VoiceStatus
    public var detail: String?
    public var model: String?
    public var hotkey: String
    public var hotkeyLabel: String
    public var enabled: Bool
    public var listener: Bool
}

/// `Settings` in core/voice/src/store.rs. Keys are camelCase on the wire.
public struct VoiceSettings: Codable, Equatable, Sendable {
    public var hotkey: String
    public var hotkeyFallback: String?
    public var tapToToggle: Bool
    public var model: String
    public var modelSource: String
    public var language: String
    public var removeFillers: Bool
    public var trailingSpace: Bool
    public var typingSpeed: String
    public var newlineAsShiftEnter: Bool
    public var learnFromEdits: Bool
    public var sounds: Bool
    public var showOverlay: Bool
    public var launchAtLogin: Bool
    public var microphone: String?
    public var onboarded: Bool
    public var updateChannel: String
    public var autoUpdate: Bool
}

public struct VoiceModel: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var tier: String
    public var tagline: String
    public var sizeMb: Int
    public var languages: String
    public var installed: Bool
    public var active: Bool
    public var recommended: Bool
}

public struct VoiceDictionary: Codable, Equatable, Sendable {
    public struct Term: Codable, Equatable, Sendable { public var text: String }
    public struct Correction: Codable, Equatable, Sendable { public var from: String; public var to: String }
    public var terms: [Term]
    public var corrections: [Correction]
}

public struct VoiceHistoryItem: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var ts: String
    public var text: String
    public var corrected: String?
    public var words: Int
    public var latencyMs: Int
    /// What was typed, after any fix made in History.
    public var shown: String { corrected ?? text }
}

/// The keys offered as presets in Settings; anything else is picked by pressing it (`pc_hotkey_capture`).
public enum VoiceHotkeys {
    public static let presets = ["Dictation", "CmdRight", "OptRight", "CtrlRight", "Fn"]
}
