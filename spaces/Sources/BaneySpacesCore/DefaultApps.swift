import Foundation

// Which app does each job: one answer for the keys, the launcher, the bar, the CLI and agents. Pure: what is installed
// and what macOS says come in through `InstalledApps`, so the tests decide both. spec/default-apps.md.

/// A job an app does for you.
public enum AppRole: String, CaseIterable, Codable, Sendable {
    case agent, browser, terminal, editor, files, mail, messages, calendar, notes, music, video, passwords

    public var title: String {
        switch self {
        case .agent: "AI agent"
        case .files: "File manager"
        default: rawValue.prefix(1).uppercased() + rawValue.dropFirst()
        }
    }

    /// What macOS itself keeps a default for, or nil where it keeps none.
    public var systemQuestion: SystemQuestion? {
        switch self {
        case .browser: .scheme("http")
        case .mail: .scheme("mailto")
        case .calendar: .scheme("webcal")
        case .editor: .type("public.plain-text")
        case .files: .type("public.folder")
        case .terminal: .type("public.unix-executable")
        // Movies have no one default on macOS, only one per file type: the catalog's order decides, QuickTime last.
        case .agent, .messages, .notes, .music, .video, .passwords: nil
        }
    }

    /// Opening a page or a letter is the whole Mac's business, so these two can be set for it too.
    public var canSetEverywhere: Bool { self == .browser || self == .mail }

    /// Polycarp picks no agent for you: opening one can cost you money, so the first use asks.
    public var asksWhenUnset: Bool { self == .agent }

    public enum SystemQuestion: Hashable, Sendable { case scheme(String), type(String) }
}

/// Who does a job: an app by its bundle identifier, or a program in a terminal by its id in the catalog.
public enum DefaultApp: Hashable, Sendable {
    case app(String), command(String)

    /// The spelling in the config file and the CLI.
    public var id: String {
        switch self { case let .app(b): b; case let .command(c): c }
    }

    /// Reads `id` back for `role`. A program is one the catalog names for that job, so nothing written in a file is
    /// ever run; anything with a dot and only a bundle identifier's characters is an app.
    public init?(id: String, role: AppRole) {
        if DefaultAppCatalog.command(id, for: role) != nil { self = .command(id); return }
        guard id.contains("."), !id.hasPrefix("."), !id.hasSuffix("."), id.utf8.count <= 255,
              id.utf8.allSatisfy(DefaultApp.bundleCharacters.contains) else { return nil }
        self = DefaultApp.app(bundle: id, for: role)
    }

    /// An app spelled as the catalog spells it. macOS reads a bundle identifier in any case, so every spelling is one app.
    static func app(bundle: String, for role: AppRole) -> DefaultApp {
        DefaultAppCatalog.entries(role).map(\.app).first { $0 == .app($0.id) && $0.id.lowercased() == bundle.lowercased() } ?? .app(bundle)
    }

    private static let bundleCharacters = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.".utf8)
}

/// What this Mac has, as the resolver asks it. The app answers from Launch Services and the disk; tests answer from a
/// table. No answer may run a program.
public protocol InstalledApps {
    /// The app's name when it is installed, else nil.
    func appName(_ bundle: String) -> String?
    /// The app macOS opens this with now.
    func systemDefault(_ question: AppRole.SystemQuestion) -> String?
    /// Where the first of these program names is, else nil.
    func commandPath(_ names: [String]) -> String?
}

/// One app or program that can do a job and is installed.
public struct DefaultCandidate: Equatable, Sendable {
    public let app: DefaultApp
    public let name: String
    /// The program's path, for a program.
    public let path: String?
    /// What it can't do, in one line, or nil.
    public let note: String?
}

public struct ResolvedDefault: Equatable, Sendable {
    public enum Source: String, Sendable {
        case you, system = "macos", firstInstalled = "first_installed", none

        public var said: String {
            switch self {
            case .you: "You chose it"
            case .system: "macOS's default"
            case .firstInstalled: "First one installed"
            case .none: "Not chosen"
            }
        }
    }

    public let role: AppRole
    public let app: DefaultCandidate?
    public let source: Source
    /// Your choice, when it isn't installed now. It stays your choice: install it again and it is back.
    public let gone: DefaultApp?
    public let candidates: [DefaultCandidate]

    /// One line for the row under the name.
    public var said: String {
        guard let gone else { return source.said }
        let then = app.map { "Using \($0.name) until it is back." } ?? "Nothing is chosen until it is back."
        return "\(DefaultAppCatalog.name(gone, for: role)) isn't installed. \(then)"
    }
}

public enum DefaultAppResolver {
    /// Your choice if it is installed, then macOS's own default for the job, then the first of the catalog that is
    /// installed. A choice that is gone falls through and is kept.
    public static func resolve(_ role: AppRole, choice: DefaultApp?, installed: InstalledApps) -> ResolvedDefault {
        let system = systemDefault(role, installed)
        var list = DefaultAppCatalog.entries(role).compactMap { candidate($0.app, role, installed) }
        for extra in [system, choice.flatMap { candidate($0, role, installed) }] {
            if let extra, !list.contains(where: { $0.app == extra.app }) { list.append(extra) }
        }
        let mine = choice.flatMap { c in list.first { $0.app == c } }
        let gone = mine == nil ? choice : nil
        func answer(_ c: DefaultCandidate?, _ s: ResolvedDefault.Source) -> ResolvedDefault {
            ResolvedDefault(role: role, app: c, source: s, gone: gone, candidates: list)
        }
        if let mine { return answer(mine, .you) }
        if role.asksWhenUnset { return answer(nil, .none) }
        if let system { return answer(system, .system) }
        if let first = list.first { return answer(first, .firstInstalled) }
        return answer(nil, .none)
    }

    /// The terminal a program opens in: yours when it can be told what to run, else the first installed one that can.
    /// nil only where no such terminal is installed, which no Mac is: Terminal is part of macOS.
    public static func terminalForCommands(choice: DefaultApp?, installed: InstalledApps) -> DefaultCandidate? {
        let r = resolve(.terminal, choice: choice, installed: installed)
        return ([r.app].compactMap { $0 } + r.candidates).first { DefaultAppCatalog.runsCommands.contains($0.app.id) }
    }

    /// The app or program, or nil when it isn't installed or can't do this job.
    public static func candidate(_ app: DefaultApp, _ role: AppRole, _ installed: InstalledApps) -> DefaultCandidate? {
        switch app {
        case let .app(bundle):
            guard let name = installed.appName(bundle) else { return nil }
            return DefaultCandidate(app: app, name: name, path: nil, note: DefaultAppCatalog.note(bundle, for: role))
        case let .command(id):
            guard let c = DefaultAppCatalog.command(id, for: role), let path = installed.commandPath(c.programs) else { return nil }
            return DefaultCandidate(app: app, name: c.name, path: path, note: nil)
        }
    }

    /// macOS's answer, when it is an app that is installed. Terminal opens programs (what iTerm2 and Ghostty's own
    /// "default terminal" menu items change) on every Mac until someone moves them, so Terminal there says nothing about
    /// what you'd rather use; nor does an app the catalog doesn't know as a terminal.
    public static func systemDefault(_ role: AppRole, _ installed: InstalledApps) -> DefaultCandidate? {
        guard let q = role.systemQuestion, let bundle = installed.systemDefault(q) else { return nil }
        let app = DefaultApp.app(bundle: bundle, for: role)
        if role == .terminal, app.id == TerminalChoice.terminal || !DefaultAppCatalog.entries(.terminal).contains(where: { $0.app == app }) {
            return nil
        }
        return candidate(app, role, installed)
    }
}
