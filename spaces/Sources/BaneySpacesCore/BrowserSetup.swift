import Foundation

/// What Settings > Browser shows, read from the bundled helper's `doctor --json`. The helper owns every check (which browsers
/// are registered, whether the extension is connected, which agents have the MCP entry); this only reads its answer.
public struct BrowserStatus: Equatable {
    public struct Browser: Equatable, Identifiable {
        public var name: String
        /// The native host manifest is in place for this browser, so the extension can reach the helper.
        public var registered: Bool
        public var id: String { name }
    }
    public struct Agent: Equatable, Identifiable {
        public var id: String
        public var name: String
        public var connected: Bool
    }

    public var browsers: [Browser] = []
    public var extensionConnected = false
    public var extensionVersion: String?
    public var agents: [Agent] = []

    public init() {}

    /// The helper's JSON. Nil when it isn't JSON of the shape `doctor --json` prints.
    public static func parse(_ data: Data) -> BrowserStatus? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let checks = root["checks"] as? [[String: Any]] else { return nil }
        var s = BrowserStatus()
        for check in checks {
            guard let id = check["id"] as? String else { continue }
            let ok = (check["status"] as? String) == "ok"
            let label = check["label"] as? String ?? ""
            if id.hasPrefix("host:") {
                s.browsers.append(Browser(name: String(id.dropFirst(5)), registered: ok))
            } else if id == "connected" {
                s.extensionConnected = ok
                if ok, let open = label.firstIndex(of: "("), let close = label.lastIndex(of: ")"), open < close {
                    let v = String(label[label.index(after: open)..<close])
                    s.extensionVersion = v == "unknown version" ? nil : v
                }
            } else if id.hasPrefix("mcp:") {
                let name = label.components(separatedBy: ":").first ?? String(id.dropFirst(4))
                s.agents.append(Agent(id: String(id.dropFirst(4)), name: name, connected: ok))
            }
        }
        return s
    }

    /// "Claude Code" and "Codex" are the two the one button wires up.
    public var addable: [Agent] { agents.filter { ($0.id == "claude" || $0.id == "codex") && !$0.connected } }
}

/// Where the bundled pieces are, and how a browser is opened on its extensions page.
public enum BrowserBundle {
    /// `Polycarp.app/Contents/Resources/browser` for a resources folder.
    public static func folder(resources: URL?) -> URL? { resources?.appendingPathComponent("browser", isDirectory: true) }
    public static func helper(resources: URL?) -> URL? { folder(resources: resources)?.appendingPathComponent("polycarp-browser") }
    public static func extensionFolder(resources: URL?) -> URL? { folder(resources: resources)?.appendingPathComponent("extension", isDirectory: true) }

    /// The app name for each browser the helper reports, as installed in /Applications.
    public static func appName(for browser: String) -> String {
        switch browser {
        case "Chrome": "Google Chrome"
        case "Chrome Beta": "Google Chrome Beta"
        case "Chrome Canary": "Google Chrome Canary"
        case "Brave": "Brave Browser"
        case "Opera": "Opera"
        default: browser
        }
    }

    /// Every Chromium browser takes `chrome://extensions` as an address.
    public static let extensionsAddress = "chrome://extensions"

    /// The environment the helper runs in from the app: the person's own, plus nothing that points at a Node.
    public static func environment(base: [String: String]) -> [String: String] {
        var env = base
        env["NO_COLOR"] = "1"
        return env
    }
}
