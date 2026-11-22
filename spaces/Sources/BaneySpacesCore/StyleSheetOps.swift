#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif
import Foundation

// What `polycarp-spaces style` and the `style_*` MCP tools run (docs/style.md). The command only parses its arguments
// and prints; everything it does is here, so it is tested here. `--json` prints `{ok, data}` or `{ok: false, error}`,
// the envelope `polycarp theme` and `surfaces` use.

/// A refusal, as the command prints it and as `{ok: false, error}` carries it.
public struct StyleFailure: Error, Equatable, Sendable {
    public let code: String
    public let message: String
    public let suggestion: String?
    public let problems: [StyleProblem]
    /// 2 for a command used wrong, 1 for the rest.
    public let exit: Int32

    public init(_ code: String, _ message: String, suggestion: String? = nil, problems: [StyleProblem] = [], exit: Int32 = 1) {
        self.code = code; self.message = message; self.suggestion = suggestion; self.problems = problems; self.exit = exit
    }

    static func usage(_ m: String) -> StyleFailure { StyleFailure("invalid_args", m, exit: 2) }

    public var envelope: SurfaceValue {
        let errors: SurfaceValue = problems.isEmpty ? .array([.object(["message": .string(message)])]) : StyleOps.problemsValue(problems)
        return .object(["ok": .bool(false), "error": .object([
            "code": .string(code), "message": .string(message),
            "suggestion": .string(suggestion ?? "Run `polycarp-spaces style example` for every selector and property."),
            // Nothing here is busy, so trying the same call again never helps.
            "retry": .string("never"),
            "data": .object(["errors": errors]),
        ])])
    }
}

public enum StyleOps {
    public typealias Result = Swift.Result<SurfaceValue, StyleFailure>
    /// The theme's roles for dark (true) or light mode, for the contrast check.
    public typealias Roles = (Bool) -> [String: StyleColor]

    public static func ok(_ data: SurfaceValue) -> SurfaceValue { .object(["ok": .bool(true), "data": data]) }

    static func problemsValue(_ list: [StyleProblem]) -> SurfaceValue {
        .array(list.map { .object(["line": .number(Double($0.line)), "column": .number(Double($0.column)),
                                   "severity": .string($0.severity.rawValue), "message": .string($0.message)]) })
    }

    static let noFolder = StyleFailure("io_error", "no config folder: POLYCARP_CONFIG_DIR is set but not an absolute path",
                                       suggestion: "Set POLYCARP_CONFIG_DIR to an absolute path, or unset it.")

    /// The file's text; "" when there is none.
    static func read(_ file: String) -> Swift.Result<(text: String, exists: Bool), StyleFailure> {
        switch StyleSheetFile.load(path: file) {
        case .missing: return .success(("", false))
        case .text(let t): return .success((t, true))
        case .rejected(let why), .failed(let why):
            return .failure(StyleFailure("io_error", "can't read \(StyleSheetFile.display(file)): \(why)",
                                         suggestion: "Fix the file by hand, or run `polycarp-spaces style reset` to move it aside."))
        }
    }

    /// Every problem `check` reports: the parse's and the contrast warnings, in file order.
    public static func problems(_ text: String, roles: Roles) -> (sheet: StyleSheet, problems: [StyleProblem]) {
        let (sheet, parsed) = StyleSheet.parse(text)
        let all = (parsed + sheet.contrastWarnings(roles: roles)).sorted { ($0.line, $0.column) < ($1.line, $1.column) }
        return (sheet, all)
    }

    // MARK: Commands

    public static func path(file: String?) -> Result {
        guard let file else { return .failure(noFolder) }
        return .success(.object(["file": .string(StyleSheetFile.display(file)), "exists": .bool(StyleSheetFile.load(path: file) != .missing)]))
    }

    /// `show`: the file as it is, and the rules as they parsed.
    public static func show(file: String?) -> Result {
        guard let file else { return .failure(noFolder) }
        switch read(file) {
        case .failure(let f): return .failure(f)
        case .success(let (text, exists)):
            let syntax = StyleSyntax(text)
            let rules: [SurfaceValue] = syntax.rules.compactMap { r -> SurfaceValue? in
                guard let sel = r.selectors else { return nil }
                var o: [String: SurfaceValue] = [
                    "selector": .string(sel.map(\.description).joined(separator: ", ")), "line": .number(Double(r.line)),
                    "declarations": .array(r.declarations.map { d in
                        .object(["property": .string(d.name), "value": .string(StyleEdit.string(syntax.scalars[d.valueStart..<d.valueEnd])), "line": .number(Double(d.line))])
                    }),
                ]
                if let m = r.media { o["media"] = .string(m.rawValue) }
                return .object(o)
            }
            return .success(.object(["file": .string(StyleSheetFile.display(file)), "exists": .bool(exists), "text": .string(text), "rules": .array(rules)]))
        }
    }

    /// `check [file]`: every problem with its line and column. Any error is a refusal (exit 1); warnings alone pass.
    public static func check(file: String?, roles: Roles) -> Result {
        guard let file else { return .failure(noFolder) }
        guard StyleSheetFile.load(path: file) != .missing else {
            return .failure(StyleFailure("io_error", "no style sheet at \(StyleSheetFile.display(file))",
                                         suggestion: "Run `polycarp-spaces style example` for a starter, then `style set` to make one."))
        }
        switch read(file) {
        case .failure(let f): return .failure(f)
        case .success(let (text, _)):
            let (sheet, all) = problems(text, roles: roles)
            let errors = all.filter(\.isError).count
            if errors > 0 {
                return .failure(StyleFailure("invalid_style", "\(errors) error\(errors == 1 ? "" : "s") in \(StyleSheetFile.display(file))",
                                             suggestion: "Fix each line listed (the rest of the sheet applies meanwhile); `polycarp-spaces style example` shows what each property takes.",
                                             problems: all))
            }
            return .success(.object(["file": .string(StyleSheetFile.display(file)), "valid": .bool(true), "rules": .number(Double(sheet.ruleCount)),
                                     "warnings": problemsValue(all)]))
        }
    }

    public static func example() -> Result { .success(.object(["text": .string(StyleSheet.example)])) }

    static func media(_ m: String?) -> Swift.Result<StyleMedia?, StyleFailure> {
        guard let m else { return .success(nil) }
        guard let x = StyleMedia(rawValue: m.lowercased()) else { return .failure(.usage("--media takes dark or light, not \(m)")) }
        return .success(x)
    }

    static func selector(_ s: String) -> Swift.Result<StyleSelector, StyleFailure> {
        switch StyleSyntax.selector(s) {
        case .success(let sel): return .success(sel)
        case .failure(let e):
            return .failure(StyleFailure("invalid_selector", e.message, suggestion: "Run `polycarp-spaces style example` for every selector."))
        }
    }

    /// `set <selector> <property> <value>`: edits that declaration in place (or adds it, or the rule), keeping comments
    /// and order, checks the whole sheet with the change, and writes it at once. A change that adds an error writes nothing.
    public static func set(_ selectorText: String, _ property: String, _ value: String, media mediaText: String? = nil, file: String?,
                           roles: Roles) -> Result {
        guard let file else { return .failure(noFolder) }
        let sel: StyleSelector
        switch selector(selectorText) { case .failure(let f): return .failure(f); case .success(let s): sel = s }
        let media: StyleMedia?
        switch Self.media(mediaText) { case .failure(let f): return .failure(f); case .success(let m): media = m }
        let isCustom = property.hasPrefix("--") && property.count > 2
        let name = isCustom ? property : property.lowercased()
        guard isCustom || StyleProperty.byName[name] != nil else {
            let near = StyleSheetBuilder.nearest(name)
            return .failure(StyleFailure("unknown_property", "unknown property `\(property)`",
                                         suggestion: near.map { "Did you mean `\($0)`?" } ?? "Run `polycarp-spaces style example` for every property."))
        }
        guard StyleSyntax.valueTokens("x " + name) != nil, !name.contains(":") else { return .failure(.usage("`\(property)` isn't a property name")) }
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, StyleSyntax.valueTokens(trimmed) != nil else {
            return .failure(StyleFailure("invalid_value", "`\(value)` can't be a value: it must be one line with no `;`, `{`, `}` or comment, and quotes closed"))
        }
        let old: String
        switch read(file) { case .failure(let f): return .failure(f); case .success(let r): old = r.text }
        let new = StyleEdit.set(old, selector: sel, property: name, value: trimmed, media: media)
        let before = problems(old, roles: roles).problems, after = problems(new, roles: roles).problems
        let added = StyleEdit.added(before.filter(\.isError), after.filter(\.isError))
        if let first = added.first {
            return .failure(StyleFailure("invalid_value", "\(sel) { \(name): \(trimmed) } was not set: \(first.message)",
                                         suggestion: "Run `polycarp-spaces style example` for what `\(name)` takes and where it applies.", problems: added))
        }
        do { try StyleSheetFile.write(new, to: file) } catch { return .failure(StyleFailure("io_error", "\(error)")) }
        var data: [String: SurfaceValue] = ["file": .string(StyleSheetFile.display(file)), "selector": .string(sel.description),
                                            "property": .string(name), "value": .string(trimmed),
                                            "warnings": problemsValue(after.filter { !$0.isError })]
        if let media { data["media"] = .string(media.rawValue) }
        if after.contains(where: \.isError) { data["errors_already_there"] = problemsValue(after.filter(\.isError)) }
        return .success(.object(data))
    }

    /// `unset <selector> [property]`: removes that declaration, or the whole rule, wherever the selector stands alone.
    public static func unset(_ selectorText: String, _ property: String?, media mediaText: String? = nil, file: String?) -> Result {
        guard let file else { return .failure(noFolder) }
        let sel: StyleSelector
        switch selector(selectorText) { case .failure(let f): return .failure(f); case .success(let s): sel = s }
        let media: StyleMedia?
        switch Self.media(mediaText) { case .failure(let f): return .failure(f); case .success(let m): media = m }
        let old: String
        let exists: Bool
        switch read(file) { case .failure(let f): return .failure(f); case .success(let r): old = r.text; exists = r.exists }
        let name = property.map { $0.hasPrefix("--") ? $0 : $0.lowercased() }
        let (new, removed) = StyleEdit.unset(old, selector: sel, property: name, media: media)
        if removed > 0, exists {
            do { try StyleSheetFile.write(new, to: file) } catch { return .failure(StyleFailure("io_error", "\(error)")) }
        }
        var data: [String: SurfaceValue] = ["file": .string(StyleSheetFile.display(file)), "selector": .string(sel.description),
                                            "removed": .number(Double(removed))]
        if let name { data["property"] = .string(name) }
        if let media { data["media"] = .string(media.rawValue) }
        return .success(.object(data))
    }

    /// `preset` with no name: the presets there are. With one: writes it as the whole sheet, after moving the sheet
    /// there was aside as `reset` does, so `restore` puts it back. The preset already in force is left as it is.
    public static func preset(_ name: String?, file: String?, roles: Roles) -> Result {
        guard let name else {
            return .success(.object(["presets": .array(StyleSheet.presets.map { .object(["name": .string($0.name), "about": .string($0.about)]) })]))
        }
        guard let preset = StyleSheet.presets.first(where: { $0.name == name.lowercased() }) else {
            return .failure(StyleFailure("invalid_args", "no preset `\(name)`; the presets are \(StyleSheet.presets.map { "`\($0.name)`" }.joined(separator: ", "))",
                                         suggestion: "Run `polycarp-spaces style preset` for the list.", exit: 2))
        }
        guard let file else { return .failure(noFolder) }
        var data: [String: SurfaceValue] = ["file": .string(StyleSheetFile.display(file)), "preset": .string(preset.name), "backup": .null]
        if StyleSheetFile.load(path: file) == .text(preset.text) {
            data["unchanged"] = .bool(true)
        } else {
            let wasThere = present(file)
            switch moveAside(file) {
            case .failure(let f): return .failure(f)
            case .success(let backup): data["backup"] = backup.map { .string(StyleSheetFile.display($0)) } ?? .null
            }
            // Nothing was there: keep an empty sheet as the backup, so `restore` brings back no rules (the theme's own
            // look) and never an older backup that a `reset` had put away (review of #609).
            if !wasThere {
                let slot = nextBackup(file)
                do { try StyleSheetFile.write(Self.noSheet, to: slot) } catch { return .failure(StyleFailure("io_error", "\(error)")) }
                data["backup"] = .string(StyleSheetFile.display(slot))
            }
            do { try StyleSheetFile.write(preset.text, to: file) } catch { return .failure(StyleFailure("io_error", "\(error)")) }
        }
        let found = problems(preset.text, roles: roles)
        data["rules"] = .number(Double(found.sheet.ruleCount))
        data["warnings"] = problemsValue(found.problems.filter { !$0.isError })
        return .success(.object(data))
    }

    /// What `preset` keeps as the backup when there was no sheet: no rules, so restoring it is the theme's own look.
    static let noSheet = "/* No style sheet was here before `style preset`; with no rules the theme alone styles. */\n"

    /// `reset`: moves the sheet aside so every surface draws as before. It goes to a new backup and never over one
    /// (see `moveAside`); an unedited preset is only removed, since `preset` writes it again.
    public static func reset(file: String?) -> Result {
        guard let file else { return .failure(noFolder) }
        var data: [String: SurfaceValue] = ["file": .string(StyleSheetFile.display(file)), "backup": .null]
        if case .text(let t) = StyleSheetFile.load(path: file), let p = StyleSheet.presets.first(where: { $0.text == t }) {
            data["preset"] = .string(p.name)
        }
        switch moveAside(file) {
        case .failure(let f): return .failure(f)
        case .success(let backup): data["backup"] = backup.map { .string(StyleSheetFile.display($0)) } ?? .null
        }
        data["restorable"] = backups(file).last.map { .string(StyleSheetFile.display($0)) } ?? .null
        return .success(.object(data))
    }

    /// `restore`: puts the newest backup back as the sheet. The sheet there was becomes the newest backup, so a second
    /// `restore` undoes the first.
    public static func restore(file: String?) -> Result {
        guard let file else { return .failure(noFolder) }
        guard let newest = backups(file).last else {
            return .failure(StyleFailure("no_backup", "no backup of \(StyleSheetFile.display(file)) to restore",
                                         suggestion: "`style preset` and `style reset` keep the sheet they replace as style.css.bak; there is none yet."))
        }
        var data: [String: SurfaceValue] = ["file": .string(StyleSheetFile.display(file)), "restored": .string(StyleSheetFile.display(newest)), "backup": .null]
        var saved: String?
        if present(file) {
            if case .text(let now) = StyleSheetFile.load(path: file), StyleSheetFile.load(path: newest) == .text(now) {
                data["unchanged"] = .bool(true)
                return .success(.object(data))
            }
            let slot = nextBackup(file)
            if let f = move(file, to: slot) { return .failure(f) }
            saved = slot
            data["backup"] = .string(StyleSheetFile.display(slot))
        }
        if let f = move(newest, to: file) {
            if let saved { _ = rename(saved, file) }
            return .failure(f)
        }
        return .success(.object(data))
    }

    // MARK: Backups

    /// Is anything at `file`: a sheet, or something there that isn't one (a folder, a file it can't read).
    static func present(_ file: String) -> Bool { StyleSheetFile.load(path: file) != .missing || PolycarpThemeFile.stamp(file) != nil }

    /// The backups beside the sheet, oldest first: `style.css.bak`, then `style.css.bak.1`, `.bak.2` and on. A new one
    /// always takes the next number, so none is ever written over.
    public static func backups(_ file: String) -> [String] { numberedBackups(file).map(\.path) }

    static func numberedBackups(_ file: String) -> [(n: Int, path: String)] {
        let dir = (file as NSString).deletingLastPathComponent
        let base = (file as NSString).lastPathComponent + ".bak"
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.isEmpty ? "." : dir)) ?? []
        let found: [(n: Int, path: String)] = names.compactMap { name in
            if name == base { return (0, file + ".bak") }
            guard name.hasPrefix(base + "."), let n = Int(name.dropFirst(base.count + 1)), n > 0, name == "\(base).\(n)" else { return nil }
            return (n, "\(file).bak.\(n)")
        }
        return found.sorted { $0.n < $1.n }
    }

    /// Where the next backup goes: one number past the newest.
    static func nextBackup(_ file: String) -> String {
        guard let last = numberedBackups(file).last else { return file + ".bak" }
        return "\(file).bak.\(last.n + 1)"
    }

    /// Renames, refusing to replace anything at `to`.
    static func move(_ from: String, to: String) -> StyleFailure? {
        var st = stat()
        if lstat(to, &st) == 0 { return StyleFailure("io_error", "\(StyleSheetFile.display(to)) is already there; nothing was moved") }
        guard rename(from, to) == 0 else {
            return StyleFailure("io_error", "can't move \(StyleSheetFile.display(from)) to \(StyleSheetFile.display(to)): \(String(cString: strerror(errno)))")
        }
        return nil
    }

    /// Takes the sheet out of force without losing it: to the next backup, never over one. Text the newest backup
    /// already holds, or an unedited preset, is only removed. Returns where the text is kept: nil for a preset or
    /// when nothing was there.
    static func moveAside(_ file: String) -> Swift.Result<String?, StyleFailure> {
        guard present(file) else { return .success(nil) }
        if case .text(let t) = StyleSheetFile.load(path: file) {
            let isPreset = StyleSheet.presets.contains { $0.text == t }
            let kept = backups(file).last.flatMap { StyleSheetFile.load(path: $0) == .text(t) ? $0 : nil }
            if isPreset || kept != nil {
                guard unlink(file) == 0 else {
                    return .failure(StyleFailure("io_error", "can't remove \(StyleSheetFile.display(file)): \(String(cString: strerror(errno)))"))
                }
                return .success(isPreset ? nil : kept)
            }
        }
        let slot = nextBackup(file)
        if let f = move(file, to: slot) { return .failure(f) }
        return .success(slot)
    }
}

// MARK: Editing in place

enum StyleEdit {
    /// Errors in `after` that `before` doesn't have, by message (places move when text is added).
    static func added(_ before: [StyleProblem], _ after: [StyleProblem]) -> [StyleProblem] {
        var left: [String: Int] = [:]
        for p in before { left[p.message, default: 0] += 1 }
        var out: [StyleProblem] = []
        for p in after {
            if let n = left[p.message], n > 0 { left[p.message] = n - 1 } else { out.append(p) }
        }
        return out
    }

    static func matches(_ d: StyleRawDeclaration, _ property: String) -> Bool {
        property.hasPrefix("--") ? d.name == property : d.name.lowercased() == property
    }

    /// The rules `set` and `unset` touch: the selector alone (not in a list), at the top level or in that mode's `@media`.
    static func rules(_ syntax: StyleSyntax, _ selector: StyleSelector, _ media: StyleMedia?) -> [StyleRawRule] {
        syntax.rules.filter { r in r.selectors == [selector] && r.media == media }
    }

    static func string(_ s: ArraySlice<Unicode.Scalar>) -> String {
        var v = String.UnicodeScalarView()
        v.append(contentsOf: s)
        return String(v)
    }

    static func set(_ text: String, selector: StyleSelector, property: String, value: String, media: StyleMedia?) -> String {
        let syntax = StyleSyntax(text)
        var s = syntax.scalars
        let decl = "\(property): \(value);"
        func replace(_ a: Int, _ b: Int, with t: String) { s.replaceSubrange(a..<b, with: Array(t.unicodeScalars)) }
        func lineIndent(_ at: Int) -> String {
            var a = at
            while a > 0, s[a - 1] != "\n" { a -= 1 }
            var e = a
            while e < s.count, s[e] == " " || s[e] == "\t" { e += 1 }
            return string(s[a..<e])
        }
        if let rule = rules(syntax, selector, media).last {
            if let d = rule.declarations.last(where: { matches($0, property) }) {
                let lead = d.valueStart == d.valueEnd && d.valueStart > 0 && s[d.valueStart - 1] == ":" ? " " : ""
                replace(d.valueStart, d.valueEnd, with: lead + value)
                return string(s[...])
            }
            let close = rule.close ?? s.count
            let inline = !s[rule.open..<close].contains("\n")
            if let last = rule.declarations.last {
                let semi = last.hasSemicolon ? "" : ";"
                // On its own line, after whatever else is on the last one's line (a trailing comment stays with it).
                var eol = last.end
                while eol < close, s[eol] != "\n" { eol += 1 }
                if inline || eol >= close || s[last.end..<eol].contains("}") {
                    replace(last.end, last.end, with: inline ? "\(semi) \(decl)" : "\(semi)\n\(lineIndent(last.start))\(decl)")
                } else {
                    replace(eol, eol, with: "\n\(lineIndent(last.start))\(decl)")
                    if !semi.isEmpty { replace(last.end, last.end, with: semi) }
                }
            } else if inline {
                let after = rule.open + 1 < s.count && s[rule.open + 1] == " " ? "" : " "
                replace(rule.open + 1, rule.open + 1, with: " \(decl)" + (close == rule.open + 1 ? " " : after))
            } else {
                replace(rule.open + 1, rule.open + 1, with: "\n\(lineIndent(rule.start))  \(decl)")
            }
            if rule.close == nil { s += Array("\n}\n".unicodeScalars) }
            return string(s[...])
        }
        var tail = ""
        if s.isEmpty {
            tail = "/* Polycarp style sheet. `polycarp-spaces style example` lists every selector and property. */\n"
        } else if s.last != "\n" {
            tail = "\n"
        }
        if let media {
            let block = "  \(selector) {\n    \(decl)\n  }\n"
            if let m = syntax.medias.last(where: { $0.media == media && $0.close != nil }) {
                let at = m.close!
                let pre = at > 0 && s[at - 1] != "\n" ? "\n" : ""
                replace(at, at, with: pre + block)
                return string(s[...])
            }
            tail += (s.isEmpty ? "" : "\n") + "@media (prefers-color-scheme: \(media.rawValue)) {\n\(block)}\n"
        } else {
            tail += (s.isEmpty ? "" : "\n") + "\(selector) {\n  \(decl)\n}\n"
        }
        return string(s[...]) + tail
    }

    /// The range to cut for `a..<b`: its whole line when nothing else is on it, else it and the spaces after it.
    static func cut(_ s: [Unicode.Scalar], _ a: Int, _ b: Int) -> Range<Int> {
        var x = a
        while x > 0, s[x - 1] == " " || s[x - 1] == "\t" { x -= 1 }
        var y = b
        while y < s.count, s[y] == " " || s[y] == "\t" { y += 1 }
        let startsLine = x == 0 || s[x - 1] == "\n"
        let endsLine = y == s.count || s[y] == "\n"
        if startsLine && endsLine { return x..<min(s.count, y + 1) }
        return a..<y
    }

    /// A whole rule's cut, with the blank line `set` put before it when it added the rule.
    static func cutBlock(_ s: [Unicode.Scalar], _ a: Int, _ b: Int) -> Range<Int> {
        let r = cut(s, a, b)
        let x = r.lowerBound
        if x >= 2, s[x - 1] == "\n", s[x - 2] == "\n", r.upperBound > b || r.upperBound == s.count { return (x - 1)..<r.upperBound }
        return r
    }

    static func unset(_ text: String, selector: StyleSelector, property: String?, media: StyleMedia?) -> (String, Int) {
        let syntax = StyleSyntax(text)
        var s = syntax.scalars
        var cuts: [Range<Int>] = []
        var removed = 0
        for rule in rules(syntax, selector, media) {
            let ruleEnd = rule.close.map { $0 + 1 } ?? s.count
            guard let property else {
                cuts.append(cutBlock(s, rule.start, ruleEnd)); removed += 1
                continue
            }
            let hits = rule.declarations.filter { matches($0, property) }
            if hits.isEmpty { continue }
            removed += hits.count
            // A rule left with nothing but space in it goes too.
            let inside = (rule.open + 1)..<(rule.close ?? s.count)
            let mine = hits.map { cut(s, $0.start, $0.end) }
            let rest = inside.filter { i in !mine.contains { $0.contains(i) } }
            if rest.allSatisfy({ s[$0].properties.isWhitespace }) {
                cuts.append(cutBlock(s, rule.start, ruleEnd))
            } else {
                cuts += mine
            }
        }
        for c in cuts.sorted(by: { $0.lowerBound > $1.lowerBound }) { s.removeSubrange(c.clamped(to: 0..<s.count)) }
        var out = string(s[...])
        // An `@media` block the change left empty goes too.
        if removed > 0, let media {
            let again = StyleSyntax(out)
            var t = again.scalars
            for m in again.medias.reversed() where m.media == media {
                guard let close = m.close, t[(m.open + 1)..<close].allSatisfy({ $0.properties.isWhitespace }) else { continue }
                t.removeSubrange(cutBlock(t, m.start, close + 1))
            }
            out = string(t[...])
        }
        return (out, removed)
    }
}

// MARK: The starter sheet and the docs tables, from the property table

extension StyleSheet {
    /// A whole sheet `polycarp-spaces style preset <name>` writes in one command.
    public struct Preset: Sendable {
        public let name: String
        public let about: String
        public let text: String
    }

    public static let presets = [omarchy]

    /// Omarchy's Waybar: a solid dark strip whatever the mode, one monospace face, numbered workspaces with an accent
    /// line under the one you're on, and a quiet grayscale right side.
    public static let omarchy = Preset(name: "omarchy", about: "a solid dark strip, monospace, numbered workspaces with an accent line, a quiet right side", text: """
    /* Omarchy: the top bar as Omarchy's Waybar draws it. A solid dark strip in both modes, one monospace face,
       the workspace numbers muted with an accent line under the one you're on, and a quiet grayscale right side.
       Written by `polycarp-spaces style preset omarchy`; `style restore` puts back the sheet that was here, and
       `style reset` the theme's own look. */

    :root {
      --strip: #1a1b26;
      --ink: #a9b1d6;
      --bright: #c0caf5;
      --quiet: #787c99;
      --alarm: #f7768e;
    }

    bar {
      background: var(--strip);
      border-bottom: none;
      color: var(--ink);
      font-family: "JetBrainsMono Nerd Font", "JetBrains Mono", monospace;
      font-size: 12px;
      font-weight: 400;
      height: 26px;
      padding: 0 10px;
      gap: 16px;
    }

    bar .workspaces { gap: 2px; }
    bar .workspace { color: var(--quiet); padding: 0 6px 3px; transition-duration: 120ms; }
    bar .workspace:hover { color: var(--ink); }
    bar .workspace.current { color: var(--bright); border-bottom: 2px solid var(--accent); }

    bar .center { color: var(--ink); }
    bar .clock { color: var(--bright); font-variant-numeric: tabular-nums; }

    bar .right { color: var(--quiet); gap: 14px; }
    bar .status { gap: 12px; }
    bar .network { color: var(--alarm); }

    """)

    /// What `polycarp-spaces style example` prints: every surface, part and property, each with what it does and takes,
    /// all commented out, so it reads as documentation and applies nothing until a line is uncommented.
    public static var example: String {
        var out = """
        /* Polycarp style sheet: <config>/style.css (the folder `polycarp theme current` prints).
           It restyles the top bar and the Workspace Dock on top of the theme: the theme sets colors, shape, type and
           motion everywhere; a rule here sets them for one surface or part, and anything left out is drawn as before.
           Edits apply live. Change it with `polycarp-spaces style set '<selector>' <property> <value>`, then run
           `polycarp-spaces style check`. A bad line is dropped and listed with its line and column; the rest applies.

           Grammar: a strict subset of CSS. Comments, `selector, selector { property: value; }`, `:root` custom
           properties used as var(--name) or var(--name, fallback), and `@media (prefers-color-scheme: dark)` (or light).
           Lengths are px or pt (both mean points). Colors: #rgb #rgba #rrggbb #rrggbbaa, rgb(), rgba(), hsl(), hsla(),
           transparent, currentColor, the 16 basic named colors, or var(--role).
           Specificity: each part, .class and :hover counts one; on a tie the later rule wins.
           color, font-*, letter-spacing and text-transform pass from a surface and region down to its parts.
        */

        :root {
          /* The theme's roles, as var(--name), in the mode in force: \(StyleProperty.roles.map { "--" + $0 }.joined(separator: " ")) */
          /* A custom property of your own, used as color: var(--gold); */
          /* --gold: rgb(212, 175, 55); */
        }

        """
        for target in StyleTarget.allCases {
            let props = StyleProperty.all.filter { $0.applies(to: target) }
            out += "\n/* \(target.rawValue): \(target.help)"
            if target.selectors.count > 1 { out += "\n   Selectors: " + target.selectors.joined(separator: ", ") + "." }
            if !target.states.isEmpty { out += "\n   States: " + target.states.map(\.selector).joined(separator: " ") + "." }
            out += " */\n\(target.selectors[target == .barModule ? target.selectors.firstIndex(of: "bar .clock")! : 0]) {\n"
            for p in props {
                out += "  /* \(p.name): \(p.example); */\n"
                out += "  /*   \(p.help) Takes \(p.takes).\(p.inherited ? " Inherited." : "") */\n"
            }
            out += "}\n"
            for state in target.states {
                let sel = StyleSelector(surface: target.surface, part: target == .barModule ? "clock" : target.parts[0], states: [state])
                let hint = props.contains { $0.name == "background" } ? "background: var(--selection)" : "opacity: 0.8"
                out += "\(sel) {\n  /* \(hint); */\n}\n"
            }
        }
        out += """

        /* Dark mode only (or light): the same rules inside @media. */
        @media (prefers-color-scheme: dark) {
          /* bar { background: var(--sunken); } */
        }

        """
        return out
    }

    /// The selector table in docs/style.md, made from `StyleTarget` (a test holds the docs to it).
    public static var selectorTable: String {
        var rows = ["| Selector | States | What it is |", "| --- | --- | --- |"]
        for t in StyleTarget.allCases {
            let states = t.states.isEmpty ? "none" : t.states.map { "`\($0.selector)`" }.joined(separator: " ")
            rows.append("| \(t.selectors.map { "`\($0)`" }.joined(separator: " ")) | \(states) | \(t.help) |")
        }
        return rows.joined(separator: "\n")
    }

    /// The property table in docs/style.md, made from `StyleProperty.all` (a test holds the docs to it).
    public static var propertyTable: String {
        var rows = ["| Property | Takes | Applies to | Inherited | What it does |", "| --- | --- | --- | --- | --- |"]
        for p in StyleProperty.all {
            let on = p.targets.count == StyleTarget.allCases.count ? "everything" : p.targets.map(\.rawValue).joined(separator: ", ")
            rows.append("| `\(p.name)` | \(p.takes) | \(on) | \(p.inherited ? "yes" : "no") | \(p.help) |")
        }
        return rows.joined(separator: "\n")
    }
}
