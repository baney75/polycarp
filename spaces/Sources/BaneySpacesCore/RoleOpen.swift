import Foundation

// Opening a job's app: what a key, the launcher or `polycarp-spaces open terminal` asks for, and what is done about it.
// Pure, so the rules are tested without an app. spec/default-apps.md R-D11.

public struct RoleRequest: Equatable, Sendable {
    public let role: AppRole
    /// A new window even when one is open.
    public let new: Bool
    /// What to ask the agent, as one argument. Only the agent takes one.
    public let prompt: String?
    /// Where it opens. Only for `takesFolder`.
    public let folder: String?

    public init(role: AppRole, new: Bool = false, prompt: String? = nil, folder: String? = nil) {
        self.role = role; self.new = new; self.prompt = prompt; self.folder = folder
    }

    public static let usage = "open <role> [--new] [--in DIR] [--prompt TEXT]"

    /// The words after `open`. Nil when they name no role: an address, as `open` took before there were roles.
    public static func parse(_ words: [String], cwd: String) -> Result<RoleRequest, SurfacesFailure>? {
        guard let role = words.first.flatMap(AppRole.init(rawValue:)) else { return nil }
        func bad(_ line: String) -> Result<RoleRequest, SurfacesFailure> {
            .failure(SurfacesFailure("invalid_args", line, suggestion: "usage: polycarp-spaces \(usage)", exit: 2))
        }
        var new = false, prompt: String?, folder: String?
        var rest = words.dropFirst()
        while let word = rest.popFirst() {
            // The word after --prompt is the prompt whatever it looks like: it is never read as an option.
            func value(_ name: String) -> String? {
                if word.hasPrefix(name + "=") { return String(word.dropFirst(name.count + 1)) }
                return word == name ? rest.popFirst() : nil
            }
            if word == "--new" { new = true; continue }
            if word == "--prompt" || word.hasPrefix("--prompt=") {
                guard role == .agent else { return bad("only the agent takes a prompt") }
                guard let p = value("--prompt"), !p.isEmpty else { return bad("--prompt needs the text") }
                prompt = p
            } else if word == "--in" || word.hasPrefix("--in=") {
                guard role.takesFolder else { return bad("\(role.rawValue) doesn't open in a folder") }
                guard let d = value("--in"), !d.isEmpty else { return bad("--in needs a folder") }
                folder = URL(fileURLWithPath: d, relativeTo: URL(fileURLWithPath: cwd, isDirectory: true)).standardizedFileURL.path
            } else {
                return bad("\(word) is no option of open \(role.rawValue)")
            }
        }
        return .success(RoleRequest(role: role, new: new, prompt: prompt, folder: folder))
    }
}

public extension AppRole {
    var takesFolder: Bool { [.agent, .terminal, .editor, .files].contains(self) }
}

public enum RoleStep: Equatable, Sendable {
    /// Its newest window on this workspace, else on the nearest one: you go to it, it is never brought here.
    case goTo
    /// Running, and a new window is wanted or it has none.
    case newWindow
    case launch
    /// The app opens the folder.
    case openFolder(String)
    /// A new window of the terminal, at a folder when one was asked for.
    case terminalWindow
    /// A program, in a terminal.
    case program(id: String, path: String)
    /// Nobody was chosen, and choosing is yours.
    case ask
    /// Nothing can do it, and why.
    case nothing(String)

    public static func of(_ r: RoleRequest, _ resolved: ResolvedDefault, running: Bool, hasWindow: Bool) -> RoleStep {
        guard let app = resolved.app else {
            if r.role.asksWhenUnset { return .ask }
            return .nothing("No app for \(r.role.title.lowercased()) is installed")
        }
        if case .command(let id) = app.app {
            return app.path.map { .program(id: id, path: $0) } ?? .nothing("\(app.name) isn't installed")
        }
        if r.role == .terminal, r.new || r.folder != nil || (running && !hasWindow) { return .terminalWindow }
        if let folder = r.folder, r.role != .agent { return .openFolder(folder) }
        if !running { return .launch }
        return r.new || !hasWindow ? .newWindow : .goTo
    }

    /// For the log and the CLI's answer.
    public var name: String {
        switch self {
        case .goTo: "went to it"
        case .newWindow, .terminalWindow: "opened a window"
        case .launch: "opened it"
        case .openFolder: "opened the folder"
        case .program: "opened it in a terminal"
        case .ask: "asked"
        case .nothing: "nothing"
        }
    }
}
