import Foundation

/// What `polycarp-spaces edits` and the MCP tools run on edits.json (Edits.swift). Every write is checked whole and goes
/// in at once; a refusal names the field and writes nothing.
public enum EditsOps {
    static func failure(_ code: String, _ issue: SurfacesIssue, _ suggestion: String) -> SurfacesOps.Result {
        .failure(SurfacesFailure(code, issue.description, suggestion: suggestion, issues: [issue]))
    }

    static func loaded(_ file: String) -> Result<[SurfaceValue], SurfacesFailure> {
        Edits.load(path: file).mapError {
            SurfacesFailure("invalid_file", $0.description, suggestion: "Fix \(Edits.name) by hand, or run `polycarp-spaces edits reset` to start over.", issues: [$0])
        }
    }

    /// Writes the edits. A refusal from the check `save` runs (too many, or a file over 256 KiB) is `too_many`, so the
    /// suggestion says what to change rather than to try again.
    static func saved(_ edits: [SurfaceValue], file: String) -> SurfacesFailure? {
        do { try Edits.save(edits, to: file); return nil } catch let issue as SurfacesIssue {
            return SurfacesFailure("too_many", issue.description, suggestion: "Make the edit shorter, or remove one with `polycarp-spaces edits rm <id>` first.", issues: [issue])
        } catch {
            return SurfacesFailure("io_error", "\(error)")
        }
    }

    static func listing(_ edits: [SurfaceValue], file: String) -> SurfaceValue {
        .object(["file": .string(file), "edits": .array(edits)])
    }

    /// `ls`: every edit, normalized.
    public static func list(file: String) -> SurfacesOps.Result { loaded(file).map { listing($0, file: file) } }

    /// `set <json edit>`: adds the edit, or replaces the one with its id in place.
    public static func set(_ text: String, file: String) -> SurfacesOps.Result {
        guard text.utf8.count <= Edits.maxBytes, case .success(let v) = SurfaceValue.parse(Data(text.utf8)) else {
            return failure("invalid_edit", SurfacesIssue("$", "the edit is not JSON"), "Give one edit as a JSON object: `polycarp-spaces edits help`.")
        }
        switch Edits.edit(v) {
        case .failure(let issue): return failure("invalid_edit", issue, "Run `polycarp-spaces edits help` for what each field takes.")
        case .success(let edit): return put(edit, file: file)
        }
    }

    private static func put(_ edit: SurfaceValue, file: String) -> SurfacesOps.Result {
        loaded(file).flatMap { list in
            var edits = list
            let i = edits.firstIndex { $0.object?["id"] == edit.object?["id"] }
            if let i { edits[i] = edit } else { edits.append(edit) }
            if let f = saved(edits, file: file) { return .failure(f) }
            return .success(.object(["edit": edit, "replaced": .bool(i != nil), "file": .string(file)]))
        }
    }

    private static func found(_ id: String, file: String, _ use: ([SurfaceValue], Int) -> SurfacesOps.Result) -> SurfacesOps.Result {
        loaded(file).flatMap { edits in
            guard let i = edits.firstIndex(where: { $0.object?["id"] == .string(id) }) else {
                return failure("not_found", SurfacesIssue("id", "no edit has the id \"\(id)\""), "Run `polycarp-spaces edits ls` for the ids.")
            }
            return use(edits, i)
        }
    }

    /// `on <id>` and `off <id>`: keeps the edit and turns it on or off.
    public static func turn(_ id: String, on: Bool, file: String) -> SurfacesOps.Result {
        found(id, file: file) { edits, i in
            var o = edits[i].object ?? [:]
            o["enabled"] = .bool(on)
            return put(.object(o), file: file)
        }
    }

    /// `rm <id>`: removes one edit.
    public static func remove(_ id: String, file: String) -> SurfacesOps.Result {
        found(id, file: file) { edits, i in
            var left = edits
            left.remove(at: i)
            if let f = saved(left, file: file) { return .failure(f) }
            return .success(listing(left, file: file))
        }
    }

    /// `reset`: no edits. Removes the file, even one that doesn't read.
    public static func reset(file: String) -> SurfacesOps.Result {
        if unlink(file) != 0 && errno != ENOENT {
            return .failure(SurfacesFailure("io_error", "can't remove \(file): \(String(cString: strerror(errno)))"))
        }
        return .success(listing([], file: file))
    }
}
