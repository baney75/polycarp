import AppKit
import BaneySpacesCore

/// The scratchpad's windows: out of sight the way another workspace's are, over the workspace in use at one key.
extension Spaces {
    /// Puts the scratchpad over the workspace in use, or away when it is there. `done` gets why not.
    func toggleScratchpad(done: @escaping (String?) -> Void = { _ in }) {
        guard active else { return done("Polycarp isn't placing windows now") }
        if switching { return enqueue { [weak self] in self?.toggleScratchpad(done: done) } }
        guard model.current != Self.agentWorkspace else { return done("the agent workspace has no scratchpad") }
        holdUntilFresh { [self] in
            guard model.scratchpadIsOut else { return done(bringScratchpad() ? nil : "the scratchpad is empty") }
            model.hideScratchpad()
            switchTo(model.current, announce: false)
            done(nil)
        }
    }

    /// Where `switchTo` ends up for a window of the scratchpad (the app it belongs to was picked in the Dock, say).
    func showScratchpad() {
        if switching { return enqueue { [weak self] in self?.showScratchpad() } }
        holdUntilFresh { [self] in bringScratchpad() }
    }

    /// Pins a window to its display, or lets it go where it is.
    func pin(_ id: WindowID, _ on: Bool) {
        guard active else { return }
        model.pin(id, on)
        persist()
        onChange?()
    }

    @discardableResult
    private func bringScratchpad() -> Bool {
        if let f = front() { noteFocus(f) }
        let hidden = model.scratch
        guard let first = model.showScratchpad() else { return false }
        let n = model.current
        switchTo(n, takeFocus: false, announce: false)
        // Each comes forward, the one used last on top with the keyboard. One in the Dock stays there.
        let up = hidden.filter { !isMinimized($0) }
        guard let top = up.contains(first) ? first : up.last else { return true }
        for id in up where id != top { focus(id, on: n, announce: false) }
        focus(top, on: n, announce: false)
        return true
    }

    /// Sends the window to the scratchpad, or takes it out when it is of it. `frame` is where it comes back, nil for where
    /// it is.
    func sendToScratchpad(_ id: WindowID, at frame: CGRect?) {
        guard active else { return }
        if switching { return enqueue { [weak self] in self?.sendToScratchpad(id, at: frame) } }
        if model.isScratch(id) {
            model.takeOut(id)
            return switchTo(model.current, announce: false)
        }
        model.toScratchpad(id)
        switchTo(model.current, announce: false)
        guard let frame else { return }
        let putBack: () -> Void = { [weak self] in self?.placeAway(id, at: frame) }
        if switching { enqueue(putBack) } else { putBack() }
    }
}
