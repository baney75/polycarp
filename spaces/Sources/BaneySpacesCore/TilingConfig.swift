extension TilingOptions {
    public init(_ s: Surfaces.Tiling, agentWorkspace: Int?) {
        self.init()
        everywhere = s.enabled
        on = s.on
        off = s.off
        style = TileStyle(rawValue: s.style) ?? .dwindle
        func edge(_ n: Int) -> Double { Double(s.outer + n) }
        gaps = TileGaps(inner: Double(s.inner), top: edge(s.top), bottom: edge(s.bottom), left: edge(s.left), right: edge(s.right))
        switch s.loneWidth {
        case .fill: lone = .fill
        case .smart: lone = .smart
        case .points(let w): lone = .points(Double(w))
        }
        side = TilingSide(rawValue: s.newWindow) ?? .after
        floatApps = Set(s.float)
        rules = s.rules.compactMap { try? TileRule.read($0).get() }
        self.agentWorkspace = agentWorkspace
    }

    /// The options with one workspace turned on or off, named in a list only when the default says otherwise.
    public func toggled(_ workspace: Int) -> TilingOptions {
        var o = self
        let tile = !tiles(workspace)
        o.on.remove(workspace)
        o.off.remove(workspace)
        if tile, !everywhere { o.on.insert(workspace) }
        if !tile, everywhere { o.off.insert(workspace) }
        return o
    }
}
