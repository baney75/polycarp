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
    public private(set) lazy var switcher = SwitcherStyles(lookup)
    public private(set) lazy var overview = OverviewStyles(lookup)
    public private(set) lazy var notifications = NotificationsStyles(lookup)
}

/// The list the bell opens.
public final class NotificationsStyles {
    /// A notification and what it holds, under the pointer or not.
    public final class Row {
        public let box, title, text, time: ComputedStyle
        /// The sheet marks this state itself (`ComputedStyle.marks`).
        public let marked: Bool

        init(_ l: StyleLookup, _ states: Set<StyleState>) {
            func part(_ name: String) -> ComputedStyle { l.computed(surface: .notifications, part: name, states: states) }
            box = part("row"); title = part("title"); text = part("text"); time = part("time")
            marked = box.marks(over: l.computed(surface: .notifications, part: "row"))
        }
    }

    public let panel, heading, section, icon, footer: ComputedStyle
    /// What the sheet's padding and larger text add to the panel's height above and below the list.
    public let more: Double
    private let rows: [Row]
    private let buttons: [ComputedStyle]

    init(_ l: StyleLookup) {
        func part(_ name: String, _ states: Set<StyleState> = []) -> ComputedStyle { l.computed(surface: .notifications, part: name, states: states) }
        panel = l.computed(surface: .notifications)
        heading = part("heading"); section = part("section"); icon = part("icon"); footer = part("footer")
        rows = [Row(l, []), Row(l, [.hover])]
        buttons = [part("button"), part("button", [.hover])]
        func down(_ c: ComputedStyle, _ own: Double) -> Double { c.padding.map { max(0, $0.top + $0.bottom - own) } ?? 0 }
        func grown(_ c: ComputedStyle, _ own: Double) -> Double { max(0, (c.fontSize ?? own) - own) * 1.3 }
        more = down(panel, 0) + down(footer, 8) + grown(heading, 14) + grown(footer, 12) + buttons.map { grown($0, 12) }.max()!
    }

    public func row(hover: Bool) -> Row { rows[hover ? 1 : 0] }
    public func button(hover: Bool) -> ComputedStyle { buttons[hover ? 1 : 0] }
}

/// The overview of every workspace.
public final class OverviewStyles {
    /// A tile and what it holds, in one state.
    public final class Tile {
        public let box, number, label, window, title, icon: ComputedStyle
        /// The sheet marks this state itself (`ComputedStyle.marks`).
        public let marked: Bool
        /// A tile a window can be dropped on: its corners, and nothing else of the sheet's over the theme's highlight.
        public let target: ComputedStyle

        init(_ l: StyleLookup, _ states: Set<StyleState>) {
            func part(_ name: String) -> ComputedStyle { l.computed(surface: .overview, part: name, states: states) }
            box = part("tile"); number = part("number"); label = part("label")
            window = part("window"); title = part("title"); icon = part("icon")
            marked = box.marks(over: l.computed(surface: .overview, part: "tile"))
            var t = ComputedStyle()
            t.borderRadius = box.borderRadius
            target = t
        }
    }

    public let panel, hint: ComputedStyle
    private let tiles: [Tile]

    init(_ l: StyleLookup) {
        panel = l.computed(surface: .overview)
        hint = l.computed(surface: .overview, part: "hint")
        tiles = [[], [.current], [.hover], [.current, .hover]].map { Tile(l, $0) }
    }

    public func tile(current: Bool, hover: Bool) -> Tile { tiles[(current ? 1 : 0) + (hover ? 2 : 0)] }
}

/// The ⌘Tab panel.
public final class SwitcherStyles {
    /// A tile and what it holds, selected or not.
    public final class Item {
        public let box, number, label, icon: ComputedStyle
        /// The sheet marks this state itself (`ComputedStyle.marks`).
        public let marked: Bool

        init(_ l: StyleLookup, _ states: Set<StyleState>) {
            func part(_ name: String) -> ComputedStyle { l.computed(surface: .switcher, part: name, states: states) }
            box = part("item"); number = part("number"); label = part("label"); icon = part("icon")
            marked = box.marks(over: l.computed(surface: .switcher, part: "item"))
        }
    }

    public let panel, hint: ComputedStyle
    /// No rule names the switcher.
    public let plain: Bool
    public let padding: StyleInsets
    /// Between workspace tiles.
    public let gap: Double
    /// A workspace tile's height: what the sheet's larger text adds, in either state, so no tile moves with the selection.
    public let tileHeight: Double
    /// What one line of a window card's title grows by with the sheet's text.
    public let titleGrowth: Double
    private let items: [Item]

    init(_ l: StyleLookup) {
        plain = !l.named.contains(.switcher)
        panel = l.computed(surface: .switcher)
        hint = l.computed(surface: .switcher, part: "hint")
        padding = panel.padding ?? StyleInsets(side: SwitcherLayout.padding / 2)
        gap = panel.gap ?? SwitcherLayout.spacing
        let items = [Item(l, []), Item(l, [.selected])]
        func more(_ part: KeyPath<Item, ComputedStyle>, over own: Double) -> Double {
            max(0, (items.compactMap { $0[keyPath: part].fontSize }.max() ?? 0) - own) * 1.2
        }
        tileHeight = SwitcherLayout.tileHeight + more(\.number, over: 34) + more(\.label, over: 10)
        titleGrowth = more(\.label, over: 12)
        self.items = items
    }

    public func item(selected: Bool) -> Item { items[selected ? 1 : 0] }

    /// The panel for this many workspace tiles, with the sheet's padding, gap and text.
    public func panelSize(tileCount: Int, maxWidth: Double) -> CGSize {
        SwitcherLayout.panelSize(tileCount: tileCount, maxWidth: maxWidth, tileHeight: tileHeight, spacing: gap,
                                 across: padding.left + padding.right, down: padding.top + padding.bottom)
    }

    /// The window cards with the sheet's gap, padding and text; its `size` is the panel's.
    public func grid(count: Int, maxWidth: Double, maxHeight: Double) -> WindowGrid {
        .fit(count: count, maxWidth: maxWidth, maxHeight: maxHeight, gap: panel.gap ?? WindowGrid.spacing,
             across: padding.left + padding.right, down: padding.top + padding.bottom, taller: titleGrowth)
    }

    public func columns(tileCount: Int, maxWidth: Double) -> Int {
        SwitcherLayout.workspaceColumns(tileCount: tileCount, maxWidth: maxWidth, spacing: gap, padding: padding.left + padding.right)
    }

    /// App tiles 104 wide in as many columns as fit, eight at most.
    public func appColumns(count: Int, maxWidth: Double) -> Int {
        min(8, SwitcherLayout.workspaceColumns(tileCount: count, maxWidth: maxWidth, tileWidth: 104, spacing: panel.gap ?? 8,
                                               padding: padding.left + padding.right))
    }
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
