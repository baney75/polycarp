import Foundation

// The style sheet's syntax: a CSS tokenizer cut down to what the subset needs, and a parser that finds rules, `@media`
// blocks and declarations with their places in the text. It never recurses on the input, so no nesting, however deep,
// can overflow the stack, and every loop moves forward, so nothing hangs. Edits (`StyleEdit`) use the same places.

struct StyleToken: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case ident(String)
        /// A name followed by "(": the "(" belongs to it.
        case function(String)
        case atKeyword(String)
        case hash(String)
        case string(String)
        /// The number and its unit: "" for none, "%" or the unit in lower case.
        case number(Double, String)
        case whitespace, colon, semicolon, comma
        case openBrace, closeBrace, openParen, closeParen, openBracket, closeBracket
        case delim(String)
        case badString
        /// A theme role, put in by `var()`.
        case color(StyleColor)
    }

    var kind: Kind
    /// As written.
    var text: String
    /// Unicode scalar offsets into the sheet, end exclusive.
    var start: Int
    var end: Int
    var line: Int
    var column: Int

    var isSpace: Bool { kind == .whitespace }
    var opens: Bool {
        switch kind {
        case .function, .openParen, .openBracket: true
        default: false
        }
    }
    var closes: Bool { kind == .closeParen || kind == .closeBracket }

    func ident(_ name: String) -> Bool {
        if case .ident(let n) = kind { return n.lowercased() == name }
        return false
    }
}

enum StyleLexer {
    static func tokens(_ s: [Unicode.Scalar], problems: inout [StyleProblem]) -> [StyleToken] {
        var out: [StyleToken] = []
        out.reserveCapacity(s.count / 3)
        var i = 0, line = 1, column = 1
        let n = s.count
        func at(_ k: Int) -> Unicode.Scalar? { k < n ? s[k] : nil }
        func advance(to k: Int) {
            while i < k {
                if s[i] == "\n" { line += 1; column = 1 } else { column += 1 }
                i += 1
            }
        }
        func isNameStart(_ c: Unicode.Scalar?) -> Bool {
            guard let c else { return false }
            return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c == "_" || c.value >= 0x80
        }
        func isName(_ c: Unicode.Scalar?) -> Bool {
            guard let c else { return false }
            return isNameStart(c) || (c >= "0" && c <= "9") || c == "-"
        }
        func isDigit(_ c: Unicode.Scalar?) -> Bool { c.map { $0 >= "0" && $0 <= "9" } ?? false }
        func startsIdent(_ k: Int) -> Bool {
            if isNameStart(at(k)) { return true }
            if at(k) == "-" { return isNameStart(at(k + 1)) || at(k + 1) == "-" }
            return false
        }
        func startsNumber(_ k: Int) -> Bool {
            if isDigit(at(k)) { return true }
            if at(k) == ".", isDigit(at(k + 1)) { return true }
            if at(k) == "+" || at(k) == "-" { return isDigit(at(k + 1)) || (at(k + 1) == "." && isDigit(at(k + 2))) }
            return false
        }
        func nameEnd(_ k: Int) -> Int { var e = k; while isName(at(e)) { e += 1 }; return e }
        func text(_ a: Int, _ b: Int) -> String {
            var str = String.UnicodeScalarView()
            str.append(contentsOf: s[a..<b])
            return String(str)
        }

        while i < n {
            let c = s[i], start = i, l = line, col = column
            func emit(_ kind: StyleToken.Kind, to end: Int) {
                advance(to: end)
                out.append(StyleToken(kind: kind, text: text(start, end), start: start, end: end, line: l, column: col))
            }
            if c == "/", at(i + 1) == "*" {
                var e = i + 2
                while e < n, !(s[e] == "*" && at(e + 1) == "/") { e += 1 }
                if e >= n {
                    problems.append(StyleProblem(line: l, column: col, message: "a comment is never closed: `*/` is missing"))
                    advance(to: n)
                } else {
                    advance(to: e + 2)
                }
                continue
            }
            switch c {
            case " ", "\t", "\n", "\r", "\u{0C}":
                var e = i
                while let d = at(e), d == " " || d == "\t" || d == "\n" || d == "\r" || d == "\u{0C}" { e += 1 }
                emit(.whitespace, to: e)
            case "\"", "'":
                var e = i + 1
                var value = String.UnicodeScalarView()
                var closed = false
                while e < n {
                    let d = s[e]
                    if d == c { closed = true; e += 1; break }
                    if d == "\n" { break }
                    if d == "\\", e + 1 < n {
                        if s[e + 1] != "\n" { value.append(s[e + 1]) }
                        e += 2; continue
                    }
                    value.append(d); e += 1
                }
                if closed {
                    emit(.string(String(value)), to: e)
                } else {
                    problems.append(StyleProblem(line: l, column: col, message: "a string is never closed on its line"))
                    emit(.badString, to: e)
                }
            case "#":
                if isName(at(i + 1)) { let e = nameEnd(i + 1); emit(.hash(text(i + 1, e)), to: e) } else { emit(.delim("#"), to: i + 1) }
            case "(": emit(.openParen, to: i + 1)
            case ")": emit(.closeParen, to: i + 1)
            case "[": emit(.openBracket, to: i + 1)
            case "]": emit(.closeBracket, to: i + 1)
            case "{": emit(.openBrace, to: i + 1)
            case "}": emit(.closeBrace, to: i + 1)
            case ",": emit(.comma, to: i + 1)
            case ":": emit(.colon, to: i + 1)
            case ";": emit(.semicolon, to: i + 1)
            case "@":
                if startsIdent(i + 1) { let e = nameEnd(i + 1); emit(.atKeyword(text(i + 1, e).lowercased()), to: e) } else { emit(.delim("@"), to: i + 1) }
            default:
                if startsNumber(i) {
                    var e = i
                    if s[e] == "+" || s[e] == "-" { e += 1 }
                    while isDigit(at(e)) { e += 1 }
                    if at(e) == ".", isDigit(at(e + 1)) { e += 1; while isDigit(at(e)) { e += 1 } }
                    if let x = at(e), x == "e" || x == "E" {
                        if isDigit(at(e + 1)) { e += 1; while isDigit(at(e)) { e += 1 } }
                        else if (at(e + 1) == "+" || at(e + 1) == "-"), isDigit(at(e + 2)) { e += 2; while isDigit(at(e)) { e += 1 } }
                    }
                    let number = Double(text(i, e)) ?? .infinity
                    if at(e) == "%" { emit(.number(number, "%"), to: e + 1) }
                    else if startsIdent(e) { let u = nameEnd(e); emit(.number(number, text(e, u).lowercased()), to: u) }
                    else { emit(.number(number, ""), to: e) }
                } else if startsIdent(i) {
                    let e = nameEnd(i)
                    if at(e) == "(" { emit(.function(text(i, e).lowercased()), to: e + 1) } else { emit(.ident(text(i, e)), to: e) }
                } else {
                    emit(.delim(String(c)), to: i + 1)
                }
            }
        }
        return out
    }
}

// MARK: Rules, as found in the text

struct StyleRawDeclaration: Sendable {
    /// As written (custom properties keep their case).
    let name: String
    let value: [StyleToken]
    let important: Bool
    let line: Int, column: Int
    let valueLine: Int, valueColumn: Int
    /// Scalar offsets: the name's start to just past its `;` (or its value, when the `;` is missing).
    let start: Int, end: Int
    let valueStart: Int, valueEnd: Int
    let hasSemicolon: Bool
}

struct StyleRawRule: Sendable {
    /// Nil when a selector in the list is invalid: the whole rule is dropped, as CSS does.
    let selectors: [StyleSelector]?
    let media: StyleMedia?
    /// The rule sits inside an `@media` block.
    let nested: Bool
    let declarations: [StyleRawDeclaration]
    let line: Int, column: Int
    /// Scalar offsets of the selector's start, the `{`, and the `}` (nil when the block is never closed).
    let start: Int, open: Int, close: Int?
    /// The selector as written, lowercased with each run of space made one (`StyleSyntax.plain`): how `style unset`
    /// finds a rule for a retired surface (`dock .tile`), which has no `StyleSelector`.
    var selectorText = ""
    /// Each selector of the list, as `StyleSyntax.key` text, with its scalar offsets.
    var items: [(key: String, start: Int, end: Int)] = []
}

struct StyleRawMedia: Sendable {
    let media: StyleMedia
    let start: Int, open: Int, close: Int?
}

/// One pass over the text: every rule, every `@media` block and every syntax problem.
struct StyleSyntax {
    let scalars: [Unicode.Scalar]
    let tokens: [StyleToken]
    private(set) var rules: [StyleRawRule] = []
    private(set) var medias: [StyleRawMedia] = []
    private(set) var problems: [StyleProblem] = []

    init(_ text: String) {
        scalars = Array(text.unicodeScalars)
        var p: [StyleProblem] = []
        tokens = StyleLexer.tokens(scalars, problems: &p)
        problems = p
        ruleList(from: 0, to: tokens.count, media: nil)
    }

    private mutating func problem(_ t: StyleToken, _ message: String) {
        problems.append(StyleProblem(line: t.line, column: t.column, message: message))
    }

    /// The `}` that closes the `{` at `open`, before `limit`.
    private func close(of open: Int, limit: Int) -> Int? {
        var depth = 0
        var k = open
        while k < limit {
            switch tokens[k].kind {
            case .openBrace: depth += 1
            case .closeBrace:
                depth -= 1
                if depth == 0 { return k }
            default: break
            }
            k += 1
        }
        return nil
    }

    /// The text of tokens `a..<b`, spaces folded to one.
    func text(_ a: Int, _ b: Int) -> String {
        var out = ""
        for t in tokens[a..<b] { out += t.isSpace ? " " : t.text }
        return out.trimmingCharacters(in: .whitespaces)
    }

    private mutating func ruleList(from: Int, to limit: Int, media: StyleMedia?) {
        var i = from
        while i < limit {
            let t = tokens[i]
            switch t.kind {
            case .whitespace, .semicolon: i += 1
            case .closeBrace:
                problem(t, "a `}` with no `{` before it")
                i += 1
            case .atKeyword: i = atRule(i, limit: limit, nested: media != nil)
            default: i = qualifiedRule(i, limit: limit, media: media)
            }
        }
    }

    private mutating func atRule(_ i: Int, limit: Int, nested: Bool) -> Int {
        guard case .atKeyword(let name) = tokens[i].kind else { return i + 1 }
        var j = i + 1
        while j < limit, tokens[j].kind != .openBrace, tokens[j].kind != .semicolon { j += 1 }
        let hasBlock = j < limit && tokens[j].kind == .openBrace
        let end = hasBlock ? close(of: j, limit: limit) : nil
        let next = hasBlock ? (end.map { $0 + 1 } ?? limit) : min(j + 1, limit)
        if name == "media", !nested, hasBlock {
            guard let media = mediaQuery(i + 1, j) else {
                problem(tokens[i], "only `@media (prefers-color-scheme: dark)` and `@media (prefers-color-scheme: light)` are supported, not `@media \(text(i + 1, j))`")
                return next
            }
            if end == nil { problem(tokens[j], "the `@media` block opened here is never closed: a `}` is missing") }
            medias.append(StyleRawMedia(media: media, start: tokens[i].start, open: tokens[j].start, close: end.map { tokens[$0].start }))
            ruleList(from: j + 1, to: end ?? limit, media: media)
            return next
        }
        if name == "media" {
            problem(tokens[i], nested ? "`@media` can't go inside another `@media`" : "`@media` needs a `{ ... }` block of rules")
        } else {
            problem(tokens[i], "`@\(name)` isn't supported; the only at-rule is `@media (prefers-color-scheme: dark)` (or `light`)")
        }
        return next
    }

    private func mediaQuery(_ a: Int, _ b: Int) -> StyleMedia? {
        let t = tokens[a..<b].filter { !$0.isSpace }
        guard t.count == 5, t[0].kind == .openParen, t[1].ident("prefers-color-scheme"), t[2].kind == .colon, t[4].kind == .closeParen,
              case .ident(let mode) = t[3].kind else { return nil }
        return StyleMedia(rawValue: mode.lowercased())
    }

    private mutating func qualifiedRule(_ i: Int, limit: Int, media: StyleMedia?) -> Int {
        var j = i
        while j < limit, tokens[j].kind != .openBrace {
            if tokens[j].kind == .semicolon || tokens[j].kind == .closeBrace {
                let looksLikeDeclaration = tokens[i...j].contains { $0.kind == .colon } && !tokens[i...j].contains { $0.kind == .delim(".") }
                problem(tokens[i], looksLikeDeclaration
                    ? "`\(text(i, j))` is outside any rule; put it in a block, like `bar { \(text(i, j)); }`"
                    : "expected a selector and a `{ ... }` block, found `\(text(i, j + 1))`")
                return tokens[j].kind == .semicolon ? j + 1 : j
            }
            j += 1
        }
        guard j < limit else {
            problem(tokens[i], "`\(text(i, limit))` has no `{ ... }` block")
            return limit
        }
        let end = close(of: j, limit: limit)
        if end == nil { problem(tokens[j], "the block opened here is never closed: a `}` is missing") }
        let selectors = selectorList(i, j)
        let items = tokens[i..<j].split { $0.kind == .comma }.compactMap { part -> (key: String, start: Int, end: Int)? in
            guard let a = part.firstIndex(where: { !$0.isSpace }), let b = part.lastIndex(where: { !$0.isSpace }) else { return nil }
            return (Self.key(text(a, b + 1)), tokens[a].start, tokens[b].end)
        }
        let declarations = declarationList(j + 1, end ?? limit)
        rules.append(StyleRawRule(selectors: selectors, media: media, nested: media != nil, declarations: declarations,
                                  line: tokens[i].line, column: tokens[i].column,
                                  start: tokens[i].start, open: tokens[j].start, close: end.map { tokens[$0].start },
                                  selectorText: Self.plain(text(i, j)), items: items))
        return end.map { $0 + 1 } ?? limit
    }

    // MARK: Declarations

    /// Past the declaration (or junk) that starts at `k`: after its `;`, or after a nested block it holds.
    private mutating func skip(_ k: Int, _ limit: Int) -> (next: Int, block: Bool) {
        var j = k
        while j < limit {
            switch tokens[j].kind {
            case .semicolon: return (j + 1, false)
            case .openBrace: return ((close(of: j, limit: limit) ?? limit - 1) + 1, true)
            default: j += 1
            }
        }
        return (limit, false)
    }

    private mutating func declarationList(_ from: Int, _ limit: Int) -> [StyleRawDeclaration] {
        var out: [StyleRawDeclaration] = []
        var k = from
        while k < limit {
            let t = tokens[k]
            if t.isSpace || t.kind == .semicolon { k += 1; continue }
            guard case .ident(let name) = t.kind else {
                let (next, block) = skip(k, limit)
                problem(t, block ? "a rule can't hold another rule (nested CSS isn't supported); write each selector at the top level"
                                 : "expected a property name, found `\(text(k, min(next, limit)).trimmingCharacters(in: CharacterSet(charactersIn: ";")))`")
                k = next
                continue
            }
            var m = k + 1
            while m < limit, tokens[m].isSpace { m += 1 }
            guard m < limit, tokens[m].kind == .colon else {
                let (next, block) = skip(k, limit)
                problem(t, block ? "a rule can't hold another rule (nested CSS isn't supported); write each selector at the top level"
                                 : "expected `:` after `\(name)`")
                k = next
                continue
            }
            // The value: up to a `;` outside parentheses. A `{` means a nested rule, which is dropped whole.
            var v = m + 1
            var depth = 0
            var nestedBlock = false
            while v < limit {
                let x = tokens[v]
                if x.opens { depth += 1 } else if x.closes { depth = max(0, depth - 1) }
                if x.kind == .semicolon && depth == 0 { break }
                if x.kind == .openBrace { nestedBlock = true; break }
                v += 1
            }
            if nestedBlock {
                problem(t, "a rule can't hold another rule (nested CSS isn't supported); write each selector at the top level")
                k = (close(of: v, limit: limit) ?? limit - 1) + 1
                continue
            }
            var a = m + 1, b = v
            while a < b, tokens[a].isSpace { a += 1 }
            while b > a, tokens[b - 1].isSpace { b -= 1 }
            var value = Array(tokens[a..<b])
            var important = false
            let solid = value.enumerated().filter { !$0.element.isSpace }
            if solid.count >= 2, solid[solid.count - 1].element.ident("important"), solid[solid.count - 2].element.kind == .delim("!") {
                important = true
                value = Array(value[..<solid[solid.count - 2].offset])
                while value.last?.isSpace == true { value.removeLast() }
            }
            let hasSemicolon = v < limit
            let colon = tokens[m]
            out.append(StyleRawDeclaration(
                name: name, value: value, important: important, line: t.line, column: t.column,
                valueLine: a < b ? tokens[a].line : colon.line, valueColumn: a < b ? tokens[a].column : colon.column + 1,
                start: t.start, end: hasSemicolon ? tokens[v].end : (b > a ? tokens[b - 1].end : colon.end),
                valueStart: a < b ? tokens[a].start : colon.end, valueEnd: b > a ? tokens[b - 1].end : colon.end,
                hasSemicolon: hasSemicolon))
            k = hasSemicolon ? v + 1 : limit
        }
        return out
    }

    // MARK: Selectors

    /// Every selector in the list, or nil (with a problem each) when one of them can't be used.
    private mutating func selectorList(_ a: Int, _ b: Int) -> [StyleSelector]? {
        var parts: [(Int, Int)] = []
        var s = a
        for k in a..<b where tokens[k].kind == .comma { parts.append((s, k)); s = k + 1 }
        parts.append((s, b))
        var out: [StyleSelector] = []
        var ok = true
        for (x, y) in parts {
            switch selector(x, y) {
            case .success(let sel): out.append(sel)
            case .failure(let why):
                let at = tokens[x..<y].first { !$0.isSpace } ?? tokens[min(x, tokens.count - 1)]
                // A retired surface (an older build's `dock`) only warns: the rest of the list still applies.
                if why.retired {
                    problems.append(StyleProblem(line: at.line, column: at.column, severity: .warning, message: why.message + "; the selector is ignored"))
                    continue
                }
                problems.append(StyleProblem(line: at.line, column: at.column, message: why.message + "; the rule is dropped"))
                ok = false
            }
        }
        if ok, parts.count > 1, out.contains(where: \.isRoot) {
            problem(tokens[a], "`:root` must be alone in its rule; the rule is dropped")
            return nil
        }
        return ok && !out.isEmpty ? out : nil
    }

    struct SelectorError: Error {
        let message: String
        /// It names a surface an older build had, not a mistake.
        var retired = false
    }

    static var surfacesText: String { StyleNumber.list(StyleSurface.allCases.map { "`\($0.rawValue)`" }, last: "and") }

    static func partsText(_ surface: StyleSurface) -> String {
        StyleTarget.allCases.filter { $0.surface == surface }.flatMap(\.parts).map { "`.\($0)`" }.joined(separator: " ")
    }

    func selector(_ a: Int, _ b: Int) -> Result<StyleSelector, SelectorError> {
        let written = text(a, b)
        var t = Array(tokens[a..<b])
        while t.first?.isSpace == true { t.removeFirst() }
        while t.last?.isSpace == true { t.removeLast() }
        func fail(_ m: String) -> Result<StyleSelector, SelectorError> { .failure(SelectorError(message: m)) }
        guard let first = t.first else { return fail("an empty selector (a stray comma?)") }
        if first.kind == .colon, t.count == 2, t[1].ident("root") { return .success(.root) }
        if let bad = t.first(where: { [.delim("*"), .delim(">"), .delim("+"), .delim("~"), .openBracket].contains($0.kind) || { if case .hash = $0.kind { true } else { false } }($0) }) {
            switch bad.kind {
            case .delim("*"): return fail("`*` isn't supported; name a surface: \(Self.surfacesText)")
            case .hash: return fail("ids (`\(bad.text)`) aren't supported; a selector is a surface and a part, like `bar .clock`")
            case .openBracket: return fail("attribute selectors aren't supported; a selector is a surface and a part, like `bar .clock`")
            default: return fail("`\(bad.text)` isn't supported; a selector is a surface, a space and one part, like `bar .clock`")
            }
        }
        guard case .ident(let name) = first.kind else {
            if first.kind == .delim("."), t.count > 1, case .ident(let p) = t[1].kind {
                let owner = StyleTarget.allCases.first { $0.parts.contains(p) }?.surface.rawValue ?? "bar"
                return fail("`.\(p)` needs its surface first: write `\(owner) .\(p)`")
            }
            return fail("`\(written)` isn't a selector; start with a surface: \(Self.surfacesText)")
        }
        if let why = StyleSurface.retired[name.lowercased()] {
            return .failure(SelectorError(message: "`\(name)` \(why)", retired: true))
        }
        guard let surface = StyleSurface(rawValue: name.lowercased()) else {
            return fail("unknown surface `\(name)`; the surfaces are \(Self.surfacesText)")
        }
        var rest = Array(t.dropFirst())
        if rest.isEmpty { return .success(StyleSelector(surface: surface)) }
        guard rest.first?.isSpace == true else {
            if rest.first?.kind == .colon, rest.count > 1, case .ident(let p) = rest[1].kind {
                return fail("`\(name)` takes no states (`:\(p)`); states go on a part, like `bar .workspace:hover`")
            }
            return fail("write `\(written.replacingOccurrences(of: name + ".", with: name + " ."))` with a space: a part is inside its surface")
        }
        rest = Array(rest.drop { $0.isSpace })
        // One compound: `.part`, then `.state` classes and `:state` pseudo-classes in any order.
        var classes: [String] = []
        var pseudos: [String] = []
        var k = 0
        while k < rest.count {
            let x = rest[k]
            if x.isSpace {
                return fail("a selector is a surface and at most one part (`\(name) .\(classes.first ?? "part")`), not `\(written)`")
            }
            if x.kind == .delim("."), k + 1 < rest.count, case .ident(let c) = rest[k + 1].kind {
                classes.append(c); k += 2; continue
            }
            if x.kind == .colon, k + 1 < rest.count, case .ident(let c) = rest[k + 1].kind {
                pseudos.append(c); k += 2; continue
            }
            if x.kind == .colon, k + 1 < rest.count, rest[k + 1].kind == .colon {
                return fail("pseudo-elements (`::`) aren't supported")
            }
            return fail("`\(x.text)` isn't supported in a selector; write a surface and a part, like `bar .clock`")
        }
        guard let partName = classes.first else {
            return fail("`\(written)` names no part; write a part as a class, like `\(name) .\(StyleTarget.allCases.first { $0.surface == surface && !$0.parts.isEmpty }!.parts[0])`")
        }
        guard let target = StyleTarget.of(surface, part: partName) else {
            return fail("`\(name)` has no part `.\(partName)`; its parts are \(Self.partsText(surface))")
        }
        var states = Set<StyleState>()
        let allowed = target.states.map(\.selector)
        let takes = allowed.isEmpty ? "takes no states" : "takes \(StyleNumber.list(allowed.map { "`\($0)`" }, last: "and"))"
        for c in classes.dropFirst() {
            guard let st = StyleState(rawValue: c), st == .current, target.states.contains(st) else {
                return fail("`.\(c)` isn't a state of `\(name) .\(partName)`, which \(takes)")
            }
            states.insert(st)
        }
        for p in pseudos {
            guard p.lowercased() == "hover", target.states.contains(.hover) else {
                return fail("`:\(p)` isn't a state of `\(name) .\(partName)`, which \(takes)")
            }
            states.insert(.hover)
        }
        return .success(StyleSelector(surface: surface, part: partName, states: states))
    }

    /// Selector text compared as written: lowercased, each run of space made one.
    static func plain(_ text: String) -> String {
        text.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// `plain` text with the states after a part in one order: `dock .tile.current:hover` is `dock .tile:hover.current`.
    static func key(_ text: String) -> String {
        plain(text).split(separator: " ").map { word in
            var pieces: [String] = []
            for c in word {
                if c == "." || c == ":" || pieces.isEmpty { pieces.append(String(c)) } else { pieces[pieces.count - 1].append(c) }
            }
            return pieces[0] + pieces.dropFirst().sorted().joined()
        }.joined(separator: " ")
    }

    /// One selector on its own, as `style set` takes it: the canonical selector or why not.
    static func selector(_ text: String) -> Result<StyleSelector, SelectorError> {
        let syntax = StyleSyntax(tokensOnly: text)
        if syntax.tokens.contains(where: { $0.kind == .comma }) { return .failure(SelectorError(message: "one selector at a time, not a list")) }
        if syntax.tokens.contains(where: { [.openBrace, .closeBrace, .semicolon].contains($0.kind) }) || !syntax.problems.isEmpty {
            return .failure(SelectorError(message: "`\(text)` isn't a selector"))
        }
        return syntax.selector(0, syntax.tokens.count)
    }

    private init(tokensOnly text: String) {
        scalars = Array(text.unicodeScalars)
        var p: [StyleProblem] = []
        tokens = StyleLexer.tokens(scalars, problems: &p)
        problems = p
    }

    /// A value on its own, as `style set` takes it: its tokens, or nil when it would break out of its declaration.
    static func valueTokens(_ text: String) -> [StyleToken]? {
        let syntax = StyleSyntax(tokensOnly: text)
        guard syntax.problems.isEmpty, !text.contains("/*"), !text.contains(where: \.isNewline) else { return nil }
        if syntax.tokens.contains(where: { [.openBrace, .closeBrace, .semicolon, .badString].contains($0.kind) }) { return nil }
        return syntax.tokens
    }
}
