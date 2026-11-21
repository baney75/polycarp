import Foundation

// The launcher's provider seam. A provider answers what was typed with rows; the app draws them and
// does what each row's action says. Providers hold no AppKit and no closures, so each is tested on its
// own and a new one is one file plus one line in `LauncherProviders.standard`.

/// What a provided row does when it is chosen. The app turns each case into the real thing.
public enum LauncherAction: Equatable, Sendable {
    /// Put the text on the pasteboard and close.
    case copy(String)
    case open(URL)
    /// A terminal in Polycarp's own window (`TerminalLaunch`).
    case terminal(TerminalLaunch)
    /// Nothing to do (a heading or a note).
    case none
}

/// One row a provider offers.
public struct LauncherResult: Equatable, Sendable {
    /// Where the row goes among the launcher's own rows. `top` is for a row that is plainly what was
    /// meant (`12*7` is a sum, not an app); everything else goes after apps and sessions.
    public enum Placement: Sendable { case top, normal }

    public var id: String
    public var section: String
    public var title: String
    public var subtitle: String
    /// An SF Symbol name.
    public var symbol: String
    /// Shown at the right of the row, such as "⇥" or "Copy".
    public var badge: String
    public var placement: Placement
    public var action: LauncherAction

    public init(id: String, section: String, title: String, subtitle: String = "", symbol: String,
                badge: String = "", placement: Placement = .normal, action: LauncherAction) {
        self.id = id
        self.section = section
        self.title = title
        self.subtitle = subtitle
        self.symbol = symbol
        self.badge = badge
        self.placement = placement
        self.action = action
    }
}

/// A source of launcher rows. `results(for:)` runs on the main thread on every keystroke, so it
/// must answer from memory in well under a millisecond; anything slower loads ahead of time.
public protocol LauncherProvider: AnyObject {
    /// A short stable name, used in row ids and traces.
    var name: String { get }
    /// Rows for what's typed in the main search. Empty for an empty query is fine.
    func results(for query: String) -> [LauncherResult]
}

public enum LauncherProviders {
    /// Every provider's rows for a query, `top` ones first, each group in provider order.
    public static func results(_ providers: [LauncherProvider], for query: String) -> (top: [LauncherResult], normal: [LauncherResult]) {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else { return ([], []) }
        var top: [LauncherResult] = []
        var normal: [LauncherResult] = []
        for p in providers {
            for r in p.results(for: query) {
                if r.placement == .top { top.append(r) } else { normal.append(r) }
            }
        }
        return (top, normal)
    }

    /// The providers the launcher starts with, in the order their rows show.
    public static func standard() -> [LauncherProvider] {
        [CalculatorProvider(), TerminalProvider()]
    }
}
