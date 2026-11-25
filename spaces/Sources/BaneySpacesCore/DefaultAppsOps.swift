import Foundation

/// The operations `polycarp-spaces defaults` runs and `polycarp mcp` passes on: read and choose which app does each job.
/// They read and write config.toml themselves, so the app need not run; a running one follows the file. None of them
/// changes macOS's own defaults: only a person's click in Settings does that (R-D8).
public enum DefaultAppsOps {
    public typealias Result = SurfacesOps.Result

    public static func list(file: String, installed: InstalledApps) -> Result {
        read(file).map { c in
            .object(["defaults": .array(AppRole.allCases.map { .object(row($0, c, installed)) }), "file": .string(SurfacesOps.display(file)),
                     "warnings": .array(c.warnings.map { .string($0) })])
        }
    }

    public static func get(_ role: String, file: String, installed: InstalledApps) -> Result {
        named(role).flatMap { r in read(file).map { c in .object(row(r, c, installed)) } }
    }

    public static func candidates(_ role: String, file: String, installed: InstalledApps) -> Result {
        named(role).flatMap { r in
            read(file).map { c in
                let answer = DefaultAppResolver.resolve(r, choice: c.apps[r], installed: installed)
                return .object(["role": .string(r.rawValue), "candidates": .array(answer.candidates.map {
                    var o = said($0); o["current"] = .bool($0.app == answer.app?.app); return .object(o)
                })])
            }
        }
    }

    /// `app` is a bundle identifier, a program's id, or the name of an installed candidate.
    public static func set(_ role: String, _ app: String, file: String, installed: InstalledApps) -> Result {
        named(role).flatMap { r in
            read(file).flatMap { c in
                let list = DefaultAppResolver.resolve(r, choice: c.apps[r], installed: installed).candidates
                func same(_ a: String) -> Bool { a.compare(app, options: [.caseInsensitive]) == .orderedSame }
                let found = list.first { same($0.app.id) } ?? DefaultApp(id: app, role: r).flatMap { DefaultAppResolver.candidate($0, r, installed) }
                let byName = found == nil ? list.filter { same($0.name) } : []
                guard let pick = found ?? (byName.count == 1 ? byName[0] : nil) else {
                    let offer = list.map { "\($0.app.id) (\($0.name))" }.joined(separator: ", ")
                    let why = byName.count > 1 ? "\(byName.count) installed apps are called \(app); use an id"
                        : "\(app) isn't installed, or can't be the \(r.rawValue) app"
                    return .failure(SurfacesFailure("not_found", why, suggestion: offer.isEmpty ? "Give an installed app's bundle identifier." : "Installed: \(offer)"))
                }
                return write(r, pick.app, file, installed)
            }
        }
    }

    public static func reset(_ role: String, file: String, installed: InstalledApps) -> Result {
        named(role).flatMap { write($0, nil, file, installed) }
    }

    // MARK: The parts

    private static func named(_ role: String) -> Swift.Result<AppRole, SurfacesFailure> {
        if let r = AppRole(rawValue: role.lowercased()) { return .success(r) }
        return .failure(SurfacesFailure("invalid_args", "no role \(role)",
                                        suggestion: "The roles are \(AppRole.allCases.map(\.rawValue).joined(separator: ", ")).", exit: 2))
    }

    private static func read(_ file: String) -> Swift.Result<DefaultAppsFile.Choices, SurfacesFailure> {
        do { return .success(try DefaultAppsFile.load(path: file)) } catch {
            return .failure(SurfacesFailure("io_error", "can't read \(SurfacesOps.display(file)): \(error)"))
        }
    }

    private static func write(_ role: AppRole, _ app: DefaultApp?, _ file: String, _ installed: InstalledApps) -> Result {
        do { try DefaultAppsFile.set(role, to: app, path: file) } catch {
            return .failure(SurfacesFailure("io_error", "\(error)"))
        }
        return read(file).map { c in
            var o = row(role, c, installed)
            if app != nil, role.canSetEverywhere {
                o["everywhere"] = .string("This is Polycarp's own choice. To make it the whole Mac's, a person presses "
                    + "Settings > Default apps > \(role.title) > Everywhere on this Mac, and answers macOS's question.")
            }
            return .object(o)
        }
    }

    private static func row(_ role: AppRole, _ c: DefaultAppsFile.Choices, _ installed: InstalledApps) -> [String: SurfaceValue] {
        let r = DefaultAppResolver.resolve(role, choice: c.apps[role], installed: installed)
        return ["role": .string(role.rawValue), "title": .string(role.title), "app": r.app.map { .object(said($0)) } ?? .null,
                "source": .string(r.source.rawValue), "said": .string(r.said), "chosen": c.apps[role].map { .string($0.id) } ?? .null,
                "warnings": .array(c.warnings.filter { $0.hasPrefix("\(DefaultAppsFile.section).\(role.rawValue) ") }.map { .string($0) })]
    }

    private static func said(_ c: DefaultCandidate) -> [String: SurfaceValue] {
        var o: [String: SurfaceValue] = ["id": .string(c.app.id), "name": .string(c.name)]
        if case .command = c.app { o["kind"] = .string("program") } else { o["kind"] = .string("app") }
        if let p = c.path { o["path"] = .string(p) }
        if let n = c.note { o["note"] = .string(n) }
        return o
    }
}
