import Foundation

/// The sheet as the top bar and the Workspace Dock read it: one `StyleLookup` for a sheet, a mode and the theme's roles,
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

    /// A built-in module's class, the same as its surfaces.json id.
    public static func part(_ m: Surfaces.BarModule) -> String? {
        if case .custom = m { return nil }
        return m.id
    }

    // MARK: The dock

    public var dock: ComputedStyle { lookup.computed(surface: .dock) }

    public func tile(current: Bool, hover: Bool = false) -> ComputedStyle {
        lookup.computed(surface: .dock, part: "tile", states: Self.states(current: current, hover: hover))
    }

    public func label(current: Bool, hover: Bool = false) -> ComputedStyle {
        lookup.computed(surface: .dock, part: "label", states: Self.states(current: current, hover: hover))
    }

    public func badge(current: Bool, hover: Bool = false) -> ComputedStyle {
        lookup.computed(surface: .dock, part: "badge", states: Self.states(current: current, hover: hover))
    }

    public func icon(current: Bool, hover: Bool = false) -> ComputedStyle {
        lookup.computed(surface: .dock, part: "icon", states: Self.states(current: current, hover: hover))
    }
}

extension ComputedStyle {
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
