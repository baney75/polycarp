import CoreGraphics

/// A tile shown larger than its place, over the others, until it is asked to go back.
public enum TilingZoom: String, Codable, Sendable {
    /// All a workspace may tile, with no gaps. The display's macOS desktop stays as it is.
    case screen
    /// From side to side, as high as its tile.
    case width
}

extension TilingEngine {
    /// The frames of a workspace with the zoomed windows at theirs, a group's windows all alike.
    func zoomed(_ frames: [WindowID: CGRect], _ slot: Slot) -> [WindowID: CGRect] {
        var out = frames
        guard let box = options.gaps.inset(slot.area) else { return out }
        for id in slot.zoomed.keys {
            guard let t = out[id], let zoom = Self.zoom(of: id, slot) else { continue }
            let to = zoom == .screen ? slot.area : CGRect(x: box.x0, y: t.minY, width: box.width, height: t.height)
            for m in slot.group(id).map({ slot.groups[$0].members }) ?? [id] { out[m] = to }
        }
        return out
    }

    /// How a window, or its group, is zoomed.
    static func zoom(of id: WindowID, _ slot: Slot) -> TilingZoom? {
        let mates = slot.group(id).map { slot.groups[$0].members } ?? [id]
        let all = mates.compactMap { slot.zoomed[$0] }
        return all.contains(.screen) ? .screen : all.first
    }

    /// Zooms a window that way, or back from it.
    static func toggle(_ zoom: TilingZoom, _ id: WindowID, _ slot: inout Slot) {
        let was = Self.zoom(of: id, slot)
        for m in slot.group(id).map({ slot.groups[$0].members }) ?? [id] { slot.zoomed[m] = nil }
        if was != zoom { slot.zoomed[id] = zoom }
    }

    /// Whether a strip of tabs is under a zoomed window.
    func covered(_ strip: CGRect, _ slot: Slot, _ frames: [WindowID: CGRect]) -> Bool {
        slot.zoomed.keys.contains { frames[$0]?.intersects(strip) == true }
    }

    /// What a saved layout keeps of its zoomed windows.
    static func kept(_ zoomed: [WindowID: TilingZoom], _ slot: Slot) -> [WindowID: TilingZoom]? {
        let left = zoomed.filter { slot.holds($0.key) }
        return left.isEmpty ? nil : left
    }
}
