import Foundation

/// What VoiceOver hears from the overlay, and the still meter shown under Reduce Motion. Pure, so both are tested.
public enum VoiceAccess {
    /// Said when dictation moves into a new phase; nil when nothing new happened (typing right after writing is the
    /// same phase). Errors are said through the notice (`VoiceNotice.announcement`).
    public static func announcement(from old: VoiceStatus?, to new: VoiceStatus) -> String? {
        guard old != new else { return nil }
        switch new {
        case .recording: return "Silas, listening"
        case .transcribing: return "Silas, writing"
        case .typing: return old == .transcribing ? nil : "Silas, writing"
        default: return nil
        }
    }

    /// Under Reduce Motion the bars stand still and light from the left with the level, like a meter.
    public static func lit(level: Float, bars: Int) -> Int {
        let shaped = min(1, pow(max(0, level), 0.6) * 1.15)
        return min(bars, Int((shaped * Float(bars)).rounded()))
    }
}
