import Foundation

// The launcher's provider seam. A provider answers what was typed with rows; the app draws them and
// does what each row's action says. Providers hold no AppKit and no closures, so each is tested on its
// own and a new one is one file plus one line in `LauncherProviders.standard`.

/// What a provided row does when it is chosen. The app turns each case into the real thing.
public enum LauncherAction: Equatable, Sendable {
    /// Put the text on the pasteboard and close.
    case copy(String)
    case open(URL)
    /// Nothing to do (a heading or a note).
    case none
    /// One of the provider's own commands (`LauncherMenuProvider.perform`), such as Clear History.
    case command(provider: String, id: String)
    /// Close the launcher.
    case close
    /// Put the text on the pasteboard (marked transient, so clipboard history skips it) and paste it into
    /// the app you were in.
    case paste(String)
    case switchWorkspace(Int)
    /// Move the window you were in to a workspace and go with it, as ⌘⇧N does.
    case moveWindow(Int)
    /// A window action by name (`WindowCommandProvider.commands`).
    case windowCommand(String)
    /// Run a launcher extension on what's typed (`ExtensionProvider.run`); its output becomes the top rows.
    case runExtension(query: String)
    /// Put this text in the main search, as Tab on a menu row does.
    case fill(String)
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
    /// A yes-or-no question asked before the action runs, for a row that deletes something.
    public var confirm: String?
    public var action: LauncherAction

    public init(id: String, section: String, title: String, subtitle: String = "", symbol: String,
                badge: String = "", placement: Placement = .normal, confirm: String? = nil, action: LauncherAction) {
        self.id = id
        self.section = section
        self.title = title
        self.subtitle = subtitle
        self.symbol = symbol
        self.badge = badge
        self.placement = placement
        self.confirm = confirm
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

/// A provider with a menu of its own in the launcher, listed in the root menu like Apps or Files.
public protocol LauncherMenuProvider: LauncherProvider {
    /// The menu's id: the launcher scope it fills, and the `launcher/<menu>` link that opens it.
    var menu: String { get }
    /// The menu was opened.
    func opened()
    /// The menu's rows for what's typed in it.
    func listing(_ query: String) -> [LauncherResult]
    /// Runs one of its `.command` rows. Nil keeps the menu open and lists it again; an action is done next.
    func perform(_ command: String) -> LauncherAction?
}

public enum LauncherProviders {
    /// The provider that fills a menu.
    public static func menu(_ providers: [LauncherProvider], _ menu: String) -> LauncherMenuProvider? {
        providers.lazy.compactMap { $0 as? LauncherMenuProvider }.first { $0.menu == menu }
    }

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
    public static func standard(env: [String: String] = ProcessInfo.processInfo.environment) -> [LauncherProvider] {
        var out: [LauncherProvider] = [CalculatorProvider()]
        if let file = SnippetStore.defaultFile(env: env) { out.append(SnippetProvider(store: SnippetStore(file: file))) }
        out.append(WindowCommandProvider())
        if let folder = LauncherExtensionStore.defaultFolder(env: env) { out.append(ExtensionProvider(store: LauncherExtensionStore(folder: folder))) }
        return out
    }
}
