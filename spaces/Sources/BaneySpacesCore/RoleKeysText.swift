import Foundation

/// The words Settings puts beside a job's key, and what a key pressed while it records does. Pure.
public enum RoleKeysText {
    /// Escape, Delete alone, or the chord pressed.
    public enum Press: Equatable, Sendable {
        case cancel, clear, chord(Chord)
        /// No chord: a key that isn't known, or one held with nothing but Shift.
        case needsMore
    }

    public static func press(keyCode: Int, mods: Set<Chord.Mod>) -> Press {
        if mods.isEmpty, keyCode == 53 { return .cancel }
        if mods.isEmpty, keyCode == 51 || keyCode == 117 { return .clear }
        return Chord(keyCode: keyCode, mods: mods).map { .chord($0) } ?? .needsMore
    }

    /// Why `role` can't have `chord`, or nil when it can: somebody has it. `owner` as in `RoleKeys.plan`.
    public static func refusal(_ chord: Chord, _ role: AppRole, _ plan: RoleKeys.Plan, owner: (Chord) -> String?) -> String? {
        // Its own key again, and the window key that is its own with Option, go with it.
        let other = plan.active.first { $0.chord == chord && $0.role != role }
        guard let who = other.map({ "Polycarp, for \(RoleKeys.action($0.role, new: $0.new))" }) ?? owner(chord) else { return nil }
        return "\(chord.display) is taken: \(who)."
    }

    /// The key it has, as Settings shows it, or nil for none.
    public static func key(_ role: AppRole, _ plan: RoleKeys.Plan) -> String? {
        let active = plan.of(role).filter { $0.taken == nil }.map(\.chord.display)
        return active.isEmpty ? nil : active.joined(separator: " ")
    }

    /// Under the job: what its key does, or why it has none.
    public static func line(_ role: AppRole, _ plan: RoleKeys.Plan) -> String {
        if let b = plan.of(role).first(where: { $0.taken != nil && $0.taken != RoleKeys.yoursForNothing }), let who = b.taken {
            return "\(b.chord.display) is taken: \(who)"
        }
        guard key(role, plan) != nil else { return "No key" }
        guard let new = plan.of(role, new: true).first(where: { $0.taken == nil }) else { return "Goes to its window, or opens one" }
        return "Goes to its window, or opens one. \(new.chord.display) always opens one"
    }

    /// What "go back" is called: the key it comes with, or no key.
    public static func standard(_ role: AppRole) -> String {
        RoleKeys.boundByDefault.contains(role) ? "Use \(RoleKeys.suggested(role).display)" : "Use \(RoleKeys.suggested(role).display) (suggested)"
    }

    /// The change that gives it the key "Use …" names.
    public static func suggestion(_ role: AppRole) -> RoleKeysFile.Change {
        RoleKeys.boundByDefault.contains(role) ? .standard : .chord(RoleKeys.suggested(role))
    }
}
