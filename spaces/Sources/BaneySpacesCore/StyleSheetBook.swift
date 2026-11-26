import Foundation

/// The sheet as the views read it: one `StyleLookup` for a sheet, a mode and the theme's roles,
/// so each part's style is worked out once per change and kept, never once per frame. Nil in a `ComputedStyle` still
/// means the view draws what it drew before the sheet, so an empty sheet changes nothing. Not thread safe: the app
/// keeps one on the main thread and builds a new one when the sheet or the theme changes.
public final class StyleBook {
    public let lookup: StyleLookup
    public var sheet: StyleSheet { lookup.sheet }
    public var dark: Bool { lookup.dark }
    public var roles: [String: StyleColor] { lookup.roles }

    public init(_ sheet: StyleSheet, dark: Bool, roles: [String: StyleColor]) {
        lookup = StyleLookup(sheet, dark: dark, roles: roles)
    }

    public static let empty = StyleBook(.empty, dark: true, roles: [:])

    /// The bar's three regions, as selectors name them.
    public enum Region: String, CaseIterable, Sendable { case left, center, right }

    private static func states(current: Bool, hover: Bool) -> Set<StyleState> {
        var s: Set<StyleState> = []
        if current { s.insert(.current) }
        if hover { s.insert(.hover) }
        return s
    }

    // MARK: The bar

    public var bar: ComputedStyle { lookup.computed(surface: .bar) }

    /// The bar's height: the sheet's, else `fallback` (surfaces.json `bar.height`).
    public func barHeight(_ fallback: Double) -> Double { bar.height ?? fallback }

    public func region(_ r: Region) -> ComputedStyle { lookup.computed(surface: .bar, part: r.rawValue) }

    /// A module where it sits, inheriting text from its region and the bar. A custom module has no class: the empty style.
    public func module(_ m: Surfaces.BarModule, in region: Region, hover: Bool = false) -> ComputedStyle {
        guard let part = Self.part(m) else { return .empty }
        return lookup.computed(surface: .bar, part: part, region: region.rawValue, states: hover ? [.hover] : [])
    }

    /// One number in the workspaces module. `hover` is the pointer on that number; the module counts as hovered with it.
    public func workspace(in region: Region, current: Bool, hover: Bool = false) -> ComputedStyle {
        lookup.computed(surface: .bar, part: "workspace", region: region.rawValue, states: Self.states(current: current, hover: hover))
    }

    /// One island of modules (bar.style islands), in the region it sits in.
    public func island(in region: Region) -> ComputedStyle {
        lookup.computed(surface: .bar, part: "island", region: region.rawValue)
    }

    /// A built-in module's class, the same as its surfaces.json id.
    public static func part(_ m: Surfaces.BarModule) -> String? {
        switch m {
        case .custom, .split: nil
        default: m.id
        }
    }

    // MARK: Tiling

    /// The outline of where a dragged tiled window would go.
    public var outline: ComputedStyle { lookup.computed(surface: .tiling) }

    // MARK: The other surfaces
    //
    // A panel opens on a key press, so everything it can need is worked out once for the book, at the first open, and
    // read from there: no row asks the cascade anything.

    public private(set) lazy var launcher = LauncherStyles(lookup)
}

/// The launcher, every part in every state.
public final class LauncherStyles {
    /// A row and what it holds, in one state. A class, so a view takes a reference and copies nothing.
    public final class Row {
        public let box, title, subtitle, badge, icon: ComputedStyle
        /// The sheet marks this state itself (`ComputedStyle.marks`).
        public let marked: Bool

        init(_ l: StyleLookup, _ states: Set<StyleState>) {
            func part(_ name: String) -> ComputedStyle { l.computed(surface: .launcher, part: name, states: states) }
            box = part("row"); title = part("title"); subtitle = part("subtitle"); badge = part("badge"); icon = part("icon")
            marked = box.marks(over: l.computed(surface: .launcher, part: "row", states: states.subtracting([.selected])))
        }

        fileprivate var all: [ComputedStyle] { [box, title, subtitle, badge, icon] }
    }

    public let panel, field, section, footer: ComputedStyle
    /// No rule names the launcher.
    public let plain: Bool
    /// A rule changes something under the pointer, so rows watch for it.
    public let hovers: Bool
    private let rows: [Row]

    init(_ l: StyleLookup) {
        plain = !l.named.contains(.launcher)
        panel = l.computed(surface: .launcher)
        field = l.computed(surface: .launcher, part: "field")
        section = l.computed(surface: .launcher, part: "section")
        footer = l.computed(surface: .launcher, part: "footer")
        rows = [[], [.selected], [.hover], [.selected, .hover]].map { Row(l, $0) }
        hovers = rows[0].all != rows[2].all || rows[1].all != rows[3].all
    }

    public func row(selected: Bool, hover: Bool = false) -> Row { rows[(selected ? 1 : 0) + (hover ? 2 : 0)] }
}

extension ComputedStyle {
    /// The sheet's rules for a state change the box, so it carries the sheet's mark. Until they do, the theme's own mark of
    /// the state (a selected row's fill, a tile's ring) is drawn over the part's box: a sheet never hides which row is
    /// selected by painting them all.
    public func marks(over plain: ComputedStyle) -> Bool {
        background != plain.background || border != plain.border || borderBottom != plain.borderBottom
    }

    /// `text` as `text-transform` says.
    public func cased(_ text: String) -> String {
        switch textTransform {
        case .uppercase?: text.uppercased()
        case .lowercase?: text.lowercased()
        case .capitalize?: text.split(separator: " ", omittingEmptySubsequences: false)
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
        case .none?, nil: text
        }
    }

    /// Sets any of padding, background, a border, a corner radius or a shadow: the part draws a box of its own.
    public var hasBox: Bool {
        padding != nil || background != nil || border != nil || borderBottom != nil || borderRadius != nil || boxShadow != nil
    }

    /// Sets any font property, so the view builds its font from the sheet over its own.
    public var hasFont: Bool { fontFamily != nil || fontSize != nil || fontWeight != nil || fontStyle != nil }
}
