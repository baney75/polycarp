import Foundation

/// The part of TOML the launcher's files use (snippets.toml, extension.toml): `key = value`, `[table]`, `[[array]]`,
/// strings (basic, literal, and both multi-line kinds), integers, floats, booleans and arrays.
/// Dotted keys, inline tables and dates are refused with a line number rather than misread.
public enum LauncherTOML {
    public indirect enum Value: Equatable, Sendable {
        case string(String)
        case int(Int)
        case double(Double)
        case bool(Bool)
        case array([Value])
        case table([String: Value])

        public var string: String? { if case .string(let s) = self { return s }; return nil }
        public var int: Int? { if case .int(let n) = self { return n }; return nil }
        public var double: Double? {
            switch self { case .double(let d): d; case .int(let n): Double(n); default: nil }
        }
        public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
        public var array: [Value]? { if case .array(let a) = self { return a }; return nil }
        public var table: [String: Value]? { if case .table(let t) = self { return t }; return nil }
    }

    public struct ParseError: Error, Equatable, CustomStringConvertible {
        public let line: Int
        public let message: String
        public var description: String { "line \(line): \(message)" }
    }

    public static func parse(_ text: String) throws -> [String: Value] {
        var p = Parser(Array(text.unicodeScalars))
        return try p.document()
    }

    private struct Parser {
        let s: [Unicode.Scalar]
        var i = 0
        var line = 1
        var root: [String: Value] = [:]
        /// Where `key = value` lines go: nil for the root, else a table name, and for `[[name]]` the
        /// last element of that array.
        var current: (name: String, isArray: Bool)?

        init(_ s: [Unicode.Scalar]) { self.s = s }

        func fail(_ m: String) -> ParseError { ParseError(line: line, message: m) }
        var atEnd: Bool { i >= s.count }
        func at(_ k: Int = 0) -> Unicode.Scalar? { i + k < s.count ? s[i + k] : nil }

        mutating func skipBlank() { while let c = at(), c == " " || c == "\t" { i += 1 } }

        /// Spaces, comments and newlines, for inside arrays.
        mutating func skipAll() {
            while let c = at() {
                if c == " " || c == "\t" || c == "\r" { i += 1 }
                else if c == "\n" { i += 1; line += 1 }
                else if c == "#" { while let d = at(), d != "\n" { i += 1 } }
                else { return }
            }
        }

        mutating func endOfLine() throws {
            skipBlank()
            if at() == "#" { while let d = at(), d != "\n" { i += 1 } }
            if at() == "\r" { i += 1 }
            guard atEnd || at() == "\n" else { throw fail("unexpected text after the value") }
        }

        mutating func document() throws -> [String: Value] {
            while !atEnd {
                skipBlank()
                guard let c = at() else { break }
                if c == "\n" { i += 1; line += 1; continue }
                if c == "\r" || c == "#" { try endOfLine(); continue }
                if c == "[" { try header() } else { try keyValue() }
                try endOfLine()
            }
            return root
        }

        mutating func header() throws {
            let isArray = at(1) == "["
            i += isArray ? 2 : 1
            skipBlank()
            let name = try key()
            skipBlank()
            guard at() == "]", !isArray || at(1) == "]" else { throw fail("a table header needs its closing bracket") }
            i += isArray ? 2 : 1
            if isArray {
                var list = root[name]?.array ?? []
                if root[name] != nil, root[name]?.array == nil { throw fail("\(name) is already a value") }
                list.append(.table([:]))
                root[name] = .array(list)
            } else {
                if root[name] != nil { throw fail("[\(name)] appears twice") }
                root[name] = .table([:])
            }
            current = (name, isArray)
        }

        mutating func key() throws -> String {
            if at() == "\"" || at() == "'" {
                let v = try value()
                guard case .string(let k) = v else { throw fail("a key must be a name") }
                return k
            }
            var k = ""
            while let c = at(), CharacterSet.alphanumerics.contains(c) || c == "_" || c == "-" { k.unicodeScalars.append(c); i += 1 }
            guard !k.isEmpty else { throw fail("expected a key name") }
            if at() == "." { throw fail("dotted keys are not supported; use a [table]") }
            return k
        }

        mutating func keyValue() throws {
            let k = try key()
            skipBlank()
            guard at() == "=" else { throw fail("expected = after \(k)") }
            i += 1
            skipBlank()
            let v = try value()
            try set(k, v)
        }

        mutating func set(_ k: String, _ v: Value) throws {
            guard let cur = current else {
                if root[k] != nil { throw fail("\(k) is set twice") }
                root[k] = v
                return
            }
            if cur.isArray {
                var list = root[cur.name]!.array!
                var t = list[list.count - 1].table!
                if t[k] != nil { throw fail("\(k) is set twice") }
                t[k] = v
                list[list.count - 1] = .table(t)
                root[cur.name] = .array(list)
            } else {
                var t = root[cur.name]!.table!
                if t[k] != nil { throw fail("\(k) is set twice") }
                t[k] = v
                root[cur.name] = .table(t)
            }
        }

        mutating func value() throws -> Value {
            guard let c = at() else { throw fail("expected a value") }
            switch c {
            case "\"": return .string(at(1) == "\"" && at(2) == "\"" ? try multiline(basic: true) : try basic())
            case "'": return .string(at(1) == "'" && at(2) == "'" ? try multiline(basic: false) : try literal())
            case "[": return try array()
            case "{": throw fail("inline tables are not supported")
            case "t", "f": return try boolean()
            default: return try number()
            }
        }

        mutating func basic() throws -> String {
            i += 1
            var out = ""
            while let c = at() {
                if c == "\"" { i += 1; return out }
                if c == "\n" { break }
                if c == "\\" { out.unicodeScalars.append(try escape()); continue }
                out.unicodeScalars.append(c)
                i += 1
            }
            throw fail("a string is missing its closing quote")
        }

        mutating func literal() throws -> String {
            i += 1
            var out = ""
            while let c = at() {
                if c == "'" { i += 1; return out }
                if c == "\n" { break }
                out.unicodeScalars.append(c)
                i += 1
            }
            throw fail("a string is missing its closing quote")
        }

        /// `"""` or `'''`. A newline right after the opening quotes is dropped, as TOML says.
        mutating func multiline(basic: Bool) throws -> String {
            let q: Unicode.Scalar = basic ? "\"" : "'"
            i += 3
            if at() == "\r" { i += 1 }
            if at() == "\n" { i += 1; line += 1 }
            var out = ""
            while let c = at() {
                if c == q, at(1) == q, at(2) == q {
                    // Up to two more quotes right before the closing three belong to the string.
                    var n = 3
                    while n < 5, at(n) == q { n += 1 }
                    for _ in 0..<(n - 3) { out.unicodeScalars.append(q) }
                    i += n
                    return out
                }
                if c == "\n" { line += 1 }
                if basic, c == "\\" {
                    // A backslash at the end of a line trims the newline and the next line's indent.
                    var j = i + 1
                    while j < s.count, s[j] == " " || s[j] == "\t" { j += 1 }
                    if j < s.count, s[j] == "\n" || s[j] == "\r" {
                        i = j
                        while let d = at(), d == " " || d == "\t" || d == "\n" || d == "\r" { if d == "\n" { line += 1 }; i += 1 }
                        continue
                    }
                    out.unicodeScalars.append(try escape())
                    continue
                }
                out.unicodeScalars.append(c)
                i += 1
            }
            throw fail("a multi-line string is missing its closing quotes")
        }

        mutating func escape() throws -> Unicode.Scalar {
            i += 1
            guard let e = at() else { throw fail("a string ends in a backslash") }
            i += 1
            switch e {
            case "n": return "\n"
            case "t": return "\t"
            case "r": return "\r"
            case "\\": return "\\"
            case "\"": return "\""
            case "b": return "\u{8}"
            case "f": return "\u{C}"
            case "u", "U":
                let n = e == "u" ? 4 : 8
                guard i + n <= s.count else { throw fail("a \\\(e) escape is too short") }
                let hex = String(String.UnicodeScalarView(s[i..<(i + n)]))
                guard let v = UInt32(hex, radix: 16), let u = Unicode.Scalar(v) else { throw fail("\\\(e)\(hex) is not a character") }
                i += n
                return u
            default: throw fail("unknown escape \\\(e)")
            }
        }

        mutating func array() throws -> Value {
            i += 1
            var out: [Value] = []
            while true {
                skipAll()
                guard let c = at() else { throw fail("an array is missing its closing bracket") }
                if c == "]" { i += 1; return .array(out) }
                out.append(try value())
                skipAll()
                if at() == "," { i += 1; continue }
                skipAll()
                guard at() == "]" else { throw fail("expected , or ] in an array") }
            }
        }

        mutating func boolean() throws -> Value {
            for (word, v) in [("true", true), ("false", false)] {
                let w = Array(word.unicodeScalars)
                if i + w.count <= s.count, Array(s[i..<(i + w.count)]) == w { i += w.count; return .bool(v) }
            }
            throw fail("expected a value")
        }

        mutating func number() throws -> Value {
            var t = ""
            while let c = at(), CharacterSet.alphanumerics.contains(c) || c == "+" || c == "-" || c == "." || c == "_" {
                if c != "_" { t.unicodeScalars.append(c) }
                i += 1
            }
            if let n = Int(t) { return .int(n) }
            if t.contains("."), let d = Double(t) { return .double(d) }
            throw fail(t.isEmpty ? "expected a value" : "\(t) is not a value this file can hold (quote text)")
        }
    }
}
