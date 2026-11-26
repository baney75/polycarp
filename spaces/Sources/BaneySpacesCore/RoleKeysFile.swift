import Foundation

/// Changing a job's key in config.toml: the lines of `[keys.bindings]` that are its own, and nothing else in the file.
public enum RoleKeysFile {
    public enum Change: Equatable, Sendable {
        case chord(Chord)
        case off
        /// What Polycarp comes with: its default key, or none.
        case standard
    }

    /// `text` with `role`'s key changed. Throws when the file holds it in a way a line can't change.
    public static func edit(_ text: String, role: AppRole, _ change: Change, mod: Set<Chord.Mod>) throws -> String {
        let table = "keys.bindings"
        let eol = text.contains("\r\n") ? "\r\n" : "\n"
        var rows = text.isEmpty ? [] : text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
        let standard = RoleKeys.suggested(role), bound = RoleKeys.boundByDefault.contains(role)
        var picked: Chord?
        if case .chord(let c) = change { picked = c }
        // Its own lines, the one that turned its default key off, and one that gave the chord it gets now to nothing.
        let own = { (line: (key: String, action: String, line: Int)) -> Bool in
            let chord = Chord(line.key, mod: mod)
            return line.action == RoleKeys.action(role, new: false) || (line.action == "none" && chord != nil && [standard, picked].contains(chord))
        }
        let lines = RoleKeys.lines(text), mine = lines.filter(own).map { $0.line - 1 }
        if let picked, let other = lines.first(where: { !own($0) && Chord($0.key, mod: mod) == picked }) {
            throw SurfacesFile.WriteError("line \(other.line) of config.toml gives \(picked.display) to \(other.action)")
        }
        var row: String?
        switch change {
        case .chord(let c) where c == standard && bound: break
        case .chord(let c): row = "\"\(c.text)\" = \"\(RoleKeys.action(role, new: false))\""
        case .off where bound: row = "\"\(standard.text)\" = \"none\""
        case .off, .standard: break
        }
        if let first = mine.first, let row { rows[first] = row }
        for i in (row == nil ? mine : Array(mine.dropFirst())).reversed() { rows.remove(at: i) }
        if mine.isEmpty, let row {
            if let last = DefaultAppsFile.lines(of: table, in: text).last(where: { !$0.1.allSatisfy(\.isWhitespace) }) {
                rows.insert(row, at: last.0)
            } else if let head = rows.lastIndex(where: { DefaultAppsFile.header($0) == table }) {
                rows.insert(row, at: head + 1)
            } else {
                while let l = rows.last, l.allSatisfy(\.isWhitespace) { rows.removeLast() }
                rows += (rows.isEmpty ? [] : [""]) + ["[\(table)]", row, ""]
            }
        }
        let out = rows.joined(separator: eol)
        let want: Chord? = switch change { case .chord(let c): c; case .off: nil; case .standard: bound ? standard : nil }
        let now = RoleKeys.plan(out, mod: mod) { _ in nil }
        guard now.of(role).filter({ $0.taken == nil }).map(\.chord) == [want].compactMap({ $0 }),
              DefaultAppsFile.read(out).apps == DefaultAppsFile.read(text).apps else {
            throw SurfacesFile.WriteError("the key for \(role.rawValue) is written in a way Polycarp can't change; edit the file by hand")
        }
        return out
    }

    public static func set(_ role: AppRole, _ change: Change, modifier: String?, path: String) throws {
        let before = try DefaultAppsFile.text(at: path) ?? ""
        try DefaultAppsFile.write(edit(before, role: role, change, mod: RoleKeys.mod(setting: modifier)), over: before, path: path)
    }
}
