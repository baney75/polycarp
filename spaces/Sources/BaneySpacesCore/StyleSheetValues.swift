import Foundation

// Values: `var()` substitution, the typed parse of each property's value, the checks that turn a raw parse into a
// `StyleSheet`, and the cascade that `computed` runs. Every message says what the value takes, so an agent can fix it.

/// A color as a declaration holds it: concrete, or `currentColor`, which becomes the part's own text color.
enum StyleColorRef: Equatable, Sendable {
    case rgba(StyleColor)
    case current
}

enum StyleValue: Equatable, Sendable {
    case color(StyleColorRef)
    case background(Background)
    /// Points, seconds, an opacity or a weight.
    case number(Double)
    case stack([String])
    case keyword(String)
    case insets(StyleInsets)
    case line(Line)
    case shadow(Shadow)

    enum Background: Equatable, Sendable {
        case none, glass
        case color(StyleColorRef)
        case gradient(StyleColorRef, StyleColorRef, StyleGradientDirection)
    }

    enum Line: Equatable, Sendable {
        case none
        case solid(Double, StyleColorRef)
    }

    enum Shadow: Equatable, Sendable {
        case none
        case drop(Double, Double, Double, StyleColorRef)
    }
}

// MARK: Pieces: a value's tokens grouped, functions with their arguments

indirect enum StylePiece: Equatable {
    case ident(String)
    case number(Double, String)
    case hash(String)
    case string(String)
    case function(String, [StylePiece])
    case comma, slash
    case color(StyleColor)
    case other(String)

    var text: String {
        switch self {
        case .ident(let s): s
        case .number(let v, let u): StyleNumber.text(v) + u
        case .hash(let h): "#" + h
        case .string(let s): "\"\(s)\""
        case .function(let n, let a): n + "(" + a.map(\.text).joined(separator: " ") + ")"
        case .comma: ","
        case .slash: "/"
        case .color(let c): c.hex
        case .other(let s): s
        }
    }

    /// Groups tokens into pieces without recursion; functions nested deeper than 16 are refused.
    static func pieces(_ tokens: [StyleToken]) -> Result<[StylePiece], StyleValueError> {
        var stack: [(name: String, items: [StylePiece])] = [("", [])]
        for t in tokens {
            switch t.kind {
            case .whitespace: continue
            case .ident(let s): stack[stack.count - 1].items.append(.ident(s))
            case .number(let v, let u):
                guard v.isFinite else { return .failure(.init("`\(t.text)` is too big a number")) }
                stack[stack.count - 1].items.append(.number(v, u))
            case .hash(let h): stack[stack.count - 1].items.append(.hash(h))
            case .string(let s): stack[stack.count - 1].items.append(.string(s))
            case .comma: stack[stack.count - 1].items.append(.comma)
            case .delim("/"): stack[stack.count - 1].items.append(.slash)
            case .color(let c): stack[stack.count - 1].items.append(.color(c))
            case .function(let name):
                guard stack.count <= 16 else { return .failure(.init("functions are nested too deep")) }
                stack.append((name, []))
            case .openParen, .openBracket: return .failure(.init("`\(t.text)` isn't expected here"))
            case .closeParen:
                guard stack.count > 1 else { return .failure(.init("a `)` with no `(` before it")) }
                let f = stack.removeLast()
                stack[stack.count - 1].items.append(.function(f.name, f.items))
            default: stack[stack.count - 1].items.append(.other(t.text))
            }
        }
        // A function left open at the end of the value closes there, as in CSS.
        while stack.count > 1 {
            let f = stack.removeLast()
            stack[stack.count - 1].items.append(.function(f.name, f.items))
        }
        return .success(stack[0].items)
    }
}

struct StyleValueError: Error, Equatable {
    /// Why a value failed, for the sheet's builder: only an undefined `var()` can come out differently once the real
    /// theme stands in for the placeholder roles.
    enum Kind: Equatable { case value, undefined, limit }
    let message: String
    let kind: Kind
    init(_ m: String, kind: Kind = .value) { message = m; self.kind = kind }
}

// MARK: var()

enum StyleVars {
    /// Most a value may grow to through `var()`, so a sheet can't make one value huge (each var used twice, ten deep).
    static let maxTokens = 4096
    static let maxDepth = 32

    /// `tokens` with every `var()` replaced: by a custom property for this mode, else a role, else its fallback.
    static func substitute(_ tokens: [StyleToken], custom: [String: [StyleToken]], roles: [String: StyleColor]) -> Result<[StyleToken], StyleValueError> {
        Expander(custom: custom, roles: roles).substitute(tokens)
    }

    static func needsSubstitution(_ tokens: [StyleToken]) -> Bool { tokens.contains { $0.kind == .function("var") } }

    /// `var()` substitution for one mode and one set of roles. Each custom property is expanded once and kept, so a chain
    /// that many rules use costs its length once (review of #604: a doubling chain used in 2500 rules ran `style check`
    /// past the MCP tool's 10 s). A value that would grow past `maxTokens` or nest past `maxDepth` is refused, never built.
    final class Expander {
        private let custom: [String: [StyleToken]]
        private let roles: [String: StyleColor]
        /// Each custom property's expansion and how many levels its own `var()`s go below the one that names it. A failure
        /// is kept too, except one for depth, which depends on how deep the property is used.
        private var memo: [String: Result<(tokens: [StyleToken], height: Int), StyleValueError>] = [:]
        /// The custom properties being expanded, outermost first: a name already here is a cycle.
        private var open: [String] = []

        init(custom: [String: [StyleToken]], roles: [String: StyleColor]) { self.custom = custom; self.roles = roles }

        /// `tokens` with every `var()` replaced. `name` is the custom property they are the value of, so a reference
        /// back to it is a cycle.
        func substitute(_ tokens: [StyleToken], as name: String? = nil) -> Result<[StyleToken], StyleValueError> {
            if let name { open.append(name) }
            defer { if name != nil { open.removeLast() } }
            return expand(tokens, depth: 0).map(\.tokens)
        }

        private static func tooLong() -> StyleValueError { .init("`var()` makes this value longer than \(maxTokens) tokens", kind: .limit) }
        private static func tooDeep() -> StyleValueError { .init("`var()` is nested more than \(maxDepth) deep", kind: .limit) }

        /// `reach` is the deepest level any part of the value was expanded at.
        private func expand(_ tokens: [StyleToken], depth: Int) -> Result<(tokens: [StyleToken], reach: Int), StyleValueError> {
            guard depth <= maxDepth else { return .failure(Self.tooDeep()) }
            var out: [StyleToken] = []
            var reach = depth
            var k = 0
            while k < tokens.count {
                let t = tokens[k]
                guard t.kind == .function("var") else {
                    out.append(t); k += 1
                    if out.count > maxTokens { return .failure(Self.tooLong()) }
                    continue
                }
                // The arguments, up to the matching `)` (the value's end closes it, as in CSS).
                var e = k + 1, d = 1
                while e < tokens.count {
                    if tokens[e].opens { d += 1 } else if tokens[e].closes { d -= 1; if d == 0 { break } }
                    e += 1
                }
                let args = Array(tokens[(k + 1)..<min(e, tokens.count)])
                var a = 0
                while a < args.count, args[a].isSpace { a += 1 }
                guard a < args.count, case .ident(let name) = args[a].kind, name.hasPrefix("--") else {
                    return .failure(.init("`var()` takes a custom property name, like `var(--accent)` or `var(--gold, #d4af37)`", kind: .limit))
                }
                a += 1
                while a < args.count, args[a].isSpace { a += 1 }
                var fallback: [StyleToken]?
                if a < args.count {
                    guard args[a].kind == .comma else { return .failure(.init("`var(\(name)` must be followed by `)` or `, fallback)`", kind: .limit)) }
                    fallback = Array(args[(a + 1)...]).trimmed
                }
                let replaced: [StyleToken]
                if let i = open.firstIndex(of: name) {
                    return .failure(.init("`var(\(name))` refers back to itself: \((open[i...] + [name]).joined(separator: " -> "))", kind: .limit))
                } else if custom[name] != nil {
                    switch property(name, depth: depth) {
                    case .failure(let f): return .failure(f)
                    case .success(let r): replaced = r.tokens; reach = max(reach, depth + r.height)
                    }
                } else if let c = roles[String(name.dropFirst(2))] {
                    replaced = [StyleToken(kind: .color(c), text: "var(\(name))", start: t.start, end: t.end, line: t.line, column: t.column)]
                } else if let fb = fallback {
                    switch expand(fb, depth: depth + 1) {
                    case .failure(let f): return .failure(f)
                    case .success(let r): replaced = r.tokens; reach = max(reach, r.reach)
                    }
                } else {
                    return .failure(.init("`var(\(name))` is not defined and has no fallback; define it in `:root`, or use a theme role: "
                                          + StyleProperty.roles.map { "--" + $0 }.joined(separator: " "), kind: .undefined))
                }
                out += replaced
                if out.count > maxTokens { return .failure(Self.tooLong()) }
                k = e + 1
            }
            return .success((out, reach))
        }

        /// A custom property's expansion, used `depth` levels down: worked out the first time, then kept.
        private func property(_ name: String, depth: Int) -> Result<(tokens: [StyleToken], height: Int), StyleValueError> {
            if let known = memo[name] {
                if case .success(let r) = known, depth + r.height > maxDepth { return .failure(Self.tooDeep()) }
                return known
            }
            open.append(name)
            let r = expand(custom[name]!, depth: depth + 1)
            open.removeLast()
            switch r {
            case .success(let e):
                let kept = Result<(tokens: [StyleToken], height: Int), StyleValueError>.success((e.tokens, e.reach - depth))
                memo[name] = kept
                return kept
            case .failure(let f):
                if f != Self.tooDeep() { memo[name] = .failure(f) }
                return .failure(f)
            }
        }
    }
}

extension Array where Element == StyleToken {
    var trimmed: [StyleToken] {
        var a = self[...]
        while a.first?.isSpace == true { a.removeFirst() }
        while a.last?.isSpace == true { a.removeLast() }
        return Array(a)
    }
}

// MARK: Typed values

enum StyleValues {
    typealias Parsed = Result<StyleValue, StyleValueError>

    static func parse(_ property: StyleProperty, _ tokens: [StyleToken]) -> Parsed {
        let name = property.name
        let raw = tokens.map { $0.isSpace ? " " : $0.text }.joined().trimmingCharacters(in: .whitespaces)
        if raw.isEmpty { return .failure(.init("`\(name)` has no value")) }
        if ["inherit", "initial", "unset", "revert"].contains(raw.lowercased()) {
            return .failure(.init("`\(raw)` isn't supported; leave `\(name)` out to get the default"))
        }
        if case .fontFamily = property.kind {
            if tokens.contains(where: { if case .color = $0.kind { true } else { false } }) {
                return .failure(.init("`\(name)` takes a font stack, not a color"))
            }
            guard let stack = PolycarpTheme.parseStack(raw) else {
                return .failure(.init("`\(raw)` isn't a font stack: names separated by commas, quoted when they hold other characters, like `\"SF Pro Text\", system-ui`"))
            }
            return .success(.stack(stack))
        }
        let pieces: [StylePiece]
        switch StylePiece.pieces(tokens) {
        case .failure(let e): return .failure(e)
        case .success(let p): pieces = p
        }
        func one() -> StylePiece? { pieces.count == 1 ? pieces[0] : nil }
        func keyword() -> String? { if case .ident(let s)? = one() { return s.lowercased() } else { return nil } }
        func fail(_ m: String) -> Parsed { .failure(.init(m)) }
        let takes = property.takes

        switch property.kind {
        case .color:
            guard let p = one() else { return fail("`\(name)` takes one color, not `\(raw)`") }
            return color(p).map { .color($0) }
        case .background:
            if keyword() == "none" { return .success(.background(.none)) }
            if keyword() == "glass" { return .success(.background(.glass)) }
            if case .function("linear-gradient", let args)? = one() { return gradient(args).map { .background($0) } }
            guard let p = one() else { return fail("`background` takes \(takes), not `\(raw)`") }
            switch color(p) {
            case .success(let c): return .success(.background(.color(c)))
            case .failure: return fail("`\(raw)` isn't a background; `background` takes \(takes)")
            }
        case .opacity:
            guard case .number(let v, let u)? = one(), u == "" || u == "%" else { return fail("`opacity` takes \(takes), not `\(raw)`") }
            let x = u == "%" ? v / 100 : v
            guard (0...1).contains(x) else { return fail("`opacity` must be from 0 to 1, not \(raw)") }
            return .success(.number(x))
        case .fontFamily:
            return fail("unreachable")
        case .fontWeight:
            if keyword() == "normal" { return .success(.number(400)) }
            if keyword() == "bold" { return .success(.number(700)) }
            guard case .number(let v, "")? = one() else { return fail("`font-weight` takes \(takes), not `\(raw)`") }
            guard (100...900).contains(v) else { return fail("`font-weight` must be from 100 to 900, not \(raw)") }
            return .success(.number(v))
        case .length(let r):
            guard let p = one() else { return fail("`\(name)` takes one length, not `\(raw)`") }
            return length(p, r, name).map { .number($0) }
        case .spacing(let r):
            if keyword() == "normal" { return .success(.number(0)) }
            guard let p = one() else { return fail("`\(name)` takes \(takes), not `\(raw)`") }
            return length(p, r, name).map { .number($0) }
        case .keywords(let allowed):
            guard let k = keyword(), allowed.contains(k) else { return fail("`\(name)` takes \(takes), not `\(raw)`") }
            return .success(.keyword(k))
        case .padding:
            guard (1...4).contains(pieces.count) else { return fail("`padding` takes \(takes), not `\(raw)`") }
            var v: [Double] = []
            for p in pieces {
                switch length(p, 0...40, "padding") {
                case .failure(let e): return .failure(e)
                case .success(let x): v.append(x)
                }
            }
            let (t, r, b, l): (Double, Double, Double, Double) = switch v.count {
            case 1: (v[0], v[0], v[0], v[0])
            case 2: (v[0], v[1], v[0], v[1])
            case 3: (v[0], v[1], v[2], v[1])
            default: (v[0], v[1], v[2], v[3])
            }
            return .success(.insets(StyleInsets(top: t, right: r, bottom: b, left: l)))
        case .line:
            if keyword() == "none" { return .success(.line(.none)) }
            var width: Double?, solid = false, c: StyleColorRef?
            for p in pieces {
                if case .ident(let s) = p, s.lowercased() == "solid", !solid { solid = true; continue }
                if case .ident(let s) = p, ["dashed", "dotted", "double", "groove", "ridge", "inset", "outset", "hidden"].contains(s.lowercased()) {
                    return fail("`\(name)` draws only `solid` lines, not `\(s)`")
                }
                if width == nil, case .number = p {
                    switch length(p, 0...8, "\(name) width") {
                    case .failure(let e): return .failure(e)
                    case .success(let w): width = w
                    }
                    continue
                }
                if c == nil, case .success(let x) = color(p) { c = x; continue }
                return fail("`\(name)` takes \(takes), not `\(raw)`")
            }
            guard let w = width, solid else { return fail("`\(name)` takes \(takes), not `\(raw)`") }
            return .success(.line(.solid(w, c ?? .current)))
        case .shadow:
            if keyword() == "none" { return .success(.shadow(.none)) }
            var lengths: [StylePiece] = [], c: StyleColorRef?
            for p in pieces {
                if case .number = p { lengths.append(p); continue }
                if c == nil, case .success(let x) = color(p) { c = x; continue }
                if case .ident(let s) = p, s.lowercased() == "inset" { return fail("`box-shadow` draws only outer shadows; `inset` isn't supported") }
                return fail("`box-shadow` takes \(takes), not `\(raw)`")
            }
            guard lengths.count == 3, let col = c else {
                return fail(lengths.count == 4 ? "`box-shadow` takes no spread: \(takes)" : "`box-shadow` takes \(takes), not `\(raw)`")
            }
            var v: [Double] = []
            for (p, r, what) in [(lengths[0], -40.0...40.0, "x"), (lengths[1], -40.0...40.0, "y"), (lengths[2], 0.0...64.0, "blur")] {
                switch length(p, r, "box-shadow \(what)") {
                case .failure(let e): return .failure(e)
                case .success(let x): v.append(x)
                }
            }
            return .success(.shadow(.drop(v[0], v[1], v[2], col)))
        case .time:
            guard case .number(let v, let u)? = one() else { return fail("`\(name)` takes \(takes), not `\(raw)`") }
            let ms: Double
            switch u {
            case "ms": ms = v
            case "s": ms = v * 1000
            case "" where v == 0: ms = 0
            default: return fail("`\(name)` takes \(takes), not `\(raw)`")
            }
            guard (0...2000).contains(ms) else { return fail("`\(name)` must be from 0 to 2000ms, not \(raw)") }
            return .success(.number(ms / 1000))
        }
    }

    /// A length in points: `px` or `pt`, or a bare 0.
    static func length(_ p: StylePiece, _ r: ClosedRange<Double>, _ name: String) -> Result<Double, StyleValueError> {
        guard case .number(let v, let u) = p else { return .failure(.init("`\(name)` takes a length, like 8px, not `\(p.text)`")) }
        guard u == "px" || u == "pt" || (u == "" && v == 0) else {
            if u == "" { return .failure(.init("`\(name)` needs a unit: write \(StyleNumber.text(v))px")) }
            return .failure(.init("`\(name)` takes px or pt, not `\(u)`"))
        }
        guard r.contains(v) else {
            return .failure(.init("`\(name)` must be from \(StyleNumber.text(r.lowerBound)) to \(StyleNumber.text(r.upperBound)), not \(p.text)"))
        }
        return .success(v)
    }

    static func gradient(_ args: [StylePiece]) -> Result<StyleValue.Background, StyleValueError> {
        var groups: [[StylePiece]] = [[]]
        for a in args { if a == .comma { groups.append([]) } else { groups[groups.count - 1].append(a) } }
        var direction = StyleGradientDirection.toBottom
        if let first = groups.first, case .ident(let w)? = first.first, w.lowercased() == "to" {
            let words = first.map { $0.text.lowercased() }.joined(separator: " ")
            guard let d = StyleGradientDirection(rawValue: words) else {
                return .failure(.init("`linear-gradient` goes `to bottom` or `to right`, not `\(words)`"))
            }
            direction = d
            groups.removeFirst()
        }
        guard groups.count == 2, groups[0].count == 1, groups[1].count == 1 else {
            return .failure(.init("`linear-gradient` takes two colors, like `linear-gradient(to bottom, var(--surface), var(--background))`"))
        }
        switch (color(groups[0][0]), color(groups[1][0])) {
        case (.success(let a), .success(let b)): return .success(.gradient(a, b, direction))
        case (.failure(let e), _), (_, .failure(let e)): return .failure(e)
        }
    }

    // MARK: Colors

    /// The 16 basic CSS colors.
    static let named: [String: UInt32] = [
        "black": 0x000000, "silver": 0xC0C0C0, "gray": 0x808080, "white": 0xFFFFFF, "maroon": 0x800000, "red": 0xFF0000,
        "purple": 0x800080, "fuchsia": 0xFF00FF, "green": 0x008000, "lime": 0x00FF00, "olive": 0x808000, "yellow": 0xFFFF00,
        "navy": 0x000080, "blue": 0x0000FF, "teal": 0x008080, "aqua": 0x00FFFF,
    ]

    static let colorForms = "#rgb, #rrggbb (with alpha: #rgba, #rrggbbaa), rgb(), hsl(), a basic named color (red, navy, teal...), transparent, currentColor or var(--role)"

    static func color(_ p: StylePiece) -> Result<StyleColorRef, StyleValueError> {
        func fail(_ m: String) -> Result<StyleColorRef, StyleValueError> { .failure(.init(m)) }
        switch p {
        case .color(let c): return .success(.rgba(c))
        case .hash(let h):
            let digits = Array(h.unicodeScalars)
            guard [3, 4, 6, 8].contains(digits.count), digits.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) || ("A"..."F").contains($0) }),
                  let v = UInt64(h, radix: 16) else {
                return fail("`#\(h)` isn't a hex color: use 3, 4, 6 or 8 hex digits")
            }
            func ch(_ x: UInt64) -> Double { Double(x) / 255 }
            switch digits.count {
            case 3, 4:
                let n = digits.count
                func nib(_ i: Int) -> Double { let x = (v >> UInt64(4 * (n - 1 - i))) & 0xF; return ch(x * 17) }
                return .success(.rgba(StyleColor(red: nib(0), green: nib(1), blue: nib(2), alpha: n == 4 ? nib(3) : 1)))
            case 6:
                return .success(.rgba(StyleColor(red: ch((v >> 16) & 0xFF), green: ch((v >> 8) & 0xFF), blue: ch(v & 0xFF))))
            default:
                return .success(.rgba(StyleColor(red: ch((v >> 24) & 0xFF), green: ch((v >> 16) & 0xFF), blue: ch((v >> 8) & 0xFF), alpha: ch(v & 0xFF))))
            }
        case .ident(let s):
            let k = s.lowercased()
            if k == "transparent" { return .success(.rgba(.clear)) }
            if k == "currentcolor" { return .success(.current) }
            if let v = named[k] { return .success(.rgba(StyleColor(rgb: v))) }
            return fail("`\(s)` isn't a color; use \(colorForms)")
        case .function(let f, let args) where f == "rgb" || f == "rgba":
            return rgb(args, f)
        case .function(let f, let args) where f == "hsl" || f == "hsla":
            return hsl(args, f)
        default:
            return fail("`\(p.text)` isn't a color; use \(colorForms)")
        }
    }

    /// The channels of rgb() or hsl(): three, then an optional alpha, with commas between all or none (`/` before the
    /// alpha when there are none).
    private static func channels(_ args: [StylePiece], _ f: String) -> Result<(StylePiece, StylePiece, StylePiece, StylePiece?), StyleValueError> {
        let bad = StyleValueError("`\(f)()` takes three numbers and an optional alpha: `\(f)(\(f.hasPrefix("rgb") ? "212, 175, 55" : "45, 60%, 52%"))`, `\(f)(\(f.hasPrefix("rgb") ? "212 175 55 / 0.8" : "45 60% 52% / 0.8"))`")
        if args.contains(.comma) {
            let vals = args.enumerated().filter { $0.offset % 2 == 0 }.map(\.element)
            let commas = args.enumerated().filter { $0.offset % 2 == 1 }.map(\.element)
            guard commas.allSatisfy({ $0 == .comma }), vals.allSatisfy({ $0 != .comma && $0 != .slash }), vals.count == 3 || vals.count == 4,
                  args.count == vals.count * 2 - 1 else { return .failure(bad) }
            return .success((vals[0], vals[1], vals[2], vals.count == 4 ? vals[3] : nil))
        }
        if args.count == 3 { return .success((args[0], args[1], args[2], nil)) }
        if args.count == 5, args[3] == .slash { return .success((args[0], args[1], args[2], args[4])) }
        return .failure(bad)
    }

    private static func alpha(_ p: StylePiece?, _ f: String) -> Result<Double, StyleValueError> {
        guard let p else { return .success(1) }
        guard case .number(let v, let u) = p, u == "" || u == "%" else { return .failure(.init("the alpha in `\(f)()` is a number from 0 to 1 or a percentage, not `\(p.text)`")) }
        let a = u == "%" ? v / 100 : v
        guard (0...1).contains(a) else { return .failure(.init("the alpha in `\(f)()` must be from 0 to 1, not \(p.text)")) }
        return .success(a)
    }

    private static func rgb(_ args: [StylePiece], _ f: String) -> Result<StyleColorRef, StyleValueError> {
        let parts: (StylePiece, StylePiece, StylePiece, StylePiece?)
        switch channels(args, f) { case .failure(let e): return .failure(e); case .success(let x): parts = x }
        var v: [Double] = []
        for p in [parts.0, parts.1, parts.2] {
            guard case .number(let x, let u) = p, u == "" || u == "%" else { return .failure(.init("an `\(f)()` channel is 0 to 255 or a percentage, not `\(p.text)`")) }
            let c = u == "%" ? x / 100 : x / 255
            guard (0...1).contains(c) else { return .failure(.init("an `\(f)()` channel must be from 0 to 255 (or 0% to 100%), not \(p.text)")) }
            v.append(c)
        }
        switch alpha(parts.3, f) {
        case .failure(let e): return .failure(e)
        case .success(let a): return .success(.rgba(StyleColor(red: v[0], green: v[1], blue: v[2], alpha: a)))
        }
    }

    private static func hsl(_ args: [StylePiece], _ f: String) -> Result<StyleColorRef, StyleValueError> {
        let parts: (StylePiece, StylePiece, StylePiece, StylePiece?)
        switch channels(args, f) { case .failure(let e): return .failure(e); case .success(let x): parts = x }
        guard case .number(let hv, let hu) = parts.0, hu == "" || hu == "deg" || hu == "turn" else {
            return .failure(.init("the hue in `\(f)()` is a number of degrees, not `\(parts.0.text)`"))
        }
        var sl: [Double] = []
        for p in [parts.1, parts.2] {
            guard case .number(let x, let u) = p, u == "%" || u == "" else { return .failure(.init("saturation and lightness in `\(f)()` are percentages, not `\(p.text)`")) }
            guard (0...100).contains(x) else { return .failure(.init("saturation and lightness in `\(f)()` must be from 0% to 100%, not \(p.text)")) }
            sl.append(x / 100)
        }
        let a: Double
        switch alpha(parts.3, f) { case .failure(let e): return .failure(e); case .success(let x): a = x }
        var h = (hu == "turn" ? hv * 360 : hv).truncatingRemainder(dividingBy: 360)
        if h < 0 { h += 360 }
        let s = sl[0], l = sl[1]
        func k(_ n: Double) -> Double { (n + h / 30).truncatingRemainder(dividingBy: 12) }
        let amount = s * min(l, 1 - l)
        func ch(_ n: Double) -> Double { l - amount * max(-1, min(k(n) - 3, 9 - k(n), 1)) }
        return .success(.rgba(StyleColor(red: ch(0), green: ch(8), blue: ch(4), alpha: a)))
    }
}

// MARK: Building a sheet from its syntax

enum StyleSheetBuilder {
    /// What `var()` checks stand roles in with: any color does, only the type matters.
    static let placeholderRoles: [String: StyleColor] = Dictionary(uniqueKeysWithValues: StyleProperty.roles.map { ($0, StyleColor.clear) })

    static func build(_ text: String) -> (sheet: StyleSheet, problems: [StyleProblem]) {
        let syntax = StyleSyntax(text)
        var problems = syntax.problems
        func add(_ line: Int, _ column: Int, _ m: String, _ severity: StyleProblem.Severity = .error) {
            problems.append(StyleProblem(line: line, column: column, severity: severity, message: m))
        }
        var rules: [StyleRule] = []
        // Each `var()` declaration with the rule and place it was kept at, to drop it after the check if it can't work.
        var deferred: [(decl: StyleDeclaration, property: StyleProperty, media: StyleMedia?, rule: Int, index: Int)] = []
        var customDecls: [(StyleRawDeclaration, StyleMedia?)] = []
        for raw in syntax.rules {
            guard let selectors = raw.selectors else { continue }
            let isRoot = selectors.first?.isRoot == true
            var kept: [StyleDeclaration] = []
            for d in raw.declarations {
                if d.important { add(d.line, d.column, "`!important` isn't supported; a later or more specific rule wins instead, so the declaration is dropped"); continue }
                if d.name.hasPrefix("--") {
                    guard isRoot else { add(d.line, d.column, "custom properties like `\(d.name)` go in `:root { ... }`"); continue }
                    customDecls.append((d, raw.media))
                    kept.append(StyleDeclaration(property: d.name, value: nil, tokens: d.value, line: d.line, column: d.column))
                    continue
                }
                let name = d.name.lowercased()
                guard let property = StyleProperty.byName[name] else {
                    let near = nearest(name)
                    add(d.line, d.column, "unknown property `\(d.name)`" + (near.map { "; did you mean `\($0)`?" } ?? "; `polycarp-spaces style example` lists every property"))
                    continue
                }
                if isRoot { add(d.line, d.column, "`:root` holds only custom properties (`--name: value`), not `\(name)`"); continue }
                let targets = selectors.compactMap(\.target)
                let misses = selectors.filter { s in s.target.map { !property.applies(to: $0) } ?? true }
                if !misses.isEmpty {
                    // What on the same surface takes it, when anything does.
                    let near = property.targets.filter { t in misses.contains { $0.surface == t.surface } }
                    add(d.line, d.column, "`\(name)` doesn't apply to \(misses.map { "`\($0)`" }.joined(separator: ", ")); it applies to "
                        + StyleNumber.list((near.isEmpty ? property.targets : near).map { "\($0.rawValue)" }, last: "and")
                        + (name == "display" && misses.contains { $0.part == nil && $0.surface == .bar } ? " (turn the bar off with surfaces.json bar.enabled)" : ""))
                    if !targets.contains(where: property.applies) { continue }
                }
                if StyleVars.needsSubstitution(d.value) {
                    let decl = StyleDeclaration(property: name, value: nil, tokens: d.value, line: d.valueLine, column: d.valueColumn)
                    deferred.append((decl, property, raw.media, rules.count, kept.count))
                    kept.append(decl)
                    continue
                }
                switch StyleValues.parse(property, d.value) {
                case .failure(let e): add(d.valueLine, d.valueColumn, e.message)
                case .success(let v): kept.append(StyleDeclaration(property: name, value: v, tokens: [], line: d.valueLine, column: d.valueColumn))
                }
            }
            rules.append(StyleRule(selectors: selectors, media: raw.media, declarations: kept))
        }
        var light: [String: [StyleToken]] = [:], dark: [String: [StyleToken]] = [:]
        for (d, media) in customDecls {
            if media != .dark { light[d.name] = d.value }
            if media != .light { dark[d.name] = d.value }
        }
        // `var()`: checked in each mode the declaration can apply in, with the roles standing in for any theme. One expander
        // per mode, so each custom property is expanded once however many rules use it, and a value written the same way
        // twice is checked once.
        let expanders: [StyleMedia: StyleVars.Expander] = [.light: .init(custom: light, roles: placeholderRoles),
                                                            .dark: .init(custom: dark, roles: placeholderRoles)]
        var checked: [String: StyleValueError?] = [:]
        /// The failures by mode; nil where the value works.
        func check(_ tokens: [StyleToken], _ media: StyleMedia?, _ line: Int, _ column: Int, name: String?, property: StyleProperty?) -> [StyleValueError?] {
            var seen: [String: [String]] = [:]
            var results: [StyleValueError?] = []
            for mode in [StyleMedia.light, .dark] where media == nil || media == mode {
                // A custom property's own value is checked as that property, so a reference back to it is a cycle; one a
                // later definition overrides is never used, so nothing can come back to it.
                let own = name.flatMap { (mode == .dark ? dark : light)[$0] == tokens ? $0 : nil }
                let key = "\(mode.rawValue)\u{0}\(own ?? "")\u{0}\(property?.name ?? "")\u{0}" + tokens.map(\.text).joined()
                let failure: StyleValueError?
                if let known = checked[key] { failure = known } else {
                    switch expanders[mode]!.substitute(tokens, as: own) {
                    case .failure(let e): failure = e
                    case .success(let t): if let property, case .failure(let e) = StyleValues.parse(property, t) { failure = e } else { failure = nil }
                    }
                    checked[key] = failure
                }
                if let failure { seen[failure.message, default: []].append(mode.rawValue) }
                results.append(failure)
            }
            for (m, modes) in seen.sorted(by: { $0.key < $1.key }) {
                add(line, column, m + (media == nil && modes.count == 1 ? " (in \(modes[0]) mode)" : ""))
            }
            return results
        }
        for (d, media) in customDecls {
            _ = check(d.value, media, d.line, d.column, name: d.name, property: nil)
        }
        // A declaration that fails in every mode it can apply in, for a reason no theme can change (a cycle, a value too
        // long or too deep, the wrong type), is dropped, so `computed` never works it out again. One whose `var()` is
        // undefined stays: a theme role could still define it.
        var dropped = Set<[Int]>()
        for x in deferred {
            let results = check(x.decl.tokens, x.media, x.decl.line, x.decl.column, name: nil, property: x.property)
            if results.allSatisfy({ $0 != nil && $0!.kind != .undefined }) { dropped.insert([x.rule, x.index]) }
        }
        if !dropped.isEmpty {
            rules = rules.enumerated().map { r, rule in
                StyleRule(selectors: rule.selectors, media: rule.media,
                          declarations: rule.declarations.enumerated().filter { !dropped.contains([r, $0.offset]) }.map(\.element))
            }
        }
        problems.sort { ($0.line, $0.column) < ($1.line, $1.column) }
        return (StyleSheet(rules: rules, customLight: light, customDark: dark), problems)
    }

    /// The known property nearest a misspelled one, by edit distance (at most 3).
    static func nearest(_ name: String) -> String? {
        func distance(_ a: [Character], _ b: [Character]) -> Int {
            if a.isEmpty { return b.count }
            if b.isEmpty { return a.count }
            var prev = Array(0...b.count)
            for i in 1...a.count {
                var cur = [i] + Array(repeating: 0, count: b.count)
                for j in 1...b.count { cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)) }
                prev = cur
            }
            return prev[b.count]
        }
        guard name.count < 64 else { return nil }
        let a = Array(name)
        let best = StyleProperty.all.map { ($0.name, distance(a, Array($0.name))) }.min { $0.1 < $1.1 }
        return best.flatMap { $0.1 <= 3 ? $0.0 : nil }
    }
}

// MARK: The cascade

/// The sheet in one mode with one set of roles: every `var()` declaration resolved once when it is made, and each style
/// `computed` is asked for worked out once and kept. A view makes one when the sheet or the theme changes and reads it
/// as often as it draws, so no switch or hover pays for the cascade (review of #604). Not locked: use it from one thread.
public final class StyleLookup {
    public let sheet: StyleSheet
    public let dark: Bool
    public let roles: [String: StyleColor]
    /// The typed value of each `var()` declaration that works in this mode, by where its value was written.
    private var resolved: [Place: StyleValue] = [:]
    private var memo: [Key: ComputedStyle] = [:]
    /// The surfaces a rule names: nothing reaches any other.
    let named: Set<StyleSurface>

    struct Place: Hashable { let line: Int, column: Int }
    private struct Key: Hashable {
        let surface: StyleSurface
        let part: String?
        let region: String?
        let states: Set<StyleState>
    }

    public init(_ sheet: StyleSheet, dark: Bool, roles: [String: StyleColor]) {
        self.sheet = sheet; self.dark = dark; self.roles = roles
        named = Set(sheet.rules.flatMap { rule in rule.selectors.compactMap(\.surface) })
        let expander = StyleVars.Expander(custom: dark ? sheet.customDark : sheet.customLight, roles: roles)
        // The same value written in many rules is worked out once.
        var byText: [String: StyleValue?] = [:]
        for rule in sheet.rules where rule.media?.matches(dark: dark) ?? true {
            for d in rule.declarations where d.value == nil {
                guard let property = StyleProperty.byName[d.property] else { continue }
                let key = d.property + "\u{0}" + d.tokens.map(\.text).joined()
                let v: StyleValue?
                if let known = byText[key] { v = known } else {
                    if case .success(let t) = expander.substitute(d.tokens), case .success(let parsed) = StyleValues.parse(property, t) { v = parsed } else { v = nil }
                    byText[key] = v
                }
                if let v { resolved[Place(line: d.line, column: d.column)] = v }
            }
        }
    }

    /// `StyleSheet.computed`, kept once worked out.
    public func computed(surface: StyleSurface, part: String? = nil, region: String? = nil, states: Set<StyleState> = []) -> ComputedStyle {
        let key = Key(surface: surface, part: part, region: region, states: states)
        if let known = memo[key] { return known }
        let c = !named.contains(surface) ? .empty : (cascade(surface: surface, part: part, region: region, states: states)?.last?.computed ?? .empty)
        memo[key] = c
        return c
    }

    /// One step down from the surface to the part: what it matches and what it ends up with.
    struct Level {
        let target: StyleTarget
        let selector: StyleSelector
        /// After inheritance, colors resolved (`currentColor` too).
        var values: [String: StyleValue] = [:]
        /// Where each property this level sets itself was written.
        var own: [String: (line: Int, column: Int)] = [:]
        var computed = ComputedStyle()
    }

    func cascade(surface: StyleSurface, part: String?, region: String?, states: Set<StyleState>) -> [Level]? {
        guard let target = StyleTarget.of(surface, part: part) else { return nil }
        var chain: [(StyleTarget, StyleSelector)] = []
        switch target {
        case .barModule, .barIsland:
            chain.append((.bar, StyleSelector(surface: .bar)))
            if let region, StyleTarget.barRegion.parts.contains(region) { chain.append((.barRegion, StyleSelector(surface: .bar, part: region))) }
        case .barWorkspace:
            chain.append((.bar, StyleSelector(surface: .bar)))
            if let region, StyleTarget.barRegion.parts.contains(region) { chain.append((.barRegion, StyleSelector(surface: .bar, part: region))) }
            chain.append((.barModule, StyleSelector(surface: .bar, part: "workspaces", states: states.intersection(StyleTarget.barModule.states))))
        default:
            // A part, what it sits in and the surface, each in as many of the states as it takes.
            var above = target.parent
            while let t = above {
                chain.insert((t, StyleSelector(surface: surface, part: t.parts.first, states: states.intersection(t.states))), at: 0)
                above = t.parent
            }
        }
        chain.append((target, StyleSelector(surface: surface, part: part, states: states.intersection(target.states))))
        var levels: [Level] = []
        for (t, sel) in chain {
            var level = Level(target: t, selector: sel)
            // Matching declarations, by specificity then order: the later one wins a tie.
            var hits: [(spec: Int, order: Int, decl: StyleDeclaration)] = []
            var order = 0
            for rule in sheet.rules {
                guard rule.media?.matches(dark: dark) ?? true else { order += rule.declarations.count; continue }
                let spec = rule.selectors.filter { $0.surface == sel.surface && $0.part == sel.part && $0.states.isSubset(of: sel.states) }
                    .map(\.specificity).max()
                for d in rule.declarations {
                    order += 1
                    if let spec { hits.append((spec, order, d)) }
                }
            }
            hits.sort { ($0.spec, $0.order) < ($1.spec, $1.order) }
            var specified: [String: (StyleValue, Int, Int)] = [:]
            for h in hits {
                guard let property = StyleProperty.byName[h.decl.property], property.applies(to: t) else { continue }
                if let v = h.decl.value ?? resolved[Place(line: h.decl.line, column: h.decl.column)] {
                    specified[property.name] = (v, h.decl.line, h.decl.column)
                }
            }
            let parent = levels.last
            // The text color first: `currentColor` in `color` is the parent's color.
            let parentColor: StyleColor? = { if case .color(.rgba(let c))? = parent?.values["color"] { c } else { nil } }()
            let properties = StyleProperty.of[t]!
            for property in properties.taken {
                if let (v, line, column) = specified[property.name] {
                    level.values[property.name] = v
                    level.own[property.name] = (line, column)
                } else if property.inherited, let v = parent?.values[property.name] {
                    level.values[property.name] = v
                }
            }
            if case .color(.current)? = level.values["color"] {
                level.values["color"] = parentColor.map { .color(.rgba($0)) }
            }
            // Inherited values pass through a level that can't use them, so a part further down still gets them.
            if let parent {
                for property in properties.passed {
                    if let v = parent.values[property.name] { level.values[property.name] = v }
                }
            }
            let own: StyleColor? = { if case .color(.rgba(let c))? = level.values["color"] { c } else { nil } }()
            level.computed = StyleSheet.finish(level.values, target: t, current: own ?? roles["foreground"])
            levels.append(level)
        }
        return levels
    }
}

extension StyleSheet {
    static func finish(_ v: [String: StyleValue], target: StyleTarget, current: StyleColor?) -> ComputedStyle {
        func color(_ r: StyleColorRef) -> StyleColor? {
            switch r {
            case .rgba(let c): c
            case .current: current
            }
        }
        func number(_ k: String) -> Double? { if case .number(let x)? = v[k] { x } else { nil } }
        func keyword(_ k: String) -> String? { if case .keyword(let x)? = v[k] { x } else { nil } }
        func line(_ k: String) -> StyleLine? {
            switch v[k] {
            case .line(.none)?: return StyleLine.none
            case .line(.solid(let w, let c))?: return color(c).map { .solid(width: w, color: $0) }
            default: return nil
            }
        }
        var s = ComputedStyle()
        let applies = { (name: String) in StyleProperty.byName[name]!.applies(to: target) }
        if applies("color"), case .color(let c)? = v["color"] { s.color = color(c) }
        switch v["background"] {
        case .background(.none)?: s.background = StyleBackground.none
        case .background(.glass)?: s.background = .glass
        case .background(.color(let c))?: s.background = color(c).map { .color($0) }
        case .background(.gradient(let a, let b, let d))?:
            if let a = color(a), let b = color(b) { s.background = .linearGradient(a, b, d) }
        default: break
        }
        s.opacity = number("opacity")
        if applies("font-family"), case .stack(let f)? = v["font-family"] { s.fontFamily = f }
        if applies("font-size") { s.fontSize = number("font-size") }
        if applies("font-weight") { s.fontWeight = number("font-weight") }
        if applies("font-style") { s.fontStyle = keyword("font-style").flatMap(StyleFontStyle.init(rawValue:)) }
        if applies("letter-spacing") { s.letterSpacing = number("letter-spacing") }
        if applies("text-transform") { s.textTransform = keyword("text-transform").flatMap(StyleTextTransform.init(rawValue:)) }
        if applies("font-variant-numeric") { s.fontVariantNumeric = keyword("font-variant-numeric").flatMap(StyleNumerals.init(rawValue:)) }
        s.height = number("height")
        s.width = number("width")
        if case .insets(let p)? = v["padding"] { s.padding = p }
        s.gap = number("gap")
        s.borderRadius = number("border-radius")
        s.border = line("border")
        s.borderBottom = line("border-bottom")
        switch v["box-shadow"] {
        case .shadow(.none)?: s.boxShadow = StyleShadow.none
        case .shadow(.drop(let x, let y, let b, let c))?: s.boxShadow = color(c).map { .drop(x: x, y: y, blur: b, color: $0) }
        default: break
        }
        s.display = keyword("display").flatMap(StyleDisplay.init(rawValue:))
        s.transitionDuration = number("transition-duration")
        return s
    }

    // MARK: Contrast

    /// Everything that draws text, in every region and state it can be in.
    static let textNodes: [(StyleSurface, String?, String?, Set<StyleState>)] = {
        let color = StyleProperty.byName["color"]!
        var nodes: [(StyleSurface, String?, String?, Set<StyleState>)] = []
        for t in StyleTarget.allCases where color.applies(to: t) {
            let regions = [nil] + ([.barModule, .barWorkspace].contains(t) ? StyleTarget.barRegion.parts.map(Optional.some) : [])
            // Every set of its states, the fewest first.
            let sets = StyleState.allCases.filter(t.reach.contains)
                .reduce([Set<StyleState>()]) { sets, st in sets + sets.map { $0.union([st]) } }
            for part in t.parts.isEmpty ? [nil] : t.parts.map(Optional.some) {
                for region in regions { for st in sets { nodes.append((t.surface, part, region, st)) } }
            }
        }
        return nodes
    }()

    /// Text the sheet colors (or puts on a background it sets) that reads below 3:1 on what is behind it, in either mode.
    /// `roles(dark)` stands for the theme in force; `background` is the base under every surface.
    func contrastWarnings(roles: (Bool) -> [String: StyleColor]) -> [StyleProblem] {
        var out: [StyleProblem] = []
        var seen = Set<String>()
        for dark in [false, true] {
            let r = roles(dark)
            guard let base = r["background"] else { continue }
            let lookup = StyleLookup(self, dark: dark, roles: r)
            for (surface, part, region, states) in Self.textNodes where lookup.named.contains(surface) {
                guard let levels = lookup.cascade(surface: surface, part: part, region: region, states: states),
                      let last = levels.last,
                      levels.contains(where: { $0.own["color"] != nil || $0.own["background"] != nil }) else { continue }
                var behind = [base]
                for level in levels {
                    switch level.computed.background {
                    case .color(let c)?: behind = behind.map { c.over($0) }
                    case .linearGradient(let a, let b, _)?: behind = behind.flatMap { [a.over($0), b.over($0)] }
                    case .glass?: behind = [base]
                    default: break
                    }
                }
                guard let text = last.computed.color ?? r["foreground"] else { continue }
                let (ratio, bg) = behind.map { (text.over($0).contrast(with: $0), $0) }.min { $0.0 < $1.0 }!
                guard ratio < 3 else { continue }
                let at = last.own["color"] ?? levels.reversed().lazy.compactMap { $0.own["background"] ?? $0.own["color"] }.first!
                let key = "\(at.line):\(at.column):\(dark)"
                guard seen.insert(key).inserted else { continue }
                out.append(StyleProblem(line: at.line, column: at.column, severity: .warning,
                                        message: "`\(last.selector)`: text \(text.over(bg).hex) on \(bg.hex) is "
                                            + String(format: "%.1f", (ratio * 10).rounded(.down) / 10) + ":1 in \(dark ? "dark" : "light") mode; text needs at least 3:1"))
            }
        }
        return out
    }
}
