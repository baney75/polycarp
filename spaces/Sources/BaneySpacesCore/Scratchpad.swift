/// The scratchpad: windows that belong to no workspace and come out over the one in use, all together, at one key. While
/// put away they live on workspace 0, which is never shown, so they are kept out of sight as any other workspace's are.
extension Workspaces {
    public static let scratchpad = 0

    public func isScratch(_ id: WindowID) -> Bool { home[id] == Self.scratchpad || out.contains(id) }

    /// Every scratchpad window, in sight or not.
    public var scratch: [WindowID] { home.keys.filter(isScratch).sorted() }

    /// Whether the scratchpad is over the workspace in use.
    public var scratchpadIsOut: Bool { !out.isEmpty && out.allSatisfy { home[$0] == current } }

    /// Sends a window to the scratchpad, out of sight.
    public mutating func toScratchpad(_ id: WindowID) {
        guard home[id] != nil else { return }
        leave(id)
        home[id] = Self.scratchpad
        lastFocused[Self.scratchpad] = id
    }

    /// A window found again goes where it was: a workspace, or the scratchpad.
    public mutating func putBack(_ id: WindowID, on n: Int) {
        if n == Self.scratchpad { toScratchpad(id) } else { assign(id, to: n, focus: false) }
    }

    /// A scratchpad window becomes one of the workspace it is over, or of the one in use.
    public mutating func takeOut(_ id: WindowID) {
        guard isScratch(id) else { return }
        assign(id, to: out.contains(id) ? home[id]! : current)
    }

    /// Brings every scratchpad window over the workspace in use. The one to focus, nil when there is none or the workspace
    /// is `reserved`: what an agent works on is never mixed with the person's.
    public mutating func showScratchpad() -> WindowID? {
        guard !reserved.contains(current), let last = lastScratch else { return nil }
        for id in scratch {
            leave(id)
            home[id] = current
            out.insert(id)
        }
        lastFocused[current] = last
        return last
    }

    /// Puts the scratchpad away, and each workspace it was over has the window in focus that had it before.
    public mutating func hideScratchpad() { putAway(out) }

    /// The scratchpad window used last.
    private var lastScratch: WindowID? {
        let all = scratch
        return out.first { home[$0].flatMap { lastFocused[$0] } == $0 } ?? lastFocused[Self.scratchpad].flatMap { all.contains($0) ? $0 : nil } ?? all.last
    }

    mutating func putAway(_ ids: Set<WindowID>) {
        if let last = lastScratch, ids.contains(last) { lastFocused[Self.scratchpad] = last }
        for id in ids {
            leave(id)
            home[id] = Self.scratchpad
        }
    }

    /// A window leaves its workspace; the focus there goes back to the window that had it before the scratchpad came out.
    private mutating func leave(_ id: WindowID) {
        out.remove(id)
        guard let n = home[id] else { return }
        if under[n] == id { under[n] = nil }
        if lastFocused[n] == id { lastFocused[n] = under[n].flatMap { home[$0] == n ? $0 : nil } }
    }
}
