import Foundation

/// The words Settings puts beside each job. Pure, so what a row says is tested.
public enum DefaultAppsText {
    /// The jobs in the order Settings shows them.
    public static let groups: [(title: String, roles: [AppRole])] = [
        ("Work", [.agent, .terminal, .editor, .files]),
        ("Web and people", [.browser, .mail, .messages, .calendar]),
        ("The rest", [.notes, .music, .passwords]),
    ]

    /// Under a job's name: who decided, and for the browser and mail what the rest of the Mac uses. `system` is macOS's
    /// own answer, where it has one.
    public static func line(_ r: ResolvedDefault, system: DefaultCandidate?) -> String {
        if r.gone != nil { return r.said }
        guard let app = r.app else { return r.role.asksWhenUnset ? "Asks you the first time" : "None is installed" }
        guard r.source == .you, r.role.canSetEverywhere, let system else { return app.note.map { "\(r.source.said). \($0)" } ?? r.source.said }
        return system.app == app.app ? "You chose it, and other apps use it too" : "Polycarp only. Other apps use \(system.name)"
    }

    /// The choice that leaves it to macOS, with what that is.
    public static func automatic(_ role: AppRole, _ r: ResolvedDefault?, system: DefaultCandidate?) -> String {
        if role.asksWhenUnset { return "Ask me" }
        let name = system?.name ?? (r?.source == .you ? nil : r?.app?.name)
        return (system == nil ? "Automatic" : "macOS default") + (name.map { ": \($0)" } ?? "")
    }

    /// One in the list: its name, and what it can't do.
    public static func item(_ c: DefaultCandidate) -> String { c.note.map { "\(c.name) (\($0))" } ?? c.name }
}
