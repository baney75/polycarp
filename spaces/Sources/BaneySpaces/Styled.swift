import AppKit
import BaneySpacesCore
import SwiftUI

/// The style sheet in force (`StyleSheetStore`, docs/style.md) as the top bar draws it: one
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
    func sync() {
        let look = Chrome.look
        let sheet = StyleSheetStore.shared.current
        let dark = look.palette.isDark
        let roles = StyleSheet.roles(look.palette.colors, onAccent: look.text(onAccent: Appearance.shared.accentRGB))
        guard sheet != book.sheet || dark != book.dark || roles != book.roles else { return }
        book = StyleBook(sheet, dark: dark, roles: roles)
    }
}

extension StyleColor {
    var swiftUI: Color { Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha) }
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
            font = .system(size: CGFloat(pt), weight: w.swiftUI, design: stack.design ?? (rounded ? .rounded : .default))
        }
        return italic ? font.italic() : font
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
