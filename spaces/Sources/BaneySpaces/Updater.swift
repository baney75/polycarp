import AppKit
import BaneySpacesCore

/// Finds new builds of Polycarp, each one built from main, and installs one only when the person
/// presses Update Now. Checking reads the feed's latest.json once a day, and can be turned
/// off; it sends nothing about this Mac. Installing runs the same installer as the first install: it
/// downloads the release's signed app (checked against the pinned release key) and puts it where
/// this copy is. It builds on this Mac instead when this copy was built here and the command line
/// tools are installed: that keeps its signature, so the Accessibility permission carries over.
/// A copy built here, updated on a Mac without the tools, gets the ready-made app and macOS asks
/// for the permission once more.
final class Updater: NSObject {

    /// The build on offer, if one is newer than this one.
    private(set) var available: Release?
    /// The build being installed right now.
    private(set) var installing: Release?
    /// Called on the main thread whenever `available` or `installing` changes.
    var onChange: () -> Void = {}

    /// True while BaneySpaces is in the middle of something an alert mustn't interrupt (a
    /// workspace switch): alerts wait for it to end.
    var isBusy: () -> Bool = { false }

    /// How many checks have finished since launch, and why the last one failed (nil when it didn't).
    /// `polycarp-spaces update` reads both (`report`).
    private(set) var checks = 0
    private(set) var checkProblem: String?

    private var timer: Timer?
    /// A check is asking GitHub right now: the menu's update row reads "Checking for Updates…".
    private(set) var checking = false
    private var watch: Timer?
    /// Alerts on screen, kept alive until a button closes them.
    private var shown: [NSAlert] = []

    static let build: BuildInfo = {
        let info = Bundle.main.infoDictionary ?? [:]
        let commit = (info["PolycarpCommit"] as? String).flatMap { $0.allSatisfy(\.isHexDigit) && $0.count >= 7 ? $0 : nil }
        let date = (info["PolycarpCommitDate"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
        let short = info["CFBundleShortVersionString"] as? String ?? "0"
        return BuildInfo(version: info["PolycarpVersion"] as? String ?? short, commit: commit, commitDate: date,
                         isRelease: BuildInfo.isRelease(channel: info["PolycarpChannel"] as? String))
    }()

    /// "0.4.0 (abc1234)" for a release, "0.4.0 local build (abc1234)" for one built here, "0.4.0" without a commit.
    static var buildDescription: String {
        let base = SemVer(build.version)?.base ?? build.version
        let named = build.isRelease ? base : "\(base) local build"
        return build.commit.map { "\(named) (\($0.prefix(7)))" } ?? named
    }

    var checksAutomatically: Bool {
        get { UserDefaults.standard.object(forKey: "checkForUpdates") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "checkForUpdates") }
    }

    private var lastCheck: Date? {
        get { UserDefaults.standard.object(forKey: "lastUpdateCheck") as? Date }
        set { UserDefaults.standard.set(newValue, forKey: "lastUpdateCheck") }
    }

    func start() {
        // Copies from before one stream saved a channel choice; nothing reads it now.
        UserDefaults.standard.removeObject(forKey: "updateChannel")
        showWhatsNewIfJustUpdated()
        // A quiet check soon after launch, then once a day while BaneySpaces runs.
        timer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in self?.checkIfDue() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.checkIfDue() }
    }

    private func checkIfDue() {
        updateBrowserIfDue()
        if rebuild.look(free: rebuildFree) { runBrowserUpdate() }
        guard checksAutomatically, installing == nil else { return }
        if let last = lastCheck, Date().timeIntervalSince(last) < 23 * 3600, available == nil { return }
        check(manual: false)
    }

    /// In the background and quietly: `polycarp browser status` and `polycarp doctor` say where it stands.
    private func updateBrowserIfDue() {
        let last = UserDefaults.standard.object(forKey: "lastBrowserUpdate") as? Date
        guard installing == nil, !rebuild.running,
              BrowserUpdate.due(last: last, now: Date(), automatic: checksAutomatically) else { return }
        UserDefaults.standard.set(Date(), forKey: "lastBrowserUpdate")
        runBrowserUpdate()
    }

    /// The same run now, for a new icon in the theme's colors: quiet, and only while updates are automatic. An ask while
    /// a run or the app's own update is under way is kept until it can start (`BrowserUpdate.Rebuild`).
    func rebuildBrowser() {
        if rebuild.ask(free: rebuildFree) { runBrowserUpdate() }
    }

    private var rebuild = BrowserUpdate.Rebuild(wanted: UserDefaults.standard.bool(forKey: "browserRebuildWanted")) {
        didSet { UserDefaults.standard.set(rebuild.wanted, forKey: "browserRebuildWanted") }
    }
    private var rebuildFree: Bool { checksAutomatically && installing == nil }
    private var browserUpdate: Process?

    private func runBrowserUpdate() {
        guard !rebuild.running, let resources = Bundle.main.resourceURL else { return }
        let update = Process()
        update.executableURL = BrowserUpdate.command(resources: resources)
        update.arguments = BrowserUpdate.arguments
        update.qualityOfService = .utility
        update.standardInput = FileHandle.nullDevice
        update.standardOutput = FileHandle.nullDevice
        update.standardError = FileHandle.nullDevice
        update.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.browserUpdate = nil
                if self.rebuild.ended(free: self.rebuildFree) { self.runBrowserUpdate() }
            }
        }
        do { try update.run() } catch { return }
        rebuild.started()
        browserUpdate = update
    }

    /// Reads the feed's latest.json. A manual check always answers, even "you're up to date".
    func check(manual: Bool) {
        guard !checking else { return }
        checking = true
        var request = URLRequest(url: Updates.feedURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("Polycarp/\(Self.build.version)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                // Nothing published yet is an answer, not a failure.
                let feed = status == 200 ? data.flatMap(Feed.init(json:)) : nil
                guard status == 404 || feed != nil else {
                    let problem = error?.localizedDescription ?? (status == 200 ? "the update feed isn't one Polycarp can read" : "GitHub answered with status \(status)")
                    self.checking = false
                    self.checkProblem = problem
                    self.checks += 1
                    if manual { self.tell("Couldn't check for updates", error?.localizedDescription ?? "\(status == 200 ? "The update feed isn't one Polycarp can read" : "GitHub answered with status \(status)"). Try again later.") }
                    return
                }
                self.lastCheck = Date()
                let offer = feed.flatMap { Updates.offer($0, build: Self.build) }
                // Still checking while GitHub compares (up to 20 s), so the menu's row stays disabled and a
                // second click can't start a second check with its own alert.
                self.confirm(offer, feed: feed) { release in
                    self.checking = false
                    self.available = release
                    self.checkProblem = nil
                    self.checks += 1
                    self.onChange()
                    guard manual else { return }
                    if let release {
                        self.offer(release)
                    } else if feed == nil {
                        self.tell("Nothing published yet", "No build of Polycarp has been published yet. You have \(Self.buildDescription).")
                    } else if feed?.platforms.contains(Feed.thisMac) == false {
                        self.tell("No build for this Mac", "Polycarp builds are for Apple silicon Macs. To update this one, build it from source with the installer. You have \(Self.buildDescription).")
                    } else {
                        self.tell("Polycarp is up to date", "You have \(Self.buildDescription), the newest build.")
                    }
                }
            }
        }.resume()
    }

    /// What the updater knows right now, for `polycarp-spaces update`.
    var report: UpdateReport {
        let build = Self.buildDescription
        if let r = installing ?? (Self.installerRunning ? available : nil) {
            return UpdateReport(state: .installing, build: build, name: r.name, commit: r.commit, checks: checks)
        }
        if let r = available {
            return UpdateReport(state: .available, build: build, name: r.name, commit: r.commit, checks: checks)
        }
        if checks == 0 || checkProblem != nil {
            return UpdateReport(state: .unknown, build: build, checks: checks, problem: checkProblem)
        }
        return UpdateReport(state: .current, build: build, checks: checks)
    }

    /// Answers `polycarp-spaces update`: "status" reports, "check" also asks GitHub again (the answer
    /// arrives in a later status, when `checks` has gone up), "now" installs the release on offer the
    /// way Update Now does: the same installer, the same signature check, nothing new.
    func answer(_ what: String) -> Wire.Reply {
        switch what {
        case "status": break
        case "check": check(manual: false)
        case "now":
            guard let release = available else { return Wire.Reply(ok: false, error: "no update is on offer; run update --check first", info: report.info) }
            // Often unattended: a question could wait forever, so a terminal running a program stops it instead.
            if let why = TerminalQuit.updateRefusal(busy: TerminalFeature.busyCount()) { return Wire.Reply(ok: false, error: why, info: report.info) }
            install(release)
        default: return Wire.Reply(ok: false, error: "update takes status, check or now")
        }
        return Wire.Reply(ok: true, info: report.info)
    }

    /// Offers `release` only when GitHub confirms it is ahead of this build: it contains every change this build
    /// has, plus more. Versions alone can't tell a local build's commit from main's. Without an answer
    /// (offline, rate limited), the version decides (`Updates.isNewerVersion`).
    private func confirm(_ release: Release?, feed: Feed?, then: @escaping (Release?) -> Void) {
        guard let release, let feed else { return then(nil) }
        guard let mine = Self.build.commit, let theirs = release.commit,
              let url = URL(string: "https://api.github.com/repos/baney75/polycarp/compare/\(mine)...\(theirs)") else { return then(release) }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Polycarp/\(Self.build.version)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let status = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["status"] as? String
            DispatchQueue.main.async {
                guard (response as? HTTPURLResponse)?.statusCode == 200, let status else {
                    return then(Updates.isNewerVersion(feed, than: Self.build) ? release : nil)
                }
                then(status == "ahead" ? release : nil)
            }
        }.resume()
    }

    // MARK: Offering an update

    /// Shows what's new in `release` and installs it if the person agrees.
    func offer(_ release: Release) {
        let alert = NSAlert()
        alert.messageText = "\(release.name) is available"
        alert.informativeText = "You have \(Self.buildDescription). Updating installs the new version in about a minute, then Polycarp restarts by itself. Your workspaces stay as they are."
        alert.accessoryView = Self.notesView(release.notes)
        alert.addButton(withTitle: "Update Now")
        alert.addButton(withTitle: "Later")
        present(alert) { [weak self] button in if button == 0 { self?.installAskingTerminals(release) } }
    }

    /// Updating restarts Polycarp, which ends the programs in its terminals: Update Now says so first while one runs.
    /// The installer's own quit then doesn't ask again (`TerminalFeature.shouldTerminate`).
    private func installAskingTerminals(_ release: Release) {
        guard let question = TerminalQuit.updateQuestion(busy: TerminalFeature.busyCount()) else { return install(release) }
        let alert = NSAlert()
        alert.messageText = question
        alert.informativeText = TerminalQuit.detail
        alert.addButton(withTitle: "Update Anyway")
        alert.addButton(withTitle: "Cancel")
        present(alert) { [weak self] button in if button == 0 { self?.install(release) } }
    }

    /// Shows an alert as an ordinary window, not a modal one: a modal alert stops the timers a
    /// workspace switch runs on. It waits for a switch in progress to end, so focus doesn't
    /// jump to BaneySpaces halfway through one.
    private func present(_ alert: NSAlert, then: @escaping (Int) -> Void = { _ in }) {
        guard !isBusy() else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.present(alert, then: then) }
            return
        }
        shown.append(alert)
        for (i, button) in alert.buttons.enumerated() {
            let target = ButtonAction { [weak self, weak alert] in
                guard let alert else { return }
                alert.window.orderOut(nil)
                self?.shown.removeAll { $0 === alert }
                then(i)
            }
            button.target = target
            button.action = #selector(ButtonAction.run(_:))
            objc_setAssociatedObject(button, &ButtonAction.key, target, .OBJC_ASSOCIATION_RETAIN)
        }
        alert.layout()
        alert.window.level = .floating
        alert.window.center()
        NSApp.activate(ignoringOtherApps: true)
        alert.window.makeKeyAndOrderFront(nil)
    }

    /// Release notes in a scrolling view, Markdown rendered.
    private static func notesView(_ notes: String) -> NSView {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 480, height: 280))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        let text = NSTextView(frame: scroll.bounds)
        text.isEditable = false
        text.drawsBackground = false
        text.textContainerInset = NSSize(width: 8, height: 8)
        text.autoresizingMask = .width
        text.textStorage?.setAttributedString(ReleaseNotes.render(notes.isEmpty ? "No notes for this release." : notes))
        scroll.documentView = text
        return scroll
    }

    // MARK: Installing

    private static var supportFolder: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Polycarp")
    }
    private static var logURL: URL { supportFolder.appendingPathComponent("update.log") }

    private static var statusURL: URL { supportFolder.appendingPathComponent("update.status") }
    private static var pidURL: URL { supportFolder.appendingPathComponent("update.pid") }

    /// Whether an installer started earlier (by this launch or one before it) is still running.
    private static var installerRunning: Bool {
        guard let text = try? String(contentsOf: pidURL, encoding: .utf8),
              let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 else { return false }
        return kill(pid, 0) == 0
    }

    /// Runs the installer for `release` in the background. It downloads (or builds) first and only
    /// then quits and replaces this app, so a failed update leaves BaneySpaces running as it was. The
    /// exact commit whose notes were shown is installed, or nothing is.
    func install(_ release: Release) {
        guard installing == nil, release.isInstallable else { return }
        guard !Self.installerRunning else {
            return tell("An update is already installing", "It installs in the background and restarts Polycarp when it's done.")
        }
        let folder = Self.supportFolder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // The tag and commit only ever reach the shell as environment variables, and only a tag
        // Polycarp publishes (nightly) and a hex commit get this far. The script
        // writes its exit status last, whatever stopped it.
        let script = """
        set -uo pipefail
        echo $$ > "$BANEYSPACES_PID_FILE"
        TMP=$(mktemp -d)
        trap 'code=$?; rm -rf "$TMP"; [ $code = 0 ] || echo "Polycarp update failed ($code)"; echo $code > "$BANEYSPACES_STATUS_FILE"; rm -f "$BANEYSPACES_PID_FILE"' EXIT
        set -e
        echo "== $(date) updating to $BANEYSPACES_REF ${BANEYSPACES_COMMIT:-}"
        curl -fsSL "https://raw.githubusercontent.com/baney75/polycarp/${BANEYSPACES_COMMIT:-$BANEYSPACES_REF}/spaces/install.sh" -o "$TMP/install.sh"
        bash "$TMP/install.sh"
        """
        let scriptURL = folder.appendingPathComponent("update.sh")
        do { try script.write(to: scriptURL, atomically: true, encoding: .utf8) } catch {
            return tell("Couldn't start the update", error.localizedDescription)
        }
        try? FileManager.default.removeItem(at: Self.statusURL)
        try? Data().write(to: Self.logURL)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        // nohup and & let the installer outlive this app, which it quits and replaces.
        task.arguments = ["-c", "nohup /bin/bash \"$0\" >>\"$1\" 2>&1 &", scriptURL.path, Self.logURL.path]
        var env = ProcessInfo.processInfo.environment
        env["BANEYSPACES_REF"] = release.tag
        // The new copy goes where this one is, so an /Applications copy isn't left beside a new
        // one in ~/Applications. Only those two folders count: a copy run from anywhere else
        // (a build folder, the disk image) leaves it unset, and the installer finds the installed copy.
        let parent = Bundle.main.bundleURL.deletingLastPathComponent().path
        if parent == "/Applications" || parent == "\(NSHomeDirectory())/Applications" {
            env["BANEYSPACES_INSTALL_DIR"] = parent
        }
        if let commit = release.commit { env["BANEYSPACES_COMMIT"] = commit }
        env["BANEYSPACES_STATUS_FILE"] = Self.statusURL.path
        env["BANEYSPACES_PID_FILE"] = Self.pidURL.path
        task.environment = env
        do { try task.run() } catch {
            return tell("Couldn't start the update", error.localizedDescription)
        }
        UserDefaults.standard.set(["tag": release.tag, "name": release.name, "notes": release.notes,
                                   "commit": release.commit ?? "", "from": Self.buildDescription], forKey: "updatingTo")
        installing = release
        onChange()
        watchForFailure()
    }

    /// The installer quits BaneySpaces when it succeeds. If BaneySpaces is still here when the
    /// installer has finished with a failure, say so instead of leaving "Updating…" in the menu.
    private func watchForFailure() {
        watch?.invalidate()
        watch = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
            guard let self else { return timer.invalidate() }
            guard let text = try? String(contentsOf: Self.statusURL, encoding: .utf8),
                  let code = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
            timer.invalidate()
            self.installing = nil
            UserDefaults.standard.removeObject(forKey: "updatingTo")
            self.onChange()
            if self.rebuild.look(free: self.rebuildFree) { self.runBrowserUpdate() }
            // Success means this app is about to be replaced; nothing to say.
            guard code != 0 else { return }
            let log = (try? String(contentsOf: Self.logURL, encoding: .utf8)) ?? ""
            let alert = NSAlert()
            alert.messageText = "The update didn't install"
            alert.informativeText = log.contains("moved to a newer build")
                ? "A newer build was published while you were reading the notes. Check for updates again to see it."
                : "Polycarp is still on \(Self.buildDescription) and works as before. The log says what went wrong."
            alert.addButton(withTitle: "Show Log")
            alert.addButton(withTitle: "OK")
            self.present(alert) { if $0 == 0 { NSWorkspace.shared.open(Self.logURL) } }
        }
        RunLoop.main.add(watch!, forMode: .common)
    }

    /// The first launch after an update says what changed.
    private func showWhatsNewIfJustUpdated() {
        guard let info = UserDefaults.standard.dictionary(forKey: "updatingTo") as? [String: String] else { return }
        UserDefaults.standard.removeObject(forKey: "updatingTo")
        let wanted = info["commit"] ?? ""
        let arrived = wanted.isEmpty ? info["from"] != Self.buildDescription
            : Self.build.commit.map { $0.hasPrefix(wanted) || wanted.hasPrefix($0) } == true
        guard arrived else { return }
        // After setup has had its chance to open: it comes first when permission needs fixing.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [self] in
            let alert = NSAlert()
            alert.messageText = "Polycarp is updated"
            alert.informativeText = "You're on \(Self.buildDescription) now (from \(info["from"] ?? "an older build")). Here's what changed."
            alert.accessoryView = Self.notesView(info["notes"] ?? "")
            alert.addButton(withTitle: "OK")
            present(alert)
        }
    }

    private func tell(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "OK")
        present(alert)
    }
}

/// A button's action as a closure.
private final class ButtonAction: NSObject {
    static var key = 0
    let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func run(_ sender: Any?) { action() }
}

/// Just enough Markdown for release notes: headings, bullets (with wrapped lines), paragraphs,
/// **bold** and `code`.
enum ReleaseNotes {
    static func render(_ markdown: String) -> NSAttributedString {
        let body = NSFont.systemFont(ofSize: 13)
        let out = NSMutableAttributedString()
        // Wrapped lines (indented continuations) join the line above.
        var blocks: [String] = []
        for line in markdown.components(separatedBy: "\n") {
            if line.hasPrefix("  "), let last = blocks.last, !last.isEmpty {
                blocks[blocks.count - 1] = last + " " + line.trimmingCharacters(in: .whitespaces)
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty, blocks.last?.isEmpty == false {
                blocks.append("")
            } else if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                blocks.append(line)
            }
        }
        for block in blocks where !block.isEmpty {
            let para = NSMutableParagraphStyle()
            para.paragraphSpacing = 6
            var text = block, font = body
            if let range = block.range(of: #"^#{1,6} "#, options: .regularExpression) {
                text = String(block[range.upperBound...])
                font = .boldSystemFont(ofSize: 14)
                para.paragraphSpacingBefore = 6
            } else if block.hasPrefix("- ") || block.hasPrefix("* ") {
                text = "•\t" + block.dropFirst(2)
                para.headIndent = 16
                para.tabStops = [NSTextTab(textAlignment: .left, location: 16)]
            }
            let line = inline(text, font: font)
            line.append(NSAttributedString(string: "\n"))
            line.addAttributes([.paragraphStyle: para, .foregroundColor: NSColor.labelColor], range: NSRange(location: 0, length: line.length))
            out.append(line)
        }
        return out
    }

    private static func inline(_ text: String, font: NSFont) -> NSMutableAttributedString {
        let out = NSMutableAttributedString()
        let bold = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
        let code = NSFont.monospacedSystemFont(ofSize: font.pointSize - 1, weight: .regular)
        var rest = Substring(text)
        while !rest.isEmpty {
            if rest.hasPrefix("**"), let end = rest.dropFirst(2).range(of: "**") {
                out.append(NSAttributedString(string: String(rest[rest.index(rest.startIndex, offsetBy: 2)..<end.lowerBound]), attributes: [.font: bold]))
                rest = rest[end.upperBound...]
            } else if rest.hasPrefix("`"), let end = rest.dropFirst().firstIndex(of: "`") {
                out.append(NSAttributedString(string: String(rest[rest.index(after: rest.startIndex)..<end]), attributes: [.font: code]))
                rest = rest[rest.index(after: end)...]
            } else {
                let next = rest.dropFirst().firstIndex { $0 == "*" || $0 == "`" } ?? rest.endIndex
                out.append(NSAttributedString(string: String(rest[rest.startIndex..<next]), attributes: [.font: font]))
                rest = rest[next...]
            }
        }
        return out
    }
}
