import Darwin
import Foundation

/// `[defaults]` in config.toml (spec/config.md), the file `[keys]` is in too: one line per role, `terminal =
/// "com.mitchellh.ghostty"`. A missing line is macOS's own answer. Reading keeps every line that is right; writing
/// changes one line and leaves the rest of the file as it was, comments and all.
public enum DefaultAppsFile {
    public static let section = "defaults"
    public static let maxBytes = 256 * 1024

    /// `$XDG_CONFIG_HOME/baneyspaces/config.toml`, or `~/.config/baneyspaces/config.toml`. `BANEYSPACES_CONFIG_DIR`, the
    /// name Windows uses too, names the folder instead.
    public static func path(env: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> String {
        if let d = env["BANEYSPACES_CONFIG_DIR"], d.hasPrefix("/") { return d + "/config.toml" }
        if let x = env["XDG_CONFIG_HOME"], x.hasPrefix("/") { return x + "/baneyspaces/config.toml" }
        return home + "/.config/baneyspaces/config.toml"
    }

    /// What the file chose, and one line per thing in it that isn't right, naming the key.
    public struct Choices: Equatable, Sendable {
        public var apps: [AppRole: DefaultApp] = [:]
        public var warnings: [String] = []
        public init() {}
    }

    // MARK: Reading

    public static func read(_ text: String) -> Choices {
        var out = Choices()
        do {
            switch try MiniTOML.parse(text)[section] {
            case let .table(t)?: for e in t.entries { take(e, &out) }
            case nil: break
            case let .some(v): out.warnings.append("[\(section)] is \(v.shown), not a table")
            }
        } catch let e as TOMLError {
            // One bad line refuses the whole file to the parser. The other choices still apply: read them one by one.
            out = Choices()
            var seen = false
            for (n, line) in lines(in: text) where !line.trimmed.isEmpty && !line.trimmed.hasPrefix("#") {
                let parsed = try? MiniTOML.parse(String(line))
                if let entry = parsed?.entries.first {
                    if let role = AppRole(rawValue: entry.key), out.apps[role] != nil {
                        out.warnings.append("\(section).\(entry.key) (line \(n)) is set twice; the first one counts")
                    } else {
                        take(.init(key: entry.key, value: entry.value, line: n), &out)
                    }
                } else {
                    seen = seen || n == e.line
                    out.warnings.append("\(section).\(name(in: line)) (line \(n)): \(n == e.line ? e.reason : "not readable"); macOS's default is used")
                }
            }
            if !seen, !out.warnings.contains(where: { $0.contains("(line \(e.line))") }) {
                out.warnings.append("config.toml line \(e.line): \(e.reason); the other lines of [\(section)] still apply")
            }
        } catch {}
        return out
    }

    private static func take(_ e: TOMLTable.Entry, _ out: inout Choices) {
        let at = "\(section).\(e.key) (line \(e.line))"
        guard let role = AppRole(rawValue: e.key) else {
            out.warnings.append("\(at): no such role; the roles are \(AppRole.allCases.map(\.rawValue).joined(separator: ", "))")
            return
        }
        guard let app = e.value.string.flatMap({ DefaultApp(id: $0, role: role) }) else {
            let programs = DefaultAppCatalog.commands(role).map(\.id)
            out.warnings.append("\(at): \(e.value.shown) isn't a bundle identifier like com.example.app"
                + (programs.isEmpty ? "" : " or one of \(programs.joined(separator: ", "))") + "; macOS's default is used")
            return
        }
        out.apps[role] = app
    }

    /// The lines of a table, with their numbers in the file.
    static func lines(of table: String = section, in text: String) -> [(Int, Substring)] {
        var inside = false
        var out: [(Int, Substring)] = []
        for (i, line) in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).enumerated() {
            if let h = header(line) { inside = h == table } else if inside { out.append((i + 1, line)) }
        }
        return out
    }

    /// The table a line opens, or nil when it opens none.
    private static func header(_ line: some StringProtocol) -> String? {
        let t = line.trimmed
        guard t.hasPrefix("["), let end = t.firstIndex(of: "]") else { return nil }
        return t[t.index(after: t.startIndex)..<end].trimmed
    }

    /// The key a line sets, as written, for a line that may not be readable.
    private static func name(in line: some StringProtocol) -> String {
        String(line.prefix { $0 != "=" }).trimmed.trimmingCharacters(in: ["\"", "'"])
    }

    // MARK: Writing

    /// `text` with one role's line set, or taken out for nil. Throws when the file sets it in a way a line can't change.
    public static func edit(_ text: String, role: AppRole, to app: DefaultApp?) throws -> String {
        let eol = text.contains("\r\n") ? "\r\n" : "\n"
        var rows = text.isEmpty ? [] : text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
        let inside = lines(in: text)
        let mine = inside.filter { name(in: $0.1) == role.rawValue }.map { $0.0 - 1 }
        if let app {
            let row = "\(role.rawValue) = \"\(app.id)\""
            if let first = mine.first {
                rows[first] = row + comment(in: rows[first])
                for i in mine.dropFirst().reversed() { rows.remove(at: i) }
            } else if let last = inside.last(where: { !$0.1.trimmed.isEmpty }) {
                rows.insert(row, at: last.0)
            } else if let head = rows.lastIndex(where: { header($0) == section }) {
                rows.insert(row, at: head + 1)
            } else {
                while let l = rows.last, l.trimmed.isEmpty { rows.removeLast() }
                rows += (rows.isEmpty ? [] : [""]) + ["[\(section)]", row, ""]
            }
        } else {
            for i in mine.reversed() { rows.remove(at: i) }
        }
        let out = rows.joined(separator: eol)
        var want = read(text).apps
        want[role] = app
        guard read(out).apps == want else {
            throw SurfacesFile.WriteError("\(section).\(role.rawValue) is written in a way Polycarp can't change; edit the file by hand")
        }
        return out
    }

    /// The comment after a value, so a change keeps it. Only a quoted value's: a bare one has no sure end.
    private static func comment(in row: String) -> String {
        guard let eq = row.firstIndex(of: "=") else { return "" }
        let v = row[row.index(after: eq)...].drop { $0 == " " || $0 == "\t" }
        guard let q = v.first, q == "\"" || q == "'", let end = v.dropFirst().firstIndex(of: q) else { return "" }
        let rest = v[v.index(after: end)...].trimmed
        return rest.hasPrefix("#") ? "  " + rest : ""
    }

    // MARK: The disk

    /// The file's text: nil for no file. Throws when it is there and can't be read.
    public static func text(at path: String) throws -> String? {
        // A config folder is often a link into a repository of its own.
        switch PolycarpThemeFile.bytes(path: resolved(path), limit: maxBytes) {
        case .missing: return nil
        case let .rejected(why), let .failed(why): throw SurfacesFile.WriteError(why)
        case let .data(d):
            guard let s = String(data: d, encoding: .utf8) else { throw SurfacesFile.WriteError("not UTF-8 text") }
            return s
        }
    }

    public static func load(path: String) throws -> Choices { read(try text(at: path) ?? "") }

    /// Sets or resets one role in the file, whole or not at all, through a link to it when it is one.
    public static func set(_ role: AppRole, to app: DefaultApp?, path: String) throws {
        let before = try text(at: path)
        if before == nil, app == nil { return }
        let after = try edit(before ?? "", role: role, to: app)
        if after == before { return }
        let target = resolved(path)
        var st = stat()
        let mode = stat(target, &st) == 0 ? st.st_mode & 0o777 : 0o644
        try SurfacesFile.write(text: after, to: target, limit: maxBytes, mode: mode)
    }

    static func resolved(_ path: String) -> String { URL(fileURLWithPath: path).resolvingSymlinksInPath().path }
}

private extension StringProtocol {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
