/// Pinned windows: each is on whichever workspace its display shows, and goes along when that changes.
extension Workspaces {
    /// Pins a window to its display or lets it go, on the workspace it is on now. Never one of a `reserved` workspace.
    public mutating func pin(_ id: WindowID, _ on: Bool) {
        guard on else { pinned.remove(id); return }
        takeOut(id)
        guard let n = home[id], n != Self.scratchpad, !reserved.contains(n) else { return }
        pinned.insert(id)
    }

    /// The pinned windows whose workspace no display shows any more come to this one, unless it is an agent's: there they
    /// wait for the next.
    mutating func bringPinned(to n: Int) {
        guard !reserved.contains(n) else { return }
        for id in pinned where home[id].map({ !isShown($0) }) ?? false {
            leave(id)
            home[id] = n
        }
    }

    /// Another native tab came to the front of a window over its workspace: it is over it as the one before was.
    public mutating func tab(_ old: WindowID, became new: WindowID) {
        guard let n = home[old], home[new] != nil else { return }
        if out.remove(old) != nil { out.insert(new) } else if pinned.remove(old) != nil { pinned.insert(new) } else { return }
        home[new] = n
        if lastFocused[n] == old { lastFocused[n] = new }
    }
}
