import Foundation

/// The JSON Schema 2020-12 keywords `spec/agent-api.schema.json` uses, enough to validate results and events against it
/// in tests: local `$ref`, `type`, `const`, `enum`, `required`, `properties`, `items`, `minItems`, `maxItems`, `minimum`,
/// `maximum`, `exclusiveMinimum`, `minLength`, `pattern`, `allOf`, `oneOf`, `not`. Unknown keywords are ignored, as the
/// standard says, so a schema keyword this does not know never fails a document.
struct AgentAPISchema {
    let root: [String: Any]

    static func load() throws -> AgentAPISchema {
        let data = try Data(contentsOf: Repo.root.appendingPathComponent("spec/agent-api.schema.json"))
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CocoaError(.coderReadCorrupt) }
        return AgentAPISchema(root: root)
    }

    var defs: [String: Any] { root["$defs"] as? [String: Any] ?? [:] }

    /// Every problem with `value` against `$defs/<name>`, each with its path. Empty means valid.
    func problems(_ value: Any, against name: String) -> [String] {
        guard let s = defs[name] else { return ["no $defs/\(name) in the schema"] }
        return check(value, s, "$")
    }

    func problems(json: String, against name: String) -> [String] {
        guard let v = try? JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed]) else { return ["not JSON"] }
        return problems(v, against: name)
    }

    private func resolve(_ ref: String) -> Any? {
        guard ref.hasPrefix("#/$defs/") else { return nil }
        return defs[String(ref.dropFirst("#/$defs/".count))]
    }

    static func isBool(_ v: Any) -> Bool { (v as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false }
    static func number(_ v: Any) -> Double? { isBool(v) ? nil : (v as? NSNumber)?.doubleValue }

    static func typeMatches(_ v: Any, _ t: String) -> Bool {
        switch t {
        case "object": return v is [String: Any]
        case "array": return v is [Any]
        case "string": return v is String
        case "boolean": return isBool(v)
        case "null": return v is NSNull
        case "number": return number(v) != nil
        case "integer": return number(v).map { $0 == $0.rounded() } ?? false
        default: return true
        }
    }

    static func equal(_ a: Any, _ b: Any) -> Bool {
        if isBool(a) != isBool(b) { return false }
        return (a as? NSObject)?.isEqual(b) ?? false
    }

    private func check(_ v: Any, _ schema: Any, _ path: String) -> [String] {
        guard let s = schema as? [String: Any] else { return [] }
        var out: [String] = []
        if let ref = s["$ref"] as? String {
            guard let target = resolve(ref) else { return ["\(path): can't resolve \(ref)"] }
            out += check(v, target, path)
        }
        if let t = s["type"] {
            let types = (t as? [String]) ?? [(t as? String) ?? ""]
            if !types.contains(where: { Self.typeMatches(v, $0) }) { return out + ["\(path): not \(types.joined(separator: " or "))"] }
        }
        if let c = s["const"], !Self.equal(v, c) { out.append("\(path): not \(c)") }
        if let e = s["enum"] as? [Any], !e.contains(where: { Self.equal(v, $0) }) { out.append("\(path): \(v) is not one of \(e)") }
        if let n = Self.number(v) {
            if let m = s["minimum"].flatMap(Self.number), n < m { out.append("\(path): \(n) under \(m)") }
            if let m = s["maximum"].flatMap(Self.number), n > m { out.append("\(path): \(n) over \(m)") }
            if let m = s["exclusiveMinimum"].flatMap(Self.number), n <= m { out.append("\(path): \(n) not over \(m)") }
        }
        if let str = v as? String {
            if let m = s["minLength"] as? Int, str.count < m { out.append("\(path): shorter than \(m)") }
            if let p = s["pattern"] as? String, str.range(of: p, options: .regularExpression) == nil { out.append("\(path): doesn't match \(p)") }
        }
        if let o = v as? [String: Any] {
            for k in (s["required"] as? [String]) ?? [] where o[k] == nil { out.append("\(path).\(k): missing") }
            for (k, sub) in (s["properties"] as? [String: Any]) ?? [:] { if let x = o[k] { out += check(x, sub, "\(path).\(k)") } }
        }
        if let a = v as? [Any] {
            if let m = s["minItems"] as? Int, a.count < m { out.append("\(path): fewer than \(m) items") }
            if let m = s["maxItems"] as? Int, a.count > m { out.append("\(path): more than \(m) items") }
            if let items = s["items"] { for (i, x) in a.enumerated() { out += check(x, items, "\(path)[\(i)]") } }
        }
        for sub in (s["allOf"] as? [Any]) ?? [] { out += check(v, sub, path) }
        if let any = s["oneOf"] as? [Any] {
            let passing = any.filter { check(v, $0, path).isEmpty }.count
            if passing != 1 { out.append("\(path): matches \(passing) of oneOf, not exactly 1") }
        }
        if let not = s["not"], check(v, not, path).isEmpty { out.append("\(path): matches what `not` excludes") }
        return out
    }
}
