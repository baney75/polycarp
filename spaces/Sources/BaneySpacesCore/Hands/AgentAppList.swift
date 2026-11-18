import AppKit
import Security

/// Apps Donovan lets agents open on the agent workspace, beyond the built-in ones, each with the copy he allowed. Only
/// Polycarp adds one, and only after Donovan clicks Allow in its sheet (`polycarp-spaces agent allow <app>`;
/// `AppAllowConsent` in the app). The list lives in Polycarp's memory and nowhere else: the session socket, its defaults
/// and every file a process of his can write are open to an agent with a shell, and an ad hoc or Local Signing identity
/// has no team for a keychain item only Polycarp can read, so a saved copy could be forged (review of #533, first-F1).
/// An allow lasts until Polycarp quits; after a restart Donovan is asked again.
public enum AgentAppGrants {
    private static let lock = NSLock()
    private static var apps: [String: AgentAppCopy] = [:]

    public static var current: Set<String> { lock.lock(); defer { lock.unlock() }; return Set(apps.keys) }
    public static func copy(of bundle: String) -> AgentAppCopy? { lock.lock(); defer { lock.unlock() }; return apps[bundle] }

    /// The app only, after Donovan's click. A kind that is never an agent's, or a string that isn't a bundle id, is dropped.
    public static func add(_ bundle: String, _ copy: AgentAppCopy) {
        guard isBundleID(bundle), AgentAppPolicy.neverListed(bundle: bundle) == nil else { return }
        lock.lock(); apps[bundle] = copy; lock.unlock()
    }

    public static func remove(_ bundle: String) { lock.lock(); apps[bundle] = nil; lock.unlock() }
    /// Tests only.
    public static func clear() { lock.lock(); apps = [:]; lock.unlock() }

    /// Why the copy at `appURL` is not the one Donovan allowed for `bundle`, or nil when it is (review of #533, second-F7).
    public static func copyProblem(bundle: String, at appURL: URL?) -> String? {
        guard let allowed = copy(of: bundle) else { return "Polycarp has no record of the copy Donovan allowed" }
        guard let appURL else { return "Polycarp can't find its bundle" }
        if let why = AgentAppCopy.placeProblem(appURL, registered: NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle)) { return why }
        if AgentAppCopy.path(appURL) != allowed.path { return "it is not the copy Donovan allowed (\(allowed.path))" }
        if !AgentAppCopy.meets(appURL, allowed.requirement) { return "its code is not signed as the copy Donovan allowed was" }
        return nil
    }

    public static func isBundleID(_ id: String) -> Bool {
        id.range(of: #"^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$"#, options: .regularExpression) != nil
    }
}

/// The copy of an app Donovan allowed: where it is and its designated code requirement, checked again at every open. A
/// bundle id says nothing by itself: any folder can hold a bundle that claims a real app's id (review of #533, second-F7).
public struct AgentAppCopy: Equatable, Sendable {
    public let path: String
    public let requirement: String
    public init(path: String, requirement: String) { self.path = path; self.requirement = requirement }

    /// The folders an allowed app may be in. A copy elsewhere (Downloads, a temporary folder) is refused.
    public static let folders = ["/Applications/", "/System/Applications/"]

    public static func path(_ url: URL) -> String { url.standardizedFileURL.resolvingSymlinksInPath().path }

    /// Why a copy at `url` can't be allowed or opened, or nil: it must sit in `folders` and be the copy LaunchServices
    /// opens for its id (`registered`), so the sheet and the open name the same app.
    public static func placeProblem(_ url: URL, registered: URL?) -> String? {
        let p = path(url)
        if !folders.contains(where: { p.hasPrefix($0) }) { return "it is not in /Applications or /System/Applications (\(p))" }
        if registered.map(path) != p { return "it is not the copy macOS opens for its bundle id (\(registered.map(path) ?? "none"))" }
        return nil
    }

    /// The copy at `url` as Donovan is asked to allow it, or nil when its signature can't be read.
    public static func read(_ url: URL) -> AgentAppCopy? {
        var code: SecStaticCode?, req: SecRequirement?, text: CFString?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures), nil) == errSecSuccess,
              SecCodeCopyDesignatedRequirement(code, [], &req) == errSecSuccess, let req,
              SecRequirementCopyString(req, [], &text) == errSecSuccess, let text else { return nil }
        return AgentAppCopy(path: path(url), requirement: text as String)
    }

    /// Whether the code at `url` is intact and meets `requirement`.
    public static func meets(_ url: URL, _ requirement: String) -> Bool {
        var code: SecStaticCode?, req: SecRequirement?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req else { return false }
        return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures), req) == errSecSuccess
    }
}

/// What an app's own bundle says about it, read before it may be listed and again at every open, so an app missing from
/// `AgentAppPolicy.kinds` is still refused by what it is (review of #496, first-F1 and second-F6).
public struct AgentAppFacts: Equatable, Sendable {
    /// It handles http or https links (`CFBundleURLTypes`): a browser, which holds Donovan's logins.
    public var opensWeb: Bool
    /// `LSApplicationCategoryType`.
    public var category: String?
    /// `LSMultipleInstancesProhibited`: a second copy can't start, so `open -n` reaches his.
    public var oneCopyOnly: Bool

    public init(opensWeb: Bool = false, category: String? = nil, oneCopyOnly: Bool = false) {
        self.opensWeb = opensWeb
        self.category = category
        self.oneCopyOnly = oneCopyOnly
    }

    /// From the app's Info.plist; nil when there is no bundle to read.
    public static func read(_ appURL: URL?) -> AgentAppFacts? {
        guard let appURL, let info = Bundle(url: appURL)?.infoDictionary else { return nil }
        let schemes = (info["CFBundleURLTypes"] as? [[String: Any]] ?? []).flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        return AgentAppFacts(opensWeb: schemes.contains { ["http", "https"].contains($0.lowercased()) },
                             category: info["LSApplicationCategoryType"] as? String,
                             oneCopyOnly: (info["LSMultipleInstancesProhibited"] as? Bool) ?? false)
    }

    /// Why an app with these facts is never listed; nil when it may be.
    public var refusal: String? {
        if opensWeb { return "it opens web links, so it is a browser, and a browser holds Donovan's logins" }
        if category == "public.app-category.developer-tools" { return "it is a developer tool, and those run code" }
        if oneCopyOnly { return "it runs one copy only, so a new copy would reach Donovan's" }
        return nil
    }
}

/// After an agent opens a listed app: it must have started a new copy, and Donovan's running copy must not have
/// grown a window. An app that takes a single-instance lock (many Electron apps) hands the launch to his copy, which
/// opens or raises a window on his workspace (review of #496, second-F6). The built-in apps were checked one by one,
/// so this runs only for listed ones.
public enum ListedOpen {
    /// nil when the open did what a listed app must; else `needs_sandbox`, saying what happened.
    public static func refusal(app: String, newCopies: Int, oldCopyWindows: Int) -> HandsError? {
        let what: String
        if oldCopyWindows > 0 { what = "the open reached the copy Donovan runs, which opened \(oldCopyWindows) window(s) on his side" }
        else if newCopies == 0 { what = "no separate copy of it started" }
        else { return nil }
        return HandsError(.needsSandbox, "\(app): \(what), so it can't be an agent's",
                          suggestion: "Ask Donovan to remove it (`polycarp-spaces agent allow --remove \(app)`) or to lend \(app) while he is away from it.",
                          retry: .never)
    }
}
