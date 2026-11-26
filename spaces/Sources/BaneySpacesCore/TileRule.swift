import Foundation

/// One window rule (`tiling.rules`): an app, and optional words of a window's title, that a window floats, tiles, is
/// pinned or goes to a workspace for. Written as one line: `<bundle id> <float|tile|pin|1-9> [title words]`.
public struct TileRule: Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        case float, tile, pin
        case workspace(Int)
    }

    public var bundle: String
    public var action: Action
    /// Words the window's title holds, any case; nil for every window of the app.
    public var title: String?

    public init(bundle: String, action: Action, title: String? = nil) {
        self.bundle = bundle; self.action = action; self.title = title
    }

    /// What is wrong with a line.
    public struct Problem: Error, Equatable, Sendable {
        public let message: String
        init(_ message: String) { self.message = message }
    }

    /// The longest line a rule may be.
    public static let longest = 200

    /// A rule from its line, or what is wrong with the line.
    public static func read(_ line: String) -> Result<TileRule, Problem> {
        let words = line.split(whereSeparator: \.isWhitespace).map(String.init)
        guard line.count <= longest else { return .failure(Problem("is longer than \(longest) characters")) }
        guard words.count >= 2 else { return .failure(Problem("needs an app's bundle id and what to do: float, tile, pin or a workspace 1-9 (as \"com.apple.Notes 3\")")) }
        guard words[0].range(of: SurfaceCheck.bundlePattern, options: .regularExpression) != nil else {
            return .failure(Problem("\"\(words[0])\" is not an app's bundle id (as \"com.apple.Notes\")"))
        }
        let action: Action
        switch words[1] {
        case "float": action = .float
        case "tile": action = .tile
        case "pin": action = .pin
        default:
            guard let n = Int(words[1]), Workspaces.range.contains(n), words[1].count == 1 else {
                return .failure(Problem("\"\(words[1])\" is not float, tile, pin or a workspace 1-9"))
            }
            action = .workspace(n)
        }
        let title = words.dropFirst(2).joined(separator: " ")
        return .success(TileRule(bundle: words[0], action: action, title: title.isEmpty ? nil : title))
    }

    /// The rule as a line, as `read` takes it.
    public var line: String {
        let what: String
        switch action {
        case .float: what = "float"
        case .tile: what = "tile"
        case .pin: what = "pin"
        case .workspace(let n): what = String(n)
        }
        return [bundle, what, title].compactMap { $0 }.joined(separator: " ")
    }

    public func matches(bundle b: String, title t: String) -> Bool {
        guard bundle.caseInsensitiveCompare(b) == .orderedSame else { return false }
        return title.map { t.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil } ?? true
    }
}

/// The rules together. A window's first matching float or tile rule says whether it floats, then the apps listed to float
/// (`tiling.float`), then the small utilities that float unless a rule tiles them. Its first matching pin or workspace
/// rule says where a new window of it goes.
public struct TileRules: Equatable, Sendable {
    /// Small utilities that float unless a rule tiles them.
    public static let builtIn: Set<String> = [
        "com.apple.calculator", "com.apple.Stickies", "com.apple.DigitalColorMeter", "com.apple.archiveutility",
        "com.apple.systempreferences", "com.apple.print.PrinterProxy",
    ]

    public var rules: [TileRule]
    /// Apps whose windows float, by bundle id.
    public var float: Set<String>

    public init(_ rules: [TileRule] = [], float: Set<String> = []) {
        self.rules = rules; self.float = float
    }

    /// The rules of lines that read; the settings check turns away a file with one that doesn't.
    public init(lines: [String], float: Set<String>) {
        self.init(lines.compactMap { try? TileRule.read($0).get() }, float: float)
    }

    public func floats(bundle: String, title: String) -> Bool {
        for r in rules where r.matches(bundle: bundle, title: title) {
            if r.action == .float { return true }
            if r.action == .tile { return false }
        }
        return float.contains(bundle) || Self.builtIn.contains { $0.caseInsensitiveCompare(bundle) == .orderedSame }
    }

    /// Where a new window goes: pinned on every workspace, to a workspace, or nil to stay where it opened.
    public func placement(bundle: String, title: String) -> TileRule.Action? {
        rules.first { r in
            guard r.matches(bundle: bundle, title: title) else { return false }
            if case .workspace = r.action { return true }
            return r.action == .pin
        }?.action
    }

    public enum Placed: Equatable, Sendable { case stay, pin, to(Int) }

    /// What becomes of a new window that opened on `here`. A rule never takes a window to or from the agent workspace, nor
    /// one of an app working there (`agentApp`), nor one that waits on you (`waits`): it stays with its app.
    public func place(bundle: String, title: String, at here: Int, agent: Int?, agentApp: Bool, waits: Bool) -> Placed {
        guard here != agent, !agentApp, !waits, let action = placement(bundle: bundle, title: title) else { return .stay }
        switch action {
        case .pin: return .pin
        case .workspace(let n): return n == here || n == agent ? .stay : .to(n)
        case .float, .tile: return .stay
        }
    }
}
