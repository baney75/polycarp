import Foundation

/// Which apps an agent may start on this Mac. Default deny: the built-in apps were verified to start a separate
/// instance that restores nothing of Donovan's and holds none of his data; an app Donovan allows in Polycarp's sheet
/// (`AgentAppGrants`) starts as a separate copy too, but only the built-ins are known to restore nothing. Everything else
/// (every browser, password managers, Keychain Access, System Settings, mail, messages, notes, calendars, photos,
/// terminals other than the agent's own Ghostty, Office and any app nobody has checked) answers `needs_sandbox`.
public enum AgentAppPolicy {
    /// Started with `-ApplePersistenceIgnoreState YES` as a new instance (`open -n`), so it opens nothing it restored.
    public static let separateInstance: Set<String> = ["com.apple.TextEdit", "com.apple.calculator", "com.apple.Preview"]
    /// Apps that must be started with a document from the handoff folder: with none they would show an Open
    /// panel, and an agent never drives an Open or Save panel (it would browse Donovan's files).
    public static let documentRequired: Set<String> = ["com.apple.TextEdit", "com.apple.Preview"]
    // Finder is not on the list: it runs once per user and shows his folders, and agents use files directly.

    /// BaneySpaces' own test app for the pointer probe: a window that draws where the mouse is dragged and reads no
    /// files. It ships inside BaneySpaces.app (Resources/probe), signed with the app's own identity, and starts only
    /// from there and only when its signature checks out (`ProbeAppTrust` in the app). A user-writable folder, or a
    /// copy that claims the bundle id, is refused like any unlisted app.
    public static let canvasProbeBundle = "com.baney.polycarp.canvasprobe"

    /// Built in, or allowed by Donovan in Polycarp's sheet (`added`), of no kind that is never opened for an agent, and
    /// with a bundle whose facts (`AgentAppFacts`, read now) don't refuse it. An allowed app with no bundle to read is refused.
    public static func allowed(bundle: String, added: Set<String> = AgentAppGrants.current, facts: AgentAppFacts? = nil) -> Bool {
        separateInstance.contains(bundle) || (added.contains(bundle) && neverListed(bundle: bundle) == nil && facts != nil && facts?.refusal == nil)
    }
    /// A copy started for an agent with `open -n`: the built-ins, the probe app and every allowed app.
    public static func needsSeparateInstance(bundle: String, added: Set<String> = AgentAppGrants.current) -> Bool {
        separateInstance.contains(bundle) || bundle == canvasProbeBundle || (added.contains(bundle) && neverListed(bundle: bundle) == nil)
    }
    /// Allowed by Donovan, not built in: its open is checked afterwards (`ListedOpen`).
    public static func isListed(bundle: String, added: Set<String> = AgentAppGrants.current) -> Bool {
        !separateInstance.contains(bundle) && added.contains(bundle) && neverListed(bundle: bundle) == nil
    }

    /// The probe app is allowed when the bundle id is its own, the app sits inside the app bundle's probe folder, and
    /// its signature was checked (`trusted`).
    public static func isProbeApp(bundle: String, at appURL: URL?, in probeFolder: URL?, trusted: Bool) -> Bool {
        guard trusted, bundle == canvasProbeBundle, let appURL, let probeFolder else { return false }
        let app = appURL.standardizedFileURL.resolvingSymlinksInPath().path
        return app.hasPrefix(probeFolder.standardizedFileURL.resolvingSymlinksInPath().path + "/")
    }

    static let kinds: [(prefixes: [String], why: String)] = [
        (["com.google.Chrome", "org.mozilla.", "company.thebrowser.", "com.brave.Browser", "com.microsoft.edgemac", "com.apple.Safari", "com.apple.SafariTechnologyPreview", "net.imput.helium", "org.chromium.Chromium", "com.operasoftware.", "com.vivaldi.Vivaldi",
          "app.zen-browser.", "com.kagi.", "com.duckduckgo.", "org.torproject.", "com.sigmaos.", "com.openai.atlas"],
         "a browser holds Donovan's logins (an agent gets its own browser profile in a later phase)"),
        (["com.1password", "com.agilebits", "com.apple.Passwords", "com.bitwarden", "com.apple.keychainaccess", "org.keepassxc", "com.lastpass"],
         "it holds Donovan's passwords"),
        (["com.apple.systempreferences", "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.Warp", "co.zeit.hyper",
          "net.kovidgoyal.kitty", "org.alacritty", "io.alacritty", "com.github.wez.wezterm", "com.raycast.", "com.runningwithcrayons.Alfred", "org.hammerspoon.",
          "com.stairways.keyboardmaestro.", "com.apple.Home", "com.apple.findmy"],
         "it controls this Mac (settings, a shell)"),
        (["com.apple.Notes", "com.apple.mail", "com.apple.MobileSMS", "com.apple.iCal", "com.apple.Photos", "com.apple.reminders", "com.apple.AddressBook", "com.apple.Music",
          "com.apple.FaceTime", "com.microsoft.", "com.apple.freeform", "com.apple.iBooksX", "com.apple.news", "com.apple.podcasts", "com.apple.TV", "com.apple.Maps",
          "com.apple.VoiceMemos", "com.apple.journal", "com.apple.Stocks", "md.obsidian", "notion.id", "com.spotify.client"],
         "it holds Donovan's own data and exists once per user"),
        (["com.apple.ScriptEditor2", "com.apple.Automator", "com.apple.shortcuts", "com.apple.dt.", "com.apple.ActivityMonitor", "com.apple.Console",
          "com.apple.DiskUtility", "com.apple.finder", "com.apple.AppStore", "com.apple.systemevents", "com.todesktop.", "dev.zed.", "com.sublimetext.",
          "com.panic.", "com.jetbrains.", "com.docker.", "com.utmapp.", "com.parallels.", "org.vim.", "com.baney.polycarp", "com.anthropic.", "com.openai.",
          "com.vscodium", "com.barebones.", "com.visualstudio.", "com.github.GitHubClient"],
         "it runs code, controls other apps or shows Donovan's files"),
        (["com.tinyspeck.slackmacgap", "com.hnc.Discord", "ru.keepcoder.Telegram", "net.whatsapp.", "org.whispersystems.", "us.zoom.", "com.readdle.", "com.superhuman."],
         "it is signed in to Donovan's accounts"),
    ]

    /// Why `bundle` is never opened for an agent, even when Donovan allows it; nil when it may be allowed. A hand-kept
    /// list: `AgentAppFacts` also refuses an app by what its bundle says it is.
    public static func neverListed(bundle: String) -> String? {
        let id = bundle.lowercased()
        return kinds.first { k in
            k.prefixes.contains { p in
                let p = p.lowercased()
                return id == p || id.hasPrefix(p.hasSuffix(".") ? p : p + ".") || (p.hasSuffix(".") && id + "." == p)
            }
        }?.why
    }

    /// nil when the app may start; else `needs_sandbox`, saying why.
    public static func refusal(app: String, bundle: String, appURL: URL? = nil, probeFolder: URL? = nil, probeTrusted: Bool = false,
                               added: Set<String> = AgentAppGrants.current,
                               copyProblem: (String, URL?) -> String? = AgentAppGrants.copyProblem) -> HandsError? {
        // An allowed app opens only as the copy Donovan allowed (second-F7), checked before its bundle is read.
        let moved = added.contains(bundle) && !separateInstance.contains(bundle) ? copyProblem(bundle, appURL) : nil
        let facts = added.contains(bundle) && moved == nil ? AgentAppFacts.read(appURL) : nil
        if moved == nil && allowed(bundle: bundle, added: added, facts: facts) || isProbeApp(bundle: bundle, at: appURL, in: probeFolder, trusted: probeTrusted) { return nil }
        let kind = neverListed(bundle: bundle) ?? moved ?? (added.contains(bundle) ? facts?.refusal ?? "Polycarp can't read its bundle" : nil)
        let why = kind ?? "Donovan hasn't allowed it"
        let ask = kind == nil
            ? "run `polycarp-spaces agent allow \(app)`: Polycarp asks Donovan in a sheet, and only his click on Allow lets agents open it"
            : "ask Donovan to lend \(app) and be away from it while you work"
        let listed = added.filter { neverListed(bundle: $0) == nil }.sorted()
        return HandsError(.needsSandbox, "\(app): \(why)",
                          suggestion: "Do this work in the sandbox (arrives in a later phase), or \(ask). Apps an agent may start now: TextEdit and Preview on a file from the handoff folder, Calculator\(listed.isEmpty ? "" : ", and " + listed.joined(separator: ", ")). Work with files directly rather than through Finder.",
                          retry: .never)
    }
}

/// A System Settings pane link, such as `x-apple.systempreferences:com.apple.Displays-Settings.extension` or
/// `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`. Under Full Access it lets one `open` land
/// on the pane an agent needs instead of a walk through the sidebar (#350); it reaches nothing a click there doesn't.
public enum SettingsPaneLink {
    public static let scheme = "x-apple.systempreferences:"
    private static let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-?=&")

    /// Starts with the scheme, then a pane id and at most a query, in plain ASCII. Anything else is not a pane link.
    public static func isLink(_ s: String) -> Bool {
        guard s.hasPrefix(scheme) else { return false }
        let rest = s.dropFirst(scheme.count)
        guard let first = rest.first, first.isLetter, rest.allSatisfy(allowed.contains) else { return false }
        return rest.filter { $0 == "?" }.count <= 1
    }

    /// System Settings keeps one window, so a link sent to a copy already running moves that window, which may be Donovan's.
    /// A pane link goes only to a copy the open starts itself.
    public static func runningRefusal(targets: [String], alreadyRunning: Bool) -> HandsError? {
        guard alreadyRunning, targets.contains(where: isLink) else { return nil }
        return HandsError(.inUse, "System Settings is already open, and a pane link would move its one window",
                          suggestion: "Use the System Settings window already on the agent workspace and pick the pane in its sidebar, or open the link once it has quit.",
                          retry: .never)
    }
}

/// `agent open`'s one gate, used by the router and by the session engine's raw `open` (which other callers on the socket reach).
public enum AgentOpenGate {
    /// The files to hand over (resolved), or why not. Under Full Access any app may start and any existing file
    /// may be opened (a relative path is read from the handoff folder); URLs still wait for agent browser profiles.
    public static func check(app: String, bundle: String, targets: [String], handoff: URL, appURL: URL? = nil, probeFolder: URL? = nil, probeTrusted: Bool = false,
                             mode: AgentAccessMode = .standard) -> Result<[String], HandsError> {
        if let e = AgentAccessGate.refusal(verb: "open", mode: mode) { return .failure(e) }
        let full = mode == .full
        if !full, let e = AgentAppPolicy.refusal(app: app, bundle: bundle, appURL: appURL, probeFolder: probeFolder, probeTrusted: probeTrusted) { return .failure(e) }
        var files: [String] = []
        for t in targets {
            if t.hasPrefix(SettingsPaneLink.scheme) {
                guard full, bundle == PermissionHelper.settingsBundleID, SettingsPaneLink.isLink(t) else {
                    return .failure(HandsError(.notSupported, "\(t) isn't a System Settings pane link that \(app) may open",
                                               suggestion: "Under Full Access, open one in System Settings: `polycarp-spaces agent open \"System Settings\" x-apple.systempreferences:com.apple.Displays-Settings.extension`.",
                                               retry: .never))
                }
                files.append(t)
                continue
            }
            if t.contains("://") {
                return .failure(HandsError(.notSupported, "opening a URL needs an agent browser profile, which arrives in a later phase",
                                           suggestion: "Open a file instead.", retry: .never))
            }
            if full {
                guard let r = HandoffPath.resolveAnywhere(t, relativeTo: handoff) else {
                    return .failure(HandsError(.badArguments, "\(t) isn't a file or folder on this Mac", suggestion: "Pass the full path of one that exists.", retry: .safe))
                }
                files.append(r.path)
                continue
            }
            guard let r = HandoffPath.resolve(t, in: handoff) else { return .failure(HandoffPath.error(t, folder: handoff)) }
            files.append(r.path)
        }
        if AgentAppPolicy.documentRequired.contains(bundle), files.isEmpty {
            return .failure(HandsError(.badArguments, "\(app) must be started with a file from the handoff folder, or it shows an Open panel",
                                       suggestion: "Put a file in \(handoff.path) and pass its path: `polycarp-spaces agent open \(app) <file>`.", retry: .safe))
        }
        return .success(files)
    }
}

/// Which files an agent may hand to an app: only ones inside the agent handoff folder.
/// Whether a window may be used, from what it shows. An Open or Save panel browses the person's files, so no agent drives one in
/// any mode, on any window. A document is checked only on a process Polycarp started for an agent: a lent app is lent with what it
/// shows, and Full Access opens documents.
public enum WindowInspection: Equatable {
    case usable, panel, outsideDocument

    public static func decide(full: Bool, agentOwned: Bool, panel: Bool, document: String?, handoff: URL) -> WindowInspection {
        if panel { return .panel }
        guard !full, agentOwned, let document, !document.isEmpty, !HandoffPath.contains(document: document, in: handoff) else { return .usable }
        return .outsideDocument
    }

    /// Whether the window stays refused for the rest of the run. Only a document from outside the handoff folder does. A
    /// panel is read again on every use, so the window is usable once it closes: a Print sheet (a Copies field and a
    /// Printer menu, the shape of a Save panel), or one read cut off while a sheet slides in, never refuses it for good.
    public var remembered: Bool { self == .outsideDocument }
}

public enum HandoffPath {
    /// Whether what a window reports as its document (a file URL or a path) is inside the folder.
    public static func contains(document: String, in folder: URL) -> Bool {
        let path = URL(string: document).flatMap { $0.isFileURL ? $0.path : nil } ?? document
        let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        return url.path.hasPrefix(folder.standardizedFileURL.resolvingSymlinksInPath().path + "/")
    }

    /// The path, resolved through symlinks, when it exists inside `folder`; nil otherwise.
    public static func resolve(_ target: String, in folder: URL) -> URL? {
        let expanded = (target as NSString).expandingTildeInPath
        let base = expanded.hasPrefix("/") ? URL(fileURLWithPath: expanded) : folder.appendingPathComponent(expanded)
        let url = base.standardizedFileURL.resolvingSymlinksInPath()
        let root = folder.standardizedFileURL.resolvingSymlinksInPath().path
        guard url.path.hasPrefix(root + "/"), FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    /// Full Access: the path, resolved through symlinks, when a file or folder exists there; relative paths are
    /// read from `folder`.
    public static func resolveAnywhere(_ target: String, relativeTo folder: URL) -> URL? {
        let expanded = (target as NSString).expandingTildeInPath
        let base = expanded.hasPrefix("/") ? URL(fileURLWithPath: expanded) : folder.appendingPathComponent(expanded)
        let url = base.standardizedFileURL.resolvingSymlinksInPath()
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    public static func error(_ target: String, folder: URL) -> HandsError {
        HandsError(.badArguments, "\(target) isn't a file in the agent handoff folder",
                   suggestion: "Put the file in \(folder.path) and pass its path. Agents don't open files from anywhere else, and URLs wait for the agent browser profiles.", retry: .safe)
    }

    /// A shot's file name: a plain name, no folder, no dot-dot.
    public static func isPlainFileName(_ name: String) -> Bool {
        !name.isEmpty && name.count <= 120 && !name.contains("/") && !name.contains("\\") && !name.hasPrefix(".") && !name.contains("\0")
    }
}

/// Whether a typed value shows the typing happened: changed from before, and now holds the text.
public enum ValueCheck {
    public static func typed(before: String, after: String, text: String) -> Bool {
        after != before && after.contains(text) && after.count >= text.count
    }
    public static func set(before: String, after: String, expected: String) -> (verified: Bool, changed: Bool) {
        (after == expected, after != before)
    }
}

/// When the user last used each app. Reads never look at it; an action on an app he is using waits (`InUseWait`).
public struct UserUse: Equatable, Sendable {
    /// How long an app counts as in use after it leaves the front.
    public static let quiet: TimeInterval = 5
    private var leftAt: [Int32: Date] = [:]
    private var front: Int32?

    public init() {}

    /// `pid` came to the front (the app before it just left).
    /// `byAgent`: an agent's action or launch brought it forward. The app before it still counts as just left, but the
    /// agent's app is not one he chose.
    public mutating func activated(_ pid: Int32, now: Date, byAgent: Bool = false) {
        if let old = front, old != pid { leftAt[old] = now }
        front = byAgent ? nil : pid
        if !byAgent { leftAt[pid] = nil }
    }

    /// Whether `pid` is in front (`frontNow`, read from the system), or left it less than `quiet` seconds ago.
    public func inUse(_ pid: Int32, frontNow: Int32?, now: Date) -> Bool { state(pid, frontNow: frontNow, now: now).busy }

    /// The same, with how long ago it left and how soon it is free.
    public func state(_ pid: Int32, frontNow: Int32?, now: Date) -> InUseState {
        if frontNow == pid { return .front }
        if let t = leftAt[pid] {
            let ago = now.timeIntervalSince(t)
            if ago < Self.quiet { return .recent(leftAgo: max(0, ago), freeIn: Self.quiet - max(0, ago)) }
        }
        return .free
    }
}

/// What a refmap file says about a ref's target. The engine writes refmaps as files the agent could edit, so
/// identity is read when the snapshot is taken and compared again before each use; a ref that now points at
/// another process or window is refused.
public struct RefIdentity: Equatable, Sendable {
    public var pid: Int
    public var window: String
    public var instance: String
}

public enum RefmapIdentity {
    /// `@e5` -> identity, from a `refmap.json`'s bytes. Nil when it isn't the expected shape.
    public static func table(from data: Data) -> [String: RefIdentity]? {
        guard let root = JSONValue.parse(data), let inner = root["inner"]?.object else { return nil }
        var out: [String: RefIdentity] = [:]
        for (key, e) in inner {
            guard let pid = e["pid"]?.int, let window = e["source_window_id"]?.string else { return nil }
            out[key] = RefIdentity(pid: pid, window: window, instance: e["process_instance"]?.string ?? "")
        }
        return out
    }

    /// The `@eN` key of `@s8f3k2p9:e5`.
    public static func key(forRef ref: String) -> String? {
        guard let colon = ref.firstIndex(of: ":") else { return nil }
        return "@" + ref[ref.index(after: colon)...]
    }

    /// Whether the ref still means what it meant when it was sealed.
    public static func intact(sealed: [String: RefIdentity], current: Data, ref: String) -> Bool {
        guard let k = key(forRef: ref), let was = sealed[k], let now = table(from: current)?[k] else { return false }
        return was == now
    }

    /// Whether every ref of the snapshot targets this window and process (checked once, when it is taken).
    public static func allTarget(_ t: [String: RefIdentity], window: UInt32, pid: Int32) -> Bool {
        t.values.allSatisfy { $0.window == "w-\(window)" && $0.pid == Int(pid) }
    }
}

/// Whether an event is the user's: from the hardware, not posted by a program. A click on a consent sheet counts
/// only if it is. Synthetic events carry their sender's pid or a private/combined source; hardware ones have pid 0
/// and the HID system state. An accessibility press carries no recent event at all.
public enum UserEventSource {
    public static let hidSystemState: Int64 = 1
    public static func isGenuine(sourcePID: Int64, sourceState: Int64, age: TimeInterval) -> Bool {
        sourcePID == 0 && sourceState == hidSystemState && age >= 0 && age < 2
    }
}

/// What the session socket refuses outright. Any process of this user can write to it, so the socket is not a place
/// where Donovan's decisions can be made: lending and returning an app, and any grant of access, happen only
/// through a consent sheet the app shows and a real click on it.
public enum SocketPolicy {
    public static let humanOnly: Set<String> = ["lend", "return", "grant"]

    public static func refusal(for r: Wire.Request) -> String? {
        // The cursor is how Donovan sees agent activity: an agent may pick its look, but only he switches it off (Settings).
        if r.op == .agent, r.text?.lowercased() == "cursor", r.args?.first?.lowercased() == "off" {
            return "turning the agent cursor off is Donovan's to do, in Polycarp Settings; agents may change its theme: `polycarp-spaces agent cursor theme <name>`"
        }
        // Agent access (Read Only, Default, Full Access) is set only in Settings, behind a real click: nothing on the socket changes it.
        if r.op == .agent, r.text?.lowercased() == "mode", let want = r.args?.first, !want.isEmpty {
            return "changing agent access to \(want) is Donovan's to do, in Polycarp Settings > Agents; `polycarp-spaces agent mode` shows the current one"
        }
        if r.op == .sandbox, r.text?.lowercased() == "images" {
            return "deleting the sandbox's images (24 GB to download again) is Donovan's to do: Settings > Agents > Delete Images"
        }
        guard r.op == .agent, let text = r.text?.lowercased(), humanOnly.contains(text) else { return nil }
        return "\(text) is Donovan's to do: `polycarp-spaces agent lend <app>` asks him in a sheet in Polycarp; nothing sent on this socket lends an app"
    }

    /// An agent caller may move a window to the agent workspace only if its process was started for an agent.
    public static func mayMove(windowPid: Int32?, startedForAgents: Set<Int32>) -> Bool {
        guard let pid = windowPid else { return false }
        return startedForAgents.contains(pid)
    }
}

/// What the engine may be asked a second time. Only a failure the engine itself reports as "nothing was delivered"
/// (retry safe) is ever repeated, and only while the caller is still waiting and the scope still holds. A timeout or
/// an unresponsive app after dispatch is unsafe or unknown: it goes back to the caller as `timeout`, `retry: never`.
public enum EngineRetry {
    public static func mayRepeat(_ e: HandsError) -> Bool { e.code == .timeout && e.retry == .safe }

    /// Runs `attempt` until it succeeds or fails for good. Between attempts the caller's wait and the scope are
    /// checked, so nothing is dispatched for a caller that left or into a window that is out of scope.
    public static func run<T>(attempt: () -> Result<T, HandsError>, stop: () -> HandsError?, cancelled: () -> Bool,
                              giveUp: Date, now: () -> Date = Date.init, pause: () -> Void) -> Result<T, HandsError> {
        while true {
            let r = attempt()
            guard case .failure(let e) = r, mayRepeat(e), now() < giveUp, !cancelled() else { return r }
            pause()
            if cancelled() { return r }
            if let s = stop() { return .failure(s) }
        }
    }
}

/// A window as the accessibility tree shows it, as much of it as the panel check needs.
public struct AXNodeInfo: Equatable, Sendable {
    public var role: String?, subrole: String?, identifier: String?, title: String?
    /// A label's text (AXValue of a static text), when it was read.
    public var value: String?
    public var children: [AXNodeInfo]
    /// False when the node's children could not be read: the panel check then fails closed.
    public var readable: Bool
    public init(role: String? = nil, subrole: String? = nil, identifier: String? = nil, title: String? = nil, value: String? = nil,
                children: [AXNodeInfo] = [], readable: Bool = true) {
        self.role = role; self.subrole = subrole; self.identifier = identifier; self.title = title; self.value = value
        self.children = children; self.readable = readable
    }
}

/// Windows an agent never works in: Open and Save panels. They browse Donovan's files.
///
/// 2026-11-10 (Donovan: "if a window pops up and it needs to press something on that window it should be able too"): a sheet
/// alone no longer puts its window off limits. A sheet is a child the agent may answer with its window's scope
/// (`ChildWindowRule`); only a sheet that is, or may be, an Open or Save panel still does.
public enum PanelDetector {
    static let panelTitles: Set<String> = ["open", "save", "save as", "export", "import", "choose"]

    /// Whether the window is an Open or Save panel, or holds one (a sheet that is or may be one, or a panel element
    /// within three levels). A sheet that is plainly something else (a "Save changes?" alert) leaves the window usable.
    /// `asWindow`: judge it as a window even though it answers AXDialog (`readsAsWindow`).
    public static func windowIsOffLimits(_ w: AXNodeInfo, asWindow: Bool = false) -> Bool {
        if isOpenOrSavePanel(identifier: w.identifier, subrole: w.subrole, title: w.title) { return true }
        if !asWindow && (isSheet(w) || w.subrole == "AXDialog" || w.subrole == "AXSystemDialog") { if looksLikeFilePanel(w) { return true } }
        func holds(_ n: AXNodeInfo, depth: Int) -> Bool {
            if isSheet(n) { return looksLikeFilePanel(n) }
            if isOpenOrSavePanel(identifier: n.identifier, subrole: n.subrole, title: n.title) { return true }
            return depth < 3 && n.children.contains { holds($0, depth: depth + 1) }
        }
        return w.children.contains { holds($0, depth: 1) }
    }

    /// System Settings' own window answers AXDialog for its subrole. Read as a dialog, its pane is deeper than a dialog
    /// read goes (so the read is cut off) and its sidebar is an outline in a split group (a file browser's shape), so
    /// every agent call on it was refused as an Open panel (live, #387). It is read and judged as a window: a
    /// sheet on it, a panel identifier or a panel title still puts it off limits.
    public static func readsAsWindow(bundle: String, identifier: String?) -> Bool {
        bundle == "com.apple.systempreferences" && identifier == "Main"
    }

    /// The panel check of a placed window, from its element: a one-level read (a dialog's, or a sheet's, deep and whole).
    public static func inspect<E>(_ root: E, bundle: String, string: (E, String) -> String?,
                                  children: (E) -> (list: [E], readable: Bool)) -> Bool {
        let asWindow = readsAsWindow(bundle: bundle, identifier: string(root, "AXIdentifier"))
        let node = AXTreeRead.node(root, depth: 1, deep: asWindow ? false : nil, string: string, children: children)
        return windowIsOffLimits(node, asWindow: asWindow)
    }

    /// A child window recognized as a sheet, dialog or alert (by role, subrole or AXModal): off limits when any part of its
    /// read was cut off, or when it is or may be a file panel. Anything else goes through `windowIsOffLimits`.
    public static func childIsOffLimits(_ n: AXNodeInfo, kind: ChildWindowKind?) -> Bool {
        switch kind {
        case .sheet?, .dialog?, .alert?:
            return !n.readable || isOpenOrSavePanel(identifier: n.identifier, subrole: "AXDialog", title: n.title) || looksLikeFilePanel(n)
                || windowIsOffLimits(n)
        default:
            return windowIsOffLimits(n)
        }
    }

    public static func isSheet(_ n: AXNodeInfo) -> Bool { n.role == "AXSheet" || n.subrole == "AXSheet" }

    public static func isOpenOrSavePanel(identifier: String?, subrole: String?, title: String?) -> Bool {
        let id = (identifier ?? "").lowercased()
        if id.contains("open-panel") || id.contains("save-panel") || id.contains("openpanel") || id.contains("savepanel") { return true }
        let t = (title ?? "").lowercased()
        return (subrole == "AXDialog" || subrole == "AXSystemDialog") && panelTitles.contains(t)
    }

    /// Whether a sheet or dialog is, or may be, a file panel. Fails closed: a subtree that could not be read counts as one.
    /// Signs: a panel title or identifier anywhere, a file browser (AXBrowser, an outline inside a split group, a sidebar),
    /// or a name field with a folder menu and a Save panel's labels ("Where", "Save As", "Tags").
    public static func looksLikeFilePanel(_ n: AXNodeInfo) -> Bool {
        if panelTitles.contains((n.title ?? "").lowercased()) { return true }
        var textField = false, popUp = false, filePanel = false
        func walk(_ x: AXNodeInfo, depth: Int, inSplit: Bool) {
            guard !filePanel else { return }
            if !x.readable { filePanel = true; return }
            let id = (x.identifier ?? "").lowercased()
            if isOpenOrSavePanel(identifier: x.identifier, subrole: x.subrole, title: x.title) || id.contains("nssavepanel") || id.contains("nsopenpanel")
                || id.contains("filebrowser") || id.contains("sidebar") || x.role == "AXBrowser" || (inSplit && x.role == "AXOutline") {
                filePanel = true; return
            }
            if x.role == "AXTextField" { textField = true }
            if x.role == "AXPopUpButton" { popUp = true }
            guard depth < 6 else { return }
            for c in x.children { walk(c, depth: depth + 1, inSplit: inSplit || x.role == "AXSplitGroup") }
        }
        walk(n, depth: 0, inSplit: false)
        // second-F8: a name field with a menu beside it is the shape of a (collapsed) Save panel in any language, so it is
        // refused on shape alone, labels unread.
        return filePanel || (textField && popUp)
    }

    /// The refusal for a window that is or holds an Open or Save panel. The same words wherever it is refused.
    public static func refusal(window: UInt32, app: String) -> HandsError {
        HandsError(.needsSandbox, "window \(window) of \(app) is or holds an Open or Save panel",
                   suggestion: "Agents never drive an Open or Save panel. Wait for it to close, or open the file with `polycarp-spaces agent open <app> <file in the handoff folder>`.", retry: .never)
    }
}

/// Processes started for an agent, each with its start time, so a process id that macOS reuses for one of Donovan's
/// apps is never taken for the agent's.
public struct AgentOwnedSet: Equatable, Sendable {
    private var started: [Int32: Double] = [:]
    public init() {}
    public mutating func add(_ pid: Int32, startedAt: Double) { started[pid] = startedAt }
    public mutating func remove(_ pid: Int32) { started[pid] = nil }
    /// True only for the same process: same pid and the same start time.
    public func contains(_ pid: Int32, startedAt: Double?) -> Bool {
        guard let was = started[pid], let now = startedAt else { return false }
        return abs(was - now) < 0.5
    }
    public var pids: Set<Int32> { Set(started.keys) }
}

/// Whether a click or key may answer the consent sheet: the right kind of event, after the button was enabled,
/// on the button.
public enum ConsentClick {
    public enum Kind: Sendable { case mouseDown, mouseUp, keyDown, other }
    public static func valid(kind: Kind, eventTime: Double, buttonEnabledAt: Double, insideButton: Bool, keyIsActivation: Bool) -> Bool {
        guard eventTime >= buttonEnabledAt else { return false }
        switch kind {
        case .mouseUp, .mouseDown: return insideButton
        case .keyDown: return keyIsActivation
        case .other: return false
        }
    }
}
