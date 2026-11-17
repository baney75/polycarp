import Foundation

/// Window and workspace commands as launcher rows: `move 3` sends the window you were in to workspace 3
/// (and goes with it, as ⌘⇧3 does), `switch 4` goes to workspace 4, `fill` fills the screen with it.
public final class WindowCommandProvider: LauncherProvider {
    public let name = "windows"

    /// A window action the app runs by name (`LauncherAction.windowCommand`).
    public struct Command: Equatable, Sendable {
        public let id: String
        public let title: String
        public let subtitle: String
        public let symbol: String
        /// Words that find it besides its title.
        public let words: [String]

        public init(id: String, title: String, subtitle: String, symbol: String, words: [String]) {
            self.id = id
            self.title = title
            self.subtitle = subtitle
            self.symbol = symbol
            self.words = words
        }
    }

    /// The window actions there are today. The window-actions builder's verbs (halves, thirds, center)
    /// join this list when they land; the app routes each id in `LauncherActions.windowCommand`.
    public static let commands = [
        Command(id: "fill", title: "Fill the Screen with This Window", subtitle: "Again puts it back · ⌃⌘F",
                symbol: "arrow.up.left.and.arrow.down.right", words: ["fill", "maximize", "full screen", "zoom"]),
    ]

    private let workspaces: ClosedRange<Int>

    public init(workspaces: ClosedRange<Int> = 1...9) { self.workspaces = workspaces }

    /// The verbs that take a workspace number, and what they do.
    private static let moveWords = ["move window to", "move to", "move", "send to", "send", "mv"]
    /// "workspace 3" and "3" already find the launcher's own Workspace rows.
    private static let switchWords = ["switch to", "switch", "go to"]

    public func results(for query: String) -> [LauncherResult] {
        let q = Fuzzy.fold(query).replacingOccurrences(of: "  ", with: " ")
        guard !q.isEmpty else { return [] }
        if let (verb, rest) = Self.split(q, Self.moveWords) {
            if let n = Int(rest), workspaces.contains(n) { return [move(n, placement: .top)] }
            if rest.isEmpty, verb != "mv" { return workspaces.map { move($0, placement: .normal) } }
        }
        if let (_, rest) = Self.split(q, Self.switchWords), let n = Int(rest), workspaces.contains(n) {
            return [LauncherResult(id: "win:switch:\(n)", section: "Workspaces", title: "Switch to Workspace \(n)",
                                   subtitle: "⌘\(n)", symbol: "\(n).square", placement: .top, action: .switchWorkspace(n))]
        }
        return Self.commands.compactMap { c in
            let best = ([c.title] + c.words).compactMap { Fuzzy.score(q, $0) }.max() ?? 0
            guard q.count >= 2, best >= 500 else { return nil }
            return LauncherResult(id: "win:\(c.id)", section: "Window", title: c.title, subtitle: c.subtitle, symbol: c.symbol,
                                  placement: best >= 900 ? .top : .normal, action: .windowCommand(c.id))
        }
    }

    private func move(_ n: Int, placement: LauncherResult.Placement) -> LauncherResult {
        LauncherResult(id: "win:move:\(n)", section: "Window", title: "Move Window to Workspace \(n)",
                       subtitle: "The window you were in goes there, and so do you · ⌘⇧\(n)",
                       symbol: "macwindow.badge.plus", placement: placement, action: .moveWindow(n))
    }

    /// "move 3" is ("move", "3"); "move" alone is ("move", ""). The longest verb that fits wins.
    static func split(_ q: String, _ verbs: [String]) -> (String, String)? {
        for v in verbs.sorted(by: { $0.count > $1.count }) {
            if q == v { return (v, "") }
            if q.hasPrefix(v + " ") { return (v, String(q.dropFirst(v.count + 1)).trimmingCharacters(in: .whitespaces)) }
            // "ws3", "mv3"
            if q.hasPrefix(v), let n = Int(q.dropFirst(v.count)), n > 0 { return (v, String(n)) }
        }
        return nil
    }
}
