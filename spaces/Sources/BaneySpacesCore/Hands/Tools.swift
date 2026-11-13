import Foundation

/// One argument of a hands command. The CLI reads it as a positional word or a `--flag`, MCP as a
/// property of the tool's arguments object; the name is the same in both.
public struct HandsParam: Equatable, Sendable {
    public enum Kind: String, Sendable { case string, integer, boolean, stringList }
    public var name: String
    public var kind: Kind
    public var help: String
    public var required: Bool
    /// Taken from the words after the verb, in order; otherwise `--name value`.
    public var positional: Bool
    /// `-i` for `--interactive`.
    public var short: String?
    /// Takes every remaining positional word (the last parameter only).
    public var rest: Bool

    public init(_ name: String, _ kind: Kind = .string, _ help: String, required: Bool = false, positional: Bool = false, short: String? = nil, rest: Bool = false) {
        self.name = name; self.kind = kind; self.help = help; self.required = required
        self.positional = positional; self.short = short; self.rest = rest
    }
}

public struct HandsTool: Equatable, Sendable {
    /// `snapshot`, `click`, `set-value`: the CLI word. MCP spells the hyphen `_`.
    public var verb: String
    public var summary: String
    public var params: [HandsParam]
    /// Whether it changes anything in an app (all but the readers).
    public var acts: Bool

    public var mcpName: String { verb.replacingOccurrences(of: "-", with: "_") }
}

/// The commands, once, for the CLI parser, the MCP `tools/list` and the app's dispatcher.
public enum HandsTools {
    static let refParam = HandsParam("ref", .string, "A ref like @s8f3k2p9:e5, or a row number from your latest snapshot, like 5.", required: true, positional: true)

    /// Not agent tools: lending an app is Donovan's decision (see `HandsParse.askedForLend`).
    public static let userOnly: Set<String> = ["lend", "return"]

    /// Every action takes it: how long to wait while Donovan is using the app (`InUseRule`, `InUseWait`).
    public static let waitParam = HandsParam("wait", .integer, "Seconds to wait, 0 to \(InUseRule.maxWait) (default \(Int(InUseRule.defaultWait))), when Donovan is using the app; Polycarp waits on its own and goes ahead once the app is free. 0 answers in_use at once.")

    public static let all: [HandsTool] = base.map { t in
        var t = t
        if AgentAccessGate.changes.contains(t.verb) { t.params.append(waitParam) }
        return t
    }

    static let base: [HandsTool] = [
        HandsTool(verb: "windows", summary: "List the windows an agent may use now: those on the agent workspace and those of lent apps, with their ids, plus the dialogs, alerts, sheets and palettes those apps raised (kind, parent, waiting: true when the app is blocked until it is answered). A dialog you may not use is listed with usable: false and the rule that refused it. A window of an app Donovan is using carries in_use: true and in_use_note; reads on it work now, and an action on it waits.", params: [], acts: false),
        HandsTool(verb: "workspaces", summary: "Read only. List the workspaces (number, name, shown or not, which one is the agent workspace) and where each window you may use is. Use it before `move` or `arrange`, or to see whether Donovan is looking at the agent workspace (agent_workspace_shown). Agents never switch, create, rename or delete workspaces.", params: [], acts: false),
        HandsTool(verb: "snapshot", summary: "Read one window, one row per element: [N] role \"name\" =value (states), indented under its parent. Act on row N with ref \"N\" (this snapshot) or the full ref the header shows. After acting, read again with since: \"latest\" to see only what changed. Example: {\"window\":4211,\"query\":\"Save\"}", params: [
            HandsParam("app", .string, "App name or bundle id. With several windows on the agent workspace the newest is read; pass window to choose."),
            HandsParam("window", .integer, "Window id from `windows`, `open` or a previous snapshot."),
            HandsParam("query", .string, "Only rows whose role, name or value has this text (any case; several with |), with their parents."),
            HandsParam("since", .string, "latest: only rows added (+), changed (~) or removed (-) since your last read of this window."),
            HandsParam("max_elements", .integer, "At most this many rows (default \(SnapshotRows.defaultMax)); a last line says how to get the rest. A since read lists every change."),
            HandsParam("format", .string, "rows (default over MCP) or json (the full tree, default on the command line)."),
            HandsParam("interactive", .boolean, "Only elements you can act on.", short: "i"),
            HandsParam("compact", .boolean, "Collapse wrapper groups with no content."),
            HandsParam("depth", .integer, "How deep to read (default 10)."),
            HandsParam("screenshot", .boolean, "Also return a picture of the window (longest side 1280), with how its pixels map to window points."),
            HandsParam("zoom", .string, "With screenshot: only this region, x,y,width,height in window points, like \"0,0,400,300\"."),
        ], acts: false),
        HandsTool(verb: "find", summary: "Search one window's accessibility tree and return the matching elements with refs.", params: [
            HandsParam("app", .string, "App name or bundle id."),
            HandsParam("window", .integer, "Window id."),
            HandsParam("role", .string, "Role, like button or textfield."),
            HandsParam("name", .string, "Part of the accessible name."),
            HandsParam("text", .string, "Part of any text the element shows."),
            HandsParam("value", .string, "Part of its value."),
            HandsParam("limit", .integer, "At most this many matches (default 20)."),
        ], acts: false),
        HandsTool(verb: "get", summary: "Read one property of an element from the live window: value, text, title, role, bounds or states.", params: [
            refParam,
            HandsParam("property", .string, "value (default), text, title, role, bounds or states.", positional: true),
        ], acts: false),
        HandsTool(verb: "click", summary: "Click an element by ref, without moving the pointer or raising the window. On a row of a list, table or outline that the press doesn't select, it selects the row instead and says which landed (landed: press or selection_write). Example: {\"ref\":\"12\"}", params: [refParam], acts: true),
        HandsTool(verb: "type", summary: "Type text into an element by ref: inserts it at the element's selection through accessibility, never by posting keys. Prints the value it read back.", params: [
            refParam,
            HandsParam("text", .string, "The text.", required: true, positional: true, rest: true),
        ], acts: true),
        HandsTool(verb: "set-value", summary: "Replace an element's whole value (a text field, a slider). Prints the value it read back.", params: [
            refParam,
            HandsParam("value", .string, "The new value.", required: true, positional: true, rest: true),
        ], acts: true),
        HandsTool(verb: "press", summary: "Press keys (Return, cmd+a, \"h i Return\") in a window that is not in front: posted to that one process, never to the session, without activating or raising anything. The ref names the window (and the element you expect to change). Refused unless Polycarp started the process, nothing else of its windows could take the key, and the window is where the app's keys go. Answers unverified (retry never) when nothing read back from the window shows the keys landed.", params: [
            refParam,
            HandsParam("key", .string, "Key name with optional modifiers, like cmd+shift+z; several keys are separated by spaces (at most 64).", required: true, positional: true, rest: true),
        ], acts: true),
        HandsTool(verb: "click-at", summary: "Click a point in a window that is not in front, by process, with window-local coordinates (points from the window's top-left corner). Never moves the real pointer or raises the window. For surfaces with no accessibility tree (a canvas); prefer `click` on a ref. Double click: {\"window\":4211,\"x\":120,\"y\":80,\"count\":2}. Answers unverified (retry never) when neither the window's tree nor the pixels around the point changed.", params: [
            HandsParam("window", .integer, "Window id from `windows`.", required: true),
            HandsParam("x", .integer, "Points from the window's left edge.", required: true),
            HandsParam("y", .integer, "Points from the window's top edge.", required: true),
            HandsParam("count", .integer, "2 for a double click, 3 for a triple (default 1)."),
            HandsParam("button", .string, "left only: right click is not available yet."),
        ], acts: true),
        HandsTool(verb: "drag", summary: "Press at a point, drag to another and release, in a window that is not in front, by process, with window-local coordinates. Never moves the real pointer or raises the window. Verified by an accessibility change or by pixels changing along the path while the rest of the window stays put.", params: [
            HandsParam("window", .integer, "Window id from `windows`.", required: true),
            HandsParam("x", .integer, "Start, points from the window's left edge.", required: true),
            HandsParam("y", .integer, "Start, points from the window's top edge.", required: true),
            HandsParam("x2", .integer, "End, points from the window's left edge.", required: true),
            HandsParam("y2", .integer, "End, points from the window's top edge.", required: true),
            HandsParam("steps", .integer, "Intermediate moves (default 12, at most 200)."),
        ], acts: true),
        HandsTool(verb: "scroll", summary: "Scroll an element by ref.", params: [
            refParam,
            HandsParam("direction", .string, "up, down, left or right.", required: true, positional: true),
            HandsParam("amount", .integer, "Notches (default 3)."),
        ], acts: true),
        HandsTool(verb: "select", summary: "Choose an option in a list, menu or popup by ref.", params: [
            refParam,
            HandsParam("option", .string, "The text of the option to choose.", required: true, positional: true, rest: true),
        ], acts: true),
        HandsTool(verb: "menu", summary: "Run a menu-bar command of the window's app by its titles, without opening the menu on screen. Only in a copy your own `open` started, with this its one window. Refused: the Apple, Window and Help menus, the app menu but About and Settings, full screen, Open and Open Recent, cut, copy and paste, and what leaves the app (Emoji, Dictation, Speech, Print, Share). A panel it raises within 1 s is cancelled and the call fails; so does a window it raises off the agent workspace, closed when Polycarp can. Example: {\"window\":4211,\"path\":\"Format > Font > Bold\"}", params: [
            HandsParam("window", .integer, "Window id from `windows`.", required: true),
            HandsParam("path", .string, "Menu titles from the menu bar down, separated by >.", required: true, positional: true, rest: true),
        ], acts: true),
        HandsTool(verb: "toggle", summary: "Flip a checkbox, switch or disclosure by ref. Prints the state it read back.", params: [refParam], acts: true),
        HandsTool(verb: "shot", summary: "Capture one window as a PNG, even while it is parked out of view. Over MCP the picture comes back fitted to 1280 pixels, labeled untrusted, with how its pixels map to window points. Needs Screen Recording for Polycarp. Example: {\"window\":4211,\"zoom\":\"0,0,400,300\"}", params: [
            HandsParam("window", .integer, "Window id.", required: true),
            HandsParam("out", .string, "A file name (no folder) for the PNG; it is written in Polycarp's own shots folder."),
            HandsParam("zoom", .string, "Only this region of the window, x,y,width,height in window points, like \"0,0,400,300\"."),
            HandsParam("cursor", .boolean, "Draw the agent cursor where it last acted in this window, if it did in the last 30 seconds and was on screen. Off by default, so the picture is the app itself."),
        ], acts: true),
        HandsTool(verb: "open", summary: "Start work in the background: open an app, or files from the agent handoff folder in it, on the agent workspace, without activating it or switching what Donovan sees. It answers with the new window's id once the window exists (it waits up to `wait` seconds, at most 7), and focus: {changed, returned} says whether macOS brought the app forward and Polycarp gave the keyboard back. Each call makes a fresh window by default (a separate copy, or New Window from behind in a running copy under Full Access; Donovan's windows never move); new_window: false reuses a window this session already opened in that app. Apps that hold the user's own data (Safari, Notes, Mail, Messages, Calendar, Photos) answer needs_sandbox; URLs wait for agent browser profiles.", params: [
            HandsParam("app", .string, "App name or bundle id.", required: true, positional: true),
            HandsParam("targets", .stringList, "Files in the agent handoff folder to open in it. URLs need an agent browser profile (a later phase).", positional: true, rest: true),
            HandsParam("new_window", .boolean, "true (default): always a fresh window. false: reuse a window this session opened in the app, when there is one and no files are given."),
        ], acts: true),
        HandsTool(verb: "arrange", summary: "Lay out the agent workspace's windows so screenshots and reads are stable: full, halves, thirds, grid, or frames with explicit frames. Only windows on the agent workspace; while it is out of sight they keep their new size and take the position when it is shown. Never touches Donovan's workspaces.", params: [
            HandsParam("layout", .string, "full, halves, thirds, grid or frames.", required: true, positional: true),
            HandsParam("windows", .stringList, "Window ids in the order to place them (default: every agent workspace window you may use, oldest first). With frames: id=x,y,width,height in points from the top-left of the screen's usable area.", positional: true, rest: true),
        ], acts: true),
        HandsTool(verb: "move", summary: "Move a window you may use onto the agent workspace (a lent window, or any window under Full Access, comes off Donovan's workspace), or give a window already there a new frame. A moved window goes back when its lend ends or Full Access is narrowed. Never onto a workspace Donovan is looking at, never one of his windows he hasn't lent, never a dialog (it goes with its app).", params: [
            HandsParam("window", .integer, "Window id from `windows`.", required: true),
            HandsParam("frame", .string, "x,y,width,height in points from the top-left of the screen's usable area (optional)."),
        ], acts: true),
        HandsTool(verb: "close", summary: "Close a window this session opened with `open`, through its close button, from behind. Anything else is refused, and no app is ever quit. If the app asks to save, the sheet appears in the result as opened: answer it (Don't Save or Cancel; a Save panel stays refused, so save first through a document you opened from the handoff folder).", params: [
            HandsParam("window", .integer, "Window id that your `open` returned.", required: true),
        ], acts: true),
    ]

    public static func tool(verb: String) -> HandsTool? {
        let v = verb.replacingOccurrences(of: "_", with: "-")
        return all.first { $0.verb == v }
    }
}

/// A command ready to send to the app: the verb and its arguments by name.
public struct HandsRequest: Codable, Equatable, Sendable {
    public var verb: String
    public var args: [String: JSONValue]
    /// The agent session this comes from, for lends.
    public var session: String?

    public init(verb: String, args: [String: JSONValue] = [:], session: String? = nil) {
        self.verb = verb; self.args = args; self.session = session
    }

    public func string(_ k: String) -> String? { args[k]?.string }
    public func int(_ k: String) -> Int? { args[k]?.int }
    public func bool(_ k: String) -> Bool { args[k]?.bool ?? false }

    /// How a snapshot answers: rows when asked, or when it uses an option only rows have; json otherwise.
    public var snapshotFormat: String {
        if let f = string("format") { return f }
        return ["query", "since", "max_elements"].contains { args[$0] != nil } ? "rows" : "json"
    }
}

public enum HandsParse {
    /// Reads `snapshot --app TextEdit -i` into a request. Unknown flags, missing values and
    /// missing required arguments come back as `bad_arguments` with the usage.
    /// What an agent gets for `lend` or `return`: they are Donovan's, not tools.
    public static func askedForLend(_ app: String?) -> HandsError {
        let name = app ?? "the app"
        return HandsError(.needsLend, "agents can't lend apps; \(name) is not on the agent workspace",
                          suggestion: "Ask Donovan to lend it: he runs `polycarp-spaces agent lend \(name)` in a terminal he types in, or picks it in the Polycarp menu under Lend to Agents. Or do the work on the agent workspace with `polycarp-spaces agent open \(name)` (apps that hold his data go to the sandbox).",
                          retry: .never)
    }

    /// The session a command line request carries (second-F7): `$BANEYSPACES_SESSION` when set, else the terminal, else
    /// "default", which every caller without a terminal shares. What `close`, `new_window: false` and dialog attribution
    /// count as "yours" is this session's.
    public static func cliSession(environment: [String: String], tty: String) -> String {
        if let s = environment["BANEYSPACES_SESSION"], !s.isEmpty { return s }
        return tty.isEmpty ? "default" : tty
    }

    public static func command(_ words: [String], session: String? = nil) -> Result<HandsRequest, HandsError> {
        if let verb = words.first, HandsTools.userOnly.contains(verb) { return .failure(askedForLend(words.dropFirst().first)) }
        guard let verb = words.first, let tool = HandsTools.tool(verb: verb) else {
            return .failure(HandsError(.badArguments, "unknown agent command \(words.first ?? "")",
                                       suggestion: "Commands: " + HandsTools.all.map(\.verb).joined(separator: ", ")))
        }
        var args: [String: JSONValue] = [:]
        var positionals: [String] = []
        let flagged = tool.params.filter { !$0.positional }
        var i = 1
        while i < words.count {
            let w = words[i]
            if w == "--" { positionals += words[(i + 1)...]; break }
            if w.hasPrefix("-"), w.count > 1, Int(w) == nil, Double(w) == nil {
                let (name, inline): (String, String?) = {
                    guard w.hasPrefix("--"), let eq = w.firstIndex(of: "=") else { return (w, nil) }
                    return (String(w[..<eq]), String(w[w.index(after: eq)...]))
                }()
                guard let p = flagged.first(where: { "--" + $0.name == name || ($0.short.map { "-" + $0 } == name) }) else {
                    return .failure(usage(tool, "unknown option \(name)"))
                }
                switch p.kind {
                case .boolean:
                    args[p.name] = .bool(inline.map { $0 != "false" && $0 != "0" } ?? true)
                case .stringList:
                    return .failure(usage(tool, "\(name) is not an option"))
                case .integer, .string:
                    guard let v = inline ?? (i + 1 < words.count ? words[i + 1] : nil) else { return .failure(usage(tool, "\(name) needs a value")) }
                    if inline == nil { i += 1 }
                    if p.kind == .integer {
                        guard let n = Int(v) else { return .failure(usage(tool, "\(name) takes a number, not \(v)")) }
                        args[p.name] = .int(n)
                    } else {
                        args[p.name] = .string(v)
                    }
                }
            } else {
                positionals.append(w)
            }
            i += 1
        }
        var rest = positionals[...]
        for p in tool.params where p.positional {
            if p.rest {
                if !rest.isEmpty {
                    args[p.name] = p.kind == .stringList ? .array(rest.map(JSONValue.string)) : .string(rest.joined(separator: " "))
                }
                rest = []
            } else if let w = rest.first {
                args[p.name] = .string(w)
                rest = rest.dropFirst()
            }
        }
        if !rest.isEmpty { return .failure(usage(tool, "unexpected \(rest.joined(separator: " "))")) }
        return validated(HandsRequest(verb: tool.verb, args: args, session: session), tool)
    }

    /// An MCP tool call: `arguments` by name.
    public static func call(name: String, arguments: [String: JSONValue], session: String? = nil) -> Result<HandsRequest, HandsError> {
        if HandsTools.userOnly.contains(name) { return .failure(askedForLend(arguments["app"]?.string)) }
        guard let tool = HandsTools.tool(verb: name) else {
            return .failure(HandsError(.badArguments, "unknown tool \(name)", suggestion: "Call tools/list for the tools."))
        }
        var args: [String: JSONValue] = [:]
        for (k, v) in arguments {
            guard let p = tool.params.first(where: { $0.name == k }) else { return .failure(usage(tool, "unknown argument \(k)")) }
            switch p.kind {
            case .string: args[k] = v.string.map(JSONValue.string) ?? .string(v.text)
            case .stringList:
                guard let a = v.array, a.allSatisfy({ $0.string != nil }) else { return .failure(usage(tool, "\(k) takes a list of strings")) }
                args[k] = v
            case .integer:
                guard let n = v.int else { return .failure(usage(tool, "\(k) takes a number")) }
                args[k] = .int(n)
            case .boolean:
                guard let b = v.bool else { return .failure(usage(tool, "\(k) takes true or false")) }
                args[k] = .bool(b)
            }
        }
        return validated(HandsRequest(verb: tool.verb, args: args, session: session), tool)
    }

    private static func validated(_ r: HandsRequest, _ tool: HandsTool) -> Result<HandsRequest, HandsError> {
        for p in tool.params where p.required && r.args[p.name] == nil {
            return .failure(usage(tool, "\(p.name) is missing"))
        }
        if let w = r.int("wait"), !(0...InUseRule.maxWait).contains(w) {
            return .failure(usage(tool, "wait is seconds from 0 to \(InUseRule.maxWait), not \(w)"))
        }
        if tool.verb == "arrange" {
            guard let layout = r.string("layout").flatMap({ AgentArrange.Layout(rawValue: $0.lowercased()) }) else {
                return .failure(usage(tool, "layout is full, halves, thirds, grid or frames, not \(r.string("layout") ?? "")"))
            }
            let items = r.args["windows"]?.array?.compactMap(\.string) ?? []
            if layout == .frames {
                if items.isEmpty { return .failure(usage(tool, "frames needs id=x,y,width,height for each window")) }
                if let bad = items.first(where: { AgentArrange.parseFrame($0) == nil }) { return .failure(usage(tool, "\(bad) isn't id=x,y,width,height")) }
            } else if let bad = items.first(where: { UInt32($0) == nil }) {
                return .failure(usage(tool, "\(bad) isn't a window id"))
            }
        }
        if tool.verb == "move", let f = r.string("frame"), AgentArrange.parseFrame("0=" + f) == nil {
            return .failure(usage(tool, "frame is x,y,width,height, not \(f)"))
        }
        if tool.verb == "snapshot" || tool.verb == "find", r.args["app"] == nil, r.args["window"] == nil {
            return .failure(usage(tool, "say which window: app or window"))
        }
        if tool.verb == "snapshot" {
            if let f = r.string("format"), f != "rows", f != "json" { return .failure(usage(tool, "format is rows or json, not \(f)")) }
            if let s = r.string("since"), s != "latest" { return .failure(usage(tool, "since takes \"latest\", not \(s)")) }
            if let m = r.int("max_elements"), m < 1 { return .failure(usage(tool, "max_elements is 1 or more, not \(m)")) }
            if r.string("format") == "json", let p = ["query", "since", "max_elements"].first(where: { r.args[$0] != nil }) {
                return .failure(usage(tool, "\(p) works with format rows only"))
            }
        }
        return .success(r)
    }

    public static func usageLine(_ tool: HandsTool) -> String {
        var parts = ["polycarp-spaces agent", tool.verb]
        for p in tool.params {
            if p.positional { parts.append(p.required ? "<\(p.name)>" : "[\(p.name)\(p.rest ? "…" : "")]") }
            else {
                let flag = "--" + p.name + (p.kind == .boolean ? "" : " <\(p.name)>")
                parts.append(p.required ? flag : "[\(flag)]")
            }
        }
        return parts.joined(separator: " ")
    }

    static func usage(_ tool: HandsTool, _ why: String) -> HandsError {
        HandsError(.badArguments, why, suggestion: "usage: " + usageLine(tool), retry: .safe)
    }
}
