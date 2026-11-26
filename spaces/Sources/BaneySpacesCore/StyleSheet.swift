import Foundation

// Polycarp's style sheet (docs/style.md): `<config>/style.css`, a strict, documented subset of CSS that restyles the top
// bar on top of the theme. The theme sets colors, shape, type and motion everywhere; the sheet
// targets one surface or one part of it, and anything it doesn't set is the look the views draw today. Parsing is
// forgiving like CSS: a bad rule or declaration is dropped and reported with its line and column, and the rest applies.
// `StyleProperty.all` is the one table of properties: validation, the docs table and `style example` all read it.

// MARK: Values the views read

/// A color as four 0...1 channels, alpha last.
public struct StyleColor: Equatable, Hashable, Sendable {
    public var red: Double
    public var green: Double
    public var blue: Double
    public var alpha: Double

    public init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        func clamp(_ v: Double) -> Double { v.isFinite ? min(1, max(0, v)) : 0 }
        self.red = clamp(red); self.green = clamp(green); self.blue = clamp(blue); self.alpha = clamp(alpha)
    }

    /// From 0xRRGGBB.
    init(rgb v: UInt32, alpha: Double = 1) {
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255, alpha: alpha)
    }

    public init(_ rgb: RGB, alpha: Double = 1) { self.init(red: rgb.r, green: rgb.g, blue: rgb.b, alpha: alpha) }

    public static let clear = StyleColor(red: 0, green: 0, blue: 0, alpha: 0)

    /// "#rrggbb", or "#rrggbbaa" when it isn't opaque.
    public var hex: String {
        func byte(_ v: Double) -> Int { Int((v * 255).rounded()) }
        let rgb = String(format: "#%02x%02x%02x", byte(red), byte(green), byte(blue))
        return alpha >= 1 ? rgb : rgb + String(format: "%02x", byte(alpha))
    }

    /// This color laid over an opaque `base`: what the eye sees.
    public func over(_ base: StyleColor) -> StyleColor {
        StyleColor(red: red * alpha + base.red * (1 - alpha), green: green * alpha + base.green * (1 - alpha),
                   blue: blue * alpha + base.blue * (1 - alpha), alpha: 1)
    }

    /// WCAG relative luminance of the color channels (alpha ignored).
    var luminance: Double {
        func lin(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(red) + 0.7152 * lin(green) + 0.0722 * lin(blue)
    }

    /// WCAG contrast ratio, 1 to 21.
    public func contrast(with other: StyleColor) -> Double {
        let hi = max(luminance, other.luminance), lo = min(luminance, other.luminance)
        return (hi + 0.05) / (lo + 0.05)
    }
}

public enum StyleGradientDirection: String, Equatable, Sendable { case toBottom = "to bottom", toRight = "to right" }

public enum StyleBackground: Equatable, Sendable {
    /// Nothing drawn behind it.
    case none
    /// The platform's blur material.
    case glass
    case color(StyleColor)
    case linearGradient(StyleColor, StyleColor, StyleGradientDirection)
}

/// Padding in points, in CSS order.
public struct StyleInsets: Equatable, Sendable {
    public var top, right, bottom, left: Double
    public init(top: Double, right: Double, bottom: Double, left: Double) {
        self.top = top; self.right = right; self.bottom = bottom; self.left = left
    }
    /// The same on every side.
    public init(side: Double) { self.init(top: side, right: side, bottom: side, left: side) }
}

/// A border: `none`, or a solid line.
public enum StyleLine: Equatable, Sendable {
    case none
    case solid(width: Double, color: StyleColor)
}

public enum StyleShadow: Equatable, Sendable {
    case none
    case drop(x: Double, y: Double, blur: Double, color: StyleColor)
}

public enum StyleFontStyle: String, CaseIterable, Sendable { case normal, italic }
public enum StyleTextTransform: String, CaseIterable, Sendable { case none, uppercase, lowercase, capitalize }
public enum StyleNumerals: String, CaseIterable, Sendable { case normal, tabularNums = "tabular-nums" }
public enum StyleDisplay: String, CaseIterable, Sendable { case flex, none }

/// What the sheet says for one surface or part, resolved to concrete values: every color is RGBA, every length is in
/// points, `transitionDuration` is in seconds. Nil means the sheet doesn't set it, so the view draws what it draws today.
public struct ComputedStyle: Equatable, Sendable {
    public var color: StyleColor?
    public var background: StyleBackground?
    public var opacity: Double?
    /// The font stack, names in order (the theme's `type.ui` rules decide which one draws).
    public var fontFamily: [String]?
    public var fontSize: Double?
    /// 100 to 900.
    public var fontWeight: Double?
    public var fontStyle: StyleFontStyle?
    public var letterSpacing: Double?
    public var textTransform: StyleTextTransform?
    public var fontVariantNumeric: StyleNumerals?
    public var height: Double?
    public var width: Double?
    public var padding: StyleInsets?
    public var gap: Double?
    public var borderRadius: Double?
    public var border: StyleLine?
    public var borderBottom: StyleLine?
    public var boxShadow: StyleShadow?
    public var display: StyleDisplay?
    public var transitionDuration: Double?

    public init() {}

    public static let empty = ComputedStyle()
    public var isEmpty: Bool { self == .empty }
    /// `display: none`: the part is not drawn.
    public var isHidden: Bool { display == StyleDisplay.none }
}

// MARK: Problems

public struct StyleProblem: Equatable, Hashable, Sendable, CustomStringConvertible {
    public enum Severity: String, Sendable { case error, warning }
    /// 1-based; 0 when the problem is about no place in the file.
    public let line: Int
    public let column: Int
    public let severity: Severity
    public let message: String

    public init(line: Int, column: Int, severity: Severity = .error, message: String) {
        self.line = line; self.column = column; self.severity = severity; self.message = message
    }

    public var isError: Bool { severity == .error }
    public var description: String { "\(line):\(column): \(severity.rawValue): \(message)" }
}

// MARK: What a selector can name

public enum StyleSurface: String, CaseIterable, Sendable {
    case bar, launcher, tiling, switcher, overview, notifications, hud
    /// Surfaces an older build had. A rule that names one reads with a warning and is ignored.
    static let retired: [String: String] = ["dock": "went with the Workspace Dock (removed 2026-11-23)"]
}

/// A state a part can be in: the workspace you're on (`.current`), the one the keyboard is on (`.selected`) and the
/// pointer over it (`:hover`).
public enum StyleState: String, CaseIterable, Sendable {
    case current, selected, hover
    /// As written in a selector.
    public var selector: String { self == .hover ? ":hover" : ".\(rawValue)" }
}

/// One kind of thing a selector names. Properties say which of these they apply to.
public enum StyleTarget: String, CaseIterable, Sendable {
    case bar, barRegion = "bar region", barIsland = "bar island", barModule = "bar module", barWorkspace = "bar workspace"
    case launcher, launcherField = "launcher field", launcherSection = "launcher section", launcherRow = "launcher row",
         launcherTitle = "launcher title", launcherSubtitle = "launcher subtitle", launcherBadge = "launcher badge",
         launcherIcon = "launcher icon", launcherFooter = "launcher footer"
    case tiling
    case switcher, switcherItem = "switcher item", switcherNumber = "switcher number", switcherLabel = "switcher label",
         switcherIcon = "switcher icon", switcherHint = "switcher hint"
    case overview, overviewTile = "overview tile", overviewNumber = "overview number", overviewLabel = "overview label",
         overviewWindow = "overview window", overviewTitle = "overview title", overviewIcon = "overview icon", overviewHint = "overview hint"
    case notifications, notificationsHeading = "notifications heading", notificationsSection = "notifications section",
         notificationsIcon = "notifications icon", notificationsRow = "notifications row", notificationsTitle = "notifications title",
         notificationsText = "notifications text", notificationsTime = "notifications time", notificationsButton = "notifications button",
         notificationsFooter = "notifications footer"
    case hud, hudCell = "hud cell", hudLabel = "hud label", hudText = "hud text", hudIcon = "hud icon"

    /// The first word of its name.
    public var surface: StyleSurface { Self.names[self]!.surface }

    /// The class names it takes after its surface; empty for the surface itself.
    public var parts: [String] { Self.names[self]!.parts }

    /// Read off the raw values once: the cascade asks on every step.
    private static let names: [StyleTarget: (surface: StyleSurface, parts: [String])] = {
        Dictionary(uniqueKeysWithValues: allCases.map { t in (t, (StyleSurface(rawValue: String(t.rawValue.prefix { $0 != " " }))!, t.classes)) })
    }()
    private static let byName: [StyleSurface: [String: StyleTarget]] = {
        var all: [StyleSurface: [String: StyleTarget]] = [:]
        for t in allCases { for part in t.parts.isEmpty ? [""] : t.parts { all[t.surface, default: [:]][part] = t } }
        return all
    }()

    private var classes: [String] {
        switch self {
        case .barRegion: ["left", "center", "right"]
        case .barModule: Surfaces.BarModule.builtIn.map(\.id)
        // The rest of its name: "launcher row" is `launcher .row`, and "launcher" the surface itself.
        default: rawValue.split(separator: " ").dropFirst().map(String.init)
        }
    }

    public var states: [StyleState] {
        switch self {
        case .barModule: [.hover]
        case .barWorkspace: [.current, .hover]
        case .launcherRow: [.selected, .hover]
        case .launcherTitle, .launcherSubtitle, .launcherBadge, .launcherIcon: [.selected]
        case .switcherItem, .switcherNumber, .switcherLabel, .switcherIcon: [.selected]
        case .overviewTile: [.current, .hover]
        case .overviewNumber, .overviewLabel: [.current]
        case .notificationsRow, .notificationsTitle, .notificationsText, .notificationsButton: [.hover]
        case .hudCell: [.current]
        default: []
        }
    }

    /// The target it inherits from. A bar module inherits from its region when the caller names one, else from the bar; a
    /// workspace number from the workspaces module; what a row or a tile holds, from it in the same state.
    var parent: StyleTarget? {
        switch self {
        case .barIsland: .barRegion
        case .barWorkspace: .barModule
        case .launcherTitle, .launcherSubtitle, .launcherBadge, .launcherIcon: .launcherRow
        case .switcherNumber, .switcherLabel, .switcherIcon: .switcherItem
        case .overviewNumber, .overviewLabel, .overviewWindow: .overviewTile
        case .overviewTitle, .overviewIcon: .overviewWindow
        case .notificationsTitle, .notificationsText, .notificationsTime: .notificationsRow
        case .notificationsIcon: .notificationsSection
        // A surface inherits from nothing, its other parts from it.
        default: parts.isEmpty ? nil : StyleTarget.of(surface, part: nil)
        }
    }

    /// What it is, for the docs and `style example`.
    public var help: String {
        switch self {
        case .bar: "The top bar itself."
        case .barRegion: "The bar's three regions; modules inherit text properties from their region."
        case .barIsland: "One island of modules when bar.style is islands: its background, corners, line, shadow, padding and gap. Text inside takes its region's and module's styles."
        case .barModule: "One class for each bar module (surfaces.json bar.modules); :hover while the pointer is on it."
        case .barWorkspace: "One number in the workspaces module; .current is the workspace you're on, :hover the one under the pointer."
        case .launcher: "The launcher's panel. gap is the space between rows."
        case .launcherField: "The search field across the top, with the magnifying glass beside it. border-bottom takes the place of the line under it."
        case .launcherSection: "A heading over a group of results."
        case .launcherRow: "One result; .selected is the one Return opens, :hover the one under the pointer. A border on .row.selected takes the place of the accent mark beside it."
        case .launcherTitle: "A result's name; .selected while its row is."
        case .launcherSubtitle: "The line under a result's name; .selected while its row is."
        case .launcherBadge: "A result's word at the right (Install, Installed); .selected while its row is."
        case .launcherIcon: "A result's picture, and the color of a symbol; .selected while its row is."
        case .launcherFooter: "The key hints along the bottom. border takes the place of the line over it."
        case .tiling: "The outline of where a dragged tiled window would go."
        case .switcher: "The ⌘Tab panel. gap is the space between tiles."
        case .switcherItem: "One app, window or workspace in it; .selected is the one letting go lands on."
        case .switcherNumber: "A workspace's number, when ⌘Tab steps through workspaces; .selected while its tile is."
        case .switcherLabel: "The name under an app, a window's title or a workspace's window count; .selected while its tile is."
        case .switcherIcon: "An app's icon; .selected while its tile is."
        case .switcherHint: "The line under the apps, and the words beside a window bar's heading."
        case .overview: "The overview of every workspace; its background takes the place of the blur and the dimming behind the tiles."
        case .overviewTile: "One workspace, an empty one's small tile too; .current is the one you're on, :hover the one under the pointer or the arrow keys. A tile a window can be dropped on keeps the theme's highlight."
        case .overviewNumber: "A workspace's number; .current on the one you're on."
        case .overviewLabel: "A tile's window count, \"You're here\" and \"Empty\"; .current on the one you're on."
        case .overviewWindow: "A window's card in a tile, and its app's name."
        case .overviewTitle: "The window's title under its app's name."
        case .overviewIcon: "The app's icon in a card."
        case .overviewHint: "The line of keys along the bottom."
        case .notifications: "The list the bell in the bar opens. gap is the space between notifications."
        case .notificationsHeading: "The word at the top."
        case .notificationsSection: "An app's name over its notifications."
        case .notificationsIcon: "The app's icon beside its name."
        case .notificationsRow: "One notification; :hover the one under the pointer."
        case .notificationsTitle: "A notification's first line; :hover while its row is."
        case .notificationsText: "The lines under it, and what the empty list says; :hover while its row is."
        case .notificationsTime: "When it came."
        case .notificationsButton: "Clear all, Notification Center, Settings and the small symbols; :hover under the pointer."
        case .notificationsFooter: "The strip along the bottom. border takes the place of the line over it."
        case .hud: "The small notices: the workspace you switched to (Settings turns it on), toasts, and an agent's notice. gap is the space between the grid's cells."
        case .hudCell: "One workspace in the grid; .current is the one you switched to."
        case .hudLabel: "The main line: the workspace's name, a toast's message, what an agent wants."
        case .hudText: "The quieter words: Empty, the line under an agent's notice and its shortcut."
        case .hudIcon: "The apps' icons, and the color of a toast's symbol."
        }
    }

    /// Every state that can change what it looks like: its own and those of what it inherits from.
    var reach: Set<StyleState> { Set(states).union(parent?.reach ?? []) }

    /// Every selector form, as the docs show it: `bar .left`, `bar .center`, `bar .right`.
    public var selectors: [String] {
        let s = surface.rawValue
        return parts.isEmpty ? [s] : parts.map { "\(s) .\($0)" }
    }

    static func of(_ surface: StyleSurface, part: String?) -> StyleTarget? {
        byName[surface]?[part ?? ""]
    }
}

/// A selector the sheet understands: `:root`, a surface, or a surface and one part with its states.
public struct StyleSelector: Hashable, Sendable, CustomStringConvertible {
    /// Nil for `:root`.
    public let surface: StyleSurface?
    public let part: String?
    public let states: Set<StyleState>

    public init(surface: StyleSurface?, part: String? = nil, states: Set<StyleState> = []) {
        self.surface = surface; self.part = part; self.states = states
    }

    public static let root = StyleSelector(surface: nil)
    public var isRoot: Bool { surface == nil }
    /// CSS specificity with no ids: the classes and pseudo-classes (the type selector ties every rule).
    var specificity: Int { (part == nil ? 0 : 1) + states.count }
    var target: StyleTarget? { surface.flatMap { StyleTarget.of($0, part: part) } }

    /// The canonical form: `bar .workspace.current:hover`.
    public var description: String {
        guard let surface else { return ":root" }
        guard let part else { return surface.rawValue }
        return "\(surface.rawValue) .\(part)" + StyleState.allCases.filter(states.contains).map(\.selector).joined()
    }
}

// MARK: The property table

/// What a property takes.
enum StyleValueKind: Sendable {
    case color, background, opacity, fontFamily, fontWeight, padding, line, shadow, time
    case length(ClosedRange<Double>)
    /// `normal` (0) or a length.
    case spacing(ClosedRange<Double>)
    case keywords([String])

    var takes: String {
        switch self {
        case .color: "a color"
        case .background: "a color, `none`, `glass` (the platform's blur) or `linear-gradient(<color>, <color>)`, optionally starting `to bottom,` or `to right,`"
        case .opacity: "a number from 0 to 1, or a percentage"
        case .fontFamily: "a font stack, as the theme's `type.ui`: names separated by commas, quoted when they hold other characters"
        case .fontWeight: "100 to 900, `normal` (400) or `bold` (700)"
        case .padding: "1 to 4 lengths from 0 to 40, in CSS order (top, right, bottom, left)"
        case .line: "`none` or `<width 0 to 8> solid <color>`"
        case .shadow: "`none` or `<x> <y> <blur> <color>` (x and y -40 to 40, blur 0 to 64)"
        case .time: "0 to 2000 `ms`, or the same in `s`"
        case .length(let r): "a length from \(StyleNumber.text(r.lowerBound)) to \(StyleNumber.text(r.upperBound)) (`px` or `pt`)"
        case .spacing(let r): "`normal` or a length from \(StyleNumber.text(r.lowerBound)) to \(StyleNumber.text(r.upperBound)) (`px` or `pt`)"
        case .keywords(let k): StyleNumber.list(k.map { "`\($0)`" }, last: "or")
        }
    }
}

public struct StyleProperty: Sendable {
    public let name: String
    let kind: StyleValueKind
    public let targets: [StyleTarget]
    /// Passed from the surface and region down to the part when the part doesn't set it.
    public let inherited: Bool
    public let help: String
    /// A value `style example` and the docs show.
    public let example: String

    public var takes: String { kind.takes }

    init(_ name: String, _ kind: StyleValueKind, _ targets: [StyleTarget], inherited: Bool = false, _ help: String, example: String) {
        self.name = name; self.kind = kind; self.targets = targets; self.inherited = inherited; self.help = help; self.example = example
    }

    public func applies(to target: StyleTarget) -> Bool { targets.contains(target) }

    /// What a part takes, and the inherited properties it only passes on, worked out once: the cascade asks on every step.
    static let of: [StyleTarget: (taken: [StyleProperty], passed: [StyleProperty])] = Dictionary(uniqueKeysWithValues: StyleTarget.allCases.map { t in
        (t, (all.filter { $0.applies(to: t) }, all.filter { $0.inherited && !$0.applies(to: t) }))
    })

    /// Everything that draws text, with letters the view spaces and cases itself.
    static let texts: [StyleTarget] = [.bar, .barRegion, .barModule, .barWorkspace,
                                       .launcher, .launcherSection, .launcherRow, .launcherTitle, .launcherSubtitle, .launcherBadge, .launcherFooter,
                                       .switcher, .switcherItem, .switcherNumber, .switcherLabel, .switcherHint,
                                       .overview, .overviewTile, .overviewNumber, .overviewLabel, .overviewWindow, .overviewTitle, .overviewHint,
                                       .notifications, .notificationsHeading, .notificationsSection, .notificationsRow, .notificationsTitle,
                                       .notificationsText, .notificationsTime, .notificationsButton, .notificationsFooter,
                                       .hud, .hudCell, .hudLabel, .hudText]
    /// Text with letters in it.
    static let letters = texts.filter { ![.switcherNumber, .overviewNumber, .hudCell].contains($0) }
    /// A font too, but the system's text field draws it.
    static let fonts = texts + [.launcherField]
    /// Everything with a fill of its own.
    static let boxes: [StyleTarget] = [.bar, .barRegion, .barIsland, .barModule, .barWorkspace,
                                       .launcher, .launcherField, .launcherSection, .launcherRow, .launcherBadge, .launcherFooter,
                                       .switcher, .switcherItem, .overview, .overviewTile, .overviewWindow, .overviewHint,
                                       .notifications, .notificationsSection, .notificationsRow, .notificationsButton, .notificationsFooter,
                                       .hud, .hudCell]
    /// The whole screen, so it has no edge to draw.
    static let edged = boxes.filter { $0 != .overview }
    /// The fills whose size is their own: nothing to pad.
    static let padded = edged.filter { ![.switcherItem, .overviewWindow, .notificationsButton, .hudCell].contains($0) }

    public static let all: [StyleProperty] = [
        StyleProperty("color", .color, fonts + [.launcherIcon, .hudIcon], inherited: true, "Text and symbol color.", example: "var(--foreground)"),
        StyleProperty("background", .background, boxes + [.tiling], "What is drawn behind it.", example: "glass"),
        StyleProperty("opacity", .opacity, StyleTarget.allCases, "How opaque the whole thing is.", example: "1"),
        StyleProperty("font-family", .fontFamily, fonts, inherited: true, "The font, first installed name wins; `monospace` and `serif` are the system's.",
                      example: "system-ui, sans-serif"),
        StyleProperty("font-size", .length(6...40), fonts, inherited: true, "Text size in points.", example: "12px"),
        StyleProperty("font-weight", .fontWeight, fonts, inherited: true, "Text weight.", example: "500"),
        StyleProperty("font-style", .keywords(StyleFontStyle.allCases.map(\.rawValue)), fonts, inherited: true, "Upright or italic text.", example: "normal"),
        StyleProperty("letter-spacing", .spacing(-2...10), texts, inherited: true, "Extra space between letters.", example: "normal"),
        StyleProperty("text-transform", .keywords(StyleTextTransform.allCases.map(\.rawValue)), letters, inherited: true,
                      "Letter case, whatever the text says.", example: "none"),
        StyleProperty("font-variant-numeric", .keywords(StyleNumerals.allCases.map(\.rawValue)), texts, inherited: true,
                      "`tabular-nums` gives every digit the same width, so a clock doesn't jiggle.", example: "tabular-nums"),
        StyleProperty("width", .length(480...1200), [.launcher], "The panel's width (never wider than the screen).", example: "700px"),
        StyleProperty("height", .length(18...64), [.bar, .launcherRow],
                      "The bar's height (on a screen with a notch the bar fills the strip beside it), or a row's: its icon shrinks to fit, and a subtitle with no room goes.",
                      example: "28px"),
        StyleProperty("padding", .padding, padded, "Space inside the edge.", example: "0 8px"),
        StyleProperty("gap", .length(0...40), [.bar, .barRegion, .barIsland, .barModule, .launcher, .launcherRow, .switcher, .notifications, .hud],
                      "Space between modules (bar, a region, an island), between a module's items (workspace numbers, menus, status items), between rows, tiles or cells (a panel) or between an icon and its text (a row).",
                      example: "8px"),
        StyleProperty("border-radius", .length(0...40), edged + [.launcherIcon, .tiling, .switcherIcon, .overviewIcon, .notificationsIcon, .hudIcon], "Corner radius.", example: "6px"),
        StyleProperty("border", .line, edged + [.tiling], "A line all around.", example: "1px solid var(--border)"),
        StyleProperty("border-bottom", .line, [.bar, .barRegion, .barModule, .barWorkspace, .launcher, .launcherField, .launcherSection, .launcherRow,
                                              .switcher, .switcherItem, .overviewTile, .overviewWindow, .notifications, .notificationsSection, .notificationsRow, .hud, .hudCell],
                      "A line along the bottom edge only.", example: "1px solid var(--border)"),
        StyleProperty("box-shadow", .shadow, [.barIsland], "A drop shadow.", example: "0 4px 12px rgba(0, 0, 0, 0.3)"),
        StyleProperty("display", .keywords(StyleDisplay.allCases.map(\.rawValue)),
                      [.barRegion, .barIsland, .barModule, .barWorkspace, .launcherSection, .launcherSubtitle, .launcherBadge, .launcherIcon, .launcherFooter,
                       .switcherLabel, .switcherIcon, .switcherHint, .overviewLabel, .overviewTitle, .overviewIcon, .overviewHint,
                       .notificationsIcon, .notificationsTime, .hudText, .hudIcon],
                      "`none` hides it; `flex` (the default) shows it.", example: "flex"),
        StyleProperty("transition-duration", .time, [.barModule, .barWorkspace, .launcherRow, .switcherItem, .overviewTile, .notificationsRow, .notificationsButton],
                      "How long a change of state (hover, current, selected) fades its colors and lines.", example: "150ms"),
    ]

    public static let byName: [String: StyleProperty] = Dictionary(uniqueKeysWithValues: all.map { ($0.name, $0) })

    /// The theme's roles, each a predefined custom property (`var(--accent)`).
    public static let roles = ["background", "surface", "sunken", "foreground", "strong", "muted", "border", "accent", "on-accent",
                               "selection", "urgent", "working", "done"]
}

/// Numbers and lists as the docs and messages write them.
enum StyleNumber {
    static func text(_ v: Double) -> String {
        if v.rounded() == v, abs(v) < 1e15 { return String(Int(v)) }
        var s = String(format: "%.3f", v)
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return s
    }

    static func list(_ items: [String], last word: String) -> String {
        switch items.count {
        case 0: return ""
        case 1: return items[0]
        default: return items.dropLast().joined(separator: ", ") + " \(word) " + items.last!
        }
    }
}

// MARK: The sheet

/// One rule that survived parsing: its selectors, its `@media` mode (nil for both) and its declarations in order.
struct StyleRule: Equatable, Sendable {
    let selectors: [StyleSelector]
    let media: StyleMedia?
    let declarations: [StyleDeclaration]
}

enum StyleMedia: String, Equatable, Sendable {
    case dark, light
    func matches(dark: Bool) -> Bool { (self == .dark) == dark }
}

struct StyleDeclaration: Equatable, Sendable {
    let property: String
    /// The typed value, when it holds no `var()`; else nil and `tokens` is resolved when a mode and roles are known.
    let value: StyleValue?
    let tokens: [StyleToken]
    let line: Int
    let column: Int
}

public struct StyleSheet: Equatable, Sendable {
    let rules: [StyleRule]
    /// Custom properties from `:root`, by mode, as written (later wins).
    let customLight: [String: [StyleToken]]
    let customDark: [String: [StyleToken]]

    public static let empty = StyleSheet(rules: [], customLight: [:], customDark: [:])

    /// True when no rule sets anything: the views draw exactly what they draw without a sheet.
    public var isEmpty: Bool { rules.allSatisfy { $0.declarations.isEmpty || $0.selectors.allSatisfy(\.isRoot) } }
    /// The rules that parsed, `:root` included.
    public var ruleCount: Int { rules.count }

    /// Reads a sheet. Never fails: what can't be used is left out and listed in `problems`, sorted by place.
    public static func parse(_ text: String) -> (sheet: StyleSheet, problems: [StyleProblem]) {
        StyleSheetBuilder.build(text)
    }

    /// The style for one surface (`part` nil), one region (`part` "left", "center" or "right") or one part (`part` a bar
    /// module id, "workspace" or "island") in `states`, for dark or light mode, with `roles` (keys as
    /// `StyleProperty.roles`: "accent", "on-accent") standing for the theme in force. A bar module inherits from its
    /// `region` when given. A part this build doesn't know is the empty style.
    public func computed(surface: StyleSurface, part: String? = nil, region: String? = nil, states: Set<StyleState> = [],
                         dark: Bool, roles: [String: StyleColor]) -> ComputedStyle {
        guard !rules.isEmpty else { return .empty }
        return StyleLookup(self, dark: dark, roles: roles).computed(surface: surface, part: part, region: region, states: states)
    }
}

extension StyleSheet {
    /// The theme's colors as the roles `computed` takes: palette role names (`on_accent` is written `on-accent`), and
    /// `on-accent` from `onAccent`, else black or white, whichever reads on the accent.
    public static func roles(_ colors: [String: RGB], onAccent: RGB? = nil) -> [String: StyleColor] {
        var out: [String: StyleColor] = [:]
        for (k, v) in colors { out[k.replacingOccurrences(of: "_", with: "-")] = StyleColor(v) }
        if let a = onAccent { out["on-accent"] = StyleColor(a) } else if out["on-accent"] == nil, let accent = colors["accent"] {
            out["on-accent"] = StyleColor(accent.bestText)
        }
        return out
    }
}
