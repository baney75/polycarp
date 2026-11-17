import Foundation

/// Apps Donovan lets agents open on the agent workspace, beyond the built-in ones: `<config>/agent-apps.toml`
/// (`~/.config/polycarp/agent-apps.toml`), one line:
///
///     apps = ["com.apple.grapher", "org.videolan.vlc"]
///
/// Each listed app starts as a separate copy that restores nothing it saved (`open -n`, persistence ignored), and only
/// its windows on the agent workspace are an agent's, as with TextEdit. A kind `AgentAppPolicy` refuses (browsers,
/// password managers, settings and shells, apps that run code, apps with his own data, Polycarp itself) can't be listed:
/// such an entry is skipped and named in `problems`. The file is read on every `agent open`, so an edit counts at once.
public struct AgentAppList: Equatable, Sendable {
    public var apps: Set<String> = []
    public var problems: [String] = []

    public init(apps: Set<String> = [], problems: [String] = []) {
        self.apps = apps
        self.problems = problems
    }

    public static let name = "agent-apps.toml"

    public static func path(env: [String: String] = ProcessInfo.processInfo.environment,
                            home: String? = FileManager.default.homeDirectoryForCurrentUser.path) -> String? {
        PolycarpThemeFile.configDir(env: { env[$0] }, home: env["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? home)
            .map { $0 + "/" + name }
    }

    /// The list in the file at `path`; empty when there is none.
    public static func load(path: String? = path()) -> AgentAppList {
        guard let path, let data = FileManager.default.contents(atPath: path) else { return AgentAppList() }
        return parse(String(decoding: data, as: UTF8.self))
    }

    /// Reads `apps = [ "id", ... ]`, which may span lines; `#` starts a comment. Anything else in the file is ignored.
    public static func parse(_ text: String) -> AgentAppList {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> Substring in
            line.firstIndex(of: "#").map { line[..<$0] } ?? line[...]
        }
        let body = lines.joined(separator: "\n")
        guard let key = body.range(of: #"(?m)^\s*apps\s*=\s*\["#, options: .regularExpression) else { return AgentAppList() }
        guard let close = body[key.upperBound...].firstIndex(of: "]") else {
            return AgentAppList(problems: ["apps: the list has no closing ]"])
        }
        var list = AgentAppList()
        for item in body[key.upperBound..<close].split(separator: ",") {
            let raw = item.trimmingCharacters(in: .whitespacesAndNewlines)
            if raw.isEmpty { continue }
            guard raw.count >= 2, raw.hasPrefix("\""), raw.hasSuffix("\"") else {
                list.problems.append("\(raw): not a quoted bundle id")
                continue
            }
            let id = String(raw.dropFirst().dropLast())
            guard id.range(of: #"^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$"#, options: .regularExpression) != nil else {
                list.problems.append("\(id): not a bundle id (like com.apple.grapher)")
                continue
            }
            if let why = AgentAppPolicy.neverListed(bundle: id) {
                list.problems.append("\(id): never opened for an agent: \(why)")
                continue
            }
            list.apps.insert(id)
        }
        return list
    }
}
