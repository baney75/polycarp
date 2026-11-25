import AppKit
import BaneySpacesCore
import SwiftUI

/// The style sheet in force (`StyleSheetStore`, docs/style.md) as the surfaces draw it: one
/// `StyleBook` for the sheet, the mode and the theme's roles, rebuilt only when one of them changes. Every value the
/// sheet leaves out falls back to what the view drew before (through `Chrome`), so with no sheet nothing changes. This
/// file is where sheet values become SwiftUI colors, fonts and shapes; the surface files ask it as they ask `Chrome`.
/// Main thread only.
final class Styles: ObservableObject {
    static let shared = Styles()
    @Published private(set) var book = StyleBook.empty
    private var observers: [NSObjectProtocol] = []

    private init() {
        sync()
        for name in [StyleSheetStore.didChange, Appearance.didChange] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.sync() })
        }
    }

    /// Builds a new book when the sheet, the mode or the roles changed, and does nothing otherwise, so any observer of
    /// those changes may call it first and read the new one.
    func sync() { show(StyleSheetStore.shared.current) }

    /// `sync` with this sheet (the renders draw sheets no file holds).
    func show(_ sheet: StyleSheet) {
        let look = Chrome.look
        let dark = look.palette.isDark
        let roles = StyleSheet.roles(look.palette.colors, onAccent: look.text(onAccent: Appearance.shared.accentRGB))
        guard sheet != book.sheet || dark != book.dark || roles != book.roles else { return }
        book = StyleBook(sheet, dark: dark, roles: roles)
    }
}

extension StyleColor {
    var swiftUI: Color { Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha) }
    var nsColor: NSColor { NSColor(srgbRed: red, green: green, blue: blue, alpha: alpha) }
}

extension ComputedStyle {
    /// The sheet's text color, else `fallback`. `dim` is how much of the sheet's color a secondary text (a verse's
    /// reference, the timer) keeps.
    func ink(_ fallback: Color, dim: Double = 1) -> Color { color.map { $0.swiftUI.opacity(dim) } ?? fallback }
}

enum Styled {
    /// The face a view draws with when the sheet names none: the bar's monospace, the theme's UI font, or the serif
    /// italic voice for words you gave Polycarp.
    enum Face { case mono, ui, voice }

    private static var faces: [String: CTFont?] = [:]

    /// The sheet's font over the view's own. `size` and `weight` are the view's, written for the 12 pt base as
    /// `Chrome`'s are; the sheet's `font-size` is in points as written.
    static func font(_ c: ComputedStyle, _ face: Face, _ size: Double, _ weight: TextWeight = .regular, rounded: Bool = false) -> Font {
        guard c.hasFont else {
            switch face {
            case .mono: return Chrome.mono(size, weight)
            case .ui: return Chrome.font(size, weight, rounded: rounded)
            case .voice: return Chrome.voice(size, weight)
            }
        }
        let f = Chrome.spec.font
        let pt = c.fontSize ?? f.size(size)
        let w = c.fontWeight.map(textWeight) ?? f.weight(weight)
        let italic = c.fontStyle.map { $0 == .italic } ?? (face == .voice)
        let stack = families(c.fontFamily, face)
        let font: Font
        if let ct = resolved(stack.named, w, pt) {
            font = Font(ct)
        } else {
            font = .system(size: CGFloat(pt), weight: w.swiftUI, // The rounded face has no italic.
                           design: stack.design ?? (rounded && !italic ? .rounded : .default))
        }
        return italic ? font.italic() : font
    }

    /// `font` for a part whose text has no font of its own in the theme: nil (the system's) when the sheet sets none.
    static func font(_ c: ComputedStyle, orNone size: Double) -> Font? { c.hasFont ? font(c, .ui, size) : nil }

    /// `font` in the theme's UI face, for the text AppKit draws.
    static func nsFont(_ c: ComputedStyle, _ size: Double, _ weight: TextWeight = .regular) -> NSFont {
        guard c.hasFont else { return Chrome.nsFont(size, weight) }
        let f = Chrome.spec.font
        let pt = c.fontSize ?? f.size(size)
        let w = c.fontWeight.map(textWeight) ?? f.weight(weight)
        let stack = families(c.fontFamily, .ui)
        // `resolved` is the base weight when the theme's own system face draws: the system's at the sheet's weight.
        let font = resolved(stack.named, w, pt).map { $0 as NSFont } ?? .systemFont(ofSize: CGFloat(pt), weight: w.nsFont)
        return c.fontStyle == .italic ? NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) : font
    }

    /// 100 to 900 to the weights the theme's fonts come in.
    static func textWeight(_ w: Double) -> TextWeight {
        switch w {
        case ..<450: .regular
        case ..<550: .medium
        case ..<650: .semibold
        case ..<750: .bold
        default: .heavy
        }
    }

    /// The names to look up, in order, and the system design to fall back to. CSS's generic names are the system's
    /// own: `monospace` and `serif` its monospaced and serif faces, `system-ui` and `sans-serif` the plain system font,
    /// which ends the list.
    private static func families(_ stack: [String]?, _ face: Face) -> (named: [String], design: Font.Design?) {
        guard let stack else {
            switch face {
            case .mono: return (Appearance.shared.polycarp?.monoFamilies ?? [FontFace.systemMonospace], .monospaced)
            case .voice: return ([FontFace.systemSerif], .serif)
            case .ui:
                let f = Chrome.spec.font
                return f.family == "system-sans" ? ([], nil) : (Chrome.look.families(for: f.family), nil)
            }
        }
        var named: [String] = []
        for name in stack {
            switch name.lowercased() {
            case "monospace", "ui-monospace": named.append(FontFace.systemMonospace)
            case "serif", "ui-serif": named.append(FontFace.systemSerif)
            case "system-ui", "sans-serif", "ui-sans-serif", "-apple-system": return (named, nil)
            default: named.append(name)
            }
        }
        return (named, nil)
    }

    /// The first installed face of `names`, resolved once per stack, weight and size.
    private static func resolved(_ names: [String], _ w: TextWeight, _ pt: Double) -> CTFont? {
        guard !names.isEmpty else { return nil }
        let key = "\(names.joined(separator: ","))|\(w)|\(pt)"
        if let cached = faces[key] { return cached }
        let face = FontFace.resolve(families: names, weight: w, size: pt)
        faces[key] = .some(face)
        return face
    }

    /// A background as a fill: nil when the sheet sets none, so the view keeps its own.
    static func fill(_ b: StyleBackground?) -> AnyShapeStyle? {
        guard let b else { return nil }
        switch b {
        case .none: return AnyShapeStyle(Color.clear)
        case .glass: return AnyShapeStyle(Material.ultraThinMaterial)
        case .color(let c): return AnyShapeStyle(c.swiftUI)
        case .linearGradient(let a, let z, let d):
            return AnyShapeStyle(LinearGradient(colors: [a.swiftUI, z.swiftUI], startPoint: d == .toRight ? .leading : .top,
                                                endPoint: d == .toRight ? .trailing : .bottom))
        }
    }

    /// A border's color and width: nil when the sheet sets none; `none` is no line.
    static func line(_ l: StyleLine?) -> (color: Color, width: CGFloat)? {
        guard let l else { return nil }
        switch l {
        case .none: return (Color.clear, 0)
        case .solid(let w, let c): return (c.swiftUI, CGFloat(w))
        }
    }

    static func insets(_ p: StyleInsets) -> EdgeInsets {
        EdgeInsets(top: CGFloat(p.top), leading: CGFloat(p.left), bottom: CGFloat(p.bottom), trailing: CGFloat(p.right))
    }

    /// `transition-duration` as an ease-out, or none (also under Reduce Motion).
    static func fade(_ c: ComputedStyle) -> Animation? {
        guard let t = c.transitionDuration, t > 0, !Chrome.reduceMotion else { return nil }
        return .easeOut(duration: t)
    }

    static func shape(_ c: ComputedStyle, else fallback: CGFloat = 0) -> RoundedRectangle {
        RoundedRectangle(cornerRadius: c.borderRadius.map { CGFloat($0) } ?? fallback, style: .continuous)
    }
}

extension Text {
    /// The sheet's letter spacing over the view's own, and its numerals: the same text when the sheet sets neither.
    func spaced(_ c: ComputedStyle, tracking own: CGFloat = 0) -> Text {
        let spacing = c.letterSpacing.map { CGFloat($0) } ?? own
        let text = spacing == 0 ? self : tracking(spacing)
        return c.fontVariantNumeric == .tabularNums ? text.monospacedDigit() : text
    }
}

extension View {
    /// The sheet's padding in place of the view's own.
    func padding(_ c: ComputedStyle, else own: EdgeInsets) -> some View { padding(c.padding.map(Styled.insets) ?? own) }

    /// A picture cut to the sheet's corners, when it sets them.
    @ViewBuilder func corners(_ c: ComputedStyle) -> some View { if c.borderRadius == nil { self } else { clipShape(Styled.shape(c)) } }
}

/// The face behind a part that has one of its own: the view's fill and corners, each replaced by the sheet's, and the
/// sheet's lines. With neither it is the view's own shape and nothing else.
struct StyledBack: View {
    let style: ComputedStyle
    /// Whose corners it has when the sheet sets none; square without one.
    let surface: Surface?
    var own = AnyShapeStyle(Color.clear)
    private var over = false

    init(_ style: ComputedStyle, _ surface: Surface? = nil) { self.style = style; self.surface = surface }

    func fill(_ color: Color) -> StyledBack { var b = self; b.own = AnyShapeStyle(color); return b }

    /// The theme's fill is a state's mark the sheet doesn't replace, so it is drawn over the sheet's background.
    func marking(_ on: Bool) -> StyledBack { var b = self; b.over = on; return b }

    var body: some View {
        let shape = Styled.shape(style, else: surface.map(Chrome.radius) ?? 0)
        if style.isEmpty {
            shape.fill(own)
        } else {
            shape.fill(Styled.fill(style.background) ?? own)
                .overlay { if over, style.background != nil { shape.fill(own) } }
                .overlay { StyledLines(style: style, shape: shape) }
                .modifier(StyledFade(style: style))
        }
    }
}

/// What a panel's rows and tiles are drawn with, picked once for the whole panel: `Bare` where no rule names it, which
/// is the theme's pieces and nothing else, so a panel without a rule opens as fast as before there was a sheet; `Dressed`
/// for the sheet's. The layout is written once, over either.
@MainActor protocol Dress {
    associatedtype Part: ViewModifier
    associatedtype Cut: ViewModifier
    associatedtype Plate: ViewModifier
    associatedtype Fit: ViewModifier
    associatedtype Hover: ViewModifier
    associatedtype Back: Face
    associatedtype Edge: View
    associatedtype Pill: View
    /// Hides and fades a part.
    static func part(_ c: ComputedStyle) -> Part
    /// A part the theme draws no face behind: the sheet's, and its fade.
    static func plate(_ c: ComputedStyle) -> Plate
    /// Cuts a picture's corners.
    static func cut(_ c: ComputedStyle) -> Cut
    static func hover(on: Bool, _ changed: @escaping (Bool) -> Void) -> Hover
    static func back(_ c: ComputedStyle, _ surface: Surface) -> Back
    /// The theme's pill, or the sheet's box.
    static func pill(_ c: ComputedStyle, _ surface: Surface, _ fill: Color) -> Pill
    /// `short` in place of the view where the sheet's height leaves it no room.
    static func fit(_ c: ComputedStyle, short: @escaping () -> AnyView) -> Fit
    /// The line the theme draws around a tile, unless the sheet draws its own; `marking` when it is a state's mark the
    /// sheet doesn't replace.
    static func edge(_ c: ComputedStyle, _ surface: Surface, _ color: Color, focused: Bool, marking: Bool) -> Edge
}

/// The face behind a row or tile: the theme's fill, and whether that fill is a mark drawn over the sheet's background.
protocol Face: View {
    func fill(_ color: Color) -> Self
    func marking(_ on: Bool) -> Self
}

extension StyledBack: Face {}

struct BareBack: Face {
    let surface: Surface
    var own = Color.clear
    func fill(_ color: Color) -> BareBack { BareBack(surface: surface, own: color) }
    func marking(_ on: Bool) -> BareBack { self }
    var body: some View { Chrome.shape(surface).fill(own) }
}

struct StyledPart: ViewModifier {
    let style: ComputedStyle
    func body(content: Content) -> some View { if !style.isHidden { content.opacity(style.opacity ?? 1) } }
}

struct StyledCut: ViewModifier {
    let style: ComputedStyle
    func body(content: Content) -> some View { content.corners(style) }
}

struct StyledPlate: ViewModifier {
    let style: ComputedStyle
    func body(content: Content) -> some View {
        if !style.isHidden { content.background { StyledBack(style) }.opacity(style.opacity ?? 1) }
    }
}

struct StyledFit: ViewModifier {
    let style: ComputedStyle
    let short: () -> AnyView
    func body(content: Content) -> some View {
        if style.height == nil { content } else { ViewThatFits(in: .vertical) { content; short() } }
    }
}

enum Bare: Dress {
    static func part(_ c: ComputedStyle) -> EmptyModifier { .identity }
    static func cut(_ c: ComputedStyle) -> EmptyModifier { .identity }
    static func plate(_ c: ComputedStyle) -> EmptyModifier { .identity }
    static func fit(_ c: ComputedStyle, short: @escaping () -> AnyView) -> EmptyModifier { .identity }
    static func hover(on: Bool, _ changed: @escaping (Bool) -> Void) -> EmptyModifier { .identity }
    static func pill(_ c: ComputedStyle, _ surface: Surface, _ fill: Color) -> some View { Chrome.pill().fill(fill) }
    static func back(_ c: ComputedStyle, _ surface: Surface) -> BareBack { BareBack(surface: surface) }
    static func edge(_ c: ComputedStyle, _ surface: Surface, _ color: Color, focused: Bool, marking: Bool) -> some View {
        Chrome.shape(surface).strokeBorder(color, lineWidth: Chrome.width(surface, focused: focused))
    }
}

enum Dressed: Dress {
    static func part(_ c: ComputedStyle) -> StyledPart { StyledPart(style: c) }
    static func cut(_ c: ComputedStyle) -> StyledCut { StyledCut(style: c) }
    static func plate(_ c: ComputedStyle) -> StyledPlate { StyledPlate(style: c) }
    static func fit(_ c: ComputedStyle, short: @escaping () -> AnyView) -> StyledFit { StyledFit(style: c, short: short) }
    @ViewBuilder static func pill(_ c: ComputedStyle, _ surface: Surface, _ fill: Color) -> some View {
        if c.borderRadius == nil, c.border == nil {
            Chrome.pill().fill(Styled.fill(c.background) ?? AnyShapeStyle(fill))
        } else {
            StyledBack(c, surface).fill(fill)
        }
    }
    static func hover(on: Bool, _ changed: @escaping (Bool) -> Void) -> StyledHover { StyledHover(on: on, changed: changed) }
    static func back(_ c: ComputedStyle, _ surface: Surface) -> StyledBack { StyledBack(c, surface) }
    @ViewBuilder static func edge(_ c: ComputedStyle, _ surface: Surface, _ color: Color, focused: Bool, marking: Bool) -> some View {
        if c.border == nil || marking {
            Styled.shape(c, else: Chrome.radius(surface)).strokeBorder(color, lineWidth: Chrome.width(surface, focused: focused))
        }
    }
}

/// Tells the view when the pointer comes and goes, only while a rule changes something under it.
struct StyledHover: ViewModifier {
    let on: Bool
    let changed: (Bool) -> Void
    func body(content: Content) -> some View { if on { content.onHover(perform: changed) } else { content } }
}

/// The sheet's letter spacing and numerals (the font and the case are set where the text is made).
struct StyledText: ViewModifier {
    let style: ComputedStyle
    func body(content: Content) -> some View {
        let spaced = content.tracking(CGFloat(style.letterSpacing ?? 0))
        if style.fontVariantNumeric == .tabularNums { spaced.monospacedDigit() } else { spaced }
    }
}

/// The sheet's box around a part: its padding, then behind it the background, the border lines and the corners, and
/// its opacity. `transition-duration` fades the box's own layers alone, never the part's layout (parts that slid
/// sideways, 2026-10-19). A part whose style sets none of it is drawn exactly as before.
struct StyledBox: ViewModifier {
    let style: ComputedStyle
    func body(content: Content) -> some View {
        if !style.hasBox && style.opacity == nil {
            content
        } else {
            let shape = Styled.shape(style)
            content
                .padding(style.padding.map(Styled.insets) ?? EdgeInsets())
                .background { StyledFace(style: style, shape: shape) }
                .opacity(style.opacity ?? 1)
        }
    }
}

/// The layers of a box: fill and lines, faded on their own.
struct StyledFace: View {
    let style: ComputedStyle
    let shape: RoundedRectangle

    var body: some View {
        ZStack {
            if let fill = Styled.fill(style.background) { shape.fill(fill) }
            StyledLines(style: style, shape: shape)
        }
        .modifier(StyledFade(style: style))
    }
}

/// `border` and `border-bottom`, inside the shape's edge.
struct StyledLines: View {
    let style: ComputedStyle
    let shape: RoundedRectangle

    var body: some View {
        ZStack(alignment: .bottom) {
            if let l = Styled.line(style.border), l.width > 0 { shape.strokeBorder(l.color, lineWidth: l.width) }
            if let l = Styled.line(style.borderBottom), l.width > 0 {
                Rectangle().fill(l.color).frame(height: l.width).frame(maxHeight: .infinity, alignment: .bottom).clipShape(shape)
            }
        }
    }
}

/// `box-shadow` (CSS blur is about twice SwiftUI's radius).
struct StyledShadow: ViewModifier {
    let shadow: StyleShadow?
    func body(content: Content) -> some View {
        if case .drop(let x, let y, let blur, let c)? = shadow {
            content.shadow(color: c.swiftUI, radius: CGFloat(blur / 2), x: CGFloat(x), y: CGFloat(y))
        } else {
            content
        }
    }
}

/// Fades what changes in this view when its style does, if the sheet sets a `transition-duration`.
struct StyledFade: ViewModifier {
    let style: ComputedStyle
    func body(content: Content) -> some View {
        if let a = Styled.fade(style) { content.animation(a, value: style) } else { content }
    }
}
