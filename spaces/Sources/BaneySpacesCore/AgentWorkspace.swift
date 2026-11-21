import Foundation

/// The agent workspace: one workspace for agents' apps (Tychicus drives them; Polycarp only places
/// their windows) while you work somewhere else. Three rules keep it from ever taking over your screen:
///
/// 1. Its apps are parked out of view instead of hidden, because macOS refuses background clicks
///    and keystrokes to a hidden app.
/// 2. Something on it coming to the front (an agent's click falling back to the foreground, an
///    app stealing focus) never takes you there. You go there yourself: its number key, its Dock
///    tile, or a row in the launcher.
/// 3. A window an agent opens in the background joins the agent workspace, not yours.
public enum AgentWorkspace {
    /// What `polycarp-spaces sandbox ...` prints (on stderr, exit 2): the throwaway macOS VM for agent work is Tychicus's now
    /// (Donovan, 2026-11-21). Nothing runs and nothing is written.
    public static let sandboxMoved = "The sandbox is now Tychicus: https://github.com/baney75/tychicus"

    /// The workspace number, or nil when it's off.
    public static func number(setting: Int) -> Int? { Workspaces.range.contains(setting) ? setting : nil }

    /// Apps with any window on the agent workspace: parked, never hidden.
    public static func parkedApps(owners: [WindowID: Int32], home: [WindowID: Int], agent: Int?) -> Set<Int32> {
        guard let agent else { return [] }
        return Set(owners.compactMap { id, pid in home[id] == agent ? pid : nil })
    }

    /// Whether an app coming to the front may take you to workspace `n`.
    public static func mayFollow(to n: Int, current: Int, agent: Int?) -> Bool {
        guard let agent else { return true }
        return n != agent || current == agent
    }

    /// Where a window that just opened belongs. `appFront` is whether its app is in front (you
    /// clicked a link, pressed its New Window key); `claimed` is a workspace asked for
    /// for the window when it opened. Nil leaves it where macOS put it.
    public static func homeForNewWindow(appFront: Bool, appWorkspaces: Set<Int>, claimed: Int?, current: Int, agent: Int?) -> Int? {
        if let claimed { return claimed }
        // An app with windows here too keeps opening them here, as it always has.
        guard let agent, current != agent, !appFront, appWorkspaces.contains(agent), !appWorkspaces.contains(current) else { return nil }
        // Opened in the background by an app that lives on the agent workspace: an agent did it.
        return agent
    }
}
