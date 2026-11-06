import CoreGraphics

/// Where the overview puts each workspace (spec/overview.md, Layout). Workspaces with windows share the screen in proportion
/// to how many windows they hold; empty ones become one row of numbered slots along the bottom. Donovan, 2026-11-01, on nine
/// equal tiles: eight empty boxes took the screen while workspace 1's seven windows were cut off.
public enum OverviewLayout {
    public struct Plan: Equatable, Sendable {
        /// Workspaces with windows, or the current one.
        public var tiles: [Int: CGRect]
        /// The rest, each a small slot in the strip.
        public var slots: [Int: CGRect]
        public var all: [Int: CGRect] { tiles.merging(slots) { a, _ in a } }
    }

    public static let gap: CGFloat = 16
    public static let slotSize: CGFloat = 56
    /// A workspace with one window still gets at least a quarter of what any other gets. Past seven windows a workspace takes
    /// no more room, since its cards shrink to fit and a very full one would otherwise squeeze a quiet one to nothing.
    static func weight(_ windows: Int) -> CGFloat { min(max(CGFloat(windows), 7.0 / 4), 7) }

    /// `area` is what the overview may use. `current` always gets a tile, so where you are is never just a slot.
    public static func plan(windows: [Int: Int], current: Int, in area: CGRect) -> Plan {
        let workspaces = 1...9
        let used = workspaces.filter { (windows[$0] ?? 0) > 0 || $0 == current }
        let empty = workspaces.filter { !used.contains($0) }
        let stripHeight = empty.isEmpty ? 0 : slotSize + gap
        let tilesArea = CGRect(x: area.minX, y: area.minY, width: area.width, height: max(0, area.height - stripHeight))

        var slots: [Int: CGRect] = [:]
        let stripWidth = CGFloat(empty.count) * slotSize + CGFloat(max(0, empty.count - 1)) * gap
        var x = area.midX - stripWidth / 2
        for n in empty {
            slots[n] = CGRect(x: x, y: area.maxY - slotSize, width: slotSize, height: slotSize)
            x += slotSize + gap
        }
        return Plan(tiles: tiles(used: used, windows: windows, in: tilesArea), slots: slots)
    }

    /// How a tile's windows fill it: the grid whose cards come closest to a window's shape (about 8:5). Nothing is cut off,
    /// so cards shrink as a tile fills.
    public struct CardGrid: Equatable, Sendable {
        public var columns: Int
        public var rows: Int
        public var cardSize: CGSize
    }

    public static let cardGap: CGFloat = 8

    public static func cards(_ count: Int, in size: CGSize) -> CardGrid {
        guard count > 0, size.width > 0, size.height > 0 else { return CardGrid(columns: 1, rows: 0, cardSize: .zero) }
        let target: CGFloat = 8.0 / 5
        var best = CardGrid(columns: 1, rows: count, cardSize: .zero)
        var bestScore = CGFloat.infinity
        for columns in 1...count {
            let rows = (count + columns - 1) / columns
            let width = (size.width - cardGap * CGFloat(columns - 1)) / CGFloat(columns)
            let height = (size.height - cardGap * CGFloat(rows - 1)) / CGFloat(rows)
            guard width > 0, height > 0 else { continue }
            // Off by a factor either way counts the same, and a little for each empty place left in the last row.
            let ratio = width / height
            let score = max(ratio / target, target / ratio) + CGFloat(rows * columns - count) * 0.05
            if score < bestScore {
                bestScore = score
                best = CardGrid(columns: columns, rows: rows, cardSize: CGSize(width: width, height: height))
            }
        }
        return best
    }

    /// How many tiles go in each row: wide rows, since screens are wide and a row of three still reads.
    static func rows(_ count: Int) -> [Int] {
        switch count {
        case 0: []
        case 1...3: [count]
        case 4: [2, 2]
        case 5: [3, 2]
        case 6: [3, 3]
        case 7: [4, 3]
        case 8: [4, 4]
        default: [3, 3, 3]
        }
    }

    private static func tiles(used: [Int], windows: [Int: Int], in area: CGRect) -> [Int: CGRect] {
        var rest = used[...]
        let groups: [[Int]] = rows(used.count).map { take in
            let row = Array(rest.prefix(take))
            rest = rest.dropFirst(take)
            return row
        }
        guard !groups.isEmpty else { return [:] }
        let sums = groups.map { row in row.map { weight(windows[$0] ?? 0) }.reduce(0, +) }
        // A row's height follows its weight per tile, softened so a busy row doesn't flatten a quiet one.
        let shares = zip(groups, sums).map { row, sum in (sum / CGFloat(row.count)).squareRoot() }
        let total = shares.reduce(0, +)
        let usableHeight = max(0, area.height - gap * CGFloat(groups.count - 1))
        var out: [Int: CGRect] = [:]
        var y = area.minY
        for (i, row) in groups.enumerated() {
            let height = usableHeight * shares[i] / total
            let usableWidth = max(0, area.width - gap * CGFloat(row.count - 1))
            var x = area.minX
            for n in row {
                let width = usableWidth * weight(windows[n] ?? 0) / sums[i]
                out[n] = CGRect(x: x, y: y, width: width, height: height)
                x += width + gap
            }
            y += height + gap
        }
        return out
    }
}
