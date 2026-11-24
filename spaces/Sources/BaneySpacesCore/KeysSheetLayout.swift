import CoreGraphics
import Foundation

/// How the shortcut sheet lays the keymap out. Pure, so the split and the caps are tested without a screen.
public enum KeysSheetLayout {
    /// The groups in `count` columns, in keymap order, each column as short as it can be: a group goes to the column
    /// with the fewest rows so far, counting its heading as a row. A group never splits across columns.
    public static func columns(_ rows: [KeyBinding], count: Int) -> [[KeyBinding.Group]] {
        let n = max(1, count)
        var out = Array(repeating: [KeyBinding.Group](), count: n)
        var height = Array(repeating: 0, count: n)
        for group in KeyBinding.Group.allCases {
            let size = rows.filter { $0.group == group }.count
            guard size > 0 else { continue }
            let i = height.indices.min { height[$0] < height[$1] } ?? 0
            out[i].append(group)
            height[i] += size + 1
        }
        return out.filter { !$0.isEmpty }
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
