import CoreGraphics
import Foundation

/// How the shortcut sheet lays the keymap out. Pure, so the split and the caps are tested without a screen.
public enum KeysSheetLayout {
    /// One group's rows in one column. A group too long for a column goes on in the next, under its heading again.
    public struct Piece: Equatable {
        public let group: KeyBinding.Group
        public let rows: [KeyBinding]
        /// Not the group's first piece: its heading says it goes on.
        public let continued: Bool

        public init(group: KeyBinding.Group, rows: [KeyBinding], continued: Bool) {
            (self.group, self.rows, self.continued) = (group, rows, continued)
        }
    }

    /// How tall a row is next to a heading: a row with a line under it (where it works, or a note) is taller.
    static func weight(_ b: KeyBinding) -> Double { b.scope == .global && b.note == nil ? 1 : 1.6 }
    static let headingWeight = 1.4

    /// The rows in at most `count` columns, in keymap order, filled one after another, as short as the columns can be. A
    /// group that fits in a column is never split: it starts the next column when the rest of this one is too short. A
    /// longer group goes on in the next column.
    public static func pieces(_ rows: [KeyBinding], count: Int) -> [[Piece]] {
        let n = max(1, count)
        let groups = KeyBinding.Group.allCases.map { g in (g, rows.filter { $0.group == g }) }.filter { !$0.1.isEmpty }
        let total = groups.reduce(0.0) { $0 + headingWeight + $1.1.reduce(0) { $0 + weight($1) } }
        // The shortest height that takes every row in n columns, in steps of a fifth of a row.
        var height = total / Double(n)
        while true {
            let columns = fill(groups, height: height)
            if columns.count <= n || height >= total { return columns }
            height += 0.2
        }
    }

    /// Fills columns of at most `height` (a column holds at least a heading and one row), as many as it takes.
    private static func fill(_ groups: [(KeyBinding.Group, [KeyBinding])], height limit: Double) -> [[Piece]] {
        var out: [[Piece]] = [[]]
        var height = 0.0
        func nextColumn() { out.append([]); height = 0 }
        for (group, list) in groups {
            let whole = headingWeight + list.reduce(0) { $0 + weight($1) }
            if height > 0, height + whole > limit, whole <= limit { nextColumn() }
            var piece: [KeyBinding] = [], continued = false
            height += headingWeight
            for b in list {
                if height + weight(b) > limit, !piece.isEmpty {
                    out[out.count - 1].append(Piece(group: group, rows: piece, continued: continued))
                    (piece, continued) = ([], true)
                    nextColumn()
                    height = headingWeight
                } else if height + weight(b) > limit, piece.isEmpty, height > headingWeight {
                    // Only the heading would be left at the foot of this column: it starts the next one.
                    nextColumn()
                    height = headingWeight
                }
                piece.append(b)
                height += weight(b)
            }
            out[out.count - 1].append(Piece(group: group, rows: piece, continued: continued))
        }
        return out.filter { !$0.isEmpty }
    }

    /// Which column count shrinks the sheet least, given its size laid out in each: the fewest columns among the best.
    public static func bestCount(_ sizes: [(count: Int, size: CGSize)], in area: CGSize, margin: CGFloat = 16) -> Int {
        var best: (count: Int, scale: CGFloat)?
        for (count, size) in sizes.sorted(by: { $0.count < $1.count }) {
            let scale = fitScale(size, in: area, margin: margin)
            if best.map({ scale > $0.scale + 0.001 }) ?? true { best = (count, scale) }
        }
        return best?.count ?? 3
    }

    /// The keys as separate caps, the way a keyboard shows them: ["⌃", "⌘", "K"]. The Polycarp modifier becomes one
    /// cap per key it holds (⌃⌥ is two), and "hold mod" reads "hold" then the modifier's caps.
    public static func caps(_ b: KeyBinding, modifier: String) -> [String] {
        let mod = modifier.map(String.init)
        return b.keys.flatMap { token -> [String] in
            if token == "mod" { return mod }
            if let symbol = KeyBinding.modifierSymbols[token] { return [symbol] }
            guard token.contains(" ") else { return [token] }
            return token.split(separator: " ").flatMap { $0 == "mod" ? mod : [String($0)] }
        }
    }

    /// How much the sheet shrinks to fit `area` with `margin` on every side: 1 when it fits, never more. The sheet
    /// ignores the mouse, so nothing off screen could be scrolled into view.
    public static func fitScale(_ content: CGSize, in area: CGSize, margin: CGFloat = 16) -> CGFloat {
        guard content.width > 0, content.height > 0 else { return 1 }
        let w = max(1, area.width - 2 * margin), h = max(1, area.height - 2 * margin)
        return min(1, w / content.width, h / content.height)
    }
}
