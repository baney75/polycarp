import Foundation

/// The player's keys (spec/player.md, R-P3). Pure: the app turns its key event into a `PlayerKey`, and this says what
/// it does for the kind of file in front. Any key it doesn't name passes on, so ⌘Tab, ⌘Q and Polycarp's own keys
/// still work over the player.
public enum PlayerKey: Equatable, Sendable {
    case space, left, right, up, down, escape
    /// A printable key, lowercased: "f", "i".
    case character(Character)
}

public struct PlayerModifiers: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let command = PlayerModifiers(rawValue: 1)
    public static let shift = PlayerModifiers(rawValue: 2)
    public static let option = PlayerModifiers(rawValue: 4)
    public static let control = PlayerModifiers(rawValue: 8)
}

public enum PlayerCommand: Equatable, Sendable {
    case togglePlay
    /// Seconds forward (or back, when negative).
    case seek(Double)
    /// To the next (1) or previous (-1) file in the folder.
    case step(Int)
    /// Volume up or down by this much (0 to 1 scale).
    case volume(Double)
    /// Fill the screen, or come back from it.
    case toggleFill
    case close
    /// Show or hide the file's details.
    case info
}

public enum PlayerKeys {
    public static let seek = 5.0
    public static let longSeek = 30.0
    public static let volumeStep = 0.1

    public static func command(_ key: PlayerKey, _ mods: PlayerModifiers = [], kind: MediaKind) -> PlayerCommand? {
        // Control and Option chords belong to macOS and other apps.
        if !mods.isDisjoint(with: [.control, .option]) { return nil }
        if mods.contains(.command) {
            switch key {
            case .character("i"): return .info
            case .character("w"): return .close
            case .left: return .step(-1)
            case .right: return .step(1)
            default: return nil
            }
        }
        switch key {
        case .escape: return .close
        case .character("f"): return .toggleFill
        case .space: return kind.timed ? .togglePlay : nil
        case .left, .right:
            let dir: Double = key == .left ? -1 : 1
            if !kind.timed { return .step(Int(dir)) }
            return .seek(dir * (mods.contains(.shift) ? longSeek : seek))
        case .up: return kind.timed ? .volume(volumeStep) : nil
        case .down: return kind.timed ? .volume(-volumeStep) : nil
        default: return nil
        }
    }
}
