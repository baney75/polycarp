import Foundation

/// A JSON value as `surfaces.json` holds it. Kept as a tree, not decoded into the model directly, so keys this build
/// doesn't know survive a read and a write (a newer build's settings are never lost to an older one's `set`).
public indirect enum SurfaceValue: Equatable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([SurfaceValue]), object([String: SurfaceValue])

    public var bool: Bool? { if case let .bool(b) = self { b } else { nil } }
    public var string: String? { if case let .string(s) = self { s } else { nil } }
    public var array: [SurfaceValue]? { if case let .array(a) = self { a } else { nil } }
    public var object: [String: SurfaceValue]? { if case let .object(o) = self { o } else { nil } }
    /// A whole number, when it is one (30, or 30.0); nil for 30.5 or anything not a number.
    public var integer: Int? {
        guard case let .number(d) = self, d.isFinite, d.rounded() == d, abs(d) < 9_007_199_254_740_992 else { return nil }
        return Int(d)
    }

    /// The JSON type's name, for messages.
    public var kind: String {
        switch self {
        case .null: "null"
        case .bool: "a boolean"
        case .number: "a number"
        case .string: "a string"
        case .array: "a list"
        case .object: "an object"
        }
    }

    // MARK: To and from JSON text

    public enum ParseError: Error, Equatable, Sendable { case notJSON(String) }

    /// Any JSON text, a bare value (`30`, `"glass"`) included.
    public static func parse(_ data: Data) -> Result<SurfaceValue, ParseError> {
        do {
            let any = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
            return .success(SurfaceValue(any: any))
        } catch {
            let reason = (error as NSError).userInfo[NSDebugDescriptionErrorKey] as? String ?? "not valid JSON"
            return .failure(.notJSON(reason))
        }
    }

    init(any: Any) {
        switch any {
        case let n as NSNumber:
            self = CFGetTypeID(n) == CFBooleanGetTypeID() ? .bool(n.boolValue) : .number(n.doubleValue)
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map(SurfaceValue.init(any:)))
        case let o as [String: Any]: self = .object(o.mapValues(SurfaceValue.init(any:)))
        default: self = .null
        }
    }

    var any: Any {
        switch self {
        case .null: NSNull()
        case let .bool(b): b
        case let .number(d): integer.map { $0 as Any } ?? d
        case let .string(s): s
        case let .array(a): a.map(\.any)
        case let .object(o): o.mapValues(\.any)
        }
    }

    /// JSON text with sorted keys: pretty for files and people, compact for one line.
    public func json(pretty: Bool = true) -> String {
        var opts: JSONSerialization.WritingOptions = [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]
        if pretty { opts.insert(.prettyPrinted) }
        guard let d = try? JSONSerialization.data(withJSONObject: any, options: opts) else { return "null" }
        return String(decoding: d, as: UTF8.self)
    }

    // MARK: Paths

    /// The value at `path` ("bar.modules.left"); nil when a step is missing or not an object. An empty path is the value.
    public func at(_ path: [String]) -> SurfaceValue? {
        var v = self
        for key in path {
            guard let next = v.object?[key] else { return nil }
            v = next
        }
        return v
    }

    /// A copy with `value` at `path`, making objects on the way (a step that held something else becomes one).
    public func setting(_ path: [String], to value: SurfaceValue) -> SurfaceValue {
        guard let key = path.first else { return value }
        var o = object ?? [:]
        o[key] = (o[key] ?? .object([:])).setting(Array(path.dropFirst()), to: value)
        return .object(o)
    }

    /// A copy without `path`, and without any object that leaves empty on the way up (the file stays tidy).
    public func removing(_ path: [String]) -> SurfaceValue {
        guard let key = path.first, var o = object, let child = o[key] else { return self }
        if path.count == 1 {
            o[key] = nil
        } else {
            let left = child.removing(Array(path.dropFirst()))
            if left.object?.isEmpty == true { o[key] = nil } else { o[key] = left }
        }
        return .object(o)
    }

    /// `over` on top of this: objects merge key by key, anything else in `over` wins.
    public func merged(with over: SurfaceValue) -> SurfaceValue {
        guard case let .object(base) = self, case let .object(top) = over else { return over }
        var out = base
        for (k, v) in top { out[k] = base[k].map { $0.merged(with: v) } ?? v }
        return .object(out)
    }
}
