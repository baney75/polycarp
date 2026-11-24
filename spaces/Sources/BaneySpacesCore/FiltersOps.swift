import Foundation

/// What `polycarp-spaces filters` and the MCP tools run on filters.json (Filters.swift). Every write is checked whole
/// and goes in at once; a refusal names the field and writes nothing.
public enum FiltersOps {
    static func failure(_ code: String, _ issue: SurfacesIssue, _ suggestion: String) -> SurfacesOps.Result {
        .failure(SurfacesFailure(code, issue.description, suggestion: suggestion, issues: [issue]))
    }

    static let fixFile = "Fix \(Filters.name) by hand, or run `polycarp-spaces filters reset` to start over."

    static func loaded(_ file: String) -> Result<[FilterRule], SurfacesFailure> {
        Filters.load(path: file).mapError { SurfacesFailure("invalid_file", $0.description, suggestion: fixFile, issues: [$0]) }
    }

    /// Writes the rules. A refusal from the check `save` runs (the file would be over 256 KiB) is `too_many`, not
    /// `io_error`, so the suggestion says what to change rather than to try again.
    static func saved(_ rules: [FilterRule], file: String) -> SurfacesFailure? {
        do { try Filters.save(rules, to: file); return nil } catch let issue as SurfacesIssue {
            return SurfacesFailure("too_many", issue.description, suggestion: "Make the rule shorter, or remove a rule with `polycarp-spaces filters rm <id>` first.",
                                   issues: [issue])
        } catch {
            return SurfacesFailure("io_error", "\(error)")
        }
    }

    static func listing(_ rules: [FilterRule], file: String) -> SurfaceValue {
        .object(["file": .string(file), "filters": .array(rules.map(\.value))])
    }

    /// `ls`: every rule, normalized.
    public static func list(file: String) -> SurfacesOps.Result {
        loaded(file).map { listing($0, file: file) }
    }

    /// `set <json rule>`: adds the rule, or replaces the one with its id in place. Nothing is written on a refusal.
    public static func set(_ text: String, file: String) -> SurfacesOps.Result {
        guard text.utf8.count <= Filters.maxBytes, case .success(let v) = SurfaceValue.parse(Data(text.utf8)) else {
            return failure("invalid_filter", SurfacesIssue("$", "the rule is not JSON"), "Give one rule as a JSON object, as {\"id\":\"no-shorts\",\"kinds\":[\"shorts\"]}.")
        }
        let rule: FilterRule
        switch Filters.rule(v) {
        case .failure(let issue): return failure("invalid_filter", issue, "Run `polycarp-spaces filters help` for what each field takes.")
        case .success(let r): rule = r
        }
        var rules: [FilterRule]
        switch loaded(file) {
        case .failure(let f): return .failure(f)
        case .success(let r): rules = r
        }
        let replaced = rules.firstIndex { $0.id == rule.id }
        if let i = replaced { rules[i] = rule } else { rules.append(rule) }
        guard rules.count <= Filters.maxRules else {
            return failure("too_many", SurfacesIssue("filters", "\(Filters.name) holds \(Filters.maxRules) rules already"),
                           "Remove a rule with `polycarp-spaces filters rm <id>` first.")
        }
        if let f = saved(rules, file: file) { return .failure(f) }
        return .success(.object(["filter": rule.value, "replaced": .bool(replaced != nil), "file": .string(file)]))
    }

    /// `rm <id>`: removes one rule.
    public static func remove(_ id: String, file: String) -> SurfacesOps.Result {
        var rules: [FilterRule]
        switch loaded(file) {
        case .failure(let f): return .failure(f)
        case .success(let r): rules = r
        }
        guard let i = rules.firstIndex(where: { $0.id == id }) else {
            return failure("not_found", SurfacesIssue("id", "no rule has the id \"\(id)\""), "Run `polycarp-spaces filters ls` for the ids.")
        }
        rules.remove(at: i)
        if let f = saved(rules, file: file) { return .failure(f) }
        return .success(listing(rules, file: file))
    }

    /// `reset`: no rules. Removes the file, even one that doesn't read.
    public static func reset(file: String) -> SurfacesOps.Result {
        if unlink(file) != 0 && errno != ENOENT {
            return .failure(SurfacesFailure("io_error", "can't remove \(file): \(String(cString: strerror(errno)))"))
        }
        return .success(listing([], file: file))
    }
}
