import CoreGraphics
import Foundation

/// The agent API's commands that change what Donovan sees (spec/agent-api.md, "View control"): `switch`, `focus`, and
/// `move` or `frame` off the agent workspace. They run only for a caller on this Mac, under Full Access, with Donovan's
/// own setting on. Everything else the agent does stays on the agent workspace, where his screen never changes.
public enum ViewControl {
    /// Where an older build saved the switch (com.baney.polycarp). It is never read: the switch lives in the running app
    /// only, so nothing written to disk turns it on (review F2). The app removes a value found here at launch.
    public static let legacyDefaultsKey = "agentViewControl"
    public static let settingTitle = "Agents may change what you see"

    /// Why `what` can't change the view, or nil when all three hold. The message names the first one missing.
    public static func refusal(_ what: String, access: AgentAccessMode, enabled: Bool, remote: Bool) -> HandsError? {
        let missing: String
        if remote {
            missing = "it came from another machine, and only an agent on this Mac may change what Donovan sees"
        } else if access != .full {
            missing = "agent access is \(access.title), and changing what Donovan sees needs Full Access"
        } else if !enabled {
            missing = "\"\(settingTitle)\" is off in Polycarp Settings > Agents"
        } else {
            return nil
        }
        return HandsError(.permissionDenied, "\(what) would change what Donovan sees, and \(missing)",
                          suggestion: "Work on the agent workspace instead: `move` a window there and `frame` it there. Only Donovan turns view control on.",
                          retry: .never)
    }
}

extension ViewControl {
    /// The answer for work on the agent workspace while Donovan can see a workspace it touches, with view control or
    /// without: it goes once no display shows it.
    public static func notWhileShown(_ what: String) -> HandsError {
        HandsError(.inUse, "\(what) would change a workspace a display shows, so it waits until none does",
                   suggestion: "Retry once Donovan has left it, or work on a window out of sight. Do not ask him to switch away.", retry: .safe)
    }
}

/// The "Agents may change what you see" switch itself (review F2). It is never stored: it starts off, nothing on disk is
/// read for it, and it turns on only when `confirm` says Donovan confirmed Polycarp's sheet. Turning it off never asks.
public struct ViewControlSwitch {
    public private(set) var on = false
    public init() {}

    /// Sets the switch; true when it now reads `new`.
    @discardableResult
    public mutating func set(_ new: Bool, confirm: () -> Bool) -> Bool {
        if new == on { return true }
        if new, !confirm() { return false }
        on = new
        return true
    }

    /// The switch as the app starts: always off. A value under the legacy key, sealed or not, is removed unread, and no
    /// Keychain item is consulted (review F2, round 2). `forgot` says a value was there.
    public static func atLaunch(_ defaults: UserDefaults) -> (state: ViewControlSwitch, forgot: Bool) {
        (ViewControlSwitch(), forgetSaved(in: defaults))
    }

    /// Removes a value saved under the legacy key, by an older build or by anyone with a shell; true when one was there.
    /// It is only ever removed, never read.
    @discardableResult
    public static func forgetSaved(in defaults: UserDefaults) -> Bool {
        guard defaults.object(forKey: ViewControl.legacyDefaultsKey) != nil else { return false }
        defaults.removeObject(forKey: ViewControl.legacyDefaultsKey)
        return true
    }
}

/// The arguments of the agent API's commands, checked before anything is read from the app.
public enum AgentCommands {
    /// `frame`: "x,y,width,height" in points, origin at the top left of the main display, as `query windows` reports it.
    public static func frame(_ text: String?) -> Result<CGRect, HandsError> {
        let parts = (text ?? "").split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 4, let x = parts[0], let y = parts[1], let w = parts[2], let h = parts[3],
              [x, y, w, h].allSatisfy(\.isFinite), w >= 1, h >= 1, w <= 100_000, h <= 100_000 else {
            return .failure(HandsError(.badArguments, "frame must be x,y,width,height in points, like 0,40,800,600",
                                       suggestion: "Read a frame from `query windows` and change it.", retry: .never))
        }
        return .success(CGRect(x: x, y: y, width: w, height: h))
    }

    /// A workspace number from 1 to 9.
    public static func workspace(_ n: Int?) -> Result<Int, HandsError> {
        guard let n, Workspaces.range.contains(n) else {
            return .failure(HandsError(.badArguments, "workspace must be a number from 1 to 9", suggestion: "Read them with `query workspaces`.", retry: .never))
        }
        return .success(n)
    }

    /// A display id the facts list.
    public static func display(_ id: String, in facts: AgentAPI.Facts) -> Result<String, HandsError> {
        guard facts.displays.contains(where: { $0.id == id }) else {
            return .failure(HandsError(.badArguments, "there is no display \(id)", suggestion: "Read the ids with `query displays`.", retry: .afterSnapshot))
        }
        return .success(id)
    }

    /// `switch`: the workspace, and the display to show it on (the focused one when none is named).
    public static func switchTarget(workspace: Int?, display: String?, facts: AgentAPI.Facts) -> Result<(workspace: Int, display: String?), HandsError> {
        switch Self.workspace(workspace) {
        case .failure(let e): return .failure(e)
        case .success(let n):
            guard let display else { return .success((n, facts.focusedDisplay)) }
            return Self.display(display, in: facts).map { (n, $0) }
        }
    }

    /// `move`: where a window goes. nil when neither `workspace` nor `display` was given, which keeps `move`'s older
    /// meaning (onto the agent workspace). A display sends it to the workspace that display shows.
    public static func moveTarget(workspace: Int?, display: String?, facts: AgentAPI.Facts) -> Result<Int?, HandsError> {
        switch (workspace, display) {
        case (nil, nil): return .success(nil)
        case (.some, .some):
            return .failure(HandsError(.badArguments, "give workspace or display, not both", suggestion: "A display sends the window to the workspace it shows.", retry: .never))
        case (let n?, nil): return Self.workspace(n).map { $0 }
        case (nil, let id?):
            return Self.display(id, in: facts).flatMap { id in
                guard let n = facts.shown[id] else {
                    return .failure(HandsError(.badArguments, "display \(id) shows no workspace", suggestion: "Read `query displays` again.", retry: .afterSnapshot))
                }
                return .success(n)
            }
        }
    }

    /// What moving or framing a window needs (spec/agent-api.md, "View control"). Acting on any workspace but the agent
    /// workspace needs view control. Acting on the agent workspace needs nothing, but waits while a display shows it or
    /// the workspace the window leaves: a passing condition, so `in_use`, never `permission_denied` (review r2 first-F1).
    public enum ViewNeed: Equatable, Sendable { case nothing, notWhileShown, viewControl }

    public static func need(from source: Int?, to target: Int, agentWorkspace: Int?, shown: Set<Int>) -> ViewNeed {
        guard let agent = agentWorkspace, target == agent, let source else { return .viewControl }
        return shown.contains(agent) || shown.contains(source) ? .notWhileShown : .nothing
    }

    /// The window's place as the result reports it: its workspace, the display showing that workspace, and its frame.
    public static func place(_ id: UInt32, _ facts: AgentAPI.Facts) -> [String: JSONValue] {
        guard let f = facts.windows.first(where: { $0.window.id == id }) else { return ["workspace": .null, "display": .null, "frame": .null] }
        return ["workspace": f.window.workspace.map(JSONValue.int) ?? .null,
                "display": facts.display(showing: f.window.workspace).map(JSONValue.string) ?? .null,
                "frame": f.frame.map(AgentAPI.frame) ?? .null]
    }
}
