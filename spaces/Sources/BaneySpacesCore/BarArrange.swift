import Foundation

/// One of the bar's three module lists (`bar.modules.left`, `center`, `right`).
public enum BarRow: String, CaseIterable, Sendable {
    case left, center, right
}

/// A place in a module list. For a module, `index` is its position in its row's list. For a drop, it is the gap the
/// module goes into, counted in the list as it is before the move: 0 is before the first, `count` is the end.
public struct BarSlot: Hashable, Sendable {
    public var row: BarRow
    public var index: Int
    public init(_ row: BarRow, _ index: Int) { self.row = row; self.index = index }
}

/// Where one row sits on a bar, in points across that bar, for `BarArrange.slot(at:rows:)`.
public struct BarRowGeometry: Equatable, Sendable {
    public var row: BarRow
    /// The stretch of the bar whose drops land in this row. Rows don't overlap; what no row covers (the notch) takes
    /// no drop.
    public var minX: Double, maxX: Double
    /// The modules this bar draws in the row, each by its index in the row's list. A module that draws nothing (the
    /// battery on a desktop Mac, a custom one) has no item and keeps its place in the list.
    public var items: [Item]
    /// How many modules the row's list holds, drawn or not.
    public var count: Int

    public struct Item: Equatable, Sendable {
        public var index: Int
        public var minX: Double, maxX: Double
        public init(index: Int, minX: Double, maxX: Double) { self.index = index; self.minX = minX; self.maxX = maxX }
    }

    public init(row: BarRow, minX: Double, maxX: Double, items: [Item], count: Int) {
        self.row = row; self.minX = minX; self.maxX = maxX; self.items = items; self.count = count
    }
}

/// Moving the bar's modules by hand (spec/bar.md, "Moving modules (macOS)", R-BA1 to R-BA6). Pure: the app
/// measures the rows, asks for a slot, and writes the moved lists with `write`.
public enum BarArrange {
    public static func list(_ bar: Surfaces.Bar, _ row: BarRow) -> [Surfaces.BarModule] {
        switch row {
        case .left: bar.left
        case .center: bar.center
        case .right: bar.right
        }
    }

    static func set(_ bar: inout Surfaces.Bar, _ row: BarRow, _ list: [Surfaces.BarModule]) {
        switch row {
        case .left: bar.left = list
        case .center: bar.center = list
        case .right: bar.right = list
        }
    }

    /// The module at `from` moved into the gap `to`. A `from` with no module, a `to` past the end of its row, or the
    /// module's own place (the gap just before or just after it) gives `bar` back unchanged, so the caller writes
    /// nothing. Nothing is dropped or doubled: the three lists hold the same modules before and after (R-BA4).
    public static func move(_ bar: Surfaces.Bar, from: BarSlot, to: BarSlot) -> Surfaces.Bar {
        var source = list(bar, from.row)
        guard source.indices.contains(from.index), to.index >= 0, to.index <= list(bar, to.row).count else { return bar }
        if from.row == to.row, to.index == from.index || to.index == from.index + 1 { return bar }
        var out = bar
        let module = source.remove(at: from.index)
        set(&out, from.row, source)
        var target = list(out, to.row)
        // In the same row the gaps after the module close up by one once it is out.
        let at = from.row == to.row && to.index > from.index ? to.index - 1 : to.index
        target.insert(module, at: at)
        set(&out, to.row, target)
        return out
    }

    /// The gap a drop at `x` lands in: the row whose stretch holds `x` (each from its `minX` up to, not including, its
    /// `maxX`; the last row takes its `maxX` too), before the first drawn module whose middle is past `x`, else the row's
    /// end. Nil where no row is (under the notch, R-BA3). With `moving`, any gap that looks the same as its own place
    /// (between the drawn modules either side of it, past ones that draw nothing) is its own place, so `move` writes
    /// nothing (R-BA5).
    public static func slot(at x: Double, rows: [BarRowGeometry], moving: BarSlot? = nil) -> BarSlot? {
        guard let i = rows.firstIndex(where: { x >= $0.minX && (x < $0.maxX || ($0 == rows.last && x == $0.maxX)) }) else { return nil }
        let row = rows[i]
        let items = row.items.sorted { $0.minX < $1.minX }
        let after = items.first { ($0.minX + $0.maxX) / 2 > x }
        let slot = BarSlot(row.row, after?.index ?? row.count)
        guard let moving, moving.row == row.row else { return slot }
        let before = items.last { $0.index < moving.index }.map { $0.index + 1 } ?? 0
        let next = items.first { $0.index > moving.index }?.index ?? row.count
        return (before...next).contains(slot.index) ? moving : slot
    }

    /// The moves VoiceOver offers on each module (R-BA6).
    public enum Step: String, CaseIterable, Sendable {
        case left = "Move Left", right = "Move Right"
        case toLeft = "Move to Left Section", toCenter = "Move to Center", toRight = "Move to Right Section"
    }

    /// Where `step` takes the module at `from`, or nil when it can't go that way. Left and right pass the modules that
    /// `shown` says draw nothing, so each step moves the module past one you can see, and at a row's edge it goes into
    /// the next row. A move to another section puts it at the end nearest where it was: the far end of a row to its
    /// left, the near end of a row to its right.
    public static func slot(for step: Step, from: BarSlot, in bar: Surfaces.Bar,
                            shown: (Surfaces.BarModule) -> Bool = { _ in true }) -> BarSlot? {
        let row = list(bar, from.row)
        guard row.indices.contains(from.index) else { return nil }
        let rows = BarRow.allCases
        let r = rows.firstIndex(of: from.row)!
        switch step {
        case .left:
            if let j = row.indices.last(where: { $0 < from.index && shown(row[$0]) }) { return BarSlot(from.row, j) }
            guard r > 0 else { return nil }
            return BarSlot(rows[r - 1], list(bar, rows[r - 1]).count)
        case .right:
            if let j = row.indices.first(where: { $0 > from.index && shown(row[$0]) }) { return BarSlot(from.row, j + 1) }
            guard r < rows.count - 1 else { return nil }
            return BarSlot(rows[r + 1], 0)
        case .toLeft, .toCenter, .toRight:
            let target: BarRow = step == .toLeft ? .left : step == .toCenter ? .center : .right
            guard target != from.row else { return nil }
            let t = rows.firstIndex(of: target)!
            return BarSlot(target, t < r ? list(bar, target).count : 0)
        }
    }

    /// The three lists as the one value `bar.modules` takes.
    public static func value(_ bar: Surfaces.Bar) -> SurfaceValue {
        func ids(_ l: [Surfaces.BarModule]) -> SurfaceValue { .array(l.map { .string($0.id) }) }
        return .object(["left": ids(bar.left), "center": ids(bar.center), "right": ids(bar.right)])
    }

    /// Writes `bar`'s three module lists to surfaces.json in one write (R-BA4); the store and every bar follow the file.
    /// What went wrong, or nil.
    public static func write(_ bar: Surfaces.Bar, file: String) -> String? {
        if case .failure(let f) = SurfacesOps.set("bar.modules", value(bar), file: file) { return f.message }
        return nil
    }
}
