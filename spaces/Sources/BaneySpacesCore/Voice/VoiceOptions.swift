import Foundation

/// The choices Settings > Silas offers beyond the switches, worded as the Silas app words them (voice/src/settings.ts),
/// and the menu bar's Start dictation item. Plain data, tested without SwiftUI.
public enum VoiceOptions {
    public struct Choice: Equatable, Sendable, Identifiable {
        /// nil is "System default" for the microphone.
        public var value: String?
        public var label: String
        public var id: String { value ?? "" }
        public init(_ value: String?, _ label: String) { self.value = value; self.label = label }
    }

    /// `typingSpeed` values the core knows (typer.rs `Pace::from_setting`): about 250, 700 and 2000 characters a second.
    public static let speeds = [Choice("steady", "Steady"), Choice("fast", "Fast"), Choice("instant", "Instant")]
    public static let speedHelp = "Pick Steady if an app drops or jumbles letters. Instant suits fast editors."

    /// The languages Cohere takes (Parakeet finds the language on its own).
    public static let languages = [Choice("en", "English"), Choice("es", "Spanish"), Choice("fr", "French"), Choice("de", "German"),
                                   Choice("it", "Italian"), Choice("pt", "Portuguese"), Choice("nl", "Dutch"), Choice("pl", "Polish")]
    public static let languageHelp = "Parakeet finds the language on its own. Cohere uses this one."

    /// System default, each connected microphone, and the chosen one if it is unplugged, so the picker never shows blank.
    public static func microphones(_ names: [String], current: String?) -> [Choice] {
        var out = [Choice(nil, "System default")] + names.map { Choice($0, $0) }
        if let c = current, !c.isEmpty, !names.contains(c) { out.append(Choice(c, "\(c) (not connected)")) }
        return out
    }

    /// Learning reads your fix back by key codes, which only map to letters on a U.S. layout (focus.rs `us_layout`).
    public static let learnHelp = "When you fix a word right after it is typed, Silas remembers. Works only with the U.S. or ABC keyboard layout."
    public static let shiftReturnHelp = "So chat boxes don't send your message early."
    public static let trailingSpaceHelp = "Ready for the next sentence."

    /// What an import says (`pc_dictionary_import`).
    public static func imported(before: Int, after: Int) -> String {
        let added = after - before
        if added <= 0 { return "Imported. Everything was already here." }
        return added == 1 ? "Imported 1 entry." : "Imported \(added) entries."
    }

    /// The menu bar item that starts or stops dictation, or nil when a click couldn't do either.
    public static func menuToggle(status: VoiceStatus, enabled: Bool, listener: Bool) -> String? {
        guard enabled, listener else { return nil }
        return switch status {
        case .ready, .error: "Start Dictation"
        case .recording: "Stop Dictation"
        case .loading, .needsModel, .transcribing, .typing: nil
        }
    }
}
