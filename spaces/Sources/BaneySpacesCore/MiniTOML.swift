import Foundation

/// A TOML value, as far as `spaces.toml` needs: strings, whole numbers, decimals, true and false, one-line arrays and
/// inline tables, `[table]` headers and `[[array]]` tables. Dates and multi-line strings are refused with the line.
public indirect enum TOMLValue: Equatable, Sendable {
    case string(String), integer(Int), float(Double), bool(Bool), array([TOMLValue]), table(TOMLTable)

    public var string: String? { if case let .string(s) = self { s } else { nil } }
    public var integer: Int? { if case let .integer(n) = self { n } else { nil } }
    public var bool: Bool? { if case let .bool(b) = self { b } else { nil } }
    public var table: TOMLTable? { if case let .table(t) = self { t } else { nil } }
    public var array: [TOMLValue]? { if case let .array(a) = self { a } else { nil } }

    /// How the value reads in a message.
    public var shown: String {
        switch self {
        case let .string(s): "\"\(s)\""
        case let .integer(n): String(n)
        case let .float(d): String(d)
        case let .bool(b): String(b)
        case let .array(a): "[" + a.map(\.shown).joined(separator: ", ") + "]"
        case .table: "a table"
        }
    }
}

/// A table that keeps the file's order and each key's line, so a message can name both.
public struct TOMLTable: Equatable, Sendable {
    public struct Entry: Equatable, Sendable {
        public let key: String
        public var value: TOMLValue
        public let line: Int
    }

    public var entries: [Entry] = []
    public init() {}

    public subscript(key: String) -> TOMLValue? { entries.first { $0.key == key }?.value }
    public func line(of key: String) -> Int? { entries.first { $0.key == key }?.line }
}

public struct TOMLError: Error, Equatable, Sendable {
    public let line: Int
    public let reason: String
}

public enum MiniTOML {
    public static func parse(_ text: String) throws -> TOMLTable {
        var root = TOMLTable()
        var path: [String] = []
        var inArray = false
        for (i, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            let raw = line.hasSuffix("\r") ? line.dropLast() : line[...]
            let n = i + 1
            var s = LineReader(Array(raw), line: n)
            s.skipSpace()
            if s.done || s.peek == "#" { continue }
            if s.peek == "[" {
                s.next()
                let double = s.peek == "["
                if double { s.next() }
                let name = try s.keyPath(until: "]")
                try s.expect("]")
                if double { try s.expect("]") }
                try s.endOfLine()
                path = name
                inArray = double
                try open(&root, path: name, array: double, line: n)
                continue
            }
            let key = try s.keyPath(until: "=")
            try s.expect("=")
            s.skipSpace()
            let value = try s.value()
            try s.endOfLine()
            try insert(&root, at: path, inArray: inArray, key: key, value: value, line: n)
        }
        return root
    }

    private static func open(_ t: inout TOMLTable, path: [String], array: Bool, line: Int) throws {
        guard let head = path.first else { return }
        let rest = Array(path.dropFirst())
        if let i = t.entries.firstIndex(where: { $0.key == head }) {
            switch t.entries[i].value {
            case var .table(sub) where !rest.isEmpty || !array:
                if rest.isEmpty { throw TOMLError(line: line, reason: "[\(head)] appears twice") }
                try open(&sub, path: rest, array: array, line: line)
                t.entries[i].value = .table(sub)
            case var .array(items) where items.last?.table != nil:
                if rest.isEmpty, array { items.append(.table(TOMLTable())) } else {
                    guard case var .table(last) = items.removeLast() else { return }
                    try open(&last, path: rest, array: array, line: line)
                    items.append(.table(last))
                }
                t.entries[i].value = .array(items)
            default:
                throw TOMLError(line: line, reason: "\(head) is already set to a value")
            }
            return
        }
        if rest.isEmpty {
            t.entries.append(.init(key: head, value: array ? .array([.table(TOMLTable())]) : .table(TOMLTable()), line: line))
        } else {
            var sub = TOMLTable()
            try open(&sub, path: rest, array: array, line: line)
            t.entries.append(.init(key: head, value: .table(sub), line: line))
        }
    }

    private static func insert(_ t: inout TOMLTable, at path: [String], inArray: Bool, key: [String], value: TOMLValue, line: Int) throws {
        if let head = path.first {
            guard let i = t.entries.firstIndex(where: { $0.key == head }) else { return }
            switch t.entries[i].value {
            case var .table(sub):
                try insert(&sub, at: Array(path.dropFirst()), inArray: inArray, key: key, value: value, line: line)
                t.entries[i].value = .table(sub)
            case var .array(items):
                guard case var .table(last) = items.removeLast() else { return }
                try insert(&last, at: Array(path.dropFirst()), inArray: inArray, key: key, value: value, line: line)
                items.append(.table(last))
                t.entries[i].value = .array(items)
            default: return
            }
            return
        }
        guard let k = key.first else { return }
        if key.count > 1 {
            var sub = t[k]?.table ?? TOMLTable()
            if t[k] != nil, t[k]?.table == nil { throw TOMLError(line: line, reason: "\(k) is already set to a value") }
            try insert(&sub, at: [], inArray: false, key: Array(key.dropFirst()), value: value, line: line)
            if let i = t.entries.firstIndex(where: { $0.key == k }) { t.entries[i].value = .table(sub) } else {
                t.entries.append(.init(key: k, value: .table(sub), line: line))
            }
            return
        }
        if let first = t.line(of: k) { throw TOMLError(line: line, reason: "\(k) is already set on line \(first)") }
        t.entries.append(.init(key: k, value: value, line: line))
    }

    private struct LineReader {
        let c: [Character]
        let line: Int
        var i = 0
        init(_ c: [Character], line: Int) { self.c = c; self.line = line }

        var done: Bool { i >= c.count }
        var peek: Character? { done ? nil : c[i] }
        mutating func next() { i += 1 }
        mutating func skipSpace() { while let p = peek, p == " " || p == "\t" { next() } }
        func fail(_ reason: String) -> TOMLError { TOMLError(line: line, reason: reason) }

        mutating func expect(_ ch: Character) throws {
            skipSpace()
            guard peek == ch else { throw fail("expected \(ch)") }
            next()
        }

        mutating func endOfLine() throws {
            skipSpace()
            guard done || peek == "#" else { throw fail("unexpected text after the value") }
        }

        /// `a.b."c d"` up to `stop`.
        mutating func keyPath(until stop: Character) throws -> [String] {
            var parts: [String] = []
            while true {
                skipSpace()
                if peek == "\"" || peek == "'" { parts.append(try quoted()) } else {
                    var bare = ""
                    while let p = peek, p.isLetter || p.isNumber || p == "_" || p == "-" { bare.append(p); next() }
                    guard !bare.isEmpty else { throw fail("expected a key") }
                    parts.append(bare)
                }
                skipSpace()
                if peek == "." { next(); continue }
                guard peek == stop else { throw fail("expected \(stop) after the key") }
                return parts
            }
        }

        mutating func quoted() throws -> String {
            let q = peek
            next()
            var out = ""
            while let p = peek {
                next()
                if p == q { return out }
                guard p == "\\", q == "\"" else { out.append(p); continue }
                guard let e = peek else { break }
                next()
                switch e {
                case "n": out.append("\n")
                case "t": out.append("\t")
                case "\"", "\\": out.append(e)
                case "u":
                    let hex = String(c[i..<min(i + 4, c.count)])
                    guard hex.count == 4, let v = UInt32(hex, radix: 16), let u = Unicode.Scalar(v) else { throw fail("bad \\u escape") }
                    out.unicodeScalars.append(u)
                    i += 4
                default: throw fail("unknown escape \\\(e)")
                }
            }
            throw fail("a string is not closed on its line")
        }

        mutating func value() throws -> TOMLValue {
            guard let p = peek else { throw fail("expected a value") }
            if p == "\"" || p == "'" {
                if c.count >= i + 3, c[i + 1] == p, c[i + 2] == p { throw fail("multi-line strings are not supported") }
                return .string(try quoted())
            }
            if p == "[" {
                next()
                var items: [TOMLValue] = []
                while true {
                    skipSpace()
                    if peek == "]" { next(); return .array(items) }
                    items.append(try value())
                    skipSpace()
                    if peek == "," { next() } else if peek != "]" { throw fail("expected , or ] in the array") }
                }
            }
            if p == "{" {
                next()
                var t = TOMLTable()
                while true {
                    skipSpace()
                    if peek == "}" { next(); return .table(t) }
                    let key = try keyPath(until: "=")
                    try expect("=")
                    skipSpace()
                    let v = try value()
                    try MiniTOML.insert(&t, at: [], inArray: false, key: key, value: v, line: line)
                    skipSpace()
                    if peek == "," { next() } else if peek != "}" { throw fail("expected , or } in the inline table") }
                }
            }
            var word = ""
            while let q = peek, !" \t,]}#".contains(q) { word.append(q); next() }
            if word == "true" { return .bool(true) }
            if word == "false" { return .bool(false) }
            let digits = word.replacingOccurrences(of: "_", with: "")
            if let n = Int(digits) { return .integer(n) }
            if let d = Double(digits), digits.contains(where: { $0 == "." || $0 == "e" || $0 == "E" }) { return .float(d) }
            throw fail(word.isEmpty ? "expected a value" : "\(word) is not a value (strings need quotes)")
        }
    }
}
