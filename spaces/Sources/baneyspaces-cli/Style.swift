import BaneySpacesCore
import Darwin
import Foundation

/// `polycarp-spaces style …`: read, check and edit `<config>/style.css`, the sheet that restyles the bar and the dock
/// on top of the theme (docs/style.md). It edits the file directly, so it works with the app running or not; a running
/// app picks the change up within 200 ms. `--json` prints the envelope `polycarp-spaces surfaces` uses, and
/// `polycarp mcp` passes it on as is. The parsing, checking and editing are all in Core (StyleOps); this only reads
/// the arguments.
enum StyleCommand {
    static let usage = """
    usage: polycarp-spaces style <command> [--json]

      path                                   where the sheet is, and whether it exists
      show                                   the sheet's text and its rules
      check [file]                           every problem with its line and column (default: the sheet in use)
      example                                a starter sheet naming every selector and property, all commented out
      preset [name]                          write a whole sheet (omarchy), the old one moved to style.css.bak
      set '<selector>' <property> <value>    change or add one declaration; refused if it would add an error
      unset '<selector>' [property]          remove one declaration, or the whole rule
      reset                                  move the sheet to style.css.bak

    set and unset take --media dark|light to edit the rules for that mode only. The file is <config>/style.css,
    the folder `polycarp theme current` prints. Docs: spaces/docs/style.md in the Polycarp repo.
    """

    static func run(_ args: [String], remote: Bool) -> Never {
        if remote { finish(.failure(StyleFailure("invalid_args", "style edits this Mac's file; run it on the other machine", exit: 2)), json: false) }
        let json = args.contains("--json")
        var media: String?
        var plain: [String] = []
        var i = 0
        let all = args.filter { $0 != "--json" }
        while i < all.count {
            let a = all[i]
            if a == "--media" {
                guard i + 1 < all.count else { finish(.failure(StyleFailure("invalid_args", "usage: --media dark|light", exit: 2)), json: json) }
                media = all[i + 1]; i += 2; continue
            }
            if a.hasPrefix("--media=") { media = String(a.dropFirst(8)); i += 1; continue }
            plain.append(a); i += 1
        }
        let file = StyleSheetFile.path()
        let sub = plain.first ?? "help"
        let rest = Array(plain.dropFirst())
        func usageFail(_ line: String) -> Never { finish(.failure(StyleFailure("invalid_args", "usage: polycarp-spaces style \(line)", exit: 2)), json: json) }
        if media != nil && sub != "set" && sub != "unset" { usageFail("\(sub): --media goes with set and unset only") }
        switch sub {
        case "path":
            guard rest.isEmpty else { usageFail("path [--json]") }
            finish(StyleOps.path(file: file), json: json) { d in
                let f = d["file"]?.string ?? ""
                return d["exists"] == .bool(true) ? f : "\(f) (no file yet: no style sheet)"
            }
        case "show":
            guard rest.isEmpty else { usageFail("show [--json]") }
            finish(StyleOps.show(file: file), json: json) { d in
                guard d["exists"] == .bool(true) else {
                    return "no style sheet at \(d["file"]?.string ?? "style.css"); `polycarp-spaces style example` prints a starter"
                }
                return d["text"]?.string ?? ""
            }
        case "check":
            guard rest.count <= 1 else { usageFail("check [file] [--json]") }
            let target = rest.first.map { (($0 as NSString).expandingTildeInPath as NSString).standardizingPath }
            let absolute = target.map { $0.hasPrefix("/") ? $0 : FileManager.default.currentDirectoryPath + "/" + $0 }
            let label = absolute.map { ($0 as NSString).lastPathComponent } ?? StyleSheetFile.name
            finish(StyleOps.check(file: absolute ?? file, roles: roles), json: json, label: label) { d in
                let n = int(d["rules"])
                return (["valid: \(d["file"]?.string ?? label), \(n) rule\(n == 1 ? "" : "s")"] + lines(d["warnings"], label)).joined(separator: "\n")
            }
        case "example":
            guard rest.isEmpty else { usageFail("example [--json]") }
            finish(StyleOps.example(), json: json) { d in d["text"]?.string ?? "" }
        case "preset":
            guard rest.count <= 1 else { usageFail("preset [name] [--json]") }
            finish(StyleOps.preset(rest.first, file: file, roles: roles), json: json) { d in
                if let list = d["presets"]?.array {
                    return (list.compactMap { p in p.object.map { "\($0["name"]?.string ?? "")  \($0["about"]?.string ?? "")" } }
                        + ["polycarp-spaces style preset <name> writes one"]).joined(separator: "\n")
                }
                var out = ["wrote the \(d["preset"]?.string ?? "") preset to \(d["file"]?.string ?? StyleSheetFile.name)"]
                if let b = d["backup"]?.string { out.append("the sheet that was there is in \(b)") }
                out += lines(d["warnings"], StyleSheetFile.name)
                out.append("`polycarp-spaces style reset` puts the theme's own look back")
                return out.joined(separator: "\n")
            }
        case "set":
            guard rest.count >= 3 else { usageFail("set '<selector>' <property> <value> [--media dark|light] [--json]") }
            let value = rest[2...].joined(separator: " ")
            finish(StyleOps.set(rest[0], rest[1], value, media: media, file: file, roles: roles), json: json) { d in
                var out = ["\(d["selector"]?.string ?? rest[0]) { \(d["property"]?.string ?? rest[1]): \(d["value"]?.string ?? value); }"
                    + (media.map { " (in \($0) mode)" } ?? "")]
                out += lines(d["warnings"], StyleSheetFile.name)
                if let before = d["errors_already_there"]?.array, !before.isEmpty {
                    out.append("the sheet already had \(before.count) error\(before.count == 1 ? "" : "s"); `polycarp-spaces style check` lists them")
                }
                return out.joined(separator: "\n")
            }
        case "unset":
            guard (1...2).contains(rest.count) else { usageFail("unset '<selector>' [property] [--media dark|light] [--json]") }
            finish(StyleOps.unset(rest[0], rest.count == 2 ? rest[1] : nil, media: media, file: file), json: json) { d in
                let n = int(d["removed"])
                let what = rest.count == 2 ? "`\(rest[1])` declaration" : "rule"
                return n == 0 ? "nothing to remove: no \(what) for `\(d["selector"]?.string ?? rest[0])`"
                    : "removed \(n) \(what)\(n == 1 ? "" : "s") from `\(d["selector"]?.string ?? rest[0])`"
            }
        case "reset":
            guard rest.isEmpty else { usageFail("reset [--json]") }
            finish(StyleOps.reset(file: file), json: json) { d in
                if let b = d["backup"]?.string { return "moved the style sheet to \(b); the theme alone styles the bar and the dock" }
                return "no style sheet to reset"
            }
        case "help", "-h", "--help":
            print(usage); exit(0)
        default:
            usageFail("path|show|check|example|preset|set|unset|reset (polycarp-spaces style help)")
        }
    }

    /// The theme's roles in force, for `var(--role)` and the contrast check: the Polycarp theme if one is set, else
    /// the palette the panels draw with no theme.
    static let roles: StyleOps.Roles = { dark in
        if let path = PolycarpThemeFile.path(), let theme = PolycarpThemeFile.load(path: path).theme {
            let c = theme.colors(systemDark: dark)
            return StyleSheet.roles(c.roles, onAccent: c.onAccent)
        }
        return StyleSheet.roles(Palette.auto(accent: AccentPreset.red.rgb).colors)
    }

    private static func int(_ v: SurfaceValue?) -> Int { if case .number(let n)? = v { Int(n) } else { 0 } }

    private static func lines(_ list: SurfaceValue?, _ label: String) -> [String] {
        (list?.array ?? []).compactMap { p in
            guard let o = p.object, case .number(let l)? = o["line"], case .number(let c)? = o["column"], let m = o["message"]?.string else { return nil }
            return "\(label):\(Int(l)):\(Int(c)): \(o["severity"]?.string ?? "error"): \(m)"
        }
    }

    /// Prints the result and exits: the envelope with --json, else `text` on stdout or the refusal and each problem,
    /// as `file:line:column: severity: message`, on stderr.
    private static func finish(_ r: StyleOps.Result, json: Bool, label: String = StyleSheetFile.name,
                               text: ([String: SurfaceValue]) -> String = { _ in "" }) -> Never {
        switch r {
        case .success(let data):
            print(json ? StyleOps.ok(data).json(pretty: true) : text(data.object ?? [:]))
            exit(0)
        case .failure(let f):
            if json {
                print(f.envelope.json(pretty: true))
            } else {
                var out = [f.message]
                out += f.problems.map { "\(label):\($0.description)" }.filter { !f.message.contains($0) }
                if let s = f.suggestion { out.append(s) }
                FileHandle.standardError.write((out.joined(separator: "\n") + "\n").data(using: .utf8)!)
            }
            exit(f.exit)
        }
    }
}
