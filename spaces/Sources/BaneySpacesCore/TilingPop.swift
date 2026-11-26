import CoreGraphics

/// Windows taken out of the tiles and put back where they were.
extension TilingEngine {
    /// The most a popped out window takes: these points, or these parts of the area when that is less.
    static let popSize = CGSize(width: 1300, height: 900)
    static let popPart = CGSize(width: 0.75, height: 0.8)

    /// A tiled window is about to float: its place is kept for when it tiles here again.
    mutating func keepPlace(of id: WindowID) {
        for key in slots.keys where slots[key]!.holds(id) {
            let layout = slots[key]!.layout
            slots[key]!.remember([id], beside: { Self.sibling(of: $0, in: layout) })
            slots[key]!.away[id]?.floating = true
            slots[key]!.away[id]?.before = before[id]
        }
    }

    /// A window is about to be pinned. `sized`, it gets a size of its own in the middle of its workspace's tiles; else it
    /// stays where it is.
    public mutating func popOut(_ id: WindowID, sized: Bool) {
        guard let w = seen[id] else { return }
        keepPlace(of: id)
        asked[id] = nil
        before[id] = nil
        guard sized, !w.fixed, let area = key(w.workspace).flatMap({ slots[$0]?.area }) else { return }
        let size = CGSize(width: min(Self.popSize.width, area.width * Self.popPart.width), height: min(Self.popSize.height, area.height * Self.popPart.height))
        before[id] = CGRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2, width: size.width, height: size.height).integral
    }
}
