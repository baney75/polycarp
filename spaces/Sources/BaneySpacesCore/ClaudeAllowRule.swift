import Foundation

/// "Always allow" for Claude Code: one rule in its user settings, so its prompt for Polycarp's tools stops. Plain data in and
/// out, so it can be tested. Settings > Agents writes it after a click, and the helper's `claude-allow on` asks at a terminal:
/// an agent with a shell can't wave its own prompts away.
public enum ClaudeAllowRule {
    public static let rule = "mcp__polycarp"

    public static func isOn(_ data: Data?) -> Bool {
        guard let data, let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let allow = (root["permissions"] as? [String: Any])?["allow"] as? [Any] else { return false }
        return allow.contains { ($0 as? String) == rule }
    }

    /// The settings with the rule added or taken out, everything else kept. Nil for a file that isn't a JSON object: it's left alone.
    public static func applied(_ on: Bool, to data: Data?) -> Data? {
        var root: [String: Any] = [:]
        if let data, !data.isEmpty {
            guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            root = parsed
        }
        var permissions = root["permissions"] as? [String: Any] ?? [:]
        var allow = permissions["allow"] as? [Any] ?? []
        allow.removeAll { ($0 as? String) == rule || ($0 as? String) == rule + "__*" }
        if on { allow.append(rule) }
        permissions["allow"] = allow
        root["permissions"] = permissions
        return try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    }
}
