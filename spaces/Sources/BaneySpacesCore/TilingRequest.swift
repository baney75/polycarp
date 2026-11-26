import Foundation

/// What `polycarp-spaces tile` and the tiling MCP tools ask of the running app, as words.
public enum TilingRequest: Equatable, Sendable {
    case status
    /// Nil is the workspace in use.
    case turn(on: Bool, workspace: Int?)
    case run(TilingCommand)

    public init?(words: [String]) {
        switch words.first {
        case nil: return nil
        case "status":
            guard words.count == 1 else { return nil }
            self = .status
        case "on", "off":
            let n = words.count > 1 ? Int(words[1]) : nil
            guard words.count < 3, words.count == 1 || n.map(Workspaces.range.contains) == true else { return nil }
            self = .turn(on: words[0] == "on", workspace: n)
        default:
            guard let c = TilingCommand(words: words) else { return nil }
            self = .run(c)
        }
    }

    /// Every form it takes, for the usage text and the docs.
    public static var forms: [(form: String, title: String)] {
        var out = [("status", "what tiles, and the windows of the workspace in use"),
                   ("on [1-9]", "tile that workspace, or the one in use"), ("off [1-9]", "stop, and put its windows back")]
        for c in TilingCommand.named { out.append((c.name.replacingOccurrences(of: "-", with: " "), c.title)) }
        return out
    }
}

/// The answer to each of them: how tiling stands after it.
public struct TilingStatus: Codable, Equatable, Sendable {
    /// The workspace in use.
    public var workspace: Int
    public var tiles: Bool
    public var style: String
    public var full: Bool
    /// Its tiled windows in the layout's order, as `agent windows` and `ls` number windows.
    public var windows: [UInt32]
    /// The tiled window in front, if one is.
    public var focused: UInt32?
    /// Every workspace that tiles.
    public var tiling: [Int]

    public init(workspace: Int, tiles: Bool, style: String, full: Bool, windows: [UInt32], focused: UInt32?, tiling: [Int]) {
        (self.workspace, self.tiles, self.style, self.full) = (workspace, tiles, style, full)
        (self.windows, self.focused, self.tiling) = (windows, focused, tiling)
    }

    public var reply: Wire.Reply {
        guard let data = try? JSONEncoder().encode(self) else { return .init(ok: false, error: "couldn't say how tiling stands") }
        return .init(ok: true, info: ["tiling": String(decoding: data, as: UTF8.self)])
    }

    public init?(_ reply: Wire.Reply) {
        guard reply.ok, let text = reply.info?["tiling"], let s = try? JSONDecoder().decode(Self.self, from: Data(text.utf8)) else { return nil }
        self = s
    }

    public var value: SurfaceValue {
        let ids = windows.map { SurfaceValue.number(Double($0)) }, on = tiling.map { SurfaceValue.number(Double($0)) }
        return .object(["workspace": .number(Double(workspace)), "tiles": .bool(tiles), "style": .string(style), "full": .bool(full),
                        "windows": .array(ids), "focused": focused.map { .number(Double($0)) } ?? .null, "tiling": .array(on)])
    }

    public var text: String {
        let here = tiles ? "workspace \(workspace) tiles \(windows.count) window\(windows.count == 1 ? "" : "s"), \(style)\(full ? ", one at full size" : "")"
            : "workspace \(workspace) doesn't tile"
        return tiling.isEmpty ? here : here + "; tiling is on for " + tiling.map(String.init).joined(separator: ", ")
    }
}
