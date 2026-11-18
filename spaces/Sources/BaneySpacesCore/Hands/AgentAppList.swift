import Foundation

/// Apps Donovan lets agents open on the agent workspace, beyond the built-in ones. Only Polycarp changes the list, and
/// only after Donovan clicks Allow in its sheet (`polycarp-spaces agent allow <app>`; `AppAllowConsent` in the app). The
/// session socket and every file a process of his can write are open to an agent with a shell, so nothing an agent can
/// write grants an open (review of #496, first-F1). The app reads its saved copy once at launch, keeps the list here in
/// memory, and saves it only after a click or a removal; a change to the saved copy while it runs is never read.
public enum AgentAppGrants {
    private static let lock = NSLock()
    private static var apps: Set<String> = []
    /// Where the app saves the list (its own defaults domain, as it does Agent Access).
    public static let defaultsKey = "agentApps"

    public static var current: Set<String> { lock.lock(); defer { lock.unlock() }; return apps }

    /// The app only: at launch from its saved copy, and after Donovan's click or a removal. A kind that is never an
    /// agent's, or a string that isn't a bundle id, is dropped.
    public static func replace(_ new: Set<String>) {
        let kept = new.filter { isBundleID($0) && AgentAppPolicy.neverListed(bundle: $0) == nil }
        lock.lock(); apps = kept; lock.unlock()
    }

    /// The app only, once at launch: its saved copy.
    public static func loadSaved(_ defaults: UserDefaults = .standard) {
        replace(Set(defaults.stringArray(forKey: defaultsKey) ?? []))
    }

    /// The app only, after Donovan's click or a removal.
    public static func save(_ defaults: UserDefaults = .standard) {
        defaults.set(current.sorted(), forKey: defaultsKey)
    }

    public static func isBundleID(_ id: String) -> Bool {
        id.range(of: #"^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$"#, options: .regularExpression) != nil
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
