import Darwin
import Foundation

/// Where surfaces.json lives, reading it, and writing it whole.
public enum SurfacesFile {
    public static let name = "surfaces.json"
    public static let maxBytes = 64 * 1024
    /// Test hook: an absolute path used instead of the support folder's file. Never set in real use.
    public static let overrideVariable = "POLYCARP_SURFACES_FILE"

    /// `~/Library/Application Support/Polycarp/surfaces.json`, or `POLYCARP_SURFACES_FILE` when it is an absolute path.
    public static func path(env: [String: String] = ProcessInfo.processInfo.environment,
                            home: URL = FileManager.default.homeDirectoryForCurrentUser) -> String {
        if let o = env[overrideVariable], o.hasPrefix("/") { return o }
        return Product.supportDir(home: home).appendingPathComponent(name).path
    }

    /// A file that read and checked: its own tree (unknown keys and all) and the model.
    public struct Document: Equatable, Sendable {
        public let tree: SurfaceValue
        public let surfaces: Surfaces
        public let warnings: [SurfacesIssue]
    }

    public enum Loaded: Equatable, Sendable {
        /// No file: every default.
        case missing
        case document(Document)
        /// Read and refused: not JSON, or a value that fails its check. `tree` is there when it was JSON.
        case invalid(SurfacesErrors, tree: SurfaceValue?)
        /// Not readable for good (not a regular file, too big, not allowed).
        case rejected(String)
        /// A read that may pass next time.
        case failed(String)
    }

    public static func load(path: String) -> Loaded {
        switch PolycarpThemeFile.bytes(path: path, limit: maxBytes) {
        case .missing: return .missing
        case .rejected(let why): return .rejected(why)
        case .failed(let why): return .failed(why)
        case .data(let data): return parse(data)
        }
    }

    public static func parse(_ data: Data) -> Loaded {
        guard data.count <= maxBytes else { return .rejected("over \(maxBytes) bytes") }
        switch SurfaceValue.parse(data) {
        case .failure(.notJSON(let why)):
            return .invalid(SurfacesErrors([SurfacesIssue("$", "not valid JSON: \(why)")]), tree: nil)
        case .success(let tree):
            switch Surfaces.check(tree) {
            case .success(let c): return .document(Document(tree: tree, surfaces: c.surfaces, warnings: c.warnings))
            case .failure(let e): return .invalid(e, tree: tree)
            }
        }
    }

    /// Writes the whole tree: a temp file beside the target, flushed, then renamed over it, so a reader (the app's
    /// watcher, another agent) sees the old file or the new one and never half of one. Makes the folder if need be.
    /// `limit` is the largest file written (filters.json has its own).
    public static func write(_ tree: SurfaceValue, to path: String, limit: Int = maxBytes) throws {
        let url = URL(fileURLWithPath: path)
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let text = tree.json(pretty: true) + "\n"
        guard text.utf8.count <= limit else { throw WriteError("the file would be over \(limit) bytes") }
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(getpid()).\(UInt32.random(in: 0...UInt32.max)).tmp").path
        let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o644)
        guard fd >= 0 else { throw WriteError("can't write \(dir.path): \(String(cString: strerror(errno)))") }
        var ok = true
        var why = ""
        text.utf8CString.withUnsafeBufferPointer { buf in
            var off = 0
            let total = buf.count - 1  // without the trailing NUL
            while off < total {
                let n = Darwin.write(fd, buf.baseAddress! + off, total - off)
                if n < 0 { if errno == EINTR { continue }; ok = false; why = String(cString: strerror(errno)); return }
                off += n
            }
        }
        if ok && fsync(fd) != 0 { ok = false; why = String(cString: strerror(errno)) }
        close(fd)
        guard ok, rename(tmp, path) == 0 else {
            if ok { why = String(cString: strerror(errno)) }
            unlink(tmp)
            throw WriteError("can't write \(path): \(why)")
        }
    }

    public struct WriteError: Error, CustomStringConvertible {
        public let description: String
        init(_ d: String) { description = d }
    }
}

// MARK: The operations the command and the MCP tools run

/// A refusal, as the command prints it and as `{ok: false, error}` carries it (the shape `polycarp theme` uses).
public struct SurfacesFailure: Error, Equatable, Sendable {
    public let code: String
    public let message: String
    public let suggestion: String?
    public let issues: [SurfacesIssue]
    /// 2 for a command used wrong, 1 for the rest.
    public let exit: Int32

    public init(_ code: String, _ message: String, suggestion: String? = nil, issues: [SurfacesIssue]? = nil, exit: Int32 = 1) {
        self.code = code; self.message = message; self.suggestion = suggestion
        self.issues = issues ?? [SurfacesIssue("$", message)]
        self.exit = exit
    }

    static func usage(_ m: String) -> SurfacesFailure { SurfacesFailure("invalid_args", m, exit: 2) }

    public var envelope: SurfaceValue {
        var error: [String: SurfaceValue] = [
            "code": .string(code), "message": .string(message),
            "data": .object(["errors": .array(issues.map { .object(["path": .string($0.path), "message": .string($0.message)]) })]),
        ]
        error["suggestion"] = .string(suggestion ?? Self.suggestion(for: code))
        // The theme envelope's `retry`: nothing here is busy, so trying the same call again never helps.
        error["retry"] = .string("never")
        return .object(["ok": .bool(false), "error": .object(error)])
    }

    static func suggestion(for code: String) -> String {
        switch code {
        case "invalid_args": "Run `polycarp-spaces surfaces help` for the usage."
        case "io_error": "Check the file and its folder, then try again."
        case "invalid_paper", "not_found":
            "Give a picture (.png, .jpg, .heic or .webp), an https URL to one, a #RRGGBB color, or a scene: field, olive, water, parchment or solid."
        case "not_a_picture": "Use a PNG, JPEG, HEIC or WebP picture that opens in Preview."
        case "too_large": "Use a picture of at most 25 MB, or a smaller copy of it."
        case "fetch_failed": "Check the URL opens a picture in a browser, or save the picture and give its path."
        default: "Run `polycarp-spaces surfaces schema` for every path and what it takes."
        }
    }
}

public enum SurfacesOps {
    public typealias Result = Swift.Result<SurfaceValue, SurfacesFailure>

    public static func ok(_ data: SurfaceValue) -> SurfaceValue { .object(["ok": .bool(true), "data": data]) }

    static func issues(_ list: [SurfacesIssue]) -> SurfaceValue {
        .array(list.map { .object(["path": .string($0.path), "message": .string($0.message)]) })
    }

    /// A path as keys; "" or "$" is the whole file. Refuses a path that names nothing this build knows.
    static func keys(_ path: String?, allowUnknownIn tree: SurfaceValue? = nil) -> Swift.Result<[String], SurfacesFailure> {
        guard let path, !path.isEmpty, path != "$" else { return .success([]) }
        let keys = path.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        if keys.contains(where: \.isEmpty) { return .failure(.usage("\"\(path)\" is not a path: keys joined with dots, like bar.height")) }
        if SurfaceField.isKnown(path) || (tree.flatMap { $0.at(keys) } != nil) { return .success(keys) }
        let near = SurfaceField.nearest(path)
        return .failure(SurfacesFailure("unknown_path", "no field \(path)",
                                        suggestion: near.isEmpty ? "run `surfaces schema` for every path" : "did you mean \(near.joined(separator: " or "))?",
                                        issues: [SurfacesIssue(path, "not a field or group this build knows")]))
    }

    /// The file's own tree to edit: none is an empty one; JSON that fails its checks can still be edited (a `set` must
    /// leave it valid); anything that isn't JSON is refused, so nothing is thrown away by accident.
    static func editable(_ path: String) -> Swift.Result<SurfaceValue, SurfacesFailure> {
        switch SurfacesFile.load(path: path) {
        case .missing: return .success(.object([:]))
        case .document(let d): return .success(d.tree)
        case .invalid(_, tree: let t?) where t.object != nil: return .success(t)
        case .invalid(let e, _):
            return .failure(SurfacesFailure("invalid_file", "\(display(path)) is not a surfaces file: \(e.summary)",
                                            suggestion: "fix it by hand, or run `surfaces reset` to start again from the defaults", issues: e.issues))
        case .rejected(let why), .failed(let why):
            return .failure(SurfacesFailure("io_error", "can't read \(display(path)): \(why)"))
        }
    }

    /// `get [path]`: the value in force (the file over the defaults), and whether the file sets it.
    public static func get(_ path: String?, file: String) -> Result {
        let tree: SurfaceValue
        switch SurfacesFile.load(path: file) {
        case .missing: tree = .object([:])
        case .document(let d): tree = d.tree
        case .invalid(let e, _):
            return .failure(SurfacesFailure("invalid_file", "\(display(file)) is invalid, so the app keeps its last good config: \(e.summary)",
                                            suggestion: "run `surfaces validate` on it, then fix or `surfaces reset` the paths it names", issues: e.issues))
        case .rejected(let why), .failed(let why): return .failure(SurfacesFailure("io_error", "can't read \(display(file)): \(why)"))
        }
        switch keys(path, allowUnknownIn: tree) {
        case .failure(let f): return .failure(f)
        case .success(let k):
            let value = SurfaceField.defaultTree.merged(with: tree).at(k) ?? .null
            return .success(.object(["path": .string(k.isEmpty ? "$" : k.joined(separator: ".")), "value": value,
                                     "set": .bool(!k.isEmpty && tree.at(k) != nil), "file": .string(display(file))]))
        }
    }

    /// `set <path> <value>`: checks the whole file with the change, then writes it at once. Nothing is written on a refusal.
    public static func set(_ path: String, _ value: SurfaceValue, file: String) -> Result {
        guard !path.isEmpty, path != "$" else { return .failure(.usage("set takes a path; `surfaces reset` starts the whole file over")) }
        let k: [String]
        switch keys(path) { case .failure(let f): return .failure(f); case .success(let got): k = got }
        if SurfaceField.byPath[path] == nil, value.object == nil {
            return .failure(SurfacesFailure("invalid_value", "\(path) is a group: its value must be an object of its fields, not \(value.kind)",
                                            issues: [SurfacesIssue(path, "must be an object, not \(value.kind)")]))
        }
        // A value retired with workspace purposes reads from an old file, but is never written again.
        var retired: [SurfacesIssue] = []
        _ = SurfaceCheck.retire(SurfaceValue.object([:]).setting(k, to: value), warnings: &retired)
        if let first = retired.first {
            let why = "\(first.path): \(first.message.components(separatedBy: ";")[0]), so it can't be set"
            return .failure(SurfacesFailure("invalid_value", why, suggestion: "run `surfaces schema` for what \(path) takes", issues: retired))
        }
        var tree: SurfaceValue
        switch editable(file) { case .failure(let f): return .failure(f); case .success(let t): tree = t }
        tree = tree.setting(k, to: value)
        if tree.at(["version"]) == nil { tree = tree.setting(["version"], to: .number(Double(Surfaces.version))) }
        switch Surfaces.check(tree) {
        case .failure(let e):
            let mine = e.issues.filter { $0.path == path || $0.path.hasPrefix(path + ".") || $0.path.hasPrefix(path + "[") }
            let message = mine.isEmpty ? "the file has other errors, so \(path) was not set: \(e.summary)" : "\(mine[0])"
            return .failure(SurfacesFailure("invalid_value", message,
                                            suggestion: mine.isEmpty ? "fix or `surfaces reset` the paths listed, then set again" : "run `surfaces schema` for what \(path) takes",
                                            issues: e.issues))
        case .success(let c):
            do { try SurfacesFile.write(tree, to: file) } catch { return .failure(SurfacesFailure("io_error", "\(error)")) }
            var data: [String: SurfaceValue] = ["path": .string(path), "value": value, "file": .string(display(file))]
            if !c.warnings.isEmpty { data["warnings"] = issues(c.warnings) }
            return .success(.object(data))
        }
    }

    /// `reset [path]`: the path back to its default (it leaves the file), or the whole file when no path is given.
    public static func reset(_ path: String?, file: String) -> Result {
        var tree: SurfaceValue
        let k: [String]
        if path == nil || path == "" || path == "$" {
            tree = .object(["version": .number(Double(Surfaces.version))])
            k = []
        } else {
            switch editable(file) { case .failure(let f): return .failure(f); case .success(let t): tree = t }
            switch keys(path, allowUnknownIn: tree) { case .failure(let f): return .failure(f); case .success(let got): k = got }
            tree = tree.removing(k)
            if tree.at(["version"]) == nil { tree = tree.setting(["version"], to: .number(Double(Surfaces.version))) }
        }
        do { try SurfacesFile.write(tree, to: file) } catch { return .failure(SurfacesFailure("io_error", "\(error)")) }
        let shown = k.isEmpty ? "$" : k.joined(separator: ".")
        if case .failure(let e) = Surfaces.check(tree) {
            return .failure(SurfacesFailure("invalid_file", "reset \(shown), but the file still has errors: \(e.summary)",
                                            suggestion: "reset or fix the paths listed", issues: e.issues))
        }
        return .success(.object(["path": .string(shown), "value": SurfaceField.defaultTree.merged(with: tree).at(k) ?? .null,
                                 "file": .string(display(file))]))
    }

    /// `validate <file>`: every error with its path, or valid with any warnings.
    public static func validate(_ path: String) -> Result {
        switch SurfacesFile.load(path: path) {
        case .missing: return .failure(SurfacesFailure("io_error", "no file at \(display(path))"))
        case .rejected(let why), .failed(let why): return .failure(SurfacesFailure("io_error", "can't read \(display(path)): \(why)"))
        case .invalid(let e, _):
            return .failure(SurfacesFailure("invalid_surfaces", "\(e.issues.count) error\(e.issues.count == 1 ? "" : "s") in \(display(path))",
                                            suggestion: "run `surfaces schema` for what each path takes", issues: e.issues))
        case .document(let d):
            return .success(.object(["file": .string(display(path)), "valid": .bool(true), "warnings": issues(d.warnings)]))
        }
    }

    public static func schema() -> Result { .success(Surfaces.schema) }

    /// A path with the home folder as `~`, for messages and logs.
    public static func display(_ p: String) -> String {
        let home = NSHomeDirectory()
        return p.hasPrefix(home + "/") ? "~" + p.dropFirst(home.count) : p
    }
}
