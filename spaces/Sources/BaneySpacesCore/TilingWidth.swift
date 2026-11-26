import CoreGraphics

/// The width a person kept for an app's windows on a workspace.
public struct TilingWidth: Codable, Equatable, Sendable {
    var bundle: String
    var workspace: Int
    var width: Double
}

extension TilingEngine {
    /// Widths kept before the oldest goes.
    static let mostWidths = 200
    /// The narrowest a person makes a workspace's only window.
    static let narrowest = 200.0

    /// Keeps the width a window has now, for its app on this workspace.
    mutating func keepWidth(_ id: WindowID, _ workspace: Int, _ slot: Slot) -> TilingOutcome {
        guard let bundle = seen[id]?.bundle, !bundle.isEmpty, let now = frames(workspace)[id]?.width else { return .nothing("no window is in front") }
        widths.removeAll { $0.bundle == bundle && $0.workspace == workspace }
        widths.append(TilingWidth(bundle: bundle, workspace: workspace, width: now))
        if widths.count > Self.mostWidths { widths.removeFirst() }
        return .changed
    }

    /// The width kept for an app here, else the one kept last on any workspace.
    func width(for bundle: String, on workspace: Int) -> Double? {
        (widths.first { $0.bundle == bundle && $0.workspace == workspace } ?? widths.last { $0.bundle == bundle })?.width
    }

    mutating func restoreWidth(_ id: WindowID, _ workspace: Int, _ key: TilingKey) -> TilingOutcome {
        guard let w = seen[id].flatMap({ width(for: $0.bundle, on: workspace) }) else { return .nothing("no width is kept for this app") }
        var slot = slots[key]!
        if slot.isAlone {
            setWidth(w, &slot)
        } else if let now = slot.layout.frames(in: slot.area, gaps: options.gaps, minimums: needs(slot))[id]?.width {
            slot.layout.resize(id, axis: .horizontal, by: w - now, area: slot.area, gaps: options.gaps, minimums: needs(slot))
        }
        guard slot != slots[key] else { return .nothing("there is nothing to change") }
        slots[key] = slot
        return .changed
    }

    /// A workspace's only window, as wide as the person made it, in the middle.
    func setWidth(_ width: Double, _ slot: inout Slot) {
        guard let box = options.gaps.inset(slot.area) else { return }
        slot.width = min(box.width, max(Self.narrowest, width.rounded()))
    }

    /// The widest a workspace's only window may be: what the person made it, else the setting. Nil is all of the area.
    func lone(_ slot: Slot) -> CGSize? {
        (slot.width ?? options.lone.width(in: slot.area)).map { CGSize(width: $0, height: .infinity) }
    }
}

extension TilingEngine.Slot {
    /// One window, or one group, has all of the layout.
    var isAlone: Bool { !layout.full && layout.windows.count == 1 }
}
